import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {
    lstat,
    open,
    readFile,
    readdir,
    realpath,
    stat
} from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const CONFIG_SCHEMA_VERSION=1;
const RELEASE_SCHEMA_VERSION=1;
const MAX_CONFIG_BYTES=256*1024;
const MAX_MANIFEST_BYTES=16*1024*1024;
const MAX_REQUEST_TARGET_BYTES=4096;
const MAX_INLINE_HTML_BYTES=4*1024*1024;
const MAX_PUBLISHED_FILE_BYTES=16*1024*1024;
const MAX_ACME_RESPONSE_BYTES=1024;
const COMPONENT_SCRIPT_PREFIX='(async function(){';
const COMPONENT_SCRIPT_SUFFIX="}).call((()=>{const registry=globalThis[Symbol.for('arcane.html-import.hosts')];const token=document.currentScript&&document.currentScript.dataset.arcaneHostToken;const host=registry instanceof Map&&token?registry.get(token):null;if(!host)throw new Error('HTML import host binding is unavailable.');return host;})())";

const MIME_TYPES=Object.freeze({
    '.avif':'image/avif',
    '.bmp':'image/bmp',
    '.css':'text/css; charset=utf-8',
    '.csv':'text/csv; charset=utf-8',
    '.gif':'image/gif',
    '.htm':'text/html; charset=utf-8',
    '.html':'text/html; charset=utf-8',
    '.ico':'image/x-icon',
    '.jpeg':'image/jpeg',
    '.jpg':'image/jpeg',
    '.js':'text/javascript; charset=utf-8',
    '.json':'application/json; charset=utf-8',
    '.m4a':'audio/mp4',
    '.md':'text/markdown; charset=utf-8',
    '.mjs':'text/javascript; charset=utf-8',
    '.mp3':'audio/mpeg',
    '.mp4':'video/mp4',
    '.ogg':'audio/ogg',
    '.ogv':'video/ogg',
    '.opus':'audio/ogg',
    '.pdf':'application/pdf',
    '.png':'image/png',
    '.svg':'image/svg+xml',
    '.txt':'text/plain; charset=utf-8',
    '.wasm':'application/wasm',
    '.wav':'audio/wav',
    '.webm':'video/webm',
    '.webmanifest':'application/manifest+json; charset=utf-8',
    '.webp':'image/webp',
    '.woff':'font/woff',
    '.woff2':'font/woff2',
    '.xml':'application/xml; charset=utf-8'
});

const PERMISSIONS_POLICY_DENY=Object.freeze([
    'accelerometer=()',
    'ambient-light-sensor=()',
    'autoplay=()',
    'bluetooth=()',
    'camera=()',
    'clipboard-read=()',
    'clipboard-write=()',
    'display-capture=()',
    'encrypted-media=()',
    'fullscreen=()',
    'gamepad=()',
    'geolocation=()',
    'gyroscope=()',
    'hid=()',
    'idle-detection=()',
    'magnetometer=()',
    'microphone=()',
    'midi=()',
    'payment=()',
    'picture-in-picture=()',
    'publickey-credentials-get=()',
    'screen-wake-lock=()',
    'serial=()',
    'speaker-selection=()',
    'usb=()',
    'web-share=()',
    'xr-spatial-tracking=()'
]);

const BASE_SECURITY_HEADERS=Object.freeze({
    'cross-origin-opener-policy':'same-origin',
    'cross-origin-resource-policy':'same-origin',
    'referrer-policy':'no-referrer',
    'vary':'Host',
    'x-content-type-options':'nosniff',
    'x-frame-options':'DENY'
});

const SITE_CONTENT_SECURITY_POLICY=[
    "default-src 'none'",
    "base-uri 'none'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'none'",
    "manifest-src 'self'",
    "worker-src 'none'",
    "child-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "form-action 'self'"
].join('; ');

function fail(message){
    throw new Error(`Static domain server: ${message}`);
}

function isPlainObject(value){
    return Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
}

function compareText(left,right){
    return left<right?-1:left>right?1:0;
}

function assertSafeInteger(value,label,{minimum=0,maximum=Number.MAX_SAFE_INTEGER}={}){
    if(!Number.isSafeInteger(value)||value<minimum||value>maximum) fail(`${label} must be an integer from ${minimum} through ${maximum}.`);
    return value;
}

function normalizeHostname(value,label='hostname'){
    if(typeof value!=='string') fail(`${label} must be a string.`);
    const normalized=value.trim().toLowerCase().replace(/\.$/,'');
    if(normalized.length<1||normalized.length>253) fail(`${label} has an invalid length.`);
    if(!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(normalized)){
        fail(`${label} must be an ASCII DNS hostname.`);
    }
    return normalized;
}

function normalizeAppId(value,label='application id'){
    if(typeof value!=='string'||!/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(value)) fail(`${label} is invalid.`);
    return value;
}

function normalizeRelativePath(value,label='path'){
    if(typeof value!=='string'||value.length<1||value.length>2048) fail(`${label} is invalid.`);
    if(value.includes('\\')||value.includes('\0')||value.startsWith('/')||/^[a-z]:/i.test(value)) fail(`${label} must be a safe relative POSIX path.`);
    const segments=value.split('/');
    if(segments.some(segment=>!segment||segment==='.'||segment==='..'||segment.startsWith('.'))) fail(`${label} contains an unsafe segment.`);
    const normalized=path.posix.normalize(value);
    if(normalized!==value||normalized.startsWith('../')) fail(`${label} is not normalized.`);
    return normalized;
}

function isRegistryOrigin(value){
    if(value==='https:') return true;
    try{
        const parsed=new URL(value);
        return (parsed.protocol==='http:'||parsed.protocol==='https:')
            &&parsed.username===''
            &&parsed.password===''
            &&parsed.pathname==='/'
            &&parsed.search===''
            &&parsed.hash===''
            &&parsed.origin===value;
    }catch{
        return false;
    }
}

function resolveInside(root,relative,label='path'){
    const normalized=normalizeRelativePath(relative,label);
    const destination=path.resolve(root,...normalized.split('/'));
    const prefix=root.endsWith(path.sep)?root:`${root}${path.sep}`;
    if(destination!==root&&!destination.startsWith(prefix)) fail(`${label} escapes its configured root.`);
    return destination;
}

function resolveConfiguredPath(projectRoot,value,label,{allowOutsideProject=false}={}){
    if(typeof value!=='string'||!value.trim()) fail(`${label} must be a path string.`);
    const resolved=path.resolve(projectRoot,value);
    if(!allowOutsideProject){
        const prefix=projectRoot.endsWith(path.sep)?projectRoot:`${projectRoot}${path.sep}`;
        if(resolved!==projectRoot&&!resolved.startsWith(prefix)) fail(`${label} escapes the project root.`);
    }
    return resolved;
}

async function readJsonFile(file,label,maximumBytes){
    const metadata=await lstat(file).catch(()=>null);
    if(!metadata?.isFile()||metadata.isSymbolicLink()) fail(`${label} is missing or is not a regular file.`);
    if(metadata.size>maximumBytes) fail(`${label} exceeds its size limit.`);
    let parsed;
    try{
        parsed=JSON.parse(await readFile(file,'utf8'));
    }catch(error){
        fail(`${label} is not valid JSON (${error.message}).`);
    }
    if(!isPlainObject(parsed)) fail(`${label} must contain an object.`);
    return parsed;
}

function validateInventoryFiles(files,label){
    if(!Array.isArray(files)||files.length<1||files.length>100000) fail(`${label}.files must be a bounded nonempty array.`);
    const entries=new Map();
    const folded=new Set();
    for(let index=0;index<files.length;index+=1){
        const record=files[index];
        if(!isPlainObject(record)) fail(`${label}.files[${index}] must be an object.`);
        const relative=normalizeRelativePath(record.path,`${label}.files[${index}].path`);
        const caseFolded=relative.toLowerCase();
        if(folded.has(caseFolded)) fail(`${label} contains a duplicate or case-colliding path: ${relative}.`);
        folded.add(caseFolded);
        const bytes=assertSafeInteger(record.bytes,`${label}.files[${index}].bytes`);
        if(bytes>MAX_PUBLISHED_FILE_BYTES) fail(`${label}.files[${index}] exceeds the per-file publication limit.`);
        if(typeof record.sha256!=='string'||!/^[a-f0-9]{64}$/.test(record.sha256)) fail(`${label}.files[${index}].sha256 is invalid.`);
        entries.set(relative,Object.freeze({relative,bytes,sha256:record.sha256}));
    }
    return entries;
}

async function loadStaticInventory(manifestPath,expectedSite){
    const manifest=await readJsonFile(manifestPath,'site release manifest',MAX_MANIFEST_BYTES);
    if(manifest.schemaVersion!==RELEASE_SCHEMA_VERSION) fail('site release manifest has an unsupported schema version.');
    if(manifest.site!==expectedSite) fail('site release manifest identity does not match the configured canonical host.');
    const files=validateInventoryFiles(manifest.files,'site release manifest');
    if(!files.has('index.html')) fail('site release manifest must include index.html.');
    return Object.freeze({manifest,files});
}

async function loadAppRelease(distRoot,appId){
    const root=resolveInside(distRoot,appId,`dist application ${appId}`);
    const releasePath=path.join(root,'ARCANE_APP_RELEASE.json');
    const manifest=await readJsonFile(releasePath,`${appId} release manifest`,MAX_MANIFEST_BYTES);
    if(manifest.schemaVersion!==RELEASE_SCHEMA_VERSION||!isPlainObject(manifest.app)) fail(`${appId} release manifest has an unsupported shape.`);
    if(manifest.app.id!==appId) fail(`${appId} release manifest identity does not match its directory.`);
    const files=validateInventoryFiles(manifest.files,`${appId} release manifest`);
    const rawStart=typeof manifest.app.start==='string'?manifest.app.start.replace(/^\.\//,''):'';
    const start=normalizeRelativePath(rawStart,`${appId} release start path`);
    if(!files.has(start)) fail(`${appId} release start path is absent from its inventory.`);
    return Object.freeze({appId,root,manifest,files,start});
}

function validateRegistryApp(registry,appId){
    const app=registry.apps?.[appId];
    if(!isPlainObject(app)) fail(`application registry does not declare ${appId}.`);
    const capabilities=Array.isArray(app.capabilities)?app.capabilities:[];
    if(capabilities.some(value=>typeof value!=='string')) fail(`application registry capabilities for ${appId} are invalid.`);
    const security=isPlainObject(app.security)?app.security:{};
    const origins={};
    for(const key of ['connectOrigins','frameOrigins','mediaOrigins']){
        const values=security[key]??[];
        if(!Array.isArray(values)||values.some(value=>typeof value!=='string'||!isRegistryOrigin(value))) fail(`application registry ${key} for ${appId} is invalid.`);
        origins[key]=[...new Set(values)].sort(compareText);
    }
    return Object.freeze({appId,capabilities:Object.freeze([...capabilities]),security:Object.freeze(origins)});
}

function isPublicHttpsOrigin(value){
    if(value==='https:') return true;
    try{
        const parsed=new URL(value);
        return parsed.protocol==='https:'
            &&parsed.username===''
            &&parsed.password===''
            &&parsed.pathname==='/'
            &&parsed.search===''
            &&parsed.hash===''
            &&parsed.origin===value;
    }catch{
        return false;
    }
}

function validatePublicAppSecurity(record,registryApp){
    const value=record??{};
    if(!isPlainObject(value)) fail(`publicAppSecurity.${registryApp.appId} must be an object.`);
    const allowedKeys=new Set(['connectOrigins','frameOrigins','mediaOrigins']);
    for(const key of Object.keys(value)){
        if(!allowedKeys.has(key)) fail(`publicAppSecurity.${registryApp.appId} contains unsupported field ${key}.`);
    }
    const origins={};
    for(const key of allowedKeys){
        const values=value[key]??[];
        if(!Array.isArray(values)||values.some(origin=>typeof origin!=='string'||!isPublicHttpsOrigin(origin))){
            fail(`publicAppSecurity.${registryApp.appId}.${key} must contain only exact HTTPS origins or the https: scheme.`);
        }
        for(const origin of values){
            if(!registryApp.security[key].includes(origin)) fail(`publicAppSecurity.${registryApp.appId}.${key} may not widen the application registry.`);
        }
        origins[key]=Object.freeze([...new Set(values)].sort(compareText));
    }
    if(origins.frameOrigins.length&&!registryApp.capabilities.includes('web.embed')) fail(`publicAppSecurity.${registryApp.appId}.frameOrigins requires web.embed.`);
    return Object.freeze(origins);
}

function inlineScripts(html){
    return [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match=>match[1]);
}

function scriptHash(source){
    return `'sha256-${createHash('sha256').update(source,'utf8').digest('base64')}'`;
}

async function collectReleaseScriptHashes(release){
    const hashes=new Set();
    for(const entry of release.files.values()){
        if(path.posix.extname(entry.relative).toLowerCase()!=='.html') continue;
        if(entry.bytes>MAX_INLINE_HTML_BYTES) fail(`${release.appId}/${entry.relative} is too large for CSP inspection.`);
        const verified=await readVerifiedInventoryEntry(release.root,entry);
        const source=verified.body.toString('utf8');
        for(const script of inlineScripts(source)){
            hashes.add(scriptHash(script));
            hashes.add(scriptHash(`${COMPONENT_SCRIPT_PREFIX}${script}${COMPONENT_SCRIPT_SUFFIX}`));
        }
    }
    return [...hashes].sort(compareText);
}

function buildAppContentSecurityPolicy(app,publicSecurity,hashes){
    const scripts=["'self'",...hashes].join(' ');
    const connects=["'self'",...publicSecurity.connectOrigins].join(' ');
    const media=["'self'",'blob:',...publicSecurity.mediaOrigins].join(' ');
    const frames=app.capabilities.includes('web.embed')
        ?["'self'",...publicSecurity.frameOrigins].join(' ')
        :"'none'";
    return [
        "default-src 'none'",
        "base-uri 'self'",
        `script-src ${scripts}`,
        "script-src-attr 'none'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        `connect-src ${connects}`,
        `media-src ${media}`,
        "manifest-src 'self'",
        "worker-src 'self'",
        "child-src 'self'",
        `frame-src ${frames}`,
        "frame-ancestors 'none'",
        "object-src 'none'",
        "form-action 'none'"
    ].join('; ');
}

function buildAppPermissionsPolicy(app){
    return PERMISSIONS_POLICY_DENY.map(value=>{
        if(value==='microphone=()'&&app.capabilities.includes('media.microphone')) return 'microphone=(self)';
        if(value==='display-capture=()'&&app.capabilities.includes('media.display')) return 'display-capture=(self)';
        return value;
    }).sort(compareText).join(', ');
}

function normalizeUrlPrefix(value,label){
    if(typeof value!=='string'||value.length<3||!value.startsWith('/')||!value.endsWith('/')||value.includes('\\')||value.includes('\0')||value.includes('?')||value.includes('#')){
        fail(`${label} must begin and end with a slash.`);
    }
    const segments=value.slice(1,-1).split('/');
    if(segments.some(segment=>!segment||segment==='.'||segment==='..'||segment.startsWith('.'))) fail(`${label} contains an unsafe segment.`);
    return `/${segments.join('/')}/`;
}

function normalizeAliasPath(value,label){
    if(typeof value!=='string'||!value.startsWith('/')||value.length>2048||value.includes('?')||value.includes('#')||value.endsWith('/')) fail(`${label} must be an absolute file URL path.`);
    const relative=normalizeRelativePath(value.slice(1),label);
    return `/${relative}`;
}

export async function loadDomainConfiguration(configPath){
    const absoluteConfig=path.resolve(configPath);
    const config=await readJsonFile(absoluteConfig,'domain configuration',MAX_CONFIG_BYTES);
    if(config.schemaVersion!==CONFIG_SCHEMA_VERSION) fail('domain configuration has an unsupported schema version.');
    const configRoot=path.dirname(absoluteConfig);
    const projectRoot=resolveConfiguredPath(configRoot,config.projectRoot??'../..','projectRoot',{allowOutsideProject:true});
    const canonicalHost=normalizeHostname(config.canonicalHost,'canonicalHost');
    const baseDomain=normalizeHostname(config.baseDomain,'baseDomain');
    if(canonicalHost!==baseDomain) fail('canonicalHost must equal baseDomain for this server contract.');
    const siteRoot=resolveConfiguredPath(projectRoot,config.siteRoot,'siteRoot');
    const siteManifestPath=resolveConfiguredPath(projectRoot,config.siteManifest,'siteManifest');
    const distRoot=resolveConfiguredPath(projectRoot,config.distRoot??'dist','distRoot');
    const registryPath=resolveConfiguredPath(projectRoot,config.appRegistry,'appRegistry');

    if(!isPlainObject(config.redirectHosts??{})) fail('redirectHosts must be an object.');
    const redirectHosts=new Map();
    for(const [source,target] of Object.entries(config.redirectHosts??{})){
        const normalizedSource=normalizeHostname(source,'redirect hostname');
        const normalizedTarget=normalizeHostname(target,'redirect target');
        if(normalizedTarget!==canonicalHost) fail('redirect hosts may target only the canonical host.');
        if(normalizedSource===canonicalHost||redirectHosts.has(normalizedSource)) fail(`duplicate redirect hostname: ${normalizedSource}.`);
        redirectHosts.set(normalizedSource,normalizedTarget);
    }

    if(!isPlainObject(config.distApps)||Object.keys(config.distApps).length<1) fail('distApps must be a nonempty explicit map.');
    const appHosts=new Map();
    for(const [label,rawAppId] of Object.entries(config.distApps)){
        const normalizedLabel=normalizeAppId(label,'subdomain label');
        const appId=normalizeAppId(rawAppId,'dist application id');
        const hostname=normalizeHostname(`${normalizedLabel}.${baseDomain}`,'application hostname');
        if(appHosts.has(hostname)||redirectHosts.has(hostname)||hostname===canonicalHost) fail(`duplicate configured hostname: ${hostname}.`);
        appHosts.set(hostname,appId);
    }

    const mountRecords=Array.isArray(config.siteMounts)?config.siteMounts:[];
    const siteMounts=[];
    for(let index=0;index<mountRecords.length;index+=1){
        const record=mountRecords[index];
        if(!isPlainObject(record)) fail(`siteMounts[${index}] must be an object.`);
        siteMounts.push(Object.freeze({
            urlPrefix:normalizeUrlPrefix(record.urlPrefix,`siteMounts[${index}].urlPrefix`),
            appId:normalizeAppId(record.distApp,`siteMounts[${index}].distApp`),
            pathPrefix:`${normalizeRelativePath(String(record.pathPrefix??'').replace(/\/$/,''),`siteMounts[${index}].pathPrefix`)}/`
        }));
    }
    siteMounts.sort((left,right)=>right.urlPrefix.length-left.urlPrefix.length);
    if(new Set(siteMounts.map(record=>record.urlPrefix)).size!==siteMounts.length) fail('siteMounts contains duplicate URL prefixes.');

    if(!isPlainObject(config.siteAssetAliases??{})) fail('siteAssetAliases must be an object.');
    const siteAssetAliases=new Map();
    for(const [urlPath,record] of Object.entries(config.siteAssetAliases??{})){
        if(!isPlainObject(record)) fail(`siteAssetAliases.${urlPath} must be an object.`);
        const normalizedPath=normalizeAliasPath(urlPath,`site asset alias ${urlPath}`);
        siteAssetAliases.set(normalizedPath,Object.freeze({
            appId:normalizeAppId(record.distApp,`site asset ${urlPath} distApp`),
            relative:normalizeRelativePath(record.path,`site asset ${urlPath} path`)
        }));
    }

    const releaseAppIds=new Set([...appHosts.values(),...siteMounts.map(record=>record.appId),...siteAssetAliases.values()].map(record=>typeof record==='string'?record:record.appId));
    const [siteInventory,registry,releases]=await Promise.all([
        loadStaticInventory(siteManifestPath,canonicalHost),
        readJsonFile(registryPath,'application registry',MAX_MANIFEST_BYTES),
        Promise.all([...releaseAppIds].sort(compareText).map(appId=>loadAppRelease(distRoot,appId)))
    ]);
    if(!isPlainObject(registry.apps)) fail('application registry must declare an apps object.');
    const releaseMap=new Map(releases.map(release=>[release.appId,release]));
    if(!isPlainObject(config.publicAppSecurity??{})) fail('publicAppSecurity must be an object.');
    const publicAppSecurity=new Map();
    for(const [rawAppId,record] of Object.entries(config.publicAppSecurity??{})){
        const appId=normalizeAppId(rawAppId,'publicAppSecurity application id');
        if(publicAppSecurity.has(appId)) fail(`duplicate publicAppSecurity application id: ${appId}.`);
        if(!releaseMap.has(appId)) fail(`publicAppSecurity references unavailable release ${appId}.`);
        publicAppSecurity.set(appId,record);
    }
    const appPolicies=new Map();
    for(const release of releases){
        const registryApp=validateRegistryApp(registry,release.appId);
        const publicSecurity=validatePublicAppSecurity(publicAppSecurity.get(release.appId),registryApp);
        const hashes=await collectReleaseScriptHashes(release);
        appPolicies.set(release.appId,Object.freeze({
            contentSecurityPolicy:buildAppContentSecurityPolicy(registryApp,publicSecurity,hashes),
            permissionsPolicy:buildAppPermissionsPolicy(registryApp)
        }));
    }
    for(const mount of siteMounts){
        if(!releaseMap.get(mount.appId)) fail(`site mount references unavailable release ${mount.appId}.`);
    }
    for(const alias of siteAssetAliases.values()){
        const release=releaseMap.get(alias.appId);
        if(!release?.files.has(alias.relative)) fail(`site asset alias references an unlisted ${alias.appId} release file: ${alias.relative}.`);
    }

    const tls=isPlainObject(config.tls)?Object.freeze({
        certificatePath:typeof config.tls.certificatePath==='string'?path.resolve(config.tls.certificatePath):null,
        privateKeyPath:typeof config.tls.privateKeyPath==='string'?path.resolve(config.tls.privateKeyPath):null
    }):Object.freeze({certificatePath:null,privateKeyPath:null});
    const hostnames=[canonicalHost,...redirectHosts.keys(),...appHosts.keys()].sort(compareText);
    return Object.freeze({
        configPath:absoluteConfig,
        projectRoot,
        canonicalHost,
        baseDomain,
        siteRoot,
        siteManifestPath,
        siteInventory,
        distRoot,
        registryPath,
        redirectHosts,
        appHosts,
        siteMounts:Object.freeze(siteMounts),
        siteAssetAliases,
        releases:releaseMap,
        appPolicies,
        hostnames:Object.freeze(hostnames),
        tls
    });
}

export function listConfiguredHostnames(configuration){
    if(!configuration?.hostnames) fail('a loaded domain configuration is required.');
    return [...configuration.hostnames];
}

function parseHostHeader(request){
    const hostHeaders=[];
    for(let index=0;index<request.rawHeaders.length;index+=2){
        if(String(request.rawHeaders[index]).toLowerCase()==='host') hostHeaders.push(String(request.rawHeaders[index+1]??''));
    }
    if(hostHeaders.length!==1) return null;
    const raw=hostHeaders[0].trim();
    if(raw.length<1||raw.length>300||/[\s/@\\]/.test(raw)) return null;
    if(raw.startsWith('[')){
        const match=/^\[([^\]]+)\](?::([0-9]{1,5}))?$/.exec(raw);
        if(!match||!['::1','0:0:0:0:0:0:0:1'].includes(match[1].toLowerCase())) return null;
        if(match[2]&&Number(match[2])>65535) return null;
        return '::1';
    }
    const match=/^([^:]+)(?::([0-9]{1,5}))?$/.exec(raw);
    if(!match||match[2]&&Number(match[2])>65535) return null;
    const hostname=match[1].toLowerCase().replace(/\.$/,'');
    if(hostname==='localhost'||hostname==='127.0.0.1') return hostname;
    try{return normalizeHostname(hostname,'request hostname');}catch{return null;}
}

function parseRequestTarget(request){
    const raw=typeof request.url==='string'?request.url:'';
    if(!raw.startsWith('/')||Buffer.byteLength(raw,'utf8')>MAX_REQUEST_TARGET_BYTES||/[\u0000-\u001f\u007f]/.test(raw)) return null;
    const question=raw.indexOf('?');
    const rawPath=question<0?raw:raw.slice(0,question);
    if(/%2f|%5c/i.test(rawPath)) return null;
    let pathname;
    try{pathname=decodeURIComponent(rawPath);}catch{return null;}
    if(pathname.includes('\\')||pathname.includes('\0')||pathname.includes('//')) return null;
    const segments=pathname.split('/').slice(1);
    const trailing=segments.at(-1)==='';
    if(trailing) segments.pop();
    if(segments.some(segment=>!segment||segment==='.'||segment==='..')) return null;
    return Object.freeze({raw,pathname,segments:Object.freeze(segments),trailing});
}

function isDevelopmentHost(hostname){
    return hostname==='localhost'||hostname==='127.0.0.1'||hostname==='::1';
}

function requestRoute(configuration,hostname,{allowDevelopmentHosts=false}={}){
    if(hostname===configuration.canonicalHost||(allowDevelopmentHosts&&isDevelopmentHost(hostname))) return Object.freeze({type:'site',hostname});
    if(configuration.redirectHosts.has(hostname)) return Object.freeze({type:'redirect',hostname,target:configuration.redirectHosts.get(hostname)});
    const appId=configuration.appHosts.get(hostname);
    if(appId) return Object.freeze({type:'app',hostname,appId});
    return null;
}

function securityHeaders({contentSecurityPolicy,permissionsPolicy,secure=false}){
    const headers={
        ...BASE_SECURITY_HEADERS,
        'content-security-policy':contentSecurityPolicy,
        'permissions-policy':permissionsPolicy
    };
    if(secure) headers['strict-transport-security']='max-age=31536000; includeSubDomains';
    return headers;
}

function siteSecurityHeaders(secure){
    return securityHeaders({
        contentSecurityPolicy:SITE_CONTENT_SECURITY_POLICY,
        permissionsPolicy:PERMISSIONS_POLICY_DENY.slice().sort(compareText).join(', '),
        secure
    });
}

function appSecurityHeaders(configuration,appId,secure){
    const policy=configuration.appPolicies.get(appId);
    return securityHeaders({
        contentSecurityPolicy:policy.contentSecurityPolicy,
        permissionsPolicy:policy.permissionsPolicy,
        secure
    });
}

function sendResponse(request,response,status,headers={},body=''){
    const payload=Buffer.isBuffer(body)?body:Buffer.from(String(body),'utf8');
    response.writeHead(status,{
        'cache-control':'no-store',
        'content-length':payload.length,
        ...headers
    });
    if(request.method==='HEAD') response.end();
    else response.end(payload);
}

function sendText(request,response,status,message,headers={}){
    sendResponse(request,response,status,{'content-type':'text/plain; charset=utf-8',...headers},`${message}\n`);
}

function sendJson(request,response,status,value,headers={}){
    sendResponse(request,response,status,{'content-type':'application/json; charset=utf-8',...headers},JSON.stringify(value));
}

function redirect(request,response,location,status=308,headers={}){
    sendResponse(request,response,status,{'location':location,'content-type':'text/plain; charset=utf-8',...headers},`Redirecting to ${location}\n`);
}

function contentType(relative){
    return MIME_TYPES[path.posix.extname(relative).toLowerCase()]??'application/octet-stream';
}

function cacheControl(relative){
    const basename=path.posix.basename(relative).toLowerCase();
    const extension=path.posix.extname(relative).toLowerCase();
    if(extension==='.html'||basename==='service-worker.js'||extension==='.webmanifest'||basename==='manifest.json') return 'no-cache';
    return 'public, max-age=3600, must-revalidate';
}

function isInside(root,candidate){
    const prefix=root.endsWith(path.sep)?root:`${root}${path.sep}`;
    return candidate===root||candidate.startsWith(prefix);
}

async function readExactFile(handle,bytes,label){
    const body=Buffer.allocUnsafe(bytes);
    let offset=0;
    while(offset<bytes){
        const result=await handle.read(body,offset,bytes-offset,offset);
        if(result.bytesRead===0) fail(`${label} changed while it was being read.`);
        offset+=result.bytesRead;
    }
    const probe=Buffer.allocUnsafe(1);
    const trailing=await handle.read(probe,0,1,bytes);
    if(trailing.bytesRead!==0) fail(`${label} changed while it was being read.`);
    return body;
}

async function readVerifiedInventoryEntry(root,entry){
    const absolute=resolveInside(root,entry.relative,'inventory file');
    const metadata=await lstat(absolute).catch(()=>null);
    if(!metadata?.isFile()||metadata.isSymbolicLink()) fail(`published file is missing or not regular: ${entry.relative}.`);
    if(metadata.size!==entry.bytes) fail(`published file size does not match its manifest: ${entry.relative}.`);
    const resolved=await realpath(absolute);
    const resolvedRoot=await realpath(root);
    if(!isInside(resolvedRoot,resolved)) fail(`published file resolves outside its release root: ${entry.relative}.`);
    const handle=await open(resolved,'r');
    try{
        const openedMetadata=await handle.stat();
        if(!openedMetadata.isFile()||openedMetadata.size!==entry.bytes) fail(`published file changed before it could be read: ${entry.relative}.`);
        const body=await readExactFile(handle,entry.bytes,`published file ${entry.relative}`);
        const digest=createHash('sha256').update(body).digest('hex');
        if(digest!==entry.sha256) fail(`published file digest does not match its manifest: ${entry.relative}.`);
        return Object.freeze({body,metadata:openedMetadata});
    }finally{
        await handle.close();
    }
}

async function serveInventoryFile(request,response,{root,entry,headers}){
    const verified=await readVerifiedInventoryEntry(root,entry);
    const etag=`"sha256-${entry.sha256}"`;
    if(request.headers['if-none-match']===etag){
        response.writeHead(304,{
            ...headers,
            'cache-control':cacheControl(entry.relative),
            'etag':etag
        });
        response.end();
        return;
    }
    response.writeHead(200,{
        ...headers,
        'accept-ranges':'none',
        'cache-control':cacheControl(entry.relative),
        'content-length':entry.bytes,
        'content-type':contentType(entry.relative),
        'etag':etag,
        'last-modified':verified.metadata.mtime.toUTCString()
    });
    if(request.method==='HEAD'){
        response.end();
        return;
    }
    response.end(verified.body);
}

function inventoryPath(target){
    if(target.segments.length===0) return 'index.html';
    const relative=target.segments.join('/');
    return target.trailing?`${relative}/index.html`:relative;
}

async function serveAcmeChallenge(configuration,request,response,target,headers){
    if(target.segments.length!==3||target.segments[0]!=='.well-known'||target.segments[1]!=='acme-challenge') return false;
    const token=target.segments[2];
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(token)){
        sendText(request,response,400,'Invalid ACME challenge token.',headers);
        return true;
    }
    const challengeRoot=path.join(configuration.siteRoot,'.well-known','acme-challenge');
    const candidate=path.join(challengeRoot,token);
    const metadata=await lstat(candidate).catch(()=>null);
    if(!metadata?.isFile()||metadata.isSymbolicLink()){
        sendText(request,response,404,'Not found.',headers);
        return true;
    }
    const resolved=await realpath(candidate);
    const resolvedRoot=await realpath(challengeRoot);
    if(!isInside(resolvedRoot,resolved)){
        sendText(request,response,404,'Not found.',headers);
        return true;
    }
    if(metadata.size<3||metadata.size>MAX_ACME_RESPONSE_BYTES){
        sendText(request,response,404,'Not found.',headers);
        return true;
    }
    const handle=await open(resolved,'r');
    let body;
    try{
        const openedMetadata=await handle.stat();
        if(!openedMetadata.isFile()||openedMetadata.size!==metadata.size||openedMetadata.size>MAX_ACME_RESPONSE_BYTES){
            sendText(request,response,404,'Not found.',headers);
            return true;
        }
        body=await readExactFile(handle,openedMetadata.size,'ACME challenge response');
    }finally{
        await handle.close();
    }
    const challenge=body.toString('ascii').trimEnd();
    if(!challenge.startsWith(`${token}.`)||!/^[A-Za-z0-9_-]{1,200}\.[A-Za-z0-9_-]{1,200}$/.test(challenge)){
        sendText(request,response,404,'Not found.',headers);
        return true;
    }
    response.writeHead(200,{
        ...headers,
        'cache-control':'no-store',
        'content-length':body.length,
        'content-type':'text/plain; charset=utf-8'
    });
    if(request.method==='HEAD') response.end();
    else response.end(body);
    return true;
}

async function serveSite(configuration,request,response,target,headers){
    const alias=configuration.siteAssetAliases.get(target.pathname);
    if(alias){
        const release=configuration.releases.get(alias.appId);
        const entry=release.files.get(alias.relative);
        await serveInventoryFile(request,response,{root:release.root,entry,headers});
        return;
    }
    for(const mount of configuration.siteMounts){
        if(!target.pathname.startsWith(mount.urlPrefix)) continue;
        const suffix=target.pathname.slice(mount.urlPrefix.length);
        if(!suffix||target.trailing){
            sendText(request,response,404,'Not found.',headers);
            return;
        }
        const relative=`${mount.pathPrefix}${suffix}`;
        let normalized;
        try{normalized=normalizeRelativePath(relative,'mounted release path');}catch{
            sendText(request,response,400,'Invalid request path.',headers);
            return;
        }
        const release=configuration.releases.get(mount.appId);
        const entry=release.files.get(normalized);
        if(!entry){
            sendText(request,response,404,'Not found.',headers);
            return;
        }
        await serveInventoryFile(request,response,{root:release.root,entry,headers});
        return;
    }
    const relative=inventoryPath(target);
    const entry=configuration.siteInventory.files.get(relative);
    if(!entry){
        sendText(request,response,404,'Not found.',headers);
        return;
    }
    await serveInventoryFile(request,response,{root:configuration.siteRoot,entry,headers});
}

async function serveApp(configuration,route,request,response,target,headers){
    const release=configuration.releases.get(route.appId);
    if(target.segments.length===0||target.pathname==='/index.html'){
        redirect(request,response,`/${release.start}`,302,headers);
        return;
    }
    const relative=inventoryPath(target);
    const entry=release.files.get(relative);
    if(!entry){
        sendText(request,response,404,'Not found.',headers);
        return;
    }
    await serveInventoryFile(request,response,{root:release.root,entry,headers});
}

export function createDomainRequestHandler(configuration,{secure=false,redirectHttp=false,allowDevelopmentHosts=false}={}){
    if(!configuration?.canonicalHost) fail('a loaded domain configuration is required.');
    return function domainRequestHandler(request,response){
        void (async()=>{
            if(!['GET','HEAD'].includes(request.method)){
                request.resume();
                response.shouldKeepAlive=false;
                sendText(request,response,405,'Method not allowed.',{'allow':'GET, HEAD','connection':'close',...siteSecurityHeaders(secure)});
                return;
            }
            if(request.headers['content-length']||request.headers['transfer-encoding']){
                response.shouldKeepAlive=false;
                sendText(request,response,400,'Request bodies are not accepted.',{'connection':'close',...siteSecurityHeaders(secure)});
                return;
            }
            const hostname=parseHostHeader(request);
            if(!hostname){
                sendText(request,response,400,'A single valid Host header is required.',siteSecurityHeaders(secure));
                return;
            }
            const route=requestRoute(configuration,hostname,{allowDevelopmentHosts});
            if(!route){
                sendText(request,response,421,'Misdirected request.',siteSecurityHeaders(secure));
                return;
            }
            const target=parseRequestTarget(request);
            if(!target){
                sendText(request,response,400,'Invalid request target.',siteSecurityHeaders(secure));
                return;
            }
            const routeHeaders=route.type==='app'
                ?appSecurityHeaders(configuration,route.appId,secure)
                :siteSecurityHeaders(secure);
            if(await serveAcmeChallenge(configuration,request,response,target,routeHeaders)) return;
            if(redirectHttp&&!secure){
                redirect(request,response,`https://${hostname}${target.raw}`,308,routeHeaders);
                return;
            }
            if(route.type==='redirect'){
                redirect(request,response,`${secure?'https':'http'}://${route.target}${target.raw}`,308,routeHeaders);
                return;
            }
            if(target.pathname==='/_health'){
                sendJson(request,response,200,{service:'precrisis-domain',status:'ok',host:route.hostname,tls:secure},routeHeaders);
                return;
            }
            if(route.type==='site') await serveSite(configuration,request,response,target,routeHeaders);
            else await serveApp(configuration,route,request,response,target,routeHeaders);
        })().catch(error=>{
            if(response.headersSent){
                response.destroy(error);
                return;
            }
            sendText(request,response,500,'The server could not complete the request.',siteSecurityHeaders(secure));
        });
    };
}

function hardenServer(server){
    server.headersTimeout=10000;
    server.requestTimeout=15000;
    server.keepAliveTimeout=5000;
    server.maxHeadersCount=64;
    server.maxRequestsPerSocket=100;
    server.maxConnections=64;
    server.setTimeout(30000,socket=>socket.destroy());
    return server;
}

function listen(server,port,host){
    return new Promise((resolve,reject)=>{
        const onError=error=>{server.off('listening',onListening);reject(error);};
        const onListening=()=>{server.off('error',onError);resolve(server.address());};
        server.once('error',onError);
        server.once('listening',onListening);
        server.listen(port,host);
    });
}

function closeServer(server){
    if(!server?.listening) return Promise.resolve();
    return new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}

async function readTlsMaterial(certificatePath,privateKeyPath){
    if(!certificatePath||!privateKeyPath) return null;
    try{
        const [cert,key]=await Promise.all([readFile(certificatePath),readFile(privateKeyPath)]);
        return Object.freeze({cert,key});
    }catch{return null;}
}

export async function startDomainServer({
    configPath,
    host='127.0.0.1',
    httpPort=8080,
    httpsPort=8443,
    certificatePath=null,
    privateKeyPath=null,
    requireTls=false,
    redirectHttp=true,
    allowDevelopmentHosts=host==='127.0.0.1'||host==='::1'||host==='localhost'
}={}){
    if(!configPath) fail('configPath is required.');
    assertSafeInteger(httpPort,'HTTP port',{maximum:65535});
    assertSafeInteger(httpsPort,'HTTPS port',{maximum:65535});
    const configuration=await loadDomainConfiguration(configPath);
    const tlsCertificate=certificatePath??configuration.tls.certificatePath;
    const tlsPrivateKey=privateKeyPath??configuration.tls.privateKeyPath;
    const tlsMaterial=await readTlsMaterial(tlsCertificate,tlsPrivateKey);
    if(requireTls&&!tlsMaterial) fail('TLS is required, but the configured certificate or private key could not be read.');
    const httpsServer=tlsMaterial
        ?hardenServer(https.createServer(tlsMaterial,createDomainRequestHandler(configuration,{secure:true,allowDevelopmentHosts})))
        :null;
    const httpServer=hardenServer(http.createServer(createDomainRequestHandler(configuration,{
        secure:false,
        redirectHttp:Boolean(httpsServer&&redirectHttp),
        allowDevelopmentHosts
    })));
    let httpAddress;
    let httpsAddress;
    try{
        httpAddress=await listen(httpServer,httpPort,host);
        if(httpsServer) httpsAddress=await listen(httpsServer,httpsPort,host);
    }catch(error){
        await Promise.allSettled([closeServer(httpServer),closeServer(httpsServer)]);
        throw error;
    }
    return Object.freeze({
        configuration,
        httpServer,
        httpsServer,
        httpAddress,
        httpsAddress,
        async reloadTls(){
            if(!httpsServer) return false;
            const refreshed=await readTlsMaterial(tlsCertificate,tlsPrivateKey);
            if(!refreshed) fail('the renewed TLS certificate or private key could not be read.');
            httpsServer.setSecureContext(refreshed);
            return true;
        },
        async close(){
            await Promise.all([closeServer(httpServer),closeServer(httpsServer)]);
        }
    });
}

async function enumerateStaticFiles(root,current='',records=[]){
    const actualDirectory=current?resolveInside(root,current,'site inventory path'):root;
    const entries=await readdir(actualDirectory,{withFileTypes:true});
    entries.sort((left,right)=>compareText(left.name,right.name));
    for(const entry of entries){
        if(entry.name.startsWith('.')) continue;
        const relative=current?`${current}/${entry.name}`:entry.name;
        if(entry.isSymbolicLink()) fail(`site inventory refuses symbolic link ${relative}.`);
        if(entry.isDirectory()) await enumerateStaticFiles(root,relative,records);
        else if(entry.isFile()){
            const file=resolveInside(root,relative,'site inventory file');
            const metadata=await stat(file);
            const digest=createHash('sha256');
            for await(const chunk of createReadStream(file)) digest.update(chunk);
            records.push(Object.freeze({path:relative,bytes:metadata.size,sha256:digest.digest('hex')}));
        }else fail(`site inventory refuses special filesystem entry ${relative}.`);
    }
    return records;
}

export async function createStaticSiteRelease({siteRoot,site}={}){
    const canonicalHost=normalizeHostname(site,'site');
    const root=path.resolve(siteRoot);
    const metadata=await lstat(root).catch(()=>null);
    if(!metadata?.isDirectory()||metadata.isSymbolicLink()) fail('siteRoot must be a regular directory.');
    const files=await enumerateStaticFiles(root);
    files.sort((left,right)=>compareText(left.path,right.path));
    if(!files.some(file=>file.path==='index.html')) fail('siteRoot must contain index.html.');
    return Object.freeze({schemaVersion:RELEASE_SCHEMA_VERSION,site:canonicalHost,files:Object.freeze(files)});
}

export default Object.freeze({
    createDomainRequestHandler,
    createStaticSiteRelease,
    listConfiguredHostnames,
    loadDomainConfiguration,
    startDomainServer
});
