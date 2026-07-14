import {loadAndApplyTheme} from './ThemeManager.js';

const sharedKey='arcaneThemeReady';
const listenerKey='arcaneThemeAppearanceListener';

export function bootstrapArcaneTheme(options={}){
    const useSharedPromise=Object.keys(options).length===0;
    if(useSharedPromise&&globalThis[sharedKey]) return globalThis[sharedKey];

    const ready=loadAndApplyTheme(options).catch(error=>{
        console.warn('[Arcane theme] Unable to load the saved appearance; using the system theme.',error);
        return {manager:null,state:null,error};
    });

    if(useSharedPromise) globalThis[sharedKey]=ready;
    if(useSharedPromise&&globalThis.Arcane?.events?.on&&!globalThis[listenerKey]){
        globalThis[listenerKey]=globalThis.Arcane.events.on('appearance.changed',async()=>{
            const result=await ready;
            if(result?.manager) await result.manager.load();
        });
    }
    return ready;
}

export const arcaneThemeReady=bootstrapArcaneTheme();
export default arcaneThemeReady;
