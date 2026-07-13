#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const app = (argv.find(v => v.startsWith('--app=')) || '--app=provisioner').slice(6);
const noOpen = argv.includes('--no-open');
const coreArgs = [path.join(root, 'runtime/arcane-core.cjs'), `--app=${app}`, `--bundle-root=${root}`];
const core = spawn(process.execPath, coreArgs, { stdio:['pipe','pipe','inherit'] });
const pending = new Map();
const eventClients = new Set();
let buffer = Buffer.alloc(0), expected = null;
core.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    if (expected === null) {
      const marker = buffer.indexOf('\r\n\r\n'); if (marker < 0) return;
      const match = buffer.subarray(0,marker).toString('ascii').match(/Content-Length:\s*(\d+)/i);
      if (!match) throw new Error('Invalid Arcane Core frame');
      expected = Number(match[1]); buffer = buffer.subarray(marker+4);
    }
    if (buffer.length < expected) return;
    const json = buffer.subarray(0,expected).toString('utf8'); buffer=buffer.subarray(expected); expected=null;
    const message = JSON.parse(json);
    if (message.type === 'event') for (const res of eventClients) res.write(`data: ${JSON.stringify(message)}\n\n`);
    else if (message.type === 'response') { const entry=pending.get(message.id); if(entry){pending.delete(message.id);entry(message);} }
  }
});
function send(message){const body=Buffer.from(JSON.stringify(message));core.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]));}
function mime(file){return file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':file.endsWith('.ico')?'image/x-icon':file.endsWith('.webmanifest')?'application/manifest+json':'application/octet-stream';}
const server=http.createServer(async(req,res)=>{
  try{
    if(req.url==='/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(': Arcane events\n\n');eventClients.add(res);req.on('close',()=>eventClients.delete(res));return;}
    if(req.url==='/rpc'&&req.method==='POST'){
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1024*1024)throw new Error('RPC request too large');}
      const request=JSON.parse(raw);const response=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(request.id);reject(new Error('RPC timeout'));},120000);pending.set(request.id,msg=>{clearTimeout(timer);resolve(msg);});send(request);});
      const body=JSON.stringify(response);res.writeHead(200,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)});res.end(body);return;
    }
    let url=req.url.split('?')[0];if(url==='/'||url===`/${app}/`)url=`/${app}/index.html`;
    const normalized=path.normalize(decodeURIComponent(url)).replace(/^(\.\.[/\\])+/, '');
    const file=path.join(root,'dist','app',normalized);
    const appRoot=path.join(root,'dist','app');if(!file.startsWith(appRoot))throw new Error('Invalid path');
    let data=await fs.promises.readFile(file);
    if(file.endsWith('index.html'))data=Buffer.from(data.toString('utf8').replace('<script src="../shared/arcane-api.js"></script>','<script>window.__ARCANE_DEV_HTTP__=true;</script><script src="../shared/arcane-api.js"></script>'));
    res.writeHead(200,{'Content-Type':mime(file),'Content-Length':data.length,'Cache-Control':'no-store'});res.end(data);
  }catch(error){const body=JSON.stringify({error:{code:'DEV_HOST_ERROR',message:error.message}});res.writeHead(500,{'Content-Type':'application/json'});res.end(body);}
});
server.listen(0,'127.0.0.1',()=>{const address=server.address();const url=`http://127.0.0.1:${address.port}/${app}/index.html`;console.log(`Arcane development host: ${url}`);if(!noOpen){if(process.platform==='win32')spawn('cmd.exe',['/c','start','',url],{detached:true,stdio:'ignore'}).unref();else spawn('xdg-open',[url],{detached:true,stdio:'ignore'}).unref();}});
process.on('SIGINT',()=>{server.close();core.kill();process.exit(0);});
