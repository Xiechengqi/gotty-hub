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
def login(origin,password,request_origin=None,request_host=None):
 headers={'Content-Type':'application/json'}
 if request_origin is not None:headers['Origin']=request_origin
 if request_host is not None:headers['Host']=request_host
 request=urllib.request.Request(origin+'/api/v1/auth/password/login',data=json.dumps({'username':'admin','password':password}).encode(),headers=headers)
 try:
  with urllib.request.urlopen(request) as response:return response.status,json.load(response),response.headers.get('Set-Cookie').split(';')[0]
 except urllib.error.HTTPError as error:return error.code,json.load(error),''
with tempfile.TemporaryDirectory(prefix='hub-config-test-') as tmp:
 env={k:v for k,v in os.environ.items() if k not in ['HUB_PASSWORD','HUB_ORIGIN','HUB_TRUSTED_PROXIES','HUB_LISTEN','HUB_DEV','HUB_DATABASE','HUB_ASSETS']};env['HUB_HOME']=tmp+'/home'
 result=subprocess.run([binary],env=env,stdin=subprocess.DEVNULL,capture_output=True);assert result.returncode!=0 and b'password is required' in result.stderr
 subprocess.run([binary,'config','--password','file password'],env=env,check=True,capture_output=True)
 config=pathlib.Path(env['HUB_HOME'],'config');assert json.loads(config.read_text())=={'password':'file password'};assert config.stat().st_mode&0o777==0o600
 subprocess.run([binary,'config','--password','cli password'],env={**env,'HUB_PASSWORD':'env password'},check=True,capture_output=True);assert json.loads(config.read_text())['password']=='cli password'
 subprocess.run([binary,'config','--password-stdin'],input=b'  spaced password  \n',env=env,check=True,capture_output=True);assert json.loads(config.read_text())['password']=='  spaced password  '
 result=subprocess.run([binary,'serve','--password',' '],env=env,stdin=subprocess.DEVNULL,capture_output=True);assert result.returncode!=0
 # Proxy settings keep their precedence; old fixed origins no longer pin a domain.
 network={**env,'HUB_HOME':tmp+'/network','HUB_ORIGIN':'https://env.example','HUB_TRUSTED_PROXIES':'192.0.2.0/24'}
 subprocess.run([binary,'config','--password','network password','--origin','https://CLI.example:443/','--trusted-proxies','127.0.0.1,::1'],env=network,check=True,capture_output=True)
 network_config=pathlib.Path(network['HUB_HOME'],'config');saved=json.loads(network_config.read_text())
 assert 'origin' not in saved and saved['trusted_proxies']==['127.0.0.1/32','::1/128']
 network_config.write_text(json.dumps({**saved,'origin':'https://old.example'}))
 assert subprocess.run([binary,'check'],env=network,capture_output=True).returncode==0
 subprocess.run([binary,'config','--origin','auto','--trusted-proxies','none'],env=network,check=True,capture_output=True)
 saved=json.loads(network_config.read_text());assert 'origin' not in saved and saved['trusted_proxies']==[]
 assert subprocess.run([binary,'check','--trusted-proxies','invalid'],env=network,capture_output=True).returncode!=0
 fresh={**env,'HUB_PASSWORD':'ignored first launch password','HUB_HOME':tmp+'/interactive','HUB_LISTEN':'127.0.0.1:0'}
 pid,fd=pty.fork()
 if pid==0:os.execve(binary,[binary],fresh)
 try:
  read_until(fd,'admin password:');os.write(fd,b'\n');read_until(fd,'admin password:');os.write(fd,b'interactive password\n');output=read_until(fd,'Hub listening');assert b'interactive password' not in output
  saved=json.loads(pathlib.Path(fresh['HUB_HOME'],'config').read_text());assert saved=={'password':'interactive password'}
 finally:os.kill(pid,signal.SIGTERM);os.waitpid(pid,0);os.close(fd)
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 origin=f'http://127.0.0.1:{port}'
 def start(args,input_data=None,public_origin=origin):
  process=subprocess.Popen([binary,*args],env={**env,'HUB_PASSWORD':'env password','HUB_LISTEN':f'127.0.0.1:{port}','HUB_ORIGIN':public_origin},cwd=tmp,stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
  if input_data is not None:process.stdin.write(input_data);process.stdin.close()
  for _ in range(100):
   try:
    with urllib.request.urlopen(origin+'/readyz') as response:assert response.status==200
    return process
   except Exception:
    if process.poll() is not None:raise AssertionError(process.stderr.read().decode())
    time.sleep(.1)
  process.terminate();process.wait();raise AssertionError('standalone launch failed')
 # Any public Host works without a domain setting, even with a stale HUB_ORIGIN.
 public_origin='http://hub.example:8088'
 process=start(['serve'],public_origin=public_origin)
 try:
  status,user,cookie=login(origin,'env password',public_origin,'hub.example:8088');assert status==200 and user['hub_address']==public_origin
  assert login(origin,'env password','http://other.example:8088','hub.example:8088')[0]==403
 finally:process.terminate();process.wait(timeout=10)
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
print('PASS request-based domains, ignored legacy origins, same-authority Origin guard, single hidden admin prompt, fixed identity, private config, stdin/spaces, password/proxy precedence, admin Web password persistence and startup override')
