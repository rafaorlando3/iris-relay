"""Lab-only bootstrap options and the compose files that pass them (or must not)."""
import importlib.util
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('bootstrap', ROOT / 'scripts' / 'bootstrap.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


def service(text, name):
    """The block of one top-level service in a compose file (plain text, no YAML library)."""
    match = re.search(r'^  ' + name + r':\n((?:    .*\n|\n)+)', text, re.M)
    return match.group(1) if match else ''


class ComposeTests(unittest.TestCase):
    lab = (ROOT / 'compose.yaml').read_text()
    demo = (ROOT / 'compose.demo.yaml').read_text()

    def test_lab_publishes_iris_on_loopback_unless_iris_bind_is_set(self):
        iris = service(self.lab, 'iris')
        self.assertIn('- "127.0.0.1:8787:8787"', iris)
        self.assertIn('- "${IRIS_BIND:-127.0.0.1}:${IRIS_PORT:-52773}:52773"', iris)
        self.assertNotIn('0.0.0.0:', iris.replace('RELAY_LISTEN_HOST: 0.0.0.0', ''))
        self.assertIn('IRIS_BIND=0.0.0.0', self.lab)
        self.assertIn('/csp/sys/UtilHome.csp', self.lab)

    def test_only_the_lab_passes_the_lab_options(self):
        lab_command = [line for line in service(self.lab, 'iris').splitlines() if 'bootstrap.py' in line]
        demo_command = [line for line in service(self.demo, 'iris').splitlines() if 'bootstrap.py' in line]
        self.assertEqual(len(lab_command), 1)
        self.assertIn('--unexpire-predefined', lab_command[0])
        self.assertIn('--serve-ui /opt/relay/web/relay', lab_command[0])
        self.assertIn('./web:/opt/relay/web:ro', self.lab)
        self.assertEqual(len(demo_command), 1)
        self.assertIn('--demo-account', demo_command[0])
        self.assertNotIn('--unexpire-predefined', demo_command[0])
        self.assertNotIn('--serve-ui', demo_command[0])

    def test_demo_replaces_the_port_list_and_keeps_iris_unpublished(self):
        iris = service(self.demo, 'iris')
        ports = re.search(r'    ports: !override\n((?:      - .*\n)+)', iris)
        self.assertIsNotNone(ports, 'compose.demo.yaml must replace the lab ports with !override')
        self.assertEqual(ports.group(1).strip().splitlines(), ['- "127.0.0.1:8787:8787"'])
        self.assertNotIn('52773:', iris)


class LabOptionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.scripts = []
        self.patch('session', lambda script, namespace='%SYS', secrets=(): self.scripts.append((namespace, script)))

    def patch(self, name, value):
        original = getattr(bootstrap, name)
        setattr(bootstrap, name, value)
        self.addCleanup(setattr, bootstrap, name, original)

    def test_predefined_passwords_are_unexpired_once_per_container(self):
        marker = self.root / '.predefined-unexpired'
        bootstrap.unexpire_predefined(marker)
        self.assertEqual(len(self.scripts), 1)
        namespace, script = self.scripts[0]
        self.assertEqual(namespace, '%SYS')
        self.assertIn('##class(Security.Users).UnExpireUserPasswords("*",.count)', script)
        self.assertIn('RELAY_STEP_FAILED', script)
        self.assertTrue(marker.is_file())
        # A restart must not undo a password that was expired later on purpose.
        bootstrap.unexpire_predefined(marker)
        self.assertEqual(len(self.scripts), 1)

    def test_iris_serves_the_checkout_ui_as_static_files_only(self):
        ui = self.root / 'web' / 'relay'
        ui.mkdir(parents=True)
        (ui / 'index.html').write_text('<!doctype html>')
        bootstrap.serve_ui(str(ui))
        namespace, script = self.scripts[0]
        self.assertEqual(namespace, '%SYS')
        for setting in ['props("Path")="%s/"' % ui, 'props("ServeFiles")=1', 'props("CSPZENEnabled")=0',
                        'props("AutoCompile")=0', 'props("AutheEnabled")=64', 'Exists("/relay")']:
            self.assertIn(setting, script)
        self.assertNotIn('DispatchClass', script)

    def test_serve_ui_refuses_a_missing_or_odd_directory(self):
        with self.assertRaises(RuntimeError):
            bootstrap.serve_ui(str(self.root / 'missing'))
        odd = self.root / 'a"b'
        odd.mkdir()
        (odd / 'index.html').write_text('x')
        with self.assertRaises(RuntimeError):
            bootstrap.serve_ui(str(odd))
        self.assertEqual(self.scripts, [])

    def test_unexpire_is_never_combined_with_the_public_demo_account(self):
        self.patch('wait_running', lambda: None)
        argv = sys.argv
        self.addCleanup(setattr, sys, 'argv', argv)
        sys.argv = ['bootstrap.py', '--credentials-stdin', '--unexpire-predefined', '--demo-account']
        with self.assertRaisesRegex(RuntimeError, 'local lab only'):
            bootstrap.main()
        self.assertEqual(self.scripts, [])


if __name__ == '__main__':
    unittest.main()
