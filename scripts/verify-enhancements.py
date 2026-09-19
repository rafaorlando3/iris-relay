#!/usr/bin/env python3
"""Verify 0.2 changes against the disposable lab. Never target production."""
import json, os, urllib.request, urllib.error, urllib.parse, http.cookiejar
from pathlib import Path
os.chdir(Path(__file__).resolve().parents[1])
c=json.loads(Path(os.environ.get('RELAY_CREDENTIALS','artifacts/lab-credentials.json')).read_text());origin=os.environ.get('RELAY_ORIGIN','http://127.0.0.1:8787');csrf=''
op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def api(path,method='GET',data=None):
 req=urllib.request.Request(origin+path,method=method,headers={'Origin':origin,'Content-Type':'application/json','X-Relay-CSRF':csrf},data=json.dumps(data).encode() if data is not None else None)
 try:
  with op.open(req,timeout=20) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
code,login=api('/api/login','POST',{'username':c['username'],'password':c['password']});assert code==200,login;assert login['server']==c['url'];csrf=login['csrf'];report=[]
fields={'tls':['Description','Enabled','TLSMinVersion','TLSMaxVersion','VerifyPeer'],'rolePolicy':['Description','Resources'],'oauthSettings':['Description','Enabled','IssuerEndpoint','Audiences','ScopeRequiredToConnect']}
for kind,name in [('tls','RelayDemoTLS'),('rolePolicy','RelayDemoRole'),('oauthSettings','RelayDemoOAuth')]:
 path='/api/manage/details?'+urllib.parse.urlencode({'kind':kind,'name':name});code,before=api(path);assert code==200 and before['editable'],before
 original={k:before['data'][k] for k in fields[kind]};desired={**original,'Description':original['Description']+' reviewed'}
 if kind=='tls':desired['TLSMinVersion']=32
 if kind=='rolePolicy':desired['Resources']=[{'Name':'%Admin_Operate','Permissions':'U'}]
 if kind=='oauthSettings':desired['Audiences']=['relay-demo','relay-reviewed'];desired['ScopeRequiredToConnect']='relay.reviewed'
 try:
  code,p=api('/api/manage/preview','POST',{'kind':kind,'name':name,'configuration':desired});assert code==200,p
  code,result=api('/api/manage/apply','POST',{'token':p['token']});assert code==200 and result['verified'],result
  replay,_=api('/api/manage/apply','POST',{'token':p['token']});assert replay==409
  report.append({'kind':kind,'verified':True,'replayStatus':replay})
 finally:
  code,p=api('/api/manage/preview','POST',{'kind':kind,'name':name,'configuration':original})
  if code==200:
   code,r=api('/api/manage/apply','POST',{'token':p['token']});assert code==200 and r['verified'],r
  elif code!=409:raise AssertionError(p)
 code,after=api(path);assert code==200 and before['data']==after['data'],after
 report[-1]['restored']=True
code,sources=api('/api/logs/sources');assert code==200,sources
for source in sources['sources']:
 code,p=api('/api/logs/page?'+urllib.parse.urlencode({'source':source['id']}))
 if source['available']:
  assert code==200 and isinstance(p['data'],list) and len(p['data'])<=150,p
  report.append({'log':source['name'],'records':len(p['data']),'state':'available'})
 else:
  assert code==409,p;report.append({'log':source['name'],'state':'unavailable','status':code})
for path in ['/api/logs/page?source=../../private','/api/logs/page?cursor=bad!']:
 code,_=api(path);assert code==400
code,login=api('/api/login','POST',{'username':'RelayObserver','password':c['observerPassword']});assert code==200;csrf=login['csrf']
for kind,name in [('tls','RelayDemoTLS'),('rolePolicy','RelayDemoRole'),('oauthSettings','RelayDemoOAuth')]:
 code,r=api('/api/manage/preview','POST',{'kind':kind,'name':name,'configuration':{}});assert code==403,r
 report.append({'observerDenied':kind,'status':code})
Path('artifacts/enhancements-live.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
