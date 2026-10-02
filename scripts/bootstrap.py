#!/usr/bin/env python3
"""Provision IRIS Relay inside an IRIS container: extension, lab accounts and demo fixtures.

Runs inside the container (system python3, as irisowner). It is the single setup
path used by scripts/lab.py (which copies the repository in and passes the
credentials on stdin) and by docker compose (which mounts the repository and keeps
generated credentials inside the container). Every step is idempotent.

Never run it against an instance with real data: it creates a %All lab account and
disposable demonstration objects. The two lab-only options below are passed by
compose.yaml alone (the public demo overlay and scripts/lab.py do not pass them):
--unexpire-predefined lifts the expired state that the official image ships for the
predefined accounts (SuperUser, _SYSTEM, Admin and the others, password SYS), and
--serve-ui lets IRIS serve the Relay UI of the checkout at /relay.
"""
import argparse
import base64
import calendar
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


def unexpire_predefined(marker):
    """Local lab only: the official image ships SuperUser, _SYSTEM, Admin and the other
    predefined accounts with expired passwords (SYS). Lift that once per container, as the
    community templates do, so the Management Portal accepts SuperUser / SYS without a
    change prompt. Once only: a password expired later on purpose stays expired."""
    if marker.exists():
        return
    session('''set sc=##class(Security.Users).UnExpireUserPasswords("*",.count) if $SYSTEM.Status.IsError(sc) { write "RELAY_STEP_FAILED unexpire: ",$SYSTEM.Status.GetErrorText(sc),! halt }
write "RELAY_READY ",count,!
''')
    marker.write_text(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + '\n')


def serve_ui(directory):
    """Local lab only: IRIS serves the Relay UI of the checkout at /relay, as the IPM package
    does (static files only: CSP/ZEN and auto-compile off, no sign-in for the files; the page
    signs in to /api/admin and /api/relay with the operator's account)."""
    path = Path(directory)
    if not (path / 'index.html').is_file():
        raise RuntimeError('No Relay UI at ' + str(path) + ' (index.html missing).')
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(path)):
        raise RuntimeError('Unexpected UI directory name: ' + str(path))
    session('''set props("NameSpace")="USER",props("Path")="%(p)s/",props("ServeFiles")=1,props("Recurse")=1,props("CSPZENEnabled")=0,props("AutoCompile")=0,props("AutheEnabled")=64,props("Enabled")=1,props("Description")="IRIS Relay web UI from the lab checkout: static files only (CSP/ZEN off)"
if '##class(Security.Applications).Exists("/relay") { set sc=##class(Security.Applications).Create("/relay",.props) } else { set sc=##class(Security.Applications).Modify("/relay",.props) }
if $SYSTEM.Status.IsError(sc) { write "RELAY_STEP_FAILED /relay: ",$SYSTEM.Status.GetErrorText(sc),! halt }
write "RELAY_READY",!
''' % {'p': str(path).rstrip('/')})


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


INCIDENT = '[Relay demo incident]'
ARCHIVE_NOTE = '[Relay demo archive]'
# (seconds after 06:00 yesterday, severity, text) for the synthetic archived rotation.
ARCHIVED_LINES = [
    (0, 0, ARCHIVE_NOTE + ' Synthetic archived log for the IRIS Relay guided tour. Written by the demo bootstrap, not by IRIS.'),
    (60, 0, ARCHIVE_NOTE + ' Nightly integrity check of USER completed (simulated)'),
    (120, 1, INCIDENT + ' License limit reached: new user connection from 10.20.0.14 refused (simulated)'),
    (300, 1, INCIDENT + ' License limit exceeded; connection from 10.20.0.22 rejected (simulated)'),
    (540, 1, INCIDENT + ' Licence limit exceeded for RelayDemoUser, CSP session refused (simulated)'),
    (900, 2, INCIDENT + " Task 'Relay demonstration task' failed with a PROTECT error on ^RelayLabFixture (simulated)"),
    (1200, 1, INCIDENT + ' Web application /relay-demo answered HTTP 503 to 12 requests in 5 minutes (simulated)'),
    (1800, 0, ARCHIVE_NOTE + ' Backup of USER completed in 42 seconds (simulated)'),
]
# Written to the live messages.log through IRIS, so the current log shows the same incident.
CURRENT_LINES = [
    (1, INCIDENT + ' License limit exceeded: user connection from 10.20.0.31 refused (simulated)'),
    (1, INCIDENT + ' License limit exceeded: user connection from 10.20.0.47 refused (simulated)'),
    (2, INCIDENT + " Task 'Relay demonstration task' failed again with a PROTECT error on ^RelayLabFixture (simulated)"),
]


def demo_incident(now=None):
    """Plant a clearly labelled, simulated incident for the public demo's guided tour.

    Adds a synthetic archived rotation (messages.old_<yesterday>) and three lines in the
    live messages.log, so the log views and the similarity search have something to find.
    Every line says it is simulated. Runs once per container (a marker survives restarts;
    the hourly reset recreates the container and therefore the incident)."""
    manager = Path(run('iris', 'qlist', 'IRIS').stdout.split('^')[1]) / 'mgr'
    marker = manager / 'relay' / '.demo-incident'
    if marker.exists():
        return
    now = now or time.time()
    yesterday = time.gmtime(now - 86400)
    # IRIS in the container logs in UTC; the synthetic lines use the same clock.
    start = calendar.timegm((yesterday.tm_year, yesterday.tm_mon, yesterday.tm_mday, 6, 0, 0, 0, 0, 0))
    archive = manager / ('messages.old_' + time.strftime('%Y%m%d', yesterday))
    if not archive.exists():
        text = ''.join('%s:000 (%d) %d %s\n' % (time.strftime('%m/%d/%y-%H:%M:%S', time.gmtime(start + offset)),
                                                4100 + i, severity, message)
                       for i, (offset, severity, message) in enumerate(ARCHIVED_LINES))
        staging = manager / '.relay-demo-archive.new'
        staging.write_text(text)
        stamp = start + ARCHIVED_LINES[-1][0]
        os.utime(staging, (stamp, stamp))
        os.replace(staging, archive)
    session('\n'.join('do ##class(%%SYS.System).WriteToConsoleLog("%s",0,%d)' % (message.replace('"', '""'), severity)
                      for severity, message in CURRENT_LINES) + '\nwrite "RELAY_READY",!\n')
    marker.write_text(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now)) + '\n')


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
    parser.add_argument('--unexpire-predefined', action='store_true',
                        help='local lab only: lift the expired passwords of the predefined accounts (SuperUser / SYS), '
                             'once per container')
    parser.add_argument('--serve-ui', metavar='DIR',
                        help='local lab only: IRIS serves the Relay UI in DIR (web/relay of the checkout) at /relay')
    parser.add_argument('--demo-account', action='store_true',
                        help='also create the shared public-demo account from RELAY_DEMO_USER / RELAY_DEMO_PASSWORD '
                             'and plant the labelled, simulated incident used by the guided tour')
    args = parser.parse_args()
    src = Path(args.src).resolve()
    wait_running()
    if args.unexpire_predefined and args.demo_account:
        raise RuntimeError('--unexpire-predefined is for the local lab only, never with --demo-account.')
    creds = load_credentials(args)
    lab_accounts(creds)
    install_extension(src)
    fixtures(src, creds)
    if args.unexpire_predefined:
        manager = Path(run('iris', 'qlist', 'IRIS').stdout.split('^')[1]) / 'mgr'
        unexpire_predefined(manager / 'relay' / '.predefined-unexpired')
    if args.serve_ui:
        serve_ui(args.serve_ui)
    if args.demo_account:
        demo_account(os.environ.get('RELAY_DEMO_USER', 'RelayDemoOperator'), os.environ.get('RELAY_DEMO_PASSWORD'))
        demo_incident()
    if args.ready_file:
        Path(args.ready_file).write_text(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + '\n')
    print('IRIS Relay bootstrap complete.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:  # the reason is always shown; credentials never are
        print('IRIS Relay bootstrap failed:', error, file=sys.stderr)
        sys.exit(1)
