import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const approvedRegistryHosts = new Set(['registry.npmjs.org']);
const { stdout } = await run('git', [
  'ls-files', '--',
  'package-lock.json',
  'machine_bundles/*/package-lock.json',
], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
});
const lockfiles = stdout.split(/\r?\n/).filter(Boolean);
if (!lockfiles.length) throw new Error('No tracked package-lock.json files were found.');

const violations = [];
let resolvedCount = 0;
for (const lockfile of lockfiles) {
  const lock = JSON.parse(await fs.readFile(new URL(`../${lockfile}`, import.meta.url), 'utf8'));
  for (const [packagePath, metadata] of Object.entries(lock.packages || {})) {
    if (!metadata?.resolved) continue;
    resolvedCount += 1;
    let resolved;
    try {
      resolved = new URL(metadata.resolved);
    } catch {
      violations.push(`${lockfile}:${packagePath || '<root>'} has an invalid resolved URL: ${metadata.resolved}`);
      continue;
    }
    if (resolved.protocol !== 'https:' || !approvedRegistryHosts.has(resolved.hostname)) {
      violations.push(`${lockfile}:${packagePath || '<root>'} uses unapproved dependency source ${metadata.resolved}`);
    }
  }
}

if (violations.length) {
  throw new Error(`Package-lock dependency source verification failed:\n${violations.join('\n')}`);
}
console.log(`Verified ${resolvedCount} dependency URLs across ${lockfiles.length} lockfiles use approved public npm registries.`);
