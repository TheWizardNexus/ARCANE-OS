import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const simulatedPlatform=process.platform==='win32'?'win32':'linux';

function createClient(app){
  const child=spawn(
    process.execPath,
    [path.join(root,'runtime/arcane-core.cjs'),`--app=${app}`,'--simulate',`--simulate-platform=${simulatedPlatform}`,`--bundle-root=${root}`],
    { stdio:['pipe','pipe','pipe'] }
  );
  let buffer=Buffer.alloc(0);
  let expected=null;
  let stderr='';
  const pending=new Map();
  const events=[];
  child.stderr.on('data',chunk=>{ stderr+=chunk.toString(); });
  child.stdout.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    while(true){
      if(expected===null){
        const marker=buffer.indexOf('\r\n\r\n');
        if(marker<0)return;
        const match=buffer.subarray(0,marker).toString('ascii').match(/Content-Length:\s*(\d+)/i);
        if(!match)throw new Error('Invalid Arcane frame');
        expected=Number(match[1]);
        buffer=buffer.subarray(marker+4);
      }
      if(buffer.length<expected)return;
      const message=JSON.parse(buffer.subarray(0,expected).toString('utf8'));
      buffer=buffer.subarray(expected);
      expected=null;
      if(message.type==='event')events.push(message);
      if(message.type==='response'){
        const entry=pending.get(message.id);
        if(!entry)continue;
        pending.delete(message.id);
        message.ok?entry.resolve(message.result):entry.reject(Object.assign(new Error(message.error.message),message.error));
      }
    }
  });

  return {
    events,
    call(method,parameters={}){
      const id=crypto.randomUUID();
      const body=Buffer.from(JSON.stringify({ protocol:'arcane/1',type:'request',id,method,parameters }));
      child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]));
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{
          pending.delete(id);
          reject(new Error(`Timeout: ${method}\n${stderr}`));
        },15000);
        pending.set(id,{
          resolve(value){ clearTimeout(timer);resolve(value); },
          reject(error){ clearTimeout(timer);reject(error); },
        });
      });
    },
    close(){ child.stdin.end();child.kill(); },
  };
}

const shell=createClient('shell');
try{
  const app=await shell.call('app.current');
  assert.equal(app.id,'shell');
  const capabilities=await shell.call('capabilities.list');
  assert(capabilities.methods.includes('session.logout'));
  assert(!capabilities.methods.includes('installation.ensure'));
  const metrics=await shell.call('system.metrics');
  assert(metrics.logicalProcessors>0);
  assert(capabilities.grants.includes('storage.read'));
  assert(capabilities.grants.includes('storage.write'));
  const saved=await shell.call('storage.set',{ key:'dashboard.chart.config',value:{ title:'Cases',series:['open','closed'] } });
  assert.equal(saved.value.title,'Cases');
  const loaded=await shell.call('storage.get',{ key:'dashboard.chart.config' });
  assert.equal(loaded.found,true);
  assert.deepEqual(loaded.value.series,['open','closed']);
  const stored=await shell.call('storage.list');
  assert.deepEqual(stored.keys,['dashboard.chart.config']);
  await shell.call('storage.delete',{ key:'dashboard.chart.config' });
  assert.equal((await shell.call('storage.get',{ key:'dashboard.chart.config' })).found,false);
  await assert.rejects(
    shell.call('storage.set',{ key:'../escape',value:true }),
    error=>error.code==='INVALID_STORAGE_KEY'
  );
  const logout=await shell.call('session.logout');
  assert.equal(logout.simulated,true);
  for(const method of ['installation.ensure','requirements.ensure','users.add','users.activate','users.resetPassword','users.applyPassword']){
    await assert.rejects(
      shell.call(method,method==='users.add'?{usernames:['arcane-policy-test']}:{username:'arcane-policy-test'}),
      error=>error.code==='METHOD_NOT_ALLOWED'&&error.method===method,
      `${method} must be denied to the shell before elevation`
    );
  }
  assert(!shell.events.some(event=>event.event==='operation.started'),'denied shell calls must not start privileged operations');
}finally{
  shell.close();
}

const provisioner=createClient('provisioner');
try{
  const capabilities=await provisioner.call('capabilities.list');
  assert(capabilities.methods.includes('installation.ensure'));
  assert(capabilities.methods.includes('provisioning.plan'));
  assert(!capabilities.methods.includes('storage.set'));
  await assert.rejects(
    provisioner.call('storage.set',{ key:'nope',value:true }),
    error=>error.code==='METHOD_NOT_ALLOWED'&&error.method==='storage.set'
  );
  const plan=await provisioner.call('provisioning.plan',{ usernames:['arcane-policy-test'] });
  assert.equal(plan.users[0].username,'arcane-policy-test');
  assert.equal(plan.simulation,true);
}finally{
  provisioner.close();
}

console.log('Arcane per-application capability policy smoke test passed.');
