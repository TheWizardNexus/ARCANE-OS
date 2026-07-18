import assert from 'node:assert/strict';
import test from 'node:test';

class MemoryStorage{
    #items=new Map();

    get length(){
        return this.#items.size;
    }

    key(index){
        return [...this.#items.keys()][index]??null;
    }

    getItem(key){
        const normalized=String(key);
        return this.#items.has(normalized)?this.#items.get(normalized):null;
    }

    setItem(key,value){
        this.#items.set(String(key),String(value));
    }

    removeItem(key){
        this.#items.delete(String(key));
    }

    clear(){
        this.#items.clear();
    }
}

function documentFor(applicationId){
    return {
        documentElement:{dataset:{}},
        querySelector(selector){
            if(selector!=='meta[name="arcane-app-id"]') return null;
            return {getAttribute(name){return name==='content'?applicationId:null;}};
        }
    };
}

const storage=new MemoryStorage();
const alphaDocument=documentFor('alpha');
globalThis.localStorage=storage;
globalThis.document=alphaDocument;
globalThis.CustomEvent=class CustomEvent extends Event{
    constructor(type,options={}){super(type);this.detail=options.detail;}
};
globalThis.window={localStorage:storage,dispatchEvent(){}};

const {default:DBLS}=await import(`../arcane/modules/DBLS.js?test=${Date.now()}`);

test.after(()=>{
    delete globalThis.localStorage;
    delete globalThis.document;
    delete globalThis.CustomEvent;
    delete globalThis.window;
});

test('DBLS uses app-qualified keys and clear removes only the calling app',()=>{
    const alpha=window.dbls;
    alpha.set('shared',{owner:'alpha'});
    storage.setItem('legacy-unowned','preserve-me');

    delete window.dbls;
    const beta=new DBLS({documentObject:documentFor('beta'),storage});
    window.dbls=beta;
    beta.set('shared',{owner:'beta'});

    assert.deepEqual(alpha.get('shared'),{owner:'alpha'});
    assert.deepEqual(beta.get('shared'),{owner:'beta'});
    assert.deepEqual(alpha.getAllKeys(),['shared']);
    assert.deepEqual(beta.getAllKeys(),['shared']);
    assert.equal(storage.getItem('arcane.apps.alpha:shared'),JSON.stringify({owner:'alpha'}));
    assert.equal(storage.getItem('arcane.apps.beta:shared'),JSON.stringify({owner:'beta'}));

    alpha.clear();
    assert.equal(alpha.get('shared'),null);
    assert.deepEqual(beta.get('shared'),{owner:'beta'});
    assert.equal(storage.getItem('legacy-unowned'),'preserve-me');
});

test('DBLS fails closed when identity is absent or conflicts with metadata',()=>{
    delete window.dbls;
    assert.throws(
        ()=>new DBLS({documentObject:documentFor('alpha'),applicationId:'beta',storage}),
        error=>error?.code==='APP_DATA_SCOPE_MISMATCH'
    );
    assert.throws(
        ()=>new DBLS({documentObject:null,storage}),
        error=>error?.code==='APP_DATA_SCOPE_REQUIRED'
    );
});

test('apps route durable local data through the app-scoped DBLS adapter',async()=>{
    const {readFile}=await import('node:fs/promises');
    for(const relativePath of [
        '../apps/markdown/modules/MarkdownApp.js',
        '../apps/scamurai/modules/ScamuraiApp.js'
    ]){
        const source=await readFile(new URL(relativePath,import.meta.url),'utf8');
        assert.match(source,/import DBLS from ['"]\.\.\/\.\.\/\.\.\/arcane\/modules\/DBLS\.js['"]/);
        assert.match(source,/new DBLS\(\)/);
        assert.doesNotMatch(source,/\blocalStorage\s*\./);
    }
});

test('shared refresh UI does not sweep another app\'s origin storage',async()=>{
    const {readFile}=await import('node:fs/promises');
    const source=await readFile(
        new URL('../arcane/components/header.html',import.meta.url),
        'utf8'
    );
    assert.doesNotMatch(source,/\blocalStorage\s*\./);
    assert.match(source,/window\.location\.reload\(true\)/);
});

test('shared fallback stores bind identical domain keys to the current app',async()=>{
    const [communicationModule,reviewModule,preferenceModule]=await Promise.all([
        import('../arcane/modules/CommunicationPreferences.js'),
        import('../arcane/modules/RecordReviewStore.js'),
        import('../arcane/modules/PreferenceStore.js')
    ]);
    const schema=[{key:'enabled',type:'boolean',defaultValue:false}];

    globalThis.document=documentFor('alpha');
    await new communicationModule.default('shared').save({demo:{enabled:true}});
    const alphaReviews=new reviewModule.default({namespace:'shared'});
    await alphaReviews.load();
    await alphaReviews.set('same',{status:'reviewed'});
    await new preferenceModule.default({namespace:'shared',schema}).set('enabled',true);

    globalThis.document=documentFor('beta');
    await new communicationModule.default('shared').save({demo:{enabled:false}});
    const betaReviews=new reviewModule.default({namespace:'shared'});
    await betaReviews.load();
    await betaReviews.set('same',{status:'pending'});
    await new preferenceModule.default({namespace:'shared',schema}).set('enabled',false);

    assert.notEqual(
        storage.getItem('arcane.apps.alpha:arcane.communications.shared'),
        storage.getItem('arcane.apps.beta:arcane.communications.shared')
    );
    assert.match(storage.getItem('arcane.apps.alpha:arcane.record-review:shared'),/reviewed/);
    assert.match(storage.getItem('arcane.apps.beta:arcane.record-review:shared'),/pending/);
    assert.equal(storage.getItem('arcane.apps.alpha:arcane.preferences:shared.enabled'),'true');
    assert.equal(storage.getItem('arcane.apps.beta:arcane.preferences:shared.enabled'),'false');
    globalThis.document=alphaDocument;
});

test('the PreCrisis service worker limits cleanup and offline matches to its cache',async()=>{
    const source=await (await import('node:fs/promises')).readFile(
        new URL('../apps/precrisis/service-worker.js',import.meta.url),
        'utf8'
    );
    assert.match(source,/CACHE_PREFIX\s*=\s*'arcane-precrisis-cache-'/);
    assert.match(source,/['"]\.\.\/\.\.\/arcane\/modules\/AppDataScope\.js['"]/);
    assert.match(source,/belongsToPreCrisis\s*&&\s*cacheName\s*!==\s*CACHE_NAME/);
    assert.doesNotMatch(source,/if\s*\(\s*!cacheWhitelist\.includes\(cacheName\)\s*\)/);
    assert.match(source,/caches\.open\(CACHE_NAME\)[\s\S]*cache\s*=>\s*cache\.match\(event\.request\)/);
    assert.doesNotMatch(source,/return\s+caches\.match\(event\.request\)/);
});
