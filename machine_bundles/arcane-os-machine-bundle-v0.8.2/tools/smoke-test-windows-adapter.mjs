import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync as spawnProcessSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(root, 'src/native/windows.cjs'), 'utf8');
const sandbox = {
  process:{ env:{ SystemRoot:'C:\\Windows' },arch:'x64' },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(`${source}\nglobalThis.createAdapter=createWindowsNativeAdapter;`,sandbox,{
  filename:'windows.cjs',
});

const queries=[];
const adapter=sandbox.createAdapter({
  simulate:false,
  path:path.win32,
  fs:{ existsSync(){ return false; } },
  spawnSync(executable,args){
    queries.push({ executable,args });
    return {
      status:0,
      stdout:'    pv    REG_SZ    1.0.9999.0\r\n',
    };
  },
});

const status=adapter.rendererStatus();
assert.equal(status.available,true);
assert.equal(status.version,'1.0.9999.0');
assert.equal(queries.length,1);
assert.equal(queries[0].executable,'C:\\Windows\\System32\\reg.exe');
assert.equal(
  queries[0].args[1],
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
);

const scripts=[];
const hardened=sandbox.createAdapter({
  simulate:false,
  production:true,
  path:path.win32,
  fs:{
    existsSync(candidate){ return String(candidate).endsWith('ArcaneShell.exe'); },
    lstatSync(){ return { isDirectory:()=>true,isFile:()=>false,isSymbolicLink:()=>false }; },
    readdirSync(){ return []; },
  },
  psQuote(value){ return `'${String(value).replaceAll("'","''")}'`; },
  cleanPowerShellError(value){ return String(value||''); },
  arcaneError(code,message){ return Object.assign(new Error(message),{code}); },
  ensureDir:async()=>{},
  run:async()=>({code:0}),
  powershell:async(script,options={})=>{
    scripts.push({script,options});
    if(options.purpose==='prepare-user-shell-backup') return {stdout:'{"username":"arcane-test","accountExisted":false,"previousShell":null,"previousShellPresent":false,"verification":"verified"}\n'};
    if(options.purpose==='create-arcane-user') return {stdout:'{"username":"arcane-test","created":true,"sid":"S-1-5-21-TEST","profile":"C:\\\\Users\\\\arcane-test","shell":"arcane","enabled":false,"activationPending":true}\n'};
    if(options.purpose==='activate-staged-arcane-user') return {stdout:'{"username":"arcane-test","sid":"S-1-5-21-TEST","enabled":true,"activated":true}\n'};
    if(options.purpose==='rollback-created-arcane-user') return {stdout:'{"username":"arcane-test","sid":"S-1-5-21-TEST","accountDisabled":true,"accountRemoved":true,"cleanupErrors":[]}\n'};
    if(options.purpose==='restore-arcane-user-shell') return {stdout:'{"username":"arcane-test","restored":true,"shell":null,"shellAssigned":false}\n'};
    return {stdout:'verified\n'};
  },
});
assert.equal(hardened.paths.installRoot,'C:\\Program Files\\Arcane OS');
assert.equal(hardened.paths.stateRoot,'C:\\ProgramData\\Arcane OS\\state');
const backup=await hardened.prepareUserShellBackup('arcane-test',{});
const staged=await hardened.provisionUser('arcane-test','secret-password',{},backup);
await hardened.activateProvisionedUser('arcane-test',staged,{});
await hardened.rollbackCreatedUser('arcane-test',staged,{});
await hardened.restoreUserShell('arcane-test',null,false,{});
await hardened.applyStatePermissions({});
await hardened.listArcaneUsers(['arcane-test']);
const provisionCall=scripts.find(entry=>entry.options.purpose==='create-arcane-user');
assert.equal(provisionCall.options.input,'secret-password\n');
assert.match(provisionCall.script,/expectedPreviousPresent/);
assert.match(provisionCall.script,/New-LocalUser[^\r\n]+-Disabled/);
assert.match(provisionCall.script,/ARCANE_PROVISION_ROLLBACK:/);
assert.match(provisionCall.script,/Remove-LocalUser/);
assert.match(provisionCall.script,/could not release the temporary Arcane registry hive/);
assert.doesNotMatch(provisionCall.script,/secret-password/);
assert.match(source, /async function resetUserPassword\(username, password, action\)/);
const restoreCall=scripts.find(entry=>entry.options.purpose==='restore-arcane-user-shell');
assert.match(restoreCall.script,/ARCANE_PREPARE_/);
assert.match(restoreCall.script,/\[String\]::Equals\(\[string\]\$current,\[string\]\$expected,\[StringComparison\]::Ordinal\)/);
const activationCall=scripts.find(entry=>entry.options.purpose==='activate-staged-arcane-user');
assert.match(activationCall.script,/SID\.Value -ne \$expectedSid/);
assert.match(activationCall.script,/\[String\]::Equals\(\[string\]\$currentShell,\[string\]\$expectedShell,\[StringComparison\]::Ordinal\)/);
assert.match(activationCall.script,/Enable-LocalUser/);
const rollbackCall=scripts.find(entry=>entry.options.purpose==='rollback-created-arcane-user');
assert.match(rollbackCall.script,/SID\.Value -ne \$expectedSid/);
assert.match(rollbackCall.script,/Disable-LocalUser/);
assert.match(rollbackCall.script,/Remove-LocalUser/);
const aclCall=scripts.find(entry=>entry.options.purpose==='verify-arcane-state-acl');
assert.match(aclCall.script,/Directory\]::CreateDirectory/);
assert.match(aclCall.script,/recovery state changed while its ACL was being locked/);
assert.match(aclCall.script,/SetAccessRuleProtection\(\$true,\$false\)/);
assert.match(aclCall.script,/will not adopt pre-existing recovery state from a directory that was not already administrator-owned/);
const listUsersCall=scripts.find(entry=>entry.options.purpose==='list-arcane-users');
assert(listUsersCall, 'Windows user discovery must query the effective per-user shell.');
assert.match(
  listUsersCall.script,
  /\$assigned=\[bool\]\(\$verified -and \[String\]::Equals\(\[string\]\$shellValue,\[string\]\$expected,\[StringComparison\]::Ordinal\)\)/,
);
assert.doesNotMatch(listUsersCall.script, /ArcaneShell\\\.exe|\$shellValue -match|\$shellValue -eq \$expected/);

const expectedShell=hardened.shellCommand();
for (const wrongShell of [
  expectedShell.replace('C:\\Program Files\\Arcane OS', 'C:\\Arcane Lookalike'),
  `${expectedShell} --extra-argument`,
  expectedShell.replace('ArcaneShell.exe', 'arcaneshell.exe'),
]) {
  assert.notEqual(wrongShell, expectedShell, 'lookalike shell fixture must differ from the exact Arcane command');
}

let signatureMode='matching';
const signatureScripts=[];
const signatureAdapter=sandbox.createAdapter({
  simulate:false,
  production:true,
  path:path.win32,
  fs:{
    existsSync(){ return true; },
    statSync(){ return {isFile:()=>true}; },
  },
  psQuote(value){ return `'${String(value).replaceAll("'","''")}'`; },
  arcaneError(code,message){ return Object.assign(new Error(message),{code}); },
  actionLog(){},
  powershell:async(script,options)=>{
    signatureScripts.push({script,options});
    const valid=(thumbprint)=>({status:'Valid',thumbprint,subject:'CN=Arcane Test'});
    const records=signatureMode==='matching'
      ? [valid('A'.repeat(40)),valid('A'.repeat(40))]
      : signatureMode==='mismatch'
        ? [valid('A'.repeat(40)),valid('B'.repeat(40))]
        : [{status:'NotSigned',thumbprint:null,subject:null},{status:'NotSigned',thumbprint:null,subject:null}];
    return {stdout:`${JSON.stringify(records)}\n`};
  },
});
const signedTrust=await signatureAdapter.verifyPrivilegePipeGuardTrust('C:\\Arcane\\ArcanePipeGuard.exe','C:\\Arcane\\ArcaneCore.exe',{},{});
assert.equal(signedTrust.signed,true);
signatureMode='mismatch';
await assert.rejects(
  ()=>signatureAdapter.verifyPrivilegePipeGuardTrust('C:\\Arcane\\ArcanePipeGuard.exe','C:\\Arcane\\ArcaneCore.exe',{},{}),
  (error)=>error?.code==='PRIVILEGE_PIPE_GUARD_TRUST_FAILED',
);
signatureMode='unsigned';
const unsignedTrust=await signatureAdapter.verifyPrivilegePipeGuardTrust(
  'C:\\Arcane\\ArcanePipeGuard.exe','C:\\Arcane\\ArcaneCore.exe',{allowUnsignedLocalRelease:true},{}
);
assert.equal(unsignedTrust.unsignedLocal,true);
await assert.rejects(
  ()=>signatureAdapter.verifyPrivilegePipeGuardTrust('C:\\Arcane\\ArcanePipeGuard.exe','C:\\Arcane\\ArcaneCore.exe',{},{}),
  (error)=>error?.code==='PRIVILEGE_PIPE_GUARD_TRUST_FAILED',
);
assert(signatureScripts.every((entry)=>entry.options.purpose==='verify-arcane-pipe-guard-signature'));
assert.match(signatureScripts[0].script,/Get-AuthenticodeSignature/);

if (process.platform === 'win32') {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const assignmentLine=listUsersCall.script.split(/\r?\n/).find((line)=>line.trim().startsWith('$assigned='));
  assert(assignmentLine, 'Windows user discovery must contain its exact shell-identity decision.');
  const identityCases=[
    {name:'exact',value:expectedShell,expected:true},
    {name:'wrong-path',value:expectedShell.replace('C:\\Program Files\\Arcane OS','C:\\Arcane Lookalike'),expected:false},
    {name:'extra-argument',value:`${expectedShell} --extra-argument`,expected:false},
    {name:'case-altered',value:expectedShell.replace('ArcaneShell.exe','arcaneshell.exe'),expected:false},
  ];
  const psLiteral=(value)=>`'${String(value).replaceAll("'","''")}'`;
  const identityScript=`$ErrorActionPreference='Stop'\n$expected=${psLiteral(expectedShell)}\n$verified=$true\n$results=@()\n${identityCases.map((item)=>`$shellValue=${psLiteral(item.value)}\n${assignmentLine}\n$results += [pscustomobject]@{name=${psLiteral(item.name)};assigned=$assigned}`).join('\n')}\n$results|ConvertTo-Json -Compress`;
  const identityResult=spawnProcessSync(powershell,['-NoProfile','-NonInteractive','-Command',identityScript],{
    encoding:'utf8',
    windowsHide:true,
  });
  assert.equal(identityResult.status,0,`PowerShell shell-identity cases failed:\n${identityResult.stdout||identityResult.stderr}`);
  const identityOutput=JSON.parse(String(identityResult.stdout).trim());
  assert.deepEqual(identityOutput.map((item)=>({name:item.name,expected:item.assigned})),identityCases.map(({name,expected})=>({name,expected})));
  const parserCommand = "$source=[Console]::In.ReadToEnd();$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}";
  for (const entry of [...scripts,...signatureScripts]) {
    const parsed = spawnProcessSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', parserCommand], {
      input: entry.script,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(parsed.status, 0, `${entry.options.purpose || 'PowerShell adapter script'} did not parse:\n${parsed.stdout || parsed.stderr}`);
  }
}

console.log('Arcane Windows native adapter smoke test passed.');
