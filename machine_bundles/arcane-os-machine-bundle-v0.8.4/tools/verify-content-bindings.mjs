import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyAppContentManifest } from './app-catalog.mjs';
import { verifyMachineContentManifest } from './machine-content.mjs';

const [kind, rootArgument, identity, hashArgument] = process.argv.slice(2);
if (!['machine', 'target'].includes(kind) || !rootArgument || !identity || !/^[a-f0-9]{64}$/.test(hashArgument || '')) {
  throw new Error('Usage: node tools/verify-content-bindings.mjs machine|target <root> <version|app-id> <manifest-sha256>');
}
const root = path.resolve(rootArgument);
const expectedHash = hashArgument.toLowerCase();
const manifestName = kind === 'machine' ? 'arcane-machine-content.json' : 'arcane-app-content.json';
const manifestData = await fs.readFile(path.join(root, manifestName));
const actualHash = crypto.createHash('sha256').update(manifestData).digest('hex');
if (actualHash !== expectedHash) throw new Error(`${manifestName} does not match the expected compiled binding.`);

let marker;
let hosts;
if (kind === 'machine') {
  const verified = await verifyMachineContentManifest({ releaseRoot: root, version: identity });
  if (verified.sha256 !== expectedHash) throw new Error('Machine content verification returned a different binding hash.');
  marker = `ARCANE-MACHINE-BINDING|1|${identity}|${expectedHash}`;
  hosts = ['bin/ArcaneProvisioner.exe', 'bin/ArcaneShell.exe'];
} else {
  const launcher = `ArcaneApp-${identity}.exe`;
  const packageManifest = JSON.parse(await fs.readFile(path.join(root, 'arcane-app-package.json'), 'utf8'));
  const verified = await verifyAppContentManifest({
    target: root,
    appId: identity,
    launcher,
    version: packageManifest.bundleVersion,
  });
  if (verified.sha256 !== expectedHash) throw new Error('Target content verification returned a different binding hash.');
  marker = `ARCANE-TARGET-BINDING|1|${identity}|${expectedHash}`;
  hosts = [launcher];
}

function occurrences(data, pattern) {
  let count = 0;
  let offset = 0;
  while ((offset = data.indexOf(pattern, offset)) !== -1) { count += 1; offset += pattern.length; }
  return count;
}

for (const relative of hosts) {
  const data = await fs.readFile(path.join(root, ...relative.split('/')));
  const count = occurrences(data, Buffer.from(marker, 'utf8')) + occurrences(data, Buffer.from(marker, 'utf16le'));
  if (count !== 1) throw new Error(`${relative} must contain exactly one compiled ${kind} content binding; found ${count}.`);
}
console.log(`Verified ${kind} binding ${marker} in ${hosts.join(', ')}.`);
