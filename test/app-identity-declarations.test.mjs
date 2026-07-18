import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import test from 'node:test';

const appsRoot=new URL('../apps/',import.meta.url);

test('every packaged app page declares the stable id from its package manifest',async()=>{
    const directories=(await readdir(appsRoot,{withFileTypes:true}))
        .filter(entry=>entry.isDirectory())
        .sort((left,right)=>left.name.localeCompare(right.name));
    let checkedPages=0;

    for(const directory of directories){
        const appRoot=new URL(`${directory.name}/`,appsRoot);
        let manifest;
        try{
            manifest=JSON.parse(await readFile(new URL('arcane-package.json',appRoot),'utf8'));
        }catch(error){
            if(error?.code==='ENOENT')continue;
            throw error;
        }
        const pages=(await readdir(appRoot,{withFileTypes:true}))
            .filter(entry=>entry.isFile()&&entry.name.endsWith('.html'))
            .sort((left,right)=>left.name.localeCompare(right.name));
        assert(pages.length>0,`${manifest.id} must package at least one top-level HTML page`);

        for(const page of pages){
            const html=await readFile(new URL(page.name,appRoot),'utf8');
            const declarations=[...html.matchAll(/<meta\s+name=["']arcane-app-id["']\s+content=["']([^"']+)["']\s*\/?>/gi)];
            assert.equal(declarations.length,1,`${manifest.id}/${page.name} must declare one arcane-app-id`);
            assert.equal(declarations[0][1],manifest.id,`${manifest.id}/${page.name} must match its package id`);
            checkedPages++;
        }
    }

    assert(checkedPages>0,'expected packaged app pages to be checked');
});
