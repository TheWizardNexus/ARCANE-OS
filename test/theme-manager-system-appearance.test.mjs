import test from 'node:test';
import assert from 'node:assert/strict';
import ThemeManager from '../arcane/modules/ThemeManager.js';
import SystemAppearance from '../arcane/modules/SystemAppearance.js';

class MemoryStore{
    constructor(values){ this.values={...values}; }
    defaults(){ return {...this.values}; }
    async load(){ return {...this.values}; }
    async set(key,value){ this.values[key]=value; return value; }
}

function rootFixture(){
    const properties=new Map();
    return {
        dataset:{},
        style:{
            fontSize:'',
            setProperty(key,value){ properties.set(key,value); },
            removeProperty(key){ properties.delete(key); }
        },
        removeAttribute(name){
            if(name==='data-color-scheme') delete this.dataset.colorScheme;
            if(name==='data-arcane-skin') delete this.dataset.arcaneSkin;
        }
    };
}

function managerFixture(systemAppearance){
    return new ThemeManager({
        appearanceStore:new MemoryStore({
            'appearance.colorScheme':'system',
            'appearance.density':'comfortable',
            'accessibility.reduceMotion':false,
            'accessibility.largeText':false
        }),
        skinStore:new MemoryStore({'appearance.activeSkin':'','appearance.customSkin':''}),
        systemAppearance,
        root:rootFixture()
    });
}

test('committed Arcane scheme changes propagate to the operating system adapter',async()=>{
    const calls=[];
    const manager=managerFixture({apply:async(value)=>{calls.push(value);return {supported:true};}});
    await manager.setScheme('light');
    assert.deepEqual(calls,[{
        scheme:'light',
        captionColor:'rgb(255, 255, 255)',
        textColor:'rgb(23, 34, 56)'
    }]);
});

test('custom skins propagate their native caption palette',async()=>{
    const calls=[];
    const manager=managerFixture({apply:async(value)=>{calls.push(value);return {supported:true};}});
    await manager.saveCustom({
        name:'Night glass',
        scheme:'dark',
        tokens:{surface:'rgb(10, 20, 30)',text:'rgb(240, 241, 242)'}
    });
    assert.equal(calls[0].scheme,'dark');
    assert.equal(calls[0].captionColor,'rgb(10, 20, 30)');
    assert.equal(calls[0].textColor,'rgb(240, 241, 242)');
});

test('SystemAppearance forwards only the native appearance contract',async()=>{
    const calls=[];
    const adapter=new SystemAppearance({
        current:async()=>({supported:true,scheme:'dark'}),
        apply:async(value)=>{calls.push(value);return value;}
    });
    await adapter.apply({scheme:'light',captionColor:'rgb(1, 2, 3)',textColor:'rgb(4, 5, 6)',ignored:true});
    assert.deepEqual(calls,[{scheme:'light',captionColor:'rgb(1, 2, 3)',textColor:'rgb(4, 5, 6)'}]);
});

test('ThemeBootstrap subscribes open renderers to Arcane appearance events',async()=>{
    const source=await import('node:fs/promises').then(({readFile})=>readFile(new URL('../arcane/modules/ThemeBootstrap.js',import.meta.url),'utf8'));
    assert.match(source,/Arcane\?\.events\?\.on/);
    assert.match(source,/\.events\.on\('appearance\.changed'/);
    assert.match(source,/await result\.manager\.load\(\)/);
});
