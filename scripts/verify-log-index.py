#!/usr/bin/env python3
"""Real IRIS regressions. Run with irispython in a fresh disposable review container.

Requires RELAY_DISPOSABLE_REVIEW=1. Run once with --prepare, then without arguments
in a new irispython process, separating class installation from the test session.
Uses USER, synthetic files and Relay.LogLine;
refuses an existing nonempty table. Never run against an instance with real data.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

if os.environ.get('RELAY_DISPOSABLE_REVIEW') != '1':
    sys.exit('Requires a fresh disposable review container and RELAY_DISPOSABLE_REVIEW=1.')
import iris
iris.execute('ZN "USER"')
root = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, root / 'src/Relay' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vectors, reader = load('log_vectors'), load('log_reader')

if sys.argv[1:] == ['--prepare']:
    iris.check_status(iris.cls('%SYSTEM.OBJ').Load(str(root / 'src/Relay/LogLine.cls'), 'ck'))
    sys.exit(0)


def count():
    return next(iter(iris.sql.exec('SELECT COUNT(*) FROM Relay.LogLine')))[0]


def child(mode, directory):
    return subprocess.Popen([sys.executable, __file__, mode, str(directory)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def finish(process):
    out, err = process.communicate(timeout=20)
    assert process.returncode == 0, (out, err)
    return json.loads(out.strip().splitlines()[-1])


if len(sys.argv) > 1:
    mode, directory = sys.argv[1], Path(sys.argv[2])
    if mode == 'writer':
        inserted = 0

        def slow(query, *params):
            global inserted
            result = iris.sql.exec(query, *params)
            if query.startswith('INSERT'):
                inserted += 1
                if inserted == 1:
                    (directory / 'writer-ready').touch()
                    deadline = time.monotonic() + 15
                    while not (directory / 'release-writer').exists():
                        if time.monotonic() > deadline:
                            raise RuntimeError('Review coordinator timed out.')
                        time.sleep(0.02)
            return result

        result = vectors.refresh_iris(directory, reader, iris, slow)
    elif mode == 'contender':
        try:
            vectors.refresh_iris(directory, reader, iris)
            result = {'busy': False}
        except ValueError as error:
            result = {'busy': 'being updated' in str(error)}
    elif mode == 'reader':
        result = vectors.search_iris('new generation', 5, iris)
    else:
        sys.exit('Unknown review mode.')
    print(json.dumps(result))
    sys.exit(0)

assert count() == 0, 'Review refuses an existing nonempty index.'
checks = []
with tempfile.TemporaryDirectory(prefix='relay-index-review-') as tmp:
    directory = Path(tmp)
    log = directory / 'messages.log'
    log.write_text(''.join(f'old generation {i}\n' for i in range(20)))
    assert vectors.refresh_iris(directory, reader, iris)['totalLines'] == 20
    checks.append('initial index')
    log.write_text(''.join(f'new generation {i}\n' for i in range(21)))
    inserts = 0

    def fail_midway(query, *params):
        global inserts
        if query.startswith('INSERT'):
            inserts += 1
            if inserts == 3:
                raise RuntimeError('Injected review failure')
        return iris.sql.exec(query, *params)

    try:
        vectors.refresh_iris(directory, reader, iris, fail_midway)
        raise AssertionError('Injected failure was not raised.')
    except RuntimeError as error:
        assert 'Injected review failure' in str(error)
    assert count() == 20 and iris.tlevel() == 0
    assert all('old generation' in row[0] for row in iris.sql.exec('SELECT Message FROM Relay.LogLine'))
    checks.append('rollback preserves complete old generation')
    assert vectors.refresh_iris(directory, reader, iris)['totalLines'] == 21
    checks.append('retry recovers after failure')
    iris.sql.exec('DELETE FROM Relay.LogLine WHERE LineNo = 0')
    assert vectors.refresh_iris(directory, reader, iris)['totalLines'] == 21
    checks.append('partial legacy index repaired')
    log.write_text(''.join(f'new generation {i}\n' for i in range(30)))
    writer = child('writer', directory)
    searcher = None
    try:
        deadline = time.monotonic() + 10
        while not (directory / 'writer-ready').exists():
            assert writer.poll() is None and time.monotonic() < deadline, 'Writer did not reach partial insert.'
            time.sleep(0.02)
        assert finish(child('contender', directory))['busy']
        checks.append('concurrent writer refused')
        searcher = child('reader', directory)
        time.sleep(0.3)
        assert searcher.poll() is None, 'Reader returned while writer held a partial generation.'
        (directory / 'release-writer').touch()
        assert finish(writer)['totalLines'] == 30
        found = finish(searcher)
        assert found['indexedLines'] == 30 and found['rows']
        assert all('new generation' in row['Message'] for row in found['rows'])
        assert count() == 30
        assert next(iter(iris.sql.exec('SELECT COUNT(DISTINCT LineNo) FROM Relay.LogLine')))[0] == 30
        checks.append('reader waits for complete committed generation; no duplicates')
    finally:
        (directory / 'release-writer').touch()
        for process in [writer, searcher]:
            if process is not None and process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
    iris.tstart()
    try:
        try:
            vectors.refresh_iris(directory, reader, iris)
            raise AssertionError('Nested transaction accepted.')
        except ValueError as error:
            assert 'standalone transaction' in str(error) and iris.tlevel() == 1
    finally:
        iris.trollbackone()
    checks.append('caller transaction preserved')
print(json.dumps({'allPassed': True, 'checks': checks, 'total': len(checks)}, indent=2))
