const DEFAULT_TIMEOUT_MS=10000;
const MAX_TIMEOUT_MS=300000;

function coded(error,code){
    if(!error.code) error.code=code;
    return error;
}

function invalid(message,ErrorType=TypeError){
    return coded(new ErrorType(message),'ASYNC_BOUNDARY_INVALID_OPTIONS');
}

function isPlainRecord(value){
    if(!value||typeof value!=='object'||Array.isArray(value)) return false;
    const prototype=Object.getPrototypeOf(value);
    return prototype===Object.prototype||prototype===null;
}

function isAbortSignal(value){
    return Boolean(value)
        &&typeof value==='object'
        &&typeof value.aborted==='boolean'
        &&typeof value.addEventListener==='function'
        &&typeof value.removeEventListener==='function';
}

function normalizeOptions(value){
    if(!isPlainRecord(value)) throw invalid('Async boundary options must be a plain object.');
    const unknown=Object.keys(value).find(key=>!new Set(['signal','timeoutMs']).has(key));
    if(unknown) throw invalid(`Async boundary options contain an unsupported field: ${unknown}.`);

    const timeoutMs=value.timeoutMs??DEFAULT_TIMEOUT_MS;
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>MAX_TIMEOUT_MS){
        throw invalid(`timeoutMs must be an integer from 1 through ${MAX_TIMEOUT_MS}.`,RangeError);
    }

    const signal=value.signal??null;
    if(signal!==null&&!isAbortSignal(signal)){
        throw invalid('signal must be an AbortSignal.');
    }

    return Object.freeze({signal,timeoutMs});
}

function normalizeOperation(value){
    if(typeof value==='function'){
        return Object.freeze({kind:'function',value});
    }
    if(!value||(typeof value!=='object'&&typeof value!=='function')){
        throw coded(new TypeError('The asynchronous operation must be a promise or function.'),'ASYNC_BOUNDARY_INVALID_OPERATION');
    }
    if(typeof value.then!=='function'){
        throw coded(new TypeError('The asynchronous operation must be a promise or function.'),'ASYNC_BOUNDARY_INVALID_OPERATION');
    }
    return Object.freeze({kind:'promise',value});
}

/**
 * Identifies expiration of an AsyncBoundary timeout.
 */
export class AsyncBoundaryTimeoutError extends Error{
    constructor(timeoutMs){
        super(`The asynchronous operation exceeded its ${timeoutMs} ms timeout.`);
        this.name='AsyncBoundaryTimeoutError';
        this.code='ASYNC_BOUNDARY_TIMEOUT';
        this.timeoutMs=timeoutMs;
    }
}

/**
 * Identifies cancellation received from an external AbortSignal.
 */
export class AsyncBoundaryAbortError extends Error{
    constructor(reason){
        super('The asynchronous operation was aborted.');
        this.name='AbortError';
        this.code='ASYNC_BOUNDARY_ABORTED';
        if(reason!==undefined) this.cause=reason;
    }
}

export const asyncBoundaryDefaults=Object.freeze({
    maxTimeoutMs:MAX_TIMEOUT_MS,
    timeoutMs:DEFAULT_TIMEOUT_MS,
});

/**
 * Runs one promise or function behind a finite timeout and optional external
 * AbortSignal. Function operations receive a child AbortSignal and must stop
 * work cooperatively when it is aborted. The boundary cannot preempt
 * synchronous work or stop an already-created promise by itself.
 *
 * @template T
 * @param {PromiseLike<T>|((signal:AbortSignal)=>T|PromiseLike<T>)} operation
 * @param {{timeoutMs?:number,signal?:AbortSignal|null}} [options]
 * @returns {Promise<T>}
 */
export function runAsyncBoundary(operation,options={}){
    let settings;
    let descriptor;
    try{
        settings=normalizeOptions(options);
        descriptor=normalizeOperation(operation);
        if(typeof globalThis.AbortController!=='function'){
            throw coded(new Error('AbortController is unavailable in this environment.'),'ASYNC_BOUNDARY_UNAVAILABLE');
        }
    }catch(error){
        return Promise.reject(error);
    }

    const controller=new AbortController();
    const suppliedPromise=descriptor.kind==='promise'
        ?Promise.resolve(descriptor.value)
        :null;

    return new Promise((resolve,reject)=>{
        let settled=false;
        let timer=null;

        const cleanup=()=>{
            if(timer!==null){
                clearTimeout(timer);
                timer=null;
            }
            settings.signal?.removeEventListener('abort',onExternalAbort);
        };
        const finish=(handler,value)=>{
            if(settled) return;
            settled=true;
            cleanup();
            handler(value);
        };
        const abortBoundary=(error)=>{
            if(settled) return;
            controller.abort(error);
            finish(reject,error);
        };
        const onExternalAbort=()=>{
            abortBoundary(new AsyncBoundaryAbortError(settings.signal?.reason));
        };

        settings.signal?.addEventListener('abort',onExternalAbort,{once:true});
        if(settings.signal?.aborted){
            suppliedPromise?.catch(()=>{});
            onExternalAbort();
            return;
        }

        timer=setTimeout(()=>{
            abortBoundary(new AsyncBoundaryTimeoutError(settings.timeoutMs));
        },settings.timeoutMs);

        const outcome=suppliedPromise??Promise.resolve().then(()=>descriptor.value(controller.signal));
        outcome.then(
            value=>finish(resolve,value),
            error=>finish(reject,error)
        );
    });
}

export default runAsyncBoundary;
