import waitForComponent from './WaitForComponent.js';

const DEFAULT_DELAY_MS=2_000;
const DEFAULT_MAX_REPORTS_PER_SESSION=10;
const DEFAULT_MAX_REPORTS_PER_WINDOW=3;
const DEFAULT_MAX_PENDING_INCIDENTS=25;
const DEFAULT_RATE_WINDOW_MS=60_000;
const LEDGER_STORAGE_KEY='arcane-global-errors-v1';
const MAX_DETAIL_LENGTH=8_000;
const HANDLER_MARKER=Symbol.for('arcane.global-errors.handler');
const DEVELOPER_MODAL_HREF=new URL('../components/modal.html?v=13',import.meta.url).href;

const MESSAGE_STYLE=[
    'Write a simple plain-text email showing the error and, when the available details support it, a possible solution.',
    'If loop_detected or error_storm_detected is true, put that warning first and clearly state that further notifications have been suppressed.',
    'Do not add facts that are not present in the report data.',
].join(' ');

function safeText(value,fallback=''){
    if(value===undefined||value===null){
        return fallback;
    }

    try{
        const text=typeof value==='string' ? value:String(value);
        return text.slice(0,MAX_DETAIL_LENGTH)||fallback;
    }catch{
        return fallback;
    }
}

function safeNumber(value){
    const number=Number(value);
    return Number.isFinite(number) ? number:null;
}

function safeIso(timestamp){
    try{
        return new Date(timestamp).toISOString();
    }catch{
        return new Date(0).toISOString();
    }
}

function resourceUrlFrom(event,target){
    const resource=event?.target;
    if(!resource||resource===target){
        return '';
    }

    return safeText(resource.currentSrc||resource.src||resource.href);
}

/**
 * Normalize a browser ErrorEvent or capture-phase resource error.
 *
 * @param {ErrorEvent|Event|Object} event
 * @param {Window|Object} target
 * @returns {Object}
 */
export function normalizeErrorEvent(event={},target=globalThis.window){
    const error=event?.error;
    const resourceUrl=resourceUrlFrom(event,target);
    const fallbackPath=safeText(target?.location?.pathname||target?.location?.href);

    return {
        type:'error',
        message:safeText(
            event?.message||error?.message,
            resourceUrl ? 'Resource failed to load':'Unknown global error'
        ),
        name:safeText(
            error?.name,
            resourceUrl ? 'ResourceLoadError':'Error'
        ),
        stack:safeText(error?.stack)||null,
        filename:safeText(event?.filename||resourceUrl||fallbackPath)||null,
        lineno:safeNumber(event?.lineno),
        colno:safeNumber(event?.colno),
    };
}

/**
 * Normalize an unhandled Promise rejection, including non-Error reasons.
 *
 * @param {PromiseRejectionEvent|Object} event
 * @param {Window|Object} target
 * @returns {Object}
 */
export function normalizeRejectionEvent(event={},target=globalThis.window){
    const reason=event?.reason;
    const reasonIsObject=reason!==null
        && (typeof reason==='object'||typeof reason==='function');

    return {
        type:'unhandledrejection',
        message:safeText(
            reasonIsObject ? reason?.message:reason,
            'Unhandled promise rejection'
        ),
        name:safeText(
            reasonIsObject ? reason?.name:'',
            'UnhandledRejection'
        ),
        stack:safeText(reasonIsObject ? reason?.stack:'')||null,
        filename:safeText(target?.location?.pathname||target?.location?.href)||null,
        lineno:null,
        colno:null,
    };
}

function normalizeFingerprintPart(value){
    return safeText(value)
        .trim()
        .replace(/\s+/g,' ')
        .slice(0,2_000);
}

function normalizeVolatileFingerprintPart(value){
    return normalizeFingerprintPart(value)
        .replace(/[?#][^\s)]+/g,'')
        .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,'<uuid>')
        .replace(/\b[0-9a-f]{16,}\b/gi,'<hex>')
        .replace(/\b\d+(?:\.\d+)?\b/g,'<number>');
}

function normalizeStackFingerprint(value,name,message){
    const stack=safeText(value).trim();
    if(!stack){
        return '';
    }

    const lines=stack.split(/\r?\n/);
    const firstLine=lines[0].trim();
    const errorName=safeText(name).trim();
    const errorMessage=safeText(message).trim();
    const hasMessageHeader=lines.length>1&&(
        firstLine===errorMessage
        || firstLine===`${errorName}: ${errorMessage}`
        || (errorName&&firstLine.startsWith(`${errorName}:`))
        || /^(?:Error|[A-Za-z_$][\w.$]*(?:Error|Exception)):(?:\s|$)/.test(firstLine)
    );
    const frames=hasMessageHeader ? lines.slice(1):lines;

    return normalizeFingerprintPart(frames.join('\n'))
        .replace(/[?#][^\s)]+/g,'')
        .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,'<uuid>')
        .replace(/\b[0-9a-f]{16,}\b/gi,'<hex>');
}

function hashText(value){
    let first=0x811c9dc5;
    let second=0x9e3779b9;

    for(let index=0;index<value.length;index++){
        const code=value.charCodeAt(index);
        first=Math.imul(first^code,0x01000193);
        second=Math.imul(second^code,0x85ebca6b);
    }

    return [first,second]
        .map(hash => (hash>>>0).toString(16).padStart(8,'0'))
        .join('');
}

/**
 * Build a stable call-site signature. When a precise source location is
 * available, the human-readable message is deliberately excluded so loops
 * with changing counters, names, or timestamps still produce one report.
 *
 * @param {Object} incident
 * @returns {string}
 */
export function fingerprintIncident(incident){
    const stackFingerprint=normalizeStackFingerprint(
        incident?.stack,
        incident?.name,
        incident?.message
    );
    const hasPreciseSource=(
        Number.isFinite(incident?.lineno)
        || Number.isFinite(incident?.colno)
        || Boolean(stackFingerprint)
    );
    const signature=[
        normalizeFingerprintPart(incident?.type),
        normalizeFingerprintPart(incident?.name),
        hasPreciseSource
            ? ''
            : normalizeVolatileFingerprintPart(incident?.message),
        normalizeFingerprintPart(incident?.filename).replace(/[?#].*$/,''),
        normalizeFingerprintPart(incident?.lineno),
        normalizeFingerprintPart(incident?.colno),
        stackFingerprint,
    ].join('|');

    return `error-${hashText(signature)}`;
}

function defaultStorage(target){
    try{
        return target?.sessionStorage||null;
    }catch{
        return null;
    }
}

async function sendWithWindowMail(target,...args){
    if(typeof target?.mail?.send!=='function'){
        await import('./Mail.js');
    }

    if(typeof target?.mail?.send!=='function'){
        throw new Error('Mail notification service is unavailable');
    }

    return target.mail.send(...args);
}

function defaultDeveloperModeStatus(target){
    try{
        if(target?.user?.ready!==true){
            return null;
        }

        return target.user.developer===true;
    }catch{
        return false;
    }
}

function appendDeveloperDetail(document,list,label,value){
    if(value===null||value===undefined||value===''){
        return;
    }

    const term=document.createElement('dt');
    const description=document.createElement('dd');

    term.textContent=label;
    term.style.fontWeight='bold';
    description.textContent=safeText(value);
    description.style.margin='0 0 0.75em';
    description.style.overflowWrap='anywhere';
    list.append(term,description);
}

function buildDeveloperIncidentContent(document,incident,fingerprint){
    const content=document.createElement('section');
    const heading=document.createElement('h2');
    const introduction=document.createElement('p');
    const details=document.createElement('dl');
    const source=[
        safeText(incident?.filename),
        Number.isFinite(incident?.lineno) ? incident.lineno:'',
        Number.isFinite(incident?.colno) ? incident.colno:'',
    ].filter(value => value!=='').join(':');

    content.className='developer-error-content';
    heading.textContent='Application Error';
    introduction.textContent='Developer mode captured this application error.';
    details.style.margin='1.5em 0';

    appendDeveloperDetail(document,details,'Type',incident?.type);
    appendDeveloperDetail(document,details,'Name',incident?.name);
    appendDeveloperDetail(document,details,'Message',incident?.message);
    appendDeveloperDetail(document,details,'Source',source);
    appendDeveloperDetail(document,details,'Fingerprint',fingerprint);

    content.append(heading,introduction,details);

    if(incident?.stack){
        const stackHeading=document.createElement('h3');
        const stack=document.createElement('pre');

        stackHeading.textContent='Stack';
        stack.textContent=safeText(incident.stack);
        stack.style.overflowWrap='anywhere';
        stack.style.whiteSpace='pre-wrap';
        content.append(stackHeading,stack);
    }

    return content;
}

async function ensureHTMLImport(target){
    const registry=target?.customElements||globalThis.customElements;

    if(!registry?.get){
        throw new Error('Custom elements are unavailable');
    }

    if(registry.get('html-import')){
        return;
    }

    try{
        await import('./HTMLImport.js');
    }catch(error){
        if(!registry.get('html-import')){
            throw error;
        }
    }

    if(!registry.get('html-import')){
        throw new Error('The html-import component is unavailable');
    }
}

async function presentDeveloperIncidentModal(target,incident,fingerprint){
    const document=target?.document;
    const container=document?.body||document?.documentElement;

    if(!document?.createElement||!container?.append){
        throw new Error('The document is not ready for an error modal');
    }

    await ensureHTMLImport(target);

    const modal=document.createElement('html-import');
    const content=buildDeveloperIncidentContent(document,incident,fingerprint);

    modal.className='modal developer-error-modal';
    modal.setAttribute('aria-label','Application error');
    modal.setAttribute('data-global-error-modal',fingerprint);
    modal.setAttribute('data-once','');
    modal.setAttribute('href',DEVELOPER_MODAL_HREF);

    let resolveClosed;
    const closed=new Promise(resolve => {
        resolveClosed=resolve;
    });
    const finish=() => {
        target.removeEventListener?.('pagehide',onPageHide);
        resolveClosed();
    };
    const onPageHide=() => {
        try{
            if(typeof modal.close==='function'){
                modal.close(undefined,true);
            }else{
                modal.remove();
            }
        }catch{
            modal.remove();
        }
        finish();
    };

    modal.addEventListener('modal-closed',finish,{ once:true });
    target.addEventListener?.('pagehide',onPageHide,{ once:true });
    container.append(modal);

    try{
        await waitForComponent(
            modal,
            {
                event:'modal-ready',
                methods:['populate','open'],
                property:'ready',
            }
        );
        await modal.populate(content,false);
        await modal.open();
    }catch(error){
        target.removeEventListener?.('pagehide',onPageHide);
        modal.removeEventListener('modal-closed',finish);
        modal.remove();
        resolveClosed();
        throw error;
    }

    await closed;
}

class Errors {
    constructor(options={}) {
        const target=options.target||globalThis.window;
        if(!target||typeof target.addEventListener!=='function'){
            throw new TypeError('Errors requires an event target');
        }

        if(options.singleton!==false&&target.errors?.[HANDLER_MARKER]===true){
            return target.errors;
        }

        this[HANDLER_MARKER]=true;
        this.target=target;
        this.delayMs=options.delayMs??DEFAULT_DELAY_MS;
        this.deliveryTimeoutMs=options.deliveryTimeoutMs??45_000;
        this.deliverySchedule=options.deliverySchedule
            || globalThis.setTimeout.bind(globalThis);
        this.deliveryCancel=options.deliveryCancel
            || globalThis.clearTimeout.bind(globalThis);
        this.maxPendingIncidents=options.maxPendingIncidents
            ?? DEFAULT_MAX_PENDING_INCIDENTS;
        this.maxReportsPerSession=options.maxReportsPerSession
            ?? DEFAULT_MAX_REPORTS_PER_SESSION;
        this.maxReportsPerWindow=options.maxReportsPerWindow
            ?? DEFAULT_MAX_REPORTS_PER_WINDOW;
        this.rateWindowMs=options.rateWindowMs??DEFAULT_RATE_WINDOW_MS;
        this.now=options.now||Date.now;
        this.schedule=options.schedule||globalThis.setTimeout.bind(globalThis);
        this.cancel=options.cancel||globalThis.clearTimeout.bind(globalThis);
        this.logger=options.logger||globalThis.console;
        this.storage=options.storage===undefined
            ? defaultStorage(target)
            : options.storage;
        this.storageHealthy=(
            typeof this.storage?.getItem==='function'
            && typeof this.storage?.setItem==='function'
        );
        this.sendMail=options.sendMail
            || sendWithWindowMail.bind(null,target);
        this.isDeveloperMode=typeof options.isDeveloperMode==='function'
            ? options.isDeveloperMode
            : defaultDeveloperModeStatus.bind(null,target);
        this.presentDeveloperIncident=typeof options.presentDeveloperIncident==='function'
            ? options.presentDeveloperIncident
            : presentDeveloperIncidentModal.bind(null,target);

        this.pending=new Map();
        this.deliveryQueue=Promise.resolve();
        this.destroyed=false;
        this.invokingMail=false;
        this.deferredDeveloperIncident=null;
        this.developerModalActive=false;
        this.developerUiDisabled=false;
        this.developerShownFingerprints=new Set();
        this.waitingForUser=false;

        const ledger=this.loadLedger();
        this.reported=new Set(ledger.fingerprints);
        this.reportTimestamps=ledger.reportTimestamps;
        this.circuitOpen=ledger.circuitOpen||!this.storageHealthy;

        if(!this.storageHealthy){
            this.warn(
                'Persistent suppression storage is unavailable; error email notifications are disabled to prevent reload loops.'
            );
        }

        this.onError=this.onError.bind(this);
        this.onRejection=this.onRejection.bind(this);
        this.onUserLoaded=this.onUserLoaded.bind(this);

        target.addEventListener('error',this.onError,true);
        target.addEventListener('unhandledrejection',this.onRejection,true);

        try{
            target.document?.documentElement?.setAttribute(
                'data-global-error-handler',
                'active'
            );
        }catch{
            // The marker is diagnostic only; listener installation already succeeded.
        }

        if(options.singleton!==false){
            try{
                target.errors=this;
            }catch(error){
                this.warn('Unable to expose the global error-handler singleton.',error);
            }
        }

        this.restorePending(ledger.pending);
    }

    loadLedger(){
        const empty={
            fingerprints:[],
            pending:[],
            reportTimestamps:[],
            circuitOpen:false,
        };

        if(!this.storageHealthy){
            return empty;
        }

        try{
            const value=JSON.parse(this.storage.getItem(LEDGER_STORAGE_KEY));
            if(!value||typeof value!=='object'){
                return empty;
            }

            return {
                fingerprints:Array.isArray(value.fingerprints)
                    ? value.fingerprints.filter(item => typeof item==='string')
                    : [],
                pending:Array.isArray(value.pending)
                    ? value.pending.filter(record => (
                        record
                        && typeof record==='object'
                        && typeof record.fingerprint==='string'
                        && record.incident
                        && typeof record.incident==='object'
                    ))
                    : [],
                reportTimestamps:Array.isArray(value.reportTimestamps)
                    ? value.reportTimestamps.filter(Number.isFinite)
                    : [],
                circuitOpen:value.circuitOpen===true,
            };
        }catch{
            this.storageHealthy=false;
            return empty;
        }
    }

    persistLedger(){
        if(!this.storageHealthy){
            return false;
        }

        try{
            const serialized=JSON.stringify({
                fingerprints:[...this.reported],
                pending:[...this.pending.values()].map(record => ({
                    count:record.count,
                    dueAt:record.dueAt,
                    errorStormDetected:record.errorStormDetected,
                    fingerprint:record.fingerprint,
                    firstSeen:record.firstSeen,
                    incident:record.incident,
                    lastSeen:record.lastSeen,
                    uniqueIncidentCount:record.uniqueIncidentCount,
                })),
                reportTimestamps:this.reportTimestamps,
                circuitOpen:this.circuitOpen,
            });
            this.storage.setItem(LEDGER_STORAGE_KEY,serialized);
            if(this.storage.getItem(LEDGER_STORAGE_KEY)!==serialized){
                throw new Error('Suppression ledger verification failed');
            }
            return true;
        }catch(error){
            this.disableForStorageFailure(error);
            return false;
        }
    }

    disableForStorageFailure(error){
        const shouldWarn=this.storageHealthy;
        this.storageHealthy=false;
        this.circuitOpen=true;

        for(const record of this.pending.values()){
            this.cancelTimer(record);
        }
        this.pending.clear();

        if(shouldWarn){
            this.warn(
                'Suppression storage failed; error email notifications are disabled to prevent reload loops.',
                error
            );
        }
    }

    cancelTimer(record){
        if(record?.timer===null||record?.timer===undefined){
            return;
        }

        try{
            this.cancel(record.timer);
        }catch(error){
            this.warn('Unable to cancel an error-notification timer.',error);
        }finally{
            record.timer=null;
        }
    }

    scheduleRecord(record,delayMs){
        try{
            record.timer=this.schedule(
                () => {
                    try{
                        this.flushFingerprint(record.fingerprint);
                    }catch(error){
                        this.warn('Unable to flush a scheduled error notification.',error);
                    }
                },
                Math.max(0,delayMs)
            );
            return true;
        }catch(error){
            this.pending.delete(record.fingerprint);
            this.warn('Unable to schedule an error notification.',error);
            return false;
        }
    }

    restorePending(records){
        if(this.circuitOpen||!Array.isArray(records)){
            return;
        }

        const timestamp=this.now();
        for(const storedRecord of records.slice(0,this.maxPendingIncidents)){
            if(this.reported.has(storedRecord.fingerprint)){
                continue;
            }

            const firstSeen=Number.isFinite(storedRecord.firstSeen)
                ? storedRecord.firstSeen:timestamp;
            const dueAt=Number.isFinite(storedRecord.dueAt)
                ? storedRecord.dueAt:firstSeen+this.delayMs;
            const record={
                count:Number.isFinite(storedRecord.count)
                    ? Math.max(1,storedRecord.count):1,
                dueAt,
                errorStormDetected:storedRecord.errorStormDetected===true,
                fingerprint:storedRecord.fingerprint,
                firstSeen,
                incident:storedRecord.incident,
                lastSeen:Number.isFinite(storedRecord.lastSeen)
                    ? storedRecord.lastSeen:firstSeen,
                timer:null,
                uniqueIncidentCount:Number.isFinite(storedRecord.uniqueIncidentCount)
                    ? Math.max(1,storedRecord.uniqueIncidentCount):1,
            };

            this.pending.set(record.fingerprint,record);
            this.scheduleRecord(record,dueAt-timestamp);
            this.offerDeveloperIncident(record.incident,record.fingerprint);
        }

        this.persistLedger();
    }

    warn(message,error){
        try{
            this.logger?.warn?.(`[global-errors] ${message}`,error);
        }catch{
            // Error reporting must never create another error.
        }
    }

    onError(event){
        try{
            this.capture(normalizeErrorEvent(event,this.target));
        }catch(error){
            this.warn('Unable to capture a global error.',error);
        }
    }

    onRejection(event){
        try{
            this.capture(normalizeRejectionEvent(event,this.target));
        }catch(error){
            this.warn('Unable to capture an unhandled rejection.',error);
        }
    }

    readDeveloperMode(){
        try{
            return this.isDeveloperMode();
        }catch(error){
            this.warn('Unable to read the developer-mode preference.',error);
            return false;
        }
    }

    deferDeveloperIncident(incident,fingerprint){
        if(!this.deferredDeveloperIncident){
            this.deferredDeveloperIncident={ fingerprint,incident };
        }

        if(this.waitingForUser){
            return;
        }

        this.waitingForUser=true;
        this.target.addEventListener(
            'user-entity-loaded',
            this.onUserLoaded
        );
    }

    onUserLoaded(){
        this.target.removeEventListener(
            'user-entity-loaded',
            this.onUserLoaded
        );
        this.waitingForUser=false;

        const deferred=this.deferredDeveloperIncident;
        this.deferredDeveloperIncident=null;

        if(deferred){
            this.offerDeveloperIncident(
                deferred.incident,
                deferred.fingerprint,
                false
            );
        }
    }

    offerDeveloperIncident(incident,fingerprint,allowDefer=true){
        if(
            this.destroyed
            || this.developerUiDisabled
            || this.developerModalActive
            || this.developerShownFingerprints.has(fingerprint)
        ){
            return false;
        }

        const developerMode=this.readDeveloperMode();
        if(developerMode!==true){
            if(allowDefer&&(developerMode===null||developerMode===undefined)){
                this.deferDeveloperIncident(incident,fingerprint);
            }
            return false;
        }

        this.developerShownFingerprints.add(fingerprint);
        this.developerModalActive=true;

        let presentation;
        try{
            presentation=this.presentDeveloperIncident(incident,fingerprint);
        }catch(error){
            this.developerModalActive=false;
            this.developerUiDisabled=true;
            this.warn('Developer error display failed and has been disabled for this session.',error);
            return false;
        }

        Promise.resolve(presentation).then(
            () => {
                this.developerModalActive=false;
            },
            error => {
                this.developerModalActive=false;
                this.developerUiDisabled=true;
                this.warn('Developer error display failed and has been disabled for this session.',error);
            }
        );

        return true;
    }

    capture(incident){
        if(this.destroyed||this.invokingMail){
            return false;
        }

        const fingerprint=fingerprintIncident(incident);
        if(this.reported.has(fingerprint)){
            return false;
        }

        this.offerDeveloperIncident(incident,fingerprint);

        if(this.circuitOpen){
            return false;
        }

        const timestamp=this.now();
        const existing=this.pending.get(fingerprint);
        if(existing){
            existing.count++;
            existing.lastSeen=timestamp;
            if(existing.count===2){
                return this.persistLedger();
            }
            return true;
        }

        if(this.pending.size>=this.maxPendingIncidents){
            const stormRecord=this.pending.values().next().value;
            if(stormRecord){
                const stormAlreadyDetected=stormRecord.errorStormDetected;
                stormRecord.errorStormDetected=true;
                stormRecord.lastSeen=timestamp;
                stormRecord.uniqueIncidentCount=stormAlreadyDetected
                    ? stormRecord.uniqueIncidentCount+1
                    : this.pending.size+1;
                this.persistLedger();
            }
            return false;
        }

        const record={
            count:1,
            dueAt:timestamp+this.delayMs,
            errorStormDetected:false,
            fingerprint,
            firstSeen:timestamp,
            incident,
            lastSeen:timestamp,
            timer:null,
            uniqueIncidentCount:1,
        };

        this.pending.set(fingerprint,record);
        // This is intentionally a fixed window from the first occurrence.
        // Resetting the timer on every repeat could postpone a true loop forever.
        if(!this.scheduleRecord(record,this.delayMs)){
            return false;
        }

        return this.persistLedger();
    }

    reserveDelivery(timestamp){
        const cutoff=timestamp-this.rateWindowMs;
        const recentReportTimestamps=this.reportTimestamps.filter(
            reportTimestamp => reportTimestamp>=cutoff
        );

        if(
            this.reportTimestamps.length>=this.maxReportsPerSession
            || recentReportTimestamps.length>=this.maxReportsPerWindow
        ){
            this.openCircuit();
            return { allowed:false,circuitOpened:true };
        }

        this.reportTimestamps.push(timestamp);

        const circuitOpened=(
            this.reportTimestamps.length>=this.maxReportsPerSession
            || recentReportTimestamps.length+1>=this.maxReportsPerWindow
        );

        if(circuitOpened){
            this.openCircuit();
        }

        return { allowed:true,circuitOpened };
    }

    openCircuit(){
        this.circuitOpen=true;

        for(const record of this.pending.values()){
            this.cancelTimer(record);
        }

        this.pending.clear();
        this.persistLedger();
    }

    flushFingerprint(fingerprint){
        const record=this.pending.get(fingerprint);
        if(!record){
            return;
        }

        this.pending.delete(fingerprint);
        this.cancelTimer(record);

        if(this.destroyed||this.circuitOpen||this.reported.has(fingerprint)){
            this.persistLedger();
            return;
        }

        // Suppress before performing any fallible notification work. A failed
        // mail request is an attempted report and must never be retried recursively.
        this.reported.add(fingerprint);
        const reservation=this.reserveDelivery(this.now());
        if(record.errorStormDetected&&reservation.allowed&&!reservation.circuitOpened){
            reservation.circuitOpened=true;
            this.openCircuit();
        }
        const persisted=this.persistLedger();

        if(!reservation.allowed||!persisted){
            return;
        }

        this.deliveryQueue=this.deliveryQueue
            .then(() => this.deliver(record,reservation))
            .catch(error => {
                this.warn('Unexpected notification-queue failure; no retry will be attempted.',error);
            });
    }

    buildNotification(record,reservation){
        const loopDetected=record.count>1;
        const errorStormDetected=record.errorStormDetected
            || reservation.circuitOpened;
        const baseSubject=record.incident.type==='unhandledrejection'
            ? 'ARCANE JS UNHANDLED REJECTION'
            : 'ARCANE JS ERROR';

        let subject=baseSubject;
        if(errorStormDetected){
            subject=`${baseSubject} - ERROR STORM DETECTED`;
        }else if(loopDetected){
            subject=`${baseSubject} - LOOP DETECTED`;
        }

        const payload={
            ...record.incident,
            fingerprint:record.fingerprint,
            occurrence_count:record.count,
            first_seen_at:safeIso(record.firstSeen),
            last_seen_at:safeIso(record.lastSeen),
            observation_window_ms:this.delayMs,
            loop_detected:loopDetected,
            error_storm_detected:errorStormDetected,
            unique_incident_count:record.uniqueIncidentCount,
            matching_notifications_suppressed:true,
            loop_notice:loopDetected
                ? `This error repeated ${record.count} times during the ${this.delayMs}ms observation window. Further matching notifications are suppressed for this browser session.`
                : 'Further occurrences of this same error are suppressed for this browser session.',
            circuit_breaker_notice:errorStormDetected
                ? 'The global notification limit was reached. Further error emails are suppressed for this browser session to stop a possible varying error loop.'
                : null,
        };

        return { payload,subject };
    }

    async deliver(record,reservation){
        const { payload,subject }=this.buildNotification(record,reservation);
        let timeout=null;
        const delivery=Promise.resolve().then(() => {
            // Only suppress events emitted synchronously by the adapter call.
            // Its returned promise is observed below, so unrelated errors that
            // occur while network delivery is pending must still be captured.
            this.invokingMail=true;
            try{
                return this.sendMail([],subject,payload,MESSAGE_STYLE,'error');
            }finally{
                this.invokingMail=false;
            }
        });

        try{
            await Promise.race([
                delivery,
                new Promise((resolve,reject) => {
                    timeout=this.deliverySchedule(
                        () => reject(new Error('Error notification timed out')),
                        this.deliveryTimeoutMs
                    );
                }),
            ]);
        }catch(error){
            this.warn('Error notification failed; no retry will be attempted.',error);
        }finally{
            if(timeout!==null){
                try{
                    this.deliveryCancel(timeout);
                }catch(error){
                    this.warn('Unable to cancel the notification timeout.',error);
                }
            }
        }
    }

    async flush(){
        for(const fingerprint of [...this.pending.keys()]){
            this.flushFingerprint(fingerprint);
        }

        await this.whenIdle();
    }

    async whenIdle(){
        await this.deliveryQueue;
    }

    destroy(){
        if(this.destroyed){
            return;
        }

        this.destroyed=true;
        this.target.removeEventListener('error',this.onError,true);
        this.target.removeEventListener('unhandledrejection',this.onRejection,true);
        this.target.removeEventListener('user-entity-loaded',this.onUserLoaded);
        this.waitingForUser=false;
        this.deferredDeveloperIncident=null;

        try{
            const modal=this.target.document?.querySelector?.(
                'html-import[data-global-error-modal]'
            );
            if(typeof modal?.close==='function'){
                modal.close(undefined,true);
            }else{
                modal?.remove?.();
            }
        }catch(error){
            this.warn('Unable to remove the developer error modal.',error);
        }

        try{
            this.target.document?.documentElement?.removeAttribute(
                'data-global-error-handler'
            );
        }catch{
            // The marker is diagnostic only.
        }

        for(const record of this.pending.values()){
            this.cancelTimer(record);
        }

        this.pending.clear();
        this.persistLedger();

        if(this.target.errors===this){
            try{
                delete this.target.errors;
            }catch{
                this.target.errors=undefined;
            }
        }
    }
}

if(typeof window!=='undefined'&&window.errors?.[HANDLER_MARKER]!==true){
    new Errors();
}

export default Errors;
