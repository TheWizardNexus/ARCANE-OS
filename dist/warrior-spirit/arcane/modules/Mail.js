import {
    DEFAULT_MAIL_REQUEST_TIMEOUT_MS,
    sendMailReport,
} from './MailTransport.mjs';

let userInstance=null;

async function loadOptionalMailDependencies(){
    await import('./DBOPFS.js');
    if(!userInstance){
        const { default:UserEntity }=await import('../entities/User.js');
        userInstance=new UserEntity();
    }
    return {
        dbopfs:globalThis.dbopfs,
        user:userInstance,
    };
}

const MAX_SUBJECT_LENGTH=160;
const MAX_MESSAGE_BYTES=25*1024*1024;
const MAIL_TYPES=new Set(['error','report','crisis_detected']);
const EMAIL_PATTERN=/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const ARCANE_APP_ID_PATTERN=/^[a-z0-9](?:[a-z0-9-]{0,62})$/;

function declaredApplicationId(document=globalThis.document){
    const value=document?.querySelector?.('meta[name="arcane-app-id"]')?.content?.trim();
    return ARCANE_APP_ID_PATTERN.test(value||'') ? value:'';
}

function defaultMailEndpoint(location=globalThis.location){
    if(!location||!['http:','https:'].includes(location.protocol)){
        return '';
    }
    const hostname=String(location.hostname||'').toLowerCase();
    const loopback=['localhost','127.0.0.1','::1','[::1]'].includes(hostname);
    if(loopback&&location.protocol==='http:'&&String(location.port||'')!=='8025'){
        const authority=hostname==='::1' ? '[::1]':hostname;
        return `http://${authority}:8025/v1/mail`;
    }
    return new URL('/v1/mail',location.origin).href;
}

export function resolveMailConfig(
    config=globalThis.arcane?.config?.mail||{},
    {document=globalThis.document,location=globalThis.location}={}
){
    const supplied=config&&typeof config==='object'&&!Array.isArray(config)?config:{};
    const appName=typeof supplied.appName==='string'&&supplied.appName.trim()
        ? supplied.appName.trim()
        : declaredApplicationId(document);
    return Object.freeze({
        appName:ARCANE_APP_ID_PATTERN.test(appName) ? appName:'',
        appKey:typeof supplied.appKey==='string' ? supplied.appKey:'',
        endpoint:typeof supplied.endpoint==='string'&&supplied.endpoint.trim()
            ? supplied.endpoint.trim()
            : defaultMailEndpoint(location),
        requestTimeout:Number.isFinite(supplied.requestTimeout)
            ? supplied.requestTimeout
            : DEFAULT_MAIL_REQUEST_TIMEOUT_MS,
    });
}

function escapeHtml(value){
    return String(value)
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;')
        .replaceAll("'",'&#39;');
}

function utf8ByteLength(value){
    return new TextEncoder().encode(value).byteLength;
}

function clonePayload(value){
    if(typeof globalThis.structuredClone==='function'){
        return globalThis.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

function serializePayload(value){
    try{
        return JSON.stringify(value,null,2);
    }catch{
        return '[The structured payload could not be serialized.]';
    }
}

function assertMessageSize(report){
    const messageBytes=['text','html'].reduce(
        (total,key)=>total+utf8ByteLength(report[key]||''),
        0
    );
    if(messageBytes>MAX_MESSAGE_BYTES){
        throw new Error('Generated report email content exceeds the 25 MiB limit');
    }
}

function createReportKey(subject){
    const safeSubject=subject
        .normalize('NFKD')
        .replace(/[^a-z0-9_-]+/gi,'_')
        .replace(/^_+|_+$/g,'')
        .slice(0,48)||'notification';
    let nonce;
    if(typeof globalThis.crypto?.randomUUID==='function'){
        nonce=globalThis.crypto.randomUUID();
    }else if(typeof globalThis.crypto?.getRandomValues==='function'){
        const bytes=globalThis.crypto.getRandomValues(new Uint8Array(16));
        nonce=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');
    }else{
        nonce=Math.random().toString(36).slice(2).padEnd(16,'0').slice(0,16);
    }
    return `${Date.now()}-${nonce}-email-${safeSubject}.json`;
}

function normalizeRecipients(values){
    if(!Array.isArray(values)){
        throw new TypeError('Mail recipients must be an array');
    }
    if(values.length>50){
        throw new TypeError('Mail supports no more than 50 recipients');
    }

    const recipients=[];
    for(const value of values){
        if(!value){
            continue;
        }

        if(typeof value!=='string'){
            throw new TypeError('Every mail recipient must be an email address');
        }

        const address=value.trim().toLowerCase();
        if(address.length>254||!EMAIL_PATTERN.test(address)){
            throw new TypeError('Mail contains an invalid recipient address');
        }

        if(!recipients.includes(address)){
            recipients.push(address);
        }
    }

    return recipients;
}

class Mail {
    constructor(config=globalThis.arcane?.config?.mail||{}) {
        if(globalThis.window?.mail){
            return globalThis.window.mail;
        }

        const resolved=resolveMailConfig(config);
        this.appName=resolved.appName;
        this.appKey=resolved.appKey;
        this.endpoint=resolved.endpoint;
        this.requestTimeout=resolved.requestTimeout;
    }

    #assertConfigured(){
        if(!this.endpoint||!this.appName){
            throw new Error('Mail transport is not configured');
        }
    }

    async send(to=[], subject='', payload={}, messageStyle='', messageType='') {
        const normalizedSubject=typeof subject==='string' ? subject.trim():'';
        if(!normalizedSubject||normalizedSubject.length>MAX_SUBJECT_LENGTH||/[\u0000-\u001f\u007f]/.test(normalizedSubject)){
            throw new TypeError(`Mail subject must contain 1-${MAX_SUBJECT_LENGTH} characters without line breaks`);
        }
        if(!payload||typeof payload!=='object'||Array.isArray(payload)){
            throw new TypeError('Mail payload must be an object');
        }
        if(typeof messageStyle!=='string'){
            throw new TypeError('Mail message style must be a string');
        }
        if(!Array.isArray(to)){
            throw new TypeError('Mail recipients must be an array');
        }
        if(typeof messageType!=='string'||!MAIL_TYPES.has(messageType)){
            throw new TypeError('Mail type must be error, report, or crisis_detected');
        }

        this.#assertConfigured();

        const recipients=normalizeRecipients(to);
        if(messageType!=='error'&&recipients.length===0){
            throw new TypeError('Report and crisis mail require at least one recipient');
        }

        const reportKey=createReportKey(normalizedSubject);
        const reportPayload={
            ...clonePayload(payload),
            source_at:new Date().toISOString(),
            source_path:globalThis.location?.pathname||'',
            subject:normalizedSubject,
            type:messageType,
        };

        if(messageType==='error'){
            reportPayload.report={
                subject:normalizedSubject,
                text:`${this.appName} application error\n\n${serializePayload(reportPayload)}`,
                to:recipients,
                type:messageType,
            };
            assertMessageSize(reportPayload.report);

            const delivery=await sendMailReport({
                appKey:this.appKey,
                appName:this.appName,
                endpoint:this.endpoint,
                report:reportPayload.report,
                reportKey,
                requestTimeout:this.requestTimeout,
            });
            return { ...delivery,reportKey };
        }

        let reportStorage=null;
        let profile={ email:'',language:'',phone:'',username:'' };
        try{
            const dependencies=await loadOptionalMailDependencies();
            reportStorage=dependencies.dbopfs;
            try{
                await dependencies.user.load();
            }catch(error){
                console.warn('Unable to load the user profile for mail; continuing with available values.',error);
            }
            profile={
                email:dependencies.user.email,
                language:dependencies.user.language,
                phone:dependencies.user.phone,
                username:dependencies.user.username,
            };
        }catch(error){
            console.warn('Optional mail formatting dependencies are unavailable; using a deterministic fallback.',error);
        }

        const wantsHtml=/\bhtml\b/i.test(messageStyle);
        Object.assign(reportPayload,{
            email:profile.email,
            language:profile.language,
            phone:profile.phone,
            source_user:profile.username || 'username not specified',
        });

        // Email formatting stays local and deterministic. The supplied style
        // is presentation intent only; it is never sent to an AI provider and
        // untrusted report values are escaped before entering HTML.
        const serialized=serializePayload(reportPayload);
        const generatedMessage=wantsHtml
            ? `<pre>${escapeHtml(serialized)}</pre>`
            : serialized;

        const sourceUser=String(reportPayload.source_user)
            .replace(/[\u0000-\u001f\u007f]/g,' ')
            .trim()
            .slice(0,80);
        const subjectSuffix=sourceUser ? ` - ${sourceUser}`:'';
        const deliverySubject=normalizedSubject.length+subjectSuffix.length<=MAX_SUBJECT_LENGTH
            ? `${normalizedSubject}${subjectSuffix}`
            : normalizedSubject;

        reportPayload.report = {
            subject:deliverySubject,
            to:recipients,
            type:messageType,
        };
        if(wantsHtml){
            reportPayload.report.html=`${generatedMessage}
<hr>
<p>Phone: ${escapeHtml(profile.phone || 'not provided')}<br>Email: ${escapeHtml(profile.email || 'not provided')}</p>`;
        }else{
            reportPayload.report.text=`${generatedMessage}

Phone: ${profile.phone || 'not provided'}
Email: ${profile.email || 'not provided'}`;
        }

        assertMessageSize(reportPayload.report);

        try{
            if(!reportStorage?.set){
                throw new Error('Report storage is unavailable');
            }
            await reportStorage.set('reports',reportKey,reportPayload);
        }catch(error){
            console.warn('Unable to store the generated mail report; continuing with delivery.',error);
        }

        const delivery=await sendMailReport({
            appKey:this.appKey,
            appName:this.appName,
            endpoint:this.endpoint,
            report:reportPayload.report,
            reportKey,
            requestTimeout:this.requestTimeout,
        });
        
        return {
            ...delivery,
            reportKey,
        };
    }
}

if(globalThis.window&&!globalThis.window.mail){
    globalThis.window.mail=new Mail();
}

export default Mail;
