import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [coreSource, windowsSource, linuxSource, windowsHostSource] = await Promise.all([
  fsp.readFile(path.join(root, 'src/core/arcane-core.template.cjs'), 'utf8'),
  fsp.readFile(path.join(root, 'src/native/windows.cjs'), 'utf8'),
  fsp.readFile(path.join(root, 'src/native/linux.cjs'), 'utf8'),
  fsp.readFile(path.join(root, 'src/hosts/windows/ArcaneHost.cs'), 'utf8'),
]);

assert.match(coreSource, /productionPackaged \? '' : argValue\('--bundle-root='\)/);
assert.match(coreSource, /cwd: opts\.cwd \|\| safeSubprocessCwd/);
assert.match(coreSource, /env: opts\.env \|\| safeSubprocessEnvironment/);
assert.doesNotMatch(coreSource, /\.\.\.process\.env/);
assert.doesNotMatch(`${windowsSource}\n${linuxSource}`, /env:\s*process\.env/);
assert.doesNotMatch(`${windowsSource}\n${linuxSource}`, /ctx\.spawn(?:Sync)?\(\s*['"]/);
assert.doesNotMatch(windowsSource, /\$password=\$\{ctx\.psQuote\(password\)\}/);
assert.equal((windowsSource.match(/\$password=\[Console\]::In\.ReadLine\(\)/g) || []).length, 2);
assert.match(windowsSource, /Remove-Item -LiteralPath \(\"Env:\"\+\$name\)/);
assert.match(windowsSource, /const systemRoot = ctx\.production \? 'C:\\\\Windows'/);
assert.match(windowsHostSource, /start\.EnvironmentVariables\.Clear\(\)/);
for (const forbidden of ['NODE_OPTIONS', 'NODE_PATH', 'DOTNET_STARTUP_HOOKS', 'COR_ENABLE_PROFILING', 'CORECLR_ENABLE_PROFILING']) {
  assert(!windowsHostSource.includes(`start.EnvironmentVariables["${forbidden}"]`));
}

{
  const checkStart=coreSource.indexOf('function checkOllamaRequirement(definition)');
  const checkEnd=coreSource.indexOf('function checkRequirements(ids)',checkStart);
  assert(checkStart>=0&&checkEnd>checkStart,'Core Ollama requirement functions must be present');
  const requirementContext=vm.createContext({
    native:{
      id:'linux',
      ollamaStatus(){return {machine:{present:false,executable:null,service:null},user:{present:false,executable:null}};},
      ollamaGlobalInstallAvailability(){return {available:false,status:'manual-only',requiresElevation:true,provider:null,reason:'Install and enable a machine-wide Ollama systemd service from a trusted distribution or official package.'};},
    },
    simulate:false,
    platform:'linux',
    versionFromCommand(){throw new Error('A missing Linux Ollama executable must not be launched.');},
    compareVersions(){return 0;},
    osInfo(){return {platform:'linux'};},
  });
  vm.runInContext(coreSource.slice(checkStart,checkEnd),requirementContext);
  const requirement=requirementContext.checkRequirement({
    id:'ollama',name:'Ollama',minimumVersion:'0.30.0',required:false,requiredFor:['arcane-user'],requiredScope:'machine',installable:false,description:'test',
  });
  assert.equal(requirement.ready,false);
  assert.equal(requirement.blocking,false,'missing Ollama must be explicitly nonblocking for a base Linux installation');
  assert.equal(requirement.status,'missing');
  assert.match(requirement.message,/does not block base Arcane OS installation on Linux/);
  assert.match(requirement.message,/before using local AI/);
}

const spawned = [];
const sandbox = {
  process: {
    env: {
      HOME: '/home/test',
      USER: 'test',
      LOGNAME: 'test',
      LANG: 'en_US.UTF-8',
      DISPLAY: ':0',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_CURRENT_DESKTOP: 'GNOME',
    },
    arch: 'x64',
    stdin: { isTTY: false },
    getuid: () => 1000,
  },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(`${linuxSource}\nglobalThis.createAdapter=createLinuxNativeAdapter;`, sandbox, { filename: 'linux.cjs' });
const adapter = sandbox.createAdapter({
  production: true,
  simulate: false,
  path: path.posix,
  fs: {
    ...fs,
    existsSync(candidate) {
      return candidate.startsWith('/usr/') || candidate.startsWith('/bin/') || candidate.startsWith('/sbin/');
    },
  },
  fsp,
  os: { hostname: () => 'fixture', userInfo: () => ({ username: 'test' }) },
  spawnSync() { return { status: 1, stdout: '', stderr: '' }; },
  spawn(command, args, options) {
    spawned.push({ command, args, options });
    return { pid: 42, unref() {} };
  },
  actionLog() {},
  arcaneError(code, message) { return Object.assign(new Error(message), { code }); },
});

for (const executable of adapter.browserCandidates()) assert(path.posix.isAbsolute(executable));
assert(path.posix.isAbsolute(adapter.sessionControlExecutable()));
const logout = adapter.logoutSpec();
assert(logout && path.posix.isAbsolute(logout[0]));
await assert.rejects(
  () => adapter.launchElevated('/opt/arcane-os/bin/ArcaneCore', ['--privileged-worker'], {}),
  (error) => error?.code === 'PRIVILEGE_PEER_VERIFICATION_UNAVAILABLE',
);
assert.equal(spawned.length, 0, 'production Linux must not spawn an unverifiable privileged peer');
const ollama = adapter.ollamaStatus();
assert.equal(ollama.machine.present, true, 'the fixture exposes a system Ollama executable');
assert.equal(ollama.machine.service.ready, false, 'a system Ollama executable without a healthy machine service must not satisfy readiness');
assert.equal(adapter.ollamaGlobalInstallAvailability().available, false, 'Linux automated global Ollama installation remains manual-only');

console.log('Arcane command and credential hardening smoke test passed.');
