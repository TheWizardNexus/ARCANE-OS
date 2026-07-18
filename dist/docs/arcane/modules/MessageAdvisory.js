function bounded(value,maximum){return String(value??'').trim().slice(0,maximum);}

export function normalizeContentAdvisory(value){
    if(!value||typeof value!=='object')return null;
    return Object.freeze({
        level:['critical','high','caution','low','unavailable'].includes(value.level)?value.level:'caution',
        title:bounded(value.title||'Content advisory',120),
        summary:bounded(value.summary||'Review this message carefully.',500),
        signals:Object.freeze(Array.from(value.signals||[],item=>bounded(item,120)).filter(Boolean).slice(0,8)),
        actionLabel:bounded(value.actionLabel,80),
    });
}

export async function inspectMessageRecords(messages,inspector){
    const advisories=new Map();let failures=0;
    if(typeof inspector!=='function')return {advisories,failures};
    for(const message of Array.from(messages||[])){
        try{const advisory=normalizeContentAdvisory(await inspector(message));if(advisory)advisories.set(message,advisory);}
        catch{failures+=1;advisories.set(message,normalizeContentAdvisory({level:'unavailable',title:'Safety check unavailable',summary:'No safety conclusion was made for this message. Pause and review it manually before replying.'}));}
    }
    return {advisories,failures};
}
