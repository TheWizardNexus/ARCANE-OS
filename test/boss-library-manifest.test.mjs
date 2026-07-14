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
let rawManifest=null;
try{
    rawManifest=JSON.parse(await readFile(manifestPath,'utf8'));
}catch(error){
    if(error?.code!=='ENOENT'){
        throw error;
    }
}
const records=rawManifest?.records||[];

describe(
    'generated BOSS Libraries corpus',
    {
        skip:rawManifest
            ? false
            : 'The private BOSS corpus is intentionally unpublished in this checkout.'
    },
    ()=>{
    it('represents all 618 source identities with collision-safe Markdown outputs',async()=>{
        assert.equal(rawManifest.record_count,618);
        assert.equal(records.length,618);
        assert.match(rawManifest.manifest_version,/^sha256:[a-f0-9]{64}$/);

        const ids=new Set(records.map(record=>record.id));
        const outputs=new Set(records.map(record=>record.output));
        assert.equal(ids.size,618);
        assert.equal(outputs.size,618);

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
        assert.equal(generated.filter(name=>name.startsWith('bossdoc-')&&name.endsWith('.md')).length,618);
        assert.equal(generated.filter(name=>/\.(?:pdf|docx|pptx|xlsx|png|jpg|mp4)$/i.test(name)).length,0);
    });

    it('preserves content-derived titles, human visual descriptions, and restricted safeguards',()=>{
        const shuffled=records.find(
            record=>record.source_path.endsWith('/SCORE/000_MANIFEST_SCORE_BOSS_resource_pack.md')
        );
        assert.equal(shuffled?.title,'SCORE Contact and Support');

        const images=records.filter(record=>['.jpg','.png'].includes(record.source_extension));
        assert.equal(images.length,15);
        assert.ok(images.every(record=>record.extraction.title_source==='human_visual_description'));
        assert.ok(images.every(record=>record.summary.length>60));

        const restricted=records.filter(record=>record.access==='restricted');
        assert.equal(restricted.length,60);
        assert.ok(restricted.every(record=>record.sensitive===true));
        assert.ok(restricted.every(record=>!/[0-9]{2}-[0-9]{7}/.test(record.summary)));
        assert.ok(restricted.every(record=>!record.contacts.length));
    });

    it('normalizes the live manifest and retrieves a relevant official routing record',()=>{
        const normalized=normalizeBossLibraryManifest(rawManifest,{
            manifestUrl:new URL('../apps/boss/documents/document-manifest.json',import.meta.url).href
        });
        assert.equal(normalized.documents.length,618);
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
