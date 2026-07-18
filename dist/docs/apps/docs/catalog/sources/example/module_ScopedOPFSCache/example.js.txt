import ScopedOPFSCache from '../../arcane/modules/ScopedOPFSCache.js';

const button=document.querySelector('#run');
const status=document.querySelector('#status');

button.addEventListener('click',async()=>{
    button.disabled=true;
    status.textContent='Running…';
    try{
        const cache=new ScopedOPFSCache({
            applicationId:'scoped-opfs-cache-example',
            namespace:'arcane-scoped-cache-example-v1'
        });
        const value={message:'Scoped cache round trip complete.',savedAt:new Date().toISOString()};
        await cache.set('round-trip',value);
        const restored=await cache.get('round-trip');
        await cache.delete('round-trip');
        status.textContent=restored?.message||'The cached value could not be read.';
    }catch(error){
        status.textContent=error?.message||'The cache example failed.';
    }finally{
        button.disabled=false;
    }
});
