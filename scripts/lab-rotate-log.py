#!/usr/bin/env python3
"""Create a real archived messages.old_* rotation in the disposable lab container.

Only for the isolated laboratory created by scripts/lab.py. It lowers
MaxConsoleLogSize to 1 MB, restarts the lab, writes clearly labelled lines until
IRIS rotates messages.log, then restores the original setting and restarts again.
"""
import argparse
import json
import subprocess
import sys
import time

IMAGE = 'containers.intersystems.com/intersystems/iris-community@sha256:87c8b9062530093d30384d66caa9933b8399bfbace7ddb7f1bdb983c0bfdb85b'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--name', default='iris-relay-2026-2')
parser.add_argument('--wait', type=int, default=240, help='seconds to wait for IRIS to rotate the log')
args = parser.parse_args()

def run(*cmd, **kw):
    return subprocess.run(cmd, text=True, capture_output=True, check=True, timeout=120, **kw)

def session(script):
    out = run('docker', 'exec', '-i', args.name, 'iris', 'session', 'IRIS', '-U', '%SYS', input=script + '\nhalt\n').stdout
    if 'ERROR #' in out or '<' in out or 'RELAY_OK' not in out:
        raise SystemExit('IRIS did not confirm the step. Nothing else was changed by this script after this point.')
    return out

def archived():
    out = run('docker', 'exec', args.name, 'sh', '-c', 'cd /usr/irissys/mgr && ls -1 messages.old_* 2>/dev/null || true').stdout
    return sorted(line for line in out.splitlines() if line)

def restart():
    run('docker', 'restart', args.name)
    for _ in range(60):
        try:
            if '^running' in run('docker', 'exec', args.name, 'iris', 'qlist', 'IRIS').stdout:
                return
        except subprocess.CalledProcessError:
            pass
        time.sleep(2)
    raise SystemExit('IRIS did not report running after restart.')

info = json.loads(run('docker', 'inspect', args.name).stdout)[0]
if info['Config']['Image'] != IMAGE:
    raise SystemExit('This container was not created by scripts/lab.py. It was not changed.')
before = archived()
original = session('set sc=##class(Config.Startup).Get(.p) write "RELAY_OK ",p("MaxConsoleLogSize"),!').split('RELAY_OK ')[1].split()[0]
print('Original MaxConsoleLogSize:', original, 'MB. Existing archived files:', len(before))
session('set sc=##class(Config.Startup).Get(.p) set p("MaxConsoleLogSize")=1 set sc=##class(Config.Startup).Modify(.p) if sc write "RELAY_OK",!')
restored = False
try:
    restart()
    session('for i=1:1:6500 { do ##class(%SYS.System).WriteToConsoleLog("IRIS Relay lab rotation line "_i_" "_$justify("",180),0,0) } write "RELAY_OK",!')
    deadline = time.time() + args.wait
    while time.time() < deadline:
        new = [name for name in archived() if name not in before]
        if new:
            print('IRIS rotated messages.log into:', ', '.join(new))
            break
        time.sleep(5)
    else:
        print('No rotation observed within', args.wait, 'seconds. Try again with a longer --wait.', file=sys.stderr)
finally:
    session('set sc=##class(Config.Startup).Get(.p) set p("MaxConsoleLogSize")=%s set sc=##class(Config.Startup).Modify(.p) if sc write "RELAY_OK",!' % int(original))
    restart()
    restored = True
    print('Restored MaxConsoleLogSize to', original, 'MB and restarted the lab.')
if not [name for name in archived() if name not in before]:
    sys.exit(1)
