import './DBOPFS.js';
import UserEntity from '../entities/User.js';

let credentials='include';
credentials='omit';

class AI {
    // This is the enum section for inference configuration
    #service = {
        baseURL: {
            OLLAMA: 'http://127.0.0.1:11434/v1',
            OPENAI: 'https://api.openai.com/v1'
        },
        sttURL: {
            LOCAL_SPEACH: 'http://127.0.0.1:8011/v1',
            OPENAI:       'https://api.openai.com/v1'
        },
        ttsURL: {
            LOCAL_SPEACH: 'http://127.0.0.1:8011/v1',
            OPENAI:       'https://api.openai.com/v1'
        },
    }

    #paths = {
        chat: {
            OLLAMA: '/chat/completions',
            OPENAI: '/chat/completions'
        },
        stt: {
            LOCAL_SPEACH: '/audio/transcriptions',
            OPENAI:       '/audio/transcriptions'
        },
        tts: {
            LOCAL_SPEACH: '/audio/speech',
            OPENAI:       '/audio/speech'
        }
    }

    #models = {
        PRECRISIS_120: 'PRECRISIS:120b',
        PRECRISIS_20:  'PRECRISIS:20b',
        PRECRISIS:     'PRECRISIS:120b',
        BOSS_26:       'BOSS-LIBRARIAN:26b',
        BOSS_120:      'BOSS-LIBRARIAN:120b',
        OPENAI:        'gpt-4o'
    }

    #sttModels = {
        OPENAI:       'whisper-1',
        LOCAL_SPEACH: 'whisper-small'
    }

    #ttsModels = {
        OPENAI:       'gpt-4o-mini-tts',
        LOCAL_SPEACH: 'kokoro'
    }

    get #serviceHeaders(){
        return {
            OPENAI: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.license}`
            },
            OLLAMA: {
                'Content-Type': 'application/json',
            }
        };
    }

    // A separate header config is required for speech-to-text services due to OpenAI
    get #sttHeaders(){
        return {
            OPENAI: {
                'Authorization': `Bearer ${this.license}`,
            },
            OLLAMA: {
                'Authorization': `Bearer ${this.license}`,
            }
        };
    }

    ready=false;
    muted=false;
    

    llmService = '';
    sttService = '';
    ttsService = '';

    model    = '';
    modelTTS = '';
    modelSTT = '';

    audioFormat = 'opus';
    audioType   = 'audio/ogg; codecs=opus';

    //audioFormat = 'wav';
    //audioType = 'audio/wav; codecs=1';

    constructor(
        llmService='',
        sttService='',
        ttsService='',
        model='',
        modelTTS='',
        modelSTT=''
    ) {
        if(window.ai){
            return window.ai;
        }

        this.setAI(
            llmService,
            sttService,
            ttsService,
            model,
            modelTTS,
            modelSTT
        );
    }

    get url() {
        return `${this.#service.baseURL[this.llmService]}${this.#paths.chat[this.llmService]}`
    }

    set url(value) {
        return false;
    }

    get urlTTS() {
        return `${this.#service.ttsURL[this.ttsService]}${this.#paths.tts[this.ttsService]}`
    }

    set urlTTS(value) {
        return false;
    }

    get urlSTT() {
        return `${this.#service.sttURL[this.sttService]}${this.#paths.stt[this.sttService]}`
    }

    set urlSTT(value) {
        return false;
    }

    #license='';

    // Browser-delivered framework code must not contain provider credentials.
    // The selected host, application, or user profile supplies one at runtime.
    get license(){
        return this.#license || globalThis.arcane?.config?.openAI?.apiKey || '';
    }
    
    set license(value){
        this.#license=typeof value==='string' ? value.trim():'';
        return this.#license;
    }

    get configured(){
        return ['OPENAI','OLLAMA'].includes(this.llmService)
            &&(this.llmService!=='OPENAI'||Boolean(this.license));
    }

    #assertServiceConfigured(service=this.llmService){
        if(service&&service!=='OPENAI'){
            return true;
        }

        if(service==='OPENAI'&&this.license){
            return true;
        }

        const error=new Error('AI provider is not configured.');
        error.code='AI_PROVIDER_NOT_CONFIGURED';
        throw error;
    }

    audioMessageChunks='';
    sourceNodes=[];
    isSpeaking=false;
    
    get headers(){
        return {
            'Content-Type': 'application/json'
        };
    }

    // TODO: Make robust enough to handle various provider header requirements
    get exHeaders() {
        // 'OLLAMA' is enum (NOTE!!)
        if (this.llmService === 'OLLAMA') {
            return {
                'Content-Type': 'application/json',
            };
        } else {
            return {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.license}`
            };
        }
    }


    // Set models to be used by the AI. 
    // Note: Only those that are defined are set.
    setAI(
        llmService,
        sttService,
        ttsService,
        model,
        modelTTS,
        modelSTT
    ) {
        if (
            !(
                llmService ||
                sttService ||
                ttsService ||
                model ||
                modelTTS ||
                modelSTT
            )
        ) {
            return false;
        }

        this.llmService=llmService;
        this.sttService=sttService;
        this.ttsService=ttsService;
        this.model=this.#models[model];
        this.modelTTS=this.#ttsModels[modelTTS];
        this.modelTTS=this.#ttsModels[modelTTS];
        this.modelSTT=this.#sttModels[modelSTT];

        return true;
    }

    async #assertResponseOK(response){
        if(response.ok){
            return response;
        }

        let detail='';

        try{
            const contentType=response.headers.get('content-type')||'';

            if(contentType.includes('application/json')){
                const errorResponse=await response.json();
                detail=errorResponse?.error?.message
                    || errorResponse?.message
                    || '';
            }else{
                const errorText=await response.text();

                if(errorText&&!errorText.trim().startsWith('<')){
                    detail=errorText.trim().slice(0,500);
                }
            }
        }catch{
            // The response status is enough when its body cannot be read.
        }

        const status=[response.status,response.statusText]
            .filter(Boolean)
            .join(' ');
        const message=`AI request failed${status ? ` (${status})`:''}`;
        const error=new Error(message);
        error.code='AI_REQUEST_FAILED';
        error.status=response.status;
        error.providerMessage=detail;
        throw error;
    }


    async streamMessage(
        messages=[],
        streamHandler=(text,id,isThinking)=>{},
        streamComplete=()=>{/*handle stream done*/},
        tools=[],
        tool_choice='auto',
        earlyFunctionTrigger=(functionName='')=>{},
        parallel_tool_calls=true,
        id=Date.now(),
        seeThinking=false
    ){
        this.#assertServiceConfigured(this.llmService);

        const request={
            model:this.model,
            messages:messages, 
            stream:true
        }

        if(tools.length){
            request.tools=tools;
            request.tool_choice=tool_choice;
            request.parallel_tool_calls=parallel_tool_calls;
        }

        const body = JSON.stringify(request);

        let isThinking=true;
        let isWaiting=true;

        streamHandler('Thinking...',`M-${id}`,isThinking);

        let response;

        try{
            response=await fetch(
                this.url,
                {
                    method:'POST',
                    credentials,
                    headers:this.#serviceHeaders[this.llmService],
                    body
                }
            );
        }catch(err){
            const error=new Error(
                'Unable to reach the AI service.',
                {cause:err}
            );
            error.code='AI_SERVICE_UNREACHABLE';
            throw error;
        }

        await this.#assertResponseOK(response);

        let chunkString='';
        let chunkCache='';
        let tool_funcs={};
        let current_func='';
        const decoder = new TextDecoder('utf-8');
        //alert(1)
        const reader=response.body?.getReader?.();

        if(!reader){
            throw new TypeError('Streaming response body is not readable');
        }

        try{
            while(true){
                const {done,value:chunk}=await reader.read();

                if(done){
                    break;
                }

                //alert(2)    //const data=String.fromCharCode.apply(null, chunk).trim().replaceAll('data: ','');
                const data = decoder.decode(chunk, { stream: true})?.trim()?.replaceAll('data: ','');
                const lines=data.split('\n\n');
                //alert(3)
                //console.log(lines);

                lines.forEach(
                    function parsingAIGeneratedStream(delta,i){
                        chunkCache+=delta;

                        if (chunkCache.trim() === '[DONE]') {
                            chunkCache = '';
                            return;
                        }

                        try{
                            const resp=JSON.parse(chunkCache)||{};
                            //console.log(JSON.stringify(resp));
                            //console.log(resp)
                            const choice = resp.choices?.[0] || {};
                            const delta = choice.delta || {};
                            const content = delta.content || '';
                            const tool_calls=delta.tool_calls || [];
                            let value = content;

                            let reasoning = '';

                            if(seeThinking){
                                reasoning=delta.reasoning || '';
                            }

                            if (reasoning) {
                                isThinking = true;
                                value = reasoning;
                            }

                            if (!reasoning && isThinking) {
                                //remove thinking chunks
                                chunkString='';
                            }

                            if (!reasoning) {
                                isThinking = false;
                            }

                            chunkCache='';

                            if(value==='' && !tool_calls.length){
                                return;
                            }

                            if(value){
                                streamHandler(value,`M-${id}`, isThinking);
                                chunkString+=value;
                            }else{
                                if(resp.done_reason){
                                    return;
                                }
                                //console.log(JSON.stringify(tool_calls))
                                for(let i=0;i<tool_calls.length;i++){
                                    const tool_func=tool_calls[i]?.function;
                                    if(tool_func?.name){
                                        current_func=tool_func.name;
                                        Promise.resolve(
                                            earlyFunctionTrigger(current_func)
                                        ).catch(
                                            error=>console.error('Early tool trigger failed:',error)
                                        );
                                    }
                                    
                                    tool_funcs[current_func]?
                                        null
                                        : tool_funcs[current_func]='';

                                    tool_funcs[current_func]+=tool_func?.arguments||'';

                                }
                                
                                //console.log(JSON.stringify(tool_funcs));
                            }
                        } catch(err) {
                            console.warn(err);
                        }
                    }
                );
            }
        }finally{
            reader.releaseLock();
        }

        //console.log(tool_funcs,current_func);
        //async
        await streamComplete(chunkString||tool_funcs, `M-${id}`,isThinking);

        //sync
        return chunkString||tool_funcs;
    }

    async fetch(
        messages=[],
        responseHandler=(text,id)=>{},
        json=false,
        tools=[],
        tool_choice='auto',
        parallel_tool_calls=true,
        id=Date.now(),
    ){
        this.#assertServiceConfigured(this.llmService);

        const request={
            model:this.model,
            messages:messages, 
            stream:false
        }

        if(json){
            request.response_format={ type: "json_object" };
        }

        if(tools.length){
            request.tools=tools;
            request.tool_choice=tool_choice;
            request.parallel_tool_calls=parallel_tool_calls;
        }

        const body = JSON.stringify(request);
        
        let response;
                
        try{
            response = await fetch(
                this.url, 
                {
                    method: 'POST',
                    credentials: credentials,
                    headers: this.#serviceHeaders[this.llmService],
                    body: body
                }
            );
        }catch(err){
            const error=new Error(
                'Unable to reach the AI service.',
                {cause:err}
            );
            error.code='AI_SERVICE_UNREACHABLE';
            throw error;
        }

        await this.#assertResponseOK(response);

        const contentType=response.headers.get('content-type')||'';

        if(!contentType.includes('application/json')){
            throw new TypeError(
                `AI request returned ${contentType||'an unknown content type'} instead of JSON.`
            );
        }

        const responseJSON=await response.json();

        if(!response.id){
            response.id=id;
        }

        //console.log(responseJSON);
        //async
        await responseHandler(responseJSON,id,false);
        //sync
        return responseJSON;
    }

    async streamTTS(
        text = '', 
        end=false
    ){
        if(ai.muted){
            console.info('muted');
            return
        }

        this.audioMessageChunks += text;

        if (!end && !/[.!?。！？]/.test(this.audioMessageChunks) && this.audioMessageChunks.length < 160) {
            return;
        }

        //console.log(this.audioMessageChunks);

        let outputs = this.audioMessageChunks.split(/(?<=[.!?。！？])/);
        const output = outputs.splice(0, 1)[0];
        this.audioMessageChunks = outputs.join('');

        //console.log(this.audioMessageChunks);

        if (output.length < 1) {
            return;
        }

        //console.log(output);

        try {
            this.#assertServiceConfigured(this.ttsService);
            const audioChunks = [];
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const sourceNode = audioContext.createBufferSource();
            this.sourceNodes.push(sourceNode);
            sourceNode.index = this.sourceNodes.length - 1;
            sourceNode.onended = this.nextSentance;

            const request={
                model: this.modelTTS,
                voice: window.user.AI_voice,
                input: output,
/*
                response_format: 'aac',
*/
                instructions: (await window.user.personality || 'A behavioral health technician with a slight veteran feel on occasion.')
                +(' and sounding a bit '+await window.user.religion || 'caring') || '',
                response_format: this.audioFormat,
            };

            const body = JSON.stringify(request);

            const response = await fetch(
                this.urlTTS, 
                {
                    method: 'POST',
                    credentials: credentials,
                    headers: this.#serviceHeaders[this.ttsService],
                    body: body
                }
            );

            const audioStream = response.body;
            const reader = audioStream.getReader();
            
            async function processAudio() {
                let { done, value } = await reader.read();
                if (done) {
                    ai.playAudio(audioChunks, audioContext, sourceNode);
                    return;
                }

                if (value) {
                    audioChunks.push(value);
                }

                processAudio();
            }

            processAudio();
        } catch (error) {
            console.warn('Error fetching audio from AI:', error);
        }

        return true;
    }

    async fetchSTT(
        audioFile,
        responseHandler=(text='')=>{}
    ){
        this.#assertServiceConfigured(this.sttService);

        const formData = new FormData();
        formData.append('file', audioFile);
        formData.append('model', this.modelSTT);
        formData.append('response_format', 'text');

        const headers=Object.assign({},this.headers);
        delete headers['Content-Type']

        const response = await fetch(
            this.urlSTT, 
            {
                method: 'POST',
                credentials: credentials,
                headers: this.#sttHeaders[this.sttService],
                body: formData
            }
        );

        if(!response.ok){
            throw new Error(`Speech transcription failed with status ${response.status}.`);
        }

        const text = await response.text();
        
        //async
        await responseHandler(text);

        //sync
        return text;
    }

    async stopAudio(){
        this.sourceNodes.splice(1);
        try{
            //console.log('stopping')
            this.sourceNodes[0]?.stop();
        }catch(err){
            console.warn(err);
        }
        this.sourceNodes.splice(0);
        this.isSpeaking = false;
    }

    async playAudio(audioChunks=[], audioContext, sourceNode) {
        if(ai.muted){
            console.info('muted');
            this.stopAudio();
            return
        }

        try {
            audioContext.onstatechange = (e) => { console.log(this, e) };
            
            const audioBlob = new Blob(audioChunks, { type: this.audioType });
            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            
            sourceNode.buffer = audioBuffer;
            sourceNode.connect(audioContext.destination);

            if (!ai.isSpeaking) {
                ai.isSpeaking = true;
                this.sourceNodes[0].start(0);
            }
        } catch (error) {
            console.warn('Error decoding audio data:', error);
            this.nextSentance();
        }
    }

    async nextSentance() {
        //console.log(ai.sourceNodes, ai.sourceNodes[0].index, ai.isSpeaking, ai.sourceNodes[0].context.state);
        ai.isSpeaking = false;
        ai.sourceNodes.splice(0, 1);
        if (ai.sourceNodes.length < 1) {
            return;
        }

        //console.log(ai.sourceNodes, ai.sourceNodes[0].index, ai.isSpeaking);
        try {
            ai.sourceNodes[0].start(0);
            ai.isSpeaking = true;
        } catch (err) {
            console.warn('Error playing audio data:', err);
            ai.isSpeaking = false;
            ai.nextSentance();
        }
    }
}

window.addEventListener(
    'user-entity-loaded',
    instantiateAI
);

if(window.user?.ready){
    instantiateAI();
}

function instantiateAI() {
    if(!window.ai){
        window.ai=new AI(
            window.user.preferredModels[0], 
            window.user.preferredModels[1], 
            window.user.preferredModels[2], 
            window.user.preferredModels[3],
            window.user.preferredModels[4],
            window.user.preferredModels[5]
        );

        window.ai.ready=true;

        const aiReady=new CustomEvent(
            'ai-ready', {
                detail: { db: window.ai }
            }
        );

        window.dispatchEvent(aiReady);

    }
}

export default AI;
