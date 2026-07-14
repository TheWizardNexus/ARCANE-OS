import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {describe,it} from 'node:test';

const setupUrl=new URL('../apps/boss/library-setup.html',import.meta.url);
const terminalUrl=new URL(
    '../apps/boss/components/import-terminal.html',
    import.meta.url
);

describe('BOSS Libraries first-run setup',()=>{
    it('provides a dedicated, observable document import route',async()=>{
        const page=await readFile(setupUrl,'utf8');

        assert.match(page,/<base href="\.\.\/\.\.\/">/);
        assert.match(page,/BOSS Libraries \| (?:Library )?(?:Setup|Import)/i);
        assert.match(page,/\.\/arcane\/modules\/DBOPFS\.js/);
        assert.match(page,/seedBossLibraryDocuments/);
        assert.match(page,/onProgress/);
        assert.match(page,/components\/import-terminal\.html/);
        assert.match(page,/\.setup-main\s*\{[^}]*grid-column:1\s*\/\s*-1/s);
        assert.match(page,/new URL\(window\.location\.href\)\.searchParams/);
        assert.match(page,/urlParameters\.get\('start'\)/);
        assert.match(page,/\.\/apps\/boss\/chat\.html/);
        assert.match(page,/location\.replace\(/);
        assert.match(page,/beforeunload/);
        assert.match(page,/blockNavigationWhileRunning/);
        assert.match(page,/\.inert=running/);
        assert.match(page,/try\s*\{[\s\S]*?seedBossLibraryDocuments[\s\S]*?if\s*\([^)]*\.ok[^)]*\)[\s\S]*?location\.replace\(/);
        assert.doesNotMatch(page,/\.innerHTML\s*=/);
    });

    it('renders import activity in an accessible reusable terminal component',async()=>{
        const source=await readFile(terminalUrl,'utf8');
        const script=source.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];

        assert.ok(script,'import terminal module script is missing');
        assert.doesNotThrow(
            ()=>new (Object.getPrototypeOf(async function(){}).constructor)(script)
        );
        assert.match(source,/role="log"/);
        assert.match(source,/aria-live="polite"/);
        assert.match(source,/line\.setAttribute\('aria-hidden','true'\)/);
        assert.match(source,/id="announcement"[^>]*role="status"/);
        assert.match(source,/overflow(?:-y)?:auto/);
        assert.match(source,/white-space:pre-wrap/);
        assert.match(source,/textContent|createTextNode/);
        assert.doesNotMatch(source,/\.innerHTML\s*=/);
    });
});
