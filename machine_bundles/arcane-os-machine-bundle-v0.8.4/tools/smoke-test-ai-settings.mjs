import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),platform=process.platform==='win32'?'win32':'linux';
const child=spawn(process.execPath,[path.join(root,'runtime/arcane-core.cjs'),'--app=settings','--simulate','--simulate-capabilities=ai.inference,ai.models.manage,ai.models.read,ai.settings.manage',`--simulate-platform=${platform}`,`--bundle-root=${root}`],{stdio:['pipe','pipe','pipe']});
let buffer=Buffer.alloc(0),expected=null;const pending=new Map(),events=[];child.stderr.on('data',chunk=>process.stderr.write(chunk));
child.stdout.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){if(expected===null){const marker=buffer.indexOf('\r\n\r\n');if(marker<0)return;const match=buffer.subarray(0,marker).toString('ascii').match(/Content-Length:\s*(\d+)/i);if(!match)throw new Error('Missing Content-Length');expected=Number(match[1]);buffer=buffer.subarray(marker+4);}if(buffer.length<expected)return;const message=JSON.parse(buffer.subarray(0,expected).toString('utf8'));buffer=buffer.subarray(expected);expected=null;if(message.type==='event')events.push(message);else if(message.type==='response'){const callback=pending.get(message.id);if(callback){pending.delete(message.id);message.ok?callback.resolve(message.result):callback.reject(Object.assign(new Error(message.error.message),message.error));}}}});
function call(method,parameters={}){const id=crypto.randomUUID(),body=Buffer.from(JSON.stringify({protocol:'arcane/1',type:'request',id,method,parameters}));child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]));return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout: ${method}`));},20000);pending.set(id,{resolve(value){clearTimeout(timer);resolve(value);},reject(error){clearTimeout(timer);reject(error);}});});}
try{
  const initial=await call('ai.provider.settings.get');if(initial.provider!=='ollama'||initial.openAIConfigured!==false||Object.hasOwn(initial,'token'))throw new Error('Provider settings exposed an invalid initial state or credential.');
  const credential='sk-arcane-simulation-token-1234567890';const saved=await call('ai.provider.settings.set',{provider:'ollama',openAIModel:'gpt-account-model',token:credential});if(!saved.openAIConfigured||Object.values(saved).includes(credential))throw new Error('Protected OpenAI credential status was not saved safely.');
  const cloud=await call('ai.provider.settings.set',{provider:'openai',openAIModel:'gpt-account-model'});if(cloud.provider!=='openai'||cloud.openAIModel!=='gpt-account-model')throw new Error('OpenAI was not selected as the Arcane brain provider.');
  await call('ai.provider.settings.set',{provider:'ollama',openAIModel:'gpt-account-model'});
  const brain=await call('ollama.brain.create',{name:'Research Brain',baseModel:'qwen3:20b',contextLength:32768,makeDefault:true});if(brain.model!=='arcane-research-brain:latest'||brain.defaultModel!==true)throw new Error('The custom Arcane brain was not created and selected.');
  const settings=await call('ollama.settings.get');if(settings.defaultModel!==brain.model)throw new Error('Custom brain settings did not persist.');
  if(!events.some(event=>event.event==='operation.progress'&&/Downloading qwen3:20b/.test(String(event.data?.message||''))))throw new Error('Custom brain download progress was not emitted.');
  const service=await call('ollama.service.settings.get');if(typeof service.supported!=='boolean')throw new Error('Advanced service settings were unavailable.');
  console.log('Arcane AI provider and custom brain settings smoke test passed.');
}finally{child.stdin.end();child.kill();}
