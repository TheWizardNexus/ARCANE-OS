'use strict';

const net = require('node:net');

const argv = process.argv.slice(2);
function option(prefix) {
  const argument = argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : '';
}

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ]);
}

const endpoint = option('--ipc=');
if (!endpoint) process.exit(2);

const socket = net.createConnection(endpoint);
const timeout = setTimeout(() => process.exit(3), 10000);
socket.once('connect', () => {
  socket.write(encodeFrame({
    protocol: option('--protocol='),
    type: 'hello',
    token: option('--token='),
    brokerSession: option('--broker-session='),
    brokerPid: Number(option('--broker-pid=')),
    elevated: true,
    pid: process.pid,
    app: option('--app='),
    platform: option('--platform='),
    version: option('--version='),
  }), () => {
    if (process.send) process.send({ connected: true, pid: process.pid });
  });
});
socket.on('data', () => process.exit(4));
socket.on('close', () => {
  clearTimeout(timeout);
  process.exit(0);
});
socket.on('error', () => process.exit(5));
