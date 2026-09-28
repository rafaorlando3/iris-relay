#!/usr/bin/env python3
"""Provision IRIS Relay inside an IRIS container: extension, lab accounts and demo fixtures.

Runs inside the container (system python3, as irisowner). It is the single setup
path used by scripts/lab.py (which copies the repository in and passes the
credentials on stdin) and by docker compose (which mounts the repository and keeps
generated credentials inside the container). Every step is idempotent.

Never run it against an instance with real data: it creates a %All lab account and
disposable demonstration objects.
"""
import argparse
import base64
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from security_fixtures import provision  # noqa: E402

IRIS_URL = 'http://127.0.0.1:52773'


def run(*cmd, **kw):
    return subprocess.run(cmd, text=True, capture_output=True, check=True, timeout=120, **kw)


def session(script, namespace='%SYS'):
    out = run('iris', 'session', 'IRIS', '-U', namespace, input=script + '\nhalt\n').stdout
    if 'ERROR #' in out or '<' in out or 'RELAY_READY' not in out:
        raise RuntimeError('IRIS setup did not confirm completion. Credentials were not printed.')


def wait_running(seconds=120):
    for _ in range(seconds):
        try:
            if '^running' in run('iris', 'qlist', 'IRIS').stdout:
                return
        except subprocess.CalledProcessError:
            pass
        time.sleep(1)
    raise RuntimeError(f'IRIS did not start within {seconds} seconds.')


def load_credentials(args):
    if args.credentials_stdin:
        return json.loads(sys.stdin.read())
    path = Path(args.credentials_file)
    if path.exists():
        return json.loads(path.read_text())
    creds = {'username': 'RelayLab', 'password': secrets.token_urlsafe(24),
             'observerPassword': secrets.token_urlsafe(24), 'url': args.public_url}
    path.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive create: an existing credentials file is never replaced.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        file.write(json.dumps(creds, indent=2))
    return creds


def install_extension(src):
    manager = Path(run('iris', 'qlist', 'IRIS').stdout.split('^')[1]) / 'mgr'
    target = manager / 'relay'
    target.mkdir(exist_ok=True)
    # Write a temporary copy and rename it over the old one: this also replaces a
    # root-owned copy left by earlier versions of lab.py (which used docker cp).
    staging = target / '.log_reader.py.new'
    shutil.copyfile(src / 'src' / 'Relay' / 'log_reader.py', staging)
    os.replace(staging, target / 'log_reader.py')
    session('''set sc=$SYSTEM.OBJ.Load("%(src)s/src/Relay/LogReader.cls","ck")
if $SYSTEM.Status.IsError(sc) { halt }
set sc=$SYSTEM.OBJ.Load("%(src)s/src/Relay/Api.cls","ck")
if $SYSTEM.Status.IsError(sc) { halt }
set props("NameSpace")="%%SYS",props("DispatchClass")="Relay.Api",props("AutheEnabled")=32,props("Enabled")=1
if '##class(Security.Applications).Exists("/api/relay") { set sc=##class(Security.Applications).Create("/api/relay",.props) if $SYSTEM.Status.IsError(sc) { halt } }
write "RELAY_READY",!
''' % {'src': src})


def lab_accounts(creds):
    # Generated credentials contain only URL-safe characters, and are never user input.
    session('''if '##class(Security.Users).Exists("RelayLab") { set sc=##class(Security.Users).Create("RelayLab","%%All","%s") if $SYSTEM.Status.IsError(sc) { halt } }
if '##class(Security.Users).Exists("RelayObserver") { set sc=##class(Security.Users).Create("RelayObserver","%%Operator","%s") if $SYSTEM.Status.IsError(sc) { halt } }
write "RELAY_READY",!
''' % (creds['password'], creds['observerPassword']))


def fixtures(src, creds):
    session('''set sc=$SYSTEM.OBJ.Load("%s/fixtures/Relay/DemoApi.cls","ck")
if $SYSTEM.Status.IsError(sc) { halt }
write "RELAY_READY",!
''' % src, 'USER')
    session('''set props("NameSpace")="USER",props("DispatchClass")="Relay.DemoApi",props("AutheEnabled")=32,props("Enabled")=0,props("Resource")="%%Admin_Operate",props("Description")="Disposable Relay demonstration application"
if '##class(Security.Applications).Exists("/relay-demo") { set sc=##class(Security.Applications).Create("/relay-demo",.props) if $SYSTEM.Status.IsError(sc) { halt } }
if '##class(Security.Users).Exists("RelayDemoUser") { set sc=##class(Security.Users).Create("RelayDemoUser","","%s") if $SYSTEM.Status.IsError(sc) { halt } kill props set props("Enabled")=0,props("FullName")="Disposable Relay demonstration account" set sc=##class(Security.Users).Modify("RelayDemoUser",.props) if $SYSTEM.Status.IsError(sc) { halt } }
write "RELAY_READY",!
''' % secrets.token_urlsafe(30))
    session('''set sc=$SYSTEM.OBJ.Load("%s/fixtures/Relay/SmokeTask.cls","ck")
if $SYSTEM.Status.IsError(sc) { halt }
if '$Data(^RelayLabFixture) { set t=##class(%%SYS.Task).%%New(),t.Name="Relay demonstration task",t.TaskClass="Relay.SmokeTask",t.NameSpace="USER",t.RunAsUser="RelayLab",t.TimePeriod=0,t.TimePeriodEvery=1,t.DailyStartTime=86399,t.StartDate=$Piece($Horolog,",",1)+1 set sc=t.%%Save() if $SYSTEM.Status.IsError(sc) { halt } set ^RelayLabFixture=t.%%Id() }
write "RELAY_READY",!
''' % src, 'USER')
    # Disposable wallet collection through the documented management API.
    wallet_url = IRIS_URL + '/api/admin/v2/wallet/collection?name=RelayDemo'
    headers = {'Authorization': 'Basic ' + base64.b64encode((creds['username'] + ':' + creds['password']).encode()).decode(),
               'Content-Type': 'application/json'}
    try:
        with urllib.request.urlopen(urllib.request.Request(wallet_url, headers=headers), timeout=10) as response:
            json.load(response)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise RuntimeError('Wallet fixture lookup failed with HTTP ' + str(error.code)) from None
        payload = json.dumps({'EditResource': '%Admin_Wallet:USE', 'UseResource': '%Admin_Wallet:USE'}).encode()
        with urllib.request.urlopen(urllib.request.Request(wallet_url, method='PUT', headers=headers, data=payload), timeout=10) as response:
            if json.load(response).get('status', {}).get('errors'):
                raise RuntimeError('Wallet fixture creation failed.')
    provision(IRIS_URL, creds)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--src', default=str(HERE.parent), help='repository root inside the container')
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--credentials-stdin', action='store_true', help='read the lab credentials JSON from stdin')
    source.add_argument('--credentials-file', help='use this file, or create it (0600) with new credentials')
    parser.add_argument('--public-url', default='http://127.0.0.1:52785', help='URL recorded in a newly created credentials file')
    parser.add_argument('--ready-file', help='write this marker after a successful setup (compose health check)')
    args = parser.parse_args()
    src = Path(args.src).resolve()
    wait_running()
    creds = load_credentials(args)
    lab_accounts(creds)
    install_extension(src)
    fixtures(src, creds)
    if args.ready_file:
        Path(args.ready_file).write_text(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + '\n')
    print('IRIS Relay bootstrap complete.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:  # the reason is always shown; credentials never are
        print('IRIS Relay bootstrap failed:', error, file=sys.stderr)
        sys.exit(1)
