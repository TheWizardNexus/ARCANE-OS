import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const simulatedPlatform = process.platform === 'win32' ? 'win32' : 'linux';
const child = spawn(process.execPath, [path.join(root,'runtime/arcane-core.cjs'),'--app=provisioner','--simulate','--simulate-standard','--simulate-broker-first-client',`--simulate-platform=${simulatedPlatform}`,`--bundle-root=${root}`], {stdio:['pipe','pipe','pipe']});
let buffer=Buffer.alloc(0), expected=null; const pending=new Map(); const events=[]; let stderr='';
child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
child.stdout.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){if(expected===null){const marker=buffer.indexOf('\r\n\r\n');if(marker<0)return;const match=buffer.subarray(0,marker).toString('ascii').match(/Content-Length:\s*(\d+)/i);if(!match)throw new Error('Invalid frame');expected=Number(match[1]);buffer=buffer.subarray(marker+4);}if(buffer.length<expected)return;const message=JSON.parse(buffer.subarray(0,expected).toString('utf8'));buffer=buffer.subarray(expected);expected=null;if(message.type==='event')events.push(message);else{const entry=pending.get(message.id);if(entry){pending.delete(message.id);message.ok?entry.resolve(message.result):entry.reject(Object.assign(new Error(message.error.message),message.error));}}}});
function send(message){const body=Buffer.from(JSON.stringify(message));child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]));}
function call(method,parameters={}){const id=crypto.randomUUID();send({protocol:'arcane/1',type:'request',id,method,parameters});return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout: ${method}\n${stderr}`));},30000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});});}
try{
  const permissions=await call('permissions.status');
  if(permissions.elevated)throw new Error('Standard simulation incorrectly reported elevated.');
  const result=await call('installation.ensure');
  if(!result.installation.present)throw new Error('Privileged installation did not finish.');
  const rejected=events.find(item=>item.event==='operation.log'&&String(item.data.message||'').includes('Rejected an unauthorized privilege broker client'));
  if(!rejected)throw new Error('The disclosed-token first client was not rejected.');
  if(rejected.data.details?.reason!=='worker-identity-mismatch')throw new Error(`Unexpected attacker rejection reason: ${rejected.data.details?.reason}`);
  if(!rejected.data.details?.claimedPid||!rejected.data.details?.expectedPid||rejected.data.details.claimedPid===rejected.data.details.expectedPid)throw new Error('The adversarial client did not exercise distinct OS process identities.');
  if(!events.some(item=>item.event==='operation.progress'&&String(item.data.message||'').includes('Administrator authorization approved')))throw new Error('Authorization progress event missing.');
  console.log('Arcane privileged worker broker adversarial first-client smoke test passed.');
}finally{child.stdin.end();child.kill();}
