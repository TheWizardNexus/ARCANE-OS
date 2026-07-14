const HEX_COLOR=/^#([0-9a-f]{6})$/i;
const RGB_COLOR=/^(rgb|rgba)\(\s*(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*(?:,|\/)\s*(0|1|0?\.\d+))?\s*\)$/i;

export const arcaneLightThemeTokens=Object.freeze({
    background:'rgb(244, 246, 251)',
    surface:'rgb(255, 255, 255)',
    text:'rgb(23, 34, 56)',
    primary:'rgb(23, 34, 56)',
    secondary:'rgb(229, 233, 243)',
    buttonText:'rgb(255, 255, 255)',
    border:'rgb(203, 211, 226)',
    focus:'rgb(118, 87, 213)'
});

export const arcaneDarkThemeTokens=Object.freeze({
    background:'rgb(13, 18, 32)',
    surface:'rgb(21, 28, 45)',
    text:'rgb(237, 241, 250)',
    primary:'rgb(36, 43, 66)',
    secondary:'rgb(26, 33, 52)',
    buttonText:'rgb(255, 255, 255)',
    border:'rgb(59, 69, 94)',
    focus:'rgb(171, 148, 255)'
});

export const themeTokens=Object.freeze([
    Object.freeze({key:'background',property:'--background',label:'Page background',defaultValue:arcaneLightThemeTokens.background}),
    Object.freeze({key:'surface',property:'--modal-background',label:'Raised surfaces',defaultValue:arcaneLightThemeTokens.surface}),
    Object.freeze({key:'text',property:'--text-color',label:'Text',defaultValue:arcaneLightThemeTokens.text}),
    Object.freeze({key:'primary',property:'--primary-color',label:'Primary',defaultValue:arcaneLightThemeTokens.primary}),
    Object.freeze({key:'secondary',property:'--secondary-color',label:'Secondary',defaultValue:arcaneLightThemeTokens.secondary}),
    Object.freeze({key:'buttonText',property:'--button-text-color',label:'Text on primary',defaultValue:arcaneLightThemeTokens.buttonText}),
    Object.freeze({key:'border',property:'--border-color',label:'Borders',defaultValue:arcaneLightThemeTokens.border}),
    Object.freeze({key:'focus',property:'--focus-color',label:'Focus and accent',defaultValue:arcaneLightThemeTokens.focus})
]);

const tokenMap=new Map(themeTokens.map(token=>[token.key,token]));

function normalizeName(value){
    const name=String(value||'').trim();
    if(!name||name.length>40) throw new TypeError('Theme names must contain 1–40 characters.');
    return name;
}

function normalizeColor(value,label='Theme color'){
    const color=String(value||'').trim();
    const hexadecimal=color.match(HEX_COLOR);
    if(hexadecimal){
        const channels=hexadecimal[1].match(/.{2}/g).map(channel=>parseInt(channel,16));
        return `rgb(${channels.join(', ')})`;
    }
    const functional=color.match(RGB_COLOR);
    if(!functional) throw new TypeError(`${label} must be an RGB or RGBA color.`);
    const channels=functional.slice(2,5).map(Number);
    const alpha=functional[5]===undefined?null:Number(functional[5]);
    if(functional[1].toLowerCase()==='rgba'&&alpha===null){
        throw new TypeError(`${label} must include an alpha value when using RGBA.`);
    }
    if(channels.some(channel=>channel<0||channel>255)||(alpha!==null&&(alpha<0||alpha>1))){
        throw new RangeError(`${label} channels are outside the supported RGB or RGBA range.`);
    }
    return alpha===null
        ?`rgb(${channels.join(', ')})`
        :`rgba(${channels.join(', ')}, ${alpha})`;
}

export function themeColorToHex(value){
    const color=normalizeColor(value);
    const channels=color.match(/\d+/g).slice(0,3).map(Number);
    return `#${channels.map(channel=>channel.toString(16).padStart(2,'0')).join('')}`;
}

export default class Theme{
    constructor(input={}){
        this.name=normalizeName(input.name||'My Arcane skin');
        this.scheme=input.scheme==='dark'?'dark':'light';
        const source=input.tokens&&typeof input.tokens==='object'?input.tokens:{};
        const defaults=this.scheme==='dark'?arcaneDarkThemeTokens:arcaneLightThemeTokens;
        this.tokens=Object.freeze(Object.fromEntries(themeTokens.map(token=>[
            token.key,
            normalizeColor(source[token.key]??defaults[token.key],token.label)
        ])));
        Object.freeze(this);
    }

    toJSON(){ return {name:this.name,scheme:this.scheme,tokens:{...this.tokens}}; }

    apply(root=document.documentElement){
        Theme.clear(root);
        for(const [key,value] of Object.entries(this.tokens)) root.style.setProperty(tokenMap.get(key).property,value);
        root.dataset.arcaneSkin='custom';
        root.dataset.colorScheme=this.scheme;
        return this;
    }

    static clear(root=document.documentElement){
        for(const token of themeTokens) root.style.removeProperty(token.property);
        root.removeAttribute('data-arcane-skin');
        return root;
    }

    static fromJSON(value){
        if(value instanceof Theme) return value;
        const parsed=typeof value==='string'?JSON.parse(value):value;
        return new Theme(parsed);
    }
}
