import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourcePath=path.join(root,'runtime','arcane-core.cjs');
const temporaryRoot=await fs.mkdtemp(path.join(os.tmpdir(),'arcane-applications-api-'));
const runtimePath=path.join(temporaryRoot,'arcane-core.cjs');
const marker='const PATHS = native.paths;';
const injectedAdapter=`
let applicationsListCallCount=0;
const publisherEvidence={securityMode:'publisher-verified',publisherTrustSource:'uac-approved-tofu',revocationStatus:'online-good'};
native.hostReleaseSecurityEvidence=()=> publisherEvidence;
native.releaseSecurityMode=()=> 'publisher-verified';
native.listInstalledApplications=async function(){
  if(arguments.length!==0)throw new Error('list contract received arguments');
  applicationsListCallCount+=1;
  if(applicationsListCallCount===2)return {verified:true,...publisherEvidence,applications:[{id:'boss',displayName:'BOSS',description:'Unsafe icon',iconUrl:'https://attacker.invalid/icon.png',version:'2.0.0',order:10}]};
  if(applicationsListCallCount===3)return {verified:false,...publisherEvidence,applications:[]};
  if(applicationsListCallCount===4)return {verified:true,...publisherEvidence,applications:[
    {id:'boss',displayName:'BOSS',description:'Duplicate one',iconUrl:'/apps/boss/app/boss/icon.png',version:'2.0.0',order:10},
    {id:'boss',displayName:'BOSS again',description:'Duplicate two',iconUrl:'/apps/boss/app/boss/icon.png',version:'2.0.0',order:20},
  ]};
  if(applicationsListCallCount===5)return {verified:true,...publisherEvidence,applications:[{id:'boss',displayName:'BOSS',description:'Unexpected field',iconUrl:'/apps/boss/app/boss/icon.png',version:'2.0.0',order:10,path:'C:\\\\secret.exe'}]};
  if(applicationsListCallCount===6)throw new Error('C:\\\\private\\catalog.json could not be read');
  return {
    verified:true,
    ...publisherEvidence,
    applications:[
      {id:'precrisis',displayName:'PreCrisis AI',description:'Clinical operations workspace',iconUrl:'/apps/precrisis/app/precrisis/icon.png',version:'1.2.3',order:20},
      {id:'boss',displayName:'BOSS',description:'Business operations workspace',iconUrl:'/apps/boss/app/boss/icon.png',version:'2.0.0',order:10},
    ],
  };
};
native.launchInstalledApplication=async function(id){
  if(arguments.length!==1)throw new Error('launch contract must receive one argument');
  if(id==='throwing')throw new Error('C:\\\\private\\ArcaneApp-throwing.exe failed');
  return {accepted:id==='boss',id,path:'C:\\\\secret.exe',pid:777,args:['--unsafe'],env:{SECRET:'no'}};
};
`;
const source=await fs.readFile(sourcePath,'utf8');
assert.equal(source.split(marker).length,2,'test adapter insertion marker must remain unique');
const hostOverrideSource=source.replace('const hostPlatform = process.platform;',"const hostPlatform = 'win32';");
assert.notEqual(hostOverrideSource,source,'test runtime must explicitly provide its Windows host seam');
const nativeDeclaration=/const native\s*=\s*createCoreNativeAdapter\(platform,\s*nativeContext\);/;
assert.match(hostOverrideSource,nativeDeclaration,'test runtime must contain the native adapter declaration');
const mutableSource=hostOverrideSource.replace(nativeDeclaration,'let native = createCoreNativeAdapter(platform, nativeContext);');
assert.notEqual(mutableSource,hostOverrideSource,'test runtime must expose the adapter seam');
await fs.writeFile(runtimePath,mutableSource.replace(marker,`native=Object.assign({},native);\n${injectedAdapter}\n${marker}`),'utf8');

function createClient(){
  const child=spawn(process.execPath,[runtimePath,'--app=shell','--simulate','--simulate-platform=win32',`--bundle-root=${root}`],{stdio:['pipe','pipe','pipe']});
  let buffer=Buffer.alloc(0);
  let expected=null;
  let stderr='';
  const pending=new Map();
  child.stderr.on('data',(chunk)=>{stderr+=chunk.toString();});
  child.stdout.on('data',(chunk)=>{
    buffer=Buffer.concat([buffer,chunk]);
    while(true){
      if(expected===null){
        const markerIndex=buffer.indexOf('\r\n\r\n');
        if(markerIndex<0)return;
        const match=buffer.subarray(0,markerIndex).toString('ascii').match(/Content-Length:\s*(\d+)/i);
        if(!match)throw new Error('Invalid Arcane frame');
        expected=Number(match[1]);
        buffer=buffer.subarray(markerIndex+4);
      }
      if(buffer.length<expected)return;
      const message=JSON.parse(buffer.subarray(0,expected).toString('utf8'));
      buffer=buffer.subarray(expected);
      expected=null;
      if(message.type!=='response')continue;
      const entry=pending.get(message.id);
      if(!entry)continue;
      pending.delete(message.id);
      message.ok?entry.resolve(message.result):entry.reject(Object.assign(new Error(message.error.message),message.error));
    }
  });
  return {
    call(method,parameters={}){
      const id=crypto.randomUUID();
      const body=Buffer.from(JSON.stringify({protocol:'arcane/1',type:'request',id,method,parameters}));
      child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]));
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout: ${method}\n${stderr}`));},15000);
        pending.set(id,{resolve(value){clearTimeout(timer);resolve(value);},reject(error){clearTimeout(timer);reject(error);}});
      });
    },
    close(){child.stdin.end();child.kill();},
  };
}

const client=createClient();
try{
  const currentApp=await client.call('app.current',{});
  assert.equal(currentApp.securityMode,'publisher-verified','release trust must reflect the native publisher proof');
  const catalog=await client.call('apps.list',{});
  assert.equal(catalog.verified,true);
  assert.equal(catalog.securityMode,'publisher-verified');
  assert.deepEqual(catalog.applications.map((application)=>application.id),['boss','precrisis'],'records must use deterministic catalog order');
  for(const application of catalog.applications){
    assert.deepEqual(Object.keys(application).sort(),['description','displayName','iconUrl','id','order','verified','version']);
    for(const forbidden of ['path','pid','args','env','executable','command'])assert.equal(forbidden in application,false);
  }
  await assert.rejects(client.call('apps.list',{}),(error)=>error.code==='APPLICATION_CATALOG_INVALID','remote icon metadata must fail closed');
  await assert.rejects(client.call('apps.list',{}),(error)=>error.code==='APPLICATION_CATALOG_UNVERIFIED','an unverified native catalog must fail closed');
  await assert.rejects(client.call('apps.list',{}),(error)=>error.code==='APPLICATION_CATALOG_INVALID','duplicate IDs must fail closed');
  await assert.rejects(client.call('apps.list',{}),(error)=>error.code==='APPLICATION_CATALOG_INVALID','unexpected native record fields must fail closed');
  await assert.rejects(
    client.call('apps.list',{}),
    (error)=>error.code==='APPLICATION_CATALOG_UNAVAILABLE'&&!JSON.stringify(error).includes('private'),
    'native paths must not escape catalog adapter errors'
  );

  const launched=await client.call('apps.launch',{id:'boss'});
  assert.deepEqual(launched,{id:'boss',accepted:true});
  for(const forbidden of ['path','pid','args','env','executable','command'])assert.equal(forbidden in launched,false);

  await assert.rejects(client.call('apps.launch',{id:'boss',path:'C:\\untrusted.exe'}),(error)=>error.code==='METHOD_CONTRACT_INPUT_INVALID');
  await assert.rejects(client.call('apps.list',null),(error)=>error.code==='METHOD_CONTRACT_INPUT_INVALID');
  await assert.rejects(client.call('apps.launch',{id:'BOSS'}),(error)=>error.code==='METHOD_CONTRACT_INPUT_INVALID');
  await assert.rejects(client.call('apps.launch',{id:'boss '}),(error)=>error.code==='METHOD_CONTRACT_INPUT_INVALID');
  await assert.rejects(client.call('apps.launch',{id:'shell'}),(error)=>error.code==='METHOD_CONTRACT_INPUT_INVALID');
  await assert.rejects(client.call('apps.launch',{id:'con'}),(error)=>error.code==='METHOD_CONTRACT_INPUT_INVALID');
  await assert.rejects(client.call('apps.launch',{id:'precrisis'}),(error)=>error.code==='APPLICATION_LAUNCH_REJECTED');
  await assert.rejects(
    client.call('apps.launch',{id:'throwing'}),
    (error)=>error.code==='APPLICATION_LAUNCH_FAILED'&&!JSON.stringify(error).includes('private'),
    'native paths must not escape launch adapter errors'
  );
}finally{
  client.close();
  await fs.rm(temporaryRoot,{recursive:true,force:true});
}

console.log('Arcane installed-app API contract smoke test passed.');
