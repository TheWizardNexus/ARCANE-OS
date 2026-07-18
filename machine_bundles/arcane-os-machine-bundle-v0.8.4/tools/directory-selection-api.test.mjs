import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readMethodPolicies} from './method-policies.mjs';

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

test('frontend exposes one bounded native directory-selection request',async function testFrontendDirectorySelection(){
  const source=await bundleSource('src/frontend/shared/arcane-api.js');
  let request=null;
  const window={
    __ARCANE_DEV_HTTP__:true,
    crypto:{randomUUID:function randomUUID(){return `request-${Date.now()}`;}},
  };
  async function fetch(_url,options){
    request=JSON.parse(options.body);
    return {
      ok:true,
      json:async function json(){return {
        protocol:'arcane/1',
        type:'response',
        id:request.id,
        ok:true,
        result:{cancelled:false,path:bundleRoot},
      };},
    };
  }
  vm.runInNewContext(source,{window,fetch,console,setTimeout,clearTimeout},{filename:'arcane-api.js'});

  const result=await window.Arcane.filesystem.selectDirectory({title:'Choose a repository',initialPath:bundleRoot});
  assert.equal(request.method,'filesystem.directory.select');
  assert.deepEqual(request.parameters,{title:'Choose a repository',initialPath:bundleRoot});
  assert.deepEqual(result,{cancelled:false,path:bundleRoot});
  assert.throws(function selectDirectoryWithInvalidOptions(){window.Arcane.filesystem.selectDirectory([]);},/options must be an object/i);
  assert.doesNotMatch(source,/showDirectoryPicker|webkitdirectory/);
});

test('Windows native selector has real read-only dialog behavior and deterministic simulation',async function testWindowsDirectorySelector(){
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

test('Linux native selector uses an argv-only desktop picker and normalizes selection',async function testLinuxDirectorySelector(){
  const createLinuxNativeAdapter=await nativeFactory('src/native/linux.cjs','createLinuxNativeAdapter');
  const calls=[];
  const selectedPath='/home/arcane/repository';
  const fakeFs=Object.create(fs);
  fakeFs.existsSync=function fakeExistsSync(value){return value==='/usr/bin/zenity';};
  const adapter=createLinuxNativeAdapter(nativeContext({
    simulate:false,
    path:path.posix,
    fs:fakeFs,
    spawnSync(executable,args,options){calls.push({executable,args,options});return {status:0,stdout:`${selectedPath}\n`,stderr:''};},
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(await adapter.selectDirectory({title:'Choose a repository',initialPath:selectedPath}))),{cancelled:false,path:selectedPath});
  assert.equal(calls.length,1);
  assert.equal(calls[0].executable,'/usr/bin/zenity');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)),['--file-selection','--directory','--title=Choose a repository',`--filename=${selectedPath}/`]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].options)),{encoding:'utf8',windowsHide:true});
  const source=await bundleSource('src/native/linux.cjs');
  const start=source.indexOf('async function selectDirectory(input)');
  const end=source.indexOf('\n  async function launchElevated',start);
  const selector=source.slice(start,end);
  assert.match(selector,/command: 'zenity'/);
  assert.match(selector,/command: 'kdialog'/);
  assert.doesNotMatch(selector,/shell\s*:\s*true|\bexec\s*\(|\bspawn\s*\(/);
});

test('Linux native selector distinguishes cancellation, missing picker, and picker failure',async function testLinuxDirectorySelectorFailures(){
  const createLinuxNativeAdapter=await nativeFactory('src/native/linux.cjs','createLinuxNativeAdapter');
  const pickerFs=Object.create(fs);
  pickerFs.existsSync=function pickerExistsSync(value){return value==='/usr/bin/zenity';};
  const cancelled=createLinuxNativeAdapter(nativeContext({
    simulate:false,
    path:path.posix,
    fs:pickerFs,
    spawnSync(){return {status:1,stdout:'',stderr:''};},
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(await cancelled.selectDirectory({title:'Choose',initialPath:'/home/arcane'}))),{cancelled:true,path:null});

  const missingFs=Object.create(fs);
  missingFs.existsSync=function missingExistsSync(){return false;};
  const missing=createLinuxNativeAdapter(nativeContext({simulate:false,path:path.posix,fs:missingFs}));
  await assert.rejects(missing.selectDirectory({title:'Choose',initialPath:'/home/arcane'}),function isMissingPicker(error){return error?.code==='FILESYSTEM_DIRECTORY_SELECTION_UNSUPPORTED'&&error?.status===501;});

  const failed=createLinuxNativeAdapter(nativeContext({
    simulate:false,
    path:path.posix,
    fs:pickerFs,
    spawnSync(){return {status:2,stdout:'',stderr:'picker failed'};},
  }));
  await assert.rejects(failed.selectDirectory({title:'Choose',initialPath:'/home/arcane'}),function isPickerFailure(error){return error?.code==='FILESYSTEM_DIRECTORY_SELECTION_FAILED'&&error?.status===500&&error?.details?.picker==='zenity'&&error?.details?.status===2;});
});

test('Core preserves the exact native picker path before canonicalization',async function testExactSelectedDirectoryPath(){
  const core=await bundleSource('src/core/arcane-core.template.cjs');
  assert.match(core,/const selected=typeof result\.path==='string'\?result\.path:'';/);
  assert.doesNotMatch(core,/result\.path\.trim\(\)/);

  const createLinuxNativeAdapter=await nativeFactory('src/native/linux.cjs','createLinuxNativeAdapter');
  const selectedPath='/home/arcane/name ';
  const pickerFs=Object.create(fs);
  pickerFs.existsSync=function pickerExistsSync(value){return value==='/usr/bin/zenity';};
  const adapter=createLinuxNativeAdapter(nativeContext({
    simulate:false,
    path:path.posix,
    fs:pickerFs,
    spawnSync(){return {status:0,stdout:`${selectedPath}\n`,stderr:''};},
  }));
  assert.equal((await adapter.selectDirectory({title:'Choose',initialPath:'/home/arcane'})).path,selectedPath);
});

test('Core policy, dispatch, validation, and package allowlists bind the selector capability',async function testDirectorySelectionAuthority(){
  const [core,packager,windows,policies]=await Promise.all([
    bundleSource('src/core/arcane-core.template.cjs'),
    bundleSource('tools/app-packager-lib.mjs'),
    bundleSource('src/native/windows.cjs'),
    readMethodPolicies(bundleRoot),
  ]);
  assert.deepEqual(policies['filesystem.directory.select'],{capability:'filesystem.directory.select'});
  assert.match(core,/case 'filesystem\.directory\.select': return selectFilesystemDirectory\(parameters\);/);
  assert.match(core,/function filesystemDirectorySelectionRequest\(parameters\)/);
  assert.match(core,/allowed=new Set\(\['initialPath','title'\]\)/);
  assert.match(core,/fs\.realpathSync\(selected\)/);
  assert.match(core,/fs\.statSync\(canonical\)\.isDirectory\(\)/);
  assert.equal(Object.hasOwn(policies['filesystem.directory.select'],'privileged'),false);
  assert.equal(Object.hasOwn(policies['filesystem.directory.select'],'exclusiveMutation'),false);
  assert.match(packager,/'filesystem\.directory\.select'/);
  assert.match(windows,/SAFE_APP_CAPABILITIES[\s\S]*?'filesystem\.directory\.select'/);
});
