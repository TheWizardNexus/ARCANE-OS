import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import StaticDocumentCatalog,{
    normalizeStaticDocumentCatalog,
    staticDocumentCacheKey,
} from '../arcane/modules/StaticDocumentCatalog.js';

const BASE_URL='https://example.test/project/';

function digest(value){
    return createHash('sha256').update(value).digest('hex');
}

function documentRecord({
    content='# Synthetic\n',
    id='synthetic',
    path=`documents/${id}.md`,
    ...overrides
}={}){
    const bytes=Buffer.from(content,'utf8');
    return {
        id,
        path,
        kind:'guide',
        title:'Synthetic guide',
        summary:'A bounded synthetic document.',
        tags:['sample'],
        byteSize:bytes.byteLength,
        sha256:digest(bytes),
        headings:[{id:'synthetic',level:1,text:'Synthetic'}],
        examples:[],
        screenshots:[],
        ...overrides,
    };
}

function manifest(documents,version='catalog-v1'){
    return {version,documents};
}

function options(overrides={}){
    return {
        baseURL:BASE_URL,
        digest:bytes=>digest(bytes),
        fetchImpl:async()=>{throw new Error('Unexpected fetch.');},
        ...overrides,
    };
}

test('static catalog validates and freezes a canonical positive inventory',()=>{
    const catalog=new StaticDocumentCatalog(manifest([
        documentRecord({id:'zeta',path:'documents/zeta.md',title:'Zeta'}),
        documentRecord({id:'alpha',path:'documents/alpha.md',title:'Alpha'}),
    ]),options());

    assert.equal(catalog.version,'catalog-v1');
    assert.equal(catalog.size,2);
    assert.deepEqual(catalog.list().map(record=>record.id),['alpha','zeta']);
    assert.equal(catalog.get('missing'),null);
    assert(Object.isFrozen(catalog.list()));
    assert(Object.isFrozen(catalog.list()[0]));
    assert(Object.isFrozen(catalog.list()[0].headings));
    assert.throws(()=>catalog.get('../alpha'),error=>error?.code==='STATIC_DOCUMENT_INVALID_ID');

    const normalized=normalizeStaticDocumentCatalog(manifest([
        documentRecord({kind:'GUIDE'}),
    ]));
    assert.equal(normalized.documents[0].kind,'guide');
    assert.throws(
        ()=>normalizeStaticDocumentCatalog(manifest([]),{maxRecords:0}),
        error=>error?.code==='STATIC_DOCUMENT_INVALID_LIMIT',
    );
    assert.throws(
        ()=>normalizeStaticDocumentCatalog(manifest([]),{unknown:true}),
        /unsupported field: unknown/,
    );
    assert.equal(
        staticDocumentCacheKey('catalog-v1','aurora','0'.repeat(64)),
        'static-document-catalog-v1--c5b05b491c64a062--0000000000000000000000000000000000000000000000000000000000000000',
    );
});

test('static catalog rejects hostile paths, unknown fields, and case collisions',()=>{
    for(const path of [
        '../private.md',
        '/root.md',
        'https://evil.test/file.md',
        'docs\\file.md',
        'docs//file.md',
        'docs%2Ffile.md',
        'docs/%2e%2e/private.md',
        'docs/file.md?raw=1',
        'docs/file.md#section',
        ' docs/file.md',
    ]){
        assert.throws(
            ()=>new StaticDocumentCatalog(manifest([documentRecord({path})])),
            error=>error?.code==='STATIC_DOCUMENT_UNSAFE_PATH',
            path,
        );
    }

    assert.throws(
        ()=>new StaticDocumentCatalog(manifest([{...documentRecord(),private:true}])),
        /unsupported field: private/,
    );
    assert.throws(
        ()=>new StaticDocumentCatalog(manifest([
            documentRecord({id:'Alpha',path:'documents/one.md'}),
            documentRecord({id:'alpha',path:'documents/two.md'}),
        ])),
        error=>error?.code==='STATIC_DOCUMENT_CASE_COLLISION',
    );
    assert.throws(
        ()=>new StaticDocumentCatalog(manifest([
            documentRecord({id:'one',path:'Documents/Guide.md'}),
            documentRecord({id:'two',path:'documents/guide.md'}),
        ])),
        error=>error?.code==='STATIC_DOCUMENT_CASE_COLLISION',
    );
    assert.throws(
        ()=>new StaticDocumentCatalog(manifest([
            documentRecord({tags:['Sample','sample']}),
        ])),
        /duplicate value/,
    );
    assert.throws(
        ()=>new StaticDocumentCatalog(manifest([
            documentRecord({byteSize:11}),
        ]),{maxDocumentBytes:10}),
        error=>error?.code==='STATIC_DOCUMENT_INVALID_LIMIT',
    );
});

test('static catalog search is weighted, filtered, bounded, and deterministic',()=>{
    const records=[
        documentRecord({
            id:'title-match',
            path:'guides/title.md',
            title:'Setup Guide',
            summary:'Primary instructions.',
            tags:['onboarding'],
        }),
        documentRecord({
            id:'tag-match',
            path:'guides/tag.md',
            title:'Reference',
            summary:'Secondary instructions.',
            tags:['setup guide','advanced'],
        }),
        documentRecord({
            id:'tie-b',
            path:'guides/tie-b.md',
            title:'Equal result',
            summary:'shared-token',
            tags:['reference'],
        }),
        documentRecord({
            id:'tie-a',
            path:'guides/tie-a.md',
            title:'Equal result',
            summary:'shared-token',
            tags:['reference'],
        }),
    ];
    const catalog=new StaticDocumentCatalog(manifest(records),options({maxResults:10}));

    const setup=catalog.search('setup guide',{limit:2});
    assert.deepEqual(setup.map(result=>result.id),['title-match','tag-match']);
    assert(setup[0].score>setup[1].score);
    assert.deepEqual(setup[0].matchedFields,['title','path']);
    assert(Object.isFrozen(setup));
    assert(Object.isFrozen(setup[0]));

    assert.deepEqual(
        catalog.search('shared-token').map(result=>result.id),
        ['tie-a','tie-b'],
    );
    assert.deepEqual(
        catalog.search('',{kinds:['guide'],tags:['advanced'],limit:1}).map(result=>result.id),
        ['tag-match'],
    );
    assert.throws(()=>catalog.search('x',{limit:11}),error=>error?.code==='STATIC_DOCUMENT_INVALID_LIMIT');
    assert.throws(()=>catalog.search('../\u0000'),error=>error?.code==='STATIC_DOCUMENT_INVALID_QUERY');
});

test('static catalog hydrates same-directory UTF-8, verifies bytes and hash, and reuses versioned cache',async()=>{
    const content='# Aurora\n\nVerified synthetic content.\n';
    const record=documentRecord({content,id:'aurora',path:'content/aurora.md',title:'Aurora'});
    const entries=new Map();
    const writes=[];
    const cache={
        get:key=>entries.get(key),
        set:(key,value)=>{writes.push([key,value]);entries.set(key,value);},
        delete:key=>entries.delete(key),
    };
    const calls=[];
    const catalog=new StaticDocumentCatalog(manifest([record]),options({
        cache,
        fetchImpl:async(url,request)=>{
            calls.push([url,request]);
            return new Response(content,{headers:{'content-type':'text/markdown; charset=utf-8'}});
        },
    }));

    const hydrated=await catalog.hydrate('aurora');
    assert.equal(hydrated.text,content);
    assert.equal(hydrated.source,'network');
    assert.equal(hydrated.url,'https://example.test/project/content/aurora.md');
    assert.equal(calls.length,1);
    assert.equal(calls[0][1].method,'GET');
    assert.equal(calls[0][1].redirect,'error');

    const expectedKey=staticDocumentCacheKey('catalog-v1','aurora',record.sha256);
    assert(expectedKey.length<128);
    assert.notEqual(
        expectedKey,
        staticDocumentCacheKey('catalog-v2','aurora',record.sha256),
    );
    assert.equal(writes[0][0],expectedKey);
    assert.deepEqual(writes[0][1],{
        schemaVersion:1,
        catalogVersion:'catalog-v1',
        documentId:'aurora',
        sha256:record.sha256,
        byteSize:record.byteSize,
        text:content,
    });

    const cached=await catalog.hydrate('aurora');
    assert.equal(cached.source,'cache');
    assert.equal(cached.text,content);
    assert.equal(calls.length,1);
    assert(Object.isFrozen(cached));

    const controller=new AbortController();
    controller.abort();
    await assert.rejects(
        catalog.hydrate('aurora',{signal:controller.signal}),
        error=>error?.code==='STATIC_DOCUMENT_ABORTED',
    );
});

test('static catalog ignores malformed cache entries and reports cache failures without losing verified content',async()=>{
    const content='Verified cache replacement.\n';
    const record=documentRecord({content,id:'cache-record'});
    const key=staticDocumentCacheKey('catalog-v1',record.id,record.sha256);
    const entries=new Map([[key,{
        schemaVersion:1,
        catalogVersion:'stale-version',
        documentId:record.id,
        sha256:record.sha256,
        byteSize:record.byteSize,
        text:content,
    }]]);
    const diagnostics=[];
    const deleted=[];
    const catalog=new StaticDocumentCatalog(manifest([record]),options({
        cache:{
            get:cacheKey=>entries.get(cacheKey),
            set:()=>{throw new Error('storage unavailable');},
            delete:cacheKey=>{deleted.push(cacheKey);entries.delete(cacheKey);},
        },
        fetchImpl:async()=>content,
        onCacheError:(error,context)=>diagnostics.push([error.code??error.message,context.operation]),
    }));

    const hydrated=await catalog.hydrate(record.id);
    assert.equal(hydrated.source,'network');
    assert.deepEqual(deleted,[key]);
    assert.deepEqual(diagnostics.map(item=>item[1]),['get','set']);
});

test('static catalog bounds an unavailable cache before using verified network content',async()=>{
    const content='Cache timeout fallback.\n';
    const record=documentRecord({content,id:'cache-timeout'});
    const diagnostics=[];
    const catalog=new StaticDocumentCatalog(manifest([record]),options({
        cacheTimeoutMs:10,
        cache:{
            get:()=>new Promise(()=>{}),
            set:()=>undefined,
        },
        fetchImpl:async()=>content,
        onCacheError:error=>diagnostics.push(error.code),
    }));

    const hydrated=await catalog.hydrate(record.id);
    assert.equal(hydrated.source,'network');
    assert.deepEqual(diagnostics,['STATIC_DOCUMENT_TIMEOUT']);
});

test('static catalog rejects oversized, mismatched, non-text, and redirected hydration',async()=>{
    const content='expected';
    const valid=documentRecord({content});

    const wrongHash=new StaticDocumentCatalog(manifest([{...valid,sha256:'0'.repeat(64)}]),options({
        fetchImpl:async()=>content,
    }));
    await assert.rejects(wrongHash.hydrate(valid.id),error=>error?.code==='STATIC_DOCUMENT_HASH_MISMATCH');

    const oversized=new StaticDocumentCatalog(manifest([{...valid,byteSize:1}]),options({
        fetchImpl:async()=>content,
    }));
    await assert.rejects(oversized.hydrate(valid.id),error=>error?.code==='STATIC_DOCUMENT_LIMIT');

    const binary=new StaticDocumentCatalog(manifest([valid]),options({
        fetchImpl:async()=>new Response(content,{headers:{'content-type':'application/octet-stream'}}),
    }));
    await assert.rejects(binary.hydrate(valid.id),error=>error?.code==='STATIC_DOCUMENT_INVALID_RESPONSE');

    const redirected=new StaticDocumentCatalog(manifest([valid]),options({
        fetchImpl:async()=>({
            ok:true,
            status:200,
            url:'https://evil.test/expected.md',
            text:async()=>content,
        }),
    }));
    await assert.rejects(redirected.hydrate(valid.id),error=>error?.code==='STATIC_DOCUMENT_UNSAFE_REDIRECT');

    const malformedRedirect=new StaticDocumentCatalog(manifest([valid]),options({
        fetchImpl:async()=>({ok:true,status:200,url:'not an absolute URL',text:async()=>content}),
    }));
    await assert.rejects(malformedRedirect.hydrate(valid.id),error=>error?.code==='STATIC_DOCUMENT_INVALID_RESPONSE');

    const invalidBytes=Uint8Array.of(0xff);
    const invalidTextRecord=documentRecord({
        content:'x',
        id:'invalid-utf8',
        byteSize:invalidBytes.byteLength,
        sha256:digest(invalidBytes),
    });
    const invalidText=new StaticDocumentCatalog(manifest([invalidTextRecord]),options({
        fetchImpl:async()=>invalidBytes,
    }));
    await assert.rejects(invalidText.hydrate(invalidTextRecord.id),error=>error?.code==='STATIC_DOCUMENT_INVALID_TEXT');
});

test('static catalog enforces its hydration timeout and aborts the injected request signal',async()=>{
    const record=documentRecord();
    let requestSignal;
    const catalog=new StaticDocumentCatalog(manifest([record]),options({
        fetchTimeoutMs:100,
        fetchImpl:async(_url,request)=>{
            requestSignal=request.signal;
            return new Promise(()=>{});
        },
    }));

    await assert.rejects(catalog.hydrate(record.id),error=>error?.code==='STATIC_DOCUMENT_TIMEOUT');
    assert.equal(requestSignal.aborted,true);
});

test('static catalog uses Web Crypto SHA-256 when no digest callback is injected',async()=>{
    const content='Default browser digest.\n';
    const record=documentRecord({content,id:'default-digest'});
    const catalog=new StaticDocumentCatalog(manifest([record]),{
        baseURL:BASE_URL,
        fetchImpl:async()=>content,
    });

    const hydrated=await catalog.hydrate(record.id);
    assert.equal(hydrated.text,content);
});

test('static catalog builds deterministic bounded untrusted context and reports unverifiable matches',async()=>{
    const bodies=new Map([
        ['alpha','Alpha '.repeat(30)],
        ['beta','Beta '.repeat(30)],
        ['broken','mismatch'],
    ]);
    const records=[
        documentRecord({content:bodies.get('alpha'),id:'alpha',title:'Shared Alpha',summary:'shared query'}),
        documentRecord({content:bodies.get('beta'),id:'beta',title:'Shared Beta',summary:'shared query'}),
        documentRecord({content:'expected',id:'broken',title:'Shared Broken',summary:'shared query'}),
    ];
    const catalog=new StaticDocumentCatalog(manifest(records),options({
        maxContextCharacters:420,
        maxContextDocuments:3,
        maxDocumentContextCharacters:60,
        fetchImpl:async url=>bodies.get(url.match(/([^/]+)\.md$/)?.[1]),
    }));

    const context=await catalog.buildContext('shared query');
    assert(context.characters<=420);
    assert.match(context.text,/UNTRUSTED STATIC DOCUMENT CONTEXT/);
    assert.equal(context.documents.length,2);
    assert(context.documents.every(item=>item.characters<=60));
    assert.deepEqual(context.failures.map(item=>item.id),['broken']);
    assert.equal(context.failures[0].code,'STATIC_DOCUMENT_HASH_MISMATCH');
    assert.equal(context.truncated,true);
    assert(Object.isFrozen(context));
    assert(Object.isFrozen(context.documents));
});

test('static catalog can ground context from body-only terms with a relevant bounded excerpt',async()=>{
    const content=[
        'Unrelated introduction. '.repeat(80),
        'providerModels returns the configured provider model inventory.',
        'Unrelated middle. '.repeat(80),
        'restoreShell restores the previous Microsoft NT shell.',
        'Unrelated ending. '.repeat(80),
        'recentErrors returns recent diagnostic error records.'
    ].join('\n');
    const record=documentRecord({
        content,
        id:'api-reference',
        title:'API reference',
        summary:'Application-facing methods.',
        headings:[{id:'methods',level:1,text:'Methods'}],
        tags:['api'],
    });
    const catalog=new StaticDocumentCatalog(manifest([record]),options({
        maxContextCharacters:1200,
        maxDocumentContextCharacters:300,
        fetchImpl:async()=>content,
    }));

    assert.equal(catalog.search('providerModels').length,0);
    const context=await catalog.buildContext('providerModels',{
        bodySearch:true,
        maxCharacters:1200,
        maxDocumentCharacters:300,
        scanLimit:1,
    });
    assert.deepEqual(context.documents.map(item=>item.id),['api-reference']);
    assert.match(context.text,/providerModels returns the configured provider model inventory/);
    assert(context.documents[0].characters<=300);

    const restoreContext=await catalog.buildContext('What does restoreShell do?',{
        bodySearch:true,
        maxCharacters:1200,
        maxDocumentCharacters:300,
        scanLimit:1,
    });
    assert.deepEqual(restoreContext.documents.map(item=>item.id),['api-reference']);
    assert.match(restoreContext.text,/restoreShell restores the previous Microsoft NT shell/);

    const errorsContext=await catalog.buildContext('How do I use recentErrors?',{
        bodySearch:true,
        maxCharacters:1200,
        maxDocumentCharacters:300,
        scanLimit:1,
    });
    assert.deepEqual(errorsContext.documents.map(item=>item.id),['api-reference']);
    assert.match(errorsContext.text,/recentErrors returns recent diagnostic error records/);
});

test('static catalog search remains usable without browser networking and aborts hydration explicitly',async()=>{
    const record=documentRecord();
    const searchable=new StaticDocumentCatalog(manifest([record]),{fetchImpl:null});
    assert.equal(searchable.search('synthetic')[0].id,'synthetic');
    await assert.rejects(searchable.hydrate('synthetic'),error=>error?.code==='STATIC_DOCUMENT_BASE_URL_REQUIRED');

    const controller=new AbortController();
    controller.abort();
    const abortable=new StaticDocumentCatalog(manifest([record]),options({fetchImpl:async()=>record.content}));
    await assert.rejects(
        abortable.hydrate('synthetic',{signal:controller.signal}),
        error=>error?.code==='STATIC_DOCUMENT_ABORTED'&&error.name==='AbortError',
    );
});

test('shared static catalog source remains domain-neutral and has no storage global',async()=>{
    const source=await readFile(new URL('../arcane/modules/StaticDocumentCatalog.js',import.meta.url),'utf8');
    assert.doesNotMatch(source,/BOSS|Arcane Docs|GitHub Pages|OpenAI|DBOPFS/i);
    assert.doesNotMatch(source,/localStorage|indexedDB|navigator\.storage/i);
});
