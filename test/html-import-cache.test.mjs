import assert from 'node:assert/strict';
import test from 'node:test';

class MemoryStorage{
    constructor(){this.calls=[];this.values=new Map()}
    getItem(key){this.calls.push(['get',String(key)]);return this.values.get(String(key))??null}
    setItem(key,value){this.calls.push(['set',String(key)]);this.values.set(String(key),String(value))}
    removeItem(key){this.calls.push(['remove',String(key)]);this.values.delete(String(key))}
}

class FakeHTMLElement extends EventTarget{
    constructor(){
        super();
        this.attributes=new Map();
        this.shadowRoot=null;
    }
    attachShadow(){
        let html='';
        this.shadowRoot={
            get innerHTML(){return html},
            set innerHTML(value){html=String(value)},
            querySelectorAll(){return []}
        };
        return this.shadowRoot;
    }
    getAttribute(name){return this.attributes.get(name)??null}
    setAttribute(name,value){this.attributes.set(name,String(value))}
}

class FakeCustomEvent extends Event{
    constructor(type,{detail,...options}={}){
        super(type,options);
        this.detail=detail;
    }
}

function ready(element){
    return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('HTML import did not become ready.')),1000);
        element.addEventListener('html-import-ready',event=>{
            clearTimeout(timer);
            resolve(event);
        },{once:true});
    });
}

test('HTMLImport never trusts executable component HTML from origin storage',async()=>{
    const storage=new MemoryStorage();
    const registry=new Map();
    const documentState={baseURI:'https://example.test/project/apps/demo/'};
    const requested=[];
    const requestOptions=[];

    globalThis.HTMLElement=FakeHTMLElement;
    globalThis.CustomEvent=FakeCustomEvent;
    globalThis.localStorage=storage;
    globalThis.customElements={define(name,value){registry.set(name,value)}};
    globalThis.document={
        get baseURI(){return documentState.baseURI},
        head:{appendChild(){}},
        createElement(){
            return {dataset:{},remove(){},set textContent(_value){},get textContent(){return ''}};
        }
    };
    globalThis.fetch=async (input,options)=>{
        const url=new URL(input,documentState.baseURI).href;
        requested.push(url);
        requestOptions.push(options);
        return {ok:true,status:200,text:async()=>`<p>${url}</p>`};
    };

    await import(`../arcane/modules/HTMLImport.js?cache-test=${Date.now()}`);
    const HTMLImport=registry.get('html-import');
    assert.equal(typeof HTMLImport,'function');

    storage.values.set(
        'arcane.html-import.v3:https://example.test/project/apps/demo/component.html',
        JSON.stringify({html:'<p>hostile stored component</p>',time:Date.now(),version:3})
    );

    const component=new HTMLImport();
    component.setAttribute('href','./component.html');
    const componentReady=ready(component);
    await component.connectedCallback();
    await componentReady;
    assert.match(component.shadowRoot.innerHTML,/project\/apps\/demo\/component\.html/);
    assert.doesNotMatch(component.shadowRoot.innerHTML,/hostile stored component/);
    assert.deepEqual(storage.calls,[],'executable component HTML must not touch origin storage');
    assert.equal(requested.length,1);
    assert.deepEqual(requestOptions[0],{
        cache:'default',
        credentials:'same-origin',
        method:'GET',
        redirect:'error'
    });

    const crossOrigin=new HTMLImport();
    crossOrigin.setAttribute('href','https://attacker.test/component.html');
    let failureDetail=null;
    crossOrigin.addEventListener('html-import-error',event=>{failureDetail=event.detail},{once:true});
    const originalConsoleError=console.error;
    const errors=[];
    console.error=(...args)=>errors.push(args);
    try{
        await crossOrigin.connectedCallback();
    }finally{
        console.error=originalConsoleError;
    }
    assert.equal(crossOrigin.ready,false);
    assert.equal(requested.length,1,'cross-origin component HTML must be rejected before fetch');
    assert.match(String(errors[0]?.[1]?.message||''),/same-origin URL/);
    assert.equal(failureDetail?.code,'HTML_IMPORT_FAILED');
    assert.equal(failureDetail?.href,'https://attacker.test/component.html');
});
