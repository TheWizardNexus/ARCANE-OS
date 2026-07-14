import crypto from 'node:crypto';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scheme=String(process.argv[2]||'').toLowerCase();
if(!['system','light','dark'].includes(scheme)){
  console.error('Usage: node tools/invoke-appearance-api.mjs system|light|dark');
  process.exit(2);
}

const palettes={
  light:{captionColor:'rgb(255, 255, 255)',textColor:'rgb(23, 34, 56)'},
  dark:{captionColor:'rgb(21, 28, 45)',textColor:'rgb(237, 241, 250)'},
  system:{captionColor:null,textColor:null},
};
const child=spawn(process.execPath,[path.join(root,'runtime/arcane-core.cjs'),'--app=shell',`--bundle-root=${root}`],{stdio:['pipe','pipe','pipe']});
let buffer=Buffer.alloc(0);
let expected=null;
let stderr='';
const pending=new Map();
child.stderr.on('data',(chunk)=>{stderr+=chunk.toString();});
child.stdout.on('data',(chunk)=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(true){
    if(expected===null){
      const marker=buffer.indexOf('\r\n\r\n');
      if(marker<0)return;
      const match=buffer.subarray(0,marker).toString('ascii').match(/Content-Length:\s*(\d+)/i);
      if(!match)throw new Error('Arcane returned an invalid frame.');
      expected=Number(match[1]);
      buffer=buffer.subarray(marker+4);
    }
    if(buffer.length<expected)return;
    const message=JSON.parse(buffer.subarray(0,expected).toString('utf8'));
    buffer=buffer.subarray(expected);
    expected=null;
    if(message.type!=='response')continue;
    const request=pending.get(message.id);
    if(!request)continue;
    pending.delete(message.id);
    message.ok?request.resolve(message.result):request.reject(Object.assign(new Error(message.error.message),message.error));
  }
});

function call(method,parameters={}){
  const id=crypto.randomUUID();
  const body=Buffer.from(JSON.stringify({protocol:'arcane/1',type:'request',id,method,parameters}));
  child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]));
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`Arcane API timed out. ${stderr}`)),15000);
    pending.set(id,{resolve(value){clearTimeout(timer);resolve(value);},reject(error){clearTimeout(timer);reject(error);}});
  });
}

try{
  const before=await call('appearance.current');
  const applied=await call('appearance.apply',{scheme,...palettes[scheme]});
  const verified=await call('appearance.current');
  if(verified.scheme!==scheme)throw new Error(`Arcane reported ${verified.scheme} after applying ${scheme}.`);
  console.log(JSON.stringify({before,applied,verified},null,2));
}finally{
  child.stdin.end();
  child.kill();
}
