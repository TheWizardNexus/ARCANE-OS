import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { renderCoreMethodPolicies, validateMethodPolicies } from './method-policies.mjs';
import { renderCoreMethodContracts, validateMethodContracts } from './method-contracts.mjs';

const toolsRoot=path.dirname(fileURLToPath(import.meta.url));
const bundleRoot=path.dirname(toolsRoot);
const corePath=path.join(bundleRoot,'src','core','arcane-core.template.cjs');
const apiPath=path.join(bundleRoot,'src','frontend','shared','arcane-api.js');
const catalogPath=path.join(bundleRoot,'arcane-apps.json');
const packagerPath=path.join(bundleRoot,'tools','app-packager-lib.mjs');
const windowsNativePath=path.join(bundleRoot,'src','native','windows.cjs');
const coreTemplate=fs.readFileSync(corePath,'utf8');
const methodPolicies=validateMethodPolicies(JSON.parse(fs.readFileSync(path.join(bundleRoot,'src','api','method-policies.json'),'utf8')));
const methodContracts=validateMethodContracts(JSON.parse(fs.readFileSync(path.join(bundleRoot,'src','api','method-contracts.json'),'utf8')),methodPolicies);
const core=coreTemplate
  .replace('__ARCANE_METHOD_POLICIES__',renderCoreMethodPolicies(methodPolicies))
  .replace('__ARCANE_METHOD_CONTRACTS__',renderCoreMethodContracts(methodContracts,methodPolicies));
const api=fs.readFileSync(apiPath,'utf8');
const catalog=JSON.parse(fs.readFileSync(catalogPath,'utf8'));
const packager=fs.readFileSync(packagerPath,'utf8');
const windowsNative=fs.readFileSync(windowsNativePath,'utf8');

const compilableCore=core
  .replace(/^#!.*\r?\n/,'')
  .replace('__ARCANE_NATIVE_ADAPTERS__','function createWindowsNativeAdapter(){return { paths:{} };}\nfunction createLinuxNativeAdapter(){return { paths:{} };}')
  .replace('__VERSION_JSON__','"0.8.4"')
  .replace('__BUNDLE_MANIFEST_JSON__','{}');
new vm.Script(compilableCore,{ filename:'arcane-core.template.cjs' });
new vm.Script(api,{ filename:'arcane-api.js' });

assert.match(core,/function managedAIProfile\(\)/);
assert.match(core,/Object\.freeze\(\{ provider,model,configured,local:provider==='ollama' \}\)/);
assert.deepEqual(methodPolicies['ai.profile.current'],{ capability:'ai.inference' });
assert.match(core,/case 'ai\.profile\.current': return managedAIProfile\(\)/);
assert.match(core,/AI_PROVIDER_CHANGED/);
assert.match(core,/expectedProvider&&expectedProvider!==provider/);
assert.match(core,/request\.model\?request:\{ \.\.\.request,model:settings\.defaultModel \}/);
assert.match(api,/profile: function \(\) \{ return invoke\('ai\.profile\.current'\); \}/);

for(const [method,capability] of [
  ['development.inspect','development.read'],
  ['development.context','development.read'],
  ['development.setup','development.manage'],
]){
  assert.equal(methodPolicies[method].capability,capability);
  assert.deepEqual(methodPolicies[method].appIds,['developer']);
  assert.match(core,new RegExp(`case '${method.replace('.','\\.')}'`));
}
assert.deepEqual(methodPolicies['development.setup'],{ capability:'development.manage',appIds:['developer'],exclusiveMutation:true });
assert.deepEqual(methodPolicies['development.node.install'],{ capability:'development.manage',appIds:['developer'],privileged:true,exclusiveMutation:true });
assert.match(core,/withAction\('development\.setup',requestId/);
assert.match(core,/withAction\('development\.node\.install',requestId/);
assert.match(core,/const DEVELOPMENT_SETUP_TASK_IDS=Object\.freeze\(\[\s*'root-dependencies','machine-dependencies','git-hooks','windows-signing'/);
assert.match(core,/'root-dependencies':\{ cwd:workspace\.root,args:\['ci','--no-audit','--no-fund'\]/);
assert.match(core,/'machine-dependencies':\{ cwd:workspace\.bundleRoot,args:\['ci','--no-audit','--no-fund'\]/);
assert.match(core,/'git-hooks':\{ cwd:workspace\.root,args:\['run','hooks:install'\]/);
assert.match(core,/'windows-signing':\{ cwd:workspace\.root,args:\['run','signing:bootstrap:dev:windows'\]/);
assert.match(core,/run\(nodeTool\.path,\[npmTool\.path,\.\.\.definition\.args\]/);
assert.match(core,/shell:false/);
assert.match(core,/DEVELOPMENT_NODE_REQUIRED/);
assert.match(core,/major>=22/);
assert.match(core,/executable\.toLowerCase\(\)===packagedCore\.toLowerCase\(\)/);

const developmentSlice=core.slice(core.indexOf('const DEVELOPMENT_CONTEXT_CHARACTER_LIMIT'),core.indexOf('async function sha256'));
assert.ok(developmentSlice.length>0,'development implementation is present');
assert.doesNotMatch(developmentSlice,/readdir(?:Sync)?\(/,'development APIs must not scan directories');
assert.doesNotMatch(developmentSlice,/request\.(?:command|args|cwd|env)/,'renderer input must not control processes');
assert.match(developmentSlice,/'docs','app-building\.md'/);
assert.match(developmentSlice,/'arcane','css','theme\.css'/);
assert.match(developmentSlice,/DEVELOPMENT_TRUSTED_BASELINE='1a092ce6b65ff9f39fa715db1a7a5885ea81c559'/);
assert.match(developmentSlice,/function developmentGitArguments\(root,args\)/);
assert.match(developmentSlice,/safe\.directory=\$\{root\}/);
assert.match(developmentSlice,/developmentGitArguments\(root,\['merge-base','--is-ancestor',DEVELOPMENT_TRUSTED_BASELINE,'HEAD'\]\)/);
assert.doesNotMatch(developmentSlice,/config','--global'/);
assert.match(developmentSlice,/DEVELOPMENT_ROOT_UNTRUSTED/);
assert.match(developmentSlice,/'ls-files','-z','--cached'/);
assert.match(developmentSlice,/scripts\['test:machine'\]/);
assert.match(developmentSlice,/runtimeVersion:VERSION/);
assert.match(developmentSlice,/query\.length>4096/);
assert.match(developmentSlice,/'--max-count=120',\.\.\.expressions,'--'/);
assert.match(developmentSlice,/stat\.isSymbolicLink\(\)/);
assert.match(developmentSlice,/DEVELOPMENT_CONTEXT_CHARACTER_LIMIT=48\*1024/);
assert.match(developmentSlice,/DEVELOPMENT_REDACTION_MARKER='\[REDACTED BY ARCANE\]'/);
assert.match(developmentSlice,/function redactDevelopmentSensitiveContent\(input\)/);
assert.match(developmentSlice,/PRIVATE KEY/);
assert.match(developmentSlice,/github_pat_/);
assert.match(developmentSlice,/redacted:sanitized\.redacted/);
assert.match(developmentSlice,/const tasks=\[\s*\{\s*id:'node-runtime'/);
assert.match(developmentSlice,/available:nodeTool\.available\|\|platform==='win32'/);
assert.match(developmentSlice,/installable:platform==='win32'/);
assert.match(developmentSlice,/ready:nodeTool\.available/);
for(const excluded of ["'.git'","'.cache'","'.codex'","'.agents'","'node_modules'","'dist'","'runtime'","'credentials'","'secrets'","'keys'","'certs'"]){
  assert.ok(developmentSlice.includes(excluded),`missing context exclusion ${excluded}`);
}
for(const filenameToken of ['token','password','passwd','private-key','auth-key'])assert.ok(developmentSlice.includes(filenameToken),`missing filename exclusion ${filenameToken}`);

const nodeInstallSlice=core.slice(core.indexOf('async function installDevelopmentNode'),core.indexOf('async function setupDevelopmentWorkspace'));
assert.ok(nodeInstallSlice.length>0,'Developer Node installer is present');
assert.match(nodeInstallSlice,/developmentRequest\(parameters,\[\]\)/);
assert.match(nodeInstallSlice,/platform!=='win32'/);
assert.match(nodeInstallSlice,/await installNode\(action\)/);
assert.match(nodeInstallSlice,/developmentNodeTool\(\)/);
assert.match(nodeInstallSlice,/DEVELOPMENT_NODE_INSTALL_FAILED/);
assert.doesNotMatch(nodeInstallSlice,/(?:download|native\.installNode)\(/,'Developer Node bootstrap must reuse the verified installer');

assert.match(api,/development: Object\.freeze\(\{/);
assert.match(api,/invoke\('development\.inspect', \{ root:/);
assert.match(api,/invoke\('development\.context', \{ root:/);
assert.match(api,/invoke\('development\.setup', \{ root:/);
assert.match(api,/installNode: function \(\) \{ return invoke\('development\.node\.install', \{\}, \{ timeoutMs: LONG_OPERATION_TIMEOUT \}\); \}/);

const developer=catalog.apps&&catalog.apps.developer;
assert.ok(developer,'Developer app is registered');
assert.equal(developer.order,45);
assert.equal(developer.source,'apps/developer');
assert.equal(developer.entry,'index.html');
assert.equal(developer.icon,'img/icon.png');
assert.deepEqual(developer.security,{ connectOrigins:[],mediaOrigins:[] });
assert.ok(developer.include.includes('prompts'));
assert.ok(developer.include.includes('img/icon.png'));
assert.ok(developer.capabilities.includes('development.read'));
assert.ok(developer.capabilities.includes('development.manage'));
assert.ok(developer.capabilities.includes('ai.inference'));
assert.ok(developer.capabilities.includes('requirements.read'));
assert.ok(developer.capabilities.includes('filesystem.directory.select'));
assert.deepEqual(developer.capabilities,[...developer.capabilities].sort(),'Developer capabilities remain deterministic');
assert.deepEqual(developer.capabilities,[
  'ai.inference','appearance.read','appearance.write','development.manage','development.read','filesystem.directory.select','preferences.read','preferences.write','requirements.read',
],'Developer requests only capabilities used by its packaged runtime');
for(const capability of ['development.manage','development.read']){
  assert.ok(packager.includes(`'${capability}'`),`packager allowlist is missing ${capability}`);
  assert.ok(windowsNative.includes(`'${capability}'`),`Windows installed-app allowlist is missing ${capability}`);
}

console.log('Development API source verification passed.');
