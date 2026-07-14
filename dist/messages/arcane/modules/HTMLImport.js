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

  #cacheVersion=3;

  async connectedCallback() {
    this.ready=false;
    const href = this.getAttribute('href');
    if (href) {
      let cache=JSON.parse(localStorage.getItem(href));
      if(cache&&cache.version===this.#cacheVersion&&cache.time&&cache.time>Date.now()-(7*24*60*60*1000)){
        this.#loadHTML(
          href,
          false,
          cache.html
        )
        return;
      }else{
        localStorage.removeItem(href);
      }

      console.warn('need to sanitize and validate htref path to only be inside the root of this app');
      const response = fetch(href,{cache:'reload'})
        .then(this.#loadHTML.bind(this,href))
        .catch(
          (err)=>{
            console.error('Error loading HTML component:', err);
          }
        );
    }else{
      console.log('no href provided for html-import tag',this)
    }
  }

  #isStored=false;

  async #loadHTML(href,response,cache=''){
    if(cache){
      response={
        ok:true,
        text:async ()=>{
          return cache;
        }
      }
    }
    
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const html = await response.text();
    this.shadowRoot.innerHTML = html;

    this.#executeScripts();

    if(!cache){
      localStorage.setItem(
        href,
        JSON.stringify(
          {
            html:html,
            time:Date.now(),
            version:this.#cacheVersion
          }
        )
      )
    }

    this.ready=true;
    this.dispatchEvent(new CustomEvent('html-import-ready',{
      bubbles:true,
      composed:true,
      detail:{href}
    }));
    return true;
  }

  #executeScripts() {
    const scripts = this.shadowRoot.querySelectorAll('script');
    scripts.forEach(
      script => {
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
        executable.textContent=`(async function(){${source}}).call((()=>{const registry=globalThis[Symbol.for('arcane.html-import.hosts')];const token=document.currentScript&&document.currentScript.dataset.arcaneHostToken;const host=registry instanceof Map&&token?registry.get(token):null;if(!host)throw new Error('HTML import host binding is unavailable.');return host;})())`;
        script.parentNode.removeChild(script);

        htmlImportHostRegistry.set(hostToken,this);
        try{
          document.head.appendChild(executable);
        }finally{
          executable.remove();
          htmlImportHostRegistry.delete(hostToken);
          delete executable.dataset.arcaneHostToken;
        }
      }
    );
  }
}
  
customElements.define('html-import', HTMLImport);

export default HTMLImport;
