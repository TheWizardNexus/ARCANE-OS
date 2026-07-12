import { marked } from './Marked.min.js';
import Is from '../node_modules/strong-type/index.js';

marked.use(
    {
        async: false,
        pedantic: false,
        gfm: true,
    }
);

const is = new Is(false);

class MD {
    #raw='';
    #rendered=''

    constructor(raw=''){
        this.raw=raw;
        this.rendered=marked.parse(raw);
        return this;
    }

    get rendered(){
        return this.#rendered;
    }

    get safeRendered(){
        return sanitize(this.#rendered);
    }

    set rendered(value=''){
        return this.#rendered;
    }

    get raw(){
        return this.#raw;
    }

    set raw(value=''){
        if(!is.string(value)){
            console.trace('MD.raw must be a string.');
            return this.#raw;
        }
        this.#raw = value;
        this.#rendered = marked.parse(value);
        return this.#raw;
    }

    append(value=''){
        if(!is.string(value)){
            console.trace('MD.append must be a string.');
            return this.#raw;
        }
        this.#raw += value;
        this.#rendered = marked.parse(this.#raw);
        return this.#raw;
    }
}

function sanitize(html=''){
    const template=document.createElement('template');
    template.innerHTML=html;

    template.content.querySelectorAll(
        'script,style,iframe,object,embed,link,meta,base,form,input,button,textarea,select,option,svg,math'
    ).forEach(element=>element.remove());

    template.content.querySelectorAll('*').forEach(
        function sanitizeElement(element){
            const attributes=Array.from(element.attributes);

            for(let i=0;i<attributes.length;i++){
                const attribute=attributes[i];
                const name=attribute.name.toLowerCase();

                if(name.startsWith('on')||name==='style'||name==='srcdoc'){
                    element.removeAttribute(attribute.name);
                    continue;
                }

                if(!['href','src','xlink:href'].includes(name)){
                    continue;
                }

                const value=attribute.value
                    .replace(/[\u0000-\u001F\u007F\s]+/g,'')
                    .toLowerCase();
                const safeImage=name==='src'&&value.startsWith('data:image/');

                if(
                    value.startsWith('javascript:')
                    || value.startsWith('vbscript:')
                    || value.startsWith('data:')&&!safeImage
                ){
                    element.removeAttribute(attribute.name);
                }
            }
        }
    );

    return template.innerHTML;
}

export default MD;
