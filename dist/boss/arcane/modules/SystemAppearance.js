export default class SystemAppearance{
    constructor(api=globalThis.Arcane?.appearance||null){ this.api=api; }

    available(){ return Boolean(this.api&&typeof this.api.apply==='function'); }

    async current(){
        if(!this.api||typeof this.api.current!=='function') return {supported:false,platform:'browser'};
        return this.api.current();
    }

    async apply(input={}){
        if(!this.available()) return {supported:false,platform:'browser'};
        const scheme=['system','light','dark'].includes(input.scheme)?input.scheme:'system';
        return this.api.apply({
            scheme,
            captionColor:scheme==='system'?null:input.captionColor||null,
            textColor:scheme==='system'?null:input.textColor||null
        });
    }
}
