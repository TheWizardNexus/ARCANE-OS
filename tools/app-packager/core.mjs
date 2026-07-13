import {createHash,randomBytes} from 'node:crypto';
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
import {pathToFileURL} from 'node:url';

export const ROOT_CONFIG_NAME='arcane-packager.json';
export const APP_CONFIG_NAME='arcane-package.json';
export const RELEASE_MANIFEST_NAME='ARCANE_APP_RELEASE.json';
export const PACKAGER_VERSION='arcane-app-packager-v1';

const APP_ID_PATTERN=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SAFE_SHARED_ID_PATTERN=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const WINDOWS_RESERVED_NAME=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const FORBIDDEN_SEGMENTS=new Set([
    '.agents',
    '.codex',
    '.git',
    'dist',
    'local'
]);
const TEXT_CONTROL_PATTERN=/[\x00-\x1f\x7f]/;

function fail(message){
    throw new Error(message);
}

function isPlainObject(value){
    return value!==null
        &&typeof value==='object'
        &&Object.getPrototypeOf(value)===Object.prototype;
}

function compareText(left,right){
    return String(left).localeCompare(String(right),'en');
}

function assertOnlyKeys(value,allowed,label){
    if(!isPlainObject(value)){
        fail(`${label} must be a JSON object.`);
    }

    for(const key of Object.keys(value)){
        if(!allowed.has(key)){
            fail(`${label} has an unsupported key: ${key}`);
        }
    }
}

function normalizeWorkspaceRoot(workspaceRoot){
    if(typeof workspaceRoot!=='string'||!workspaceRoot.trim()){
        fail('workspaceRoot must be a directory path.');
    }

    return path.resolve(workspaceRoot);
}

export function normalizeRelativePath(value,label='path'){
    if(typeof value!=='string'||!value||value.includes('\\')||TEXT_CONTROL_PATTERN.test(value)){
        fail(`Unsafe ${label}: ${String(value)}`);
    }

    if(path.posix.isAbsolute(value)||/^[a-z]:/i.test(value)){
        fail(`Unsafe ${label}: ${value}`);
    }

    const segments=value.split('/');

    for(const segment of segments){
        if(!segment||segment==='.'||segment==='..'||segment.includes(':')
            ||segment.endsWith('.')||segment.endsWith(' ')
            ||WINDOWS_RESERVED_NAME.test(segment)){
            fail(`Unsafe ${label}: ${value}`);
        }
    }

    return segments.join('/');
}

function normalizeRelativeRoot(value,label){
    if(value==='.'){
        return '.';
    }

    return normalizeRelativePath(value,label);
}

function isInside(root,candidate,{allowEqual=false}={}){
    const relative=path.relative(path.resolve(root),path.resolve(candidate));
    return (allowEqual&&relative==='')
        ||Boolean(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
}

function resolveInside(root,relative,label,{allowRoot=false}={}){
    const normalized=relative==='.'&&allowRoot
        ?'.'
        :normalizeRelativePath(relative,label);
    const candidate=path.resolve(root,...(normalized==='.'?[]:normalized.split('/')));

    if(!isInside(root,candidate,{allowEqual:allowRoot})){
        fail(`${label} leaves its allowed root: ${relative}`);
    }

    return candidate;
}

function pathKey(relative){
    return relative.toLocaleLowerCase('en-US');
}

function pathIsSameOrDescendant(candidate,parent){
    const candidateKey=pathKey(candidate);
    const parentKey=pathKey(parent);
    return candidateKey===parentKey||candidateKey.startsWith(`${parentKey}/`);
}

function isGlobLike(value){
    return /[*?\[\]{}]/.test(value);
}

function validatePathList(value,label,{required=false}={}){
    if(!Array.isArray(value)||(required&&value.length===0)){
        fail(`${label} must be ${required?'a non-empty':'an'} array of literal relative paths.`);
    }

    if(value.length>512){
        fail(`${label} is unreasonably large.`);
    }

    const normalized=value.map((entry,index)=>{
        const item=normalizeRelativePath(entry,`${label}[${index}]`);

        if(isGlobLike(item)){
            fail(`${label}[${index}] must be literal; directories already include descendants.`);
        }

        return item;
    });
    const keys=new Set();

    for(const item of normalized){
        const key=pathKey(item);

        if(keys.has(key)){
            fail(`${label} contains a duplicate path: ${item}`);
        }

        keys.add(key);
    }

    if(required){
        for(let left=0;left<normalized.length;left++){
            for(let right=left+1;right<normalized.length;right++){
                if(pathIsSameOrDescendant(normalized[left],normalized[right])
                    ||pathIsSameOrDescendant(normalized[right],normalized[left])){
                    fail(`${label} has overlapping paths: ${normalized[left]} and ${normalized[right]}`);
                }
            }
        }
    }

    return normalized;
}

function isAlwaysForbidden(relative){
    return relative.split('/').some(segment=>{
        const key=pathKey(segment);
        return FORBIDDEN_SEGMENTS.has(key)||key==='.env'||key.startsWith('.env.');
    });
}

function isAppSourceForbidden(relative){
    return isAlwaysForbidden(relative)
        ||relative.split('/').some(segment=>pathKey(segment)==='node_modules');
}

function isExcluded(relative,excludes){
    return isAlwaysForbidden(relative)
        ||excludes.some(excluded=>pathIsSameOrDescendant(relative,excluded));
}

function assertSafePresentationText(value,label,maximum=160){
    if(typeof value!=='string'||!value.trim()||value.length>maximum
        ||TEXT_CONTROL_PATTERN.test(value)||/[<>]/.test(value)){
        fail(`${label} must be plain text no longer than ${maximum} characters.`);
    }

    return value.trim();
}

export function parseSemver(value){
    if(typeof value!=='string'){
        fail(`Invalid semantic version: ${String(value)}`);
    }

    const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);

    if(!match){
        fail(`Invalid semantic version: ${value}`);
    }

    const prerelease=match[4]?match[4].split('.'):[];
    const build=match[5]?match[5].split('.'):[];

    for(const identifier of prerelease){
        if(/^\d+$/.test(identifier)&&identifier.length>1&&identifier.startsWith('0')){
            fail(`Invalid semantic version: ${value}`);
        }
    }

    const numbers=match.slice(1,4).map(Number);

    if(numbers.some(number=>!Number.isSafeInteger(number))){
        fail(`Semantic version component exceeds JavaScript's safe integer range: ${value}`);
    }

    return {
        major:numbers[0],
        minor:numbers[1],
        patch:numbers[2],
        prerelease,
        build
    };
}

function formatSemver(version){
    let rendered=`${version.major}.${version.minor}.${version.patch}`;

    if(version.prerelease?.length){
        rendered+=`-${version.prerelease.join('.')}`;
    }

    if(version.build?.length){
        rendered+=`+${version.build.join('.')}`;
    }

    return rendered;
}

function validatePreid(preid){
    const value=preid??'rc';

    if(typeof value!=='string'||!/^[0-9A-Za-z-]+$/.test(value)
        ||(/^\d+$/.test(value)&&value.length>1&&value.startsWith('0'))){
        fail(`Invalid prerelease identifier: ${String(value)}`);
    }

    return value;
}

export function incrementSemver(value,bump,preid){
    const current=parseSemver(value);

    if(!['major','minor','patch','prerelease'].includes(bump)){
        fail(`Unsupported semantic version bump: ${String(bump)}`);
    }

    if(bump==='major'){
        return formatSemver({major:current.major+1,minor:0,patch:0});
    }

    if(bump==='minor'){
        return formatSemver({major:current.major,minor:current.minor+1,patch:0});
    }

    if(bump==='patch'){
        return formatSemver({major:current.major,minor:current.minor,patch:current.patch+1});
    }

    const requestedPreid=validatePreid(preid);
    const next={
        major:current.major,
        minor:current.minor,
        patch:current.patch,
        prerelease:[]
    };

    if(!current.prerelease.length){
        next.patch+=1;
        next.prerelease=[requestedPreid,'0'];
        return formatSemver(next);
    }

    if(current.prerelease[0]!==requestedPreid){
        next.prerelease=[requestedPreid,'0'];
        return formatSemver(next);
    }

    next.prerelease=[...current.prerelease];
    let incremented=false;

    for(let index=next.prerelease.length-1;index>=0;index--){
        if(/^\d+$/.test(next.prerelease[index])){
            const number=Number(next.prerelease[index]);

            if(!Number.isSafeInteger(number)||number===Number.MAX_SAFE_INTEGER){
                fail(`Prerelease number is too large to increment: ${value}`);
            }

            next.prerelease[index]=String(number+1);
            incremented=true;
            break;
        }
    }

    if(!incremented){
        next.prerelease.push('0');
    }

    return formatSemver(next);
}

async function readJson(filePath,label=filePath){
    let text;

    try{
        text=await readFile(filePath,'utf8');
    }catch(error){
        if(error?.code==='ENOENT'){
            fail(`${label} does not exist.`);
        }

        throw error;
    }

    try{
        return JSON.parse(text);
    }catch(error){
        fail(`${label} is not valid JSON: ${error.message}`);
    }
}

function validateSharedRoute(route,label){
    assertOnlyKeys(route,new Set(['source','destination','include','exclude']),label);
    const source=normalizeRelativeRoot(route.source,`${label}.source`);
    const destination=normalizeRelativeRoot(route.destination,`${label}.destination`);
    const include=validatePathList(route.include,`${label}.include`,{required:true});
    const exclude=validatePathList(route.exclude??[],`${label}.exclude`);

    if(source==='.'||source==='apps'||source.startsWith('apps/')
        ||source==='dist'||source.startsWith('dist/')
        ||source==='node_modules'
        ||isAlwaysForbidden(source)){
        fail(`${label}.source is outside the permitted shared-payload boundary: ${source}`);
    }

    if(destination==='apps'||destination.startsWith('apps/')
        ||destination===RELEASE_MANIFEST_NAME){
        fail(`${label}.destination overlaps a reserved package path: ${destination}`);
    }

    return Object.freeze({source,destination,include,exclude});
}

async function loadRootConfig(workspaceRoot){
    const configPath=path.join(workspaceRoot,ROOT_CONFIG_NAME);
    const value=await readJson(configPath,ROOT_CONFIG_NAME);
    assertOnlyKeys(value,new Set(['schemaVersion','appsRoot','distRoot','sharedPayloads']),ROOT_CONFIG_NAME);

    if(value.schemaVersion!==1){
        fail(`${ROOT_CONFIG_NAME}.schemaVersion must be 1.`);
    }

    if(value.appsRoot!=='apps'||value.distRoot!=='dist'){
        fail(`${ROOT_CONFIG_NAME} must bind appsRoot to "apps" and distRoot to "dist".`);
    }

    if(!isPlainObject(value.sharedPayloads)){
        fail(`${ROOT_CONFIG_NAME}.sharedPayloads must be an object.`);
    }

    const sharedPayloads={};

    for(const [id,routes] of Object.entries(value.sharedPayloads).sort(([left],[right])=>compareText(left,right))){
        if(!SAFE_SHARED_ID_PATTERN.test(id)){
            fail(`Unsafe shared payload id: ${id}`);
        }

        if(!Array.isArray(routes)||routes.length===0){
            fail(`sharedPayloads.${id} must be a non-empty array.`);
        }

        sharedPayloads[id]=Object.freeze(routes.map((route,index)=>
            validateSharedRoute(route,`sharedPayloads.${id}[${index}]`)
        ));
    }

    return Object.freeze({
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:Object.freeze(sharedPayloads),
        configPath
    });
}

function validateAppConfig(value,appId,rootConfig,configPath){
    assertOnlyKeys(
        value,
        new Set([
            'schemaVersion',
            'id',
            'displayName',
            'version',
            'entry',
            'strategy',
            'include',
            'exclude',
            'shared',
            'adapter'
        ]),
        `${appId}/${APP_CONFIG_NAME}`
    );

    if(value.schemaVersion!==1){
        fail(`${appId}/${APP_CONFIG_NAME}.schemaVersion must be 1.`);
    }

    if(value.id!==appId||!APP_ID_PATTERN.test(value.id)){
        fail(`${appId}/${APP_CONFIG_NAME}.id must exactly match its apps directory.`);
    }

    const displayName=assertSafePresentationText(
        value.displayName,
        `${appId}/${APP_CONFIG_NAME}.displayName`
    );
    parseSemver(value.version);
    const entry=normalizeRelativePath(value.entry,`${appId}/${APP_CONFIG_NAME}.entry`);
    const include=validatePathList(value.include,`${appId}/${APP_CONFIG_NAME}.include`,{required:true});
    const exclude=validatePathList(value.exclude??[],`${appId}/${APP_CONFIG_NAME}.exclude`);

    if(isAlwaysForbidden(entry)||isExcluded(entry,exclude)
        ||!include.some(allowed=>pathIsSameOrDescendant(entry,allowed))){
        fail(`${appId}/${APP_CONFIG_NAME}.entry is not covered by its public include rules.`);
    }

    if(!['static','adapter'].includes(value.strategy)){
        fail(`${appId}/${APP_CONFIG_NAME}.strategy must be "static" or "adapter".`);
    }

    if(!Array.isArray(value.shared)||new Set(value.shared).size!==value.shared.length){
        fail(`${appId}/${APP_CONFIG_NAME}.shared must be an array of unique shared payload ids.`);
    }

    for(const [index,sharedId] of value.shared.entries()){
        if(typeof sharedId!=='string'||!Object.hasOwn(rootConfig.sharedPayloads,sharedId)){
            fail(`${appId}/${APP_CONFIG_NAME}.shared[${index}] references an unknown shared payload: ${String(sharedId)}`);
        }
    }

    let adapter=null;

    if(value.strategy==='adapter'){
        adapter=normalizeRelativePath(value.adapter,`${appId}/${APP_CONFIG_NAME}.adapter`);

        if(!adapter.startsWith('scripts/')||path.posix.extname(adapter)!=='.mjs'){
            fail(`${appId}/${APP_CONFIG_NAME}.adapter must be an app-local scripts/*.mjs module.`);
        }
    }else if(value.adapter!==undefined){
        fail(`${appId}/${APP_CONFIG_NAME}.adapter is only valid with strategy "adapter".`);
    }

    return Object.freeze({
        schemaVersion:1,
        id:appId,
        displayName,
        version:value.version,
        entry,
        strategy:value.strategy,
        include:Object.freeze(include),
        exclude:Object.freeze(exclude),
        shared:Object.freeze([...value.shared]),
        adapter,
        configPath
    });
}

async function assertNoLinks(root,candidate,label){
    const resolvedRoot=path.resolve(root);
    const resolvedCandidate=path.resolve(candidate);

    if(!isInside(resolvedRoot,resolvedCandidate,{allowEqual:true})){
        fail(`${label} leaves its allowed root.`);
    }

    const relative=path.relative(resolvedRoot,resolvedCandidate);
    let current=resolvedRoot;
    const rootInfo=await lstat(resolvedRoot);

    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()){
        fail(`${label} root must be a real directory.`);
    }

    for(const segment of relative.split(path.sep).filter(Boolean)){
        current=path.join(current,segment);
        const info=await lstat(current);

        if(info.isSymbolicLink()){
            fail(`${label} contains a symbolic link or junction: ${current}`);
        }
    }

    const [actualRoot,actualCandidate]=await Promise.all([
        realpath(resolvedRoot),
        realpath(resolvedCandidate)
    ]);

    if(!isInside(actualRoot,actualCandidate,{allowEqual:true})){
        fail(`${label} resolves outside its allowed root.`);
    }
}

async function assertSafeDistBoundary(workspaceRoot,distRoot,{create=false}={}){
    await assertNoLinks(workspaceRoot,workspaceRoot,'workspace');
    let details;

    try{
        details=await lstat(distRoot);
    }catch(error){
        if(error?.code!=='ENOENT'){
            throw error;
        }

        if(!create){
            return false;
        }

        try{
            await mkdir(distRoot);
        }catch(createError){
            if(createError?.code!=='EEXIST'){
                throw createError;
            }
        }

        details=await lstat(distRoot);
    }

    if(details.isSymbolicLink()||!details.isDirectory()){
        fail('dist must be a real workspace directory, not a link, junction, or special entry.');
    }

    await assertNoLinks(workspaceRoot,distRoot,'dist');
    return true;
}

async function assertOptionalSafeOutput(distRoot,outputRoot,appId){
    let details;

    try{
        details=await lstat(outputRoot);
    }catch(error){
        if(error?.code==='ENOENT'){
            return false;
        }

        throw error;
    }

    if(details.isSymbolicLink()||!details.isDirectory()){
        fail(`dist/${appId} must be a real directory, not a link, junction, or special entry.`);
    }

    await assertNoLinks(distRoot,outputRoot,`dist/${appId}`);
    return true;
}

async function getAppContext({workspaceRoot:requestedWorkspaceRoot,appId}){
    const workspaceRoot=normalizeWorkspaceRoot(requestedWorkspaceRoot);

    if(typeof appId!=='string'||!APP_ID_PATTERN.test(appId)){
        fail(`Invalid app id: ${String(appId)}`);
    }

    const rootConfig=await loadRootConfig(workspaceRoot);
    const appsRoot=path.join(workspaceRoot,rootConfig.appsRoot);
    const appRoot=resolveInside(appsRoot,appId,'app id');
    let appInfo;

    try{
        appInfo=await lstat(appRoot);
    }catch(error){
        if(error?.code==='ENOENT'){
            const available=(await readdir(appsRoot,{withFileTypes:true}))
                .filter(entry=>entry.isDirectory()&&APP_ID_PATTERN.test(entry.name))
                .map(entry=>entry.name)
                .sort(compareText);
            fail(`Unknown app "${appId}". Available apps: ${available.join(', ')||'[none]'}.`);
        }

        throw error;
    }

    if(appInfo.isSymbolicLink()||!appInfo.isDirectory()){
        fail(`apps/${appId} must be a real directory, not a link or special entry.`);
    }

    await assertNoLinks(appsRoot,appRoot,`apps/${appId}`);
    const configPath=path.join(appRoot,APP_CONFIG_NAME);
    const rawConfig=await readJson(configPath,`apps/${appId}/${APP_CONFIG_NAME}`);
    const config=validateAppConfig(rawConfig,appId,rootConfig,configPath);
    const distRoot=path.join(workspaceRoot,rootConfig.distRoot);
    const outputRoot=resolveInside(distRoot,appId,'package output');
    const distExists=await assertSafeDistBoundary(workspaceRoot,distRoot);

    if(distExists){
        await assertOptionalSafeOutput(distRoot,outputRoot,appId);
    }

    return {workspaceRoot,rootConfig,appsRoot,appRoot,distRoot,outputRoot,config};
}

async function enumerateRoute({
    workspaceRoot,
    sourceRoot,
    destinationRoot,
    include,
    exclude,
    label,
    appPayload=false
}){
    await assertNoLinks(workspaceRoot,sourceRoot,`${label}.source`);
    const files=[];

    async function visit(absolute,relative){
        if(isExcluded(relative,exclude)||(appPayload&&isAppSourceForbidden(relative))){
            return;
        }

        const info=await lstat(absolute);

        if(info.isSymbolicLink()){
            fail(`${label} contains a symbolic link or junction: ${relative}`);
        }

        if(info.isDirectory()){
            const entries=await readdir(absolute,{withFileTypes:true});

            for(const entry of entries.sort((left,right)=>compareText(left.name,right.name))){
                const childRelative=`${relative}/${entry.name}`;

                if(isExcluded(childRelative,exclude)
                    ||(appPayload&&isAppSourceForbidden(childRelative))){
                    continue;
                }

                if(entry.isSymbolicLink()){
                    fail(`${label} contains a symbolic link or junction: ${childRelative}`);
                }

                await visit(path.join(absolute,entry.name),childRelative);
            }

            return;
        }

        if(!info.isFile()){
            fail(`${label} contains a non-file entry: ${relative}`);
        }

        const destination=destinationRoot==='.'
            ?relative
            :`${destinationRoot}/${relative}`;
        files.push({
            source:absolute,
            sourceRelative:relative,
            destination:normalizeRelativePath(destination,`${label} destination`),
            bytes:info.size,
            label
        });
    }

    for(const allowed of include){
        if(isExcluded(allowed,exclude)||(appPayload&&isAppSourceForbidden(allowed))){
            continue;
        }

        const candidate=resolveInside(sourceRoot,allowed,`${label}.include`);

        try{
            await assertNoLinks(sourceRoot,candidate,`${label}.include "${allowed}"`);
        }catch(error){
            if(error?.code==='ENOENT'){
                fail(`${label}.include does not exist: ${allowed}`);
            }

            throw error;
        }

        await visit(candidate,allowed);
    }

    return files;
}

async function collectPackageFiles(context){
    const {workspaceRoot,appRoot,config,rootConfig}=context;
    const files=await enumerateRoute({
        workspaceRoot,
        sourceRoot:appRoot,
        destinationRoot:`apps/${config.id}`,
        include:config.include,
        exclude:config.exclude,
        label:`apps.${config.id}`,
        appPayload:true
    });

    for(const sharedId of config.shared){
        const routes=rootConfig.sharedPayloads[sharedId];

        for(const [index,route] of routes.entries()){
            const sourceRoot=resolveInside(
                workspaceRoot,
                route.source,
                `sharedPayloads.${sharedId}[${index}].source`
            );
            files.push(...await enumerateRoute({
                workspaceRoot,
                sourceRoot,
                destinationRoot:route.destination,
                include:route.include,
                exclude:route.exclude,
                label:`sharedPayloads.${sharedId}[${index}]`
            }));
        }
    }

    const destinations=new Map();

    for(const file of files){
        if(file.destination===RELEASE_MANIFEST_NAME||file.destination==='index.html'){
            fail(`${file.label} collides with generated package path: ${file.destination}`);
        }

        const key=pathKey(file.destination);

        if(destinations.has(key)){
            fail(`Package destination collision: ${file.destination} from ${file.source} and ${destinations.get(key).source}.`);
        }

        destinations.set(key,file);
    }

    const expectedEntry=`apps/${config.id}/${config.entry}`;

    if(!destinations.has(pathKey(expectedEntry))){
        fail(`The configured entry file was not found in the package payload: ${expectedEntry}`);
    }

    return files.sort((left,right)=>compareText(left.destination,right.destination));
}

async function copyPackageFiles(files,outputRoot){
    for(const file of files){
        const destination=resolveInside(outputRoot,file.destination,'package destination');
        await mkdir(path.dirname(destination),{recursive:true});
        await copyFile(file.source,destination);
    }
}

function escapeHtml(value){
    return String(value)
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;');
}

async function materializeBasePackage(context,outputRoot,files){
    await mkdir(outputRoot,{recursive:true});
    await assertNoLinks(context.distRoot,outputRoot,'package staging root');
    await copyPackageFiles(files,outputRoot);
    const start=`./apps/${context.config.id}/${context.config.entry}`;
    const title=escapeHtml(context.config.displayName);
    await writeFile(
        path.join(outputRoot,'index.html'),
        [
            '<!doctype html>',
            '<meta charset="utf-8">',
            `<meta http-equiv="refresh" content="0; url=${escapeHtml(start)}">`,
            `<title>${title}</title>`,
            `<a href="${escapeHtml(start)}">Open ${title}</a>`,
            ''
        ].join('\n'),
        'utf8'
    );
}

async function sha256(filePath){
    const hash=createHash('sha256');
    const {createReadStream}=await import('node:fs');

    for await(const chunk of createReadStream(filePath)){
        hash.update(chunk);
    }

    return hash.digest('hex');
}

async function listOutputFiles(root){
    const files=[];

    async function visit(directory,relativeRoot=''){
        const entries=await readdir(directory,{withFileTypes:true});

        for(const entry of entries.sort((left,right)=>compareText(left.name,right.name))){
            const relative=relativeRoot?`${relativeRoot}/${entry.name}`:entry.name;
            const absolute=path.join(directory,entry.name);

            if(isAlwaysForbidden(relative)){
                fail(`Package contains a globally forbidden path: ${relative}`);
            }

            if(entry.isSymbolicLink()){
                fail(`Package contains a symbolic link or junction: ${relative}`);
            }

            if(entry.isDirectory()){
                await visit(absolute,relative);
            }else if(entry.isFile()){
                files.push({absolute,relative});
            }else{
                fail(`Package contains a non-file entry: ${relative}`);
            }
        }
    }

    await visit(root);
    return files.sort((left,right)=>compareText(left.relative,right.relative));
}

async function inventoryEntries(root){
    const files=(await listOutputFiles(root)).filter(file=>
        file.relative!==RELEASE_MANIFEST_NAME
    );
    const entries=[];

    for(const file of files){
        const details=await stat(file.absolute);
        entries.push({
            path:file.relative,
            bytes:details.size,
            sha256:await sha256(file.absolute)
        });
    }

    return entries;
}

function normalizedRoutePolicy(route){
    return {
        source:route.source,
        destination:route.destination,
        include:[...route.include].sort(compareText),
        exclude:[...route.exclude].sort(compareText)
    };
}

async function packagePolicySha256(context){
    const {config,rootConfig,appRoot}=context;
    let adapter=null;

    if(config.adapter){
        const adapterPath=resolveInside(appRoot,config.adapter,`${config.id} adapter`);
        await assertNoLinks(appRoot,adapterPath,`${config.id} adapter`);
        adapter={
            path:config.adapter,
            sha256:await sha256(adapterPath)
        };
    }

    const shared=[...config.shared]
        .sort(compareText)
        .map(id=>({
            id,
            routes:rootConfig.sharedPayloads[id]
                .map(normalizedRoutePolicy)
                .sort((left,right)=>compareText(JSON.stringify(left),JSON.stringify(right)))
        }));
    const policy={
        strategy:config.strategy,
        include:[...config.include].sort(compareText),
        exclude:[...config.exclude].sort(compareText),
        shared,
        adapter
    };

    return createHash('sha256')
        .update(JSON.stringify(policy))
        .digest('hex');
}

async function writeReleaseManifest(root,context,version){
    const {config}=context;
    const files=await inventoryEntries(root);
    const totalBytes=files.reduce((total,file)=>total+file.bytes,0);
    const contentSha256=createHash('sha256')
        .update(JSON.stringify(files))
        .digest('hex');
    const release={
        schemaVersion:1,
        builder:PACKAGER_VERSION,
        app:{
            id:config.id,
            displayName:config.displayName,
            version,
            entry:config.entry,
            start:`./apps/${config.id}/${config.entry}`
        },
        policySha256:await packagePolicySha256(context),
        fileCount:files.length,
        totalBytes,
        contentSha256,
        files
    };

    await writeFile(
        path.join(root,RELEASE_MANIFEST_NAME),
        `${JSON.stringify(release,null,2)}\n`,
        'utf8'
    );
    return release;
}

async function verifyGenericRelease(root,context,version){
    const {config}=context;
    const release=await readJson(
        path.join(root,RELEASE_MANIFEST_NAME),
        `${config.id}/${RELEASE_MANIFEST_NAME}`
    );
    const expectedApp={
        id:config.id,
        displayName:config.displayName,
        version,
        entry:config.entry,
        start:`./apps/${config.id}/${config.entry}`
    };

    if(release?.schemaVersion!==1||release?.builder!==PACKAGER_VERSION
        ||JSON.stringify(release?.app)!==JSON.stringify(expectedApp)
        ||release?.policySha256!==await packagePolicySha256(context)
        ||!Array.isArray(release?.files)){
        fail(`${config.id}/${RELEASE_MANIFEST_NAME} identity is invalid.`);
    }

    const actualFiles=await inventoryEntries(root);
    const totalBytes=actualFiles.reduce((total,file)=>total+file.bytes,0);
    const contentSha256=createHash('sha256')
        .update(JSON.stringify(actualFiles))
        .digest('hex');

    if(release.fileCount!==actualFiles.length
        ||release.totalBytes!==totalBytes
        ||release.contentSha256!==contentSha256
        ||JSON.stringify(release.files)!==JSON.stringify(actualFiles)){
        fail(`${config.id}/${RELEASE_MANIFEST_NAME} does not match the package tree.`);
    }

    const rootIndex=path.join(root,'index.html');
    const entry=resolveInside(root,expectedApp.start.slice(2),'package entry');
    const [indexInfo,entryInfo]=await Promise.all([lstat(rootIndex),lstat(entry)]);

    if(!indexInfo.isFile()||indexInfo.isSymbolicLink()
        ||!entryInfo.isFile()||entryInfo.isSymbolicLink()){
        fail(`Package entry files for ${config.id} are invalid.`);
    }

    return release;
}

async function loadAdapter(context){
    if(context.config.strategy!=='adapter'){
        return null;
    }

    const adapterPath=resolveInside(
        context.appRoot,
        context.config.adapter,
        `${context.config.id} adapter`
    );
    await assertNoLinks(context.appRoot,adapterPath,`${context.config.id} adapter`);
    const details=await stat(adapterPath);

    if(!details.isFile()){
        fail(`${context.config.id} adapter is not a regular file.`);
    }

    const module=await import(`${pathToFileURL(adapterPath).href}?mtime=${details.mtimeMs}`);

    if(typeof module.buildArcanePackage!=='function'
        ||typeof module.verifyArcanePackage!=='function'){
        fail(`${context.config.id} adapter must export buildArcanePackage and verifyArcanePackage.`);
    }

    return module;
}

async function verifyBuiltPackage(context,outputRoot,version,adapter){
    if(adapter){
        await adapter.verifyArcanePackage({
            workspaceRoot:context.workspaceRoot,
            appRoot:context.appRoot,
            outputRoot,
            config:context.config,
            version
        });
    }

    return verifyGenericRelease(outputRoot,context,version);
}

async function writeAppVersion(context,version){
    parseSemver(version);
    const raw=await readJson(context.config.configPath,context.config.configPath);
    raw.version=version;
    const temporary=`${context.config.configPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    const backup=`${context.config.configPath}.bak-${process.pid}-${randomBytes(4).toString('hex')}`;
    await writeFile(temporary,`${JSON.stringify(raw,null,2)}\n`,'utf8');

    let originalMoved=false;
    let replacementInstalled=false;

    try{
        await rename(context.config.configPath,backup);
        originalMoved=true;
        await rename(temporary,context.config.configPath);
        replacementInstalled=true;
    }catch(error){
        await rm(temporary,{force:true});

        if(originalMoved&&!replacementInstalled){
            try{
                await rename(backup,context.config.configPath);
            }catch{
                // Preserve the original error; the backup path remains recoverable.
            }
        }

        throw error;
    }

    await rm(backup,{force:true}).catch(()=>{});
}

function resolveTargetVersion(current,{bump,exactVersion,preid}={}){
    if(bump&&exactVersion){
        fail('Choose either a semantic version bump or an exact version, not both.');
    }

    if(exactVersion!==undefined){
        parseSemver(exactVersion);

        if(exactVersion===current){
            fail(`Version is already ${current}.`);
        }

        return exactVersion;
    }

    return bump?incrementSemver(current,bump,preid):current;
}

async function acquirePackageLock(distRoot,appId){
    const lockPath=path.join(distRoot,`.arcane-packager-${appId}.lock`);
    let handle;

    try{
        handle=await open(lockPath,'wx');
        await handle.writeFile(`${JSON.stringify({pid:process.pid,app:appId})}\n`,'utf8');
    }catch(error){
        if(handle){
            await handle.close().catch(()=>{});
            await rm(lockPath,{force:true}).catch(()=>{});
        }

        if(error?.code==='EEXIST'){
            fail(`Another package operation for ${appId} is already running. If no process is active, remove the stale lock at ${lockPath}.`);
        }

        throw error;
    }

    let released=false;

    return async()=>{
        if(released){
            return;
        }

        released=true;
        const cleanupErrors=[];

        try{
            await handle.close();
        }catch(error){
            cleanupErrors.push(`close failed: ${error.message}`);
        }

        try{
            await rm(lockPath,{force:true});
        }catch(error){
            cleanupErrors.push(`remove failed: ${error.message}`);
        }

        if(cleanupErrors.length){
            console.error(
                `Arcane packager completed but could not fully clean ${lockPath} (${cleanupErrors.join('; ')}). Remove the stale lock before the next operation.`
            );
        }
    };
}

async function acquireOperationLock(workspaceRoot,appId){
    const resolvedWorkspace=normalizeWorkspaceRoot(workspaceRoot);

    if(typeof appId!=='string'||!APP_ID_PATTERN.test(appId)){
        fail(`Invalid app id: ${String(appId)}`);
    }

    const rootConfig=await loadRootConfig(resolvedWorkspace);
    const distRoot=path.join(resolvedWorkspace,rootConfig.distRoot);
    await assertSafeDistBoundary(resolvedWorkspace,distRoot,{create:true});
    return acquirePackageLock(distRoot,appId);
}

async function readDistVersion(outputRoot){
    try{
        const release=await readJson(path.join(outputRoot,RELEASE_MANIFEST_NAME));
        return typeof release?.app?.version==='string'?release.app.version:null;
    }catch{
        return null;
    }
}

export async function discoverApps({workspaceRoot:requestedWorkspaceRoot}){
    const workspaceRoot=normalizeWorkspaceRoot(requestedWorkspaceRoot);
    const rootConfig=await loadRootConfig(workspaceRoot);
    const appsRoot=path.join(workspaceRoot,rootConfig.appsRoot);
    const entries=await readdir(appsRoot,{withFileTypes:true});
    const apps=[];

    for(const entry of entries.sort((left,right)=>compareText(left.name,right.name))){
        if(!APP_ID_PATTERN.test(entry.name)||(entry.isFile()&&!entry.isSymbolicLink())){
            continue;
        }

        if(entry.isSymbolicLink()){
            apps.push({
                id:entry.name,
                displayName:entry.name,
                configured:false,
                status:'unsafe-link',
                version:null,
                distVersion:null
            });
            continue;
        }

        if(!entry.isDirectory()){
            continue;
        }

        const configPath=path.join(appsRoot,entry.name,APP_CONFIG_NAME);

        try{
            const context=await getAppContext({workspaceRoot,appId:entry.name});
            apps.push({
                id:entry.name,
                displayName:context.config.displayName,
                configured:true,
                status:'ready',
                version:context.config.version,
                distVersion:await readDistVersion(context.outputRoot),
                strategy:context.config.strategy,
                entry:context.config.entry,
                output:path.relative(workspaceRoot,context.outputRoot).replaceAll('\\','/')
            });
        }catch(error){
            let configured=true;

            try{
                await lstat(configPath);
            }catch{
                configured=false;
            }

            let displayName=entry.name;

            try{
                const manifest=await readJson(path.join(appsRoot,entry.name,'manifest.json'));
                if(typeof manifest?.name==='string'&&manifest.name.trim()){
                    displayName=manifest.name.trim();
                }
            }catch{
                // An unconfigured app can still be listed without a PWA manifest.
            }

            apps.push({
                id:entry.name,
                displayName,
                configured,
                status:configured?'invalid':'unconfigured',
                version:null,
                distVersion:null,
                error:configured?error.message:undefined
            });
        }
    }

    return apps;
}

export async function inspectApp({workspaceRoot,appId}){
    const context=await getAppContext({workspaceRoot,appId});
    const files=await collectPackageFiles(context);
    const totalBytes=files.reduce((total,file)=>total+file.bytes,0);
    const largestFiles=[...files]
        .sort((left,right)=>right.bytes-left.bytes||compareText(left.destination,right.destination))
        .slice(0,10)
        .map(file=>({path:file.destination,bytes:file.bytes}));

    return {
        id:context.config.id,
        displayName:context.config.displayName,
        version:context.config.version,
        distVersion:await readDistVersion(context.outputRoot),
        strategy:context.config.strategy,
        entry:context.config.entry,
        output:path.relative(context.workspaceRoot,context.outputRoot).replaceAll('\\','/'),
        include:[...context.config.include],
        exclude:[...context.config.exclude],
        shared:[...context.config.shared],
        adapter:context.config.adapter,
        baseFileCount:files.length,
        baseBytes:totalBytes,
        largestFiles,
        note:context.config.strategy==='adapter'
            ?'Counts cover the static base; the adapter can add generated public files.'
            :undefined
    };
}

async function packageAppUnlocked({
    workspaceRoot,
    appId,
    bump,
    preid,
    exactVersion,
    dryRun=false
}){
    const context=await getAppContext({workspaceRoot,appId});
    const currentVersion=context.config.version;
    const version=resolveTargetVersion(currentVersion,{bump,exactVersion,preid});
    const files=await collectPackageFiles(context);
    const preview={
        app:appId,
        currentVersion,
        version,
        bump:bump??null,
        dryRun:Boolean(dryRun),
        output:path.relative(context.workspaceRoot,context.outputRoot).replaceAll('\\','/'),
        baseFileCount:files.length,
        baseBytes:files.reduce((total,file)=>total+file.bytes,0),
        strategy:context.config.strategy
    };

    if(dryRun){
        return preview;
    }

    const token=`${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const staging=resolveInside(context.distRoot,`.arcane-packager-${appId}-${token}`,'staging output');
    const stagingTemporary=`${staging}.tmp`;
    const backup=resolveInside(context.distRoot,`.arcane-packager-${appId}-backup-${token}`,'backup output');
    const failedOutput=resolveInside(context.distRoot,`.arcane-packager-${appId}-failed-${token}`,'failed output');
    let adapter=null;
    let movedExisting=false;
    let promoted=false;
    let operationSucceeded=false;
    let rollbackRestored=false;

    try{
        await rm(staging,{recursive:true,force:true});
        await rm(stagingTemporary,{recursive:true,force:true});
        await rm(backup,{recursive:true,force:true}).catch(()=>{});
        await rm(failedOutput,{recursive:true,force:true}).catch(()=>{});
        adapter=await loadAdapter(context);

        if(adapter){
            let prepared=false;
            await adapter.buildArcanePackage({
                workspaceRoot:context.workspaceRoot,
                appRoot:context.appRoot,
                outputRoot:staging,
                config:context.config,
                version,
                prepareBase:async outputRoot=>{
                    if(prepared){
                        fail(`${appId} adapter requested its base payload more than once.`);
                    }

                    prepared=true;
                    const requestedRoot=path.resolve(outputRoot);

                    if(requestedRoot!==path.resolve(staging)
                        &&requestedRoot!==path.resolve(stagingTemporary)){
                        fail(`${appId} adapter requested its base payload outside its assigned staging roots.`);
                    }

                    await materializeBasePackage(context,outputRoot,files);
                }
            });

            if(!prepared){
                fail(`${appId} adapter did not materialize the configured public base payload.`);
            }
        }else{
            await materializeBasePackage(context,staging,files);
        }

        await writeReleaseManifest(staging,context,version);
        const release=await verifyBuiltPackage(context,staging,version,adapter);

        try{
            await lstat(context.outputRoot);
            await rename(context.outputRoot,backup);
            movedExisting=true;
        }catch(error){
            if(error?.code!=='ENOENT'){
                throw error;
            }
        }

        await rename(staging,context.outputRoot);
        promoted=true;

        if(version!==currentVersion){
            await writeAppVersion(context,version);
        }

        operationSucceeded=true;
        return {
            ...preview,
            dryRun:false,
            fileCount:release.fileCount,
            totalBytes:release.totalBytes,
            contentSha256:release.contentSha256
        };
    }catch(error){
        const rollbackErrors=[];
        let targetVacated=!promoted;

        if(promoted){
            try{
                await rename(context.outputRoot,failedOutput);
                targetVacated=true;
            }catch(moveError){
                targetVacated=false;
                rollbackErrors.push(`could not move the failed package aside: ${moveError.message}`);
            }
        }

        if(movedExisting&&targetVacated){
            try{
                await rename(backup,context.outputRoot);
                rollbackRestored=true;
            }catch(restoreError){
                rollbackErrors.push(`could not restore the previous package from ${backup}: ${restoreError.message}`);
            }
        }

        if(rollbackErrors.length){
            error.message+=` Rollback warning: ${rollbackErrors.join('; ')}. Preserve ${backup} until manually recovered.`;
        }

        throw error;
    }finally{
        await rm(staging,{recursive:true,force:true}).catch(()=>{});
        await rm(stagingTemporary,{recursive:true,force:true}).catch(()=>{});
        await rm(failedOutput,{recursive:true,force:true}).catch(()=>{});

        if(operationSucceeded||rollbackRestored||!movedExisting){
            await rm(backup,{recursive:true,force:true}).catch(()=>{});
        }
    }
}

export async function packageApp(options){
    if(options?.dryRun){
        return packageAppUnlocked(options);
    }

    await getAppContext({
        workspaceRoot:options?.workspaceRoot,
        appId:options?.appId
    });
    const releaseLock=await acquireOperationLock(
        options?.workspaceRoot,
        options?.appId
    );

    try{
        return await packageAppUnlocked(options);
    }finally{
        await releaseLock();
    }
}

export async function verifyApp({workspaceRoot,appId}){
    const context=await getAppContext({workspaceRoot,appId});
    const adapter=await loadAdapter(context);
    const release=await verifyBuiltPackage(
        context,
        context.outputRoot,
        context.config.version,
        adapter
    );

    return {
        app:appId,
        version:release.app.version,
        output:path.relative(context.workspaceRoot,context.outputRoot).replaceAll('\\','/'),
        fileCount:release.fileCount,
        totalBytes:release.totalBytes,
        contentSha256:release.contentSha256,
        verified:true
    };
}

async function bumpVersionUnlocked({
    workspaceRoot,
    appId,
    bump,
    preid,
    exactVersion,
    dryRun=false
}){
    const context=await getAppContext({workspaceRoot,appId});
    const currentVersion=context.config.version;
    const version=resolveTargetVersion(currentVersion,{bump,exactVersion,preid});

    if(version===currentVersion){
        fail('A bump level or exact version is required.');
    }

    if(!dryRun){
        await writeAppVersion(context,version);
    }

    return {
        app:appId,
        currentVersion,
        version,
        bump:bump??null,
        dryRun:Boolean(dryRun)
    };
}

export async function bumpVersion(options){
    if(options?.dryRun){
        return bumpVersionUnlocked(options);
    }

    await getAppContext({
        workspaceRoot:options?.workspaceRoot,
        appId:options?.appId
    });
    const releaseLock=await acquireOperationLock(
        options?.workspaceRoot,
        options?.appId
    );

    try{
        return await bumpVersionUnlocked(options);
    }finally{
        await releaseLock();
    }
}
