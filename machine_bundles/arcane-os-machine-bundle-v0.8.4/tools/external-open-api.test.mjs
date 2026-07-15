import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read=(relative)=>readFile(path.join(root,...relative.split('/')),'utf8');

test('frontend exposes external.open as one bounded native request',async()=>{
  const source=await read('src/frontend/shared/arcane-api.js');
  let request;
  const window={__ARCANE_DEV_HTTP__:true,crypto:{randomUUID:()=> 'external-open-request'}};
  const fetch=async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({protocol:'arcane/1',type:'response',id:request.id,ok:true,result:{opened:true,uri:'mailto:test@example.com'}})}};
  vm.runInNewContext(source,{window,fetch,console,setTimeout,clearTimeout},{filename:'arcane-api.js'});
  const result=await window.Arcane.external.open('mailto:test@example.com');
  assert.equal(request.method,'external.open');
  assert.deepEqual(request.parameters,{uri:'mailto:test@example.com'});
  assert.deepEqual(result,{opened:true,uri:'mailto:test@example.com'});
});

test('core and native adapters enforce the mailto-only external-open contract',async()=>{
  const [core,windows,linux,packager,host,targetBuild]=await Promise.all([read('src/core/arcane-core.template.cjs'),read('src/native/windows.cjs'),read('src/native/linux.cjs'),read('tools/app-packager-lib.mjs'),read('src/hosts/windows/ArcaneHost.cs'),read('tools/build-windows-target-app.ps1')]);
  assert.match(core,/'external\.open': Object\.freeze\(\{ capability:'external\.open' \}\)/);
  assert.match(core,/case 'external\.open': return openExternalUri\(parameters\)/);
  assert.match(core,/uri\.protocol!=='mailto:'/);
  assert.match(core,/EXTERNAL_SCHEME_NOT_ALLOWED/);
  assert.match(windows,/explorer\.exe/);
  assert.doesNotMatch(windows.match(/function openExternalUri[\s\S]*?\n  \}/)?.[0]||'',/cmdExe|powershell|shell:\s*true/);
  assert.match(linux,/ctx\.spawn\(opener, \[uri\]/);
  assert.match(packager,/'external\.open'/);
  assert.match(host,/Program\.AllowExternalOpen/);
  assert.match(host,/String\.Equals\(uri\.Scheme, "mailto"/);
  assert.match(host,/UseShellExecute = true/);
  assert.match(targetBuild,/-contains 'external\.open'/);
});
