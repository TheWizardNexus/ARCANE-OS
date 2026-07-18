function parseRecordLinks(value='',{pattern=/\b[A-Z]\d{4}\b/gi}={}){
    const text=Array.isArray(value)?value.join(' '):String(value||'');
    return [...new Set([...text.matchAll(pattern)].map(match=>match[0].toUpperCase()))];
}

function buildRecordLinkIndex(records=[],{
    id=item=>item.id,
    links=item=>item.links||[],
    validIds=null
}={}){
    const known=new Set(validIds||records.map(id).filter(Boolean));
    const outbound={}; const inbound={}; const invalid={};
    for(const record of records){
        const source=String(id(record)||'');
        if(!source) continue;
        const targets=[...new Set(links(record).map(value=>String(value).toUpperCase()))].filter(target=>target&&target!==source);
        outbound[source]=targets.filter(target=>known.has(target));
        invalid[source]=targets.filter(target=>!known.has(target));
        for(const target of outbound[source]) inbound[target]=[...new Set([...(inbound[target]||[]),source])];
    }
    return {outbound,inbound,invalid,linkCount:Object.values(outbound).reduce((sum,targets)=>sum+targets.length,0)};
}

export {buildRecordLinkIndex,parseRecordLinks};
