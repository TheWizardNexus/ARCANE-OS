import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const platform=process.platform==='win32'?'win32':'linux';
const child=spawn(process.execPath,[path.join(root,'runtime/arcane-core.cjs'),'--app=terminal','--simulate',`--simulate-platform=${platform}`,'--simulate-capabilities=terminal.execute',`--bundle-root=${root}`],{cwd:root,stdio:['pipe','pipe','pipe']});
let buffer=Buffer.alloc(0),expected=null,stderr='';
const pending=new Map(),events=[];

child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
child.stdout.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(true){
    if(expected===null){const marker=buffer.indexOf('\r\n\r\n');if(marker<0)return;const match=buffer.subarray(0,marker).toString('ascii').match(/Content-Length:\s*(\d+)/i);if(!match)throw new Error('Invalid terminal smoke frame.');expected=Number(match[1]);buffer=buffer.subarray(marker+4);}
    if(buffer.length<expected)return;
    const message=JSON.parse(buffer.subarray(0,expected).toString('utf8'));buffer=buffer.subarray(expected);expected=null;
    if(message.type==='event')events.push(message);
    if(message.type==='response'){const entry=pending.get(message.id);if(entry){pending.delete(message.id);message.ok?entry.resolve(message.result):entry.reject(Object.assign(new Error(message.error.message),message.error));}}
  }
});

function call(method,parameters={}){
  const id=crypto.randomUUID();const body=Buffer.from(JSON.stringify({protocol:'arcane/1',type:'request',id,method,parameters}));child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]));
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout: ${method}\n${stderr}`));},10000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});});
}

async function waitForOutput(sessionId,text){
  const timeout=Date.now()+8000;
  while(Date.now()<timeout){if(events.some(event=>event.event==='terminal.output'&&event.data.sessionId===sessionId&&event.data.data.includes(text)))return;await new Promise(resolve=>setTimeout(resolve,25));}
  throw new Error(`Terminal output did not contain ${text}.\n${stderr}`);
}

try{
  const capabilities=await call('capabilities.list');
  for(const method of ['terminal.start','terminal.list','terminal.write','terminal.resize','terminal.signal','terminal.close'])assert(capabilities.methods.includes(method));
  await assert.rejects(call('terminal.start',{shell:'auto',cwd:'',columns:80,rows:24,executable:'untrusted'}),error=>error.code==='METHOD_CONTRACT_INPUT_INVALID');
  const session=await call('terminal.start',{shell:'auto',cwd:root,columns:80,rows:24});
  assert.match(session.id,/^term-/);assert.equal(session.cwd,root);
  const marker=`arcane-terminal-smoke-${Date.now()}`;
  await call('terminal.write',{sessionId:session.id,data:platform==='win32'?`Write-Output '${marker}'\r\n`:`printf '${marker}\\n'\n`});
  await waitForOutput(session.id,marker);
  assert.equal((await call('terminal.resize',{sessionId:session.id,columns:132,rows:41})).columns,132);
  assert((await call('terminal.list',{})).sessions.some(item=>item.id===session.id));
  assert.equal((await call('terminal.close',{sessionId:session.id})).accepted,true);
  console.log('Arcane native terminal API smoke test passed.');
}finally{child.stdin.end();setTimeout(()=>child.kill(),500).unref();}
