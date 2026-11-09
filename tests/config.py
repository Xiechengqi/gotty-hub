#!/usr/bin/env python3
"""CLI/config/bootstrap tests without sending mail or changing the caller's HOME."""
import json,os,pathlib,socket,subprocess,tempfile,time,urllib.request,pty,select,signal
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
with tempfile.TemporaryDirectory(prefix='hub-config-test-') as tmp:
 env={k:v for k,v in os.environ.items() if k not in ['RESEND_API_KEY','HUB_ADMIN_EMAIL','HUB_ORIGIN','HUB_DATABASE','HUB_ASSETS']};env['HUB_HOME']=tmp+'/home'
 result=subprocess.run([binary],env={**env,'RESEND_API_KEY':'ignored-on-first-noargs','HUB_ADMIN_EMAIL':'ignored@example.test'},stdin=subprocess.DEVNULL,capture_output=True);assert result.returncode!=0 and b'is required' in result.stderr
 subprocess.run([binary,'config','--resend-api-key','file-key','--admin-email','ADMIN@example.test'],env=env,check=True,capture_output=True)
 config=pathlib.Path(env['HUB_HOME'],'config');assert json.loads(config.read_text())=={'resend_api_key':'file-key','admin_email':'admin@example.test'};assert config.stat().st_mode&0o777==0o600
 result=subprocess.run([binary,'config','--resend-api-key','cli-key','--admin-email','cli@example.test'],env={**env,'RESEND_API_KEY':'env-key','HUB_ADMIN_EMAIL':'env@example.test'},check=True,capture_output=True);assert json.loads(config.read_text())['resend_api_key']=='cli-key'
 result=subprocess.run([binary,'serve','--resend-api-key',' ','--admin-email','cli@example.test'],env=env,stdin=subprocess.DEVNULL,capture_output=True);assert result.returncode!=0
 # No arguments, empty first entries: terminal prompts again and never echoes the key.
 fresh={**env,'HUB_HOME':tmp+'/interactive','HUB_LISTEN':'127.0.0.1:0'}
 pid,fd=pty.fork()
 if pid==0:os.execve(binary,[binary],fresh)
 try:
  read_until(fd,'Resend API key:');os.write(fd,b'\n');read_until(fd,'Resend API key:');os.write(fd,b'interactive-key\n');output=read_until(fd,'Admin email:');assert b'interactive-key' not in output
  os.write(fd,b'\n');read_until(fd,'Admin email:');os.write(fd,b'person@example.test\n');read_until(fd,'Hub listening')
  saved=json.loads(pathlib.Path(fresh['HUB_HOME'],'config').read_text());assert saved['admin_email']=='person@example.test' and saved['resend_api_key']=='interactive-key'
 finally:
  os.kill(pid,signal.SIGTERM);os.waitpid(pid,0);os.close(fd)
 # Run detached from checkout: embedded assets, database and logs stay under HUB_HOME.
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 process=subprocess.Popen([binary],env={**env,'HUB_LISTEN':f'127.0.0.1:{port}','HUB_ORIGIN':f'http://127.0.0.1:{port}'},cwd=tmp,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 try:
  for _ in range(100):
   try:
    response=urllib.request.urlopen(f'http://127.0.0.1:{port}/');assert b'<html' in response.read();break
   except Exception:time.sleep(.1)
  else:raise AssertionError('standalone launch failed')
  assert pathlib.Path(env['HUB_HOME'],'hub.db').exists();assert pathlib.Path(env['HUB_HOME'],'logs').exists()
 finally:process.terminate();process.wait(timeout=10)
print('PASS interactive required values/hidden secret, config permissions/precedence, noninteractive rejection, standalone assets and data home')
