import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {describe,it} from 'node:test';

const PAGE_URL=new URL('../apps/boss/library.html',import.meta.url);
const page=await readFile(PAGE_URL,'utf8');

describe('BOSS Libraries document page',()=>{
    it('uses the shared Arcane shell and BOSS Libraries navigation',()=>{
        assert.match(page,/<base href="\.\.\/\.\.\/">/);
        assert.match(page,/href="\.\/arcane\/components\/header\.html\?v=3"/);
        assert.match(page,/href="\.\/apps\/boss\/components\/nav\.html\?v=10"/);
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

    it('offers a simple editable handoff to the BOSS Librarian',()=>{
        assert.match(page,/id="askLibrarian"[\s\S]*?>Ask the BOSS Librarian</);
        assert.match(page,/Not sure what terms to use\?/);
        assert.match(page,/id="askLibrarianEmpty"[\s\S]*?>Ask the BOSS Librarian about this search</);
        assert.match(page,/new URL\('\.\/apps\/boss\/chat\.html',document\.baseURI\)/);
        assert.match(page,/\.trim\(\)\.slice\(0,500\)/);
        assert.match(page,/chatUrl\.searchParams\.set\('q',query\)/);
        assert.doesNotMatch(page,/searchParams\.set\(['"]includeRestricted/);
        assert.match(
            page,
            /class="empty-state-message" role="status" aria-live="polite">[\s\S]*?<\/div>\s*<a id="askLibrarianEmpty"/
        );
    });

    it('shows locally available original documents without unsafe HTML rendering',()=>{
        assert.match(page,/function localOriginalUrl\(record\)/);
        assert.match(page,/record\.originalUrl/);
        assert.match(page,/text:kind==='download'\?'Get original':'View original'/);
        assert.match(page,/async function openOriginal\(record,trigger,originalUrl\)/);
        assert.match(page,/kind==='pdf'/);
        assert.match(page,/kind==='image'/);
        assert.match(page,/kind==='video'/);
        assert.match(page,/kind==='download'/);
        assert.match(page,/textPreview\.textContent=/);
    });

    it('keeps Markdown preview content in text-only DOM sinks',()=>{
        assert.match(page,/markdownPreview\.textContent=/);
        assert.doesNotMatch(page,/\.innerHTML\s*=/);
        assert.match(page,/Formatting is intentionally not rendered/);
    });
});
