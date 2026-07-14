const programs=Object.freeze([
    Object.freeze({id:'veterans',number:'Program 01',name:'Warrior Spirit Veterans',audience:'Veterans',description:'Journaling, communication, servant leadership, mentoring, coaching, occupational training, breathwork, and equine programming.'}),
    Object.freeze({id:'teach',number:'Program 02',name:'Warrior Spirit Teach',audience:'Educators and educational aides',description:'Self-care, mental health literacy, resilience, relationship building, mentoring, coaching, breathwork, and equine programming.'}),
    Object.freeze({id:'youth',number:'Program 03',name:'Warrior Spirit Youth',audience:'Youth and their trusted adults',description:'Journaling, mental wellness, communication, servant leadership, financial literacy, mentoring, coaching, breathwork, and equine programming.'}),
    Object.freeze({id:'recovery',number:'Program 04',name:'Warrior Spirit Recovery',audience:'People in recovery',description:'Journaling, fitness and nutrition, self-care, communication, healthy life coaching, breathwork, and equine programming.'}),
    Object.freeze({id:'first-watch',number:'Program 05',name:'Warrior Spirit First Watch',audience:'First responders',description:'Journaling, communication, self-care, fitness and nutrition, servant leadership, coaching, mentoring, breathwork, and equine programming.'})
]);

const byId=new Map(programs.map(program=>[program.id,program]));

function programById(value){return byId.get(String(value||'').trim())||programs[0]}
function programPrompt(program){const selected=programById(program?.id||program);return `Selected Warrior Spirit program: ${selected.name}. Intended audience: ${selected.audience}. Published program context: ${selected.description}`}

export {programById,programPrompt,programs};
