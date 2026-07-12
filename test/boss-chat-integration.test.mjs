import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {describe,it} from 'node:test';

const chat=await readFile(
    new URL('../apps/boss/chat.html',import.meta.url),
    'utf8'
);
const prompt=await readFile(
    new URL('../apps/boss/prompts/system.md',import.meta.url),
    'utf8'
);
const bossCss=await readFile(
    new URL('../apps/boss/boss.css',import.meta.url),
    'utf8'
);
const htmlImport=await readFile(
    new URL('../arcane/modules/HTMLImport.js',import.meta.url),
    'utf8'
);
const manifest=JSON.parse(
    await readFile(
        new URL('../apps/boss/manifest.json',import.meta.url),
        'utf8'
    )
);
const manifestIcon=manifest.icons[0];
const manifestIconBytes=await readFile(
    new URL(
        `../apps/boss/${manifestIcon.src.replace(/^\.\//,'')}`,
        import.meta.url
    )
);

describe('BOSS Libraries chat integration',()=>{
    it('loads the canonical prompt and normalized document runtime',()=>{
        assert.match(chat,/\.\/apps\/boss\/prompts\/system\.md/);
        assert.match(chat,/createBossLibraryContext/);
        assert.match(chat,/loadBossLibraryManifest/);
        assert.match(chat,/seedBossLibraryDocuments/);
    });

    it('uses focused librarian tools instead of dumping every document',()=>{
        assert.match(chat,/name:'search_boss_library'/);
        assert.match(chat,/name:'prepare_boss_handoff'/);
        assert.doesNotMatch(chat,/check_for_related_resources/);
        assert.doesNotMatch(chat,/getAll\(['"]documents['"]\)/);
        assert.doesNotMatch(chat,/# Documents\s*:/);
    });

    it('defines the master brand as a librarian rather than a mentor',()=>{
        assert.match(prompt,/BOSS Libraries AI Librarian/);
        assert.match(prompt,/You are not a mentor/);
        assert.match(prompt,/What are you trying to find or get done\?/);
        assert.doesNotMatch(chat,/PROFILE-FIRST RULE/);
        assert.doesNotMatch(chat,/SCORE HANDOFF SUMMARY/);
    });

    it('retrieves a bounded context for each request and keeps restricted records opt-in',()=>{
        assert.match(chat,/topK:options\.topK\|\|4/);
        assert.match(chat,/totalCharacterLimit:15000/);
        assert.match(chat,/includeRestricted:options\.includeRestricted===true/);
        assert.match(chat,/includeRestricted:params\.include_restricted===true/);
    });

    it('keeps the phone chat usable and supplies a square install icon',()=>{
        assert.match(
            bossCss,
            /@media \(max-width:36em\)[\s\S]*?\.file-manager\s*\{[\s\S]*?display:none/
        );
        assert.match(
            bossCss,
            /main\.contents\s*\{[\s\S]*?grid-template-rows:minmax\(0,1fr\) auto/
        );

        const [width,height]=manifestIcon.sizes.split('x').map(Number);

        assert.equal(width,height);
        assert.ok(manifestIconBytes.length>1000);
    });

    it('executes imported component scripts with their host on repeat loads',()=>{
        assert.match(htmlImport,/document\.createElement\('script'\)/);
        assert.match(htmlImport,/document\.head\.appendChild\(executable\)/);
        assert.match(htmlImport,/arcaneHostToken/);
        assert.match(htmlImport,/htmlImportHostRegistry\.set\(hostToken,this\)/);
        assert.doesNotMatch(htmlImport,/\beval\s*\(|new AsyncFunction/);
    });
});
