import {loadAndApplyTheme} from '../../../arcane/modules/ThemeManager.js';

const mount=document.querySelector('#fileManagerMount');
const unsupported=document.querySelector('#unsupported');
const refresh=document.querySelector('#refresh');
const status=document.querySelector('#status');
let manager=null;

function setStatus(message){status.textContent=String(message||'');}

refresh.addEventListener('click',async()=>{
    refresh.disabled=true;setStatus('Refreshing files…');
    try{await manager.loadAll?.();setStatus('Files are up to date.');}
    catch(error){setStatus(error?.message||'Unable to refresh files.');}
    finally{refresh.disabled=false;}
});

function initializeFileManager(){
    if(typeof navigator.storage?.getDirectory!=='function'){
        unsupported.hidden=false;refresh.disabled=true;setStatus('Secure device storage is unavailable in this preview.');return;
    }
    manager=document.createElement('html-import');
    manager.id='fileManager';manager.dataset.layout='grid';manager.dataset.dirs='Documents,Downloads,Pictures';manager.setAttribute('href',mount.dataset.componentHref);
    manager.addEventListener('file-manager-ready',()=>setStatus('Files are ready. Upload into Documents, Downloads, or Pictures.'));
    manager.addEventListener('file-manager-action',event=>{
        const action=event.detail?.action;
        if(action==='error') setStatus(event.detail?.error?.message||'A file operation failed.');
        if(action==='delete') setStatus('File deleted.');
        if(action==='upload') setStatus('File saved on this device.');
    });
    mount.append(manager);
}

loadAndApplyTheme().catch(()=>{});
initializeFileManager();
