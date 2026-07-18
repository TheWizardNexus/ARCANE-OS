const mobileNavigation=document.querySelector('.mobile-nav');

if(mobileNavigation instanceof HTMLDetailsElement){
    const summary=mobileNavigation.querySelector('summary');

    mobileNavigation.addEventListener('click',event=>{
        if(event.target instanceof Element&&event.target.closest('a')) mobileNavigation.open=false;
    });

    mobileNavigation.addEventListener('keydown',event=>{
        if(event.key!=='Escape'||!mobileNavigation.open) return;
        mobileNavigation.open=false;
        summary?.focus();
    });
}
