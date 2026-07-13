import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    rmdir,
    stat,
    symlink,
    unlink,
    writeFile
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,describe,it} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {
    bumpVersion,
    discoverApps,
    incrementSemver,
    inspectApp,
    packageApp,
    parseSemver,
    verifyApp
} from '../tools/app-packager/core.mjs';

const execFile=promisify(execFileCallback);
const cliPath=fileURLToPath(new URL('../tools/package-app.mjs',import.meta.url));
const temporaryRoots=new Set();

afterEach(async()=>{
    await Promise.all(
        [...temporaryRoots].map(root=>rm(root,{recursive:true,force:true}))
    );
    temporaryRoots.clear();
});

async function writeJson(filePath,value){
    await mkdir(path.dirname(filePath),{recursive:true});
    await writeFile(filePath,`${JSON.stringify(value,null,2)}\n`,'utf8');
}

async function readJson(filePath){
    return JSON.parse(await readFile(filePath,'utf8'));
}

async function createWorkspace(rootConfig={}){
    const workspaceRoot=await mkdtemp(
        path.join(tmpdir(),'arcane-app-packager-test-')
    );
    temporaryRoots.add(workspaceRoot);
    await mkdir(path.join(workspaceRoot,'apps'),{recursive:true});
    await writeJson(
        path.join(workspaceRoot,'arcane-packager.json'),
        {
            schemaVersion:1,
            appsRoot:'apps',
            distRoot:'dist',
            sharedPayloads:{},
            ...rootConfig
        }
    );
    return workspaceRoot;
}

async function createApp(
    workspaceRoot,
    id,
    {
        config={},
        files={
            'index.html':'<!doctype html><title>Fixture app</title>\n'
        }
    }={}
){
    const appRoot=path.join(workspaceRoot,'apps',id);
    await mkdir(appRoot,{recursive:true});
    const appConfig={
        schemaVersion:1,
        id,
        displayName:`${id} fixture`,
        version:'1.2.3',
        entry:'index.html',
        strategy:'static',
        include:['index.html'],
        exclude:[],
        shared:[],
        ...config
    };

    await writeJson(path.join(appRoot,'arcane-package.json'),appConfig);
    for(const [relativePath,contents] of Object.entries(files)){
        const filePath=path.join(appRoot,...relativePath.split('/'));
        await mkdir(path.dirname(filePath),{recursive:true});
        await writeFile(filePath,contents);
    }

    return {appConfig,appRoot};
}

async function updateRootConfig(workspaceRoot,update){
    const configPath=path.join(workspaceRoot,'arcane-packager.json');
    const current=await readJson(configPath);
    await writeJson(configPath,{...current,...update});
}

async function updateAppConfig(workspaceRoot,id,update){
    const configPath=path.join(
        workspaceRoot,
        'apps',
        id,
        'arcane-package.json'
    );
    const current=await readJson(configPath);
    await writeJson(configPath,{...current,...update});
}

function releaseRoot(workspaceRoot,id){
    return path.join(workspaceRoot,'dist',id);
}

function releaseAppRoot(workspaceRoot,id){
    return path.join(releaseRoot(workspaceRoot,id),'apps',id);
}

function releaseManifestPath(workspaceRoot,id){
    return path.join(releaseRoot(workspaceRoot,id),'ARCANE_APP_RELEASE.json');
}

async function exists(filePath){
    return access(filePath).then(()=>true,()=>false);
}

async function sha256(filePath){
    return createHash('sha256')
        .update(await readFile(filePath))
        .digest('hex');
}

async function waitForFile(filePath,timeoutMs=3000){
    const deadline=Date.now()+timeoutMs;

    while(Date.now()<deadline){
        if(await exists(filePath)){
            return;
        }

        await new Promise(resolve=>setTimeout(resolve,10));
    }

    assert.fail(`Timed out waiting for fixture signal: ${filePath}`);
}

describe('Arcane app discovery and inspection',()=>{
    it('lists every app directory in stable order and reports configured versions',async()=>{
        const workspaceRoot=await createWorkspace();
        await createApp(workspaceRoot,'zeta',{
            config:{displayName:'Zeta Desk',version:'3.4.5'}
        });
        await createApp(workspaceRoot,'alpha',{
            config:{displayName:'Alpha Desk',version:'1.0.0'}
        });
        await mkdir(path.join(workspaceRoot,'apps','unconfigured'),{recursive:true});
        await writeFile(
            path.join(workspaceRoot,'apps','README.txt'),
            'This is not an app directory.\n'
        );

        const apps=await discoverApps({workspaceRoot});

        assert.ok(Array.isArray(apps));
        assert.deepEqual(
            apps.map(app=>app.id),
            ['alpha','unconfigured','zeta']
        );
        assert.equal(apps.find(app=>app.id==='alpha').version,'1.0.0');
        assert.equal(apps.find(app=>app.id==='alpha').configured,true);
        assert.equal(apps.find(app=>app.id==='unconfigured').configured,false);

        const alpha=await inspectApp({workspaceRoot,appId:'alpha'});
        assert.equal(alpha.id,'alpha');
        assert.equal(alpha.displayName,'Alpha Desk');
        assert.equal(alpha.version,'1.0.0');
        assert.equal(alpha.entry,'index.html');
        assert.equal(alpha.strategy,'static');
    });

    it('rejects unknown and traversal-like app identifiers',async()=>{
        const workspaceRoot=await createWorkspace();
        await createApp(workspaceRoot,'alpha');

        await assert.rejects(
            inspectApp({workspaceRoot,appId:'missing'}),
            /app|missing|not found/i
        );
        await assert.rejects(
            inspectApp({workspaceRoot,appId:'../alpha'}),
            /app|safe|invalid|path|relative/i
        );
        await assert.rejects(
            inspectApp({workspaceRoot,appId:'..\\alpha'}),
            /app|safe|invalid|path|relative/i
        );
    });
});

describe('Arcane app semantic versions',()=>{
    it('strictly parses SemVer and increments stable and prerelease versions',()=>{
        const parsed=parseSemver('12.34.56-alpha.7+build.9');

        assert.equal(parsed.major,12);
        assert.equal(parsed.minor,34);
        assert.equal(parsed.patch,56);
        assert.equal(incrementSemver('1.2.3','patch'),'1.2.4');
        assert.equal(incrementSemver('1.2.3','minor'),'1.3.0');
        assert.equal(incrementSemver('1.2.3','major'),'2.0.0');
        assert.equal(
            incrementSemver('1.2.3','prerelease','beta'),
            '1.2.4-beta.0'
        );
    });

    it('rejects non-SemVer strings, leading zeroes, and invalid bump names',()=>{
        for(const invalid of [
            '',
            '1',
            '1.2',
            'v1.2.3',
            '01.2.3',
            '1.02.3',
            '1.2.03',
            '1.2.3-',
            '1.2.3+'
        ]){
            assert.throws(()=>parseSemver(invalid),/version|semver|valid/i);
        }

        assert.throws(
            ()=>incrementSemver('1.2.3','banana'),
            /bump|version|semver/i
        );
        assert.throws(
            ()=>incrementSemver('1.2.3','prerelease','bad preid'),
            /pre|identifier|version|semver/i
        );
    });

    it('updates app versions explicitly and keeps dry runs non-mutating',async()=>{
        const workspaceRoot=await createWorkspace();
        await createApp(workspaceRoot,'alpha',{
            config:{version:'2.3.4'}
        });
        const configPath=path.join(
            workspaceRoot,
            'apps','alpha','arcane-package.json'
        );

        await bumpVersion({
            workspaceRoot,
            appId:'alpha',
            bump:'minor',
            dryRun:true
        });
        assert.equal((await readJson(configPath)).version,'2.3.4');

        await bumpVersion({
            workspaceRoot,
            appId:'alpha',
            bump:'minor'
        });
        assert.equal((await readJson(configPath)).version,'2.4.0');

        await bumpVersion({
            workspaceRoot,
            appId:'alpha',
            exactVersion:'5.0.0-rc.1'
        });
        assert.equal((await readJson(configPath)).version,'5.0.0-rc.1');

        await assert.rejects(
            bumpVersion({
                workspaceRoot,
                appId:'alpha',
                exactVersion:'not-a-version'
            }),
            /version|semver|valid/i
        );
        assert.equal((await readJson(configPath)).version,'5.0.0-rc.1');
    });

    it('passes a custom prerelease identifier through package and bump operations',async()=>{
        const packageWorkspace=await createWorkspace();
        await createApp(packageWorkspace,'alpha');

        const packaged=await packageApp({
            workspaceRoot:packageWorkspace,
            appId:'alpha',
            bump:'prerelease',
            preid:'beta'
        });
        const packageConfig=await readJson(path.join(
            packageWorkspace,
            'apps','alpha','arcane-package.json'
        ));
        const packageManifest=await readJson(
            releaseManifestPath(packageWorkspace,'alpha')
        );

        assert.equal(packaged.version,'1.2.4-beta.0');
        assert.equal(packageConfig.version,'1.2.4-beta.0');
        assert.equal(packageManifest.app.version,'1.2.4-beta.0');
        assert.equal(JSON.stringify(packaged).includes('-rc.'),false);

        const bumpWorkspace=await createWorkspace();
        await createApp(bumpWorkspace,'alpha');
        const bumped=await bumpVersion({
            workspaceRoot:bumpWorkspace,
            appId:'alpha',
            bump:'prerelease',
            preid:'beta'
        });
        const bumpConfig=await readJson(path.join(
            bumpWorkspace,
            'apps','alpha','arcane-package.json'
        ));

        assert.equal(bumped.version,'1.2.4-beta.0');
        assert.equal(bumpConfig.version,'1.2.4-beta.0');
        assert.equal(JSON.stringify(bumped).includes('-rc.'),false);
    });
});

describe('Arcane static app packaging',()=>{
    it('applies literal includes and excludes and resolves declared shared routes',async()=>{
        const workspaceRoot=await createWorkspace({
            sharedPayloads:{
                'browser-runtime':[
                    {
                        source:'arcane',
                        destination:'arcane',
                        include:['modules'],
                        exclude:['modules/private']
                    },
                    {
                        source:'node_modules/tiny-runtime',
                        destination:'node_modules/tiny-runtime',
                        include:['index.js'],
                        exclude:[]
                    }
                ]
            }
        });
        await createApp(workspaceRoot,'alpha',{
            config:{
                include:['index.html','assets','private'],
                exclude:['assets/maps','private'],
                shared:['browser-runtime']
            },
            files:{
                'index.html':'<!doctype html><title>Alpha</title>\n',
                'assets/app.css':'body { color: navy; }\n',
                'assets/icons/logo.svg':'<svg></svg>\n',
                'assets/maps/app.css.map':'private source map\n',
                'private/secret.txt':'do not publish\n',
                'private/nested/credentials.txt':'do not publish either\n',
                'scripts/build.mjs':'not included\n'
            }
        });
        await mkdir(
            path.join(workspaceRoot,'arcane','modules','private'),
            {recursive:true}
        );
        await mkdir(
            path.join(workspaceRoot,'arcane','images'),
            {recursive:true}
        );
        await mkdir(
            path.join(workspaceRoot,'node_modules','tiny-runtime'),
            {recursive:true}
        );
        await writeFile(
            path.join(workspaceRoot,'arcane','modules','runtime.js'),
            'export const ready=true;\n'
        );
        await writeFile(
            path.join(workspaceRoot,'arcane','modules','private','secret.js'),
            'export const secret=true;\n'
        );
        await writeFile(
            path.join(workspaceRoot,'arcane','images','unused.svg'),
            '<svg></svg>\n'
        );
        await writeFile(
            path.join(workspaceRoot,'node_modules','tiny-runtime','index.js'),
            'export default true;\n'
        );

        await packageApp({workspaceRoot,appId:'alpha'});

        const appOutput=releaseAppRoot(workspaceRoot,'alpha');
        assert.equal(await exists(path.join(appOutput,'index.html')),true);
        assert.equal(await exists(path.join(appOutput,'assets','app.css')),true);
        assert.equal(
            await exists(path.join(appOutput,'assets','icons','logo.svg')),
            true
        );
        assert.equal(
            await exists(path.join(appOutput,'assets','maps','app.css.map')),
            false
        );
        assert.equal(await exists(path.join(appOutput,'private')),false);
        assert.equal(await exists(path.join(appOutput,'scripts')),false);
        assert.equal(
            await exists(
                path.join(releaseRoot(workspaceRoot,'alpha'),'arcane','modules','runtime.js')
            ),
            true
        );
        assert.equal(
            await exists(
                path.join(releaseRoot(workspaceRoot,'alpha'),'arcane','modules','private')
            ),
            false
        );
        assert.equal(
            await exists(
                path.join(releaseRoot(workspaceRoot,'alpha'),'arcane','images')
            ),
            false
        );
        assert.equal(
            await exists(
                path.join(
                    releaseRoot(workspaceRoot,'alpha'),
                    'node_modules','tiny-runtime','index.js'
                )
            ),
            true
        );

        const release=await readJson(releaseManifestPath(workspaceRoot,'alpha'));
        assert.equal(release.app.id,'alpha');
        assert.equal(release.app.version,'1.2.3');
        assert.match(release.app.start,/apps\/alpha\/index\.html$/);
        const packageIndex=await readFile(
            path.join(releaseRoot(workspaceRoot,'alpha'),'index.html'),
            'utf8'
        );
        assert.match(packageIndex,/apps\/alpha\/index\.html/);
    });

    it('writes a deterministic, complete inventory and detects every kind of tampering',async()=>{
        const workspaceRoot=await createWorkspace();
        await createApp(workspaceRoot,'alpha',{
            config:{include:['index.html','assets']},
            files:{
                'index.html':'<!doctype html><title>Alpha</title>\n',
                'assets/app.css':'body { color: navy; }\n',
                'assets/logo.bin':Buffer.from([0,1,2,3,254,255])
            }
        });

        await packageApp({workspaceRoot,appId:'alpha'});
        const first=await readJson(releaseManifestPath(workspaceRoot,'alpha'));
        const paths=first.files.map(file=>file.path);

        assert.equal(first.schemaVersion,1);
        assert.equal(first.builder,'arcane-app-packager-v1');
        assert.equal(first.fileCount,first.files.length);
        assert.equal(first.totalBytes,first.files.reduce(
            (total,file)=>total+file.bytes,
            0
        ));
        assert.deepEqual(paths,[...paths].sort((left,right)=>
            left.localeCompare(right,'en')
        ));
        assert.equal(new Set(paths).size,paths.length);
        assert.equal(paths.includes('ARCANE_APP_RELEASE.json'),false);

        for(const file of first.files){
            assert.equal(file.path.includes('\\'),false);
            const absolute=path.join(
                releaseRoot(workspaceRoot,'alpha'),
                ...file.path.split('/')
            );
            const details=await stat(absolute);
            assert.equal(details.isFile(),true);
            assert.equal(file.bytes,details.size);
            assert.equal(file.sha256,await sha256(absolute));
        }

        await verifyApp({workspaceRoot,appId:'alpha'});
        await packageApp({workspaceRoot,appId:'alpha'});
        const second=await readJson(releaseManifestPath(workspaceRoot,'alpha'));
        assert.deepEqual(second,first);

        const appCss=path.join(
            releaseAppRoot(workspaceRoot,'alpha'),
            'assets','app.css'
        );
        await writeFile(appCss,'tampered\n');
        await assert.rejects(
            verifyApp({workspaceRoot,appId:'alpha'}),
            /hash|inventory|integrity|mismatch|bytes|package tree/i
        );

        await packageApp({workspaceRoot,appId:'alpha'});
        await writeFile(
            path.join(releaseRoot(workspaceRoot,'alpha'),'unexpected.txt'),
            'unexpected\n'
        );
        await assert.rejects(
            verifyApp({workspaceRoot,appId:'alpha'}),
            /extra|inventory|integrity|mismatch|unexpected|count|package tree/i
        );

        await packageApp({workspaceRoot,appId:'alpha'});
        await rm(appCss);
        await assert.rejects(
            verifyApp({workspaceRoot,appId:'alpha'}),
            /missing|inventory|integrity|mismatch|count|package tree/i
        );
    });

    it('rejects an internally intact release when its public file policy becomes stricter',async()=>{
        const workspaceRoot=await createWorkspace();
        await createApp(workspaceRoot,'alpha',{
            config:{
                include:['index.html','private'],
                exclude:[]
            },
            files:{
                'index.html':'<!doctype html><title>Alpha</title>\n',
                'private/secret.txt':'previously approved fixture content\n'
            }
        });

        await packageApp({workspaceRoot,appId:'alpha'});
        await verifyApp({workspaceRoot,appId:'alpha'});
        const manifestPath=releaseManifestPath(workspaceRoot,'alpha');
        const manifestBefore=await readFile(manifestPath,'utf8');
        const releaseBefore=JSON.parse(manifestBefore);
        const secretPath=path.join(
            releaseAppRoot(workspaceRoot,'alpha'),
            'private','secret.txt'
        );
        assert.equal(
            await readFile(secretPath,'utf8'),
            'previously approved fixture content\n'
        );
        assert.equal(typeof releaseBefore.policySha256,'string');
        assert.equal(releaseBefore.policySha256.length,64);

        await updateAppConfig(workspaceRoot,'alpha',{exclude:['private']});

        await assert.rejects(
            verifyApp({workspaceRoot,appId:'alpha'}),
            /policy|identity|release/i
        );
        assert.equal(await readFile(manifestPath,'utf8'),manifestBefore);
        assert.equal(
            await readFile(secretPath,'utf8'),
            'previously approved fixture content\n'
        );
        assert.equal(
            (await readJson(manifestPath)).policySha256,
            releaseBefore.policySha256
        );
    });

    it('keeps package dry runs non-mutating and commits a bump only after success',async()=>{
        const workspaceRoot=await createWorkspace();
        await createApp(workspaceRoot,'alpha',{
            config:{version:'7.8.9'}
        });
        const configPath=path.join(
            workspaceRoot,
            'apps','alpha','arcane-package.json'
        );

        await packageApp({
            workspaceRoot,
            appId:'alpha',
            bump:'minor',
            dryRun:true
        });
        assert.equal(await exists(releaseRoot(workspaceRoot,'alpha')),false);
        assert.equal((await readJson(configPath)).version,'7.8.9');

        await packageApp({workspaceRoot,appId:'alpha',bump:'minor'});
        assert.equal((await readJson(configPath)).version,'7.9.0');
        assert.equal(
            (await readJson(releaseManifestPath(workspaceRoot,'alpha'))).app.version,
            '7.9.0'
        );
    });

    it('preserves the previous package and source version after a failed rebuild',async()=>{
        const workspaceRoot=await createWorkspace();
        await createApp(workspaceRoot,'alpha',{
            config:{version:'4.5.6'}
        });
        const configPath=path.join(
            workspaceRoot,
            'apps','alpha','arcane-package.json'
        );

        await packageApp({workspaceRoot,appId:'alpha'});
        const previousManifest=await readFile(
            releaseManifestPath(workspaceRoot,'alpha'),
            'utf8'
        );
        const previousIndex=await readFile(
            path.join(releaseAppRoot(workspaceRoot,'alpha'),'index.html'),
            'utf8'
        );

        await updateRootConfig(workspaceRoot,{
            sharedPayloads:{
                broken:[
                    {
                        source:'missing-runtime',
                        destination:'arcane',
                        include:['modules'],
                        exclude:[]
                    }
                ]
            }
        });
        await updateAppConfig(workspaceRoot,'alpha',{shared:['broken']});

        await assert.rejects(
            packageApp({workspaceRoot,appId:'alpha',bump:'patch'}),
            /missing|source|payload|not found|enoent/i
        );
        assert.equal((await readJson(configPath)).version,'4.5.6');
        assert.equal(
            await readFile(releaseManifestPath(workspaceRoot,'alpha'),'utf8'),
            previousManifest
        );
        assert.equal(
            await readFile(
                path.join(releaseAppRoot(workspaceRoot,'alpha'),'index.html'),
                'utf8'
            ),
            previousIndex
        );
    });
});

describe('Arcane adapter packaging safety',()=>{
    it('uses one app lock for concurrent package and bump operations',async()=>{
        const workspaceRoot=await createWorkspace();
        await createApp(workspaceRoot,'alpha',{
            config:{
                strategy:'adapter',
                adapter:'scripts/delayed-adapter.mjs'
            },
            files:{
                'index.html':'<!doctype html><title>Alpha</title>\n',
                'scripts/delayed-adapter.mjs':`
import {access,writeFile} from 'node:fs/promises';
import path from 'node:path';

export async function buildArcanePackage({appRoot,outputRoot,prepareBase}){
    await prepareBase(outputRoot);
    const started=path.join(appRoot,'.adapter-started');
    const release=path.join(appRoot,'.adapter-release');
    await writeFile(started,'started\\n','utf8');

    for(let attempt=0;attempt<500;attempt++){
        try{
            await access(release);
            return;
        }catch(error){
            if(error?.code!=='ENOENT'){
                throw error;
            }
        }

        await new Promise(resolve=>setTimeout(resolve,10));
    }

    throw new Error('Timed out waiting for the test release gate.');
}

export async function verifyArcanePackage(){}
`
            }
        });
        const appRoot=path.join(workspaceRoot,'apps','alpha');
        const started=path.join(appRoot,'.adapter-started');
        const release=path.join(appRoot,'.adapter-release');
        const packaging=packageApp({
            workspaceRoot,
            appId:'alpha',
            bump:'patch'
        });
        let packageResult;

        try{
            await waitForFile(started);
            await assert.rejects(
                bumpVersion({
                    workspaceRoot,
                    appId:'alpha',
                    bump:'minor'
                }),
                /another package operation|already running|lock/i
            );
        }finally{
            await writeFile(release,'continue\n','utf8');
            packageResult=await packaging;
        }

        const sourceVersion=(await readJson(path.join(
            appRoot,
            'arcane-package.json'
        ))).version;
        const distVersion=(await readJson(
            releaseManifestPath(workspaceRoot,'alpha')
        )).app.version;

        assert.equal(packageResult.version,'1.2.4');
        assert.equal(sourceVersion,'1.2.4');
        assert.equal(distVersion,'1.2.4');
        assert.equal(sourceVersion,distVersion);
        assert.equal(
            await exists(path.join(
                workspaceRoot,
                'dist',
                '.arcane-packager-alpha.lock'
            )),
            false
        );
    });

    it('rejects verifier mutations and preserves the previous valid package',async()=>{
        const workspaceRoot=await createWorkspace();
        const {appRoot}=await createApp(workspaceRoot,'alpha');

        await packageApp({workspaceRoot,appId:'alpha'});
        const previousManifest=await readFile(
            releaseManifestPath(workspaceRoot,'alpha'),
            'utf8'
        );
        const previousIndex=await readFile(
            path.join(releaseAppRoot(workspaceRoot,'alpha'),'index.html'),
            'utf8'
        );
        const adapterPath=path.join(
            appRoot,
            'scripts',
            'mutating-verifier.mjs'
        );
        await mkdir(path.dirname(adapterPath),{recursive:true});
        await writeFile(
            adapterPath,
            `
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

export async function buildArcanePackage({outputRoot,prepareBase}){
    await prepareBase(outputRoot);
}

export async function verifyArcanePackage({outputRoot}){
    await writeFile(
        path.join(outputRoot,'verifier-mutation.txt'),
        'a verifier must not change output\\n',
        'utf8'
    );
}
`,
            'utf8'
        );
        await updateAppConfig(workspaceRoot,'alpha',{
            strategy:'adapter',
            adapter:'scripts/mutating-verifier.mjs'
        });

        await assert.rejects(
            packageApp({
                workspaceRoot,
                appId:'alpha',
                bump:'patch'
            }),
            /package tree|inventory|mutation|match/i
        );

        assert.equal(
            (await readJson(path.join(
                appRoot,
                'arcane-package.json'
            ))).version,
            '1.2.3'
        );
        assert.equal(
            await readFile(releaseManifestPath(workspaceRoot,'alpha'),'utf8'),
            previousManifest
        );
        assert.equal(
            await readFile(
                path.join(releaseAppRoot(workspaceRoot,'alpha'),'index.html'),
                'utf8'
            ),
            previousIndex
        );
        assert.equal(
            await exists(path.join(
                releaseRoot(workspaceRoot,'alpha'),
                'verifier-mutation.txt'
            )),
            false
        );
        assert.deepEqual(
            await readdir(path.join(workspaceRoot,'dist')),
            ['alpha']
        );
    });
});

describe('Arcane packager CLI output channels',()=>{
    it('keeps adapter progress on stderr so --json stdout remains parseable',async()=>{
        const workspaceRoot=await createWorkspace();
        await createApp(workspaceRoot,'alpha',{
            config:{
                strategy:'adapter',
                adapter:'scripts/noisy-adapter.mjs'
            },
            files:{
                'index.html':'<!doctype html><title>Alpha</title>\n',
                'scripts/noisy-adapter.mjs':`
export async function buildArcanePackage({outputRoot,prepareBase}){
    console.log('adapter build progress');
    await prepareBase(outputRoot);
}

export async function verifyArcanePackage(){
    console.log('adapter verify progress');
}
`
            }
        });

        const {stdout,stderr}=await execFile(
            process.execPath,
            [
                cliPath,
                'package',
                'alpha',
                '--workspace',
                workspaceRoot,
                '--json'
            ],
            {
                cwd:workspaceRoot,
                maxBuffer:1024*1024
            }
        );
        const result=JSON.parse(stdout);

        assert.equal(result.app,'alpha');
        assert.equal(result.version,'1.2.3');
        assert.equal(result.dryRun,false);
        assert.match(stderr,/adapter build progress/);
        assert.match(stderr,/adapter verify progress/);
        assert.equal(stdout.includes('adapter progress'),false);
    });

    it('rejects version-changing --all packaging before mutating any app',async()=>{
        const workspaceRoot=await createWorkspace();
        await createApp(workspaceRoot,'alpha',{
            config:{version:'1.2.3'}
        });
        await createApp(workspaceRoot,'beta',{
            config:{version:'4.5.6'}
        });
        const alphaConfig=path.join(
            workspaceRoot,
            'apps','alpha','arcane-package.json'
        );
        const betaConfig=path.join(
            workspaceRoot,
            'apps','beta','arcane-package.json'
        );
        const before={
            alpha:await readFile(alphaConfig,'utf8'),
            beta:await readFile(betaConfig,'utf8')
        };
        let failure;

        try{
            await execFile(
                process.execPath,
                [
                    cliPath,
                    'package',
                    '--all',
                    '--bump',
                    'patch',
                    '--workspace',
                    workspaceRoot
                ],
                {
                    cwd:workspaceRoot,
                    maxBuffer:1024*1024
                }
            );
            assert.fail('Version-changing --all packaging unexpectedly succeeded.');
        }catch(error){
            failure=error;
        }

        assert.notEqual(failure?.code,0);
        assert.match(
            failure?.stderr??'',
            /version-changing --all releases are not atomic/i
        );
        assert.equal(await readFile(alphaConfig,'utf8'),before.alpha);
        assert.equal(await readFile(betaConfig,'utf8'),before.beta);
        assert.equal(await exists(path.join(workspaceRoot,'dist')),false);
    });
});

describe('Arcane package path boundaries',()=>{
    it('rejects a linked dist boundary without touching its outside target',async test=>{
        const workspaceRoot=await createWorkspace();
        await createApp(workspaceRoot,'alpha');
        const outsideRoot=await mkdtemp(
            path.join(tmpdir(),'arcane-app-packager-outside-')
        );
        temporaryRoots.add(outsideRoot);
        const sentinelPath=path.join(outsideRoot,'sentinel.txt');
        const distLink=path.join(workspaceRoot,'dist');
        await writeFile(sentinelPath,'outside must remain untouched\n','utf8');

        try{
            await symlink(
                outsideRoot,
                distLink,
                process.platform==='win32'?'junction':'dir'
            );
        }catch(error){
            if(error?.code==='EPERM'||error?.code==='EACCES'){
                test.skip(`Link creation is not permitted: ${error.code}`);
                return;
            }

            throw error;
        }

        try{
            await assert.rejects(
                packageApp({
                    workspaceRoot,
                    appId:'alpha',
                    bump:'patch'
                }),
                /dist.*(?:real|link|junction)|link.*dist|junction.*dist/i
            );
            assert.equal(
                await readFile(sentinelPath,'utf8'),
                'outside must remain untouched\n'
            );
            assert.deepEqual(await readdir(outsideRoot),['sentinel.txt']);
            assert.equal(
                (await readJson(path.join(
                    workspaceRoot,
                    'apps','alpha','arcane-package.json'
                ))).version,
                '1.2.3'
            );
        }finally{
            try{
                await unlink(distLink);
            }catch(error){
                if(process.platform==='win32'
                    &&(error?.code==='EPERM'||error?.code==='EISDIR')){
                    await rmdir(distLink);
                }else if(error?.code!=='ENOENT'){
                    throw error;
                }
            }
        }

        assert.equal(
            await readFile(sentinelPath,'utf8'),
            'outside must remain untouched\n'
        );
    });

    it('rejects unsafe app entry, include, exclude, and adapter paths',async()=>{
        const cases=[
            {
                name:'entry traversal',
                update:{entry:'../outside.html'}
            },
            {
                name:'include traversal',
                update:{include:['../private']}
            },
            {
                name:'exclude traversal',
                update:{exclude:['..\\private']}
            },
            {
                name:'absolute include',
                update:{include:[path.resolve('outside.txt')]}
            },
            {
                name:'glob include',
                update:{include:['**/*']}
            },
            {
                name:'adapter traversal',
                update:{
                    strategy:'adapter',
                    adapter:'../outside-adapter.mjs'
                }
            }
        ];

        for(const testCase of cases){
            const workspaceRoot=await createWorkspace();
            await createApp(workspaceRoot,'alpha',{
                config:testCase.update
            });

            await assert.rejects(
                packageApp({
                    workspaceRoot,
                    appId:'alpha',
                    dryRun:true
                }),
                /adapter|entry|glob|include|exclude|path|relative|safe|wildcard/i,
                testCase.name
            );
        }
    });

    it('rejects unsafe shared route sources and destinations',async()=>{
        const routes=[
            {
                source:'../outside',
                destination:'arcane',
                include:['modules'],
                exclude:[]
            },
            {
                source:'arcane',
                destination:'../outside',
                include:['modules'],
                exclude:[]
            },
            {
                source:'arcane',
                destination:'arcane',
                include:['../private'],
                exclude:[]
            },
            {
                source:'arcane',
                destination:'arcane',
                include:['modules'],
                exclude:['..\\private']
            }
        ];

        for(const route of routes){
            const workspaceRoot=await createWorkspace({
                sharedPayloads:{unsafe:[route]}
            });
            await createApp(workspaceRoot,'alpha',{
                config:{shared:['unsafe']}
            });

            await assert.rejects(
                packageApp({
                    workspaceRoot,
                    appId:'alpha',
                    dryRun:true
                }),
                /destination|source|include|exclude|path|relative|safe/i
            );
            assert.equal(await exists(releaseRoot(workspaceRoot,'alpha')),false);
        }
    });
});
