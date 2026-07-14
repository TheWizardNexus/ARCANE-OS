import waitForComponent from '../../../arcane/modules/WaitForComponent.js';

const EXTERNAL_ORIGINS=new Set([
    'https://988lifeline.org',
    'https://warriorspirittexas.org'
]);

function statusElement(){return document.querySelector('#pageStatus')}
function setPageStatus(message='',error=false){
    const target=statusElement();
    if(!target)return;
    target.textContent=message;
    target.toggleAttribute('data-error',Boolean(error));
}

function validatedExternalURL(value){
    const url=new URL(String(value||''));
    if(url.protocol!=='https:'||url.username||url.password||!EXTERNAL_ORIGINS.has(url.origin))throw new TypeError('This external destination is not approved for Warrior Spirit Companion.');
    return url.href;
}

async function openExternal(value){
    const url=validatedExternalURL(value);
    const opened=globalThis.open?.(url,'_blank','noopener,noreferrer');
    if(!opened)throw new Error('The browser blocked the new window. Copy the visible address and open it manually.');
    return {opened:true,url};
}

async function copyText(value){
    const text=String(value||'');
    if(globalThis.navigator?.clipboard?.writeText)await globalThis.navigator.clipboard.writeText(text);
    else throw new Error(`Copy is unavailable. The value is: ${text}`);
    return text;
}

function bindPageActions(root=document){
    root.addEventListener('click',async event=>{
        const external=event.target.closest?.('[data-external-url]');
        const copy=event.target.closest?.('[data-copy-text]');
        if(!external&&!copy)return;
        event.preventDefault();
        try{
            if(external){await openExternal(external.dataset.externalUrl);setPageStatus('Opened in a separate browser window.')}
            else{const value=await copyText(copy.dataset.copyText);setPageStatus(`Copied ${value}.`)}
        }catch(error){setPageStatus(error?.message||'That action is unavailable.',true)}
    });
}

async function readyAppBar(status='Ready',tone='success'){
    const appBar=document.querySelector('#appBar');
    if(!appBar)return null;
    await waitForComponent(appBar,{methods:['setStatus'],property:'ready',event:'app-bar-ready'});
    appBar.setStatus(status,tone);
    return appBar;
}

export {bindPageActions,copyText,openExternal,readyAppBar,setPageStatus,validatedExternalURL};
