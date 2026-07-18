const DEFAULT_LEVELS=Object.freeze([
    {minimum:70,id:'critical'},
    {minimum:40,id:'high'},
    {minimum:15,id:'caution'},
    {minimum:0,id:'low'},
]);

function normalizeText(value,maxLength){
    return String(value??'').normalize('NFKC').slice(0,maxLength);
}

export function analyzeRiskSignals(input,{signals=[],levels=DEFAULT_LEVELS,maxLength=20_000}={}){
    const text=normalizeText(input,maxLength);
    const matches=[];
    let score=0;

    for(const signal of signals){
        if(!signal||typeof signal.id!=='string'||!(signal.pattern instanceof RegExp))continue;
        signal.pattern.lastIndex=0;
        if(!signal.pattern.test(text))continue;
        const weight=Math.max(0,Math.min(100,Number(signal.weight)||0));
        score+=weight;
        matches.push({
            id:signal.id,
            label:String(signal.label||signal.id),
            weight,
            guidance:String(signal.guidance||''),
        });
    }

    score=Math.min(100,score);
    const ordered=[...levels].sort((a,b)=>b.minimum-a.minimum);
    const level=ordered.find(candidate=>score>=candidate.minimum)?.id||'unknown';
    return Object.freeze({level,matches:Object.freeze(matches),score,textLength:text.length,truncated:String(input??'').length>text.length});
}

export {DEFAULT_LEVELS};
