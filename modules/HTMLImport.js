class HTMLImport extends HTMLElement {
  constructor() {
      super();
      this.attachShadow({ mode: 'open' });
  }

  #cacheVersion=2;

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
        
        let newScript=script.innerText;
        script.parentNode.removeChild(script);
        eval(`(async ()=>{${newScript}})()`);
      }
    );
  }
}
  
customElements.define('html-import', HTMLImport);

export default HTMLImport;
