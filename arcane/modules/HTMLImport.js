class HTMLImport extends HTMLElement {
  constructor() {
      super();
      this.attachShadow({ mode: 'open' });
  }

  #cacheVersion=3;

  async connectedCallback() {
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
        script.parentNode.removeChild(script);
        const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
        const execute=new AsyncFunction(source);

        execute.call(this).catch(
          error=>console.error('Error executing HTML component script:',error)
        );
      }
    );
  }
}
  
customElements.define('html-import', HTMLImport);

export default HTMLImport;
