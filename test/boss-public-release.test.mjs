import assert from 'node:assert/strict';
import {readdir,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {before,describe,it} from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';

import {normalizeBossLibraryManifest} from '../apps/boss/boss-library.js';

const workspaceRoot=fileURLToPath(new URL('../',import.meta.url));
const releaseRoot=path.join(workspaceRoot,'dist','boss');
const releaseBossRoot=path.join(releaseRoot,'apps','boss');
const releaseDocumentsRoot=path.join(releaseBossRoot,'documents');
const releaseOriginalsRoot=path.join(releaseBossRoot,'originals');
const releaseManifestPath=path.join(
    releaseDocumentsRoot,
    'document-manifest.json'
);
const privateManifestPath=path.join(
    workspaceRoot,
    'apps','boss','documents','document-manifest.json'
);

function normalizedRelative(root,file){
    return path.relative(root,file).split(path.sep).join('/');
}

function resolveContained(root,relativePath,label){
    assert.equal(typeof relativePath,'string',`${label} must be a string`);
    assert.ok(relativePath,`${label} must not be empty`);
    assert.equal(relativePath.includes('\\'),false,`${label} must use URL separators`);
    assert.equal(path.posix.isAbsolute(relativePath),false,`${label} must be relative`);
    assert.equal(
        relativePath.split('/').some(segment=>!segment||segment==='.'||segment==='..'),
        false,
        `${label} must not contain empty or traversal segments`
    );

    const absolute=path.resolve(root,...relativePath.split('/'));
    const rootWithSeparator=`${path.resolve(root)}${path.sep}`;
    assert.ok(
        absolute.startsWith(rootWithSeparator),
        `${label} must remain within its release root`
    );
    return absolute;
}

async function listFiles(root){
    const files=[];

    async function walk(directory){
        for(const entry of await readdir(directory,{withFileTypes:true})){
            const entryPath=path.join(directory,entry.name);

            if(entry.isSymbolicLink()){
                assert.fail(`Public releases may not contain symlinks: ${entryPath}`);
            }

            if(entry.isDirectory()){
                await walk(entryPath);
            }else if(entry.isFile()){
                files.push(entryPath);
            }else{
                assert.fail(`Unexpected public-release filesystem entry: ${entryPath}`);
            }
        }
    }

    await walk(root);
    return files.sort((left,right)=>left.localeCompare(right));
}

let publicManifest;
let privateManifest;
let publicRecords;
let privateRecords;
let normalizedManifest;

describe('BOSS public website release',()=>{
    before(async()=>{
        try{
            publicManifest=JSON.parse(
                await readFile(releaseManifestPath,'utf8')
            );
        }catch(error){
            assert.fail(
                `Build the required public artifact before release testing: ${releaseManifestPath}\n${error.message}`
            );
        }

        try{
            privateManifest=JSON.parse(
                await readFile(privateManifestPath,'utf8')
            );
        }catch(error){
            assert.fail(
                `The canonical manifest is required to prove the public projection: ${privateManifestPath}\n${error.message}`
            );
        }

        publicRecords=publicManifest.records||[];
        privateRecords=privateManifest.records||[];
        normalizedManifest=normalizeBossLibraryManifest(publicManifest,{
            manifestUrl:pathToFileURL(releaseManifestPath).href
        });
    });

    it('is an exact 500-record projection of explicit public, non-sensitive records',()=>{
        const approvedRecords=privateRecords.filter(
            record=>record.access==='public'&&record.sensitive!==true
        );
        const nonPublicRecords=privateRecords.filter(
            record=>record.access!=='public'||record.sensitive===true
        );
        const approvedIds=new Set(approvedRecords.map(record=>record.id));
        const releasedIds=new Set(publicRecords.map(record=>record.id));

        assert.equal(publicManifest.audience,'public');
        assert.equal(publicManifest.original_root,'../originals/');
        assert.equal(publicManifest.record_count,500);
        assert.equal(publicRecords.length,500);
        assert.equal(approvedRecords.length,500);
        assert.equal(nonPublicRecords.length,118);
        assert.equal(releasedIds.size,publicRecords.length);
        assert.deepEqual(
            [...releasedIds].sort(),
            [...approvedIds].sort(),
            'The release must contain every and only approved public record ID.'
        );

        for(const record of publicRecords){
            assert.equal(record.access,'public',`${record.id} is not explicitly public`);
            assert.equal(record.sensitive,false,`${record.id} is not explicitly non-sensitive`);
            assert.ok(record.source_path,`${record.id} has no public-original path`);
            assert.ok(record.output,`${record.id} has no generated Markdown output`);
        }

        for(const record of nonPublicRecords){
            assert.equal(
                releasedIds.has(record.id),
                false,
                `Non-public record leaked into the release: ${record.id}`
            );
        }
    });

    it('publishes the first-run library setup route and terminal component',async()=>{
        const setupPage=path.join(releaseBossRoot,'library-setup.html');
        const terminalComponent=path.join(
            releaseBossRoot,
            'components',
            'import-terminal.html'
        );
        const [setupInfo,terminalInfo]=await Promise.all([
            stat(setupPage),
            stat(terminalComponent)
        ]);

        assert.ok(setupInfo.isFile(),'library setup route is missing from the public release');
        assert.ok(
            terminalInfo.isFile(),
            'import terminal component is missing from the public release'
        );
    });

    it('contains exactly the declared public Markdown records and public originals',async()=>{
        const declaredOutputs=new Set(publicRecords.map(record=>record.output));
        const declaredOriginals=new Set(publicRecords.map(record=>record.source_path));
        const markdownFiles=(await listFiles(releaseDocumentsRoot))
            .map(file=>normalizedRelative(releaseDocumentsRoot,file))
            .filter(relative=>/^bossdoc-[a-f0-9]{12}--.+\.md$/i.test(relative));
        const originalFiles=(await listFiles(releaseOriginalsRoot))
            .map(file=>normalizedRelative(releaseOriginalsRoot,file));

        assert.equal(declaredOutputs.size,500);
        assert.equal(declaredOriginals.size,500);
        assert.deepEqual(markdownFiles.sort(),[...declaredOutputs].sort());
        assert.deepEqual(originalFiles.sort(),[...declaredOriginals].sort());

        for(const record of publicRecords){
            const markdownPath=resolveContained(
                releaseDocumentsRoot,
                record.output,
                `${record.id} output`
            );
            const originalPath=resolveContained(
                releaseOriginalsRoot,
                record.source_path,
                `${record.id} source_path`
            );
            const [markdownInfo,originalInfo]=await Promise.all([
                stat(markdownPath),
                stat(originalPath)
            ]);

            assert.ok(markdownInfo.isFile(),`${record.id} Markdown is not a file`);
            assert.ok(originalInfo.isFile(),`${record.id} original is not a file`);
            if(Number(record.source_bytes)>0){
                assert.equal(
                    originalInfo.size,
                    Number(record.source_bytes),
                    `${record.id} public original has the wrong byte size`
                );
            }
        }
    });

    it('resolves originals only through the isolated public originals root',async()=>{
        assert.equal(normalizedManifest.audience,'public');
        assert.equal(normalizedManifest.documents.length,500);

        for(const record of normalizedManifest.documents){
            assert.equal(record.access,'public');
            assert.equal(record.sensitive,false);
            assert.ok(record.originalUrl,`${record.id} has no original URL`);
            assert.equal(
                fileURLToPath(record.originalUrl),
                resolveContained(
                    releaseOriginalsRoot,
                    record.sourcePath,
                    `${record.id} normalized source path`
                )
            );
        }

        const releaseFiles=(await listFiles(releaseRoot))
            .map(file=>normalizedRelative(releaseRoot,file));
        assert.equal(
            releaseFiles.some(relative=>/(^|\/)business docs(\/|$)/i.test(relative)),
            false,
            'The canonical business-docs tree must never be in the website artifact.'
        );

        const releasedFiles=new Set(releaseFiles);
        for(const record of privateRecords.filter(
            item=>item.access!=='public'||item.sensitive===true
        )){
            assert.equal(
                releasedFiles.has(`apps/boss/originals/${record.source_path}`),
                false,
                `Non-public original leaked into the release: ${record.id}`
            );
            assert.equal(
                releasedFiles.has(`apps/boss/documents/${record.output}`),
                false,
                `Non-public Markdown leaked into the release: ${record.id}`
            );
        }
    });

    it('keeps every public file below the GitHub hosting threshold',async()=>{
        const releaseFiles=await listFiles(releaseRoot);
        let largest=null;

        for(const file of releaseFiles){
            const details=await stat(file);

            if(!largest||details.size>largest.bytes){
                largest={
                    bytes:details.size,
                    path:normalizedRelative(releaseRoot,file)
                };
            }
        }

        assert.ok(largest,'The public release must contain files.');
        assert.ok(
            largest.bytes<=95_000_000,
            `${largest.path} is ${largest.bytes} bytes; public files must stay at or below 95,000,000 bytes.`
        );
    });
});
