import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const bundle=path.join(root,'machine_bundles','arcane-os-machine-bundle-v0.8.4');
const [commandReference,apiReference,apiSource,rootManifest,bundleManifest]=await Promise.all([
    fs.readFile(path.join(root,'docs','developer-commands.md'),'utf8'),
    fs.readFile(path.join(root,'docs','arcane-api.md'),'utf8'),
    fs.readFile(path.join(bundle,'src','frontend','shared','arcane-api.js'),'utf8'),
    fs.readFile(path.join(root,'package.json'),'utf8').then(JSON.parse),
    fs.readFile(path.join(bundle,'package.json'),'utf8').then(JSON.parse),
]);

function collectMethods(value,prefix='Arcane',methods=[]){
    for(const key of Object.keys(value)){
        const member=value[key];
        const memberPath=`${prefix}.${key}`;
        if(typeof member==='function'){
            if(memberPath!=='Arcane.Error') methods.push(memberPath);
        }else if(member&&typeof member==='object') collectMethods(member,memberPath,methods);
    }
    return methods;
}

test('developer command reference covers every declared npm command',()=>{
    for(const name of Object.keys(rootManifest.scripts)){
        assert.ok(commandReference.includes(`npm run ${name}`),`root command is undocumented: npm run ${name}`);
    }
    for(const name of Object.keys(bundleManifest.scripts)){
        const exact=commandReference.includes(`\`${name}\``);
        const withArguments=commandReference.includes(`\`${name} `);
        const rootForm=commandReference.includes(`npm run ${name}`);
        assert.ok(exact||withArguments||rootForm,`machine-bundle command is undocumented: ${name}`);
    }
});

test('Arcane API reference covers the complete application-facing bridge',()=>{
    const window={crypto:{randomUUID:()=> 'reference-test-id'}};
    vm.runInNewContext(apiSource,{window,console,setTimeout,clearTimeout,EventSource:undefined,fetch:undefined});
    const methods=collectMethods(window.Arcane);
    assert.ok(methods.length>50,'expected the complete Arcane API surface');
    for(const method of methods){
        assert.ok(apiReference.includes(`\`${method}(`),`Arcane method is undocumented: ${method}`);
    }
    assert.match(apiReference,/WebView2/);
    assert.match(apiReference,/WebKitGTK/);
    assert.match(apiReference,/application-facing/);
});
