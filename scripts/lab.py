#!/usr/bin/env python3
"""Create an isolated local IRIS laboratory; never use with production data."""
import json
import argparse
import secrets
import subprocess
import time
import urllib.request
import urllib.error
import base64
from pathlib import Path
from security_fixtures import provision

ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'containers.intersystems.com/intersystems/iris-community@sha256:87c8b9062530093d30384d66caa9933b8399bfbace7ddb7f1bdb983c0bfdb85b'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--name',default='iris-relay-2026-2')
parser.add_argument('--port',type=int,default=52785)
parser.add_argument('--credentials',default='artifacts/lab-credentials.json')
args=parser.parse_args()
if not 1024 <= args.port <= 65535: parser.error('Use an unprivileged local port.')
NAME=args.name
CREDENTIALS=(ROOT / args.credentials).resolve()
LAB_URL='http://127.0.0.1:'+str(args.port)

def command(*args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, check=True, timeout=90, **kwargs)

def session(script, namespace='%SYS'):
    out = command('docker', 'exec', '-i', NAME, 'iris', 'session', 'IRIS', '-U', namespace, input=script+'\nhalt\n').stdout
    if 'ERROR #' in out or '<' in out or 'RELAY_READY' not in out:
        raise RuntimeError('IRIS setup did not confirm completion. Inspect the local container and retry; credentials were not printed.')

existing=subprocess.run(['docker','inspect',NAME],text=True,capture_output=True)
if existing.returncode == 0:
    info=json.loads(existing.stdout)[0]
    if info['Config']['Image'] != IMAGE or not CREDENTIALS.exists():
        raise RuntimeError('An existing container occupies the lab name without this setup record. It was not changed.')
    if not info['State']['Running']:
        command('docker','start',NAME)
    creds=json.loads(CREDENTIALS.read_text())
else:
    command('docker','run','-d','--name',NAME,'--memory=2g','--cpus=2','-p','127.0.0.1:'+str(args.port)+':52773',IMAGE)
    creds={'username':'RelayLab','password':secrets.token_urlsafe(24),'observerPassword':secrets.token_urlsafe(24),'url':LAB_URL}
    CREDENTIALS.parent.mkdir(exist_ok=True)
    # Exclusive create prevents replacing an earlier credential file.
    with CREDENTIALS.open('x') as file:
        file.write(json.dumps(creds,indent=2))
    CREDENTIALS.chmod(0o600)

for attempt in range(30):
    try:
        state=command('docker','exec',NAME,'iris','qlist','IRIS').stdout
        if '^running' in state:
            break
    except subprocess.CalledProcessError:
        pass
    time.sleep(1)
else:
    raise RuntimeError('IRIS did not start within 30 seconds.')

# Generated credentials contain only URL-safe characters, and are never user input.
session('''if '##class(Security.Users).Exists("RelayLab") { set sc=##class(Security.Users).Create("RelayLab","%%All","%s") if $SYSTEM.Status.IsError(sc) { halt } }
if '##class(Security.Users).Exists("RelayObserver") { set sc=##class(Security.Users).Create("RelayObserver","%%Operator","%s") if $SYSTEM.Status.IsError(sc) { halt } }
write "RELAY_READY",!
''' % (creds['password'],creds['observerPassword']))
command('docker','exec',NAME,'mkdir','-p','/tmp/relay-src','/usr/irissys/mgr/relay')
command('docker','cp',str(ROOT/'src'/'Relay'/'log_reader.py'),NAME+':/usr/irissys/mgr/relay/log_reader.py')
command('docker','cp',str(ROOT/'src'/'Relay')+'/.',NAME+':/tmp/relay-src')
session('''set sc=$SYSTEM.OBJ.Load("/tmp/relay-src/LogReader.cls","ck")
if $SYSTEM.Status.IsError(sc) { halt }
set sc=$SYSTEM.OBJ.Load("/tmp/relay-src/Api.cls","ck")
if $SYSTEM.Status.IsError(sc) { halt }
set props("NameSpace")="%SYS",props("DispatchClass")="Relay.Api",props("AutheEnabled")=32,props("Enabled")=1
if '##class(Security.Applications).Exists("/api/relay") { set sc=##class(Security.Applications).Create("/api/relay",.props) if $SYSTEM.Status.IsError(sc) { halt } }
write "RELAY_READY",!
''')
command('docker','cp',str(ROOT/'fixtures'/'Relay'/'DemoApi.cls'),NAME+':/tmp/RelayDemoApi.cls')
session('''set sc=$SYSTEM.OBJ.Load("/tmp/RelayDemoApi.cls","ck")
if $SYSTEM.Status.IsError(sc) { halt }
write "RELAY_READY",!
''', 'USER')
session('''set props("NameSpace")="USER",props("DispatchClass")="Relay.DemoApi",props("AutheEnabled")=32,props("Enabled")=0,props("Resource")="%%Admin_Operate",props("Description")="Disposable Relay demonstration application"
if '##class(Security.Applications).Exists("/relay-demo") { set sc=##class(Security.Applications).Create("/relay-demo",.props) if $SYSTEM.Status.IsError(sc) { halt } }
if '##class(Security.Users).Exists("RelayDemoUser") { set sc=##class(Security.Users).Create("RelayDemoUser","","%s") if $SYSTEM.Status.IsError(sc) { halt } kill props set props("Enabled")=0,props("FullName")="Disposable Relay demonstration account" set sc=##class(Security.Users).Modify("RelayDemoUser",.props) if $SYSTEM.Status.IsError(sc) { halt } }
write "RELAY_READY",!
''' % secrets.token_urlsafe(30))
command('docker','cp',str(ROOT/'fixtures'/'Relay'/'SmokeTask.cls'),NAME+':/tmp/RelaySmokeTask.cls')
session('''set sc=$SYSTEM.OBJ.Load("/tmp/RelaySmokeTask.cls","ck")
if $SYSTEM.Status.IsError(sc) { halt }
if '$Data(^RelayLabFixture) { set t=##class(%SYS.Task).%New(),t.Name="Relay demonstration task",t.TaskClass="Relay.SmokeTask",t.NameSpace="USER",t.RunAsUser="RelayLab",t.TimePeriod=0,t.TimePeriodEvery=1,t.DailyStartTime=86399,t.StartDate=$Piece($Horolog,",",1)+1 set sc=t.%Save() if $SYSTEM.Status.IsError(sc) { halt } set ^RelayLabFixture=t.%Id() }
write "RELAY_READY",!
''', 'USER')
# Provision a disposable wallet collection through the documented management API.
wallet_url=LAB_URL+'/api/admin/v2/wallet/collection?name=RelayDemo'
headers={'Authorization':'Basic '+base64.b64encode((creds['username']+':'+creds['password']).encode()).decode(),'Content-Type':'application/json'}
try:
    with urllib.request.urlopen(urllib.request.Request(wallet_url,headers=headers),timeout=10) as response:
        json.load(response)
except urllib.error.HTTPError as error:
    if error.code != 404: raise RuntimeError('Wallet fixture lookup failed.') from None
    payload=json.dumps({'EditResource':'%Admin_Wallet:USE','UseResource':'%Admin_Wallet:USE'}).encode()
    with urllib.request.urlopen(urllib.request.Request(wallet_url,method='PUT',headers=headers,data=payload),timeout=10) as response:
        result=json.load(response)
        if result.get('status',{}).get('errors'): raise RuntimeError('Wallet fixture creation failed.')
provision(NAME,LAB_URL,creds)
print('Local IRIS ready at '+LAB_URL)
print('Private laboratory credentials: '+str(CREDENTIALS))
print('Run IRIS_URL='+LAB_URL+' npm start, then open http://127.0.0.1:8787')
print('Stop the lab with: docker stop '+NAME)
