#!/usr/bin/env python3
"""Create a real archived messages.old_* rotation in the disposable lab container.

Only for the isolated laboratory created by scripts/lab.py. The container must be
positively identified by the non-secret record that lab.py writes
(artifacts/lab-setup.json): same name, same container ID, pinned image and IRIS
published only on 127.0.0.1 at the recorded port. Anything else is refused before
any setting is changed or the container is restarted.

The script lowers MaxConsoleLogSize to 1 MB, restarts the lab, writes clearly
labelled lines until IRIS rotates messages.log, then restores the original
setting and restarts again. Restoration runs even if a later step fails.

Labs created before this record existed are refused. Confirm the container's
full ID with `docker inspect -f '{{.Id}}' <name>` and run
`python3 scripts/lab.py --adopt-container <full ID>` once, or create a new lab
with a different name, port, credentials and record path.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'containers.intersystems.com/intersystems/iris-community@sha256:87c8b9062530093d30384d66caa9933b8399bfbace7ddb7f1bdb983c0bfdb85b'


class Refused(Exception):
    """The target is not the identified lab; nothing was changed."""


def run(*cmd, **kw):
    return subprocess.run(cmd, text=True, capture_output=True, check=True, timeout=120, **kw)


def identify(name, record_path):
    """Return the verified full container ID if `name` is the exact container lab.py recorded, else raise Refused.

    Every later operation targets that ID, never the name, so renaming or recreating a
    container between identification and execution cannot redirect the changes."""
    try:
        record = json.loads(Path(record_path).read_text())
    except FileNotFoundError:
        raise Refused(f'No lab record at {record_path}. Run python3 scripts/lab.py first (it records the container it manages).')
    except (OSError, ValueError):
        raise Refused(f'The lab record at {record_path} is unreadable.')
    try:
        info = json.loads(run('docker', 'inspect', name).stdout)[0]
    except subprocess.CalledProcessError:
        raise Refused(f'Container {name!r} was not found.')
    if record.get('name') != name:
        raise Refused(f'The lab record is for {record.get("name")!r}, not {name!r}.')
    if record.get('containerId') != info['Id']:
        raise Refused(f'Container {name!r} is not the container recorded by scripts/lab.py (different container ID).')
    if info['Config']['Image'] != IMAGE or record.get('image') != IMAGE:
        raise Refused(f'Container {name!r} does not use the pinned lab image.')
    bindings = (info.get('HostConfig') or {}).get('PortBindings') or {}
    iris = bindings.get('52773/tcp') or []
    if len(bindings) != 1 or len(iris) != 1 or iris[0].get('HostIp') != '127.0.0.1' or str(iris[0].get('HostPort')) != str(record.get('port')):
        raise Refused(f'Container {name!r} is not published only on 127.0.0.1:{record.get("port")} as recorded.')
    if not info['State']['Running']:
        raise Refused(f'Container {name!r} is not running. Start it with python3 scripts/lab.py.')
    return info['Id']


class Lab:
    def __init__(self, container_id):
        self.name = container_id  # full ID from identify(); docker accepts it wherever a name is accepted

    def session(self, script):
        out = run('docker', 'exec', '-i', self.name, 'iris', 'session', 'IRIS', '-U', '%SYS', input=script + '\nhalt\n').stdout
        if 'ERROR #' in out or '<' in out or 'RELAY_OK' not in out:
            raise RuntimeError('IRIS did not confirm the step.')
        return out

    def archived(self):
        out = run('docker', 'exec', self.name, 'sh', '-c', 'cd /usr/irissys/mgr && ls -1 messages.old_* 2>/dev/null || true').stdout
        return sorted(line for line in out.splitlines() if line)

    def max_size(self):
        out = self.session('set sc=##class(Config.Startup).Get(.p) write "RELAY_OK ",p("MaxConsoleLogSize"),!')
        return int(out.split('RELAY_OK ')[1].split()[0])

    def set_max_size(self, value):
        self.session('set sc=##class(Config.Startup).Get(.p) set p("MaxConsoleLogSize")=%d set sc=##class(Config.Startup).Modify(.p) if sc write "RELAY_OK",!' % int(value))

    def restart(self):
        run('docker', 'restart', self.name)
        for _ in range(60):
            try:
                if '^running' in run('docker', 'exec', self.name, 'iris', 'qlist', 'IRIS').stdout:
                    return
            except subprocess.CalledProcessError:
                pass
            time.sleep(2)
        raise RuntimeError('IRIS did not report running after restart.')

    def write_lines(self):
        self.session('for i=1:1:6500 { do ##class(%SYS.System).WriteToConsoleLog("IRIS Relay lab rotation line "_i_" "_$justify("",180),0,0) } write "RELAY_OK",!')


def rotate(lab, wait):
    """Return the new archived file names. Always tries to restore the original size."""
    before = lab.archived()
    original = lab.max_size()
    print('Original MaxConsoleLogSize:', original, 'MB. Existing archived files:', len(before))
    new, problem = [], None
    touched = False
    try:
        touched = True  # from here on a partial change is possible, so restoration must run
        lab.set_max_size(1)
        lab.restart()
        lab.write_lines()
        deadline = time.time() + wait
        while time.time() < deadline:
            new = [n for n in lab.archived() if n not in before]
            if new:
                print('IRIS rotated messages.log into:', ', '.join(new))
                break
            time.sleep(5)
        else:
            problem = f'No rotation observed within {wait} seconds. Try again with a longer --wait.'
    except Exception as error:  # report the reason, then restore below
        problem = f'Rotation step failed: {error}'
    finally:
        if touched:
            try:
                lab.set_max_size(original)
                lab.restart()
                if lab.max_size() != original:
                    raise RuntimeError('readback differs')
                print('Restored MaxConsoleLogSize to', original, 'MB and restarted the lab (read back).')
            except Exception as error:
                print(f'RESTORE FAILED ({error}). Set MaxConsoleLogSize back to {original} in the [Startup] section and restart the lab.', file=sys.stderr)
                raise SystemExit(2)
    if problem:
        print(problem, file=sys.stderr)
        raise SystemExit(1)
    return new


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--name', default='iris-relay-2026-2')
    parser.add_argument('--setup-record', default=str(ROOT / 'artifacts' / 'lab-setup.json'))
    parser.add_argument('--wait', type=int, default=240, help='seconds to wait for IRIS to rotate the log')
    args = parser.parse_args(argv)
    try:
        container_id = identify(args.name, args.setup_record)
    except Refused as reason:
        print('Refused, nothing was changed:', reason, file=sys.stderr)
        raise SystemExit(3)
    print('Target container:', container_id[:12])
    try:
        rotate(Lab(container_id), args.wait)
    except (RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        # Only reachable before the first change: later failures are handled inside rotate().
        print('Failed before any change, nothing was modified:', error, file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
