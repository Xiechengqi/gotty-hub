#!/usr/bin/env python3
"""Isolated real Hub + real GoTTY smoke test; no external mail or ASR requests."""
import os, pathlib, signal, socket, sqlite3, subprocess, tempfile, time, urllib.request
root=pathlib.Path(__file__).resolve().parents[1]
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def wait(url):
 for _ in range(200):
  try:
   urllib.request.urlopen(url,timeout=1);return
  except Exception:time.sleep(.1)
 raise RuntimeError('service failed to start: '+url)
with tempfile.TemporaryDirectory(prefix='gotty-hub-integration-') as tmp:
 hubport,gottyport,asrport=port(),port(),port()
 hub=f'http://127.0.0.1:{hubport}';gotty=f'http://127.0.0.1:{gottyport}'
 env={**os.environ,'HUB_DEV':'1','HUB_HOME':tmp+'/home','RESEND_API_KEY':'test-key','HUB_ADMIN_EMAIL':'owner@example.test','HUB_ORIGIN':hub,'HUB_LISTEN':f'127.0.0.1:{hubport}','HUB_DATABASE':f'sqlite://{tmp}/hub.db?mode=rwc','HUB_DEV_MAIL_DIR':tmp+'/mail','HUB_TEST_URL':hub,'GOTTY_TEST_URL':gotty,'HUB_TEST_MAIL':tmp+'/mail','GOTTY_TEST_STATE':tmp+'/device/hub.json'}
 binary=os.environ.get('GOTTY_BIN','/tmp/gotty-hub-tools/gotty')
 processes=[]
 try:
  with open(tmp+'/hub.log','w') as hlog,open(tmp+'/gotty.log','w') as glog:
   processes.append(subprocess.Popen(['node',str(root/'tests/asr-fixture.cjs'),str(asrport)],cwd=root,env=env,stdout=hlog,stderr=hlog,start_new_session=True))
   processes.append(subprocess.Popen([str(root/'target/debug/gotty-hub')],cwd=root,env=env,stdout=hlog,stderr=hlog,start_new_session=True))
   wait(hub+'/healthz')
   processes.append(subprocess.Popen([binary,'--address','127.0.0.1','--port',str(gottyport),'--permit-write','--enable-asr','--asr-backend',f'ws://127.0.0.1:{asrport}','--hub-enabled','--hub-allow-http','--hub-state-file',env['GOTTY_TEST_STATE'],'bash'],cwd=tmp,env=env,stdout=glog,stderr=glog,start_new_session=True))
   wait(gotty)
   subprocess.run(['node',str(root/'tests/smoke.cjs')],cwd=root,env=env,check=True,timeout=120)
   subprocess.run(['node',str(root/'tests/security.cjs')],cwd=root,env=env,check=True,timeout=120)
   def stage(name):subprocess.run(['node',str(root/'tests/recovery.cjs'),name],cwd=root,env=env,check=True,timeout=60)
   def watch():
    ready=pathlib.Path(env['GOTTY_TEST_STATE']+'.watch-ready');ready.unlink(missing_ok=True)
    p=subprocess.Popen(['node',str(root/'tests/recovery.cjs'),'watch'],cwd=root,env=env,start_new_session=True);processes.append(p)
    for _ in range(100):
     if ready.exists():return p
     if p.poll() is not None:raise RuntimeError('watcher failed')
     time.sleep(.1)
    raise RuntimeError('watcher not ready')
   stage('rotate')
   subprocess.run(['node',str(root/'tests/admin.cjs')],cwd=root,env=env,check=True,timeout=90)
   observer=watch();os.killpg(processes[2].pid,signal.SIGTERM);processes[2].wait(timeout=5);assert observer.wait(timeout=15)==0
   processes.append(subprocess.Popen([binary,'--address','127.0.0.1','--port',str(gottyport),'--permit-write','--enable-asr','--asr-backend',f'ws://127.0.0.1:{asrport}','--hub-enabled','--hub-allow-http','--hub-state-file',env['GOTTY_TEST_STATE'],'bash'],cwd=tmp,env=env,stdout=glog,stderr=glog,start_new_session=True))
   stage('online')
   observer=watch();os.killpg(processes[1].pid,signal.SIGTERM);processes[1].wait(timeout=5);assert observer.wait(timeout=15)==0
   # Restore an online-backup snapshot after the stopped Hub's WAL is checkpointed.
   with sqlite3.connect(tmp+'/hub.db') as original,sqlite3.connect(tmp+'/backup.db') as backup:
    original.backup(backup);assert backup.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
   with sqlite3.connect(tmp+'/backup.db') as backup,sqlite3.connect(tmp+'/hub.db') as restored:
    backup.backup(restored)
   print('PASS SQLite consistent backup, integrity check and restore',flush=True)
   processes.append(subprocess.Popen([str(root/'target/debug/gotty-hub')],cwd=root,env=env,stdout=hlog,stderr=hlog,start_new_session=True));wait(hub+'/healthz')
   stage('online');stage('unbind')
 except Exception:
  for name in ['hub.log','gotty.log']:
   print(f'--- {name} ---\n'+pathlib.Path(tmp,name).read_text()[-5000:])
  raise
 finally:
  for process in processes:
   try:os.killpg(process.pid,signal.SIGTERM)
   except ProcessLookupError:pass
  for process in processes:
   try:process.wait(timeout=5)
   except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL)
