#!/usr/bin/env python3
"""Isolated administrator setup, configuration precedence and password persistence."""
import json,os,pathlib,socket,subprocess,tempfile,time,urllib.request,urllib.error,pty,select,signal
binary=str(pathlib.Path(__file__).resolve().parents[1]/'target/debug/gotty-hub')
def read_until(fd,word):
 output=b'';end=time.time()+10
 while time.time()<end:
  ready,_,_=select.select([fd],[],[],.1)
  if ready:
   try:output+=os.read(fd,4096)
   except OSError:break
   if word.encode() in output:return output
 raise AssertionError('missing interactive prompt '+word)
def login(origin,password):
 request=urllib.request.Request(origin+'/api/v1/auth/password/login',data=json.dumps({'username':'admin','password':password}).encode(),headers={'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(request) as response:return response.status,json.load(response),response.headers.get('Set-Cookie').split(';')[0]
 except urllib.error.HTTPError as error:return error.code,json.load(error),''
with tempfile.TemporaryDirectory(prefix='hub-config-test-') as tmp:
 env={k:v for k,v in os.environ.items() if k not in ['HUB_PASSWORD','HUB_ORIGIN','HUB_DATABASE','HUB_ASSETS']};env['HUB_HOME']=tmp+'/home'
 result=subprocess.run([binary],env=env,stdin=subprocess.DEVNULL,capture_output=True);assert result.returncode!=0 and b'password is required' in result.stderr
 subprocess.run([binary,'config','--password','file password'],env=env,check=True,capture_output=True)
 config=pathlib.Path(env['HUB_HOME'],'config');assert json.loads(config.read_text())=={'password':'file password'};assert config.stat().st_mode&0o777==0o600
 subprocess.run([binary,'config','--password','cli password'],env={**env,'HUB_PASSWORD':'env password'},check=True,capture_output=True);assert json.loads(config.read_text())['password']=='cli password'
 subprocess.run([binary,'config','--password-stdin'],input=b'  spaced password  \n',env=env,check=True,capture_output=True);assert json.loads(config.read_text())['password']=='  spaced password  '
 result=subprocess.run([binary,'serve','--password',' '],env=env,stdin=subprocess.DEVNULL,capture_output=True);assert result.returncode!=0
 fresh={**env,'HUB_PASSWORD':'ignored first launch password','HUB_HOME':tmp+'/interactive','HUB_LISTEN':'127.0.0.1:0'}
 pid,fd=pty.fork()
 if pid==0:os.execve(binary,[binary],fresh)
 try:
  read_until(fd,'admin password:');os.write(fd,b'\n');read_until(fd,'admin password:');os.write(fd,b'interactive password\n');output=read_until(fd,'Hub listening');assert b'interactive password' not in output
  saved=json.loads(pathlib.Path(fresh['HUB_HOME'],'config').read_text());assert saved=={'password':'interactive password'}
 finally:os.kill(pid,signal.SIGTERM);os.waitpid(pid,0);os.close(fd)
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 origin=f'http://127.0.0.1:{port}'
 def start(args,input_data=None):
  process=subprocess.Popen([binary,*args],env={**env,'HUB_PASSWORD':'env password','HUB_LISTEN':f'127.0.0.1:{port}','HUB_ORIGIN':origin},cwd=tmp,stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
  if input_data is not None:process.stdin.write(input_data);process.stdin.close()
  for _ in range(100):
   try:
    with urllib.request.urlopen(origin+'/readyz') as response:assert response.status==200
    return process
   except Exception:
    if process.poll() is not None:raise AssertionError(process.stderr.read().decode())
    time.sleep(.1)
  process.terminate();process.wait();raise AssertionError('standalone launch failed')
 # Admin requires a nonempty password, without the ordinary user's 12-byte minimum.
 process=start(['serve','--password','x'])
 try:
  status,user,cookie=login(origin,'x');assert status==200 and user['username']=='admin' and user['is_admin']
  assert login(origin,'env password')[0]==401
  assert json.loads(config.read_text())['password']=='  spaced password  '
  new_password='changed admin password'
  request=urllib.request.Request(origin+'/api/v1/me/password',method='PUT',data=json.dumps({'password':new_password}).encode(),headers={'Content-Type':'application/json','Cookie':cookie,'X-CSRF-Token':user['csrf']})
  with urllib.request.urlopen(request) as response:assert response.status==200
  assert json.loads(config.read_text())['password']==new_password
  assert login(origin,new_password)[0]==200
  assert pathlib.Path(env['HUB_HOME'],'hub.db').exists() and pathlib.Path(env['HUB_HOME'],'logs').exists()
 finally:process.terminate();process.wait(timeout=10)
 # An explicit startup override remains authoritative on the next launch.
 process=start(['--password','override password'])
 try:assert login(origin,'override password')[0]==200 and login(origin,'changed admin password')[0]==401
 finally:process.terminate();process.wait(timeout=10)
 process=start(['serve','--password-stdin'],b'stdin startup override\n')
 try:
  status,user,cookie=login(origin,'stdin startup override');assert status==200
  request=urllib.request.Request(origin+'/api/v1/admin/restart',data=b'{}',headers={'Content-Type':'application/json','Cookie':cookie,'X-CSRF-Token':user['csrf']})
  with urllib.request.urlopen(request) as response:assert response.status==200
  time.sleep(4)
  assert process.poll() is None and login(origin,'stdin startup override')[0]==200
  assert b'--password-stdin' not in pathlib.Path(f'/proc/{process.pid}/cmdline').read_bytes()
 finally:process.terminate();process.wait(timeout=10)
print('PASS single hidden admin prompt, fixed identity, private config, stdin/spaces, CLI > env > config, admin Web password persistence and startup override')
