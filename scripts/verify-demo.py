#!/usr/bin/env python3
"""Check a hosted public demo end to end, as a visitor would, and restore every change.

Usage: python3 scripts/verify-demo.py https://<demo host> [--insecure]
The shared demo account is read from the demo's own /api/config (it is public).
--insecure only skips TLS verification for https://localhost (local rehearsal).
"""
import http.cookiejar
import json
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

origin = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else 'https://localhost'
context = None
if '--insecure' in sys.argv:
    if urllib.parse.urlparse(origin).hostname != 'localhost':
        sys.exit('--insecure is only allowed for https://localhost.')
    context = ssl._create_unverified_context()
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), urllib.request.HTTPSHandler(context=context))
csrf = ''
report = []


def api(path, method='GET', data=None):
    req = urllib.request.Request(origin + path, method=method, data=json.dumps(data).encode() if data is not None else None,
                                 headers={'Origin': origin, 'Content-Type': 'application/json', 'X-Relay-CSRF': csrf})
    try:
        with opener.open(req, timeout=150) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def check(name, condition, detail=None):
    report.append({'check': name, 'ok': bool(condition)})
    if not condition:
        print(json.dumps(report, indent=1))
        sys.exit(f'FAILED: {name}: {detail}')


code, config = api('/api/config')
check('demo mode advertised', code == 200 and config.get('demo'), config)
code, r = api('/api/login', 'POST', {'username': 'RelayLab', 'password': 'not-the-demo-account'})
check('non-demo account refused before IRIS', code == 403, r)
code, login = api('/api/login', 'POST', {'username': config['username'], 'password': config['password']})
check('demo account signs in', code == 200, login)
csrf = login['csrf']

# Refusals: anything that is not a Relay demonstration object.
for kind, name, change in [('users', '_SYSTEM', {'roles': []}), ('users', config['username'], {'roles': ['%All']}),
                           ('webapps', '/csp/sys', {'enabled': False}), ('webapps', '/api/admin', {'enabled': False}),
                           ('tls', '%SuperServer', {'configuration': {}}), ('rolePolicy', '%Developer', {'configuration': {}})]:
    code, r = api('/api/manage/preview', 'POST', {'kind': kind, 'name': name, **change})
    check(f'refused {kind} {name}', code == 403, r)


def apply_and_restore(kind, name, change, restore):
    code, p = api('/api/manage/preview', 'POST', {'kind': kind, 'name': name, **change})
    check(f'preview {kind} {name}', code == 200, p)
    code, a = api('/api/manage/apply', 'POST', {'token': p['token']})
    check(f'applied and verified {kind} {name}', code == 200 and a.get('verified'), a)
    code, p = api('/api/manage/preview', 'POST', {'kind': kind, 'name': name, **restore})
    check(f'restore preview {kind} {name}', code == 200, p)
    code, a = api('/api/manage/apply', 'POST', {'token': p['token']})
    check(f'restored {kind} {name}', code == 200 and a.get('verified'), a)


for kind, name, change, restore in [
        ('webapps', '/relay-demo', {'enabled': True}, {'enabled': False}),
        ('users', 'RelayDemoUser', {'roles': ['%Operator']}, {'roles': []}),
        ('collections', 'RelayDemo', {'policy': {'EditResource': '%Admin_Wallet:USE', 'UseResource': '%Admin_Operate:USE'}},
         {'policy': {'EditResource': '%Admin_Wallet:USE', 'UseResource': '%Admin_Wallet:USE'}}),
        ('certificates', 'RelayDemoCertificate', {'owners': ['RelayLab', 'RelayObserver']}, {'owners': ['RelayLab']}),
        ('oauthResources', 'RelayDemoOAuth', {'enabled': True}, {'enabled': False})]:
    apply_and_restore(kind, name, change, restore)

fields = {'tls': ['Description', 'Enabled', 'TLSMinVersion', 'TLSMaxVersion', 'VerifyPeer'], 'rolePolicy': ['Description', 'Resources'],
          'oauthSettings': ['Description', 'Enabled', 'IssuerEndpoint', 'Audiences', 'ScopeRequiredToConnect']}
for kind, name in [('tls', 'RelayDemoTLS'), ('rolePolicy', 'RelayDemoRole'), ('oauthSettings', 'RelayDemoOAuth')]:
    code, before = api('/api/manage/details?' + urllib.parse.urlencode({'kind': kind, 'name': name}))
    check(f'details {kind}', code == 200 and before.get('editable'), before)
    original = {k: before['data'][k] for k in fields[kind]}
    apply_and_restore(kind, name, {'configuration': {**original, 'Description': original['Description'] + ' (demo check)'}},
                      {'configuration': original})

code, tasks = api('/api/resource/tasks')
check('tasks view', code == 200, tasks)
task = next((t for t in tasks['data'] if t.get('Name') == 'Relay demonstration task'), None)
check('demo task present', task, tasks)
other = next((t for t in tasks['data'] if t.get('Name') != 'Relay demonstration task'), None)
code, r = api('/api/tasks/preview', 'POST', {'taskId': other['Id'], 'action': 'suspend'})
check('other task refused', code == 403, r)
for action in ['suspend', 'resume']:
    code, p = api('/api/tasks/preview', 'POST', {'taskId': task['Id'], 'action': action})
    check(f'task {action} preview', code == 200, p)
    code, a = api('/api/tasks/apply', 'POST', {'token': p['token']})
    check(f'task {action} verified', code == 200 and a.get('verified'), a)

code, sources = api('/api/logs/sources')
check('log sources', code == 200 and any(s['available'] for s in sources['sources']), sources)
code, page = api('/api/logs/page?source=runtime')
check('log page', code == 200 and page['data'], page)
code, idx = api('/api/logs/index', 'POST', {})
check('similarity index', code == 200 and idx.get('totalLines', 0) > 0, idx)
code, found = api('/api/logs/search?' + urllib.parse.urlencode({'q': 'journaling started', 'limit': 5}))
check('similarity search', code == 200 and found['rows'], found)
# Guided tour: the labelled, simulated incident planted by the demo bootstrap.
archived = [s for s in sources['sources'] if s.get('archived') and s['available']]
check('archived rotation listed for the guided tour', archived, sources)
code, old = api('/api/logs/page?' + urllib.parse.urlencode({'source': archived[0]['id']}))
check('archived rotation readable and labelled', code == 200 and any('[Relay demo' in r['Message'] for r in old['data']), old)
code, incident = api('/api/logs/search?' + urllib.parse.urlencode({'q': 'license limit exceeded', 'limit': 5}))
files = {name for row in incident.get('rows', []) for name in row['Files']} if code == 200 else set()
check('guided tour incident found in the current and archived logs',
      code == 200 and incident['rows'] and '[Relay demo incident]' in incident['rows'][0]['Message']
      and 'messages.log' in files and archived[0]['name'] in files, incident)
code, audit = api('/api/audit/query', 'POST', {'maxRows': 5})
check('audit query accepted', code in (200, 202), audit)
code, catalog = api('/api/explorer/catalog')
check('explorer catalog', code == 200 and catalog['operations'], catalog)
print(json.dumps({'origin': origin, 'checks': len(report), 'allPassed': all(r['ok'] for r in report)}, indent=1))
