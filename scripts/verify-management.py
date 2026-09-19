#!/usr/bin/env python3
"""Integration check for the disposable local lab, with Relay running on port 8787.
Temporarily changes five named disposable fixtures, then restores their state.
Do not point Relay at another instance while running this check.
"""
import json,urllib.request,urllib.error,http.cookiejar,base64
from pathlib import Path
import os
os.chdir(Path(__file__).resolve().parents[1])
c=json.loads(Path('artifacts/lab-credentials.json').read_text())
jar=http.cookiejar.CookieJar(); op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)); origin='http://127.0.0.1:8787';csrf=''
def api(path,method='GET',data=None):
 req=urllib.request.Request(origin+path,method=method,headers={'Origin':origin,'Content-Type':'application/json','X-Relay-CSRF':csrf},data=json.dumps(data).encode() if data is not None else None)
 try:
  with op.open(req) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
code,login=api('/api/login','POST',{'username':c['username'],'password':c['password']});assert code==200,login;assert login['server']==c.get('url','http://127.0.0.1:52785'), 'Relay is not connected to this laboratory';csrf=login['csrf']
report=[]
for kind,name,changes in [('webapps','/relay-demo',[{'enabled':True},{'enabled':False}]),('users','RelayDemoUser',[{'roles':['%Operator']},{'roles':[]}]),('collections','RelayDemo',[{'policy':{'EditResource':'%Admin_Wallet:USE','UseResource':'%Admin_Operate:USE'}},{'policy':{'EditResource':'%Admin_Wallet:USE','UseResource':'%Admin_Wallet:USE'}}]),('certificates','RelayDemoCertificate',[{'owners':['RelayLab','RelayObserver']},{'owners':['RelayLab']}]),('oauthResources','RelayDemoOAuth',[{'enabled':True},{'enabled':False}])]:
 code,before=api('/api/manage/details?'+urllib.parse.urlencode({'kind':kind,'name':name}));assert code==200 and before['editable'],before
 original=before['data']
 try:
  for change in changes:
   code,p=api('/api/manage/preview','POST',{'kind':kind,'name':name,**change});assert code==200,p
   code,a=api('/api/manage/apply','POST',{'token':p['token']});assert code==200 and a['verified'],a
   replay,_=api('/api/manage/apply','POST',{'token':p['token']});assert replay==409
   report.append({'kind':kind,'desired':change,'verified':a['verified'],'replayStatus':replay})
  code,after=api('/api/manage/details?'+urllib.parse.urlencode({'kind':kind,'name':name}));assert code==200
  assert before['data']==after['data'], 'Configuration did not return to original'
 finally:
  # Always try restoring this disposable fixture after an interrupted check.
  restore={'enabled':original['Enabled']} if kind in ['webapps','oauthResources'] else {'roles':original['Roles']} if kind=='users' else {'owners':original['OwnerList']} if kind=='certificates' else {'policy':{k:original[k] for k in ['EditResource','UseResource']}}
  code,p=api('/api/manage/preview','POST',{'kind':kind,'name':name,**restore})
  if code==200:
   code,a=api('/api/manage/apply','POST',{'token':p['token']});assert code==200 and a['verified']
code,catalog=api('/api/explorer/catalog');assert code==200
parameters={'webapp':{'name':'/relay-demo'},'user':{'name':'RelayDemoUser'},'role':{'name':'%Operator'},'collection':{'name':'RelayDemo'},'secretNames':{'collection':'RelayDemo'},'certificate':{'alias':'RelayMissingFixture'},'x509':{'alias':'RelayMissingFixture'},'oauthDefinition':{'serverId':2147483647}}
for operation in catalog['operations']:
 code,result=api('/api/explorer/run','POST',{'operation':operation,'parameters':parameters.get(operation,{})})
 expected=404 if operation in ['certificate','x509','oauthDefinition'] else 200
 assert code==expected,(operation,code,result)
 report.append({'explorer':operation,'status':code,'purpose':'nonexistent record failure check' if expected==404 else 'live data query'})
for payload in [{'operation':'https://example.com'},{'operation':'tasks','parameters':{'maxRows':101}},{'operation':'tasks','parameters':{'method':'DELETE'}}]:
 code,_=api('/api/explorer/run','POST',payload);assert code==400
for operation,params in [('certificate',{'alias':'RelayDemoCertificate'}),('x509',{'alias':'RelayDemoCertificate'}),('oauthDefinition',{'serverId':1})]:
 code,result=api('/api/explorer/run','POST',{'operation':operation,'parameters':params});assert code==200,(operation,result)
 report.append({'populatedSecurityDetail':operation,'status':code})
code,start=api('/api/audit/query','POST',{'maxRows':10});assert code==202 and not start['complete'],start
import time
for attempt in range(20):
 code,result=api('/api/audit/result?'+urllib.parse.urlencode({'id':start['id']}));assert code==200,result
 if result['complete']:break
 assert result['state'] in ['Queued','Running'],result
 time.sleep(.2)
else:raise AssertionError('Audit did not finish within the integration-check window')
assert len(result['data'])<=10
assert all('EventData' not in row and 'SessionID' not in row for row in result['data'])
report.append({'auditState':result['state'],'returnedRecords':len(result['data'])})
for data in [{'kind':'webapps','name':'/api/admin','enabled':False},{'kind':'users','name':'RelayLab','roles':[]},{'kind':'users','name':'RelayDemoUser','roles':['%All']}]:
 code,v=api('/api/manage/preview','POST',data);assert code==403,v
 report.append({'protected':data['name'],'status':code})
code,login=api('/api/login','POST',{'username':'RelayObserver','password':c['observerPassword']});assert code==200;csrf=login['csrf']
code,v=api('/api/manage/preview','POST',{'kind':'webapps','name':'/relay-demo','enabled':True});assert code==403,v
report.append({'observerWriteStatus':code})
code,v=api('/api/explorer/run','POST',{'operation':'roles','parameters':{}});assert code==403,v
report.append({'observerRestrictedExplorerStatus':code})
code,_=api('/api/audit/result?'+urllib.parse.urlencode({'id':start['id']}));assert code==404
code,_=api('/api/audit/query','POST',{'maxRows':10});assert code==403
report.append({'observerAuditStatus':code,'crossSessionQueryStatus':404})
Path('artifacts/management-live.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
