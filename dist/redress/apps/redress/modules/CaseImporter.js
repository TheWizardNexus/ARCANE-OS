import {
    canonicalImportPath,
    classifyCasePath,
    companionPathFor,
    normalizeRelativePath,
    parseFilingFileName,
    shouldSkipImportPath
} from './CaseModel.js';
import EvidenceDescriptor,{relativeLink} from './EvidenceDescriptor.js';
import {sha256} from './CaseRepository.js';

function extensionOf(name=''){
    const index=String(name).lastIndexOf('.');
    return index>0?String(name).slice(index).toLowerCase():'';
}

function withoutExtension(name=''){
    const extension=extensionOf(name);
    return extension?String(name).slice(0,-extension.length):String(name);
}

function basename(path=''){
    return String(path).split('/').at(-1)||'';
}

function dirname(path=''){
    const segments=String(path).split('/');
    segments.pop();
    return segments.join('/');
}

function joinPath(...values){
    return normalizeRelativePath(values.filter(Boolean).join('/'));
}

function sourceJoin(...values){
    return values
        .filter(Boolean)
        .join('/')
        .replaceAll('\\','/')
        .replace(/^\/+|\/+$/g,'');
}

async function walkFileSystemHandle(handle,parentPath=''){
    const path=sourceJoin(parentPath,handle.name);
    if(handle.kind==='file'){
        return [{file:await handle.getFile(),relativePath:path}];
    }
    if(shouldSkipImportPath(path)){
        return [];
    }

    const items=[];
    for await(const child of handle.values()){
        items.push(...await walkFileSystemHandle(child,path));
    }
    return items;
}

function readLegacyFile(entry){
    return new Promise((resolve,reject)=>entry.file(resolve,reject));
}

function readLegacyEntries(reader){
    return new Promise((resolve,reject)=>reader.readEntries(resolve,reject));
}

async function walkLegacyEntry(entry,parentPath=''){
    const path=sourceJoin(parentPath,entry.name);
    if(entry.isFile){
        return [{file:await readLegacyFile(entry),relativePath:path}];
    }
    if(!entry.isDirectory){
        return [];
    }
    if(shouldSkipImportPath(path)){
        return [];
    }

    const reader=entry.createReader();
    const children=[];
    while(true){
        const batch=await readLegacyEntries(reader);
        if(!batch.length){
            break;
        }
        children.push(...batch);
    }

    const items=[];
    for(const child of children){
        items.push(...await walkLegacyEntry(child,path));
    }
    return items;
}

function filesFromList(fileList=[]){
    return Array.from(fileList||[]).map(file=>({
        file,
        relativePath:sourceJoin(file.webkitRelativePath||file.name)
    }));
}

async function filesFromDataTransfer(dataTransfer){
    const transferItems=Array.from(dataTransfer?.items||[]).filter(item=>item.kind==='file');
    if(!transferItems.length){
        return filesFromList(dataTransfer?.files||[]);
    }

    const modern=[];
    let modernSupported=false;
    for(const item of transferItems){
        if(typeof item.getAsFileSystemHandle!=='function'){
            continue;
        }
        modernSupported=true;
        const handle=await item.getAsFileSystemHandle();
        if(handle){
            modern.push(...await walkFileSystemHandle(handle));
        }
    }
    if(modernSupported&&modern.length){
        return modern;
    }

    const legacy=[];
    for(const item of transferItems){
        const entry=item.webkitGetAsEntry?.();
        if(entry){
            legacy.push(...await walkLegacyEntry(entry));
        }
    }
    return legacy.length?legacy:filesFromList(dataTransfer?.files||[]);
}

function pairKey(path=''){
    const normalized=normalizeRelativePath(path);
    const branches=[
        ['filing','Filing by Filing/PDF/'],
        ['filing','Filing by Filing/MD/'],
        ['evidence','Evidence/Raw/'],
        ['evidence','Evidence/MD/']
    ];
    const match=branches.find(([,prefix])=>normalized.startsWith(prefix));
    const root=match?.[0]||'';
    const relative=match?normalized.slice(match[1].length):normalized;
    return `${root}:${withoutExtension(relative).toLowerCase()}`;
}

function copyPath(path='',copyNumber=2){
    const extension=extensionOf(path);
    const stem=extension?path.slice(0,-extension.length):path;
    return `${stem} Copy ${copyNumber}${extension}`;
}

function uniquePairedPath(repository,caseRecord,desiredPath='',currentId=''){
    const occupied=new Map(caseRecord.files.map(record=>[record.path.toLowerCase(),record]));
    let candidate=desiredPath;
    let copyNumber=2;

    while(true){
        const rawCollision=occupied.get(candidate.toLowerCase());
        const descriptionPath=companionPathFor(candidate);
        const descriptionCollision=descriptionPath
            ?occupied.get(descriptionPath.toLowerCase())
            :null;
        const rawAvailable=!rawCollision||rawCollision.id===currentId;
        const descriptionAvailable=!descriptionCollision
            ||descriptionCollision.descriptionFor===candidate
            ||descriptionCollision.descriptionFor===rawCollision?.path;

        if(rawAvailable&&descriptionAvailable){
            return candidate;
        }
        candidate=copyPath(desiredPath,copyNumber++);
    }
}

function allocateImportPair(desiredPath='',reservedPaths=new Set(),{allowExisting=false}={}){
    let candidate=desiredPath;
    let copyNumber=2;

    while(true){
        const descriptionPath=companionPathFor(candidate);
        const rawOccupied=reservedPaths.has(candidate.toLowerCase());
        const descriptionOccupied=descriptionPath
            ?reservedPaths.has(descriptionPath.toLowerCase())
            :false;
        if(allowExisting||(!rawOccupied&&!descriptionOccupied)){
            reservedPaths.add(candidate.toLowerCase());
            if(descriptionPath){
                reservedPaths.add(descriptionPath.toLowerCase());
            }
            return candidate;
        }
        candidate=copyPath(desiredPath,copyNumber++);
    }
}

function markdownIntegrity(text='',expectedBase=''){
    const firstHeading=String(text).match(/^#\s+(.+)$/m)?.[1]?.trim()||'';
    const expected=withoutExtension(expectedBase);
    return {
        heading:firstHeading,
        status:firstHeading&&firstHeading!==expected?'needs-review':'ready',
        issues:firstHeading&&firstHeading!==expected
            ?[`Markdown heading “${firstHeading}” does not match filesystem basename “${expected}”.`]
            :[]
    };
}

function rewriteMarkdownPair(text='',rawPath='',descriptionPath=''){
    const title=withoutExtension(basename(descriptionPath));
    const sourceName=basename(rawPath);
    const sourceLabel=extensionOf(rawPath)==='.pdf'?'Source PDF':'Source file';
    const sourceLine=`- ${sourceLabel}: [${sourceName}](<${relativeLink(descriptionPath,rawPath)}>)`;
    let output=String(text);

    if(/^#\s+.+$/m.test(output)){
        output=output.replace(/^#\s+.+$/m,`# ${title}`);
    }else{
        output=`# ${title}\n\n${output}`;
    }
    if(/^- Source (?:PDF|file):.*$/mi.test(output)){
        output=output.replace(/^- Source (?:PDF|file):.*$/mi,sourceLine);
    }else{
        output=output.replace(/^#\s+.+$/m,heading=>`${heading}\n\n${sourceLine}`);
    }
    return output;
}

function descriptionPathForRaw(rawPath=''){
    return companionPathFor(rawPath);
}

function applicationKind(classification={}){
    if(classification.bucket==='filing'&&classification.role==='raw'){
        return 'filing';
    }
    if(classification.bucket==='evidence'&&classification.role==='raw'){
        return 'evidence';
    }
    if(classification.role==='description'){
        return 'description';
    }
    return 'other';
}

class CaseImporter {
    constructor({repository,descriptor}={}){
        if(!repository){
            throw new TypeError('CaseImporter requires a CaseRepository.');
        }
        this.repository=repository;
        this.descriptor=descriptor||new EvidenceDescriptor();
    }

    async collect(source){
        if(source?.items||source?.files){
            return filesFromDataTransfer(source);
        }
        return filesFromList(source);
    }

    async import(source,{
        caseRecord,
        mode='case',
        onProgress=()=>{},
        flushEvery=10
    }={}){
        if(!caseRecord){
            throw new TypeError('A case record is required for import.');
        }
        const collected=Array.isArray(source)?source:await this.collect(source);
        const skipped=[];
        const candidates=[];

        for(const item of collected){
            const sourcePath=sourceJoin(item.relativePath||item.file?.name||'');
            let originalPath='';
            try{
                originalPath=normalizeRelativePath(sourcePath);
            }catch(error){
                skipped.push({path:sourcePath,reason:'invalid-path',error});
                continue;
            }
            if(!item.file||shouldSkipImportPath(originalPath,mode)){
                skipped.push({path:originalPath,reason:'excluded'});
                continue;
            }

            if(mode==='filing'&&extensionOf(originalPath)!=='.pdf'){
                skipped.push({path:originalPath,reason:'filing-requires-pdf'});
                continue;
            }

            const mapped=canonicalImportPath(originalPath,{
                target:mode==='evidence'
                    ?'evidence'
                    :mode==='filing'?'filing':'auto'
            });
            if(!mapped){
                skipped.push({path:originalPath,reason:'outside-case-structure'});
                continue;
            }
            candidates.push({
                file:item.file,
                originalPath,
                path:normalizeRelativePath(mapped),
                classification:classifyCasePath(mapped)
            });
        }

        const sidecars=new Map();
        const rawFiles=new Map();
        for(const item of candidates){
            if(item.classification?.role==='description'){
                const key=pairKey(item.path);
                const group=sidecars.get(key)||[];
                group.push(item);
                sidecars.set(key,group);
            }else{
                const key=pairKey(item.path);
                const group=rawFiles.get(key)||[];
                group.push(item);
                rawFiles.set(key,group);
            }
        }

        for(const [key,group] of rawFiles){
            const descriptions=sidecars.get(key)||[];
            for(let index=0;index<Math.min(group.length,descriptions.length);index++){
                group[index].sidecar=descriptions[index];
                descriptions[index].rawItem=group[index];
            }
        }

        const imported=[];
        const generated=[];
        const failures=[];
        const successfulSidecarKeys=new Set();
        const rawCandidates=Array.from(rawFiles.values()).flat();
        const reservedPaths=new Set(caseRecord.files.map(record=>record.path.toLowerCase()));

        for(const item of rawCandidates){
            const kind=applicationKind(item.classification);
            try{
                if(kind==='evidence'&&!item.sidecar){
                    item.analysisResult=await this.descriptor.analyze(item.file,{
                        kind:'evidence',
                        path:item.path,
                        caseProfile:caseRecord.profile,
                        useAI:false
                    });
                    item.path=joinPath(dirname(item.path),item.analysisResult.canonicalName);
                }

                item.hash=await sha256(item.file);
                const existing=this.repository.findByPath(caseRecord,item.path);
                const sameHash=Boolean(
                    existing?.hash?.value
                    &&item.hash.value
                    &&existing.hash.value===item.hash.value
                );
                const desiredPath=item.path;
                item.path=allocateImportPair(desiredPath,reservedPaths,{allowExisting:sameHash});
                item.pairRenamed=item.path!==desiredPath;
                if(item.sidecar){
                    item.sidecar.path=descriptionPathForRaw(item.path);
                }
            }catch(error){
                item.preflightError=error;
                failures.push({path:item.originalPath,error});
            }
        }

        const total=candidates.length+rawCandidates.filter(item=>!item.sidecar).length;
        let completed=0;
        let writesSinceFlush=0;

        const progress=(stage,item,message='')=>{
            onProgress({stage,item,completed,total,imported:imported.length,generated:generated.length,skipped:skipped.length,failures:failures.length,message});
        };

        for(const item of rawCandidates){
            progress('importing',item,`Importing ${item.file.name}`);
            if(item.preflightError){
                completed++;
                continue;
            }
            try{
                const kind=applicationKind(item.classification);
                const filing=parseFilingFileName(item.file.name);
                const status=kind==='filing'&&!filing
                    ?'needs-review'
                    :item.analysisResult?.analysis?.needsReview?'needs-review':'ready';
                const descriptionPath=descriptionPathForRaw(item.path);
                const record=await this.repository.putFile(caseRecord,{
                    file:item.file,
                    path:item.path,
                    kind,
                    hash:item.hash,
                    originalPath:item.originalPath,
                    originalName:item.file.name,
                    replace:true,
                    status,
                    metadata:{
                        descriptionPath,
                        filingNameValid:kind==='filing'?Boolean(filing):undefined,
                        initialAnalysis:item.analysisResult?.analysis||undefined
                    }
                });
                item.storedRecord=record;
                item.path=record.path;
                imported.push(record);
                writesSinceFlush++;
            }catch(error){
                failures.push({path:item.originalPath,error});
            }
            completed++;
            if(writesSinceFlush>=flushEvery){
                await this.repository.saveCase(caseRecord);
                writesSinceFlush=0;
            }
        }

        for(const item of candidates.filter(candidate=>candidate.classification?.role==='description')){
            progress('importing',item,`Importing ${item.file.name}`);
            const raw=item.rawItem;
            if(!raw?.storedRecord){
                if(!raw){
                    try{
                        const text=await item.file.text();
                        const integrity=markdownIntegrity(text,basename(item.path));
                        const record=await this.repository.putFile(caseRecord,{
                            file:item.file,
                            path:item.path,
                            kind:'description',
                            originalPath:item.originalPath,
                            originalName:item.file.name,
                            status:'needs-review',
                            metadata:{
                                integrity:{
                                    ...integrity,
                                    status:'needs-review',
                                    issues:[...integrity.issues,'No paired raw source was included.']
                                }
                            }
                        });
                        imported.push(record);
                        writesSinceFlush++;
                    }catch(error){
                        failures.push({path:item.originalPath,error});
                    }
                }
                completed++;
                continue;
            }
            try{
                let text=await item.file.text();
                if(raw.pairRenamed){
                    text=rewriteMarkdownPair(text,raw.storedRecord.path,item.path);
                }
                const integrity=markdownIntegrity(text,basename(item.path));
                const record=await this.repository.putFile(caseRecord,{
                    file:new Blob([text],{type:item.file.type||'text/markdown'}),
                    path:item.path,
                    kind:applicationKind(item.classification),
                    originalPath:item.originalPath,
                    originalName:item.file.name,
                    descriptionFor:raw.storedRecord.path,
                    status:integrity.status,
                    metadata:{integrity,lastModified:item.file.lastModified||null}
                });
                imported.push(record);
                successfulSidecarKeys.add(pairKey(item.path));
                writesSinceFlush++;
            }catch(error){
                failures.push({path:item.originalPath,error});
            }
            completed++;
            if(writesSinceFlush>=flushEvery){
                await this.repository.saveCase(caseRecord);
                writesSinceFlush=0;
            }
        }

        const unpaired=rawCandidates.filter(
            item=>!item.sidecar||!successfulSidecarKeys.has(pairKey(item.path))
        );
        for(const item of unpaired){
            if(!item.storedRecord){
                continue;
            }
            progress('describing',item,`Creating Markdown for ${item.storedRecord.name}`);
            try{
                const kind=applicationKind(item.classification)==='filing'?'filing':'evidence';
                const result=await this.descriptor.analyze(item.file,{
                    kind,
                    path:item.path,
                    caseProfile:caseRecord.profile
                });
                if(kind==='evidence'&&result.canonicalName!==item.storedRecord.name){
                    const desiredPath=uniquePairedPath(
                        this.repository,
                        caseRecord,
                        joinPath(dirname(item.storedRecord.path),result.canonicalName),
                        item.storedRecord.id
                    );
                    await this.repository.renameFile(caseRecord,item.storedRecord,desiredPath);
                    item.path=item.storedRecord.path;
                }
                const descriptionPath=descriptionPathForRaw(item.storedRecord.path);
                const markdown=this.descriptor.buildMarkdown({
                    kind,
                    rawRecord:item.storedRecord,
                    analysis:result.analysis,
                    extraction:result.extraction
                });
                const record=await this.repository.putGeneratedMarkdown(
                    caseRecord,
                    descriptionPath,
                    markdown,
                    {
                        descriptionFor:item.storedRecord.path,
                        status:result.analysis.needsReview?'needs-review':'ready'
                    }
                );
                item.storedRecord.descriptionPath=descriptionPath;
                item.storedRecord.status=(
                    item.storedRecord.filingNameValid===false
                    ||result.analysis.needsReview
                )?'needs-review':'ready';
                generated.push(record);
                writesSinceFlush++;
            }catch(error){
                failures.push({path:item.originalPath,error});
            }
            completed++;
            if(writesSinceFlush>=flushEvery){
                await this.repository.saveCase(caseRecord);
                writesSinceFlush=0;
            }
        }

        await this.repository.saveCase(caseRecord);
        progress('complete',null,`Imported ${imported.length} files and created ${generated.length} descriptions.`);

        return {caseRecord,imported,generated,skipped,failures,total:collected.length};
    }
}

export {
    CaseImporter,
    applicationKind,
    descriptionPathForRaw,
    filesFromDataTransfer,
    filesFromList,
    markdownIntegrity,
    pairKey,
    rewriteMarkdownPair,
    uniquePairedPath,
    walkFileSystemHandle,
    walkLegacyEntry
};

export default CaseImporter;
