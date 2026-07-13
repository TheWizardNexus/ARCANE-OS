import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import TerminalSession from '../arcane/entities/TerminalSession.js';
import {parseAnsi,stripAnsi} from '../arcane/modules/AnsiText.js';
import TerminalCommandRegistry,{splitCommandLine} from '../arcane/modules/TerminalCommandRegistry.js';
import SystemToolRegistry from '../arcane/modules/SystemToolRegistry.js';
import createArcaneSystemTools from '../apps/terminal/modules/ArcaneSystemTools.js';
import createArcaneTerminalCommands from '../apps/terminal/modules/ArcaneTerminalCommands.js';

test('terminal sessions validate reusable native session values',()=>{
    const session=new TerminalSession({id:'term-123',shell:'powershell',cwd:'C:\\work',state:'running'});
    assert.equal(session.shellLabel(),'PowerShell');assert.equal(session.with({state:'exited'}).state,'exited');
    assert.throws(()=>new TerminalSession({id:'../escape'}),/session IDs/);assert.throws(()=>new TerminalSession({id:'okay',shell:'arbitrary.exe'}),/Unsupported terminal shell/);
});

test('ANSI parsing preserves text while recognizing safe display state',()=>{
    const source='plain \u001b[1;31merror\u001b[0m done';const tokens=parseAnsi(source);
    assert.equal(tokens.map(token=>token.text).join(''),'plain error done');assert.equal(tokens.find(token=>token.text==='error').style.foreground,'red');assert.equal(stripAnsi(source),'plain error done');
});

test('command registry handles quoting, aliases, completion, and app context',async()=>{
    assert.deepEqual(splitCommandLine('tool app-package "my app"'),['tool','app-package','my app']);
    const registry=new TerminalCommandRegistry([{name:'hello',aliases:['hi'],run:({args})=>args.join(' ')}]);
    assert.deepEqual(registry.completions('he'),['hello']);assert.equal((await registry.execute('hi Arcane')).value,'Arcane');assert.equal((await registry.execute('unknown')).handled,false);
});

test('system tools are named, discoverable, and reject command injection as app ids',()=>{
    const tools=createArcaneSystemTools();assert(tools instanceof SystemToolRegistry);assert(tools.list().some(tool=>tool.id==='app-package'));
    assert.equal(tools.build('app-package',['terminal']),'npm run app:package -- terminal');
    assert.equal(tools.build('native-app-build',['terminal','portable']),'npm --prefix machine_bundles/arcane-os-machine-bundle-v0.8.4 run build:app -- --app=terminal --platform=portable');
    assert.equal(tools.build('native-app-build',['terminal','nt']),'npm --prefix machine_bundles/arcane-os-machine-bundle-v0.8.4 run build:app -- --app=terminal --platform=windows');
    assert.throws(()=>tools.build('app-package',['terminal; rm']),/Usage/);
});

test('Arcane Terminal routes registered build tools through the active native shell',async()=>{
    let executed='';const commands=createArcaneTerminalCommands({arcane:null});const result=await commands.execute('app package terminal',{executeShell:command=>{executed=command;}});
    assert.equal(result.handled,true);assert.equal(executed,'npm run app:package -- terminal');assert.match(result.value,/npm run app:package/);
});

test('shared terminal sources remain domain-neutral and app-specific tools remain app-local',async()=>{
    const [component,client,app]=await Promise.all([readFile(new URL('../arcane/components/terminal-workspace.html',import.meta.url),'utf8'),readFile(new URL('../arcane/modules/TerminalClient.js',import.meta.url),'utf8'),readFile(new URL('../apps/terminal/modules/ArcaneSystemTools.js',import.meta.url),'utf8')]);
    assert.match(component,/terminal-submit/);assert.match(component,/terminal-session-new/);assert.doesNotMatch(component,/npm run|app:package|ArcaneTerminalCommands/);assert.doesNotMatch(client,/npm run|app:package/);assert.match(app,/app:package/);
});
