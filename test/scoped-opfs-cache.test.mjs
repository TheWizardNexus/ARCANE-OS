import assert from 'node:assert/strict';
import test from 'node:test';

import ScopedOPFSCache from '../arcane/modules/ScopedOPFSCache.js';

function notFound(){
    const error=new Error('Not found');
    error.name='NotFoundError';
    return error;
}

class MemoryFileHandle{
    constructor(files,name){
        this.files=files;
        this.name=name;
    }

    async getFile(){
        if(!this.files.has(this.name))throw notFound();
        const source=this.files.get(this.name);
        return {size:new TextEncoder().encode(source).byteLength,text:async()=>source};
    }

    async createWritable(){
        let staged='';
        return {
            write:async value=>{staged=String(value)},
            close:async()=>{this.files.set(this.name,staged)},
            abort:async()=>{}
        };
    }
}

class MemoryDirectory{
    constructor(){
        this.directories=new Map();
        this.files=new Map();
    }

    async getDirectoryHandle(name,{create=false}={}){
        if(!this.directories.has(name)){
            if(!create)throw notFound();
            this.directories.set(name,new MemoryDirectory());
        }
        return this.directories.get(name);
    }

    async getFileHandle(name,{create=false}={}){
        if(!this.files.has(name)&&!create)throw notFound();
        return new MemoryFileHandle(this.files,name);
    }

    async removeEntry(name){
        if(!this.files.delete(name))throw notFound();
    }
}

function memoryStorage(){
    const root=new MemoryDirectory();
    return {root,getDirectory:async()=>root};
}

test('ScopedOPFSCache round trips JSON inside only its namespace',async()=>{
    const storage=memoryStorage();
    const cache=new ScopedOPFSCache({applicationId:'docs',namespace:'arcane-docs-cache-v1',storage});
    const value={schemaVersion:1,text:'Arcane'};

    await cache.set('document-key',value);

    assert.deepEqual(await cache.get('document-key'),value);
    assert.equal(storage.root.files.size,0);
    assert.equal(storage.root.directories.size,1);
    assert(storage.root.directories.get('apps').directories.get('docs').directories.has('arcane-docs-cache-v1'));
    assert.equal(await cache.delete('document-key'),true);
    assert.equal(await cache.get('document-key'),undefined);
    assert.equal(await cache.delete('document-key'),false);
});

test('ScopedOPFSCache nests the same namespace and key beneath each application',async()=>{
    const storage=memoryStorage();
    const alpha=new ScopedOPFSCache({applicationId:'alpha',namespace:'shared-cache',storage});
    const beta=new ScopedOPFSCache({applicationId:'beta',namespace:'shared-cache',storage});

    await alpha.set('shared-key',{owner:'alpha'});
    assert.equal(await beta.get('shared-key'),undefined);
    await beta.set('shared-key',{owner:'beta'});

    assert.deepEqual(await alpha.get('shared-key'),{owner:'alpha'});
    assert.deepEqual(await beta.get('shared-key'),{owner:'beta'});
    const applications=storage.root.directories.get('apps');
    assert.deepEqual([...applications.directories.keys()].sort(),['alpha','beta']);
    assert(
        applications.directories.get('alpha').directories.has('shared-cache')
    );
    assert(
        applications.directories.get('beta').directories.has('shared-cache')
    );
});

test('ScopedOPFSCache rejects unsafe namespaces and keys',async()=>{
    const storage=memoryStorage();
    assert.throws(()=>new ScopedOPFSCache({applicationId:'docs',namespace:'../other',storage}),/filename-safe/);
    const cache=new ScopedOPFSCache({applicationId:'docs',namespace:'safe',storage});
    await assert.rejects(cache.set('../other',{value:true}),/filename-safe/);
    await assert.rejects(cache.get('folder/key'),/filename-safe/);
});

test('ScopedOPFSCache removes corrupt and oversized entries without clearing neighbors',async()=>{
    const storage=memoryStorage();
    const applications=await storage.root.getDirectoryHandle('apps',{create:true});
    const application=await applications.getDirectoryHandle('docs',{create:true});
    const directory=await application.getDirectoryHandle('bounded',{create:true});
    directory.files.set('corrupt','{');
    directory.files.set('large',JSON.stringify({text:'x'.repeat(200)}));
    directory.files.set('neighbor',JSON.stringify({ok:true}));
    const cache=new ScopedOPFSCache({applicationId:'docs',namespace:'bounded',maxEntryBytes:64,storage});

    assert.equal(await cache.get('corrupt'),undefined);
    assert.equal(await cache.get('large'),undefined);
    assert.deepEqual(await cache.get('neighbor'),{ok:true});
    assert.equal(directory.files.has('corrupt'),false);
    assert.equal(directory.files.has('large'),false);
    assert.equal(directory.files.has('neighbor'),true);
    await assert.rejects(cache.set('too-large',{text:'x'.repeat(200)}),error=>error.code==='OPFS_CACHE_ENTRY_TOO_LARGE');
});
