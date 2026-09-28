import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

root = Path(__file__).resolve().parents[1] / 'src/Relay'
def load(name):
    spec = importlib.util.spec_from_file_location(name, root / (name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
vectors = load('log_vectors'); reader = load('log_reader')


def cosine(a, b):
    return sum(x * y for x, y in zip(a, b))


class FakeSQL:
    """In-memory stand-in for Relay.LogLine, answering only the statements log_vectors issues."""
    def __init__(self):
        self.rows, self.inserts = [], 0
    def __call__(self, query, *params):
        if query.startswith('SELECT DISTINCT'):
            return sorted({(r[0], r[1]) for r in self.rows})
        if query.startswith('DELETE'):
            before = len(self.rows); self.rows = [r for r in self.rows if r[0] != params[0]]
            if before == len(self.rows):
                error = Exception(''); error.sqlcode = 100; raise error
            return []
        if query.startswith('INSERT'):
            self.inserts += 1
            self.rows.append((params[0], params[1], params[2], params[3], params[4], params[5],
                              [float(v) for v in params[6].split(',')])); return []
        if query.startswith('SELECT COUNT(DISTINCT'):
            return [(len({r[0] for r in self.rows}),)]
        if query.startswith('SELECT COUNT'):
            return [(len(self.rows),)]
        if query.startswith('SELECT TOP'):
            q = [float(v) for v in params[0].split(',')]
            top = int(query.split()[2])
            ranked = sorted(self.rows, key=lambda r: -cosine(r[6], q))[:top]
            return [(r[0], r[2], r[3], r[4], r[5], cosine(r[6], q)) for r in ranked]
        raise AssertionError(query)


class Embedding(unittest.TestCase):
    def test_deterministic_normalized_and_digits_folded(self):
        a = vectors.embed('Journaling to /usr/irissys/mgr/journal/20260928.003 started')
        self.assertEqual(a, vectors.embed('Journaling to /usr/irissys/mgr/journal/20260928.003 started'))
        self.assertAlmostEqual(sum(v * v for v in a), 1.0, places=9)
        self.assertEqual(a, vectors.embed('Journaling to /usr/irissys/mgr/journal/20261001.017 started'))
        self.assertEqual(len(a), vectors.DIMS)
        self.assertFalse(any(vectors.embed('  ... ')))

    def test_similar_wording_ranks_above_unrelated(self):
        q = vectors.embed('licence limit exceeded')
        close = vectors.embed('License limit was exceeded for this instance')
        far = vectors.embed('Journaling started to the new file')
        self.assertGreater(cosine(q, close), cosine(q, far) + 0.2)


class Index(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        (self.dir / 'messages.log').write_text(''.join(f'09/28/26-10:00:0{i % 10} (1) 0 Current line {i}\n' for i in range(40)))
        old = self.dir / 'messages.old_20260927'
        old.write_text('09/27/26-10:00:00 (2) 2 [Utility.Event] License limit exceeded\n' * 3)
        os.utime(old, (1000, 1000))

    def test_refresh_skips_unchanged_replaces_changed_and_drops_removed(self):
        sql = FakeSQL()
        first = vectors.refresh(self.dir, reader, sql)
        self.assertEqual((first['indexedLines'], first['files'], first['totalLines']), (43, 2, 43))
        again = vectors.refresh(self.dir, reader, sql)
        self.assertEqual((again['indexedLines'], again['unchangedFiles']), (0, 2))
        with open(self.dir / 'messages.log', 'a') as f:
            f.write('09/28/26-11:00:00 (1) 1 Appended line\n')
        grown = vectors.refresh(self.dir, reader, sql)
        self.assertEqual((grown['indexedLines'], grown['unchangedFiles'], grown['totalLines']), (41, 1, 44))
        (self.dir / 'messages.old_20260927').unlink()
        gone = vectors.refresh(self.dir, reader, sql)
        self.assertEqual((gone['files'], gone['totalLines']), (1, 41))

    def test_limits_and_links(self):
        sql = FakeSQL()
        other = self.dir / 'secret'; other.write_text('private\n')
        (self.dir / 'messages.old_20260101').symlink_to(other)
        big = self.dir / 'messages.old_20260926'
        big.write_text(''.join(f'line {i}\n' for i in range(vectors.MAX_LINES_PER_FILE + 500)))
        result = vectors.refresh(self.dir, reader, sql)
        self.assertNotIn('messages.old_20260101', {r[0] for r in sql.rows})
        self.assertEqual(sum(1 for r in sql.rows if r[0] == 'messages.old_20260926'), vectors.MAX_LINES_PER_FILE)
        self.assertLessEqual(result['totalLines'], vectors.MAX_LINES_TOTAL)

    def test_same_size_same_timestamp_rewrite_reindexes_content(self):
        sql = FakeSQL()
        vectors.refresh(self.dir, reader, sql)
        path = self.dir / 'messages.log'
        before = path.stat()
        path.write_text(path.read_text().replace('Current', 'Changed'))
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(path.stat().st_size, before.st_size)
        result = vectors.refresh(self.dir, reader, sql)
        self.assertEqual(result['indexedLines'], 40)
        self.assertTrue(all('Changed' in r[5] for r in sql.rows if r[0] == 'messages.log'))

    def test_search_groups_repeats_and_validates_input(self):
        sql = FakeSQL()
        vectors.refresh(self.dir, reader, sql)
        result = vectors.search('licence limit exceeded', 5, sql)
        top = result['rows'][0]
        self.assertIn('License limit exceeded', top['Message'])
        self.assertEqual((top['Occurrences'], top['Files'], top['Level']), (3, ['messages.old_20260927'], 2))
        self.assertEqual(len({r['Message'] for r in result['rows']}), len(result['rows']))
        self.assertLessEqual(len(result['rows']), 5)
        self.assertIn('error', vectors.search('', 5, sql))
        self.assertIn('error', vectors.search('x' * 201, 5, sql))
        self.assertIn('error', vectors.search('... !!!', 5, sql))
        self.assertIn('error', vectors.search('anything', 5, FakeSQL()))


if __name__ == '__main__':
    unittest.main()
