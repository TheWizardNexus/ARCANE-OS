import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import test from 'node:test';
import Preference,{preferenceSchema} from '../arcane/entities/Preference.js';
import Theme,{
    arcaneDarkThemeTokens,
    arcaneLightThemeTokens,
    themeColorToHex,
    themeTokens
} from '../arcane/entities/Theme.js';

const read=relative=>readFile(new URL(`../${relative}`,import.meta.url),'utf8');

test('shared preference entity validates and normalizes reusable schemas',()=>{
    const schema=preferenceSchema([
        {key:'appearance.theme',type:'select',defaultValue:'system',options:['system','dark']},
        {key:'accessibility.zoom',type:'number',defaultValue:100,minimum:80,maximum:200}
    ]);
    assert(schema[0] instanceof Preference);
    assert.equal(schema[0].value('missing'),'system');
    assert.equal(schema[1].value(500),200);
    assert.throws(()=>preferenceSchema([{key:'same'},{key:'same'}]),/unique/);
});

test('shared themes expose safe named tokens instead of arbitrary CSS',()=>{
    const theme=new Theme({name:'Night reading',scheme:'dark',tokens:{background:'#10131a',text:'#f4f5f8'}});
    assert.equal(theme.scheme,'dark');
    assert.equal(theme.tokens.background,'rgb(16, 19, 26)');
    assert.equal(Object.keys(theme.tokens).length,themeTokens.length);
    const translucent=new Theme({name:'Translucent',tokens:{surface:'rgba(255, 255, 255, .85)'}});
    assert.equal(translucent.tokens.surface,'rgba(255, 255, 255, 0.85)');
    assert.equal(themeColorToHex('rgb(16, 19, 26)'),'#10131a');
    assert.throws(()=>new Theme({name:'Invalid',tokens:{text:'rgb(300, 0, 0)'}}),/outside the supported/);
    assert.throws(()=>new Theme({name:'Unsafe',tokens:{background:'url(https://example.com)'}}),/RGB or RGBA/);
    assert(!JSON.stringify(theme).includes('url('));
});

test('Arcane Light and Dark provide complete safe defaults',()=>{
    const light=new Theme({name:'Arcane Light',scheme:'light'});
    const dark=new Theme({name:'Arcane Dark',scheme:'dark'});
    assert.deepEqual(light.tokens,arcaneLightThemeTokens);
    assert.deepEqual(dark.tokens,arcaneDarkThemeTokens);
    assert.notEqual(light.tokens.background,dark.tokens.background);
    assert.notEqual(light.tokens.text,dark.tokens.text);
});

test('shared theme stylesheet exposes explicit and system light/dark palettes',async()=>{
    const css=await read('arcane/css/theme.css');
    assert.match(css,/:root\[data-color-scheme="light"\]/);
    assert.match(css,/:root\[data-color-scheme="dark"\]/);
    assert.match(css,/@media \(prefers-color-scheme:dark\)/);
    assert.match(css,/:root:not\(\[data-color-scheme\]\)/);
    assert.doesNotMatch(css,/#[0-9a-f]{3,8}\b/i);
    for(const value of Object.values(arcaneLightThemeTokens)) assert.ok(css.includes(value),`light token ${value}`);
    for(const value of Object.values(arcaneDarkThemeTokens)) assert.ok(css.includes(value),`dark token ${value}`);
});

test('every packaged app page loads and applies the shared theme before app CSS',async()=>{
    const appEntries=await readdir(new URL('../apps/',import.meta.url),{withFileTypes:true});
    for(const entry of appEntries.filter(item=>item.isDirectory())){
        const configPath=`apps/${entry.name}/arcane-package.json`;
        let config;
        try{ config=JSON.parse(await read(configPath)); }catch{ continue; }
        const pages=config.include.filter(value=>value.endsWith('.html'));
        assert.ok(pages.length>0,`${entry.name} has no packaged HTML page`);
        for(const page of pages){
            const html=await read(`apps/${entry.name}/${page}`);
            const links=[...html.matchAll(/<link\b[^>]*>/gi)]
                .map(match=>match[0])
                .filter(tag=>/\brel=["']stylesheet["']/i.test(tag))
                .map(tag=>tag.match(/\bhref=["']([^"']+)["']/i)?.[1])
                .filter(Boolean);
            const themeIndex=links.findIndex(href=>href.includes('arcane/css/theme.css'));
            const layoutIndex=links.findIndex(href=>href.includes('arcane/css/layout.css'));
            const primitivesIndex=links.findIndex(href=>href.includes('arcane/css/primitives.css'));
            const appStyleIndexes=links
                .map((href,index)=>({href,index}))
                .filter(item=>item.href.startsWith(`./apps/${entry.name}/`)&&/\.css(?:\?|$)/.test(item.href))
                .map(item=>item.index);
            assert.notEqual(themeIndex,-1,`${entry.name}/${page} is missing theme.css`);
            assert.equal((html.match(/arcane\/css\/theme\.css\?v=1/g)||[]).length,1,`${entry.name}/${page} theme.css count`);
            assert.equal((html.match(/arcane\/modules\/ThemeBootstrap\.js\?v=1/g)||[]).length,1,`${entry.name}/${page} bootstrap count`);
            if(layoutIndex!==-1) assert.ok(layoutIndex<themeIndex,`${entry.name}/${page} must load theme.css after legacy layout.css`);
            if(primitivesIndex!==-1) assert.ok(themeIndex<primitivesIndex,`${entry.name}/${page} must load theme.css before primitives.css`);
            for(const appStyleIndex of appStyleIndexes) assert.ok(themeIndex<appStyleIndex,`${entry.name}/${page} must load theme.css before app CSS`);
        }
    }
});

test('preference form is domain-neutral and exposes configuration events',async()=>{
    const html=await read('arcane/components/preferences-form.html');
    const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
    assert.ok(script);
    assert.doesNotThrow(()=>new AsyncFunction(script));
    for(const marker of ['host.configure=configure','host.getValues=getValues','preferences-submit','preferences-change','preferences-reset']) assert.ok(html.includes(marker),marker);
    assert.doesNotMatch(html,/color scheme|reduce motion|Arcane Settings/i);
});

test('theme switcher and editor are reusable accessible component contracts',async()=>{
    const [switcher,editor,example]=await Promise.all([read('arcane/components/theme-switcher.html'),read('arcane/components/theme-editor.html'),read('example/component_theme/index.html')]);
    for(const [name,html] of [['switcher',switcher],['editor',editor]]){
        const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
        const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
        assert.ok(script,`${name} script`);
        assert.doesNotThrow(()=>new AsyncFunction(script));
    }
    assert.match(switcher,/role="group" aria-label="Color scheme"/);
    for(const mode of ['system','light','dark','custom']) assert.match(switcher,new RegExp(`data-scheme="${mode}"`));
    for(const event of ['theme-preview','theme-save','theme-reset']) assert.ok(editor.includes(event),event);
    assert.doesNotMatch(editor,/<textarea|contenteditable|custom css/i);
    assert.match(example,/arcane\/components\/theme-switcher\.html/);
    assert.match(example,/arcane\/components\/theme-editor\.html/);
});

test('Settings and Files remain thin shells over shared Arcane behavior',async()=>{
    const [settings,settingsModule,files,filesModule,registry]=await Promise.all([
        read('apps/settings/index.html'),read('apps/settings/modules/SettingsApp.js').then(async source=>source+await read('apps/settings/modules/AISettingsApp.js')),
        read('apps/files/index.html'),read('apps/files/modules/FilesApp.js'),
        read('machine_bundles/arcane-os-machine-bundle-v0.8.4/arcane-apps.json').then(JSON.parse)
    ]);
    assert.match(settings,/arcane\/components\/preferences-form\.html/);
    assert.match(settings,/arcane\/components\/theme-editor\.html/);
    assert.match(settings,/arcane\/components\/theme-switcher\.html/);
    assert.match(settingsModule,/arcane\/modules\/AppearancePreferences\.js/);
    assert.match(settingsModule,/arcane\/modules\/OllamaSettings\.js/);
    assert.match(files,/arcane\/components\/file-manager\.html/);
    assert.match(files,/arcane\/components\/theme-switcher\.html/);
    assert.match(filesModule,/arcane\/modules\/ThemeManager\.js/);
    assert.doesNotMatch(filesModule,/indexedDB|showOpenFilePicker|FileSystemHandle/);
    assert.deepEqual(registry.apps.files.capabilities,['preferences.read','storage.read','storage.write']);
    assert.deepEqual(registry.apps.settings.capabilities,['ai.inference','ai.models.manage','ai.models.read','ai.settings.manage','identity.read','network.status.read','preferences.read','preferences.write','appearance.read','appearance.write','system.read']);
    for(const app of ['files','settings']){
        const entries=await readdir(new URL(`../apps/${app}`,import.meta.url));
        assert(!entries.includes('components'),`${app} must use shared components rather than app-local copies`);
    }
});

test('native preference capability is shared and explicitly permissioned',async()=>{
    const [core,api,packager]=await Promise.all([
        read('machine_bundles/arcane-os-machine-bundle-v0.8.4/src/core/arcane-core.template.cjs'),
        read('machine_bundles/arcane-os-machine-bundle-v0.8.4/src/frontend/shared/arcane-api.js'),
        read('machine_bundles/arcane-os-machine-bundle-v0.8.4/tools/app-packager-lib.mjs')
    ]);
    for(const method of ['preferences.list','preferences.get','preferences.set','preferences.delete']) assert.ok(core.includes(method),method);
    assert.match(api,/preferences:\s*Object\.freeze/);
    assert.match(packager,/'preferences\.read'/);
    assert.match(packager,/'preferences\.write'/);
});
