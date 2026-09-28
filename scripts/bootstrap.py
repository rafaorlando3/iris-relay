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
import re
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


def session(script, namespace='%SYS', secrets=()):
    out = run('iris', 'session', 'IRIS', '-U', namespace, input=script + '\nhalt\n').stdout
    if 'ERROR #' in out or '<' in out or 'RELAY_READY' not in out:
        # Show the IRIS reason (first error lines), never the credentials in the script.
        reason = [line.strip() for line in out.splitlines()
                  if 'RELAY_STEP_FAILED' in line or 'ERROR #' in line or '<' in line][:3]
        text = ' | '.join(reason) or 'no confirmation from IRIS'
        for secret in secrets:
            text = text.replace(secret, '[redacted]')
        first = next((l.strip() for l in script.splitlines() if l.strip()), '')[:60]
        raise RuntimeError('IRIS setup step failed (' + first.split('(')[0] + '...): ' + text[:400])


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
    for module in ['log_reader.py', 'log_vectors.py']:
        staging = target / ('.' + module + '.new')
        shutil.copyfile(src / 'src' / 'Relay' / module, staging)
        os.replace(staging, target / module)
    session('''set sc=$SYSTEM.OBJ.Load("%(src)s/src/Relay/LogLine.cls","ck")
if $SYSTEM.Status.IsError(sc) { halt }
set sc=$SYSTEM.OBJ.Load("%(src)s/src/Relay/LogReader.cls","ck")
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
''' % (creds['password'], creds['observerPassword']), secrets=[creds['password'], creds['observerPassword']])


DEMO_ROLES = '%Manager'


def demo_account(username, password):
    """Shared account for a hosted public demo: no %All; Relay (RELAY_DEMO=1) limits changes to the Relay fixtures."""
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9]{2,31}', username or ''):
        raise RuntimeError('Invalid demo username.')
    if not re.fullmatch(r'[A-Za-z0-9_-]{12,64}', password or ''):
        raise RuntimeError('The demo password must be 12 to 64 letters, digits, _ or -.')
    # The terminal runs each line on its own, so if/else must stay on one line.
    session('''if '##class(Security.Users).Exists("%(u)s") { set sc=##class(Security.Users).Create("%(u)s","%(r)s","%(p)s","Shared public demo account") } else { set props("Password")="%(p)s",props("Roles")="%(r)s",props("Enabled")=1 set sc=##class(Security.Users).Modify("%(u)s",.props) }
if $SYSTEM.Status.IsError(sc) { write "RELAY_STEP_FAILED demo account: ",$SYSTEM.Status.GetErrorText(sc),! halt }
set st=##class(%%SQL.Statement).%%ExecDirect(,"GRANT SELECT, INSERT, DELETE ON Relay.LogLine TO %(u)s") if st.%%SQLCODE<0 { write "RELAY_STEP_FAILED demo grant: SQLCODE ",st.%%SQLCODE," ",st.%%Message,! halt }
write "RELAY_READY",!
''' % {'u': username, 'p': password, 'r': DEMO_ROLES}, secrets=[password])


def fixtures(src, creds):
    session('''set sc=$SYSTEM.OBJ.Load("%s/fixtures/Relay/DemoApi.cls","ck")
if $SYSTEM.Status.IsError(sc) { halt }
write "RELAY_READY",!
''' % src, 'USER')
    demo_user_password = secrets.token_urlsafe(30)  # never kept; the fixture user stays disabled
    session('''set props("NameSpace")="USER",props("DispatchClass")="Relay.DemoApi",props("AutheEnabled")=32,props("Enabled")=0,props("Resource")="%%Admin_Operate",props("Description")="Disposable Relay demonstration application"
if '##class(Security.Applications).Exists("/relay-demo") { set sc=##class(Security.Applications).Create("/relay-demo",.props) if $SYSTEM.Status.IsError(sc) { halt } }
if '##class(Security.Users).Exists("RelayDemoUser") { set sc=##class(Security.Users).Create("RelayDemoUser","","%s") if $SYSTEM.Status.IsError(sc) { halt } kill props set props("Enabled")=0,props("FullName")="Disposable Relay demonstration account" set sc=##class(Security.Users).Modify("RelayDemoUser",.props) if $SYSTEM.Status.IsError(sc) { halt } }
write "RELAY_READY",!
''' % demo_user_password, secrets=[demo_user_password])
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
    parser.add_argument('--demo-account', action='store_true',
                        help='also create the shared public-demo account from RELAY_DEMO_USER / RELAY_DEMO_PASSWORD')
    args = parser.parse_args()
    src = Path(args.src).resolve()
    wait_running()
    creds = load_credentials(args)
    lab_accounts(creds)
    install_extension(src)
    fixtures(src, creds)
    if args.demo_account:
        demo_account(os.environ.get('RELAY_DEMO_USER', 'RelayDemoOperator'), os.environ.get('RELAY_DEMO_PASSWORD'))
    if args.ready_file:
        Path(args.ready_file).write_text(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + '\n')
    print('IRIS Relay bootstrap complete.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:  # the reason is always shown; credentials never are
        print('IRIS Relay bootstrap failed:', error, file=sys.stderr)
        sys.exit(1)
