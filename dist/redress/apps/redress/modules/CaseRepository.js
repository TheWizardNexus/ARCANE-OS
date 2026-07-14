import {
    createCaseRecord,
    normalizeRelativePath
} from './CaseModel.js';

const CASES_TABLE='redress_cases';
const FILES_TABLE='redress_files';
const STATE_TABLE='redress_state';
const ACTIVE_CASE_FILE='active-case.json';

function nowISO(){
    return new Date().toISOString();
}

function createId(prefix='item'){
    if(globalThis.crypto?.randomUUID){
        return `${prefix}-${globalThis.crypto.randomUUID()}`;
    }

    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,12)}`;
}

function extensionOf(name=''){
    const index=String(name).lastIndexOf('.');
    return index>0?String(name).slice(index).toLowerCase():'';
}

function basename(path=''){
    return String(path).split('/').at(-1)||'';
}

function storageFileName(caseId='',recordId='',name=''){
    const extension=extensionOf(name);
    const safeCase=String(caseId).replace(/[^a-z0-9_-]+/gi,'-').slice(0,72)||'case';
    return `${safeCase}--${recordId}${extension}`;
}

const SHA256_INITIAL=Object.freeze([
    0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
    0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19
]);
const SHA256_CONSTANTS=Object.freeze([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);

function rotateRight(value,bits){
    return (value>>>bits)|(value<<(32-bits));
}

class StreamingSHA256 {
    constructor(){
        this.state=SHA256_INITIAL.slice();
        this.buffer=new Uint8Array(64);
        this.bufferLength=0;
        this.bytesHashed=0;
        this.finished=false;
        this.words=new Uint32Array(64);
    }

    update(input){
        if(this.finished){
            throw new Error('SHA-256 digest has already been finalized.');
        }
        const data=input instanceof Uint8Array?input:new Uint8Array(input);
        this.bytesHashed+=data.length;
        let offset=0;

        if(this.bufferLength){
            const needed=64-this.bufferLength;
            const take=Math.min(needed,data.length);
            this.buffer.set(data.subarray(0,take),this.bufferLength);
            this.bufferLength+=take;
            offset+=take;
            if(this.bufferLength===64){
                this.transform(this.buffer);
                this.bufferLength=0;
            }
        }

        while(offset+64<=data.length){
            this.transform(data.subarray(offset,offset+64));
            offset+=64;
        }

        if(offset<data.length){
            this.buffer.set(data.subarray(offset),0);
            this.bufferLength=data.length-offset;
        }
        return this;
    }

    transform(chunk){
        const words=this.words;
        for(let index=0;index<16;index++){
            const offset=index*4;
            words[index]=(
                (chunk[offset]<<24)
                |(chunk[offset+1]<<16)
                |(chunk[offset+2]<<8)
                |chunk[offset+3]
            )>>>0;
        }
        for(let index=16;index<64;index++){
            const previous=words[index-15];
            const earlier=words[index-2];
            const sigma0=rotateRight(previous,7)^rotateRight(previous,18)^(previous>>>3);
            const sigma1=rotateRight(earlier,17)^rotateRight(earlier,19)^(earlier>>>10);
            words[index]=(words[index-16]+sigma0+words[index-7]+sigma1)>>>0;
        }

        let [a,b,c,d,e,f,g,h]=this.state;
        for(let index=0;index<64;index++){
            const sigma1=rotateRight(e,6)^rotateRight(e,11)^rotateRight(e,25);
            const choice=(e&f)^((~e)&g);
            const first=(h+sigma1+choice+SHA256_CONSTANTS[index]+words[index])>>>0;
            const sigma0=rotateRight(a,2)^rotateRight(a,13)^rotateRight(a,22);
            const majority=(a&b)^(a&c)^(b&c);
            const second=(sigma0+majority)>>>0;
            h=g;
            g=f;
            f=e;
            e=(d+first)>>>0;
            d=c;
            c=b;
            b=a;
            a=(first+second)>>>0;
        }

        this.state[0]=(this.state[0]+a)>>>0;
        this.state[1]=(this.state[1]+b)>>>0;
        this.state[2]=(this.state[2]+c)>>>0;
        this.state[3]=(this.state[3]+d)>>>0;
        this.state[4]=(this.state[4]+e)>>>0;
        this.state[5]=(this.state[5]+f)>>>0;
        this.state[6]=(this.state[6]+g)>>>0;
        this.state[7]=(this.state[7]+h)>>>0;
    }

    hex(){
        if(!this.finished){
            const bytesHashed=this.bytesHashed;
            const finalLength=this.bufferLength<56?64:128;
            const finalBlock=new Uint8Array(finalLength);
            finalBlock.set(this.buffer.subarray(0,this.bufferLength));
            finalBlock[this.bufferLength]=0x80;
            const bitLength=bytesHashed*8;
            const high=Math.floor(bitLength/0x100000000);
            const low=bitLength>>>0;
            const view=new DataView(finalBlock.buffer);
            view.setUint32(finalLength-8,high,false);
            view.setUint32(finalLength-4,low,false);
            for(let offset=0;offset<finalLength;offset+=64){
                this.transform(finalBlock.subarray(offset,offset+64));
            }
            this.finished=true;
        }
        return this.state.map(word=>word.toString(16).padStart(8,'0')).join('');
    }
}

async function sha256(file){
    if(typeof file?.stream!=='function'&&typeof file?.arrayBuffer!=='function'){
        return {algorithm:'SHA-256',status:'unavailable',value:''};
    }

    try{
        if(Number(file.size)<=32*1024*1024&&globalThis.crypto?.subtle&&typeof file.arrayBuffer==='function'){
            const digest=await globalThis.crypto.subtle.digest('SHA-256',await file.arrayBuffer());
            const value=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
            return {algorithm:'SHA-256',status:'complete',value};
        }

        const hasher=new StreamingSHA256();
        if(typeof file.stream==='function'){
            const reader=file.stream().getReader();
            try{
                while(true){
                    const {done,value}=await reader.read();
                    if(done){
                        break;
                    }
                    hasher.update(value);
                }
            }finally{
                reader.releaseLock();
            }
        }else{
            hasher.update(new Uint8Array(await file.arrayBuffer()));
        }
        return {algorithm:'SHA-256',status:'complete',value:hasher.hex()};
    }catch(error){
        console.warn('Unable to hash imported file.',error);
        return {algorithm:'SHA-256',status:'failed',value:''};
    }
}

function normalizeCaseRecord(record){
    const normalized=record&&typeof record==='object'?record:{};
    normalized.files=Array.isArray(normalized.files)?normalized.files:[];
    normalized.profile=normalized.profile&&typeof normalized.profile==='object'
        ?normalized.profile
        :{};
    normalized.jobs=Array.isArray(normalized.jobs)?normalized.jobs:[];
    return normalized;
}

const SEARCH_STOP_WORDS=new Set([
    'about','after','again','against','analysis','before','being','between','build',
    'case','could','draft','from','have','into','legal','matter','other','should',
    'that','their','there','these','they','this','through','what','when','where',
    'which','while','with','would','your'
]);

function searchTerms(query=''){
    return Array.from(new Set(
        String(query).toLowerCase().match(/[a-z0-9]{3,}/g)||[]
    )).filter(term=>!SEARCH_STOP_WORDS.has(term));
}

function scoreDocument(path='',content='',query=''){
    const terms=searchTerms(query);
    if(!terms.length){
        return 0;
    }
    const normalizedPath=String(path).toLowerCase();
    const normalizedContent=String(content).toLowerCase();
    let score=0;
    for(const term of terms){
        if(normalizedPath.includes(term)){
            score+=12;
        }
        const occurrences=normalizedContent.split(term).length-1;
        score+=Math.min(occurrences,6)*2;
    }
    const phrase=String(query).trim().toLowerCase();
    if(phrase.length>=5&&normalizedContent.includes(phrase)){
        score+=18;
    }
    return score;
}

function waitForDBOPFS(database=globalThis.dbopfs){
    if(database?.ready){
        return Promise.resolve(database);
    }

    return new Promise(resolve=>{
        const complete=event=>{
            const readyDatabase=event?.detail?.dbopfs||database||globalThis.dbopfs;
            if(!readyDatabase?.ready){
                return;
            }
            globalThis.window?.removeEventListener('dbopfs-ready',complete);
            resolve(readyDatabase);
        };

        globalThis.window?.addEventListener('dbopfs-ready',complete);
        complete();
    });
}

class CaseRepository {
    #database;

    constructor({database=globalThis.dbopfs}={}){
        this.#database=database;
    }

    async ready(){
        this.#database=await waitForDBOPFS(this.#database);
        return this;
    }

    get providerName(){
        return this.#database?.providerName||'DBOPFS';
    }

    async listCases(){
        await this.ready();
        const records=await this.#database.getAll(CASES_TABLE);

        return Object.values(records||{})
            .filter(record=>record&&typeof record==='object'&&!Array.isArray(record))
            .map(normalizeCaseRecord)
            .sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
    }

    async getCase(caseId=''){
        await this.ready();
        if(!caseId){
            return null;
        }

        const record=await this.#database.get(CASES_TABLE,`${caseId}.json`,true);
        return record?normalizeCaseRecord(record):null;
    }

    async createCase(profile={}){
        const timestamp=nowISO();
        const record=createCaseRecord({
            ...profile,
            title:profile.caseName||profile.title||profile.caseNumber||'Untitled legal matter',
            createdAt:timestamp,
            updatedAt:timestamp
        });
        record.profile={...record.profile,...profile};
        record.title=profile.caseName||profile.title||record.title;
        record.caseNumber=profile.caseNumber||record.caseNumber;
        if(await this.getCase(record.id)){
            record.id=createId(record.id);
        }
        await this.saveCase(record);
        await this.setActiveCase(record.id);
        return record;
    }

    async saveCase(record){
        await this.ready();
        const normalized=normalizeCaseRecord(record);

        if(!normalized.id){
            throw new TypeError('A case record must have an id.');
        }

        normalized.updatedAt=nowISO();
        await this.#database.set(
            CASES_TABLE,
            `${normalized.id}.json`,
            JSON.stringify(normalized)
        );
        return normalized;
    }

    async setActiveCase(caseId=''){
        await this.ready();
        await this.#database.set(
            STATE_TABLE,
            ACTIVE_CASE_FILE,
            JSON.stringify({caseId,updatedAt:nowISO()})
        );
        return caseId;
    }

    async getActiveCase(){
        await this.ready();
        const state=await this.#database.get(STATE_TABLE,ACTIVE_CASE_FILE,true);
        return state?.caseId?this.getCase(state.caseId):null;
    }

    async getOrCreateActiveCase(profile={}){
        const active=await this.getActiveCase();
        if(active){
            return active;
        }

        const cases=await this.listCases();
        if(cases.length){
            await this.setActiveCase(cases[0].id);
            return cases[0];
        }

        return this.createCase(profile);
    }

    findByPath(caseRecord,path=''){
        const normalized=normalizeRelativePath(path);
        return normalizeCaseRecord(caseRecord).files.find(
            file=>file.path.toLowerCase()===normalized.toLowerCase()
        )||null;
    }

    uniquePath(caseRecord,path=''){
        const normalized=normalizeRelativePath(path);
        const paths=new Set(normalizeCaseRecord(caseRecord).files.map(file=>file.path.toLowerCase()));
        if(!paths.has(normalized.toLowerCase())){
            return normalized;
        }

        const segments=normalized.split('/');
        const name=segments.pop();
        const extension=extensionOf(name);
        const stem=extension?name.slice(0,-extension.length):name;
        let copy=2;
        let candidate='';

        do{
            candidate=[...segments,`${stem} Copy ${copy}${extension}`].join('/');
            copy++;
        }while(paths.has(candidate.toLowerCase()));

        return candidate;
    }

    async putFile(caseRecord,{
        file,
        path,
        kind='other',
        originalPath='',
        originalName='',
        descriptionFor='',
        generated=false,
        hash=null,
        replace=true,
        status='ready',
        metadata={}
    }={}){
        await this.ready();

        if(!file){
            throw new TypeError('putFile requires a File, Blob, or string value.');
        }

        const normalizedCase=normalizeCaseRecord(caseRecord);
        const normalizedPath=normalizeRelativePath(path);
        if(!normalizedPath){
            throw new TypeError('putFile requires a relative case path.');
        }

        let existing=this.findByPath(normalizedCase,normalizedPath);
        let finalPath=normalizedPath;
        if(existing&&!replace){
            finalPath=this.uniquePath(normalizedCase,normalizedPath);
            existing=null;
        }

        const id=existing?.id||createId('file');
        const name=basename(finalPath);
        const storageKey=existing?.storageKey||storageFileName(normalizedCase.id,id,name);
        const blob=file instanceof Blob?file:new Blob([file],{type:metadata.type||'text/plain'});
        const fileHash=hash?.algorithm?hash:await sha256(blob);
        const importTime=nowISO();

        await this.#database.writeFile(FILES_TABLE,storageKey,blob,false);

        const provenance=Array.isArray(existing?.provenance)
            ?[...existing.provenance]
            :existing?[{
                originalName:existing.originalName||existing.name,
                originalPath:existing.originalPath||existing.path,
                importedAt:existing.importedAt||'',
                hash:existing.hash?.value||''
            }]:[];
        const provenanceEntry={
            originalName:originalName||file?.name||existing?.originalName||name,
            originalPath:normalizeRelativePath(originalPath||existing?.originalPath||finalPath),
            importedAt:importTime,
            hash:fileHash.value||''
        };
        if(!provenance.some(entry=>entry.originalName===provenanceEntry.originalName
            &&entry.originalPath===provenanceEntry.originalPath
            &&entry.hash===provenanceEntry.hash)){
            provenance.push(provenanceEntry);
        }

        const record={
            ...existing,
            ...metadata,
            id,
            storageKey,
            path:finalPath,
            name,
            kind,
            extension:extensionOf(name),
            mimeType:blob.type||metadata.mimeType||'',
            size:blob.size,
            lastModified:Number(file?.lastModified)||metadata.lastModified||null,
            originalName:provenanceEntry.originalName,
            originalPath:provenanceEntry.originalPath,
            importedAt:existing?.importedAt||importTime,
            lastImportedAt:importTime,
            provenance,
            updatedAt:nowISO(),
            descriptionFor:normalizeRelativePath(descriptionFor||existing?.descriptionFor||''),
            generated:Boolean(generated),
            status,
            hash:fileHash
        };

        const index=normalizedCase.files.findIndex(item=>item.id===id);
        if(index>=0){
            normalizedCase.files[index]=record;
        }else{
            normalizedCase.files.push(record);
        }

        return record;
    }

    async putGeneratedMarkdown(caseRecord,path='',markdown='',options={}){
        return this.putFile(
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
    }

    async readFile(record){
        await this.ready();
        if(!record?.storageKey){
            throw new TypeError('A stored file record is required.');
        }
        return this.#database.readFile(FILES_TABLE,record.storageKey);
    }

    async readText(record){
        return (await this.readFile(record)).text();
    }

    async removeFile(caseRecord,record){
        await this.ready();
        if(!record){
            return false;
        }
        await this.#database.delete(FILES_TABLE,record.storageKey);
        caseRecord.files=normalizeCaseRecord(caseRecord).files.filter(file=>file.id!==record.id);
        await this.saveCase(caseRecord);
        return true;
    }

    async renameFile(caseRecord,record,newPath=''){
        const path=normalizeRelativePath(newPath);
        if(!path){
            throw new TypeError('A new relative path is required.');
        }
        const collision=this.findByPath(caseRecord,path);
        if(collision&&collision.id!==record.id){
            throw new Error(`A case file already exists at ${path}.`);
        }
        record.path=path;
        record.name=basename(path);
        record.updatedAt=nowISO();
        await this.saveCase(caseRecord);
        return record;
    }

    async getMarkdownContext(caseRecord,{
        totalCharacterLimit=60000,
        perDocumentCharacterLimit=9000,
        includeKinds=[]
    }={}){
        const allowed=new Set(includeKinds);
        const records=normalizeCaseRecord(caseRecord).files
            .filter(record=>record.extension==='.md')
            .filter(record=>!allowed.size||allowed.has(record.kind))
            .sort((a,b)=>a.path.localeCompare(b.path));
        const documents=[];
        let remaining=Math.max(0,totalCharacterLimit);

        for(const record of records){
            if(remaining<=0){
                break;
            }
            try{
                const body=await this.readText(record);
                const content=body.slice(0,Math.min(perDocumentCharacterLimit,remaining));
                documents.push({path:record.path,content,truncated:content.length<body.length});
                remaining-=content.length;
            }catch(error){
                console.warn(`Unable to read ${record.path} for legal context.`,error);
            }
        }

        return documents;
    }

    async getLegalContext(caseRecord,{
        query='',
        totalCharacterLimit=60000,
        perDocumentCharacterLimit=9000,
        inventoryCharacterLimit=32000,
        includeKinds=['description','authority']
    }={}){
        const allowed=new Set(includeKinds);
        const records=normalizeCaseRecord(caseRecord).files
            .filter(record=>record.extension==='.md')
            .filter(record=>!allowed.size||allowed.has(record.kind))
            .sort((a,b)=>a.path.localeCompare(b.path,undefined,{numeric:true,sensitivity:'base'}));
        const ranked=[];
        const errors=[];

        for(const record of records){
            try{
                const file=await this.readFile(record);
                const previewBytes=Math.max(perDocumentCharacterLimit*4,36000);
                const previewBlob=typeof file.slice==='function'
                    ?file.slice(0,previewBytes)
                    :file;
                const body=await previewBlob.text();
                ranked.push({
                    record,
                    body,
                    previewBounded:Number(file.size)>Number(previewBlob.size),
                    score:scoreDocument(record.path,body.slice(0,18000),query)
                });
            }catch(error){
                errors.push({path:record.path,message:error.message});
            }
        }

        ranked.sort((a,b)=>b.score-a.score
            ||a.record.path.localeCompare(b.record.path,undefined,{numeric:true,sensitivity:'base'}));

        const documents=[];
        let remaining=Math.max(0,totalCharacterLimit);
        for(const item of ranked){
            if(remaining<=0){
                break;
            }
            const content=item.body.slice(0,Math.min(perDocumentCharacterLimit,remaining));
            if(!content){
                continue;
            }
            documents.push({
                path:item.record.path,
                content,
                truncated:item.previewBounded||content.length<item.body.length,
                score:item.score,
                kind:item.record.kind,
                generated:Boolean(item.record.generated),
                status:item.record.status||'ready',
                descriptionFor:item.record.descriptionFor||''
            });
            remaining-=content.length;
        }

        const inventory=[];
        let inventoryCharacters=0;
        for(const record of records){
            const line=record.path;
            if(inventoryCharacters+line.length>inventoryCharacterLimit){
                break;
            }
            inventory.push(line);
            inventoryCharacters+=line.length;
        }

        return {
            documents,
            coverage:{
                query:String(query),
                selection:searchTerms(query).length?'query-ranked':'path-ordered',
                totalDocuments:records.length,
                readableDocuments:ranked.length,
                includedDocuments:documents.length,
                omittedDocuments:Math.max(0,records.length-documents.length),
                includedCharacters:totalCharacterLimit-remaining,
                inventory,
                inventoryOmitted:Math.max(0,records.length-inventory.length),
                errors
            }
        };
    }
}

export {
    ACTIVE_CASE_FILE,
    CASES_TABLE,
    FILES_TABLE,
    STATE_TABLE,
    StreamingSHA256,
    CaseRepository,
    createId,
    scoreDocument,
    searchTerms,
    sha256,
    waitForDBOPFS
};

export default CaseRepository;
