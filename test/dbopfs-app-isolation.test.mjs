import assert from 'node:assert/strict';
import test from 'node:test';

const encoder=new TextEncoder();
const decoder=new TextDecoder();

function notFound(){
    const error=new Error('Not found');
    error.name='NotFoundError';
    return error;
}

async function bytesFrom(value){
    if(value instanceof Blob)return new Uint8Array(await value.arrayBuffer());
    if(value instanceof ArrayBuffer)return new Uint8Array(value);
    if(ArrayBuffer.isView(value)){
        return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
    }
    return encoder.encode(String(value));
}

function spliceBytes(current,addition,position){
    const length=Math.max(current.byteLength,position+addition.byteLength);
    const next=new Uint8Array(length);
    next.set(current);
    next.set(addition,position);
    return next;
}

class MemoryFileEntry{
    constructor(source=''){
        this.bytes=encoder.encode(source);
    }
}

class MemoryFileHandle{
    constructor(files,name){
        this.kind='file';
        this.name=name;
        this.files=files;
    }

    get entry(){
        return this.files.get(this.name);
    }

    async getFile(){
        if(!this.entry)throw notFound();
        return new Blob([this.entry.bytes],{type:'application/octet-stream'});
    }

    async createWritable({keepExistingData=false}={}){
        if(!this.entry)throw notFound();
        let staged=keepExistingData?this.entry.bytes.slice():new Uint8Array();
        let position=0;

        return {
            seek:async offset=>{position=offset},
            write:async value=>{
                const addition=await bytesFrom(value);
                staged=spliceBytes(staged,addition,position);
                position+=addition.byteLength;
            },
            close:async()=>{this.entry.bytes=staged},
            abort:async()=>{}
        };
    }

    async createSyncAccessHandle(){
        if(!this.entry)throw notFound();
        const entry=this.entry;
        return {
            getSize:()=>entry.bytes.byteLength,
            truncate:length=>{entry.bytes=entry.bytes.slice(0,length)},
            read:(destination,{at=0}={})=>{
                const source=entry.bytes.subarray(at,at+destination.byteLength);
                destination.set(source);
                return source.byteLength;
            },
            write:(source,{at=0}={})=>{
                const addition=new Uint8Array(source.buffer,source.byteOffset,source.byteLength);
                entry.bytes=spliceBytes(entry.bytes,addition,at);
                return addition.byteLength;
            },
            flush:()=>{},
            close:()=>{}
        };
    }
}

class MemoryDirectory{
    constructor(name=''){
        this.kind='directory';
        this.name=name;
        this.directories=new Map();
        this.files=new Map();
    }

    async getDirectoryHandle(name,{create=false}={}){
        if(!this.directories.has(name)){
            if(!create)throw notFound();
            this.directories.set(name,new MemoryDirectory(name));
        }
        return this.directories.get(name);
    }

    async getFileHandle(name,{create=false}={}){
        if(!this.files.has(name)){
            if(!create)throw notFound();
            this.files.set(name,new MemoryFileEntry());
        }
        return new MemoryFileHandle(this.files,name);
    }

    async removeEntry(name,{recursive=false}={}){
        if(this.files.delete(name))return;
        const directory=this.directories.get(name);
        if(!directory)throw notFound();
        if(!recursive&&(directory.files.size||directory.directories.size)){
            throw new Error('Directory is not empty');
        }
        this.directories.delete(name);
    }

    async *entries(){
        for(const [name,directory]of this.directories)yield [name,directory];
        for(const name of this.files.keys())yield [name,new MemoryFileHandle(this.files,name)];
    }
}

function memoryStorage(){
    const root=new MemoryDirectory('root');
    return {
        root,
        getDirectory:async()=>root,
        persist:async()=>true
    };
}

function installGlobals(values){
    const descriptors=new Map();
    for(const [name,value]of Object.entries(values)){
        descriptors.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
        Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
    }
    return ()=>{
        for(const [name,descriptor]of descriptors){
            if(descriptor)Object.defineProperty(globalThis,name,descriptor);
            else delete globalThis[name];
        }
    };
}

test('DBOPFS isolates identical table keys and clears only the owning app',async()=>{
    const storage=memoryStorage();
    storage.root.files.set('origin-sentinel.txt',new MemoryFileEntry('keep'));
    const windowObject={
        dbopfs:{get(){}},
        dispatchEvent(){}
    };
    class TestCustomEvent{
        constructor(type,options={}){
            this.type=type;
            this.detail=options.detail;
        }
    }
    const restore=installGlobals({
        navigator:{storage},
        window:windowObject,
        document:{querySelector:()=>null,documentElement:{dataset:{}}},
        CustomEvent:TestCustomEvent,
        Arcane:undefined
    });

    try{
        const moduleUrl=new URL('../arcane/modules/DBOPFS.js',import.meta.url);
        moduleUrl.searchParams.set('isolation-test',String(Date.now()));
        const {default:DBOPFS}=await import(moduleUrl.href);
        windowObject.dbopfs=null;

        const alpha=new DBOPFS({applicationId:'alpha',storage});
        const beta=new DBOPFS({applicationId:'beta',storage});
        await Promise.all([alpha.readyPromise,beta.readyPromise]);

        assert.equal(alpha.applicationId,'alpha');
        assert.equal(alpha.storagePath,'apps/alpha');
        assert.equal(beta.applicationId,'beta');
        assert.equal(beta.storagePath,'apps/beta');

        await alpha.set('notes','shared.json',{owner:'alpha'});
        assert.equal(await beta.get('notes','shared.json',true),null);

        await beta.set('notes','shared.json',{owner:'beta'});
        assert.deepEqual(await alpha.get('notes','shared.json',true),{owner:'alpha'});
        assert.deepEqual(await beta.get('notes','shared.json',true),{owner:'beta'});

        await alpha.clearAllStorage();

        assert.equal(await alpha.get('notes','shared.json',true),null);
        assert.deepEqual(await beta.get('notes','shared.json',true),{owner:'beta'});
        assert.equal(
            decoder.decode(storage.root.files.get('origin-sentinel.txt').bytes),
            'keep'
        );
        const applications=storage.root.directories.get('apps');
        assert.deepEqual([...applications.directories.keys()].sort(),['alpha','beta']);
    }finally{
        restore();
    }
});

test('DBOPFS worker executes file access beneath the supplied app scope',async()=>{
    const storage=memoryStorage();
    let messageHandler=null;
    const restore=installGlobals({
        navigator:{storage},
        self:{
            addEventListener(type,handler){
                if(type==='message')messageHandler=handler;
            }
        }
    });

    function messagePort(){
        return {
            response:null,
            closed:false,
            postMessage(value){this.response=value},
            close(){this.closed=true}
        };
    }

    try{
        const workerUrl=new URL('../arcane/modules/DBOPFSWorker.js',import.meta.url);
        workerUrl.searchParams.set('scope-test',String(Date.now()));
        await import(workerUrl.href);
        assert.equal(typeof messageHandler,'function');

        const alphaPort=messagePort();
        await messageHandler({
            data:{
                operation:'write',
                applicationId:'alpha',
                directoryName:'notes',
                fileName:'shared.json',
                fileData:encoder.encode('{"owner":"alpha"}').buffer,
                append:false
            },
            ports:[alphaPort]
        });
        assert.deepEqual(alphaPort.response,{success:true});
        assert.equal(alphaPort.closed,true);

        const betaPort=messagePort();
        await messageHandler({
            data:{
                operation:'write',
                applicationId:'beta',
                directoryName:'notes',
                fileName:'shared.json',
                fileData:encoder.encode('{"owner":"beta"}').buffer,
                append:false
            },
            ports:[betaPort]
        });
        assert.deepEqual(betaPort.response,{success:true});

        const applications=storage.root.directories.get('apps');
        const alphaEntry=applications.directories.get('alpha')
            .directories.get('notes').files.get('shared.json');
        const betaEntry=applications.directories.get('beta')
            .directories.get('notes').files.get('shared.json');
        assert.equal(decoder.decode(alphaEntry.bytes),'{"owner":"alpha"}');
        assert.equal(decoder.decode(betaEntry.bytes),'{"owner":"beta"}');

        const unsafePort=messagePort();
        await messageHandler({
            data:{
                operation:'write',
                applicationId:'../alpha',
                directoryName:'notes',
                fileName:'escape.json',
                fileData:new ArrayBuffer(0)
            },
            ports:[unsafePort]
        });
        assert.equal(unsafePort.response.error.name,'SecurityError');
        assert.equal(applications.directories.has('../alpha'),false);
    }finally{
        restore();
    }
});
