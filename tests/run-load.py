#!/usr/bin/env python3
"""50 actual GoTTY processes, 100 authenticated WS streams, bounded-duration fixture."""
import hashlib,json,os,pathlib,signal,socket,sqlite3,subprocess,tempfile,time,urllib.request
root=pathlib.Path(__file__).resolve().parents[1]
def free():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def wait(url):
 for _ in range(200):
  try:urllib.request.urlopen(url,timeout=1);return
  except Exception:time.sleep(.1)
 raise RuntimeError('service not ready')
report=pathlib.Path(os.environ.get('HUB_LOAD_REPORT','/tmp/gotty-hub-load-report.json'))
with tempfile.TemporaryDirectory(prefix='gotty-hub-load-') as tmp:
 port=free();url=f'http://127.0.0.1:{port}';env={**os.environ,'HUB_DEV':'1','HUB_HOME':tmp+'/home','RESEND_API_KEY':'test-key','HUB_ADMIN_EMAIL':'owner@example.test','HUB_LISTEN':f'127.0.0.1:{port}','HUB_ORIGIN':url,'HUB_DATABASE':f'sqlite://{tmp}/hub.db?mode=rwc','HUB_DEV_MAIL_DIR':tmp+'/mail'}
 processes=[];samples=[]
 with open(tmp+'/process.log','w') as log:
  try:
   hub=subprocess.Popen([str(root/'target/debug/gotty-hub')],cwd=root,env=env,stdout=log,stderr=log,start_new_session=True);processes.append(hub);wait(url+'/healthz')
   conn=sqlite3.connect(tmp+'/hub.db');digest=lambda s:hashlib.sha256(s.encode()).hexdigest();session=os.urandom(32).hex();csrf=os.urandom(32).hex()
   conn.execute('INSERT INTO users(email) VALUES(?)',('load@example.test',));conn.execute('INSERT INTO sessions VALUES(?,?,?,?)',(digest(session),'load@example.test',csrf,int(time.time())+7200))
   for i in range(50):
    key=os.urandom(32).hex();identity=f'load-{i}';conn.execute('INSERT INTO instances(id,name,owner,device) VALUES(?,?,?,?)',(identity,identity,'load@example.test',digest(key)));conn.execute('INSERT INTO grants VALUES(?,?,?)',(identity,'load@example.test','owner'))
    directory=pathlib.Path(tmp,f'device-{i}');directory.mkdir(mode=0o700);state=directory/'hub.json';state.write_text(json.dumps({'url':url,'instance_id':identity,'credential':key}));state.chmod(0o600)
    process=subprocess.Popen([os.environ.get('GOTTY_BIN','/tmp/gotty-hub-tools/gotty'),'--address','127.0.0.1','--port',str(free()),'--permit-write','--hub-enabled','--hub-allow-http','--hub-state-file',str(state),'bash'],cwd=tmp,env=env,stdout=log,stderr=log,start_new_session=True);processes.append(process)
   conn.commit();conn.close();time.sleep(5)
   fixture=pathlib.Path(tmp,'fixture.json');fixture.write_text(json.dumps({'url':url,'session':session,'csrf':csrf}));fixture.chmod(0o600)
   client=subprocess.Popen(['node',str(root/'tests/load.cjs'),str(fixture),str(report)],cwd=root,env=env,start_new_session=True);processes.append(client)
   while client.poll() is None:
    rss=0
    try:
     for line in pathlib.Path(f'/proc/{hub.pid}/status').read_text().splitlines():
      if line.startswith('VmRSS:'):rss=int(line.split()[1])
    except FileNotFoundError:pass
    samples.append({'elapsed':len(samples)*5,'hub_rss_kib':rss});time.sleep(5)
   if client.returncode:raise RuntimeError('load client failed; '+pathlib.Path(tmp,'process.log').read_text()[-3000:])
   result=json.loads(report.read_text());result['memorySamples']=samples;result['hubPeakRSSKiB']=max(v['hub_rss_kib'] for v in samples);report.write_text(json.dumps(result,indent=2));print('Report:',report)
  finally:
   for process in processes:
    try:os.killpg(process.pid,signal.SIGTERM)
    except ProcessLookupError:pass
   for process in processes:
    try:process.wait(timeout=3)
    except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL)
