import assert from 'node:assert/strict';
import {access,readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {describe,it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {
    normalizeBossLibraryManifest,
    rankBossLibraryDocuments
} from '../apps/boss/boss-library.js';

const documentsDirectory=fileURLToPath(
    new URL('../apps/boss/documents/',import.meta.url)
);
const manifestPath=path.join(documentsDirectory,'document-manifest.json');
const sourceDirectory=fileURLToPath(
    new URL('../apps/boss/business docs/',import.meta.url)
);
const linkPolicy=JSON.parse(await readFile(
    fileURLToPath(new URL('../apps/boss/link-policy.json',import.meta.url)),
    'utf8'
));
let rawManifest=null;
try{
    rawManifest=JSON.parse(await readFile(manifestPath,'utf8'));
}catch(error){
    if(error?.code!=='ENOENT'){
        throw error;
    }
}
const records=rawManifest?.records||[];

describe('BOSS Libraries link policy',()=>{
    it('keeps replacements and removals explicit and non-overlapping',()=>{
        const replacements=Object.entries(linkPolicy.replace);
        const removals=new Set(linkPolicy.remove);

        assert.equal(replacements.length,41);
        assert.equal(linkPolicy.remove.length,3);
        assert.deepEqual(linkPolicy.remove_prefixes,[
            'http://images.google.com/imgres?',
            'https://start4.pwc.com/'
        ]);
        assert.ok(replacements.every(([source,target])=>source!==target));
        assert.ok(replacements.every(([,target])=>target.startsWith('https://')));
        assert.ok(replacements.every(([source])=>!removals.has(source)));
    });
});

describe(
    'generated BOSS Libraries corpus',
    {
        skip:rawManifest
            ? false
            : 'The private BOSS corpus is intentionally unpublished in this checkout.'
    },
    ()=>{
    it('represents all 500 source identities with collision-safe Markdown outputs',async()=>{
        assert.equal(rawManifest.record_count,500);
        assert.equal(records.length,500);
        assert.match(rawManifest.manifest_version,/^sha256:[a-f0-9]{64}$/);

        const ids=new Set(records.map(record=>record.id));
        const outputs=new Set(records.map(record=>record.output));
        assert.equal(ids.size,500);
        assert.equal(outputs.size,500);

        for(const record of records){
            assert.match(record.id,/^bossdoc-[a-f0-9]{12}$/);
            assert.match(record.output,/^bossdoc-[a-f0-9]{12}--.+\.md$/);
            assert.equal(record.document_path,`./${record.output}`);
            assert.ok(record.title);
            assert.ok(record.summary);
            assert.ok(record.extraction?.status);
            await access(path.join(documentsDirectory,record.output));
            await access(path.join(sourceDirectory,...record.source_path.split('/')));
        }

        const generated=await readdir(documentsDirectory);
        assert.equal(generated.filter(name=>name.startsWith('bossdoc-')&&name.endsWith('.md')).length,500);
        assert.equal(generated.filter(name=>/\.(?:pdf|docx|pptx|xlsx|png|jpg|mp4)$/i.test(name)).length,0);
    });

    it('preserves content-derived titles and human visual descriptions',()=>{
        const shuffled=records.find(
            record=>record.source_path.endsWith('/SCORE/000_MANIFEST_SCORE_BOSS_resource_pack.md')
        );
        assert.equal(shuffled?.title,'SCORE Contact and Support');

        const images=records.filter(record=>['.jpg','.png'].includes(record.source_extension));
        assert.equal(images.length,6);
        assert.ok(images.every(record=>record.extraction.title_source==='human_visual_description'));
        assert.ok(images.every(record=>record.summary.length>60));

    });

    it('applies the reviewed link repairs to generated records',()=>{
        const links=records.flatMap(record=>record.links||[]);

        for(const stale of Object.keys(linkPolicy.replace)){
            assert.ok(!links.includes(stale),`Stale replaced URL remains: ${stale}`);
        }
        for(const removed of linkPolicy.remove){
            assert.ok(!links.includes(removed),`Removed URL remains: ${removed}`);
        }
        for(const prefix of linkPolicy.remove_prefixes){
            assert.ok(!links.some(link=>link.startsWith(prefix)),`Removed URL prefix remains: ${prefix}`);
        }
        assert.ok(links.includes('https://bchispanicchamber.com/'));
        assert.ok(links.includes('https://supportcenter.score.org/kb/article/163-volunteer-onboarding-steps-and-checklist/'));
        assert.ok(links.includes('https://www.sba.gov/federal-contracting'));
    });

    it('normalizes the live manifest and retrieves a relevant official routing record',()=>{
        const normalized=normalizeBossLibraryManifest(rawManifest,{
            manifestUrl:new URL('../apps/boss/documents/document-manifest.json',import.meta.url).href
        });
        assert.equal(normalized.documents.length,500);
        assert.ok(normalized.documents.every(record=>record.originalUrl));
        assert.ok(normalized.documents.every(record=>record.sourceExtension));
        assert.ok(normalized.documents.every(record=>record.sourceBytes>0));

        const matches=rankBossLibraryDocuments(
            normalized.documents,
            'SCORE contact support',
            {topK:3}
        );

        assert.ok(matches.length>0);
        assert.equal(matches[0].title,'SCORE Contact and Support');
        assert.match(matches[0].documentUrl,/bossdoc-.+\.md$/);
        assert.match(matches[0].sourceUrl,/^https:\/\//);
        assert.match(matches[0].originalUrl,/\/apps\/boss\/business%20docs\//);
        assert.ok(matches[0].sourceExtension);
        assert.ok(matches[0].sourceBytes>0);
        assert.equal(
            fileURLToPath(matches[0].originalUrl),
            path.join(sourceDirectory,...matches[0].sourcePath.split('/'))
        );
    });
    }
);
