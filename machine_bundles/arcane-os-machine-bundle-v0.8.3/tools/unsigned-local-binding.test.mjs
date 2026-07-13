import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreSource = await fs.readFile(path.join(root, 'src/core/arcane-core.template.cjs'), 'utf8');

function functionSource(start, end) {
  const from = coreSource.indexOf(start);
  const to = coreSource.indexOf(end, from);
  assert.notEqual(from, -1, `Missing Core function ${start}`);
  assert.notEqual(to, -1, `Missing Core function boundary ${end}`);
  return coreSource.slice(from, to);
}

const normalizeSource = functionSource('function normalizeIntegrityPath(input)', 'function integrityFilePath');
const verifySource = functionSource('function verifyUnsignedLocalPipeGuardBinding(guardExecutable)', 'function monitorPipeGuardSignals');

function createVerifier({ bundleRoot, coreExecutable, appMode = 'provisioner', version = '0.8.2' }) {
  const sandbox = {
    BUNDLE_MANIFEST: { name: 'Arcane OS Machine Bundle' },
    VERSION: version,
    appMode,
    bundleRoot: () => bundleRoot,
    crypto,
    fs: fsSync,
    path,
    process: { arch: process.arch, execPath: coreExecutable },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${normalizeSource}\n${verifySource}\nglobalThis.verifyUnsignedLocalPipeGuardBinding = verifyUnsignedLocalPipeGuardBinding;`, sandbox, {
    filename: 'arcane-unsigned-local-binding.cjs',
  });
  return sandbox.verifyUnsignedLocalPipeGuardBinding;
}

function record(relativePath, contents) {
  return {
    path: relativePath,
    size: contents.length,
    sha256: crypto.createHash('sha256').update(contents).digest('hex'),
  };
}

test('unsigned local machine release binds the sibling Core and pipe guard through bin paths', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-unsigned-machine-'));
  const core = Buffer.from('machine core');
  const guard = Buffer.from('machine guard');
  const coreExecutable = path.join(fixture, 'bin', 'ArcaneCore.exe');
  const guardExecutable = path.join(fixture, 'bin', 'ArcanePipeGuard.exe');
  try {
    await fs.mkdir(path.dirname(coreExecutable), { recursive: true });
    await fs.writeFile(coreExecutable, core);
    await fs.writeFile(guardExecutable, guard);
    const manifest = {
      schemaVersion: 1,
      hashAlgorithm: 'sha256',
      release: {
        name: 'Arcane OS Machine Bundle',
        version: '0.8.2',
        platform: 'windows',
        architecture: process.arch,
      },
      files: [record('bin/ArcaneCore.exe', core), record('bin/ArcanePipeGuard.exe', guard)],
    };
    const manifestPath = path.join(fixture, 'arcane-machine-content.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const verify = createVerifier({ bundleRoot: fixture, coreExecutable });
    assert.doesNotThrow(() => verify(guardExecutable));

    manifest.files[0].sha256 = '0'.repeat(64);
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    assert.throws(() => verify(guardExecutable), /ArcaneCore\.exe does not match the content manifest/);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('unsigned local target release binds root-level Core and pipe guard through its app content manifest', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-unsigned-target-'));
  const core = Buffer.from('target core');
  const guard = Buffer.from('target guard');
  const coreExecutable = path.join(fixture, 'ArcaneCore.exe');
  const guardExecutable = path.join(fixture, 'ArcanePipeGuard.exe');
  try {
    await fs.writeFile(coreExecutable, core);
    await fs.writeFile(guardExecutable, guard);
    const manifest = {
      schemaVersion: 1,
      hashAlgorithm: 'sha256',
      app: { id: 'boss', version: '0.8.2' },
      files: [record('ArcaneCore.exe', core), record('ArcanePipeGuard.exe', guard)],
    };
    const manifestPath = path.join(fixture, 'arcane-app-content.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const verify = createVerifier({ bundleRoot: fixture, coreExecutable, appMode: 'boss' });
    assert.doesNotThrow(() => verify(guardExecutable));

    manifest.app.id = 'precrisis';
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    assert.throws(() => verify(guardExecutable), /content manifest is invalid/);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('unsigned local binding rejects ambiguous manifests and executables outside the bound root', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-unsigned-boundary-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-unsigned-outside-'));
  const core = Buffer.from('outside core');
  const guard = Buffer.from('outside guard');
  const coreExecutable = path.join(outside, 'ArcaneCore.exe');
  const guardExecutable = path.join(outside, 'ArcanePipeGuard.exe');
  try {
    await fs.writeFile(coreExecutable, core);
    await fs.writeFile(guardExecutable, guard);
    const machine = {
      schemaVersion: 1,
      hashAlgorithm: 'sha256',
      release: {
        name: 'Arcane OS Machine Bundle',
        version: '0.8.2',
        platform: 'windows',
        architecture: process.arch,
      },
      files: [record('bin/ArcaneCore.exe', core), record('bin/ArcanePipeGuard.exe', guard)],
    };
    await fs.writeFile(path.join(fixture, 'arcane-machine-content.json'), JSON.stringify(machine));
    const verify = createVerifier({ bundleRoot: fixture, coreExecutable });
    assert.throws(() => verify(guardExecutable), /integrity path|not normalized/);

    await fs.writeFile(path.join(fixture, 'arcane-app-content.json'), JSON.stringify({
      schemaVersion: 1,
      hashAlgorithm: 'sha256',
      app: { id: 'provisioner', version: '0.8.2' },
      files: [],
    }));
    assert.throws(() => verify(guardExecutable), /content manifest is missing or ambiguous/);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
