import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

if (process.platform !== 'win32') {
  throw new Error('The compiled ArcanePipeGuard smoke test must run on Windows.');
}

const guardPath = path.resolve(process.argv[2] || '');
await fs.access(guardPath);
const pipeName = `arcane-privileged-guard-test-${process.pid}-${crypto.randomBytes(10).toString('hex')}`;
const endpoint = `\\\\.\\pipe\\${pipeName}`;
const workerBytes = Buffer.from(`ARCANE-WORKER-${crypto.randomBytes(24).toString('hex')}`, 'ascii');
const brokerBytes = Buffer.from(`ARCANE-BROKER-${crypto.randomBytes(24).toString('hex')}`, 'ascii');
const guard = spawn(guardPath, [`--pipe-name=${pipeName}`], {
  cwd: path.dirname(guardPath),
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let signalBuffer = '';
const signalLines = [];
const signalWaiters = new Set();
let guardFailure = null;
function settleSignals() {
  for (const waiter of [...signalWaiters]) {
    const match = signalLines.findIndex((line) => line.startsWith(waiter.prefix));
    if (match >= 0) {
      const [line] = signalLines.splice(match, 1);
      signalWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    } else if (guardFailure) {
      signalWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(guardFailure);
    }
  }
}
function acceptSignal(line) {
  const value = line.trim();
  if (!value) return;
  if (value.startsWith('ARCANE_PIPE_GUARD_ERROR ')) guardFailure = new Error(value);
  else signalLines.push(value);
  settleSignals();
}
guard.stderr.setEncoding('utf8');
guard.stderr.on('data', (chunk) => {
  signalBuffer += chunk;
  while (signalBuffer.includes('\n')) {
    const newline = signalBuffer.indexOf('\n');
    acceptSignal(signalBuffer.slice(0, newline));
    signalBuffer = signalBuffer.slice(newline + 1);
  }
});
guard.on('error', (error) => { guardFailure = error; settleSignals(); });
guard.on('exit', (code) => {
  if (signalBuffer) acceptSignal(signalBuffer);
  if (code !== 0 && !guardFailure) guardFailure = new Error(`ArcanePipeGuard exited with ${code}.`);
  settleSignals();
});
function waitSignal(prefix, milliseconds = 15000) {
  const existing = signalLines.findIndex((line) => line.startsWith(prefix));
  if (existing >= 0) return Promise.resolve(signalLines.splice(existing, 1)[0]);
  if (guardFailure) return Promise.reject(guardFailure);
  return new Promise((resolve, reject) => {
    const waiter = { prefix, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      signalWaiters.delete(waiter);
      reject(new Error(`Timed out waiting for ${prefix}. Signals: ${signalLines.join(' | ')}`));
    }, milliseconds);
    signalWaiters.add(waiter);
  });
}
function connect(socket) {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
}

const childSource = String.raw`
'use strict';
const net=require('node:net');
const endpoint=process.argv[1];
const outgoing=Buffer.from(process.argv[2],'base64url');
const expected=Buffer.from(process.argv[3],'base64url');
const deadline=Date.now()+15000;
function attempt(){
  const socket=net.createConnection(endpoint);
  let connected=false;
  socket.once('connect',()=>{connected=true;socket.write(outgoing);});
  let received=Buffer.alloc(0);
  socket.on('data',(chunk)=>{
    received=Buffer.concat([received,chunk]);
    if(received.length>=expected.length){
      if(!received.subarray(0,expected.length).equals(expected))process.exit(22);
      socket.destroy();
      process.stdout.write('ARCANE_TEST_CLIENT_OK',()=>process.exit(0));
    }
  });
  socket.once('error',()=>{
    socket.destroy();
    if(!connected&&Date.now()<deadline)setTimeout(attempt,25);
    else process.exit(21);
  });
}
attempt();
setTimeout(()=>process.exit(23),16000).unref();
`;

let attacker;
let legitimate;
try {
  assert.equal(await waitSignal('ARCANE_PIPE_GUARD_READY '), `ARCANE_PIPE_GUARD_READY ${pipeName}`);

  attacker = net.createConnection(endpoint);
  await connect(attacker);

  legitimate = spawn(process.execPath, [
    '-e', childSource, endpoint, workerBytes.toString('base64url'), brokerBytes.toString('base64url'),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  assert(Number.isSafeInteger(legitimate.pid) && legitimate.pid > 0 && legitimate.pid !== process.pid);
  let legitimateOutput = '';
  let legitimateError = '';
  legitimate.stdout.setEncoding('utf8');
  legitimate.stderr.setEncoding('utf8');
  legitimate.stdout.on('data', (chunk) => { legitimateOutput += chunk; });
  legitimate.stderr.on('data', (chunk) => { legitimateError += chunk; });

  const fakeHello = Buffer.from(JSON.stringify({
    protocol: 'arcane/1',
    type: 'hello',
    pid: legitimate.pid,
    note: 'attacker claims the expected Start-Process PID',
  }), 'utf8');
  attacker.write(Buffer.concat([
    Buffer.from(`Content-Length: ${fakeHello.length}\r\n\r\n`, 'ascii'),
    fakeHello,
  ]));

  const rejectedPromise = waitSignal('ARCANE_PIPE_GUARD_REJECTED ');
  const boundPromise = waitSignal('ARCANE_PIPE_GUARD_BOUND ');
  guard.stdin.write(`ARCANE_EXPECTED_PID ${legitimate.pid}\n`, 'ascii');
  assert.equal(await rejectedPromise, `ARCANE_PIPE_GUARD_REJECTED ${process.pid}`);
  assert.equal(await boundPromise, `ARCANE_PIPE_GUARD_BOUND ${legitimate.pid}`);

  let relayed = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The verified worker bytes were not relayed.')), 15000);
    guard.stdout.on('data', (chunk) => {
      relayed = Buffer.concat([relayed, chunk]);
      if (relayed.length >= workerBytes.length) {
        clearTimeout(timer);
        resolve();
      }
    });
    guard.stdout.once('error', reject);
  });
  assert.deepEqual(relayed.subarray(0, workerBytes.length), workerBytes);
  assert.equal(relayed.includes(fakeHello), false, 'bytes from a kernel-PID-mismatched client reached the broker');
  guard.stdin.write(brokerBytes);

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Verified pipe client timed out. stderr=${legitimateError} stdout=${legitimateOutput} signals=${signalLines.join('|')}`)), 15000);
    legitimate.once('error', reject);
    legitimate.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, legitimateError);
  assert.equal(legitimateOutput, 'ARCANE_TEST_CLIENT_OK');
  console.log('ArcanePipeGuard rejected a spoofed claimed PID and relayed only the kernel-verified Windows client.');
} finally {
  try { attacker?.destroy(); } catch { }
  try { legitimate?.kill(); } catch { }
  try { guard.stdin.end(); } catch { }
  if (guard.exitCode === null && guard.signalCode === null) {
    try { guard.kill(); } catch { }
  }
}
