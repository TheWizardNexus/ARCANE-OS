import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const simulatedPlatform=process.platform==='win32'?'win32':'linux';
const child=spawn(process.execPath,[path.join(root,'runtime/arcane-core.cjs'),'--app=shell','--simulate',`--simulate-platform=${simulatedPlatform}`,`--bundle-root=${root}`],{ stdio:['pipe','pipe','pipe'] });
let buffer=Buffer.alloc(0);
let expected=null;
const pending=new Map();
const events=[];
child.stderr.on('data',(chunk)=>process.stderr.write(chunk));
child.stdout.on('data',(chunk)=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(true){
    if(expected===null){
      const marker=buffer.indexOf('\r\n\r\n');
      if(marker<0)return;
      const match=buffer.subarray(0,marker).toString('ascii').match(/Content-Length:\s*(\d+)/i);
      if(!match)throw new Error('Missing Content-Length');
      expected=Number(match[1]);buffer=buffer.subarray(marker+4);
    }
    if(buffer.length<expected)return;
    const message=JSON.parse(buffer.subarray(0,expected).toString('utf8'));
    buffer=buffer.subarray(expected);expected=null;
    if(message.type==='event')events.push(message);
    else if(message.type==='response'){
      const callback=pending.get(message.id);
      if(callback){pending.delete(message.id);message.ok?callback.resolve(message.result):callback.reject(Object.assign(new Error(message.error.message),message.error));}
    }
  }
});
function call(method,parameters={}){
  const id=crypto.randomUUID();
  const body=Buffer.from(JSON.stringify({ protocol:'arcane/1',type:'request',id,method,parameters }));
  child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]));
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout: ${method}`));},20000);
    pending.set(id,{resolve(value){clearTimeout(timer);resolve(value);},reject(error){clearTimeout(timer);reject(error);}});
  });
}

try{
  const automatic=await call('ollama.selection.get');
  if(automatic.preference!=='auto'||automatic.recommendedVariant!=='20b'||automatic.effectiveVariant!=='20b')throw new Error('Automatic model selection did not choose 20B for the simulated 16 GB GPU.');
  if(automatic.minimum120bGpuBytes!==80_000_000_000)throw new Error('Automatic 120B GPU threshold drifted.');
  const selected=await call('ollama.selection.set',{ preference:'120b' });
  if(selected.preference!=='120b'||selected.variant!=='120b'||selected.model!=='arcane:120b'||selected.alias!=='arcane:latest')throw new Error('The explicit 120B preference was not created and selected.');
  const persisted=await call('ollama.selection.get');
  if(persisted.preference!=='120b'||persisted.effectiveVariant!=='120b'||persisted.activeVariant!=='120b')throw new Error('The explicit 120B preference did not persist in the user settings state.');
  if(!events.some((event)=>event.event==='operation.progress'&&/Downloading gpt-oss:120b/.test(String(event.data&&event.data.message||''))))throw new Error('The 120B selection did not report download progress.');
  let invalidRejected=false;
  try{await call('ollama.selection.set',{ preference:'largest' });}catch(error){invalidRejected=error.code==='INVALID_ARCANE_MODEL_PREFERENCE';}
  if(!invalidRejected)throw new Error('An invalid Arcane model preference was accepted.');
  console.log('Arcane GPU-aware model selection smoke test passed.');
}finally{child.stdin.end();child.kill();}
