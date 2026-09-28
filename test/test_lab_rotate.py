import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location('rotate', Path(__file__).resolve().parents[1] / 'scripts/lab-rotate-log.py')
rotate = importlib.util.module_from_spec(spec); spec.loader.exec_module(rotate)


def container(cid='abc123', image=rotate.IMAGE, bindings=None, running=True):
    if bindings is None:
        bindings = {'52773/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '52785'}]}
    return {'Id': cid, 'Config': {'Image': image}, 'HostConfig': {'PortBindings': bindings}, 'State': {'Running': running}}


class Identify(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(); self.addCleanup(self.dir.cleanup)
        self.record = Path(self.dir.name) / 'lab-setup.json'
        self.record.write_text(json.dumps({'name': 'lab', 'containerId': 'abc123', 'image': rotate.IMAGE, 'port': 52785}))

    def check(self, info, name='lab'):
        out = subprocess.CompletedProcess([], 0, stdout=json.dumps([info]), stderr='')
        with mock.patch.object(rotate, 'run', return_value=out):
            return rotate.identify(name, self.record)

    def test_recorded_lab_is_accepted(self):
        self.assertEqual(self.check(container()), 'abc123')

    def test_same_image_but_other_container_is_refused(self):
        with self.assertRaisesRegex(rotate.Refused, 'container ID'):
            self.check(container(cid='other'))

    def test_other_name_image_exposure_and_state_are_refused(self):
        with self.assertRaisesRegex(rotate.Refused, 'record is for'):
            self.check(container(), name='decoy')
        with self.assertRaisesRegex(rotate.Refused, 'pinned lab image'):
            self.check(container(image='intersystemsdc/iris-community:latest'))
        for bindings in [{'52773/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '52785'}]},
                         {'52773/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '52799'}]},
                         {'52773/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '52785'}], '1972/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '1972'}]}]:
            with self.assertRaisesRegex(rotate.Refused, 'published only'):
                self.check(container(bindings=bindings))
        with self.assertRaisesRegex(rotate.Refused, 'not running'):
            self.check(container(running=False))

    def test_missing_or_broken_record_is_refused(self):
        self.record.unlink()
        with self.assertRaisesRegex(rotate.Refused, 'No lab record'):
            self.check(container())
        self.record.write_text('{broken')
        with self.assertRaisesRegex(rotate.Refused, 'unreadable'):
            self.check(container())


class TargetsId(unittest.TestCase):
    def test_every_docker_call_uses_the_verified_id(self):
        calls = []
        def fake_run(*cmd, **kw):
            calls.append(cmd)
            out = 'RELAY_OK 5\n' if 'session' in cmd else ('^running' if 'qlist' in cmd else '')
            return subprocess.CompletedProcess(cmd, 0, stdout=out, stderr='')
        lab = rotate.Lab('0123456789abcdef' * 4)
        with mock.patch.object(rotate, 'run', side_effect=fake_run):
            lab.max_size(); lab.set_max_size(1); lab.restart(); lab.write_lines(); lab.archived()
        self.assertTrue(calls)
        for cmd in calls:
            self.assertEqual(cmd[0], 'docker')
            self.assertIn('0123456789abcdef' * 4, cmd, cmd)
            self.assertNotIn('lab', cmd, cmd)


class FakeLab:
    def __init__(self, fail=None):
        self.size, self.files, self.fail, self.calls = 5, [], fail, []
    def archived(self): return list(self.files)
    def max_size(self): return self.size
    def set_max_size(self, value):
        self.calls.append(('set', value)); self.size = value
        if self.fail == 'after-first-change' and value == 1: raise RuntimeError('lost connection after the change')
    def restart(self): self.calls.append(('restart',))
    def write_lines(self):
        if self.fail == 'write': raise RuntimeError('write failed')
        self.files.append('messages.old_20260928')


class Restore(unittest.TestCase):
    def test_success_rotates_and_restores(self):
        lab = FakeLab()
        with mock.patch('builtins.print'):
            self.assertEqual(rotate.rotate(lab, 5), ['messages.old_20260928'])
        self.assertEqual(lab.size, 5); self.assertEqual(lab.calls[-2:], [('set', 5), ('restart',)])

    def test_failures_after_or_during_the_change_still_restore(self):
        for fail in ['write', 'after-first-change']:
            lab = FakeLab(fail)
            with mock.patch('builtins.print'), self.assertRaises(SystemExit) as stop:
                rotate.rotate(lab, 1)
            self.assertEqual(stop.exception.code, 1, fail)
            self.assertEqual(lab.size, 5, fail)
            self.assertIn(('set', 5), lab.calls, fail)


if __name__ == '__main__':
    unittest.main()
