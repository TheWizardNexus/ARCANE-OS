import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [service, windows, core, provisioner, build, machineContent, releaseIntegrity, nativeHost] = await Promise.all([
  fs.readFile(path.join(root, 'src/hosts/windows/ArcaneOllamaService.cs'), 'utf8'),
  fs.readFile(path.join(root, 'src/native/windows.cjs'), 'utf8'),
  fs.readFile(path.join(root, 'src/core/arcane-core.template.cjs'), 'utf8'),
  fs.readFile(path.join(root, 'src/frontend/provisioner/index.html'), 'utf8'),
  fs.readFile(path.join(root, 'tools/build-windows-webview2.ps1'), 'utf8'),
  fs.readFile(path.join(root, 'tools/machine-content.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'tools/release-integrity.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'src/hosts/windows/ArcaneHost.cs'), 'utf8'),
]);

assert.match(service, /ServiceBase[.]Run\(new ArcaneOllamaService\(\)\)/);
assert.match(service, /Path[.]Combine\(AppDomain[.]CurrentDomain[.]BaseDirectory, "ollama[.]exe"\)/);
assert.match(service, /UseShellExecute = false/);
assert.match(service, /CreateJobObject/);
assert.match(service, /JobObjectLimitKillOnJobClose/);
assert.match(service, /AssignProcessToJobObject/);
assert.match(service, /TerminateJobObject/);
assert.match(service, /FileAttributes[.]ReparsePoint/);
assert.match(service, /http:\/\/127[.]0[.]0[.]1:11434\/api\/version/);
assert.match(service, /new BoundedText\(8192\)/);
assert.match(service, /EventLog[.]WriteEntry/);
assert.match(service, /service host entered startup/);
assert.doesNotMatch(service, /cmd[.]exe|powershell[.]exe|UseShellExecute = true/i);

assert.match(windows, /'binPath=', `"\$\{serviceHost\}"`/);
assert.doesNotMatch(windows, /'binPath='[^\r\n]+--service/);
assert.match(windows, /'obj=', 'NT AUTHORITY\\\\LocalService'/);
assert.doesNotMatch(windows, /New-Item -Path \$service -Force/);
assert.match(windows, /service registration disappeared before its environment was configured/);
assert.match(windows, /'sidtype', 'ArcaneOllama', 'unrestricted'/);
assert.match(windows, /NTAccount\('NT SERVICE','ArcaneOllama'\)/);
assert.match(windows, /SecurityIdentifier\('S-1-5-19'\)/);
assert(windows.indexOf("'sidtype', 'ArcaneOllama', 'unrestricted'") < windows.indexOf('await protectOllamaRuntime(action, executable)'),
  'the unique service SID must exist before runtime ACLs are applied');
assert.match(windows, /Assert-ReadExecute[\s\S]*\$localService[\s\S]*\$serviceSid/);
assert.match(windows, /\$readExecute=\$rule[.]FileSystemRights -band [^\r\n]+ReadAndExecute[\s\S]*\$readExecute -eq [^\r\n]+ReadAndExecute/);
assert.match(windows, /relative[.]Split\('\\\\'\)[\s\S]*Arcane Ollama cache ancestor is unsafe/);
assert.match(windows, /'failure', 'ArcaneOllama'/);
assert.match(windows, /spawnSync\(serviceHost, \['--probe'\]/);
assert.match(windows, /accountMatches/);
assert.match(windows, /Reusing the protected, SHA-256-verified Ollama archive cache/);
assert.match(windows, /copyFile\(candidate, temporary\)[\s\S]*sha256\(temporary\)[\s\S]*rename\(temporary, cacheFile\)[\s\S]*sha256\(cacheFile\)/);
assert.match(windows, /installPayload\(ctx[.]bundleRoot\(\)\)/);
assert.match(windows, /serviceInstallPath = 'bin\/ArcaneOllamaService[.]exe'/);
assert.match(windows, /copyFile\(serviceHostSource, stagedServiceHost\)[\s\S]*verifyBoundServiceHost\(stagedServiceHost, 'while staging'\)/);
assert.match(windows, /verifyBoundServiceHost\(serviceHost, 'after applying the Ollama runtime ACL'\)/);
assert.match(windows, /persistOllamaFailureDiagnostic/);
assert.match(windows, /last-service-start-failure[.]json/);
assert.match(windows, /error[.]code === 'OLLAMA_GLOBAL_SERVICE_START_FAILED' && activated/);
assert.match(windows, /Preserving the failed ArcaneOllama service and activated runtime for direct startup diagnosis/);
assert.match(windows, /createdService = true/);
assert.doesNotMatch(windows, /serviceTouched/);
assert.match(windows, /\['stop', 'ArcaneOllama'\][\s\S]*waitForOllamaService\(executable \|\| currentExecutable, 'stopped', 30000\)[\s\S]*\['delete', 'ArcaneOllama'\]/);
assert.doesNotMatch(windows, /\['delete', 'ArcaneOllama'\], \{ action, allowFailure: true \}/);
assert.match(windows, /const restoredExecutable = ollamaExecutable\(\) \|\| currentExecutable \|\| executable;[\s\S]*\['start', 'ArcaneOllama'\][\s\S]*waitForOllamaService\(restoredExecutable, 'running', 30000\)/);
assert.match(windows, /exitCode:[\s\S]*stdout:[\s\S]*stderr:/);
assert.doesNotMatch(windows, /'binPath=', `"\$\{executable\}" serve`/);

assert.match(core, /diagnosticDetails: error && error[.]diagnosticDetails/);
assert.match(provisioner, /diagnosticDetails: error && error[.]diagnosticDetails/);
const normalizeStart = core.indexOf('function normalizeError(error)');
const normalizeEnd = core.indexOf('function recordError(', normalizeStart);
assert(normalizeStart >= 0 && normalizeEnd > normalizeStart);
const normalizeContext = { normalized: null };
vm.runInNewContext(`${core.slice(normalizeStart, normalizeEnd)}\nnormalized=normalizeError({message:'failed',diagnosticDetails:{serviceHost:{path:'C:\\\\Program Files\\\\Ollama\\\\ArcaneOllamaService.exe'}}});`, normalizeContext);
assert.equal(normalizeContext.normalized.diagnosticDetails.serviceHost.path, 'C:\\Program Files\\Ollama\\ArcaneOllamaService.exe');

assert.match(build, /ArcaneOllamaService[.]cs/);
assert.match(build, /reference:System[.]ServiceProcess[.]dll/);
assert.match(build, /Sign-ArcaneFile \$ollamaServiceTarget/);
assert(build.indexOf('Sign-ArcaneFile $ollamaServiceTarget') < build.indexOf("tools\\machine-content.mjs') write"));
for (const source of [machineContent, releaseIntegrity, nativeHost]) assert.match(source, /ArcaneOllamaService[.]exe/);

console.log('Arcane Ollama Windows service host source and release binding verification passed.');
