#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {
    copyFile,
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    stat,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const SCRIPT_DIRECTORY=path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT=path.resolve(SCRIPT_DIRECTORY,'..');
const REPOSITORY_ROOT=path.resolve(APP_ROOT,'..','..');
const DIST_ROOT=path.join(REPOSITORY_ROOT,'dist');
const DEFAULT_OUTPUT_ROOT=path.join(DIST_ROOT,'boss');
const FULL_CORPUS_ROOT=path.join(APP_ROOT,'documents');
const SOURCE_ROOT=path.join(APP_ROOT,'business docs');
const SOURCE_MANIFEST_PATH=path.join(FULL_CORPUS_ROOT,'document-manifest.json');
const RELEASE_LOCK_PATH=path.join(APP_ROOT,'public-release-lock.json');
const EXPECTED_PUBLIC_RECORDS=500;
const PUBLIC_FILE_BYTE_LIMIT=95_000_000;
const RELEASE_BUILDER='boss-public-release-v1';
const RELEASE_INVENTORY_FILES=new Set([
    'ARCANE_APP_RELEASE.json',
    'PUBLIC_RELEASE.json'
]);

const APP_FILE_ALLOWLIST=[
    'admin.html',
    'boss-library.js',
    'boss.css',
    'chat.html',
    'export.html',
    'import.html',
    'library-setup.html',
    'library.html',
    'manifest.json'
];

const APP_DIRECTORY_ALLOWLIST=[
    'components',
    'img',
    'prompts'
];

const PUBLIC_RECORD_FIELDS=[
    'access',
    'category',
    'contacts',
    'document_path',
    'guardrails',
    'id',
    'key_information',
    'keywords',
    'lifecycle_stages',
    'links',
    'next_handoff',
    'organizations',
    'output',
    'people',
    'search_text',
    'sensitive',
    'slug',
    'source_bytes',
    'source_extension',
    'source_mime',
    'source_path',
    'source_url',
    'summary',
    'title',
    'topics',
    'when_to_surface'
];

const TEXT_EXTENSIONS=new Set([
    '.css',
    '.html',
    '.js',
    '.json',
    '.md',
    '.svg',
    '.txt'
]);

function parseArguments(argv){
    const options={
        check:false,
        lockOnly:false,
        refreshLock:false,
        outputRoot:DEFAULT_OUTPUT_ROOT
    };

    for(let index=0;index<argv.length;index++){
        const argument=argv[index];

        if(argument==='--check'){
            options.check=true;
        }else if(argument==='--refresh-lock'){
            options.refreshLock=true;
        }else if(argument==='--refresh-lock-only'){
            options.refreshLock=true;
            options.lockOnly=true;
        }else if(argument==='--output'){
            const value=argv[++index];

            if(!value){
                throw new Error('--output requires a directory path.');
            }

            options.outputRoot=path.resolve(value);
        }else{
            throw new Error(`Unknown argument: ${argument}`);
        }
    }

    if(options.lockOnly&&options.check){
        throw new Error('--refresh-lock-only cannot be combined with --check.');
    }

    return options;
}

function assertSafeOutputRoot(outputRoot){
    const resolved=path.resolve(outputRoot);
    const relative=path.relative(DIST_ROOT,resolved);

    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)){
        throw new Error(
            `Public output must be a child of ${DIST_ROOT}; received ${resolved}`
        );
    }

    return resolved;
}

async function assertSafeOutputBoundary(outputRoot){
    const safeOutputRoot=assertSafeOutputRoot(outputRoot);
    const repositoryInfo=await lstat(REPOSITORY_ROOT);

    if(repositoryInfo.isSymbolicLink()||!repositoryInfo.isDirectory()){
        throw new Error('The BOSS repository root must be a real directory.');
    }

    try{
        await mkdir(DIST_ROOT);
    }catch(error){
        if(error?.code!=='EEXIST'){
            throw error;
        }
    }

    const distInfo=await lstat(DIST_ROOT);

    if(distInfo.isSymbolicLink()||!distInfo.isDirectory()){
        throw new Error('The BOSS dist boundary must be a real directory, not a link or junction.');
    }

    const [realRepositoryRoot,realDistRoot]=await Promise.all([
        realpath(REPOSITORY_ROOT),
        realpath(DIST_ROOT)
    ]);
    const distRelative=path.relative(realRepositoryRoot,realDistRoot);

    if(!distRelative||distRelative.startsWith('..')||path.isAbsolute(distRelative)){
        throw new Error('The BOSS dist boundary resolves outside the repository.');
    }

    try{
        const outputInfo=await lstat(safeOutputRoot);

        if(outputInfo.isSymbolicLink()||!outputInfo.isDirectory()){
            throw new Error('The BOSS public output must be a real directory, not a link or junction.');
        }

        const realOutputRoot=await realpath(safeOutputRoot);
        const outputRelative=path.relative(realDistRoot,realOutputRoot);

        if(!outputRelative||outputRelative.startsWith('..')||path.isAbsolute(outputRelative)){
            throw new Error('The BOSS public output resolves outside dist.');
        }
    }catch(error){
        if(error?.code!=='ENOENT'){
            throw error;
        }
    }

    return safeOutputRoot;
}

function normalizeRelativePath(value=''){
    return String(value).replaceAll('\\','/').replace(/^\.\//,'');
}

function assertSafeRelativePath(value,label='path'){
    const normalized=normalizeRelativePath(value);
    const segments=normalized.split('/');

    if(!normalized
        ||path.posix.isAbsolute(normalized)
        ||segments.some(segment=>!segment||segment==='.'||segment==='..')){
        throw new Error(`Unsafe ${label}: ${value}`);
    }

    return normalized;
}

function resolveInside(root,relativePath,label='path'){
    const normalized=assertSafeRelativePath(relativePath,label);
    const resolved=path.resolve(root,...normalized.split('/'));
    const relative=path.relative(path.resolve(root),resolved);

    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)){
        throw new Error(`${label} leaves its allowed root: ${relativePath}`);
    }

    return resolved;
}

async function readJson(filePath){
    return JSON.parse(await readFile(filePath,'utf8'));
}

async function sha256(filePath){
    const hash=createHash('sha256');
    const handle=await open(filePath,'r');
    const buffer=Buffer.allocUnsafe(1024*1024);

    try{
        while(true){
            const {bytesRead}=await handle.read(buffer,0,buffer.length,null);

            if(bytesRead===0){
                break;
            }

            hash.update(buffer.subarray(0,bytesRead));
        }
    }finally{
        await handle.close();
    }

    return hash.digest('hex');
}

async function copyAllowlistedTree(source,destination){
    const sourceInfo=await lstat(source);

    if(sourceInfo.isSymbolicLink()){
        throw new Error(`Refusing to publish symbolic link: ${source}`);
    }

    if(sourceInfo.isDirectory()){
        await mkdir(destination,{recursive:true});
        const entries=await readdir(source,{withFileTypes:true});

        for(const entry of entries.sort((left,right)=>
            left.name.localeCompare(right.name,'en')
        )){
            await copyAllowlistedTree(
                path.join(source,entry.name),
                path.join(destination,entry.name)
            );
        }

        return;
    }

    if(!sourceInfo.isFile()){
        throw new Error(`Refusing to publish non-file entry: ${source}`);
    }

    await mkdir(path.dirname(destination),{recursive:true});
    await copyFile(source,destination);
}

function publicCandidates(manifest){
    const records=Array.isArray(manifest?.records)?manifest.records:[];

    return records.filter(record=>
        record?.access==='public'&&record?.sensitive!==true
    ).sort((left,right)=>left.id.localeCompare(right.id,'en'));
}

function releaseLockFor(manifest){
    const records=publicCandidates(manifest).map(record=>({
        id:record.id,
        output:record.output,
        output_sha256:record.output_sha256,
        source_path:record.source_path,
        source_sha256:record.source_sha256
    }));

    if(records.length!==EXPECTED_PUBLIC_RECORDS){
        throw new Error(
            `Expected ${EXPECTED_PUBLIC_RECORDS} public records, found ${records.length}.`
        );
    }

    return {
        schema_version:1,
        purpose:'Explicit content lock for the BOSS public website release.',
        source_manifest_version:manifest.manifest_version,
        record_count:records.length,
        records
    };
}

async function refreshReleaseLock(manifest){
    const releaseLock=releaseLockFor(manifest);

    await writeFile(
        RELEASE_LOCK_PATH,
        `${JSON.stringify(releaseLock,null,2)}\n`,
        'utf8'
    );

    return releaseLock;
}

function validateReleaseLock(manifest,releaseLock){
    const expected=releaseLockFor(manifest);

    if(releaseLock?.record_count!==EXPECTED_PUBLIC_RECORDS
        ||!Array.isArray(releaseLock?.records)){
        throw new Error('The BOSS public release lock is malformed.');
    }

    if(JSON.stringify(expected.records)!==JSON.stringify(releaseLock.records)){
        throw new Error(
            'Public content changed. Review the corpus and run with --refresh-lock before publishing.'
        );
    }

    const allRecords=Array.isArray(manifest?.records)?manifest.records:[];
    const byId=new Map(allRecords.map(record=>[record.id,record]));

    for(const entry of releaseLock.records){
        const record=byId.get(entry.id);

        if(!record||record.access!=='public'||record.sensitive===true){
            throw new Error(`Release lock includes a non-public record: ${entry.id}`);
        }
    }

    return releaseLock.records.map(entry=>byId.get(entry.id));
}

function projectPublicRecord(record){
    const projected={};

    for(const field of PUBLIC_RECORD_FIELDS){
        if(Object.hasOwn(record,field)){
            projected[field]=record[field];
        }
    }

    projected.access='public';
    projected.sensitive=false;
    projected.source_path=assertSafeRelativePath(
        projected.source_path,
        `source path for ${record.id}`
    );
    projected.output=assertSafeRelativePath(
        projected.output,
        `Markdown output for ${record.id}`
    );
    projected.document_path=`./${projected.output}`;

    return projected;
}

function yamlScalar(value){
    return JSON.stringify(value??'',null,0);
}

function markdownList(values=[],empty='No additional details were recorded.'){
    const items=Array.isArray(values)?values.filter(Boolean):[];

    if(!items.length){
        return `- ${empty}`;
    }

    return items.map(value=>`- ${String(value).replaceAll('\n',' ')}`).join('\n');
}

function renderPublicRecord(record){
    const organizations=Array.isArray(record.organizations)
        ?record.organizations
        :[];
    const people=Array.isArray(record.people)?record.people:[];
    const links=[
        ...new Set([
            record.source_url,
            ...(Array.isArray(record.links)?record.links:[])
        ].filter(Boolean))
    ];
    const contacts=Array.isArray(record.contacts)?record.contacts:[];
    const peopleAndLinks=[];

    if(organizations.length){
        peopleAndLinks.push(`- Organizations: ${organizations.join(', ')}`);
    }

    if(people.length){
        peopleAndLinks.push(`- People named for routing: ${people.join(', ')}`);
    }

    for(const link of links){
        peopleAndLinks.push(`- Link: <${link}>`);
    }

    for(const contact of contacts){
        peopleAndLinks.push(`- Contact: ${String(contact).replaceAll('\n',' ')}`);
    }

    if(!peopleAndLinks.length){
        peopleAndLinks.push('- No public contact or external link was recorded.');
    }

    return [
        '---',
        `id: ${yamlScalar(record.id)}`,
        `title: ${yamlScalar(record.title)}`,
        `access: ${yamlScalar('public')}`,
        `category: ${yamlScalar(record.category)}`,
        `topics: ${yamlScalar(record.topics||[])}`,
        `lifecycle_stages: ${yamlScalar(record.lifecycle_stages||[])}`,
        `organizations: ${yamlScalar(organizations)}`,
        '---',
        '',
        `# ${record.title}`,
        '',
        '> BOSS Libraries public routing record. Use it to find the right source, link, organization, or person.',
        '',
        '## Description',
        '',
        record.summary||'No concise public description was recorded.',
        '',
        '## When to surface',
        '',
        record.when_to_surface||'Surface this record when its topic matches the user\'s request.',
        '',
        '## Key information',
        '',
        markdownList(record.key_information),
        '',
        '## People and links',
        '',
        peopleAndLinks.join('\n'),
        '',
        '## Next handoff',
        '',
        record.next_handoff||'Open the public original or follow the most relevant official link.',
        '',
        '## Guardrails',
        '',
        markdownList(
            record.guardrails,
            'Confirm current requirements with the responsible organization.'
        ),
        '',
        '## Original document',
        '',
        'Use **View original** in the BOSS Library to open or download the approved public source.',
        ''
    ].join('\n');
}

function countBy(records,field){
    const counts=new Map();

    for(const record of records){
        const value=record[field]||'[none]';
        counts.set(value,(counts.get(value)||0)+1);
    }

    return [...counts.entries()].sort((left,right)=>
        String(left[0]).localeCompare(String(right[0]),'en')
    );
}

function renderPublicCatalog(records){
    const categories=countBy(records,'category');
    const formats=countBy(records,'source_extension');
    const lines=[
        '# BOSS Libraries Public Document Catalog',
        '',
        'This catalog contains the public website collection. The librarian retrieves a small set of relevant records, provides useful live links, and routes the user to the right person or organization.',
        '',
        '## Collection summary',
        '',
        `- Public routing records: ${records.length}`,
        `- Approved public originals: ${records.length}`,
        '- Bundled internal records: 0',
        '- Bundled restricted records: 0',
        '- User uploads remain private to browser-managed storage.',
        '',
        '## How BOSS should use these records',
        '',
        '1. Identify the user\'s immediate information need, location, and business stage when relevant.',
        '2. Search titles, summaries, topics, lifecycle stages, organizations, and keywords.',
        '3. Retrieve only the strongest matches.',
        '4. Give the most useful source links and one concise next handoff.',
        '5. Treat user-uploaded documents according to their private access boundary.',
        '',
        '## Source categories',
        '',
        '| Category | Records |',
        '|---|---:|',
        ...categories.map(([label,count])=>`| ${label} | ${count} |`),
        '',
        '## Source formats',
        '',
        '| Format | Records |',
        '|---|---:|',
        ...formats.map(([label,count])=>`| \`${label}\` | ${count} |`),
        ''
    ];

    return lines.join('\n');
}

function renderPublicReport(records,originalBytes){
    return [
        '# BOSS Libraries Public Release Report',
        '',
        `- Builder: \`${RELEASE_BUILDER}\``,
        `- Published public records: ${records.length}`,
        `- Published Markdown descriptions: ${records.length}`,
        `- Published public originals: ${records.length}`,
        `- Public original bytes: ${originalBytes}`,
        '- Bundled internal records: 0',
        '- Bundled restricted records: 0',
        '',
        'The public package is assembled from a per-record content lock. It is not a copy of the working repository or a source directory.',
        ''
    ].join('\n');
}

function manifestVersion(records,contentHashes){
    const payload=records.map(record=>({
        id:record.id,
        output:record.output,
        output_sha256:contentHashes.get(record.output),
        source_path:record.source_path
    }));

    return `sha256:${createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex')}`;
}

async function listFiles(root){
    const files=[];

    async function visit(directory){
        const entries=await readdir(directory,{withFileTypes:true});

        for(const entry of entries.sort((left,right)=>
            left.name.localeCompare(right.name,'en')
        )){
            const absolute=path.join(directory,entry.name);

            if(entry.isSymbolicLink()){
                throw new Error(`Release contains a symbolic link: ${absolute}`);
            }

            if(entry.isDirectory()){
                await visit(absolute);
            }else if(entry.isFile()){
                files.push({
                    absolute,
                    relative:normalizeRelativePath(path.relative(root,absolute))
                });
            }else{
                throw new Error(`Release contains an unsupported entry: ${absolute}`);
            }
        }
    }

    await visit(root);
    return files;
}

async function writeReleaseInventory(root){
    const files=(await listFiles(root)).filter(
        file=>!RELEASE_INVENTORY_FILES.has(file.relative)
    );
    const inventory=[];

    for(const file of files){
        const details=await stat(file.absolute);
        inventory.push({
            path:file.relative,
            bytes:details.size,
            sha256:await sha256(file.absolute)
        });
    }

    await writeFile(
        path.join(root,'PUBLIC_RELEASE.json'),
        `${JSON.stringify({
            schema_version:1,
            builder:RELEASE_BUILDER,
            file_count:inventory.length,
            files:inventory
        },null,2)}\n`,
        'utf8'
    );
}

async function verifyRelease(outputRoot,fullManifest){
    const appOutput=path.join(outputRoot,'apps','boss');
    const documentsRoot=path.join(appOutput,'documents');
    const originalsRoot=path.join(appOutput,'originals');
    const publicManifest=await readJson(
        path.join(documentsRoot,'document-manifest.json')
    );
    const records=Array.isArray(publicManifest.records)
        ?publicManifest.records
        :[];

    if(publicManifest.audience!=='public'
        ||publicManifest.original_root!=='../originals/'
        ||publicManifest.record_count!==EXPECTED_PUBLIC_RECORDS
        ||records.length!==EXPECTED_PUBLIC_RECORDS){
        throw new Error('Public manifest identity or record count is invalid.');
    }

    if(records.some(record=>
        record.access!=='public'
        ||record.sensitive!==false
        ||record.source_sha256
        ||record.output_sha256
        ||record.duplicate_of
    )){
        throw new Error('Public manifest contains a non-public or private-only field.');
    }

    const ids=new Set();
    const outputs=new Set();
    const sourcePaths=new Set();
    const fullRecordsById=new Map(
        (fullManifest?.records||[]).map(record=>[record.id,record])
    );

    for(const record of records){
        if(ids.has(record.id)||outputs.has(record.output)||sourcePaths.has(record.source_path)){
            throw new Error(`Duplicate public release identity: ${record.id}`);
        }

        ids.add(record.id);
        outputs.add(record.output);
        sourcePaths.add(record.source_path);

        const markdownPath=resolveInside(documentsRoot,record.output,'public Markdown');
        const originalPath=resolveInside(originalsRoot,record.source_path,'public original');
        await lstat(markdownPath);
        const originalInfo=await lstat(originalPath);

        if(!originalInfo.isFile()||originalInfo.isSymbolicLink()){
            throw new Error(`Invalid public original: ${record.source_path}`);
        }

        if(originalInfo.size!==record.source_bytes){
            throw new Error(`Public original size mismatch: ${record.source_path}`);
        }

        const lockedSource=fullRecordsById.get(record.id);

        if(!lockedSource
            ||lockedSource.access!=='public'
            ||lockedSource.sensitive===true
            ||await sha256(originalPath)!==lockedSource.source_sha256){
            throw new Error(`Public original hash mismatch: ${record.source_path}`);
        }
    }

    const markdownFiles=(await readdir(documentsRoot)).filter(name=>
        /^bossdoc-.+\.md$/i.test(name)
    );
    const originalFiles=(await listFiles(originalsRoot));

    if(markdownFiles.length!==EXPECTED_PUBLIC_RECORDS
        ||originalFiles.length!==EXPECTED_PUBLIC_RECORDS){
        throw new Error(
            `Release has ${markdownFiles.length} Markdown files and ${originalFiles.length} originals.`
        );
    }

    if(await lstat(path.join(appOutput,'business docs')).then(()=>true,()=>false)){
        throw new Error('The working business-docs tree leaked into the public release.');
    }

    const privateRecords=(fullManifest?.records||[]).filter(record=>
        record.access!=='public'||record.sensitive===true
    );
    const privateTokens=new Set(
        privateRecords.flatMap(record=>[
            record.id,
            record.output,
            normalizeRelativePath(record.source_path)
        ]).filter(Boolean)
    );
    const releaseFiles=await listFiles(outputRoot);
    let maximumFileBytes=0;

    for(const file of releaseFiles){
        const details=await stat(file.absolute);
        maximumFileBytes=Math.max(maximumFileBytes,details.size);

        if(details.size>PUBLIC_FILE_BYTE_LIMIT){
            throw new Error(
                `Public release file exceeds the ${PUBLIC_FILE_BYTE_LIMIT}-byte hosting limit: ${file.relative} (${details.size} bytes)`
            );
        }
    }

    for(const file of releaseFiles){
        const normalizedRelative=file.relative.toLowerCase();

        for(const record of privateRecords){
            if(normalizedRelative===normalizeRelativePath(
                path.join('apps','boss','originals',record.source_path)
            ).toLowerCase()){
                throw new Error(`Private original leaked: ${record.id}`);
            }
        }

        if(!TEXT_EXTENSIONS.has(path.extname(file.absolute).toLowerCase())){
            continue;
        }

        const text=await readFile(file.absolute,'utf8');

        if(/business(?:%20| )docs/i.test(text)){
            throw new Error(`Working source path leaked into ${file.relative}`);
        }

        for(const token of privateTokens){
            if(text.includes(token)){
                throw new Error(`Private corpus token leaked into ${file.relative}`);
            }
        }
    }

    const releaseInventory=await readJson(path.join(outputRoot,'PUBLIC_RELEASE.json'));

    if(!Array.isArray(releaseInventory.files)
        ||releaseInventory.file_count!==releaseInventory.files.length){
        throw new Error('Public release inventory is invalid.');
    }

    const filesWithoutInventory=releaseFiles.filter(
        file=>!RELEASE_INVENTORY_FILES.has(file.relative)
    );
    const inventoryByPath=new Map(
        releaseInventory.files.map(entry=>[entry.path,entry])
    );

    if(inventoryByPath.size!==releaseInventory.files.length
        ||filesWithoutInventory.length!==releaseInventory.files.length){
        throw new Error('Public release inventory does not match the file tree.');
    }

    for(const file of filesWithoutInventory){
        const entry=inventoryByPath.get(file.relative);
        const details=await stat(file.absolute);

        if(!entry
            ||entry.bytes!==details.size
            ||entry.sha256!==await sha256(file.absolute)){
            throw new Error(`Public release inventory mismatch: ${file.relative}`);
        }
    }

    return {
        audience:publicManifest.audience,
        record_count:records.length,
        markdown_count:markdownFiles.length,
        original_count:originalFiles.length,
        original_bytes:records.reduce(
            (total,record)=>total+Number(record.source_bytes||0),
            0
        ),
        maximum_file_bytes:maximumFileBytes,
        file_limit_bytes:PUBLIC_FILE_BYTE_LIMIT,
        inventory_files:releaseInventory.file_count
    };
}

async function buildRelease(
    outputRoot,
    fullManifest,
    records,
    {prepareBase}={}
){
    const temporaryRoot=`${outputRoot}.tmp`;

    assertSafeOutputRoot(temporaryRoot);
    await rm(temporaryRoot,{recursive:true,force:true});
    await mkdir(temporaryRoot,{recursive:true});

    if(prepareBase!==undefined&&typeof prepareBase!=='function'){
        throw new TypeError('prepareBase must be a function when provided.');
    }

    if(prepareBase){
        await prepareBase(temporaryRoot);
    }

    const appOutput=path.join(temporaryRoot,'apps','boss');
    const documentsOutput=path.join(appOutput,'documents');
    const originalsOutput=path.join(appOutput,'originals');
    await mkdir(documentsOutput,{recursive:true});
    await mkdir(originalsOutput,{recursive:true});

    if(!prepareBase){
        for(const name of APP_FILE_ALLOWLIST){
            await copyAllowlistedTree(
                path.join(APP_ROOT,name),
                path.join(appOutput,name)
            );
        }

        for(const name of APP_DIRECTORY_ALLOWLIST){
            await copyAllowlistedTree(
                path.join(APP_ROOT,name),
                path.join(appOutput,name)
            );
        }

        await copyAllowlistedTree(
            path.join(REPOSITORY_ROOT,'arcane'),
            path.join(temporaryRoot,'arcane')
        );
        await copyAllowlistedTree(
            path.join(REPOSITORY_ROOT,'node_modules','strong-type'),
            path.join(temporaryRoot,'node_modules','strong-type')
        );

        await writeFile(
            path.join(temporaryRoot,'index.html'),
            '<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0; url=./apps/boss/chat.html">\n<title>BOSS Libraries</title>\n<a href="./apps/boss/chat.html">Open BOSS Libraries</a>\n',
            'utf8'
        );
    }

    const projectedRecords=[];
    const publicMarkdownHashes=new Map();
    let originalBytes=0;

    for(let index=0;index<records.length;index++){
        const record=records[index];
        const projected=projectPublicRecord(record);
        const sourceMarkdown=resolveInside(
            FULL_CORPUS_ROOT,
            record.output,
            `source Markdown for ${record.id}`
        );
        const sourceOriginal=resolveInside(
            SOURCE_ROOT,
            record.source_path,
            `source original for ${record.id}`
        );
        const markdownInfo=await lstat(sourceMarkdown);
        const originalInfo=await lstat(sourceOriginal);

        if(markdownInfo.isSymbolicLink()||!markdownInfo.isFile()
            ||originalInfo.isSymbolicLink()||!originalInfo.isFile()){
            throw new Error(`Release source is not a regular file: ${record.id}`);
        }

        if(await sha256(sourceMarkdown)!==record.output_sha256
            ||await sha256(sourceOriginal)!==record.source_sha256){
            throw new Error(`Source hash changed for public record: ${record.id}`);
        }

        const markdownDestination=resolveInside(
            documentsOutput,
            projected.output,
            `published Markdown for ${record.id}`
        );
        const originalDestination=resolveInside(
            originalsOutput,
            projected.source_path,
            `published original for ${record.id}`
        );
        const publicMarkdown=renderPublicRecord(projected);
        await mkdir(path.dirname(markdownDestination),{recursive:true});
        await writeFile(markdownDestination,publicMarkdown,'utf8');
        await mkdir(path.dirname(originalDestination),{recursive:true});
        await copyFile(sourceOriginal,originalDestination);

        publicMarkdownHashes.set(projected.output,await sha256(markdownDestination));
        originalBytes+=originalInfo.size;
        projectedRecords.push(projected);

        if((index+1)%50===0||index+1===records.length){
            console.error(`Published ${index+1}/${records.length} public records`);
        }
    }

    const publicManifest={
        schema_version:1,
        manifest_version:manifestVersion(projectedRecords,publicMarkdownHashes),
        builder_version:RELEASE_BUILDER,
        audience:'public',
        original_root:'../originals/',
        record_count:projectedRecords.length,
        catalog:'000-boss-library-catalog.md',
        conversion_report:'CONVERSION_REPORT.md',
        records:projectedRecords
    };

    await writeFile(
        path.join(documentsOutput,'000-boss-library-catalog.md'),
        renderPublicCatalog(projectedRecords),
        'utf8'
    );
    await writeFile(
        path.join(documentsOutput,'CONVERSION_REPORT.md'),
        renderPublicReport(projectedRecords,originalBytes),
        'utf8'
    );
    await writeFile(
        path.join(documentsOutput,'document-manifest.json'),
        `${JSON.stringify(publicManifest,null,2)}\n`,
        'utf8'
    );
    await writeReleaseInventory(temporaryRoot);
    const verification=await verifyRelease(temporaryRoot,fullManifest);

    await rm(outputRoot,{recursive:true,force:true});
    await rename(temporaryRoot,outputRoot);
    return verification;
}

async function lockedReleaseInputs(){
    const fullManifest=await readJson(SOURCE_MANIFEST_PATH);
    const releaseLock=await readJson(RELEASE_LOCK_PATH);
    const records=validateReleaseLock(fullManifest,releaseLock);

    return {fullManifest,records};
}

export async function buildArcanePackage({
    outputRoot=DEFAULT_OUTPUT_ROOT,
    prepareBase
}={}){
    const safeOutputRoot=await assertSafeOutputBoundary(outputRoot);
    const {fullManifest,records}=await lockedReleaseInputs();

    return buildRelease(
        safeOutputRoot,
        fullManifest,
        records,
        {prepareBase}
    );
}

export async function verifyArcanePackage({
    outputRoot=DEFAULT_OUTPUT_ROOT
}={}){
    const safeOutputRoot=await assertSafeOutputBoundary(outputRoot);
    const {fullManifest}=await lockedReleaseInputs();

    return verifyRelease(safeOutputRoot,fullManifest);
}

async function main(){
    const options=parseArguments(process.argv.slice(2));
    const outputRoot=assertSafeOutputRoot(options.outputRoot);
    const fullManifest=await readJson(SOURCE_MANIFEST_PATH);
    let releaseLock;

    if(options.refreshLock){
        releaseLock=await refreshReleaseLock(fullManifest);
        console.log(`Refreshed public release lock with ${releaseLock.record_count} records.`);
    }else{
        releaseLock=await readJson(RELEASE_LOCK_PATH);
    }

    if(options.lockOnly){
        return;
    }

    const records=validateReleaseLock(fullManifest,releaseLock);

    if(path.resolve(outputRoot)===path.resolve(DEFAULT_OUTPUT_ROOT)){
        const {packageApp,verifyApp}=await import('../../../tools/app-packager/core.mjs');
        const result=options.check
            ?await verifyApp({workspaceRoot:REPOSITORY_ROOT,appId:'boss'})
            :await packageApp({workspaceRoot:REPOSITORY_ROOT,appId:'boss'});
        console.log(JSON.stringify(result,null,2));
        return;
    }

    await assertSafeOutputBoundary(outputRoot);

    if(options.check){
        const result=await verifyRelease(outputRoot,fullManifest);
        console.log(JSON.stringify(result,null,2));
        return;
    }

    const result=await buildRelease(outputRoot,fullManifest,records);
    console.log(JSON.stringify(result,null,2));
}

const isDirectExecution=Boolean(
    process.argv[1]
    &&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url
);

if(isDirectExecution){
    main().catch(error=>{
        console.error(error?.stack||error);
        process.exitCode=1;
    });
}
