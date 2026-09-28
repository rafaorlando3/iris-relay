#!/usr/bin/env python3
"""Create an isolated local IRIS laboratory; never use with production data."""
import json
import argparse
import secrets
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'containers.intersystems.com/intersystems/iris-community@sha256:87c8b9062530093d30384d66caa9933b8399bfbace7ddb7f1bdb983c0bfdb85b'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--name',default='iris-relay-2026-2')
parser.add_argument('--port',type=int,default=52785)
parser.add_argument('--credentials',default='artifacts/lab-credentials.json')
parser.add_argument('--setup-record',default='artifacts/lab-setup.json',help='non-secret record binding this lab to its container ID')
parser.add_argument('--adopt-container',metavar='FULL_ID',help='one-time migration of a lab created before lab-setup.json existed: the full container ID you confirmed with docker inspect -f {{.Id}} NAME')
args=parser.parse_args()
if not 1024 <= args.port <= 65535: parser.error('Use an unprivileged local port.')
NAME=args.name
CREDENTIALS=(ROOT / args.credentials).resolve()
SETUP_RECORD=(ROOT / args.setup_record).resolve()
LAB_URL='http://127.0.0.1:'+str(args.port)

def command(*args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, check=True, timeout=90, **kwargs)

def refuse(reason):
    raise SystemExit('Refused, nothing was changed: '+reason)

def loopback_only(info):
    bindings=(info.get('HostConfig') or {}).get('PortBindings') or {}
    iris=bindings.get('52773/tcp') or []
    return len(bindings)==1 and len(iris)==1 and iris[0].get('HostIp')=='127.0.0.1' and str(iris[0].get('HostPort'))==str(args.port)

def read_record():
    try:
        return json.loads(SETUP_RECORD.read_text())
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        refuse('the lab record '+str(SETUP_RECORD)+' is unreadable.')

def write_record(container_id, exclusive):
    SETUP_RECORD.parent.mkdir(exist_ok=True)
    with SETUP_RECORD.open('x' if exclusive else 'w') as file:
        file.write(json.dumps({'name':NAME,'containerId':container_id,'image':IMAGE,'port':args.port,'url':LAB_URL},indent=2))

# A lab is reused only when the non-secret record written at creation binds this name to the
# exact container ID, the pinned image and a loopback-only port. Nothing else is adopted.
existing=subprocess.run(['docker','inspect',NAME],text=True,capture_output=True)
record=read_record()
if existing.returncode == 0:
    info=json.loads(existing.stdout)[0]
    if info['Config']['Image'] != IMAGE:
        refuse('container '+NAME+' does not use the pinned lab image.')
    if not loopback_only(info):
        refuse('container '+NAME+' is not published only on 127.0.0.1:'+str(args.port)+'.')
    if not CREDENTIALS.exists():
        refuse('the credentials file '+str(CREDENTIALS)+' for this lab is missing.')
    if args.adopt_container:
        if record is not None:
            refuse('a lab record already exists; --adopt-container is only for labs created before the record existed.')
        if args.adopt_container != info['Id']:
            refuse('--adopt-container must be the full ID of '+NAME+' (docker inspect -f {{.Id}} '+NAME+').')
        write_record(info['Id'], exclusive=True)
        print('Recorded container '+info['Id'][:12]+' as this lab.')
    elif record is None:
        refuse('container '+NAME+' exists but has no lab record at '+str(SETUP_RECORD)+'. If you created it with an earlier IRIS Relay, confirm its ID with docker inspect -f {{.Id}} '+NAME+' and run again with --adopt-container <that full ID>. Otherwise choose another --name, --port, --credentials and --setup-record.')
    elif record.get('name')!=NAME or record.get('containerId')!=info['Id'] or record.get('image')!=IMAGE or record.get('port')!=args.port:
        refuse('container '+NAME+' is not the container recorded in '+str(SETUP_RECORD)+'.')
    TARGET=info['Id']
    if not info['State']['Running']:
        command('docker','start',TARGET)
    creds=json.loads(CREDENTIALS.read_text())
else:
    if CREDENTIALS.exists() or record is not None:
        refuse('no container named '+NAME+', but '+str(CREDENTIALS if CREDENTIALS.exists() else SETUP_RECORD)+' already exists. Use new --credentials and --setup-record paths for a new lab.')
    TARGET=command('docker','run','-d','--name',NAME,'--memory=2g','--cpus=2','-p','127.0.0.1:'+str(args.port)+':52773',IMAGE).stdout.strip()
    # Non-secret record binding this lab to the exact container this script created.
    write_record(TARGET, exclusive=True)
    creds={'username':'RelayLab','password':secrets.token_urlsafe(24),'observerPassword':secrets.token_urlsafe(24),'url':LAB_URL}
    CREDENTIALS.parent.mkdir(exist_ok=True)
    # Exclusive create prevents replacing an earlier credential file.
    with CREDENTIALS.open('x') as file:
        file.write(json.dumps(creds,indent=2))
    CREDENTIALS.chmod(0o600)

# All provisioning runs inside the container through scripts/bootstrap.py, the same
# path docker compose uses. Only the files it needs are copied in.
command('docker','exec','-u','root',TARGET,'rm','-rf','/tmp/relay-bootstrap')
command('docker','exec',TARGET,'mkdir','-p','/tmp/relay-bootstrap/src','/tmp/relay-bootstrap/fixtures','/tmp/relay-bootstrap/scripts')
command('docker','cp',str(ROOT/'src'/'Relay'),TARGET+':/tmp/relay-bootstrap/src/Relay')
command('docker','cp',str(ROOT/'fixtures'/'Relay'),TARGET+':/tmp/relay-bootstrap/fixtures/Relay')
for helper in ['bootstrap.py','security_fixtures.py']:
    command('docker','cp',str(ROOT/'scripts'/helper),TARGET+':/tmp/relay-bootstrap/scripts/'+helper)
setup=subprocess.run(['docker','exec','-i',TARGET,'python3','/tmp/relay-bootstrap/scripts/bootstrap.py','--src','/tmp/relay-bootstrap','--credentials-stdin'],
                     input=json.dumps(creds),text=True,capture_output=True,timeout=600)
if setup.returncode != 0:
    raise SystemExit((setup.stderr.strip() or setup.stdout.strip() or 'bootstrap failed without a message')+' The container was left as it is for inspection.')
print('Local IRIS ready at '+LAB_URL)
print('Private laboratory credentials: '+str(CREDENTIALS))
print('Run IRIS_URL='+LAB_URL+' npm start, then open http://127.0.0.1:8787')
print('Stop the lab with: docker stop '+NAME)
