import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
    appendTranscription,
    applyMarkdownFormat,
    effectiveDashboardVisibility,
    normalizeChartOptions,
    normalizeChartRows,
    normalizeDashboardDefinitions,
    normalizeDashboardOptions,
    normalizeMarkdownOptions,
    normalizeVoiceOptions
} from '../arcane/modules/ComponentContracts.js';

test('chart contract accepts parent labels, schema, formatters, data, and options',()=>{
    const formatValue=value=>`${value}%`;
    const options=normalizeChartOptions(
        {
            key:'revenue',
            title:'Monthly Revenue',
            info:'Gross receipts reported by the parent application.',
            xKey:'month',
            yKey:'amount',
            seriesLabel:'Revenue',
            valueLabel:'Amount',
            timeLabel:'Month',
            latestLabel:'Most recent month',
            unit:'USD',
            style:'area',
            min:0,
            max:'100',
            removable:true,
            formatValue,
            chartOptions:{legend:{show:true}},
            data:[{month:'2026-01-01',amount:10}]
        }
    );

    assert.equal(options.key,'revenue');
    assert.equal(options.title,'Monthly Revenue');
    assert.equal(options.info,'Gross receipts reported by the parent application.');
    assert.equal(options.labels.time,'Month');
    assert.equal(options.labels.value,'Amount');
    assert.equal(options.labels.latest,'Most recent month');
    assert.equal(options.style,'area');
    assert.equal(options.max,100);
    assert.equal(options.formatValue,formatValue);
    assert.deepEqual(options.chartOptions,{legend:{show:true}});
    assert.deepEqual(options.data,[{month:'2026-01-01',amount:10}]);

    const rows=normalizeChartRows(
        [
            {month:'2026-02-01T00:00:00Z',amount:'25'},
            {month:'2026-01-01T00:00:00Z',amount:10},
            {month:'2026-01-01T00:00:00Z',amount:15},
            {month:'invalid',amount:99}
        ],
        options
    );
    assert.deepEqual(
        rows,
        [
            [Date.parse('2026-01-01T00:00:00Z'),15],
            [Date.parse('2026-02-01T00:00:00Z'),25]
        ]
    );
});

test('chart contract supports parent row adapters and non-time x axes',()=>{
    assert.deepEqual(
        normalizeChartRows(
            [{period:2,total:4},{period:1,total:2}],
            {
                time:false,
                mapRow:row=>[row.period,row.total*10]
            }
        ),
        [[1,20],[2,40]]
    );
});

test('chart contract preserves legacy aliases and rejects invalid parent options',()=>{
    const data=[[1,2]];
    const options=normalizeChartOptions(
        {
            chartKey:'legacy-key',
            chartStyle:'points',
            datasets:data,
            name:'Parent title'
        }
    );

    assert.equal(options.key,'legacy-key');
    assert.equal(options.style,'points');
    assert.equal(options.title,'Parent title');
    assert.equal(options.data,data);
    assert.throws(
        ()=>normalizeChartOptions({min:5,max:5}),
        /greater than min/
    );
    assert.throws(
        ()=>normalizeChartOptions({formatValue:'not a function'}),
        /formatValue must be a function/
    );
    assert.throws(
        ()=>normalizeChartOptions({labels:{value:4}}),
        /Chart labels\.value must be a string/
    );
});

test('dashboard definitions derive display information and chart options from parents',()=>{
    const [definition]=normalizeDashboardDefinitions(
        [
            {
                key:'tickets',
                label:'Open Tickets',
                info:'Unresolved support work.',
                data:[[1,3]],
                style:'points',
                valueLabel:'Tickets',
                defaultVisible:false,
                group:'Operations'
            }
        ]
    );

    assert.equal(definition.title,'Open Tickets');
    assert.equal(definition.description,'Unresolved support work.');
    assert.equal(definition.defaultVisible,false);
    assert.equal(definition.group,'Operations');
    assert.equal(definition.chartOptions.title,'Open Tickets');
    assert.equal(definition.chartOptions.info,'Unresolved support work.');
    assert.equal(definition.chartOptions.style,'points');
    assert.deepEqual(definition.chartOptions.data,[[1,3]]);
    assert.throws(
        ()=>normalizeDashboardDefinitions([{key:'same'},{key:'same'}]),
        /unique and nonempty/
    );
});

test('dashboard contract exposes effective parent visibility and nested chart options',()=>{
    const configuration=normalizeDashboardOptions(
        {
            definitions:[
                {
                    key:'alpha',
                    label:'Alpha',
                    defaultVisible:false,
                    chartOptions:{info:'Chart-specific information'}
                },
                {key:'beta',title:'Beta',disabled:true}
            ],
            labels:{trigger:'Choose panels'},
            visibility:{alpha:true,beta:'invalid',retired:false}
        }
    );

    assert.equal(configuration.labels.trigger,'Choose panels');
    assert.equal(
        configuration.definitions[0].chartOptions.info,
        'Chart-specific information'
    );
    assert.equal(configuration.definitions[1].disabled,true);
    assert.deepEqual(
        effectiveDashboardVisibility(
            configuration.definitions,
            configuration.visibility
        ),
        {alpha:true,beta:true}
    );
});

test('voice contract keeps legacy labels while accepting parent adapters and media options',()=>{
    const transcribe=async ()=> 'hello';
    const options=normalizeVoiceOptions(
        {
            description:'Dictate a field note.',
            startLabel:'Record',
            stopLabel:'Finish segment',
            completeLabel:'Use note',
            transcriptionLabel:'Field-note transcript',
            emptyLabel:'No field note yet.',
            messages:{ready:'Recorder ready.'},
            mediaConstraints:{audio:{noiseSuppression:true}},
            mimeTypes:['audio/ogg','audio/ogg','audio/webm'],
            persist:false,
            transcribe,
            initialValue:'Existing note'
        }
    );

    assert.equal(options.labels.start,'Record');
    assert.equal(options.labels.stop,'Finish segment');
    assert.equal(options.labels.complete,'Use note');
    assert.equal(options.messages.ready,'Recorder ready.');
    assert.deepEqual(options.mediaConstraints,{audio:{noiseSuppression:true}});
    assert.deepEqual(options.mimeTypes,['audio/ogg','audio/webm']);
    assert.equal(options.persist,false);
    assert.equal(options.transcribe,transcribe);
    assert.equal(options.initialValue,'Existing note');
});

test('voice contract composes segments and validates parent callbacks',()=>{
    assert.equal(
        appendTranscription('First segment','Second segment',' | '),
        'First segment | Second segment'
    );
    assert.equal(appendTranscription('First segment','  '),'First segment');
    assert.throws(
        ()=>normalizeVoiceOptions({onSave:true}),
        /onSave must be a function/
    );
    assert.throws(
        ()=>normalizeVoiceOptions({mimeTypes:['audio/webm',42]}),
        /only strings/
    );
    assert.throws(
        ()=>normalizeVoiceOptions({mediaConstraints:{video:true}}),
        /must request audio/
    );
});

test('markdown contract accepts parent toolbar, labels, initial data, and visibility',()=>{
    const options=normalizeMarkdownOptions(
        {
            bodyPlaceholder:'Write release notes...',
            previewLabel:'Release-note preview',
            saveLabel:'Publish draft',
            labels:{saved:'Draft published.'},
            formats:[
                {
                    id:'highlight',
                    label:'Highlight',
                    title:'Highlight text',
                    before:'==',
                    after:'==',
                    placeholder:'important text'
                }
            ],
            showTitle:false,
            showPreview:false,
            readOnly:true,
            initialTitle:'Version 1',
            initialValue:'# Changes'
        }
    );

    assert.equal(options.labels.bodyPlaceholder,'Write release notes...');
    assert.equal(options.labels.preview,'Release-note preview');
    assert.equal(options.labels.save,'Publish draft');
    assert.equal(options.labels.saved,'Draft published.');
    assert.equal(options.formats[0].id,'highlight');
    assert.equal(options.showTitle,false);
    assert.equal(options.showPreview,false);
    assert.equal(options.readOnly,true);
    assert.equal(options.initialTitle,'Version 1');
    assert.equal(options.initialValue,'# Changes');
    assert.throws(
        ()=>normalizeMarkdownOptions({formats:[{id:'bad'}]}),
        /prefix or wrapper/
    );
});

test('markdown contract applies parent-defined wrappers and prefixes',()=>{
    assert.deepEqual(
        applyMarkdownFormat(
            'release notes',
            0,
            7,
            {
                id:'highlight',
                label:'Highlight',
                before:'==',
                after:'==',
                placeholder:'important'
            }
        ),
        {
            value:'==release== notes',
            selectionStart:2,
            selectionEnd:9
        }
    );
    assert.deepEqual(
        applyMarkdownFormat(
            'one\ntwo',
            0,
            7,
            {
                id:'task',
                label:'Task',
                prefix:'- [ ] ',
                placeholder:'task'
            }
        ),
        {
            value:'- [ ] one\n- [ ] two',
            selectionStart:6,
            selectionEnd:19
        }
    );
});

test('shared component sources use the validated contracts and remain domain-neutral',async()=>{
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
    const components={
        chart:['host.configure=configure','host.populate=populate','normalizeChartOptions'],
        'dashboard-config':['host.getChartOptions=getChartOptions','normalizeDashboardOptions'],
        'markdown-editor':['host.saveEntry=saveEntry','normalizeMarkdownOptions'],
        'voice-transcription':['host.startRecording=startRecording','normalizeVoiceOptions']
    };

    for(const [name,markers] of Object.entries(components)){
        const source=await readFile(
            new URL(`../arcane/components/${name}.html`,import.meta.url),
            'utf8'
        );
        assert.match(source,/ComponentContracts\.js/);
        const script=source.match(
            /<script type="module">([\s\S]*?)<\/script>/
        )?.[1];
        assert.ok(script,`${name} is missing its module script`);
        assert.doesNotThrow(
            ()=>new AsyncFunction(script),
            `${name} module script must compile`
        );
        assert.doesNotMatch(
            source,
            /PreCrisis|schizophrenia|psychotic|revenue|patient/i
        );
        for(const marker of markers){
            assert.ok(source.includes(marker),`${name} is missing ${marker}`);
        }
    }
});
