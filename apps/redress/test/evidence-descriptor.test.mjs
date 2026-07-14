import assert from 'node:assert/strict';
import test from 'node:test';

import EvidenceDescriptor,{
    buildDescriptionMarkdown,
    fallbackAnalysis,
    relativeLink
} from '../modules/EvidenceDescriptor.js';

function namedBlob(name,body='',type='application/octet-stream'){
    const blob=new Blob([body],{type});
    Object.defineProperties(blob,{
        name:{value:name,enumerable:true},
        lastModified:{value:Date.parse('2026-07-12T12:00:00Z'),enumerable:true}
    });
    return blob;
}

test('relative links preserve flat and nested filing/evidence pairs',()=>{
    assert.equal(
        relativeLink('Filing by Filing/MD/order.md','Filing by Filing/PDF/order.pdf'),
        '../PDF/order.pdf'
    );
    assert.equal(
        relativeLink('Evidence/MD/phone/messages/call.md','Evidence/Raw/phone/messages/call.m4a'),
        '../../../Raw/phone/messages/call.m4a'
    );
});

test('filing fallback retains the parsed filing date',()=>{
    const analysis=fallbackAnalysis(
        namedBlob('24-10-28 [COURT] - Order After Hearing.pdf','%PDF','application/pdf'),
        {kind:'filing',extraction:{content:'',limitations:[]}}
    );

    assert.equal(analysis.date,'24-10-28');
    assert.deepEqual(analysis.who,['COURT']);
});

test('evidence Markdown uses an Evidence heading and a correct nested source link',()=>{
    const markdown=buildDescriptionMarkdown({
        kind:'evidence',
        rawRecord:{
            name:'[UNDATED] [ALEX] - Voicemail.m4a',
            path:'Evidence/Raw/phone/[UNDATED] [ALEX] - Voicemail.m4a',
            originalName:'recording.m4a',
            originalPath:'phone/recording.m4a',
            mimeType:'audio/mp4',
            size:12,
            hash:{status:'complete',value:'abc'},
            importedAt:'2026-07-12T12:00:00Z'
        },
        analysis:{
            who:['ALEX'],
            title:'Voicemail',
            documentType:'Audio evidence',
            summary:'A voicemail.',
            requests:[],
            limitations:[],
            needsReview:true
        },
        extraction:{status:'not-extracted',method:'metadata-only',limitations:[]}
    });

    assert.match(markdown,/### Evidence/);
    assert.doesNotMatch(markdown,/### Filing/);
    assert.match(markdown,/\(<\.\.\/\.\.\/Raw\/phone\/\[UNDATED\] \[ALEX\] - Voicemail\.m4a>\)/);
});

test('invalid AI naming fields fall back to a conservative review name',async()=>{
    const ai={
        configured:true,
        redressConfigured:true,
        async fetch(){
            return {
                choices:[{
                    message:{
                        content:JSON.stringify({
                            title:'',
                            who:[],
                            what:'',
                            date:'sometime last year',
                            summary:'Unverified description.',
                            needsReview:false
                        })
                    }
                }]
            };
        }
    };
    const descriptor=new EvidenceDescriptor({ai});
    const result=await descriptor.analyze(namedBlob('voice-note.m4a','audio','audio/mp4'));

    assert.match(result.canonicalName,/^\[UNDATED\] \[SOURCE NOT YET IDENTIFIED\] - voice note\.m4a$/i);
    assert.equal(result.analysis.needsReview,true);
    assert.ok(result.analysis.limitations.some(item=>item.includes('proposed evidence name was rejected')));
});
