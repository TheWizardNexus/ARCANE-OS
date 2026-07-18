import Theme,{arcaneDarkThemeTokens,arcaneLightThemeTokens} from '../entities/Theme.js';
import PreferenceStore from './PreferenceStore.js';
import {applyAppearancePreferences,createAppearancePreferenceStore} from './AppearancePreferences.js';
import SystemAppearance from './SystemAppearance.js';

const skinSchema=Object.freeze([
    {key:'appearance.activeSkin',type:'text',defaultValue:''},
    {key:'appearance.customSkin',type:'text',defaultValue:''}
]);

export default class ThemeManager{
    constructor({appearanceStore=null,skinStore=null,systemAppearance=null,root=null}={}){
        this.appearanceStore=appearanceStore||createAppearancePreferenceStore();
        this.skinStore=skinStore||new PreferenceStore({namespace:'arcane',schema:skinSchema});
        this.root=root||globalThis.document?.documentElement||null;
        this.systemAppearance=systemAppearance||new SystemAppearance();
        this.appearance=this.appearanceStore.defaults();
        this.skinState=this.skinStore.defaults();
        this.customTheme=null;
    }

    async load(){
        const [appearance,skinState]=await Promise.all([this.appearanceStore.load(),this.skinStore.load()]);
        this.appearance=appearance;
        this.skinState=skinState;
        this.customTheme=parseTheme(skinState['appearance.customSkin']);
        this.apply();
        return this.current();
    }

    apply(){
        if(!this.root) return this.current();
        Theme.clear(this.root);
        applyAppearancePreferences(this.appearance,this.root);
        if(this.skinState['appearance.activeSkin']==='custom'&&this.customTheme) this.customTheme.apply(this.root);
        return this.current();
    }

    current(){
        const custom=this.skinState['appearance.activeSkin']==='custom'&&this.customTheme;
        return {
            mode:custom?'custom':this.appearance['appearance.colorScheme']||'system',
            appearance:{...this.appearance},
            theme:this.customTheme?.toJSON()||null
        };
    }

    async setScheme(scheme='system'){
        const normalized=['system','light','dark'].includes(scheme)?scheme:'system';
        await Promise.all([
            this.appearanceStore.set('appearance.colorScheme',normalized),
            this.skinStore.set('appearance.activeSkin','')
        ]);
        this.appearance={...this.appearance,'appearance.colorScheme':normalized};
        this.skinState={...this.skinState,'appearance.activeSkin':''};
        this.apply();await this.syncSystemAppearance();this.emit();
        return this.current();
    }

    async saveCustom(input={}){
        const theme=Theme.fromJSON(input);
        await Promise.all([
            this.skinStore.set('appearance.customSkin',JSON.stringify(theme)),
            this.skinStore.set('appearance.activeSkin','custom'),
            this.appearanceStore.set('appearance.colorScheme',theme.scheme)
        ]);
        this.customTheme=theme;
        this.skinState={...this.skinState,'appearance.customSkin':JSON.stringify(theme),'appearance.activeSkin':'custom'};
        this.appearance={...this.appearance,'appearance.colorScheme':theme.scheme};
        this.apply();await this.syncSystemAppearance();this.emit();
        return this.current();
    }

    async activateCustom(){
        if(!this.customTheme) await this.load();
        if(!this.customTheme) return this.current();
        await Promise.all([
            this.skinStore.set('appearance.activeSkin','custom'),
            this.appearanceStore.set('appearance.colorScheme',this.customTheme.scheme)
        ]);
        this.skinState={...this.skinState,'appearance.activeSkin':'custom'};
        this.appearance={...this.appearance,'appearance.colorScheme':this.customTheme.scheme};
        this.apply();await this.syncSystemAppearance();this.emit();
        return this.current();
    }

    preview(input={}){
        const theme=Theme.fromJSON(input);
        if(this.root) theme.apply(this.root);
        return theme;
    }

    async resetCustom(){
        await Promise.all([
            this.skinStore.set('appearance.customSkin',''),
            this.skinStore.set('appearance.activeSkin','')
        ]);
        this.customTheme=null;
        this.skinState={...this.skinState,'appearance.customSkin':'','appearance.activeSkin':''};
        this.apply();await this.syncSystemAppearance();this.emit();
        return this.current();
    }

    async syncSystemAppearance(){
        const state=this.current();
        const theme=state.mode==='custom'?this.customTheme:null;
        const tokens=theme?.tokens||(state.mode==='dark'?arcaneDarkThemeTokens:state.mode==='light'?arcaneLightThemeTokens:null);
        return this.systemAppearance.apply({
            scheme:theme?.scheme||state.mode,
            captionColor:tokens?.surface||null,
            textColor:tokens?.text||null
        });
    }

    emit(){
        if(typeof globalThis.CustomEvent==='function'&&typeof globalThis.dispatchEvent==='function'){
            globalThis.dispatchEvent(new CustomEvent('arcane-theme-change',{detail:this.current()}));
        }
    }
}

function parseTheme(value){
    if(!value) return null;
    try{return Theme.fromJSON(value);}catch{return null;}
}

export async function loadAndApplyTheme(options={}){
    const manager=options.manager||new ThemeManager(options);
    const state=await manager.load();
    return {manager,state};
}
