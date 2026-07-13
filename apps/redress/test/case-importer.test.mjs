import assert from 'node:assert/strict';
import test from 'node:test';

import CaseImporter,{
    filesFromList,
    markdownIntegrity,
    walkFileSystemHandle
} from '../modules/CaseImporter.js';

const FILING_STEM='24-10-28 [TERUKO MILLER] - Petition for Dissolution of Marriage';
const FILING_PDF=`${FILING_STEM}.pdf`;
const FILING_MD=`${FILING_STEM}.md`;

function fakeFile(name,body='',{
    type='application/octet-stream',
    relativePath='',
    lastModified=Date.parse('2026-07-12T12:00:00.000Z')
}={}){
    const file=new Blob([body],{type});

    Object.defineProperties(
        file,
        {
            name:{value:name,enumerable:true},
            webkitRelativePath:{value:relativePath,enumerable:true},
            lastModified:{value:lastModified,enumerable:true}
        }
    );

    return file;
}

function extensionOf(name=''){
    const index=String(name).lastIndexOf('.');
    return index>0?String(name).slice(index).toLowerCase():'';
}

function basename(path=''){
    return String(path).split('/').at(-1)||'';
}

function copyPath(path='',copyNumber=2){
    const extension=extensionOf(path);
    const stem=extension?path.slice(0,-extension.length):path;
    return `${stem} Copy ${copyNumber}${extension}`;
}

class FakeRepository {
    putCalls=[];

    generatedCalls=[];

    saveCalls=0;

    nextId=1;

    findByPath(caseRecord,path=''){
        return caseRecord.files.find(
            record=>record.path.toLowerCase()===String(path).toLowerCase()
        )||null;
    }

    uniquePath(caseRecord,path){
        const paths=new Set(caseRecord.files.map(record=>record.path.toLowerCase()));
        if(!paths.has(path.toLowerCase())){
            return path;
        }

        let number=2;
        let candidate=copyPath(path,number);
        while(paths.has(candidate.toLowerCase())){
            number++;
            candidate=copyPath(path,number);
        }
        return candidate;
    }

    async putFile(caseRecord,options={}){
        const finalPath=options.replace===false
            ?this.uniquePath(caseRecord,options.path)
            :options.path;
        const name=basename(finalPath);
        const record={
            ...(options.metadata||{}),
            id:`file-${this.nextId++}`,
            storageKey:`stored-${this.nextId}-${name}`,
            path:finalPath,
            name,
            kind:options.kind||'other',
            extension:extensionOf(name),
            mimeType:options.file?.type||'',
            size:options.file?.size||0,
            originalName:options.originalName||options.file?.name||name,
            originalPath:options.originalPath||finalPath,
            importedAt:'2026-07-12T12:00:00.000Z',
            descriptionFor:options.descriptionFor||'',
            generated:Boolean(options.generated),
            status:options.status||'ready',
            hash:{algorithm:'SHA-256',status:'complete',value:`hash-${this.nextId}`}
        };

        caseRecord.files.push(record);
        this.putCalls.push({options,record});
        return record;
    }

    async putGeneratedMarkdown(caseRecord,path,markdown,options={}){
        const record=await this.putFile(
            caseRecord,
            {
                ...options,
                file:new Blob([markdown],{type:'text/markdown'}),
                path,
                kind:options.kind||'description',
                generated:true,
                replace:options.replace!==false
            }
        );

        record.markdown=markdown;
        this.generatedCalls.push({markdown,options,path,record});
        return record;
    }

    async saveCase(caseRecord){
        this.saveCalls++;
        return caseRecord;
    }
}

class FakeDescriptor {
    constructor({evidenceName='[UNDATED] [ASHLEY ONOFRE] - Voicemail About Pickup.m4a'}={}){
        this.evidenceName=evidenceName;
        this.analyzeCalls=[];
        this.buildCalls=[];
    }

    async analyze(file,{kind='evidence',path='',caseProfile={},useAI=true}={}){
        this.analyzeCalls.push({file,kind,path,caseProfile,useAI});
        const evidence=kind==='evidence';
        return {
            canonicalName:evidence?this.evidenceName:file.name,
            analysis:{
                title:evidence?'Voicemail About Pickup':FILING_STEM,
                who:evidence?['ASHLEY ONOFRE']:['TERUKO MILLER'],
                what:evidence?'Voicemail About Pickup':'Petition for Dissolution of Marriage',
                date:evidence?'':'24-10-28',
                documentType:evidence?'Audio evidence':'Court filing',
                summary:'Grounded test description.',
                requests:[],
                relevance:'Review with the case record.',
                limitations:[],
                generatedBy:'test-descriptor',
                needsReview:false
            },
            extraction:{
                content:'',
                method:'test',
                status:'complete',
                limitations:[]
            }
        };
    }

    buildMarkdown(options={}){
        this.buildCalls.push(options);
        const title=basename(options.rawRecord?.name||'Case file').replace(/\.[^.]+$/u,'');
        return `# ${title}\n\nGrounded test description.\n`;
    }
}

function fixture(options={}){
    const repository=new FakeRepository();
    const descriptor=new FakeDescriptor(options);
    const importer=new CaseImporter({repository,descriptor});
    const caseRecord={
        id:'24fl001068',
        profile:{caseNumber:'24FL001068'},
        files:[],
        jobs:[]
    };

    return {caseRecord,descriptor,importer,repository};
}

test('maps folder-list files and detects a Markdown H1 mismatch',()=>{
    const file=fakeFile(
        FILING_PDF,
        'pdf',
        {relativePath:`24FL001068\\Filing by Filing\\PDF\\${FILING_PDF}`}
    );

    assert.deepEqual(
        filesFromList([file]).map(item=>item.relativePath),
        [`24FL001068/Filing by Filing/PDF/${FILING_PDF}`]
    );

    const integrity=markdownIntegrity('# A Different Filing\n\nBody',FILING_MD);
    assert.equal(integrity.status,'needs-review');
    assert.equal(integrity.heading,'A Different Filing');
    assert.match(integrity.issues[0],/does not match filesystem basename/u);
});

test('imports an exact Filing by Filing PDF/MD pair and excludes merged and rendered files',async()=>{
    const {caseRecord,descriptor,importer}=fixture();
    const pdfPath=`24FL001068/Filing by Filing/PDF/${FILING_PDF}`;
    const mdPath=`24FL001068/Filing by Filing/MD/${FILING_MD}`;
    const result=await importer.import(
        [
            {
                file:fakeFile(FILING_PDF,'%PDF-test',{type:'application/pdf'}),
                relativePath:pdfPath
            },
            {
                file:fakeFile(FILING_MD,`# ${FILING_STEM}\n\nPetition summary.`,{type:'text/markdown'}),
                relativePath:mdPath
            },
            {
                file:fakeFile('merged.pdf','merged',{type:'application/pdf'}),
                relativePath:'24FL001068/Court provided merged PDFs/merged.pdf'
            },
            {
                file:fakeFile('page-0001.png','render',{type:'image/png'}),
                relativePath:`24FL001068/Filing by Filing/MD/_rendered_pages/${FILING_STEM}/page-0001.png`
            }
        ],
        {caseRecord,flushEvery:100}
    );

    assert.equal(result.failures.length,0);
    assert.deepEqual(
        result.skipped.map(item=>item.path),
        [
            '24FL001068/Court provided merged PDFs/merged.pdf',
            `24FL001068/Filing by Filing/MD/_rendered_pages/${FILING_STEM}/page-0001.png`
        ]
    );
    assert.equal(result.imported.length,2);
    assert.equal(result.generated.length,0);
    assert.equal(descriptor.analyzeCalls.length,0);

    const raw=result.imported.find(record=>record.kind==='filing');
    const markdown=result.imported.find(record=>record.kind==='description');
    assert.equal(raw.path,`Filing by Filing/PDF/${FILING_PDF}`);
    assert.equal(markdown.path,`Filing by Filing/MD/${FILING_MD}`);
    assert.equal(raw.descriptionPath,markdown.path);
    assert.equal(markdown.descriptionFor,raw.path);
    assert.equal(raw.originalName,FILING_PDF);
    assert.equal(raw.originalPath,pdfPath);
    assert.equal(markdown.originalName,FILING_MD);
    assert.equal(markdown.originalPath,mdPath);
    assert.equal(raw.filingNameValid,true);
    assert.equal(raw.status,'ready');
    assert.equal(markdown.status,'ready');
});

test('generates the exact same-basename Markdown companion for a filing without a sidecar',async()=>{
    const {caseRecord,descriptor,importer,repository}=fixture();
    const result=await importer.import(
        [
            {
                file:fakeFile(FILING_PDF,'%PDF-test',{type:'application/pdf'}),
                relativePath:`PDF/${FILING_PDF}`
            }
        ],
        {caseRecord,flushEvery:100}
    );

    assert.equal(result.failures.length,0);
    assert.equal(result.imported.length,1);
    assert.equal(result.generated.length,1);
    assert.equal(descriptor.analyzeCalls.length,1);
    assert.equal(descriptor.analyzeCalls[0].useAI,true);
    assert.equal(repository.generatedCalls.length,1);

    const raw=result.imported[0];
    const markdown=result.generated[0];
    assert.equal(raw.path,`Filing by Filing/PDF/${FILING_PDF}`);
    assert.equal(markdown.path,`Filing by Filing/MD/${FILING_MD}`);
    assert.equal(markdown.descriptionFor,raw.path);
    assert.equal(markdown.generated,true);
    assert.match(markdown.markdown,new RegExp(`^# ${FILING_STEM.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`,'u'));
});

test('evidence mode applies a descriptive raw name and creates matching Markdown with provenance',async()=>{
    const evidenceName='[UNDATED] [ASHLEY ONOFRE] - Voicemail About Pickup.m4a';
    const {caseRecord,descriptor,importer}=fixture({evidenceName});
    const originalPath='phone-export/messages/recording-001.m4a';
    const result=await importer.import(
        [
            {
                file:fakeFile('recording-001.m4a','audio',{type:'audio/mp4'}),
                relativePath:originalPath
            }
        ],
        {caseRecord,mode:'evidence',flushEvery:100}
    );

    assert.equal(result.failures.length,0);
    assert.equal(descriptor.analyzeCalls.length,2);
    assert.equal(descriptor.analyzeCalls[0].useAI,false);
    assert.equal(descriptor.analyzeCalls[1].useAI,true);
    assert.equal(result.imported.length,1);
    assert.equal(result.generated.length,1);

    const raw=result.imported[0];
    const markdown=result.generated[0];
    assert.equal(raw.path,`Evidence/Raw/phone-export/messages/${evidenceName}`);
    assert.equal(
        markdown.path,
        'Evidence/MD/phone-export/messages/[UNDATED] [ASHLEY ONOFRE] - Voicemail About Pickup.md'
    );
    assert.equal(
        basename(markdown.path).replace(/\.md$/u,''),
        basename(raw.path).replace(/\.m4a$/u,'')
    );
    assert.equal(raw.originalName,'recording-001.m4a');
    assert.equal(raw.originalPath,originalPath);
    assert.equal(markdown.descriptionFor,raw.path);
    assert.equal(raw.initialAnalysis.what,'Voicemail About Pickup');
});

test('marks invalid filing names and mismatched imported Markdown for review',async()=>{
    const {caseRecord,importer}=fixture();
    const invalidName='Petition without filing convention.pdf';
    const mismatchedBody='# Wrong Filing Title\n\nBody';
    const result=await importer.import(
        [
            {
                file:fakeFile(invalidName,'pdf',{type:'application/pdf'}),
                relativePath:`Filing by Filing/PDF/${invalidName}`
            },
            {
                file:fakeFile(FILING_PDF,'pdf',{type:'application/pdf'}),
                relativePath:`Filing by Filing/PDF/${FILING_PDF}`
            },
            {
                file:fakeFile(FILING_MD,mismatchedBody,{type:'text/markdown'}),
                relativePath:`Filing by Filing/MD/${FILING_MD}`
            }
        ],
        {caseRecord,flushEvery:100}
    );

    assert.equal(result.failures.length,0);
    const invalid=result.imported.find(record=>record.name===invalidName);
    const mismatched=result.imported.find(record=>record.name===FILING_MD);
    assert.equal(invalid.kind,'filing');
    assert.equal(invalid.filingNameValid,false);
    assert.equal(invalid.status,'needs-review');
    assert.equal(mismatched.kind,'description');
    assert.equal(mismatched.status,'needs-review');
    assert.equal(mismatched.integrity.heading,'Wrong Filing Title');
    assert.match(mismatched.integrity.issues[0],/does not match filesystem basename/u);
});

test('treats Markdown uploaded as raw evidence as evidence and creates a separate sidecar',async()=>{
    const evidenceName='[UNDATED] [SOURCE NOT YET IDENTIFIED] - Message Notes.md';
    const {caseRecord,importer}=fixture({evidenceName});
    const result=await importer.import(
        [{file:fakeFile('message-notes.md','# Original notes',{type:'text/markdown'}),relativePath:'message-notes.md'}],
        {caseRecord,mode:'evidence',flushEvery:100}
    );

    assert.equal(result.failures.length,0);
    assert.equal(result.imported[0].kind,'evidence');
    assert.equal(result.imported[0].path,`Evidence/Raw/${evidenceName}`);
    assert.equal(result.generated[0].path,'Evidence/MD/[UNDATED] [SOURCE NOT YET IDENTIFIED] - Message Notes.md');
});

test('stores raw first and generates a fallback when an imported sidecar cannot be read',async()=>{
    const {caseRecord,importer}=fixture();
    const brokenMarkdown=fakeFile(FILING_MD,'broken',{type:'text/markdown'});
    Object.defineProperty(brokenMarkdown,'text',{value:async()=>{throw new Error('unreadable sidecar');}});
    const result=await importer.import(
        [
            {file:fakeFile(FILING_PDF,'%PDF',{type:'application/pdf'}),relativePath:`PDF/${FILING_PDF}`},
            {file:brokenMarkdown,relativePath:`MD/${FILING_MD}`}
        ],
        {caseRecord,flushEvery:100}
    );

    assert.equal(result.imported.some(record=>record.kind==='filing'),true);
    assert.equal(result.failures.length,1);
    assert.equal(result.generated.length,1);
    assert.equal(result.generated[0].descriptionFor,`Filing by Filing/PDF/${FILING_PDF}`);
});

test('versions two distinct colliding pairs before writing either sidecar',async()=>{
    const {caseRecord,importer}=fixture();
    const result=await importer.import(
        [
            {file:fakeFile(FILING_PDF,'first',{type:'application/pdf'}),relativePath:`one/PDF/${FILING_PDF}`},
            {file:fakeFile(FILING_MD,`# ${FILING_STEM}\n\nFirst`,{type:'text/markdown'}),relativePath:`one/MD/${FILING_MD}`},
            {file:fakeFile(FILING_PDF,'second',{type:'application/pdf'}),relativePath:`two/PDF/${FILING_PDF}`},
            {file:fakeFile(FILING_MD,`# ${FILING_STEM}\n\nSecond`,{type:'text/markdown'}),relativePath:`two/MD/${FILING_MD}`}
        ],
        {caseRecord,flushEvery:100}
    );

    assert.equal(result.failures.length,0);
    const rawPaths=result.imported.filter(record=>record.kind==='filing').map(record=>record.path).sort();
    const markdownPaths=result.imported.filter(record=>record.kind==='description').map(record=>record.path).sort();
    assert.equal(new Set(rawPaths).size,2);
    assert.equal(new Set(markdownPaths).size,2);
    assert.ok(rawPaths.some(path=>path.includes('Copy 2.pdf')));
    assert.ok(markdownPaths.some(path=>path.includes('Copy 2.md')));
});

test('prunes excluded directories before opening their children',async()=>{
    let excludedTraversed=false;
    const excluded={
        kind:'directory',
        name:'_rendered_pages',
        async *values(){
            excludedTraversed=true;
            throw new Error('excluded directory should not be traversed');
        }
    };
    const root={
        kind:'directory',
        name:'24FL001068',
        async *values(){yield excluded;}
    };

    assert.deepEqual(await walkFileSystemHandle(root),[]);
    assert.equal(excludedTraversed,false);
});
