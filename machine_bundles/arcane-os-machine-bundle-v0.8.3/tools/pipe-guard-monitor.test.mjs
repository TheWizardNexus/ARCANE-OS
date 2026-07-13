import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreSource = await fs.readFile(path.join(root, 'src/core/arcane-core.template.cjs'), 'utf8');
const start = coreSource.indexOf('function monitorPipeGuardSignals(child)');
const end = coreSource.indexOf('function secretEquals', start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);
const monitorSource = coreSource.slice(start, end);

function createMonitor() {
  const sandbox = { clearTimeout, setTimeout };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${monitorSource}\nglobalThis.monitorPipeGuardSignals = monitorPipeGuardSignals;`, sandbox, {
    filename: 'arcane-pipe-guard-monitor.cjs',
  });
  return sandbox.monitorPipeGuardSignals;
}

function fakeGuard() {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  return child;
}

test('pipe guard preserves its detailed stderr failure through process close', async () => {
  const child = fakeGuard();
  const monitor = createMonitor()(child);
  const waiting = monitor.waitFor('ARCANE_PIPE_GUARD_BOUND ', 1000);
  child.stderr.write('ARCANE_PIPE_GUARD_ERROR expected worker 123 exited with code 37\n');
  child.stderr.end();
  child.emit('exit', 10, null);
  child.emit('close', 10, null);
  await assert.rejects(waiting, /expected worker 123 exited with code 37/);
});

test('pipe guard close is terminal even when it occurs between waiters', async () => {
  const child = fakeGuard();
  const monitor = createMonitor()(child);
  child.stderr.end();
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  await assert.rejects(
    monitor.waitFor('ARCANE_PIPE_GUARD_BOUND ', 60000),
    /closed before peer authentication \(code 0, signal none\)/,
  );
});
