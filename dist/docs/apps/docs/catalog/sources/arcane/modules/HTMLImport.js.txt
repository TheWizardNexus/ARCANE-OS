const htmlImportHostRegistryKey=Symbol.for('arcane.html-import.hosts');
const htmlImportHostRegistry=globalThis[htmlImportHostRegistryKey] instanceof Map
  ?globalThis[htmlImportHostRegistryKey]
  :new Map();

globalThis[htmlImportHostRegistryKey]=htmlImportHostRegistry;

let htmlImportScriptId=0;

class HTMLImport extends HTMLElement {
  ready=false;

  constructor() {
      super();
      this.attachShadow({ mode: 'open' });
  }

  async connectedCallback() {
    this.ready=false;
    const href=this.getAttribute('href');
    let resolvedHref='';
    if(!href){
      console.log('no href provided for html-import tag',this);
      return;
    }

    try{
      const baseURL=new URL(document.baseURI);
      const resolvedURL=new URL(href,baseURL);
      resolvedHref=resolvedURL.href;
      if(resolvedURL.origin!==baseURL.origin){
        throw new Error('HTML imports must use a same-origin URL.');
      }
      const response=await fetch(resolvedURL.href,{
        cache:'default',
        credentials:'same-origin',
        method:'GET',
        redirect:'error'
      });
      await this.#loadHTML(href,resolvedHref,response);
    }catch(err){
      console.error('Error loading HTML component:',err);
      this.dispatchEvent(new CustomEvent('html-import-error',{
        bubbles:true,
        composed:true,
        detail:{
          code:'HTML_IMPORT_FAILED',
          href,
          message:'The component could not be loaded.',
          resolvedHref
        }
      }));
    }
  }

  async #loadHTML(href,resolvedHref,response){
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const html = await response.text();
    this.shadowRoot.innerHTML = html;

    await this.#executeScripts();

    this.ready=true;
    this.dispatchEvent(new CustomEvent('html-import-ready',{
      bubbles:true,
      composed:true,
      detail:{href,resolvedHref}
    }));
    return true;
  }

  async #executeScripts() {
    const scripts = Array.from(this.shadowRoot.querySelectorAll('script'));
    for(const script of scripts){
        if (script.src) {
          console.error('ONLY INLINE SCRIPTS SUPPORTED AT THIS TIME FOR SECURITY REASONS');
          console.warn('script src path will need to be limited to ./{text}.js, ../{text}.js), or acceptable sub folders. This can be complex.');
          return;
          //newScript.src = script.src;
        }

        const source=(script.textContent||'').replace(
          /\bimport\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g,
          (_match,_quote,specifier)=>{
            return `import(${JSON.stringify(new URL(specifier,import.meta.url).href)})`;
          }
        );
        const executable=document.createElement('script');
        const hostToken=`html-import-${Date.now()}-${htmlImportScriptId++}`;

        executable.dataset.arcaneHostToken=hostToken;
        executable.textContent=`(()=>{const registry=globalThis[Symbol.for('arcane.html-import.hosts')];const token=document.currentScript&&document.currentScript.dataset.arcaneHostToken;const binding=registry instanceof Map&&token?registry.get(token):null;if(!binding?.host)throw new Error('HTML import host binding is unavailable.');binding.promise=(async function(){${source}}).call(binding.host);})()`;
        script.parentNode.removeChild(script);

        const binding={host:this,promise:null};
        htmlImportHostRegistry.set(hostToken,binding);
        try{
          document.head.appendChild(executable);
          await binding.promise;
        }finally{
          executable.remove();
          htmlImportHostRegistry.delete(hostToken);
          delete executable.dataset.arcaneHostToken;
        }
    }
  }
}
  
customElements.define('html-import', HTMLImport);

export default HTMLImport;
