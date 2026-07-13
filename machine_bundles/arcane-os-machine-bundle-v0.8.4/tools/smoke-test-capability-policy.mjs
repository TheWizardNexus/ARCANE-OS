import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const simulatedPlatform=process.platform==='win32'?'win32':'linux';

function createClient(app,options={}){
  const platform=options.platform||simulatedPlatform;
  const child=spawn(
    process.execPath,
    [path.join(root,'runtime/arcane-core.cjs'),`--app=${app}`,'--simulate',`--simulate-platform=${platform}`,`--bundle-root=${root}`,...(options.extraArgs||[])],
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
  assert(capabilities.methods.includes('system.lock'));
  assert(!capabilities.methods.includes('installation.ensure'));
  const metrics=await shell.call('system.metrics');
  assert(metrics.logicalProcessors>0);
  assert(capabilities.grants.includes('storage.read'));
  assert(capabilities.grants.includes('storage.write'));
  assert(capabilities.grants.includes('applications.read'));
  assert(capabilities.grants.includes('applications.launch'));
  assert(capabilities.grants.includes('appearance.read'));
  assert(capabilities.grants.includes('appearance.write'));
  assert(capabilities.methods.includes('apps.list'));
  assert(capabilities.methods.includes('apps.launch'));
  await assert.rejects(
    shell.call('apps.list',{ path:'C:\\untrusted' }),
    error=>error.code==='INVALID_APPLICATION_REQUEST'
  );
  await assert.rejects(
    shell.call('apps.launch',{ id:'boss',args:['--unsafe'],env:{PATH:'untrusted'} }),
    error=>error.code==='INVALID_APPLICATION_REQUEST'
  );
  await assert.rejects(
    shell.call('apps.launch',{ id:'../boss' }),
    error=>error.code==='INVALID_APPLICATION_ID'
  );
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
  assert.equal((await shell.call('appearance.current')).platform,'windows');
  const lightAppearance=await shell.call('appearance.apply',{
    scheme:'light',captionColor:'rgb(255, 255, 255)',textColor:'rgb(23, 34, 56)'
  });
  assert.equal(lightAppearance.scheme,'light');
  assert.equal(lightAppearance.effectiveScheme,'light');
  const darkAppearance=await shell.call('appearance.apply',{
    scheme:'dark',captionColor:'rgb(21, 28, 45)',textColor:'rgb(237, 241, 250)'
  });
  assert.equal(darkAppearance.effectiveScheme,'dark');
  await assert.rejects(
    shell.call('appearance.apply',{scheme:'dark',captionColor:'white'}),
    error=>/RGB color/.test(error.message)
  );
  const logout=await shell.call('session.logout');
  assert.equal(logout.simulated,true);
  const locked=await shell.call('system.lock');
  assert.equal(locked.simulated,true);
  for(const method of ['installation.ensure','requirements.ensure','users.add','users.activate','users.resetPassword','users.applyPassword','users.verifyShell']){
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
  assert(!capabilities.methods.includes('apps.list'));
  assert(!capabilities.methods.includes('apps.launch'));
  await assert.rejects(
    provisioner.call('storage.set',{ key:'nope',value:true }),
    error=>error.code==='METHOD_NOT_ALLOWED'&&error.method==='storage.set'
  );
  for(const method of ['apps.list','apps.launch']){
    await assert.rejects(
      provisioner.call(method,method==='apps.launch'?{id:'boss'}:{}),
      error=>error.code==='METHOD_NOT_ALLOWED'&&error.method===method
    );
  }
  const plan=await provisioner.call('provisioning.plan',{ usernames:['arcane-policy-test'] });
  assert.equal(plan.users[0].username,'arcane-policy-test');
  assert.equal(plan.simulation,true);
}finally{
  provisioner.close();
}

const genericApp=createClient('boss',{ extraArgs:['--simulate-capabilities=applications.read,applications.launch'] });
try{
  const capabilities=await genericApp.call('capabilities.list');
  assert(capabilities.grants.includes('applications.read'));
  assert(!capabilities.methods.includes('apps.list'),'generic apps must remain denied even if a capability grant is injected');
  for(const method of ['apps.list','apps.launch']){
    await assert.rejects(
      genericApp.call(method,method==='apps.launch'?{id:'precrisis'}:{}),
      error=>error.code==='METHOD_NOT_ALLOWED'&&error.method===method
    );
  }
  await assert.rejects(
    genericApp.call('appearance.apply',{scheme:'light'}),
    error=>error.code==='METHOD_NOT_ALLOWED'&&error.method==='appearance.apply'
  );
}finally{
  genericApp.close();
}

const ollamaApp=createClient('boss',{ extraArgs:['--simulate-capabilities=ai.inference,ai.models.read,ai.models.manage'] });
try{
  const capabilities=await ollamaApp.call('capabilities.list');
  for(const method of ['ollama.version','ollama.models','ollama.running','ollama.show','ollama.generate','ollama.chat','ollama.embed','ollama.pull','ollama.push','ollama.create','ollama.copy','ollama.delete']){
    assert(capabilities.methods.includes(method),`${method} must be exposed by its declared capability`);
  }
  assert.equal((await ollamaApp.call('ollama.version')).version,'simulated');
  assert.deepEqual((await ollamaApp.call('ollama.models')).models,[]);
  const chat=await ollamaApp.call('ollama.chat',{ model:'gemma4',messages:[{ role:'user',content:'Hello' }] });
  assert.equal(chat.message.content,'Simulated Arcane Ollama response.');
  const embedding=await ollamaApp.call('ollama.embed',{ model:'embeddinggemma',input:'Hello' });
  assert.deepEqual(embedding.embeddings,[[0]]);
  const streamId='ollama-policy-stream';
  await ollamaApp.call('ollama.pull',{ model:'gemma4',stream:true,streamId });
  assert(ollamaApp.events.some(event=>event.event==='ollama.chunk'&&event.data.streamId===streamId));
  await assert.rejects(
    ollamaApp.call('ollama.chat',{ model:'gemma4',messages:[],host:'http://remote.invalid' }),
    error=>error.code==='INVALID_OLLAMA_REQUEST',
    'Ollama requests must not redirect Arcane Core to an arbitrary host'
  );
}finally{
  ollamaApp.close();
}

const inferenceOnlyApp=createClient('boss',{ extraArgs:['--simulate-capabilities=ai.inference'] });
try{
  await assert.rejects(
    inferenceOnlyApp.call('ollama.pull',{ model:'gemma4' }),
    error=>error.code==='METHOD_NOT_ALLOWED'&&error.requiredCapability==='ai.models.manage'
  );
}finally{
  inferenceOnlyApp.close();
}

const linuxShell=createClient('shell',{ platform:'linux' });
try{
  await assert.rejects(
    linuxShell.call('apps.list',{}),
    error=>error.code==='APPLICATIONS_UNAVAILABLE',
    'the Linux application adapter must fail closed'
  );
}finally{
  linuxShell.close();
}

console.log('Arcane per-application capability policy smoke test passed.');
