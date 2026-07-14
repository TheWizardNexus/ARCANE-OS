import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';

import CaseRepository,{StreamingSHA256} from '../modules/CaseRepository.js';

class MemoryDBOPFS {
    ready=true;

    providerName='MemoryDBOPFS';

    tables=new Map();

    table(name){
        if(!this.tables.has(name)){
            this.tables.set(name,new Map());
        }

        return this.tables.get(name);
    }

    async set(tableName,fileName,value){
        let stored=value;

        if(typeof value==='string'&&fileName.toLowerCase().endsWith('.json')){
            stored=JSON.parse(value);
        }

        this.table(tableName).set(fileName,stored);
        return stored;
    }

    async get(tableName,fileName){
        return this.table(tableName).get(fileName)??null;
    }

    async getAll(tableName){
        return Object.fromEntries(this.table(tableName));
    }

    async writeFile(tableName,fileName,data,append=false){
        const incoming=data instanceof Blob
            ?data
            :new Blob([data]);
        const previous=this.table(tableName).get(fileName);
        const parts=append&&previous instanceof Blob
            ?[previous,incoming]
            :[incoming];
        const stored=new Blob(parts,{type:incoming.type||previous?.type||''});

        this.table(tableName).set(fileName,stored);
        return true;
    }

    async readFile(tableName,fileName){
        const stored=this.table(tableName).get(fileName);

        if(!(stored instanceof Blob)){
            const error=new Error(`No file exists at ${tableName}/${fileName}.`);
            error.name='NotFoundError';
            throw error;
        }

        return stored;
    }

    async delete(tableName,fileName){
        this.table(tableName).delete(fileName);
        return true;
    }

    has(tableName,fileName){
        return this.table(tableName).has(fileName);
    }
}

async function createFixture(){
    const database=new MemoryDBOPFS();
    const repository=new CaseRepository({database});
    const caseRecord=await repository.createCase({
        caseNumber:'24FL001068',
        matterType:'family',
        title:'Miller v. Miller'
    });

    return {caseRecord,database,repository};
}

test('creates, lists, and restores the active case',async()=>{
    const {caseRecord,repository}=await createFixture();

    assert.ok(caseRecord.id);
    assert.equal(repository.providerName,'MemoryDBOPFS');
    assert.deepEqual(
        (await repository.listCases()).map(record=>record.id),
        [caseRecord.id]
    );
    assert.equal((await repository.getActiveCase()).id,caseRecord.id);
    assert.equal(
        (await repository.getOrCreateActiveCase({caseNumber:'unused'})).id,
        caseRecord.id
    );
});

test('round-trips binary files and records SHA-256 when Web Crypto is available',async()=>{
    const {caseRecord,repository}=await createFixture();
    const bytes=Uint8Array.from([0,1,2,3,127,128,254,255]);
    const stored=await repository.putFile(
        caseRecord,
        {
            file:new Blob([bytes],{type:'application/pdf'}),
            path:'Filing by Filing/PDF/24-10-28 [COURT] - Test Filing.pdf',
            kind:'filing',
            originalName:'original.pdf',
            originalPath:'Filing by Filing/PDF/original.pdf'
        }
    );
    const restored=new Uint8Array(await (await repository.readFile(stored)).arrayBuffer());

    assert.deepEqual(restored,bytes);
    assert.equal(stored.mimeType,'application/pdf');
    assert.equal(stored.size,bytes.byteLength);
    assert.equal(stored.originalName,'original.pdf');

    assert.equal(stored.hash.status,'complete');
    assert.equal(
        stored.hash.value,
        createHash('sha256').update(bytes).digest('hex')
    );
});

test('streaming SHA-256 matches Node across arbitrary chunk boundaries',()=>{
    const chunks=[
        new TextEncoder().encode('The quick '),
        new TextEncoder().encode('brown fox jumps over '),
        new TextEncoder().encode('the lazy dog')
    ];
    const hasher=new StreamingSHA256();
    chunks.forEach(chunk=>hasher.update(chunk));
    const expected=createHash('sha256').update(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)))).digest('hex');

    assert.equal(hasher.hex(),expected);
    assert.equal(hasher.hex(),expected);
});

test('legal retrieval excludes work product and reports ranked coverage',async()=>{
    const {caseRecord,repository}=await createFixture();
    for(let index=0;index<10;index++){
        await repository.putGeneratedMarkdown(
            caseRecord,
            `Filing by Filing/MD/24-11-${String(index+1).padStart(2,'0')} [COURT] - Filing ${index}.md`,
            index===7?'A focused sanctions discussion.':`General filing ${index}.`,
            {kind:'description'}
        );
    }
    await repository.putGeneratedMarkdown(
        caseRecord,
        'Work Product/Drafts/Prior AI Draft.md',
        'sanctions sanctions sanctions',
        {kind:'work-product'}
    );

    const context=await repository.getLegalContext(caseRecord,{
        query:'sanctions',
        totalCharacterLimit:36,
        perDocumentCharacterLimit:18
    });

    assert.equal(context.coverage.totalDocuments,10);
    assert.equal(context.coverage.includedDocuments,3);
    assert.equal(context.coverage.omittedDocuments,7);
    assert.match(context.documents[0].path,/Filing 7\.md$/);
    assert.ok(context.documents.every(document=>!document.path.startsWith('Work Product/')));
    assert.equal(context.coverage.inventory.length,10);
});

test('uses deterministic Copy 2 paths when replacement is disabled',async()=>{
    const {caseRecord,repository}=await createFixture();
    const path='Evidence/Raw/BRANDON MILLER - Payment Record.pdf';
    const first=await repository.putFile(
        caseRecord,
        {file:new Blob(['first']),path,kind:'evidence'}
    );
    const copy=await repository.putFile(
        caseRecord,
        {file:new Blob(['second']),path,kind:'evidence',replace:false}
    );

    assert.equal(first.path,path);
    assert.equal(
        copy.path,
        'Evidence/Raw/BRANDON MILLER - Payment Record Copy 2.pdf'
    );
    assert.notEqual(copy.id,first.id);
    assert.notEqual(copy.storageKey,first.storageKey);
});

test('stores generated Markdown and bounds legal context by document and total size',async()=>{
    const {caseRecord,repository}=await createFixture();
    const first=await repository.putGeneratedMarkdown(
        caseRecord,
        'Analysis/A.md',
        'abcdefghij',
        {kind:'analysis'}
    );
    await repository.putGeneratedMarkdown(
        caseRecord,
        'Analysis/B.md',
        'klmnopqrst',
        {kind:'analysis'}
    );
    await repository.putGeneratedMarkdown(
        caseRecord,
        'Evidence/MD/excluded.md',
        'not selected',
        {kind:'description'}
    );

    assert.equal(first.generated,true);
    assert.equal(first.mimeType,'text/markdown');
    assert.equal(await repository.readText(first),'abcdefghij');

    const context=await repository.getMarkdownContext(
        caseRecord,
        {
            includeKinds:['analysis'],
            perDocumentCharacterLimit:6,
            totalCharacterLimit:10
        }
    );

    assert.deepEqual(
        context,
        [
            {path:'Analysis/A.md',content:'abcdef',truncated:true},
            {path:'Analysis/B.md',content:'klmn',truncated:true}
        ]
    );
    assert.equal(
        context.reduce((total,document)=>total+document.content.length,0),
        10
    );
});

test('rejects rename collisions and removes file bytes and persisted metadata',async()=>{
    const {caseRecord,database,repository}=await createFixture();
    const first=await repository.putFile(
        caseRecord,
        {
            file:new Blob(['one'],{type:'text/plain'}),
            path:'Evidence/Raw/One.txt',
            kind:'evidence'
        }
    );
    const second=await repository.putFile(
        caseRecord,
        {
            file:new Blob(['two'],{type:'text/plain'}),
            path:'Evidence/Raw/Two.txt',
            kind:'evidence'
        }
    );

    await assert.rejects(
        repository.renameFile(caseRecord,second,first.path),
        /already exists/
    );
    assert.equal(second.path,'Evidence/Raw/Two.txt');

    await repository.renameFile(
        caseRecord,
        second,
        'Evidence/Raw/Renamed.txt'
    );
    assert.equal(second.path,'Evidence/Raw/Renamed.txt');
    assert.ok(
        (await repository.getCase(caseRecord.id)).files.some(
            record=>record.id===second.id&&record.path==='Evidence/Raw/Renamed.txt'
        )
    );

    assert.equal(await repository.removeFile(caseRecord,first),true);
    assert.equal(database.has('redress_files',first.storageKey),false);
    await assert.rejects(repository.readFile(first),{name:'NotFoundError'});
    assert.equal(
        (await repository.getCase(caseRecord.id)).files.some(record=>record.id===first.id),
        false
    );
});
