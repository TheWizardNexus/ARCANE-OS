import assert from 'node:assert/strict';
import test from 'node:test';

import {
    canonicalApplicationId,
    declaredApplicationId,
    openApplicationDataDirectory,
    resolveApplicationId
} from '../arcane/modules/AppDataScope.js';

function notFound(){
    const error=new Error('Not found');
    error.name='NotFoundError';
    return error;
}

class MemoryDirectory{
    constructor(name=''){
        this.kind='directory';
        this.name=name;
        this.directories=new Map();
    }

    async getDirectoryHandle(name,{create=false}={}){
        if(!this.directories.has(name)){
            if(!create)throw notFound();
            this.directories.set(name,new MemoryDirectory(name));
        }
        return this.directories.get(name);
    }
}

function documentIdentity(metaId=null,rootId=null){
    return {
        querySelector(selector){
            if(selector!=='meta[name="arcane-app-id"]'||metaId===null)return null;
            return {getAttribute:name=>name==='content'?metaId:null};
        },
        documentElement:{dataset:{arcaneAppId:rootId}}
    };
}

test('canonical application ids reject traversal and non-canonical segments',()=>{
    assert.equal(canonicalApplicationId('alpha'),'alpha');
    assert.equal(canonicalApplicationId('alpha-2'),'alpha-2');

    for(const unsafe of [
        '',
        '.',
        '..',
        '../alpha',
        'alpha/records',
        'alpha\\records',
        'Alpha',
        'alpha--beta',
        '2alpha',
        `a${'b'.repeat(64)}`
    ]){
        assert.throws(
            ()=>canonicalApplicationId(unsafe),
            error=>error?.code==='APP_DATA_SCOPE_INVALID',
            `expected ${JSON.stringify(unsafe)} to be rejected`
        );
    }
});

test('document identity declarations agree or fail closed',()=>{
    assert.equal(declaredApplicationId(documentIdentity('alpha',null)),'alpha');
    assert.equal(declaredApplicationId(documentIdentity(null,'beta')),'beta');
    assert.equal(declaredApplicationId(documentIdentity('alpha','alpha')),'alpha');
    assert.throws(
        ()=>declaredApplicationId(documentIdentity('alpha','beta')),
        error=>error?.code==='APP_DATA_SCOPE_MISMATCH'
    );
});

test('the native-bound application id is authoritative',async()=>{
    const nativeAlpha={app:{current:async()=>({id:'alpha'})}};

    assert.equal(await resolveApplicationId({applicationId:'alpha',documentObject:null,arcane:nativeAlpha}),'alpha');
    await assert.rejects(
        resolveApplicationId({applicationId:'beta',documentObject:null,arcane:nativeAlpha}),
        error=>error?.code==='APP_DATA_SCOPE_MISMATCH'
    );
    await assert.rejects(
        resolveApplicationId({documentObject:null,arcane:null}),
        error=>error?.code==='APP_DATA_SCOPE_REQUIRED'
    );
});

test('application data directories are nested beneath separate app folders',async()=>{
    const root=new MemoryDirectory('root');
    const storage={getDirectory:async()=>root};
    const alpha=await openApplicationDataDirectory({
        storage,
        applicationId:'alpha',
        documentObject:null,
        arcane:null
    });
    const beta=await openApplicationDataDirectory({
        storage,
        applicationId:'beta',
        documentObject:null,
        arcane:null
    });

    assert.equal(alpha.path,'apps/alpha');
    assert.equal(beta.path,'apps/beta');
    assert.notEqual(alpha.directory,beta.directory);
    assert.deepEqual([...root.directories.keys()],['apps']);
    assert.deepEqual(
        [...root.directories.get('apps').directories.keys()].sort(),
        ['alpha','beta']
    );
});
