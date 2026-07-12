import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {describe,it} from 'node:test';

const PAGE_URL=new URL('../apps/boss/library.html',import.meta.url);
const page=await readFile(PAGE_URL,'utf8');

describe('BOSS Libraries document page',()=>{
    it('uses the shared Arcane shell and BOSS Libraries navigation',()=>{
        assert.match(page,/<base href="\.\.\/\.\.\/">/);
        assert.match(page,/href="\.\/arcane\/components\/header\.html\?v=3"/);
        assert.match(page,/href="\.\/apps\/boss\/components\/nav\.html\?v=2"/);
        assert.match(page,/BOSS Libraries \| Document Library/);
    });

    it('loads the normalized document manifest through the BOSS runtime',()=>{
        assert.match(page,/loadBossLibraryManifest/);
        assert.match(page,/\.\/apps\/boss\/documents\/document-manifest\.json/);
        assert.match(page,/PAGE_SIZE=24/);
    });

    it('provides search, organization, category, access, and restricted controls',()=>{
        for(const id of [
            'searchInput',
            'organizationFilter',
            'categoryFilter',
            'accessFilter',
            'includeRestricted'
        ]){
            assert.match(page,new RegExp(`id="${id}"`));
        }

        assert.match(page,/id="restrictedOption" value="restricted" disabled/);
    });

    it('keeps Markdown preview content in text-only DOM sinks',()=>{
        assert.match(page,/markdownPreview\.textContent=/);
        assert.doesNotMatch(page,/\.innerHTML\s*=/);
        assert.match(page,/Formatting is intentionally not rendered/);
    });
});
