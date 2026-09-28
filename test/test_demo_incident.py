"""The simulated incident planted for the public demo's guided tour."""
import calendar
import importlib.util
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('bootstrap', ROOT / 'scripts' / 'bootstrap.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
spec = importlib.util.spec_from_file_location('logs', ROOT / 'src' / 'Relay' / 'log_reader.py')
logs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logs)


class Qlist:
    def __init__(self, root):
        self.stdout = 'IRIS^' + str(root) + '^2026.2.0.221.0com^running'


class DemoIncidentTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.mgr = self.root / 'mgr'
        (self.mgr / 'relay').mkdir(parents=True)
        self.scripts = []
        self.patch('run', lambda *cmd, **kw: Qlist(self.root))
        self.patch('session', lambda script, namespace='%SYS', secrets=(): self.scripts.append(script))

    def patch(self, name, value):
        original = getattr(bootstrap, name)
        setattr(bootstrap, name, value)
        self.addCleanup(setattr, bootstrap, name, original)

    def test_archive_is_labelled_listed_and_readable(self):
        now = calendar.timegm((2026, 9, 28, 20, 0, 0, 0, 0, 0))
        bootstrap.demo_incident(now)
        archive = self.mgr / 'messages.old_20260927'
        self.assertTrue(archive.is_file())
        lines = archive.read_text().splitlines()
        self.assertEqual(len(lines), len(bootstrap.ARCHIVED_LINES))
        self.assertTrue(all('[Relay demo' in line for line in lines))
        self.assertTrue(all('(simulated)' in line or 'not by IRIS' in line for line in lines))
        # The log reader lists it as an archived rotation and parses every line.
        listed = [s for s in logs.catalog(self.mgr)['sources'] if s.get('archived')]
        self.assertEqual([s['name'] for s in listed], ['messages.old_20260927'])
        self.assertTrue(listed[0]['modified'].startswith('2026-09-27T06:30'))
        page = logs.page(self.mgr, listed[0]['id'])
        self.assertNotIn('error', page)
        self.assertEqual(len(page['rows']), len(lines))
        self.assertTrue(all(row['Time'].startswith('09/27/26-06:') and row['Level'] in (0, 1, 2) for row in page['rows']))
        self.assertFalse((self.mgr / '.relay-demo-archive.new').exists())

    def test_current_log_lines_go_through_iris_and_run_once(self):
        bootstrap.demo_incident()
        self.assertEqual(len(self.scripts), 1)
        script = self.scripts[0]
        self.assertEqual(script.count('WriteToConsoleLog('), len(bootstrap.CURRENT_LINES))
        self.assertIn('##class(%SYS.System)', script)
        self.assertNotIn('<', script)  # the session check treats '<' in output as an IRIS error
        self.assertTrue(script.rstrip().endswith('write "RELAY_READY",!'))
        # A container restart keeps the marker: no duplicate lines.
        bootstrap.demo_incident()
        self.assertEqual(len(self.scripts), 1)
        self.assertTrue((self.mgr / 'relay' / '.demo-incident').exists())

    def test_existing_archive_is_never_replaced(self):
        now = calendar.timegm((2026, 9, 28, 20, 0, 0, 0, 0, 0))
        archive = self.mgr / 'messages.old_20260927'
        archive.write_text('real IRIS rotation\n')
        bootstrap.demo_incident(now)
        self.assertEqual(archive.read_text(), 'real IRIS rotation\n')


if __name__ == '__main__':
    unittest.main()
