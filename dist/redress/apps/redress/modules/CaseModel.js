const CASE_SCHEMA_VERSION=1;

const CASE_FOLDERS=Object.freeze({
    filingRoot:'Filing by Filing',
    filingPdf:'Filing by Filing/PDF',
    filingMarkdown:'Filing by Filing/MD',
    evidenceRoot:'Evidence',
    evidenceRaw:'Evidence/Raw',
    evidenceMarkdown:'Evidence/MD'
});

const CONTROL_CHARACTER=/[\u0000-\u001f\u007f]/u;
const WINDOWS_INVALID_CHARACTER=/[<>:"|?*]/u;
const WINDOWS_DEVICE_NAME=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const FILING_STEM=/^(\d{2})-(\d{2})-(\d{2}) \[([^\]\r\n]+)\] - (.+)$/u;
const COPY_SUFFIX=/\s+(Copy\s+(\d+))$/iu;
const MARKDOWN_EXTENSION='.md';

const WORKSPACE_DIRECTORY_NAMES=new Set([
    '.agents',
    '.codex',
    '.git',
    '.redress',
    'node_modules',
    'output',
    'tools'
]);

const ALWAYS_SKIPPED_DIRECTORY_NAMES=new Set([
    'court provided merged pdfs'
]);

const JUNK_FILE_NAMES=new Set([
    '.ds_store',
    'desktop.ini',
    'thumbs.db'
]);

function assertString(value,label='Path'){
    if(typeof value!=='string'){
        throw new TypeError(`${label} must be a string.`);
    }
}

/**
 * Normalize an Arcane case-relative path without ever accepting an absolute or
 * traversing path. The result is suitable for either browser or native-backed
 * storage providers and always uses `/` separators.
 */
function normalizeRelativePath(value=''){
    assertString(value);

    if(value===''){
        return '';
    }

    if(CONTROL_CHARACTER.test(value)){
        throw new RangeError('Relative paths cannot contain control characters.');
    }

    const path=value.normalize('NFC').replaceAll('\\','/');
    if(path.startsWith('/')||/^[a-z]:/iu.test(path)){
        throw new RangeError('Absolute, drive, and UNC paths are not allowed.');
    }

    const segments=path.split('/');
    for(const segment of segments){
        if(!segment){
            throw new RangeError('Relative paths cannot contain empty segments.');
        }
        if(segment==='.'||segment==='..'){
            throw new RangeError('Relative paths cannot contain dot segments.');
        }
        if(WINDOWS_INVALID_CHARACTER.test(segment)){
            throw new RangeError(`Path segment contains a reserved character: ${segment}`);
        }
        if(/[. ]$/u.test(segment)){
            throw new RangeError(`Path segment cannot end in a dot or space: ${segment}`);
        }
        if(WINDOWS_DEVICE_NAME.test(segment)){
            throw new RangeError(`Path segment is a reserved device name: ${segment}`);
        }
    }

    return segments.join('/');
}

function extensionOf(path=''){
    const name=String(path).split('/').at(-1)||'';
    const index=name.lastIndexOf('.');
    return index>0?name.slice(index).toLowerCase():'';
}

function nameWithoutExtension(name=''){
    const extension=extensionOf(name);
    return extension?name.slice(0,-extension.length):name;
}

function replaceExtension(path='',extension=MARKDOWN_EXTENSION){
    const segments=path.split('/');
    const name=segments.pop()||'';
    segments.push(`${nameWithoutExtension(name)}${extension}`);
    return segments.join('/');
}

function isCalendarDate(year,month,day){
    const date=new Date(Date.UTC(year,month-1,day));
    return date.getUTCFullYear()===year
        &&date.getUTCMonth()===month-1
        &&date.getUTCDate()===day;
}

/** Parse the filing convention without removing meaningful `Copy N` text. */
function parseFilingFileName(path=''){
    assertString(path,'Filename');
    const normalized=path.replaceAll('\\','/');
    const fileName=normalized.split('/').at(-1)||'';
    const extension=extensionOf(fileName);
    const stem=nameWithoutExtension(fileName);
    const match=FILING_STEM.exec(stem);

    if(!match){
        return null;
    }

    const [,yearToken,monthToken,dayToken,rawActor,rawTitle]=match;
    const year=2000+Number(yearToken);
    const month=Number(monthToken);
    const day=Number(dayToken);
    const actor=rawActor.trim();
    const title=rawTitle.trim();
    if(!actor||!title||!isCalendarDate(year,month,day)){
        return null;
    }

    const copyMatch=COPY_SUFFIX.exec(title);
    const copySuffix=copyMatch?.[1]||'';
    const copyNumber=copyMatch?Number(copyMatch[2]):null;
    const baseTitle=copyMatch?title.slice(0,-copyMatch[0].length):title;
    const dateToken=`${yearToken}-${monthToken}-${dayToken}`;

    return {
        fileName,
        stem,
        extension,
        dateToken,
        isoDate:`${year}-${monthToken}-${dayToken}`,
        year,
        month,
        day,
        actor,
        sourceActor:actor,
        title,
        baseTitle,
        copySuffix,
        copyNumber
    };
}

function importSkipReason(path='',{
    includeDerived=false,
    includeMerged=false,
    includeWorkspaceArtifacts=false
}={}){
    let normalized;
    try{
        normalized=normalizeRelativePath(path);
    }catch{
        return 'invalid-path';
    }

    if(!normalized){
        return 'empty-path';
    }

    const segments=normalized.split('/');
    for(const segment of segments){
        const lower=segment.toLowerCase();
        if(!includeMerged&&ALWAYS_SKIPPED_DIRECTORY_NAMES.has(lower)){
            return 'merged-pdf-folder';
        }
        if(!includeDerived&&lower==='_rendered_pages'){
            return 'derived-render-cache';
        }
        if(!includeWorkspaceArtifacts&&(
            WORKSPACE_DIRECTORY_NAMES.has(lower)
            ||/^qa(?:$|[-_])/u.test(lower)
            ||/^tmp(?:$|[-_])/u.test(lower)
        )){
            return 'workspace-artifact';
        }
    }

    const fileName=segments.at(-1).toLowerCase();
    if(JUNK_FILE_NAMES.has(fileName)||fileName.startsWith('~$')||fileName.endsWith('.tmp')){
        return 'junk-file';
    }

    return '';
}

function shouldSkipImportPath(path='',options={}){
    return Boolean(importSkipReason(path,options));
}

function indexOfSegment(segments,name){
    const lower=name.toLowerCase();
    return segments.findIndex(segment=>segment.toLowerCase()===lower);
}

function canonicalExistingPath(normalized=''){
    const segments=normalized.split('/');
    const filingIndex=indexOfSegment(segments,CASE_FOLDERS.filingRoot);
    if(filingIndex>=0){
        const tail=segments.slice(filingIndex+1);
        if(!tail.length){
            return CASE_FOLDERS.filingRoot;
        }
        const branch=tail.shift().toLowerCase();
        if(branch==='pdf'){
            return [CASE_FOLDERS.filingPdf,...tail].join('/');
        }
        if(branch==='md'){
            return [CASE_FOLDERS.filingMarkdown,...tail].join('/');
        }
        return [CASE_FOLDERS.filingRoot,branch,...tail].join('/');
    }

    const evidenceIndex=indexOfSegment(segments,CASE_FOLDERS.evidenceRoot);
    if(evidenceIndex>=0){
        const tail=segments.slice(evidenceIndex+1);
        if(!tail.length){
            return CASE_FOLDERS.evidenceRoot;
        }
        const branch=tail.shift().toLowerCase();
        if(branch==='raw'||branch==='files'){
            return [CASE_FOLDERS.evidenceRaw,...tail].join('/');
        }
        if(branch==='md'){
            return [CASE_FOLDERS.evidenceMarkdown,...tail].join('/');
        }
        return [CASE_FOLDERS.evidenceRoot,branch,...tail].join('/');
    }

    return null;
}

function targetFolder(target=''){
    switch(String(target).toLowerCase()){
        case 'filing':
        case 'filings':
        case 'filing-pdf':
        case 'filing-raw':
            return CASE_FOLDERS.filingPdf;
        case 'filing-markdown':
        case 'filing-md':
            return CASE_FOLDERS.filingMarkdown;
        case 'evidence':
        case 'evidence-raw':
        case 'raw':
            return CASE_FOLDERS.evidenceRaw;
        case 'evidence-markdown':
        case 'evidence-md':
            return CASE_FOLDERS.evidenceMarkdown;
        default:
            return '';
    }
}

/**
 * Map a dropped relative path into the canonical case tree. Unknown loose
 * evidence requires an explicit evidence target; this prevents a whole-case
 * drop from accidentally ingesting QA and report work product as evidence.
 */
function canonicalImportPath(path='',{
    target='auto',
    includeDerived=false,
    includeMerged=false,
    includeWorkspaceArtifacts=false
}={}){
    const normalized=normalizeRelativePath(path);
    if(shouldSkipImportPath(normalized,{
        includeDerived,
        includeMerged,
        includeWorkspaceArtifacts
    })){
        return null;
    }

    const existing=canonicalExistingPath(normalized);
    if(existing){
        return existing;
    }

    const segments=normalized.split('/');
    const first=segments[0]?.toLowerCase();
    if(first==='pdf'&&segments.length>1){
        return [CASE_FOLDERS.filingPdf,...segments.slice(1)].join('/');
    }
    if(first==='md'&&segments.length>1){
        return [CASE_FOLDERS.filingMarkdown,...segments.slice(1)].join('/');
    }
    if((first==='raw'||first==='files')&&segments.length>1){
        return [CASE_FOLDERS.evidenceRaw,...segments.slice(1)].join('/');
    }

    const explicitFolder=targetFolder(target);
    if(explicitFolder){
        return `${explicitFolder}/${normalized}`;
    }

    const parsed=parseFilingFileName(normalized);
    const extension=extensionOf(normalized);
    if(parsed&&extension==='.pdf'){
        return `${CASE_FOLDERS.filingPdf}/${parsed.fileName}`;
    }
    if(parsed&&extension===MARKDOWN_EXTENSION){
        return `${CASE_FOLDERS.filingMarkdown}/${parsed.fileName}`;
    }

    return null;
}

function classification(kind,path,extras={}){
    const extension=extensionOf(path);
    const result={
        kind,
        type:kind,
        path,
        canonicalPath:path,
        name:path.split('/').at(-1)||'',
        extension,
        bucket:'other',
        role:'other',
        skipped:false,
        skipReason:'',
        ...extras
    };
    return result;
}

function classifyCasePath(path='',options={}){
    const normalized=normalizeRelativePath(path);
    const canonical=canonicalExistingPath(normalized)||normalized;
    const lower=canonical.toLowerCase();
    const reason=importSkipReason(normalized,options);

    if(lower.includes('/md/_rendered_pages/')||lower.endsWith('/md/_rendered_pages')){
        return classification('filing-render',canonical,{
            bucket:'filing',
            role:'derived',
            skipped:!options.includeDerived,
            skipReason:options.includeDerived?'':'derived-render-cache'
        });
    }

    if(reason){
        return classification('skipped',canonical,{skipped:true,skipReason:reason});
    }

    if(lower===CASE_FOLDERS.filingRoot.toLowerCase()
        ||lower===CASE_FOLDERS.filingPdf.toLowerCase()
        ||lower===CASE_FOLDERS.filingMarkdown.toLowerCase()){
        return classification('case-directory',canonical,{bucket:'filing',role:'directory'});
    }
    if(lower===CASE_FOLDERS.evidenceRoot.toLowerCase()
        ||lower===CASE_FOLDERS.evidenceRaw.toLowerCase()
        ||lower===CASE_FOLDERS.evidenceMarkdown.toLowerCase()){
        return classification('case-directory',canonical,{bucket:'evidence',role:'directory'});
    }
    if(lower.startsWith(`${CASE_FOLDERS.filingPdf.toLowerCase()}/`)){
        const parsed=parseFilingFileName(canonical);
        return classification(extensionOf(canonical)==='.pdf'?'filing-pdf':'filing-unsupported',canonical,{
            bucket:'filing',
            role:'raw',
            parsedFiling:parsed
        });
    }
    if(lower.startsWith(`${CASE_FOLDERS.filingMarkdown.toLowerCase()}/`)){
        return classification(extensionOf(canonical)===MARKDOWN_EXTENSION?'filing-markdown':'filing-unsupported',canonical,{
            bucket:'filing',
            role:'description',
            parsedFiling:parseFilingFileName(canonical)
        });
    }
    if(lower.startsWith(`${CASE_FOLDERS.evidenceRaw.toLowerCase()}/`)){
        return classification('evidence-raw',canonical,{bucket:'evidence',role:'raw'});
    }
    if(lower.startsWith(`${CASE_FOLDERS.evidenceMarkdown.toLowerCase()}/`)){
        return classification(extensionOf(canonical)===MARKDOWN_EXTENSION?'evidence-markdown':'evidence-unsupported',canonical,{
            bucket:'evidence',
            role:'description'
        });
    }

    return classification('other',canonical);
}

function companionPathFor(path='',options={}){
    const canonical=canonicalImportPath(path,options);
    if(!canonical){
        return null;
    }

    const info=classifyCasePath(canonical,{...options,includeDerived:true});
    if(info.kind==='filing-pdf'){
        const relative=canonical.slice(CASE_FOLDERS.filingPdf.length+1);
        return `${CASE_FOLDERS.filingMarkdown}/${replaceExtension(relative)}`;
    }
    if(info.kind==='evidence-raw'){
        const relative=canonical.slice(CASE_FOLDERS.evidenceRaw.length+1);
        return `${CASE_FOLDERS.evidenceMarkdown}/${replaceExtension(relative)}`;
    }
    return null;
}

function pathFromEntry(entry){
    if(typeof entry==='string'){
        return entry;
    }
    if(entry&&typeof entry==='object'){
        return entry.path||entry.relativePath||entry.webkitRelativePath||entry.name||'';
    }
    throw new TypeError('Case entries must be path strings or objects containing a path.');
}

function pairCaseCompanions(entries=[],options={}){
    if(!Array.isArray(entries)){
        throw new TypeError('Companion pairing requires an array of case entries.');
    }

    const records=[];
    for(const entry of entries){
        const originalPath=pathFromEntry(entry);
        const canonical=canonicalImportPath(originalPath,options);
        if(canonical){
            records.push({entry,path:canonical,classification:classifyCasePath(canonical)});
        }
    }

    const byPath=new Map(records.map(record=>[record.path.toLowerCase(),record]));
    const descriptions=new Set(
        records
            .filter(record=>record.classification.role==='description')
            .map(record=>record.path.toLowerCase())
    );
    const pairedDescriptionPaths=new Set();
    const pairs=[];

    for(const record of records){
        if(record.classification.role!=='raw'){
            continue;
        }
        const expectedPath=companionPathFor(record.path);
        const companion=expectedPath?byPath.get(expectedPath.toLowerCase())||null:null;
        if(companion){
            pairedDescriptionPaths.add(companion.path.toLowerCase());
        }
        pairs.push({
            source:record.entry,
            sourcePath:record.path,
            companion:companion?.entry||null,
            companionPath:expectedPath,
            hasCompanion:Boolean(companion)
        });
    }

    const orphanCompanions=records
        .filter(record=>descriptions.has(record.path.toLowerCase()))
        .filter(record=>!pairedDescriptionPaths.has(record.path.toLowerCase()))
        .map(record=>({entry:record.entry,path:record.path}));

    return {
        pairs,
        missingCompanions:pairs.filter(pair=>!pair.hasCompanion),
        orphanCompanions
    };
}

function sanitizeEvidencePart(value='',{actor=false}={}){
    let result=String(value)
        .normalize('NFC')
        .replace(/[\u0000-\u001f\u007f]/gu,' ')
        .replace(/[<>:"/\\|?*]/gu,' ')
        .replace(actor?/[[\]]/gu:/$^/gu,' ')
        .replace(/\s+/gu,' ')
        .trim()
        .replace(/[. ]+$/gu,'');
    if(actor){
        result=result.toUpperCase();
    }
    return result;
}

function evidenceDateToken(value){
    if(value===undefined||value===null||value===''){
        return null;
    }

    if(value instanceof Date){
        if(Number.isNaN(value.getTime())){
            throw new TypeError('Evidence date is invalid.');
        }
        const year=String(value.getUTCFullYear()).padStart(4,'0');
        const month=String(value.getUTCMonth()+1).padStart(2,'0');
        const day=String(value.getUTCDate()).padStart(2,'0');
        return `${year.slice(-2)}-${month}-${day}`;
    }

    const string=String(value).trim();
    const match=/^(?:(\d{4})|(\d{2}))-(\d{2})-(\d{2})$/u.exec(string);
    if(!match){
        throw new TypeError('Evidence date must be YYYY-MM-DD, YY-MM-DD, a Date, or blank.');
    }

    const year=match[1]?Number(match[1]):2000+Number(match[2]);
    const month=Number(match[3]);
    const day=Number(match[4]);
    if(!isCalendarDate(year,month,day)){
        throw new TypeError('Evidence date is invalid.');
    }
    return `${String(year).slice(-2)}-${match[3]}-${match[4]}`;
}

function normalizedExtension(extension='',originalName=''){
    let candidate=extension||extensionOf(originalName);
    if(!candidate){
        return '';
    }
    candidate=String(candidate).trim().toLowerCase();
    if(!candidate.startsWith('.')){
        candidate=`.${candidate}`;
    }
    if(!/^\.[a-z0-9][a-z0-9._-]*$/u.test(candidate)){
        throw new TypeError('Evidence extension is invalid.');
    }
    return candidate;
}

/** Build a grounded evidence filename. A missing date is explicit, never guessed. */
function buildEvidenceFileName({
    date=null,
    who='',
    actors=null,
    people=null,
    sourceActor='',
    description='',
    what='',
    title='',
    extension='',
    originalName='',
    copyNumber=null
}={}){
    const actorValue=actors??people??(who||sourceActor);
    const actorList=Array.isArray(actorValue)?actorValue:[actorValue];
    const actorText=sanitizeEvidencePart(actorList.filter(Boolean).join(' AND '),{actor:true});
    let descriptionText=sanitizeEvidencePart(description||what||title);

    if(!actorText){
        throw new TypeError('Evidence naming requires who the evidence concerns or came from.');
    }
    if(!descriptionText){
        throw new TypeError('Evidence naming requires a descriptive what/title.');
    }
    if(copyNumber!==null&&copyNumber!==undefined){
        const number=Number(copyNumber);
        if(!Number.isInteger(number)||number<2){
            throw new TypeError('Evidence copyNumber must be an integer of 2 or greater.');
        }
        if(!COPY_SUFFIX.test(descriptionText)){
            descriptionText+=` Copy ${number}`;
        }
    }

    const dateToken=evidenceDateToken(date);
    const prefix=dateToken?dateToken:'[UNDATED]';
    const suffix=normalizedExtension(extension,originalName);
    return `${prefix} [${actorText}] - ${descriptionText}${suffix}`;
}

function createCaseProfile(overrides={}){
    if(!overrides||typeof overrides!=='object'||Array.isArray(overrides)){
        throw new TypeError('Case profile overrides must be an object.');
    }

    const jurisdiction=overrides.jurisdiction&&typeof overrides.jurisdiction==='object'
        ?overrides.jurisdiction
        :{};
    const court=overrides.court&&typeof overrides.court==='object'
        ?overrides.court
        :{};
    const matterTypes=overrides.matterTypes
        ||(overrides.matterType?[overrides.matterType]:[]);
    const matterTypeList=Array.isArray(matterTypes)?matterTypes:[matterTypes];

    return {
        title:overrides.title||overrides.displayName||'',
        caseNumber:overrides.caseNumber||'',
        matterTypes:matterTypeList.filter(Boolean),
        status:overrides.status||'active',
        court:{
            name:court.name||overrides.courtName||'',
            type:court.type||overrides.courtType||'',
            division:court.division||overrides.division||''
        },
        jurisdiction:{
            country:jurisdiction.country||'',
            stateProvince:jurisdiction.stateProvince||jurisdiction.state||'',
            countyMunicipality:jurisdiction.countyMunicipality||jurisdiction.county||'',
            locality:jurisdiction.locality||'',
            level:jurisdiction.level||''
        },
        parties:[...(overrides.parties||[])],
        counsel:[...(overrides.counsel||[])],
        contacts:[...(overrides.contacts||[])],
        tags:[...(overrides.tags||[])]
    };
}

function slug(value=''){
    return String(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/gu,'')
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu,'-')
        .replace(/^-+|-+$/gu,'')
        .slice(0,96);
}

/** Create a deterministic default case record; callers supply timestamps/IDs. */
function createCaseRecord(input={}){
    if(!input||typeof input!=='object'||Array.isArray(input)){
        throw new TypeError('Case record input must be an object.');
    }

    const profile=createCaseProfile(input.profile||input);
    const caseNumber=input.caseNumber||profile.caseNumber;
    const title=input.title||input.displayName||profile.title||caseNumber||'Untitled legal matter';
    profile.title=profile.title||title;
    profile.caseNumber=profile.caseNumber||caseNumber;
    const id=input.id||slug(caseNumber||title)||'case';
    const storageBackend=input.storageBackend||input.storage?.backend||'dbopfs';

    return {
        id,
        schemaVersion:CASE_SCHEMA_VERSION,
        caseNumber,
        title,
        status:input.status||profile.status||'active',
        profile,
        folders:{...CASE_FOLDERS},
        storageBackend,
        storage:{...(input.storage||{}),backend:storageBackend},
        files:[...(input.files||[])],
        jobs:[...(input.jobs||[])],
        createdAt:input.createdAt||'',
        updatedAt:input.updatedAt||input.createdAt||''
    };
}

function compareNodes(left,right){
    if(left.kind!==right.kind){
        return left.kind==='directory'?-1:1;
    }
    return left.name.localeCompare(right.name,undefined,{numeric:true,sensitivity:'base'});
}

function buildCaseTree(entries=[],{
    includeCanonicalFolders=true,
    includeSkipped=false
}={}){
    if(!Array.isArray(entries)){
        throw new TypeError('Case tree entries must be an array.');
    }

    const root={name:'',path:'',kind:'directory',type:'directory',children:[]};
    const nodes=new Map([['',root]]);

    function ensureDirectory(path){
        if(nodes.has(path.toLowerCase())){
            const existing=nodes.get(path.toLowerCase());
            if(existing.kind!=='directory'){
                throw new Error(`A file blocks directory path ${path}.`);
            }
            return existing;
        }
        const segments=path.split('/');
        const name=segments.pop();
        const parentPath=segments.join('/');
        const parent=ensureDirectory(parentPath);
        const node={name,path,kind:'directory',type:'directory',children:[]};
        parent.children.push(node);
        nodes.set(path.toLowerCase(),node);
        return node;
    }

    if(includeCanonicalFolders){
        for(const path of [
            CASE_FOLDERS.filingPdf,
            CASE_FOLDERS.filingMarkdown,
            CASE_FOLDERS.evidenceRaw,
            CASE_FOLDERS.evidenceMarkdown
        ]){
            ensureDirectory(path);
        }
    }

    for(const entry of entries){
        const path=normalizeRelativePath(pathFromEntry(entry));
        const isDirectory=typeof entry==='object'&&Boolean(
            entry.isDirectory||entry.kind==='directory'||entry.type==='directory'
        );
        if(!includeSkipped&&shouldSkipImportPath(path)){
            continue;
        }
        if(isDirectory){
            ensureDirectory(path);
            continue;
        }

        const segments=path.split('/');
        const name=segments.pop();
        const parentPath=segments.join('/');
        const parent=ensureDirectory(parentPath);
        const key=path.toLowerCase();
        const existing=nodes.get(key);
        if(existing){
            if(existing.kind==='directory'){
                throw new Error(`A directory blocks file path ${path}.`);
            }
            continue;
        }

        const info=classifyCasePath(path);
        const node={
            name,
            path,
            kind:'file',
            type:'file',
            caseKind:info.kind,
            classification:info,
            record:typeof entry==='string'?null:{...entry}
        };
        parent.children.push(node);
        nodes.set(key,node);
    }

    function sortTree(node){
        node.children.sort(compareNodes);
        for(const child of node.children){
            if(child.kind==='directory'){
                sortTree(child);
            }
        }
    }
    sortTree(root);
    return root;
}

export {
    CASE_FOLDERS,
    CASE_SCHEMA_VERSION,
    buildCaseTree,
    buildEvidenceFileName,
    canonicalImportPath,
    classifyCasePath,
    companionPathFor,
    createCaseProfile,
    createCaseRecord,
    importSkipReason,
    normalizeRelativePath,
    pairCaseCompanions,
    parseFilingFileName,
    shouldSkipImportPath
};
