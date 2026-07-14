import PreferenceStore from './PreferenceStore.js';

export const appearancePreferenceSchema=Object.freeze([
    {key:'appearance.colorScheme',type:'select',label:'Color scheme',description:'Use the device preference or choose a consistent light or dark appearance.',defaultValue:'system',options:[{label:'Use device setting',value:'system'},{label:'Light',value:'light'},{label:'Dark',value:'dark'}]},
    {key:'appearance.density',type:'select',label:'Layout density',description:'Choose comfortable spacing or fit more information on screen.',defaultValue:'comfortable',options:[{label:'Comfortable',value:'comfortable'},{label:'Compact',value:'compact'}]},
    {key:'accessibility.reduceMotion',type:'boolean',label:'Reduce motion',description:'Limit non-essential animation and transitions.',defaultValue:false},
    {key:'accessibility.largeText',type:'boolean',label:'Larger text',description:'Increase the base text size in compatible Arcane applications.',defaultValue:false}
]);

export function createAppearancePreferenceStore(options={}){
    return new PreferenceStore({namespace:'arcane',schema:appearancePreferenceSchema,...options});
}

export function applyAppearancePreferences(values={},root=document.documentElement){
    const scheme=values['appearance.colorScheme'];
    if(scheme==='light'||scheme==='dark') root.dataset.colorScheme=scheme; else root.removeAttribute('data-color-scheme');
    root.dataset.density=values['appearance.density']||'comfortable';
    root.dataset.reduceMotion=String(Boolean(values['accessibility.reduceMotion']));
    root.style.fontSize=values['accessibility.largeText']?'18px':'';
    return values;
}

export async function loadAndApplyAppearancePreferences(options={}){
    const store=options.store||createAppearancePreferenceStore(options);
    const values=await store.load();
    applyAppearancePreferences(values,options.root||document.documentElement);
    return {store,values};
}
