import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const shell=await fs.readFile(path.join(root,'src','frontend','shell','index.html'),'utf8');
const scriptMatches=[...shell.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].filter((match)=>!(/\bsrc\s*=/i.test(match[0])));
assert.equal(scriptMatches.length,1);
new vm.Script(scriptMatches[0][1],{filename:'shell.inline.js'});

assert.match(shell,/id="securityWarning"[^>]*>Arcane has not yet verified/,'the trust warning must be visible before runtime verification');
assert.match(shell,/Unsigned local test mode is active/);
assert.match(shell,/warning\.hidden = mode === 'publisher-verified'/,'only affirmative publisher verification may hide the warning');
assert.match(shell,/setSecurityMode\(application\.securityMode\)/,'the unsigned warning must be set before catalog loading can fail');
assert.match(shell,/Arcane\.applications\.list\(\)/);
assert.match(shell,/Arcane\.applications\.launch\(application\.id\)/,'the shell must pass the canonical catalog ID only');
assert.match(shell,/id="lock"/,'the default shell must expose a lock control');
assert.match(shell,/Arcane\.system\.lock\(\)/,'the lock control must use the capability-gated Arcane API');
assert.match(shell,/document\.createElement\('button'\)/);
assert.match(shell,/button\.setAttribute\('aria-label'/);
assert.match(shell,/textContent = application\.displayName/);
assert.match(shell,/textContent = application\.description/);
assert.match(shell,/url\.origin === window\.location\.origin/);
assert.match(shell,/kind === 'loading'/);
assert.match(shell,/kind === 'empty'/);
assert.match(shell,/kind === 'repair'/);
assert.match(shell,/launchingApplicationId/);

const renderStart=shell.indexOf('function renderApplications()');
const renderEnd=shell.indexOf('function updateApplicationBusyState()',renderStart);
assert(renderStart>0&&renderEnd>renderStart);
assert(!shell.slice(renderStart,renderEnd).includes('innerHTML'),'catalog metadata must never be rendered through innerHTML');
const launchStart=shell.indexOf('async function launchApplication',renderEnd);
const launchEnd=shell.indexOf('async function loadApplications',launchStart);
assert(launchStart>renderEnd&&launchEnd>launchStart);
const launchSource=shell.slice(launchStart,launchEnd);
assert(!launchSource.includes('renderApplications()'),'busy transitions must preserve the focused application button');
assert.match(launchSource,/button\.focus\(\)/,'focus must return to the activated application after launch completion or failure');

const builtShell=await fs.readFile(path.join(root,'dist','app','shell','index.html'),'utf8');
const builtInline=[...builtShell.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].filter((match)=>!(/\bsrc\s*=/i.test(match[0])));
assert.equal(builtInline.length,1,'the generated shell must retain its inline controller');
const scriptHash=`'sha256-${crypto.createHash('sha256').update(builtInline[0][1],'utf8').digest('base64')}'`;
assert(builtShell.includes(scriptHash),'the generated CSP must authorize the exact shell controller hash');
assert(!builtShell.includes('__ARCANE_SCRIPT_HASHES__'));

class FakeClassList {
  constructor(){this.values=new Set();}
  add(...values){for(const value of values)this.values.add(value);}
  remove(...values){for(const value of values)this.values.delete(value);}
  toggle(value,force){
    const enabled=force===undefined?!this.values.has(value):Boolean(force);
    enabled?this.values.add(value):this.values.delete(value);
    return enabled;
  }
  contains(value){return this.values.has(value);}
}

class FakeElement {
  constructor(tagName,document,id=''){
    this.tagName=String(tagName).toUpperCase();
    this.ownerDocument=document;
    this.id=id;
    this.children=[];
    this.listeners=new Map();
    this.attributes=new Map();
    this.dataset={};
    this.classList=new FakeClassList();
    this.className='';
    this.textContent='';
    this.hidden=false;
    this.disabled=false;
  }
  appendChild(child){this.children.push(child);child.parentNode=this;return child;}
  replaceChildren(...children){this.children=[];for(const child of children)this.appendChild(child);}
  addEventListener(name,listener){this.listeners.set(name,listener);}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  getAttribute(name){return this.attributes.has(name)?this.attributes.get(name):null;}
  querySelector(selector){
    if(selector.startsWith('.'))return this.walk().find((node)=>String(node.className).split(/\s+/).includes(selector.slice(1)))||null;
    return null;
  }
  querySelectorAll(selector){
    if(selector.startsWith('.'))return this.walk().filter((node)=>String(node.className).split(/\s+/).includes(selector.slice(1)));
    return [];
  }
  walk(){return this.children.flatMap((child)=>[child,...child.walk()]);}
  focus(){this.ownerDocument.activeElement=this;}
  showModal(){this.open=true;}
  close(){this.open=false;}
  select(){}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter((child)=>child!==this);}
}

function shellHarness(){
  const ids=['toast','errorTitle','errorMessage','errorResolution','errorBody','errorPanel','status','dismissError','copyError','clock','securityWarning','catalogState','catalogBadge','appGrid','version','identity','userValue','osValue','hostValue','lock','logout','logoutDialog','cancelLogout','confirmLogout','logoutText'];
  const document={activeElement:null,elements:new Map()};
  document.createElement=(tagName)=>new FakeElement(tagName,document);
  document.querySelector=(selector)=>selector.startsWith('#')?document.elements.get(selector.slice(1))||null:null;
  document.execCommand=()=>true;
  document.body=new FakeElement('body',document,'body');
  for(const id of ids)document.elements.set(id,new FakeElement(id==='logoutDialog'?'dialog':'div',document,id));

  let resolveLaunch;
  const launchCalls=[];
  const launchPromise=new Promise((resolve)=>{resolveLaunch=resolve;});
  const lockCalls=[];
  const Arcane={
    events:{on(){}},
    system:{ping:async()=>({ok:true}),lock:async()=>{lockCalls.push(true);return {simulated:true};}},
    version:{current:async()=>({version:'0.8.2'})},
    user:{current:async()=>({username:'arcane-test',displayName:'Arcane Test'})},
    platform:{status:async()=>({platform:'win32',displayName:'Windows'})},
    app:{current:async()=>({securityMode:'unsigned-local-test'})},
    applications:{
      list:async()=>({verified:true,securityMode:'unsigned-local-test',applications:[{id:'boss',displayName:'BOSS',description:'Business workspace',iconUrl:'/apps/boss/icon.png',version:'0.8.2',order:10,verified:true}]}),
      launch(id){launchCalls.push(id);return launchPromise;},
    },
    diagnostics:{get:async()=>null},
    session:{logout:async()=>({simulated:true})},
  };
  const location={origin:'https://arcane.local',href:'https://arcane.local/shell/index.html',reload(){}};
  const window={document,Arcane,location,addEventListener(){}};
  const context=vm.createContext({window,document,Arcane,location,navigator:{},URL,console,setTimeout,clearTimeout,setInterval(){return 0;},Date,Error,Promise,JSON});
  vm.runInContext(scriptMatches[0][1],context,{filename:'shell.behavior.js'});
  return {document,launchCalls,resolveLaunch,lockCalls};
}

async function flushTasks(){for(let index=0;index<8;index+=1)await new Promise((resolve)=>setImmediate(resolve));}
const behavior=shellHarness();
await flushTasks();
const grid=behavior.document.elements.get('appGrid');
assert.equal(grid.children.length,1,'a verified app must render as one launch button');
const appButton=grid.children[0];
assert.equal(appButton.getAttribute('aria-label'),'Open BOSS');
assert.equal(behavior.document.elements.get('securityWarning').hidden,false,'unsigned local test warning must remain visible');
behavior.document.elements.get('lock').listeners.get('click')();
await flushTasks();
assert.equal(behavior.lockCalls.length,1,'the Lock control must dispatch exactly one capability-gated request');
appButton.focus();
appButton.listeners.get('click')();
assert.deepEqual(behavior.launchCalls,['boss'],'the behavior layer must send the ID only');
assert.equal(grid.children[0],appButton,'entering busy state must preserve the focused button node');
assert.equal(appButton.getAttribute('aria-disabled'),'true');
assert.equal(behavior.document.activeElement,appButton);
behavior.resolveLaunch({id:'boss',accepted:true});
await flushTasks();
assert.equal(grid.children[0],appButton,'leaving busy state must preserve the focused button node');
assert.equal(appButton.getAttribute('aria-disabled'),'false');
assert.equal(behavior.document.activeElement,appButton,'focus must return to the activated button');

console.log('Arcane shell catalog UI source smoke test passed.');
