#!/usr/bin/env python3
"""Opt-in test of real public GitHub release install in a disposable service."""
import hashlib,json,os,pathlib,secrets,shutil,socket,sqlite3,subprocess,tempfile,time,urllib.request
assert os.environ.get('HUB_UPGRADE_NETWORK')=='1','Set HUB_UPGRADE_NETWORK=1 to download the public release'
root=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='hub-real-upgrade-') as tmp:
 directory=pathlib.Path(tmp);binary=directory/'gotty-hub';shutil.copy2(root/'target/debug/gotty-hub',binary)
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 origin=f'http://127.0.0.1:{port}';home=directory/'home'
 env={**os.environ,'HUB_HOME':str(home),'HUB_DEV':'1','HUB_LISTEN':f'127.0.0.1:{port}','HUB_ORIGIN':origin,'RESEND_API_KEY':'test-key','HUB_ADMIN_EMAIL':'admin@example.test'}
 for key in ['HUB_DATABASE','HUB_ASSETS','HUB_DEV_MAIL_DIR']:env.pop(key,None)
 with open(directory/'process.log','w') as log:
  process=subprocess.Popen([str(binary)],env=env,cwd=tmp,stdout=log,stderr=log)
  try:
   for _ in range(150):
    try:urllib.request.urlopen(origin+'/readyz',timeout=1);break
    except Exception:time.sleep(.1)
   else:raise AssertionError('startup failed')
   token=secrets.token_hex(32);csrf=secrets.token_hex(32)
   with sqlite3.connect(home/'hub.db') as db:
    db.execute('INSERT INTO users(email) VALUES(?)',('admin@example.test',));db.execute('INSERT INTO sessions VALUES(?,?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),'admin@example.test',csrf,int(time.time())+3600))
   def api(path,body=None):
    request=urllib.request.Request(origin+'/api/v1'+path,data=json.dumps(body).encode() if body is not None else None,headers={'Cookie':'hub_session='+token,'Content-Type':'application/json','X-CSRF-Token':csrf,'Origin':origin})
    with urllib.request.urlopen(request,timeout=35) as response:return json.load(response)
   latest=api('/admin/version');assert latest['latest'];print('Latest release:',latest['latest'],flush=True)
   original=hashlib.sha256(binary.read_bytes()).hexdigest();assert api('/admin/upgrade',{})['ok']
   deadline=time.time()+420;state={}
   while time.time()<deadline:
    if process.poll() is not None:raise AssertionError('process exited during upgrade')
    try:
     state=api('/admin/upgrade')
     if state['stage']=='failed':raise AssertionError('upgrade failed')
     if state['stage']=='complete' and not state['active']:break
    except (OSError,urllib.error.URLError):pass
    time.sleep(1)
   else:raise AssertionError('upgrade did not complete: '+str(state))
   assert hashlib.sha256(binary.read_bytes()).hexdigest()!=original
   assert (home/'config').exists() and (home/'updates/previous.bin').exists()
   backups=list((home/'updates').glob('hub-*.db'));assert backups
   with sqlite3.connect(backups[0]) as db:assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
   assert api('/me')['is_admin'];assert api('/admin/dashboard')['revision']==state['target_revision'];assert b'<html' in urllib.request.urlopen(origin).read()
   print('PASS actual GitHub download/SHA256/probe/SQLite backup/atomic replace/exec, persisted admin session and embedded assets',flush=True)
  except Exception:
   print((directory/'process.log').read_text()[-4000:]);raise
  finally:
   if process.poll() is None:process.terminate();process.wait(timeout=10)
