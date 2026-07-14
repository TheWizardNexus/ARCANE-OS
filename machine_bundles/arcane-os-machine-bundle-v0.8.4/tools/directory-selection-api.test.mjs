import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const toolsRoot=path.dirname(fileURLToPath(import.meta.url));
const bundleRoot=path.dirname(toolsRoot);

async function bundleSource(relative){
  return readFile(path.join(bundleRoot,...relative.split('/')),'utf8');
}

function nativeContext(overrides={}){
  return {
    production:false,
    simulate:true,
    processPkg:false,
    path,
    os,
    fs,
    spawn(){throw new Error('The focused selector test must not spawn a process.');},
    spawnSync(){throw new Error('The focused selector test must not spawn a process.');},
    powershell(){throw new Error('The focused selector test must not open a real dialog.');},
    psQuote(value){return `'${String(value).replaceAll("'","''")}'`;},
    arcaneError(code,message,resolution,status,details){
      const error=new Error(message);
      Object.assign(error,{code,resolution,status,details});
      return error;
    },
    ...overrides,
  };
}

async function nativeFactory(relative,name){
  const source=await bundleSource(relative);
  const module={exports:{}};
  vm.runInNewContext(`${source}\nmodule.exports=${name};`,{
    module,
    exports:module.exports,
    require,
    process,
    Buffer,
    console,
    setTimeout,
    clearTimeout,
  },{filename:path.join(bundleRoot,...relative.split('/'))});
  return module.exports;
}

test('frontend exposes one bounded native directory-selection request',async()=>{
  const source=await bundleSource('src/frontend/shared/arcane-api.js');
  let request=null;
  const window={
    __ARCANE_DEV_HTTP__:true,
    crypto:{randomUUID:()=>`request-${Date.now()}`},
  };
  const fetch=async(_url,options)=>{
    request=JSON.parse(options.body);
    return {
      ok:true,
      json:async()=>({
        protocol:'arcane/1',
        type:'response',
        id:request.id,
        ok:true,
        result:{cancelled:false,path:bundleRoot},
      }),
    };
  };
  vm.runInNewContext(source,{window,fetch,console,setTimeout,clearTimeout},{filename:'arcane-api.js'});

  const result=await window.Arcane.filesystem.selectDirectory({title:'Choose a repository',initialPath:bundleRoot});
  assert.equal(request.method,'filesystem.directory.select');
  assert.deepEqual(request.parameters,{title:'Choose a repository',initialPath:bundleRoot});
  assert.deepEqual(result,{cancelled:false,path:bundleRoot});
  assert.throws(()=>window.Arcane.filesystem.selectDirectory([]),/options must be an object/i);
  assert.doesNotMatch(source,/showDirectoryPicker|webkitdirectory/);
});

test('Windows native selector has real read-only dialog behavior and deterministic simulation',async()=>{
  const source=await bundleSource('src/native/windows.cjs');
  const createWindowsNativeAdapter=await nativeFactory('src/native/windows.cjs','createWindowsNativeAdapter');
  const adapter=createWindowsNativeAdapter(nativeContext());

  assert.deepEqual(JSON.parse(JSON.stringify(await adapter.selectDirectory({title:'Choose a repository',initialPath:bundleRoot}))),{
    cancelled:false,
    path:bundleRoot,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await adapter.selectDirectory({title:'Choose a repository',initialPath:''}))),{
    cancelled:true,
    path:null,
  });

  const start=source.indexOf('async function selectDirectory(input)');
  const end=source.indexOf('\n  function normalizeShellRecovery',start);
  assert.ok(start>=0&&end>start);
  const selector=source.slice(start,end);
  assert.match(selector,/System\.Windows\.Forms\.FolderBrowserDialog/);
  assert.match(selector,/ShowNewFolderButton=\$false/);
  assert.match(selector,/AutoUpgradeEnabled=\$true/);
  assert.match(selector,/ctx\.powershell\(script/);
  assert.match(selector,/ConvertTo-Json -Compress/);
  assert.doesNotMatch(selector,/\bRunAs\b|Start-Process|\bNew-Item\b|Set-Content|WriteAll|mkdir/i);
});

test('Linux native selector fails explicitly without spawning or mutating',async()=>{
  const createLinuxNativeAdapter=await nativeFactory('src/native/linux.cjs','createLinuxNativeAdapter');
  const adapter=createLinuxNativeAdapter(nativeContext());
  await assert.rejects(
    adapter.selectDirectory({title:'Choose a repository',initialPath:bundleRoot}),
    (error)=>error?.code==='FILESYSTEM_DIRECTORY_SELECTION_UNSUPPORTED'&&error?.status===501
  );
});

test('Core policy, dispatch, validation, and package allowlists bind the selector capability',async()=>{
  const [core,packager,windows]=await Promise.all([
    bundleSource('src/core/arcane-core.template.cjs'),
    bundleSource('tools/app-packager-lib.mjs'),
    bundleSource('src/native/windows.cjs'),
  ]);
  const policy=/['"]filesystem\.directory\.select['"]:\s*Object\.freeze\(\{\s*capability:['"]filesystem\.directory\.select['"]\s*\}\)/;
  assert.match(core,policy);
  assert.match(core,/case 'filesystem\.directory\.select': return selectFilesystemDirectory\(parameters\);/);
  assert.match(core,/function filesystemDirectorySelectionRequest\(parameters\)/);
  assert.match(core,/allowed=new Set\(\['initialPath','title'\]\)/);
  assert.match(core,/fs\.realpathSync\(selected\)/);
  assert.match(core,/fs\.statSync\(canonical\)\.isDirectory\(\)/);
  assert.doesNotMatch(core.match(policy)?.[0]||'',/privileged|exclusiveMutation/);
  assert.match(packager,/'filesystem\.directory\.select'/);
  assert.match(windows,/SAFE_APP_CAPABILITIES[\s\S]*?'filesystem\.directory\.select'/);
});
