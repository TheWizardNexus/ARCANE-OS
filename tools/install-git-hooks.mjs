import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(repositoryRoot, '.git'))) {
  console.log('Skipping Git hook setup outside a Git worktree.');
  process.exit(0);
}

const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  windowsHide: true,
});
if (result.status !== 0) {
  throw new Error(`Could not configure the Arcane Git hooks: ${(result.stderr || result.stdout || '').trim()}`);
}
console.log('Configured the Arcane pre-push verification hook.');
