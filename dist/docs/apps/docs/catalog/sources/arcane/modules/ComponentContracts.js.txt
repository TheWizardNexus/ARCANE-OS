const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);

function record(value,label){
    if(value===undefined){
        return {};
    }
    if(!value||typeof value!=='object'||Array.isArray(value)){
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function string(value,fallback='',allowEmpty=false){
    if(typeof value!=='string'){
        return fallback;
    }
    const normalized=value.trim();
    return normalized||(allowEmpty?'':fallback);
}

function text(value,fallback='',allowEmpty=false){
    if(typeof value!=='string'){
        return fallback;
    }
    return value||(allowEmpty?'':fallback);
}

function option(input,previous,key,fallback){
    return own(input,key)
        ?input[key]
        :own(previous,key)
            ?previous[key]
            :fallback;
}

function optionAlias(input,previous,keys,fallback){
    for(const key of keys){
        if(own(input,key)){
            return input[key];
        }
    }
    for(const key of keys){
        if(own(previous,key)){
            return previous[key];
        }
    }
    return fallback;
}

function optionalCallback(input,previous,keys,label=keys[0]){
    const value=optionAlias(input,previous,keys,null);
    if(value!==null&&value!==undefined&&typeof value!=='function'){
        throw new TypeError(`${label} must be a function or null`);
    }
    return typeof value==='function'?value:null;
}

function finiteNumber(value,label){
    if(value===null||value===undefined||value===''){
        return null;
    }
    const normalized=Number(value);
    if(!Number.isFinite(normalized)){
        throw new TypeError(`${label} must be a finite number or null`);
    }
    return normalized;
}

function stringRecord(value,defaults,label){
    value=record(value,label);
    const normalized={...defaults};
    for(const [key,item] of Object.entries(value)){
        if(typeof item!=='string'){
            throw new TypeError(`${label}.${key} must be a string`);
        }
        normalized[key]=item;
    }
    return normalized;
}

const CHART_LABELS=Object.freeze({
    empty:'No data yet.',
    hover:'Point under cursor',
    keyboard:'Keyboard-selected point',
    latest:'Latest recorded point',
    navigation:'Use left and right arrow keys to review every recorded point.',
    noSelection:'No point selected',
    selected:'Selected point',
    time:'Date',
    value:'Value'
});

function normalizeChartOptions(input={},previous={}){
    input=record(input,'Chart options');
    previous=record(previous,'Previous chart options');
    const previousLabels=stringRecord(
        previous.labels,
        CHART_LABELS,
        'Previous chart labels'
    );
    const labels=stringRecord(input.labels,previousLabels,'Chart labels');
    const aliases={
        emptyLabel:'empty',
        hoverLabel:'hover',
        keyboardLabel:'keyboard',
        latestLabel:'latest',
        navigationLabel:'navigation',
        noSelectionLabel:'noSelection',
        selectedLabel:'selected',
        timeLabel:'time',
        valueLabel:'value'
    };

    for(const [source,target] of Object.entries(aliases)){
        if(typeof input[source]==='string'){
            labels[target]=input[source];
        }
    }

    const styleValue=string(
        optionAlias(input,previous,['style','chartStyle'],'line'),
        'line'
    );
    const style=['area','line','points'].includes(styleValue)?styleValue:'line';
    const min=finiteNumber(option(input,previous,'min',null),'min');
    const max=finiteNumber(option(input,previous,'max',null),'max');
    if(min!==null&&max!==null&&max<=min){
        throw new RangeError('max must be greater than min');
    }

    const chartOptions=option(input,previous,'chartOptions',null);
    if(
        chartOptions!==null
        &&typeof chartOptions!=='function'
        &&(!chartOptions||typeof chartOptions!=='object'||Array.isArray(chartOptions))
    ){
        throw new TypeError('chartOptions must be an object, function, or null');
    }

    const data=optionAlias(input,previous,['data','dataset','datasets'],undefined);

    return {
        key:string(optionAlias(input,previous,['key','chartKey'],''),'',true),
        title:text(optionAlias(input,previous,['title','name'],'Chart'),'Chart'),
        info:text(optionAlias(input,previous,['info','description'],'') ,'',true),
        style,
        seriesLabel:text(option(input,previous,'seriesLabel',labels.value),labels.value),
        labels,
        min,
        max,
        removable:option(input,previous,'removable',false)===true,
        removeLabel:text(option(input,previous,'removeLabel',''),'',true),
        color:text(option(input,previous,'color',''),'',true),
        unit:text(option(input,previous,'unit',''),'',true),
        time:option(input,previous,'time',true)!==false,
        xKey:string(option(input,previous,'xKey',''),'',true),
        yKey:string(option(input,previous,'yKey',''),'',true),
        mapRow:optionalCallback(input,previous,['mapRow']),
        parseX:optionalCallback(input,previous,['parseX']),
        parseY:optionalCallback(input,previous,['parseY']),
        formatTime:optionalCallback(input,previous,['formatTime']),
        formatValue:optionalCallback(input,previous,['formatValue']),
        chartOptions:typeof chartOptions==='object'&&chartOptions!==null
            ?{...chartOptions}
            :chartOptions,
        data
    };
}

function numericX(value,time=true){
    if(value instanceof Date){
        return value.getTime();
    }
    const number=Number(value);
    if(Number.isFinite(number)){
        return number;
    }
    if(time&&typeof value==='string'){
        const parsed=Date.parse(value);
        return Number.isFinite(parsed)?parsed:NaN;
    }
    return NaN;
}

function normalizeChartRows(data=[],options={}){
    const config=normalizeChartOptions(options);
    if(data&&typeof data==='object'&&!Array.isArray(data)){
        data=Object.entries(data);
    }
    if(!Array.isArray(data)){
        return [];
    }
    const normalized=[];

    for(let index=0;index<data.length;index++){
        const original=data[index];
        const item=config.mapRow?config.mapRow(original,index):original;
        const x=Array.isArray(item)
            ?item[0]
            :config.xKey
                ?item?.[config.xKey]
                :item?.date??item?.timestamp??item?.x;
        const y=Array.isArray(item)
            ?item[1]
            :config.yKey
                ?item?.[config.yKey]
                :item?.value??item?.score??item?.y;
        const parsedX=config.parseX?config.parseX(x,item,index):x;
        const parsedY=config.parseY?config.parseY(y,item,index):y;
        const normalizedX=numericX(parsedX,config.time);
        const normalizedY=Number(parsedY);

        if(Number.isFinite(normalizedX)&&Number.isFinite(normalizedY)){
            normalized.push([normalizedX,normalizedY]);
        }
    }

    normalized.sort((left,right)=>left[0]-right[0]);
    return Array.from(new Map(normalized.map(row=>[row[0],row])).values());
}

function normalizeDashboardDefinitions(values=[]){
    if(!Array.isArray(values)){
        throw new TypeError('Dashboard definitions must be an array');
    }
    const keys=new Set();
    return values.map(
        (value,index)=>{
            value=record(value,`Dashboard definition ${index}`);
            const key=string(value.key,'');
            if(!key||keys.has(key)){
                throw new Error('Dashboard definition keys must be unique and nonempty');
            }
            keys.add(key);
            const title=text(value.title??value.label??value.name??key,key);
            const description=text(value.description??value.info??'','',true);
            const suppliedChartOptions=record(
                value.chartOptions,
                'Dashboard chart options'
            );
            const chartOptions=normalizeChartOptions({
                ...value,
                ...suppliedChartOptions,
                key,
                title,
                info:own(suppliedChartOptions,'info')
                    ?suppliedChartOptions.info
                    :description
            });
            return {
                ...value,
                key,
                title,
                description,
                defaultVisible:value.defaultVisible!==false,
                disabled:value.disabled===true,
                group:text(value.group,'',true),
                chartOptions
            };
        }
    );
}

const DASHBOARD_LABELS=Object.freeze({
    description:'Choose which charts appear on your dashboard.',
    empty:'No dashboard items are available.',
    heading:'Configure Dashboard',
    trigger:'Configure Dashboard'
});

function normalizeDashboardVisibility(values={}){
    values=record(values,'Dashboard visibility');
    const visibility={};
    for(const [key,value] of Object.entries(values)){
        if(typeof value==='boolean'){
            visibility[key]=value;
        }
    }
    return visibility;
}

function normalizeDashboardOptions(input={},previous={}){
    input=record(input,'Dashboard configuration');
    previous=record(previous,'Previous dashboard configuration');
    const previousLabels=stringRecord(
        previous.labels,
        DASHBOARD_LABELS,
        'Previous dashboard labels'
    );
    const labels=stringRecord(input.labels,previousLabels,'Dashboard labels');
    const aliases={
        description:'description',
        emptyLabel:'empty',
        heading:'heading',
        triggerLabel:'trigger'
    };
    for(const [source,target] of Object.entries(aliases)){
        if(typeof input[source]==='string'){
            labels[target]=input[source];
        }
    }
    return {
        labels,
        definitions:own(input,'definitions')
            ?normalizeDashboardDefinitions(input.definitions)
            :Array.isArray(previous.definitions)
                ?normalizeDashboardDefinitions(previous.definitions)
                :[],
        visibility:own(input,'visibility')
            ?normalizeDashboardVisibility(input.visibility)
            :normalizeDashboardVisibility(previous.visibility)
    };
}

function effectiveDashboardVisibility(definitions=[],visibility={}){
    definitions=normalizeDashboardDefinitions(definitions);
    visibility=normalizeDashboardVisibility(visibility);
    return Object.fromEntries(
        definitions.map(
            definition=>[
                definition.key,
                typeof visibility[definition.key]==='boolean'
                    ?visibility[definition.key]
                    :definition.defaultVisible
            ]
        )
    );
}

const VOICE_LABELS=Object.freeze({
    complete:'Complete Transcription',
    description:'Record one or more segments. Each segment is transcribed after you press Stop.',
    empty:'Your transcription will appear here after you stop recording.',
    start:'Start',
    stop:'Stop',
    transcription:'Voice transcription'
});

const VOICE_MESSAGES=Object.freeze({
    complete:'Complete.',
    completeError:'Unable to complete this transcription.',
    completing:'Completing transcription...',
    emptyAudio:'No audio was captured. Try recording again.',
    interrupted:'Recording was interrupted. Your completed transcription is still available.',
    noSpeech:'No speech was transcribed. You can try another segment.',
    ready:'Ready.',
    recording:'Recording...',
    recordingEnded:'Recording ended. Transcribing captured audio...',
    requesting:'Requesting microphone access...',
    saved:'Transcription saved. Record another segment or complete.',
    saveError:'Transcribed, but unable to save.',
    saving:'Saving transcription...',
    startError:'Unable to start recording. Check microphone permission and try again.',
    transcribed:'Transcription added. Record another segment or complete.',
    transcribeError:'Unable to transcribe this recording.',
    transcribing:'Transcribing this segment...',
    unsupported:'Audio recording is not supported by this browser.'
});

function normalizeVoiceOptions(input={},previous={}){
    input=record(input,'Voice transcription options');
    previous=record(previous,'Previous voice transcription options');
    const previousLabels=stringRecord(
        previous.labels,
        VOICE_LABELS,
        'Previous voice labels'
    );
    const labels=stringRecord(input.labels,previousLabels,'Voice labels');
    const aliases={
        completeLabel:'complete',
        description:'description',
        emptyLabel:'empty',
        startLabel:'start',
        stopLabel:'stop',
        transcriptionLabel:'transcription'
    };
    for(const [source,target] of Object.entries(aliases)){
        if(typeof input[source]==='string'){
            labels[target]=input[source];
        }
    }

    const constraints=option(input,previous,'mediaConstraints',{audio:true});
    if(!constraints||typeof constraints!=='object'||Array.isArray(constraints)){
        throw new TypeError('mediaConstraints must be an object');
    }
    if(!own(constraints,'audio')||constraints.audio===false){
        throw new TypeError('mediaConstraints.audio must request audio');
    }
    const mimeTypes=option(
        input,
        previous,
        'mimeTypes',
        ['audio/webm;codecs=opus','audio/mp4','audio/webm']
    );
    if(!Array.isArray(mimeTypes)){
        throw new TypeError('mimeTypes must be an array');
    }
    if(mimeTypes.some(value=>typeof value!=='string')){
        throw new TypeError('mimeTypes must contain only strings');
    }
    const separator=option(input,previous,'separator','\n\n');
    if(typeof separator!=='string'){
        throw new TypeError('separator must be a string');
    }

    return {
        labels,
        messages:stringRecord(
            input.messages,
            stringRecord(
                previous.messages,
                VOICE_MESSAGES,
                'Previous voice messages'
            ),
            'Voice messages'
        ),
        mediaConstraints:{...constraints},
        mimeTypes:[...new Set(mimeTypes.map(value=>value.trim()).filter(Boolean))],
        persist:option(input,previous,'persist',true)!==false,
        transcribe:optionalCallback(input,previous,['transcribe']),
        onSave:optionalCallback(input,previous,['onSave','save'],'onSave'),
        onComplete:optionalCallback(input,previous,['onComplete','complete'],'onComplete'),
        separator,
        initialValue:text(option(input,previous,'initialValue',''),'',true)
    };
}

function appendTranscription(current='',segment='',separator='\n\n'){
    current=text(current,'',true).trim();
    segment=text(segment,'',true).trim();
    if(!segment){
        return current;
    }
    return current?`${current}${separator}${segment}`:segment;
}

const MARKDOWN_FORMATS=Object.freeze([
    Object.freeze({id:'heading',label:'Heading',title:'Heading',prefix:'## ',placeholder:'Heading'}),
    Object.freeze({id:'bold',label:'B',title:'Bold',before:'**',after:'**',placeholder:'bold text'}),
    Object.freeze({id:'italic',label:'I',title:'Italic',before:'_',after:'_',placeholder:'italic text'}),
    Object.freeze({id:'strike',label:'S',title:'Strikethrough',before:'~~',after:'~~',placeholder:'strikethrough text'}),
    Object.freeze({id:'code',label:'Code',title:'Inline code',before:'`',after:'`',placeholder:'code'}),
    Object.freeze({id:'link',label:'Link',title:'Link',before:'[',after:'](https://)',placeholder:'link text'}),
    Object.freeze({id:'quote',label:'Quote',title:'Quote',prefix:'> ',placeholder:'Quote'}),
    Object.freeze({id:'list',label:'List',title:'Bulleted list',prefix:'- ',placeholder:'List item'})
]);

const MARKDOWN_LABELS=Object.freeze({
    bodyPlaceholder:'Write in Markdown...',
    emptyError:'Write content before saving.',
    preview:'Markdown preview',
    save:'Save',
    saveError:'Unable to save.',
    saved:'Saved.',
    saving:'Saving...',
    titlePlaceholder:'Title (optional)',
    toolbar:'Markdown formatting',
    unavailable:'Saving is unavailable.'
});

function normalizeMarkdownFormats(values=MARKDOWN_FORMATS){
    if(!Array.isArray(values)){
        throw new TypeError('Markdown formats must be an array');
    }
    const ids=new Set();
    return values.map(
        (value,index)=>{
            value=record(value,`Markdown format ${index}`);
            const id=string(value.id,'');
            if(!/^[a-z][a-z0-9-]{0,31}$/.test(id)||ids.has(id)){
                throw new Error('Markdown format ids must be unique lowercase identifiers');
            }
            ids.add(id);
            const prefix=text(value.prefix,'',true);
            const before=text(value.before,'',true);
            const after=text(value.after,'',true);
            if(!prefix&&!before&&!after){
                throw new Error(`Markdown format ${id} must define a prefix or wrapper`);
            }
            return {
                id,
                label:text(value.label??id,id),
                title:text(value.title??value.label??id,id),
                prefix,
                before,
                after,
                placeholder:text(value.placeholder??value.label??id,id)
            };
        }
    );
}

function normalizeMarkdownOptions(input={},previous={}){
    input=record(input,'Markdown editor options');
    previous=record(previous,'Previous markdown editor options');
    const previousLabels=stringRecord(
        previous.labels,
        MARKDOWN_LABELS,
        'Previous markdown labels'
    );
    const labels=stringRecord(input.labels,previousLabels,'Markdown labels');
    const aliases={
        bodyPlaceholder:'bodyPlaceholder',
        previewLabel:'preview',
        saveLabel:'save',
        titlePlaceholder:'titlePlaceholder',
        toolbarLabel:'toolbar'
    };
    for(const [source,target] of Object.entries(aliases)){
        if(typeof input[source]==='string'){
            labels[target]=input[source];
        }
    }

    return {
        labels,
        formats:normalizeMarkdownFormats(option(input,previous,'formats',MARKDOWN_FORMATS)),
        showTitle:option(input,previous,'showTitle',true)!==false,
        showPreview:option(input,previous,'showPreview',true)!==false,
        showToolbar:option(input,previous,'showToolbar',true)!==false,
        showSave:option(input,previous,'showSave',true)!==false,
        readOnly:option(input,previous,'readOnly',false)===true,
        clearOnSave:option(input,previous,'clearOnSave',true)!==false,
        onSave:optionalCallback(input,previous,['onSave','save'],'onSave'),
        onChange:optionalCallback(input,previous,['onChange']),
        initialValue:text(option(input,previous,'initialValue',''),'',true),
        initialTitle:text(option(input,previous,'initialTitle',''),'',true)
    };
}

function applyMarkdownFormat(value='',selectionStart=0,selectionEnd=selectionStart,format={}){
    value=text(value,'',true);
    format=normalizeMarkdownFormats([format])[0];
    const rawStart=Number(selectionStart);
    const rawEnd=Number(selectionEnd);
    const start=Math.max(
        0,
        Math.min(value.length,Number.isFinite(rawStart)?rawStart:0)
    );
    const end=Math.max(
        start,
        Math.min(value.length,Number.isFinite(rawEnd)?rawEnd:start)
    );
    const selected=value.slice(start,end);
    const content=selected||format.placeholder;
    let replacement='';
    let nextStart=start;
    let nextEnd=start;

    if(format.prefix){
        replacement=content.split(/\r?\n/).map(line=>format.prefix+line).join('\n');
        nextStart=start+format.prefix.length;
        nextEnd=start+replacement.length;
    }else{
        replacement=format.before+content+format.after;
        nextStart=start+format.before.length;
        nextEnd=nextStart+content.length;
    }

    return {
        value:value.slice(0,start)+replacement+value.slice(end),
        selectionStart:nextStart,
        selectionEnd:nextEnd
    };
}

export {
    CHART_LABELS,
    DASHBOARD_LABELS,
    MARKDOWN_FORMATS,
    MARKDOWN_LABELS,
    VOICE_LABELS,
    VOICE_MESSAGES,
    appendTranscription,
    applyMarkdownFormat,
    effectiveDashboardVisibility,
    normalizeChartOptions,
    normalizeChartRows,
    normalizeDashboardDefinitions,
    normalizeDashboardOptions,
    normalizeDashboardVisibility,
    normalizeMarkdownFormats,
    normalizeMarkdownOptions,
    normalizeVoiceOptions
};
