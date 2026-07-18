import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { pathToFileURL } from 'node:url';

const MEBIBYTE=1024*1024;

export const MAIL_TYPES=Object.freeze({
    error:'error',
    report:'report',
    crisisDetected:'crisis_detected',
});

// Routing identities are deployment policy. The shared service never embeds
// product addresses, recipient lists, or application credentials.
export const DEFAULT_ERROR_RECIPIENTS=Object.freeze([]);
export const DEFAULT_SENDERS=Object.freeze({});

const ALLOWED_MAIL_TYPES=new Set(Object.values(MAIL_TYPES));

const DEFAULTS=Object.freeze({
    // JSON escaping adds overhead, so the request envelope is larger than the
    // 25 MiB combined text/HTML content limit enforced after parsing.
    bodyLimitBytes:52*MEBIBYTE,
    healthPath:'/healthz',
    host:'127.0.0.1',
    idempotencyMaxEntries:1_000,
    idempotencyTtlMs:10*60*1000,
    mailPath:'/v1/mail',
    maxConcurrentSends:2,
    maxMessageBytes:25*MEBIBYTE,
    maxQueuedSends:2,
    maxRecipients:50,
    maxSubjectLength:160,
    port:8025,
    rateLimitMax:20,
    rateLimitWindowMs:60_000,
    readyPath:'/readyz',
    requestTimeoutMs:120_000,
    smtpConnectionTimeoutMs:10_000,
    smtpGreetingTimeoutMs:10_000,
    smtpAttemptTimeoutMs:150_000,
    smtpRetryAttempts:2,
    smtpRetryBaseMs:250,
    smtpSocketTimeoutMs:120_000,
    verifyIntervalMs:60_000,
});

// The deployment adapters deliberately leave headroom between each layer:
// gateway drain < reverse proxy < browser. Configuration that would violate
// this ordering fails closed instead of allowing a late SMTP acceptance to be
// reported to the user as a proxy timeout.
export const MAIL_TIMEOUT_CONTRACT=Object.freeze({
    browserRequestMs:590_000,
    edgeResponseMs:450_000,
    responseMarginMs:10_000,
    shutdownOverheadMs:5_000,
});

const EMAIL_PATTERN=/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const IDEMPOTENCY_KEY_PATTERN=/^[a-zA-Z0-9._:-]{8,128}$/;
const APP_ID_PATTERN=/^[a-z0-9](?:[a-z0-9-]{0,62})$/;

export class ConfigurationError extends Error {
    constructor(message) {
        super(message);
        this.name='ConfigurationError';
    }
}

class HttpError extends Error {
    constructor(status,message,{ headers={} }={}) {
        super(message);
        this.name='HttpError';
        this.status=status;
        this.headers=headers;
    }
}

class QueueFullError extends Error {
    constructor() {
        super('The delivery queue is full');
        this.name='QueueFullError';
    }
}

function calculateDrainTimeoutMs(config) {
    let retryDelayMs=0;
    for(let attempt=1;attempt<config.smtpRetryAttempts;attempt++) {
        retryDelayMs+=config.smtpRetryBaseMs*(2**(attempt-1))
            + config.smtpRetryBaseMs;
    }
    return config.requestTimeoutMs
        + config.smtpAttemptTimeoutMs*config.smtpRetryAttempts
        + retryDelayMs
        + MAIL_TIMEOUT_CONTRACT.shutdownOverheadMs;
}

function parseBoolean(value,fallback=false) {
    if(value===undefined || value==='') return fallback;
    if(value===true || value==='true' || value==='1') return true;
    if(value===false || value==='false' || value==='0') return false;
    throw new ConfigurationError(`Expected a boolean value, received ${JSON.stringify(value)}`);
}

function parseInteger(value,fallback,name,{ min=1,max=Number.MAX_SAFE_INTEGER }={}) {
    if(value===undefined || value==='') return fallback;
    const parsed=Number(value);
    if(!Number.isSafeInteger(parsed) || parsed<min || parsed>max) {
        throw new ConfigurationError(`${name} must be an integer between ${min} and ${max}`);
    }
    return parsed;
}

function parseList(value) {
    if(!value) return [];
    const serialized=String(value);
    if(serialized.length>65_536) {
        throw new ConfigurationError('Comma-separated configuration values must not exceed 65536 characters');
    }
    const values=[...new Set(serialized.split(',').map(item => item.trim()).filter(Boolean))];
    if(values.length>256 || values.some(item => item.length>2_048)) {
        throw new ConfigurationError('Comma-separated configuration contains too many or oversized values');
    }
    return values;
}

function normalizePath(value,name) {
    const path=String(value || '').trim();
    const segments=path.split('/').slice(1);
    if(path.length<2 || path.length>128 || !path.startsWith('/')
        || !/^\/[a-zA-Z0-9._~/-]+$/.test(path)
        || segments.some(segment => !segment || segment==='.' || segment==='..')) {
        throw new ConfigurationError(`${name} must be an absolute URL path`);
    }
    return path;
}

function normalizeEmail(value) {
    if(typeof value!=='string') throw new Error('Email addresses must be strings');
    const address=value.trim().toLowerCase();
    if(address.length<3 || address.length>254 || !EMAIL_PATTERN.test(address)) {
        throw new Error('Invalid email address');
    }
    return address;
}

function parseEmails(value,name,errors,{ required=false }={}) {
    const addresses=[];
    for(const candidate of parseList(value)) {
        try {
            addresses.push(normalizeEmail(candidate));
        } catch {
            errors.push(`${name} contains an invalid email address`);
        }
    }
    if(required && addresses.length===0) errors.push(`${name} is required`);
    return [...new Set(addresses)];
}

function parseOrigins(value,errors) {
    const origins=[];
    const candidates=parseList(value);
    if(candidates.length>64) errors.push('MAIL_ALLOWED_ORIGINS must not contain more than 64 origins');
    for(const candidate of candidates.slice(0,64)) {
        if(candidate==='null') {
            origins.push(candidate);
            continue;
        }
        try {
            const url=new URL(candidate);
            if(url.origin!==candidate || !['https:','http:'].includes(url.protocol)) throw new Error();
            if(url.protocol==='http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) {
                throw new Error();
            }
            origins.push(url.origin);
        } catch {
            errors.push('MAIL_ALLOWED_ORIGINS must contain exact HTTPS origins');
        }
    }
    return new Set(origins);
}

function parseApplicationIds(value,name,errors) {
    const ids=[];
    const candidates=parseList(value);
    if(candidates.length>64) errors.push(`${name} must not contain more than 64 application ids`);
    for(const candidate of candidates.slice(0,64)) {
        if(!APP_ID_PATTERN.test(candidate)) {
            errors.push(`${name} contains an invalid Arcane application id`);
            continue;
        }
        ids.push(candidate);
    }
    return new Set(ids);
}

function parseAppKeys(env,errors) {
    const keys=new Map();
    const raw=String(env.MAIL_APP_KEYS || '').trim();
    if(raw) {
        if(raw.length>65_536) {
            errors.push('MAIL_APP_KEYS must not exceed 65536 characters');
            return keys;
        }
        let parsed;
        try {
            parsed=JSON.parse(raw);
        } catch {
            errors.push('MAIL_APP_KEYS must be a JSON object mapping application ids to rotated secrets');
        }
        if(parsed!==undefined) {
            if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)
                || Object.getPrototypeOf(parsed)!==Object.prototype) {
                errors.push('MAIL_APP_KEYS must be a JSON object mapping application ids to rotated secrets');
            } else {
                const entries=Object.entries(parsed);
                if(entries.length>64) errors.push('MAIL_APP_KEYS must not contain more than 64 applications');
                for(const [appId,key] of entries.slice(0,64)) {
                    if(!APP_ID_PATTERN.test(appId)) {
                        errors.push('MAIL_APP_KEYS contains an invalid Arcane application id');
                    } else if(typeof key!=='string' || key.length<32 || key.length>512
                        || /[\u0000-\u001f\u007f]/.test(key)) {
                        errors.push(`MAIL_APP_KEYS.${appId} must be a 32-512 character secret`);
                    } else {
                        keys.set(appId,key);
                    }
                }
            }
        }
    }

    const legacyName=String(env.MAIL_APP_NAME || '').trim();
    const legacyKey=String(env.MAIL_APP_KEY || '');
    if(legacyName || legacyKey) {
        if(!APP_ID_PATTERN.test(legacyName)) {
            errors.push('MAIL_APP_NAME must be a valid Arcane application id');
        } else if(legacyKey.length<32 || legacyKey.length>512
            || /[\u0000-\u001f\u007f]/.test(legacyKey)) {
            errors.push('MAIL_APP_KEY must be a 32-512 character rotated secret');
        } else if(keys.has(legacyName) && keys.get(legacyName)!==legacyKey) {
            errors.push(`MAIL_APP_KEY conflicts with MAIL_APP_KEYS.${legacyName}`);
        } else {
            keys.set(legacyName,legacyKey);
        }
    }
    return keys;
}

/**
 * Loads and validates runtime delivery configuration. Non-secret routing
 * values have safe application defaults; SMTP credentials do not.
 */
export function loadConfig(env=process.env) {
    const errors=[];
    const smtpPassword=String(env.MAIL_SMTP_PASS || '');

    if(!smtpPassword) errors.push('MAIL_SMTP_PASS is required');
    if(smtpPassword.length>1_024 || /[\u0000-\u001f\u007f]/.test(smtpPassword)) {
        errors.push('MAIL_SMTP_PASS must contain at most 1024 characters without control characters');
    }

    let smtpUser='';
    try {
        smtpUser=normalizeEmail(env.MAIL_SMTP_USER || '');
    } catch {
        errors.push('MAIL_SMTP_USER must be a valid email address');
    }

    const errorRecipients=parseEmails(
        env.MAIL_ERROR_RECIPIENTS || DEFAULT_ERROR_RECIPIENTS.join(','),
        'MAIL_ERROR_RECIPIENTS',
        errors,
        { required:true },
    );
    const allowedOrigins=parseOrigins(env.MAIL_ALLOWED_ORIGINS,errors);
    const appKeys=parseAppKeys(env,errors);
    const localDevelopmentApps=parseApplicationIds(
        env.MAIL_LOCAL_DEVELOPMENT_APPS,
        'MAIL_LOCAL_DEVELOPMENT_APPS',
        errors,
    );

    const senders={};
    const senderConfiguration=[
        [MAIL_TYPES.error,'MAIL_FROM_ERROR'],
        [MAIL_TYPES.report,'MAIL_FROM_REPORT'],
        [MAIL_TYPES.crisisDetected,'MAIL_FROM_CRISIS_DETECTED'],
    ];
    for(const [type,name] of senderConfiguration) {
        try {
            senders[type]=normalizeEmail(env[name] || DEFAULT_SENDERS[type] || smtpUser);
        } catch {
            errors.push(`${name} must be a valid email address`);
        }
    }

    let host;
    let port;
    let bodyLimitBytes;
    let idempotencyMaxEntries;
    let idempotencyTtlMs;
    let maxConcurrentSends;
    let maxMessageBytes;
    let maxQueuedSends;
    let maxRecipients;
    let rateLimitMax;
    let rateLimitWindowMs;
    let requestTimeoutMs;
    let smtpConnectionTimeoutMs;
    let smtpGreetingTimeoutMs;
    let smtpAttemptTimeoutMs;
    let smtpPort;
    let smtpRetryAttempts;
    let smtpRetryBaseMs;
    let smtpSocketTimeoutMs;
    let verifyIntervalMs;
    let localDevelopmentOriginAuth;

    try {
        host=String(env.MAIL_HOST || DEFAULTS.host).trim();
        if(!host) throw new ConfigurationError('MAIL_HOST cannot be empty');
        port=parseInteger(env.MAIL_PORT,DEFAULTS.port,'MAIL_PORT',{ max:65_535 });
        bodyLimitBytes=parseInteger(env.MAIL_BODY_LIMIT_BYTES,DEFAULTS.bodyLimitBytes,'MAIL_BODY_LIMIT_BYTES',{ max:64*MEBIBYTE });
        idempotencyMaxEntries=parseInteger(env.MAIL_IDEMPOTENCY_MAX_ENTRIES,DEFAULTS.idempotencyMaxEntries,'MAIL_IDEMPOTENCY_MAX_ENTRIES',{ max:100_000 });
        idempotencyTtlMs=parseInteger(env.MAIL_IDEMPOTENCY_TTL_MS,DEFAULTS.idempotencyTtlMs,'MAIL_IDEMPOTENCY_TTL_MS',{ max:24*60*60*1000 });
        maxConcurrentSends=parseInteger(env.MAIL_MAX_CONCURRENT_SENDS,DEFAULTS.maxConcurrentSends,'MAIL_MAX_CONCURRENT_SENDS',{ max:20 });
        maxMessageBytes=parseInteger(env.MAIL_MAX_MESSAGE_BYTES,DEFAULTS.maxMessageBytes,'MAIL_MAX_MESSAGE_BYTES',{ max:50*MEBIBYTE });
        maxQueuedSends=parseInteger(env.MAIL_MAX_QUEUED_SENDS,DEFAULTS.maxQueuedSends,'MAIL_MAX_QUEUED_SENDS',{ min:0,max:10_000 });
        maxRecipients=parseInteger(env.MAIL_MAX_RECIPIENTS,DEFAULTS.maxRecipients,'MAIL_MAX_RECIPIENTS',{ max:100 });
        rateLimitMax=parseInteger(env.MAIL_RATE_LIMIT_MAX,DEFAULTS.rateLimitMax,'MAIL_RATE_LIMIT_MAX',{ max:10_000 });
        rateLimitWindowMs=parseInteger(env.MAIL_RATE_LIMIT_WINDOW_MS,DEFAULTS.rateLimitWindowMs,'MAIL_RATE_LIMIT_WINDOW_MS',{ max:24*60*60*1000 });
        requestTimeoutMs=parseInteger(env.MAIL_REQUEST_TIMEOUT_MS,DEFAULTS.requestTimeoutMs,'MAIL_REQUEST_TIMEOUT_MS',{ max:10*60_000 });
        smtpPort=parseInteger(env.MAIL_SMTP_PORT,465,'MAIL_SMTP_PORT',{ max:65_535 });
        smtpConnectionTimeoutMs=parseInteger(env.MAIL_SMTP_CONNECTION_TIMEOUT_MS,DEFAULTS.smtpConnectionTimeoutMs,'MAIL_SMTP_CONNECTION_TIMEOUT_MS',{ max:120_000 });
        smtpGreetingTimeoutMs=parseInteger(env.MAIL_SMTP_GREETING_TIMEOUT_MS,DEFAULTS.smtpGreetingTimeoutMs,'MAIL_SMTP_GREETING_TIMEOUT_MS',{ max:120_000 });
        smtpAttemptTimeoutMs=parseInteger(env.MAIL_SMTP_ATTEMPT_TIMEOUT_MS,DEFAULTS.smtpAttemptTimeoutMs,'MAIL_SMTP_ATTEMPT_TIMEOUT_MS',{ min:1_000,max:10*60_000 });
        smtpRetryAttempts=parseInteger(env.MAIL_SMTP_RETRY_ATTEMPTS,DEFAULTS.smtpRetryAttempts,'MAIL_SMTP_RETRY_ATTEMPTS',{ max:3 });
        smtpRetryBaseMs=parseInteger(env.MAIL_SMTP_RETRY_BASE_MS,DEFAULTS.smtpRetryBaseMs,'MAIL_SMTP_RETRY_BASE_MS',{ max:10_000 });
        smtpSocketTimeoutMs=parseInteger(env.MAIL_SMTP_SOCKET_TIMEOUT_MS,DEFAULTS.smtpSocketTimeoutMs,'MAIL_SMTP_SOCKET_TIMEOUT_MS',{ max:10*60_000 });
        verifyIntervalMs=parseInteger(env.MAIL_VERIFY_INTERVAL_MS,DEFAULTS.verifyIntervalMs,'MAIL_VERIFY_INTERVAL_MS',{ min:10_000,max:60*60*1000 });
        localDevelopmentOriginAuth=parseBoolean(env.MAIL_LOCAL_DEVELOPMENT_ORIGIN_AUTH,false);
    } catch(error) {
        errors.push(error.message);
    }

    const loopbackHosts=new Set(['127.0.0.1','::1','localhost']);
    if(host&&!loopbackHosts.has(host)) {
        errors.push('MAIL_HOST must remain loopback-only; use an authenticated reverse proxy for public ingress');
    }
    if(localDevelopmentOriginAuth) {
        if(!loopbackHosts.has(host)) {
            errors.push('MAIL_LOCAL_DEVELOPMENT_ORIGIN_AUTH requires MAIL_HOST to remain loopback-only');
        }
        if(localDevelopmentApps.size===0) {
            errors.push('MAIL_LOCAL_DEVELOPMENT_ORIGIN_AUTH requires MAIL_LOCAL_DEVELOPMENT_APPS');
        }
        if(allowedOrigins.size===0 || [...allowedOrigins].some(origin => {
            if(origin==='null') return true;
            try {
                return !new Set(['127.0.0.1','[::1]','localhost']).has(new URL(origin).hostname);
            } catch { return true; }
        })) {
            errors.push('MAIL_LOCAL_DEVELOPMENT_ORIGIN_AUTH requires explicit loopback-only MAIL_ALLOWED_ORIGINS');
        }
    }
    if(appKeys.size===0 && !localDevelopmentOriginAuth) {
        errors.push('MAIL_APP_KEYS is required outside explicit loopback development mode');
    }
    if(allowedOrigins.size===0) {
        errors.push('MAIL_ALLOWED_ORIGINS is required');
    }

    if(errorRecipients.length>maxRecipients) {
        errors.push('MAIL_MAX_RECIPIENTS cannot be smaller than MAIL_ERROR_RECIPIENTS');
    }
    if(bodyLimitBytes<maxMessageBytes*2+MEBIBYTE) {
        errors.push('MAIL_BODY_LIMIT_BYTES must be at least twice MAIL_MAX_MESSAGE_BYTES plus 1 MiB for JSON escaping');
    }
    if([smtpConnectionTimeoutMs,smtpGreetingTimeoutMs,smtpSocketTimeoutMs]
        .some(timeout => timeout>smtpAttemptTimeoutMs)) {
        errors.push('SMTP stage timeouts must not exceed MAIL_SMTP_ATTEMPT_TIMEOUT_MS');
    }

    let mailPath;
    let healthPath;
    let readyPath;
    try {
        mailPath=normalizePath(env.MAIL_PATH || DEFAULTS.mailPath,'MAIL_PATH');
        healthPath=normalizePath(env.MAIL_HEALTH_PATH || DEFAULTS.healthPath,'MAIL_HEALTH_PATH');
        readyPath=normalizePath(env.MAIL_READY_PATH || DEFAULTS.readyPath,'MAIL_READY_PATH');
        if(new Set([mailPath,healthPath,readyPath]).size!==3) {
            throw new ConfigurationError('Mail, health, and readiness paths must be different');
        }
    } catch(error) {
        errors.push(error.message);
    }

    const smtpHost=String(env.MAIL_SMTP_HOST || '').trim();
    if(!smtpHost || smtpHost.length>253 || /[\s\u0000-\u001f\u007f]/.test(smtpHost)
        || !/^[a-zA-Z0-9.:[\]-]+$/.test(smtpHost)) {
        errors.push('MAIL_SMTP_HOST must be a hostname or IP address');
    }

    if(errors.length) {
        throw new ConfigurationError(`Invalid mail server configuration:\n- ${errors.join('\n- ')}`);
    }

    const messageIdDomain=String(
        env.MAIL_MESSAGE_ID_DOMAIN || senders[MAIL_TYPES.report].split('@')[1],
    ).toLowerCase();
    const dnsNamePattern=/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    if(messageIdDomain.length>253 || !dnsNamePattern.test(messageIdDomain)) {
        throw new ConfigurationError('MAIL_MESSAGE_ID_DOMAIN must be a DNS name');
    }

    const smtpSecure=parseBoolean(env.MAIL_SMTP_SECURE,smtpPort===465);
    const smtp={
        auth:{ pass:smtpPassword,user:smtpUser },
        connectionTimeout:smtpConnectionTimeoutMs,
        dnsTimeout:smtpConnectionTimeoutMs,
        greetingTimeout:smtpGreetingTimeoutMs,
        host:smtpHost,
        pool:false,
        port:smtpPort,
        requireTLS:!smtpSecure,
        secure:smtpSecure,
        socketTimeout:smtpSocketTimeoutMs,
        tls:{ minVersion:'TLSv1.2',rejectUnauthorized:true },
    };
    const drainTimeoutMs=calculateDrainTimeoutMs({
        requestTimeoutMs,
        smtp,
        smtpAttemptTimeoutMs,
        smtpRetryAttempts,
        smtpRetryBaseMs,
    });
    if(drainTimeoutMs+MAIL_TIMEOUT_CONTRACT.responseMarginMs>MAIL_TIMEOUT_CONTRACT.edgeResponseMs
        || requestTimeoutMs+drainTimeoutMs+MAIL_TIMEOUT_CONTRACT.responseMarginMs
            > MAIL_TIMEOUT_CONTRACT.browserRequestMs) {
        throw new ConfigurationError(
            'Mail timeout settings exceed the fixed proxy, browser, or graceful-shutdown budget',
        );
    }

    return {
        allowedOrigins,
        appKeys,
        bodyLimitBytes,
        drainTimeoutMs,
        errorRecipients,
        healthPath,
        host,
        idempotencyMaxEntries,
        idempotencyTtlMs,
        localDevelopmentApps,
        mailPath,
        maxConcurrentSends,
        maxMessageBytes,
        maxQueuedSends,
        maxRecipients,
        maxSubjectLength:DEFAULTS.maxSubjectLength,
        messageIdDomain,
        localDevelopmentOriginAuth,
        port,
        rateLimitMax,
        rateLimitWindowMs,
        readyPath,
        requestTimeoutMs,
        senders,
        smtp,
        smtpAttemptTimeoutMs,
        smtpRetryAttempts,
        smtpRetryBaseMs,
        trustProxy:parseBoolean(env.MAIL_TRUST_PROXY,false),
        verifyIntervalMs,
    };
}

function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}

function fingerprintMail(mail) {
    const digest=createHash('sha256');
    const add=value => {
        const text=String(value ?? '');
        digest.update(String(Buffer.byteLength(text,'utf8')));
        digest.update(':');
        digest.update(text);
        digest.update(';');
    };

    add(mail.type);
    add(mail.subject);
    add(mail.text);
    add(mail.html);
    for(const recipient of mail.recipients) add(recipient);
    return digest.digest('hex');
}

function safeEqual(actual,expected) {
    if(typeof actual!=='string' || typeof expected!=='string') return false;
    const actualBuffer=Buffer.from(actual);
    const expectedBuffer=Buffer.from(expected);
    if(actualBuffer.length!==expectedBuffer.length) {
        timingSafeEqual(expectedBuffer,expectedBuffer);
        return false;
    }
    return timingSafeEqual(actualBuffer,expectedBuffer);
}

function appKeyFor(config,appName) {
    if(config.appKeys instanceof Map) return config.appKeys.get(appName);
    if(appName===config.appName) return config.appKey;
    return undefined;
}

function requestOrigin(request) {
    const value=request.headers.origin;
    if(typeof value!=='string') return null;
    try {
        const url=new URL(value);
        return url.origin===value ? url:null;
    } catch {
        return null;
    }
}

function localDevelopmentApplication(request,config) {
    if(!config.localDevelopmentOriginAuth) return null;
    const appName=request.headers['x-mail-app'];
    const origin=requestOrigin(request);
    const loopbacks=new Set(['127.0.0.1','::1','[::1]','localhost']);
    if(typeof appName!=='string' || !config.localDevelopmentApps?.has(appName)) return null;
    if(!origin || !config.allowedOrigins.has(origin.origin) || !loopbacks.has(origin.hostname)) return null;
    if(!loopbacks.has(request.socket.remoteAddress?.replace(/^::ffff:/,''))) return null;
    if(request.headers['sec-fetch-site'] && !['same-origin','same-site'].includes(request.headers['sec-fetch-site'])) return null;
    return appName;
}

function authorizedApplication(request,config) {
    const local=localDevelopmentApplication(request,config);
    if(local) return local;
    const appName=request.headers['x-mail-app'];
    const expectedKey=typeof appName==='string' ? appKeyFor(config,appName):undefined;
    if(!expectedKey || !safeEqual(request.headers['x-mail-key'],expectedKey)) return null;
    return appName;
}

function setBaseHeaders(response) {
    response.setHeader('Cache-Control','no-store');
    response.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
    response.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
    response.setHeader('Vary','Origin');
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('X-Frame-Options','DENY');
}

function applyCors(request,response,allowedOrigins) {
    const origin=request.headers.origin;
    if(typeof origin!=='string' || !allowedOrigins.has(origin)) return false;
    response.setHeader('Access-Control-Allow-Origin',origin);
    response.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers','Content-Type, Idempotency-Key, X-Mail-App, X-Mail-Key');
    response.setHeader('Access-Control-Max-Age','600');
    return true;
}

function writeJson(response,status,body,headers={}) {
    if(response.writableEnded || response.destroyed) return;
    const encoded=Buffer.from(JSON.stringify(body));
    response.statusCode=status;
    response.setHeader('Content-Type','application/json; charset=utf-8');
    response.setHeader('Content-Length',encoded.length);
    for(const [name,value] of Object.entries(headers)) response.setHeader(name,value);
    response.end(encoded);
}

function readJson(request,{ limitBytes,timeoutMs }) {
    const declaredLength=Number(request.headers['content-length']);
    if(Number.isFinite(declaredLength) && declaredLength>limitBytes) {
        request.resume();
        throw new HttpError(413,'Request body is too large');
    }

    return new Promise((resolve,reject) => {
        const chunks=[];
        let size=0;
        let settled=false;
        const timer=setTimeout(
            () => finish(new HttpError(408,'Request body timed out')),
            timeoutMs,
        );
        timer.unref?.();

        const cleanup=() => {
            clearTimeout(timer);
            request.off('aborted',onAborted);
            request.off('data',onData);
            request.off('end',onEnd);
            request.off('error',onError);
        };
        const finish=(error,value) => {
            if(settled) return;
            settled=true;
            cleanup();
            if(error) reject(error);
            else resolve(value);
        };
        const onAborted=() => finish(new HttpError(400,'Request was aborted'));
        const onError=() => finish(new HttpError(400,'Unable to read request body'));
        const onData=chunk => {
            size+=chunk.length;
            if(size>limitBytes) {
                finish(new HttpError(413,'Request body is too large'));
                request.resume();
                return;
            }
            chunks.push(chunk);
        };
        const onEnd=() => {
            if(size===0) return finish(new HttpError(400,'Request body is required'));
            try {
                finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                finish(new HttpError(400,'Request body must be valid JSON'));
            }
        };

        request.on('aborted',onAborted);
        request.on('data',onData);
        request.on('end',onEnd);
        request.on('error',onError);
    });
}

function validatePayload(value,config) {
    if(!value || typeof value!=='object' || Array.isArray(value)) {
        throw new HttpError(422,'Request body must be a JSON object');
    }

    const allowedFields=new Set(['html','subject','text','to','type']);
    if(Object.keys(value).some(key => !allowedFields.has(key))) {
        throw new HttpError(422,'Request body contains unsupported fields');
    }

    if(typeof value.type!=='string' || !ALLOWED_MAIL_TYPES.has(value.type)) {
        throw new HttpError(
            422,
            `type must be one of: ${[...ALLOWED_MAIL_TYPES].join(', ')}`,
        );
    }

    if(typeof value.subject!=='string') throw new HttpError(422,'subject must be a string');
    const subject=value.subject.trim();
    if(!subject || subject.length>config.maxSubjectLength || /[\u0000-\u001f\u007f]/.test(subject)) {
        throw new HttpError(422,`subject must contain 1-${config.maxSubjectLength} characters without line breaks`);
    }

    if(value.text!==undefined && typeof value.text!=='string') {
        throw new HttpError(422,'text must be a string');
    }
    if(value.html!==undefined && typeof value.html!=='string') {
        throw new HttpError(422,'html must be a string');
    }

    const text=value.text || '';
    const html=value.html || '';
    if(!/\S/.test(text) && !/\S/.test(html)) {
        throw new HttpError(422,'At least one of text or html must contain message content');
    }
    const unsupportedControl=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
    if(unsupportedControl.test(text) || unsupportedControl.test(html)) {
        throw new HttpError(422,'text and html contain unsupported control characters');
    }
    const messageBytes=Buffer.byteLength(text,'utf8')+Buffer.byteLength(html,'utf8');
    if(messageBytes>config.maxMessageBytes) {
        throw new HttpError(
            422,
            `Combined text and html must not exceed ${config.maxMessageBytes} UTF-8 bytes`,
        );
    }

    if(value.to!==undefined && !Array.isArray(value.to)) {
        throw new HttpError(422,'to must be an array of email addresses');
    }
    if((value.to || []).length>config.maxRecipients) {
        throw new HttpError(422,`No more than ${config.maxRecipients} recipients are permitted`);
    }

    const requested=[];
    for(const candidate of value.to || []) {
        let address;
        try {
            address=normalizeEmail(candidate);
        } catch {
            throw new HttpError(422,'to contains an invalid email address');
        }
        requested.push(address);
    }

    const requestedRecipients=[...new Set(requested)];
    if(value.type!==MAIL_TYPES.error && requestedRecipients.length===0) {
        throw new HttpError(422,'to must contain at least one recipient for this message type');
    }

    const recipients=[...new Set([
        ...requestedRecipients,
        ...(value.type===MAIL_TYPES.error ? config.errorRecipients:[]),
    ])];
    if(recipients.length>config.maxRecipients) {
        throw new HttpError(422,`No more than ${config.maxRecipients} recipients are permitted`);
    }

    return {
        html,
        recipients,
        subject,
        text,
        type:value.type,
    };
}

function clientKey(request,trustProxy) {
    if(trustProxy) {
        const forwarded=request.headers['x-forwarded-for'];
        if(typeof forwarded==='string') {
            const first=forwarded.split(',')[0].trim();
            if(first && first.length<=64) return first;
        }
    }
    return request.socket.remoteAddress || 'unknown';
}

function createRateLimiter({ max,now,windowMs }) {
    const clients=new Map();
    const maxClients=1_024;
    return {
        consume(key) {
            const timestamp=now();
            let entry=clients.get(key);
            if(!entry || timestamp>=entry.resetAt) {
                entry={ count:0,resetAt:timestamp+windowMs };
            } else {
                clients.delete(key);
            }
            clients.set(key,entry);
            entry.count++;

            if(clients.size>maxClients) {
                clients.delete(clients.keys().next().value);
            }

            return {
                allowed:entry.count<=max,
                retryAfter:Math.max(1,Math.ceil((entry.resetAt-timestamp)/1000)),
            };
        },
    };
}

function createWorkQueue(maxConcurrent,maxQueued) {
    const pending=[];
    const idleWaiters=new Set();
    let active=0;
    let closed=false;

    const notifyIdle=() => {
        if(active!==0 || pending.length!==0) return;
        for(const resolve of idleWaiters) resolve();
        idleWaiters.clear();
    };
    const start=task => {
        clearTimeout(task.timer);
        active++;
        Promise.resolve()
            .then(task.work)
            .then(task.resolve,task.reject)
            .finally(() => {
                active--;
                const next=pending.shift();
                if(next) start(next);
                else notifyIdle();
            });
    };

    return {
        close() {
            closed=true;
            notifyIdle();
        },
        onIdle() {
            if(active===0 && pending.length===0) return Promise.resolve();
            return new Promise(resolve => idleWaiters.add(resolve));
        },
        run(work,waitTimeoutMs) {
            if(closed) return Promise.reject(new QueueFullError());
            if(active>=maxConcurrent && pending.length>=maxQueued) {
                return Promise.reject(new QueueFullError());
            }
            return new Promise((resolve,reject) => {
                const task={ reject,resolve,timer:null,work };
                if(active<maxConcurrent) start(task);
                else {
                    task.timer=setTimeout(() => {
                        const index=pending.indexOf(task);
                        if(index===-1) return;
                        pending.splice(index,1);
                        reject(new QueueFullError());
                        notifyIdle();
                    },waitTimeoutMs);
                    task.timer.unref?.();
                    pending.push(task);
                }
            });
        },
    };
}

function isTransientSmtpError(error) {
    if(['EAI_AGAIN','ECONNECTION'].includes(error?.code)) return true;
    return [421,450,451,452].includes(Number(error?.responseCode));
}

function isAmbiguousSmtpError(error) {
    return ['EATTEMPTTIMEOUT','ECONNRESET','ESOCKET','ETIMEDOUT'].includes(error?.code);
}

async function sendWithRetry(transporter,message,config,{ logger,random,sleep,requestId }) {
    for(let attempt=1;attempt<=config.smtpRetryAttempts;attempt++) {
        try {
            const info=await transporter.sendMail(message);
            return { attempts:attempt,info:info || {} };
        } catch(error) {
            if(Array.isArray(error?.accepted) && error.accepted.length) {
                logger.warn?.({
                    accepted:error.accepted.length,
                    attempt,
                    code:error?.code || 'SMTP_PARTIAL',
                    event:'mail.partially_accepted',
                    requestId,
                    retry:false,
                });
                return {
                    attempts:attempt,
                    info:{
                        accepted:error.accepted,
                        rejected:Array.isArray(error.rejected) ? error.rejected:[],
                    },
                    partial:true,
                };
            }
            if(isAmbiguousSmtpError(error)) {
                logger.warn?.({
                    attempt,
                    code:error.code,
                    event:'mail.delivery_uncertain',
                    requestId,
                    retry:false,
                });
                return {
                    attempts:attempt,
                    info:{ accepted:[],rejected:[] },
                    partial:true,
                    uncertain:true,
                };
            }
            const retry=attempt<config.smtpRetryAttempts
                && isTransientSmtpError(error);
            logger.warn?.({
                attempt,
                code:error?.code || 'SMTP_ERROR',
                event:'mail.delivery_failed',
                requestId,
                retry,
                responseCode:Number(error?.responseCode) || undefined,
            });
            if(!retry) throw error;
            const delay=config.smtpRetryBaseMs*(2**(attempt-1))
                + Math.floor(random()*config.smtpRetryBaseMs);
            await sleep(delay);
        }
    }
    throw new Error('SMTP retry loop exhausted');
}

function parseIdempotencyKey(request) {
    const value=request.headers['idempotency-key'];
    if(value===undefined) return null;
    if(typeof value!=='string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
        throw new HttpError(422,'Idempotency-Key must contain 8-128 safe characters');
    }
    return value;
}

function createIdempotencyStore({ maxEntries,now,ttlMs }) {
    const records=new Map();
    const prune=() => {
        const timestamp=now();
        for(const [key,record] of records) {
            if(record.expiresAt<=timestamp) records.delete(key);
        }
    };

    return {
        begin(key,fingerprint,work) {
            if(!key) return { promise:work(),replayed:false };
            prune();
            const existing=records.get(key);
            if(existing) {
                if(existing.fingerprint!==fingerprint) {
                    throw new HttpError(409,'Idempotency-Key was already used for another request');
                }
                return { promise:existing.promise,replayed:true };
            }
            if(records.size>=maxEntries) {
                throw new HttpError(503,'Idempotency cache is full',{ headers:{ 'Retry-After':'5' } });
            }

            const record={ expiresAt:Number.POSITIVE_INFINITY,fingerprint,promise:null };
            record.promise=Promise.resolve()
                .then(work)
                .then(result => {
                    record.expiresAt=now()+ttlMs;
                    return result;
                })
                .catch(error => {
                    records.delete(key);
                    throw error;
                });
            records.set(key,record);
            return { promise:record.promise,replayed:false };
        },
    };
}

function smtpOperationError(message,code) {
    const error=new Error(message);
    error.code=code;
    return error;
}

/**
 * Creates a fresh SMTP connection for every verify or delivery operation and
 * enforces one absolute wall-clock deadline across DNS, address fallback,
 * connect, TLS, SMTP commands, and message streaming. Destroying the owned
 * socket prevents a timed-out request from being accepted later.
 */
export function createBoundedSmtpTransport({
    attemptTimeoutMs,
    connectImpl=connectTcp,
    nodemailer,
    smtp,
}) {
    if(!nodemailer || typeof nodemailer.createTransport!=='function'
        || !smtp || typeof smtp!=='object'
        || !Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs<1
        || typeof connectImpl!=='function') {
        throw new TypeError('A Nodemailer implementation, SMTP options, connector, and positive attempt timeout are required');
    }

    let closed=false;
    const activeAborters=new Set();
    const run=async operation => {
        if(closed) throw smtpOperationError('SMTP transport is closed','ECONNECTION');

        const sockets=new Set();
        let aborted=false;
        const transport=nodemailer.createTransport({
            ...smtp,
            pool:false,
            getSocket(options,callback) {
                let callbackFinished=false;
                const finish=(error,value) => {
                    if(callbackFinished) return;
                    callbackFinished=true;
                    callback(error,value);
                };
                if(closed || aborted) {
                    finish(smtpOperationError('SMTP transport is closed','ECONNECTION'));
                    return;
                }

                const configuredHost=String(options.host || '');
                const socketHost=configuredHost.startsWith('[') && configuredHost.endsWith(']')
                    ? configuredHost.slice(1,-1)
                    : configuredHost;
                let socket;
                try {
                    const socketOptions={ host:socketHost,port:options.port };
                    if(options.localAddress) socketOptions.localAddress=options.localAddress;
                    socket=connectImpl(socketOptions);
                } catch(error) {
                    finish(error);
                    return;
                }

                sockets.add(socket);
                socket.once('connect',() => finish(null,{ connection:socket }));
                socket.once('error',error => finish(error));
                socket.once('close',() => sockets.delete(socket));
            },
        });

        let timeout;
        let abort;
        const deadline=new Promise((_,reject) => {
            abort=error => {
                if(aborted) return;
                aborted=true;
                // Reject with our stable classification after closing the
                // socket. Nodemailer mutates socket error objects in-place,
                // so the deadline error itself must never be passed to it.
                for(const socket of sockets) socket.destroy();
                try { transport.close?.(); } catch {}
                reject(error);
            };
            activeAborters.add(abort);
            timeout=setTimeout(
                () => abort(smtpOperationError('SMTP attempt exceeded its absolute deadline','EATTEMPTTIMEOUT')),
                attemptTimeoutMs,
            );
            timeout.unref?.();
        });

        try {
            return await Promise.race([
                Promise.resolve().then(() => operation(transport)),
                deadline,
            ]);
        } finally {
            aborted=true;
            clearTimeout(timeout);
            activeAborters.delete(abort);
            for(const socket of sockets) socket.destroy();
            try { transport.close?.(); } catch {}
        }
    };

    return {
        close() {
            if(closed) return;
            closed=true;
            const error=smtpOperationError('SMTP transport closed during an operation','ECONNECTION');
            for(const abort of [...activeAborters]) abort(error);
        },
        sendMail(message) {
            return run(transport => transport.sendMail(message));
        },
        verify() {
            return run(transport => transport.verify());
        },
    };
}

/**
 * Creates an API-only mail gateway. The SMTP transport is injected so tests do
 * not require credentials or network access.
 */
export function createMailGateway({
    config,
    logger=console,
    now=Date.now,
    random=Math.random,
    sleep=duration => new Promise(resolve => setTimeout(resolve,duration)),
    transporter,
}) {
    if(!config || !transporter || typeof transporter.sendMail!=='function') {
        throw new TypeError('config and an SMTP transporter are required');
    }

    const drainTimeoutMs=Number.isSafeInteger(config.drainTimeoutMs)
        ? config.drainTimeoutMs
        : calculateDrainTimeoutMs(config);
    const state={ ready:false,shuttingDown:false };
    let activeBodyReads=0;
    const cleanups=[];
    const queue=createWorkQueue(config.maxConcurrentSends,config.maxQueuedSends);
    const rateLimiter=createRateLimiter({
        max:config.rateLimitMax,
        now,
        windowMs:config.rateLimitWindowMs,
    });
    const idempotency=createIdempotencyStore({
        maxEntries:config.idempotencyMaxEntries,
        now,
        ttlMs:config.idempotencyTtlMs,
    });

    const deliver=async (mail,idempotencyKey,fingerprint,requestId,appName) => {
        const messageIdSeed=idempotencyKey
            ? `${appName}:${idempotencyKey}:${fingerprint}`
            : `${appName}:${requestId}`;
        const message={
            bcc:mail.recipients,
            disableFileAccess:true,
            disableUrlAccess:true,
            from:config.senders[mail.type],
            messageId:`<${hash(messageIdSeed).slice(0,40)}@${config.messageIdDomain}>`,
            subject:mail.subject,
            to:'undisclosed-recipients:;',
        };
        if(mail.text) message.text=mail.text;
        if(mail.html) message.html=mail.html;
        const startedAt=now();

        try {
            const { attempts,info,partial=false,uncertain=false }=await sendWithRetry(transporter,message,config,{
                logger,random,requestId,sleep,
            });
            const rejected=Array.isArray(info.rejected) ? info.rejected.length : 0;
            const accepted=Array.isArray(info.accepted) ? info.accepted.length : undefined;
            if(rejected>0 && accepted===0) {
                const error=new Error('All recipients were rejected');
                error.code='EALLREJECTED';
                throw error;
            }
            const status=partial || rejected ? 207 : 202;
            logger.info?.({
                accepted,
                attempts,
                durationMs:Math.max(0,now()-startedAt),
                event:uncertain
                    ? 'mail.delivery_uncertain'
                    : partial || rejected ? 'mail.partially_accepted' : 'mail.accepted',
                appName,
                rejected,
                requestId,
            });
            return {
                body:{
                    accepted,
                    rejected,
                    requestId,
                    status:uncertain
                        ? 'delivery_uncertain'
                        : partial || rejected ? 'partially_accepted' : 'accepted',
                },
                status,
            };
        } catch(error) {
            logger.error?.({
                code:error?.code || 'SMTP_ERROR',
                event:'mail.rejected',
                appName,
                requestId,
                responseCode:Number(error?.responseCode) || undefined,
            });
            throw new HttpError(502,'Mail provider rejected the request');
        }
    };

    const route=async (request,response) => {
        setBaseHeaders(response);

        let url;
        try {
            url=new URL(request.url,'http://mail.local');
        } catch {
            throw new HttpError(400,'Invalid request URL');
        }

        if(url.search || ![config.mailPath,config.healthPath,config.readyPath].includes(url.pathname)) {
            throw new HttpError(404,'Not found');
        }

        if(url.pathname===config.healthPath || url.pathname===config.readyPath) {
            if(request.method!=='GET') {
                throw new HttpError(405,'Method not allowed',{ headers:{ Allow:'GET' } });
            }
            if(url.pathname===config.healthPath) {
                writeJson(response,200,{ status:'ok' });
            } else {
                writeJson(response,state.ready && !state.shuttingDown ? 200 : 503,{
                    status:state.ready && !state.shuttingDown ? 'ready' : 'unavailable',
                });
            }
            return;
        }

        if(!applyCors(request,response,config.allowedOrigins)) {
            throw new HttpError(403,'Origin is not permitted');
        }
        if(request.method==='OPTIONS') {
            response.statusCode=204;
            response.end();
            return;
        }
        if(request.method!=='POST') {
            throw new HttpError(405,'Method not allowed',{ headers:{ Allow:'POST, OPTIONS' } });
        }
        if(state.shuttingDown) {
            throw new HttpError(503,'Server is shutting down',{ headers:{ 'Retry-After':'5' } });
        }
        if(!state.ready) {
            throw new HttpError(503,'Mail provider is unavailable',{ headers:{ 'Retry-After':'5' } });
        }

        const appName=authorizedApplication(request,config);
        if(!appName) {
            throw new HttpError(401,'Mail request is not authorized');
        }

        const rate=rateLimiter.consume(`${appName}:${clientKey(request,config.trustProxy)}`);
        if(!rate.allowed) {
            throw new HttpError(429,'Rate limit exceeded',{
                headers:{ 'Retry-After':String(rate.retryAfter) },
            });
        }

        if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
            throw new HttpError(415,'Content-Type must be application/json');
        }

        if(activeBodyReads>=Math.max(2,config.maxConcurrentSends)) {
            throw new HttpError(503,'Too many request bodies are being processed',{
                headers:{ 'Retry-After':'2' },
            });
        }

        let raw;
        activeBodyReads++;
        try {
            raw=await readJson(request,{
                limitBytes:config.bodyLimitBytes,
                timeoutMs:config.requestTimeoutMs,
            });
        } finally {
            activeBodyReads--;
        }
        const mail=validatePayload(raw,config);
        const idempotencyKey=parseIdempotencyKey(request);
        const fingerprint=fingerprintMail({...mail,appName});
        const requestId=randomUUID();

        let delivery;
        try {
            delivery=idempotency.begin(
                idempotencyKey ? `${appName}:${idempotencyKey}`:null,
                fingerprint,
                () => queue.run(
                    () => deliver(mail,idempotencyKey,fingerprint,requestId,appName),
                    config.requestTimeoutMs,
                ),
            );
        } catch(error) {
            throw error;
        }

        let result;
        try {
            result=await delivery.promise;
        } catch(error) {
            if(error instanceof QueueFullError) {
                throw new HttpError(503,'Delivery queue is full',{ headers:{ 'Retry-After':'2' } });
            }
            throw error;
        }

        writeJson(response,result.status,{
            ...result.body,
            ...(delivery.replayed ? { replayed:true } : {}),
        });
    };

    const handle=(request,response) => {
        return route(request,response).catch(error => {
            const known=error instanceof HttpError;
            if(!request.complete) {
                response.setHeader('Connection','close');
                request.resume();
            }
            if(!known) {
                logger.error?.({
                    code:error?.code || 'UNEXPECTED_ERROR',
                    event:'mail.request_failed',
                });
            }
            writeJson(
                response,
                known ? error.status : 500,
                { error:known ? error.message : 'Internal server error' },
                known ? error.headers : {},
            );
        });
    };

    const server=createServer((request,response) => {
        void handle(request,response);
    });

    server.maxHeadersCount=50;
    server.maxRequestsPerSocket=100;
    server.requestTimeout=config.requestTimeoutMs;
    server.headersTimeout=Math.min(10_000,config.requestTimeoutMs);
    server.keepAliveTimeout=5_000;
    server.on('clientError',(error,socket) => {
        logger.warn?.({ code:error?.code || 'CLIENT_ERROR',event:'mail.client_error' });
        if(socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });

    return {
        addCleanup(cleanup) {
            cleanups.push(cleanup);
        },
        drainTimeoutMs,
        async close() {
            state.shuttingDown=true;
            queue.close();
            let closeError;
            try {
                const serverClose=server.listening
                    ? new Promise((resolve,reject) => {
                        server.close(error => error ? reject(error) : resolve());
                    })
                    : Promise.resolve();
                await queue.onIdle();
                server.closeIdleConnections?.();
                await serverClose;
                for(const cleanup of cleanups.splice(0)) await cleanup();
            } catch(error) {
                closeError=error;
            } finally {
                transporter.close?.();
            }
            if(closeError) throw closeError;
        },
        listen(port=config.port,host=config.host) {
            return new Promise((resolve,reject) => {
                const onError=error => {
                    server.off('listening',onListening);
                    reject(error);
                };
                const onListening=() => {
                    server.off('error',onError);
                    resolve(server.address());
                };
                server.once('error',onError);
                server.once('listening',onListening);
                server.listen(port,host);
            });
        },
        handle,
        handles(pathname) {
            return pathname===config.mailPath
                || pathname===config.healthPath
                || pathname===config.readyPath;
        },
        paths:Object.freeze({
            health:config.healthPath,
            mail:config.mailPath,
            ready:config.readyPath,
        }),
        server,
        setReady(value) {
            state.ready=Boolean(value);
        },
    };
}

export async function startFromEnvironment(env=process.env,{ logger=console,listen=true }={}) {
    const config=loadConfig(env);
    const { default:nodemailer }=await import('nodemailer');
    const transporter=createBoundedSmtpTransport({
        attemptTimeoutMs:config.smtpAttemptTimeoutMs,
        nodemailer,
        smtp:config.smtp,
    });

    try {
        await transporter.verify();
    } catch(error) {
        transporter.close?.();
        throw error;
    }
    const gateway=createMailGateway({ config,logger,transporter });
    gateway.setReady(true);
    if(listen) {
        try {
            await gateway.listen();
        } catch(error) {
            await gateway.close();
            throw error;
        }
    }

    let stopped=false;
    let verifyTimer;
    const verify=async () => {
        try {
            await transporter.verify();
            gateway.setReady(true);
        } catch(error) {
            gateway.setReady(false);
            logger.warn?.({ code:error?.code || 'SMTP_VERIFY_FAILED',event:'mail.not_ready' });
        } finally {
            if(!stopped) {
                verifyTimer=setTimeout(verify,config.verifyIntervalMs);
                verifyTimer.unref?.();
            }
        }
    };
    verifyTimer=setTimeout(verify,config.verifyIntervalMs);
    verifyTimer.unref?.();
    gateway.addCleanup(() => {
        stopped=true;
        clearTimeout(verifyTimer);
    });

    logger.info?.(listen
        ? { event:'mail.listening',host:config.host,port:config.port }
        : { event:'mail.ready',mode:'composed' });
    return gateway;
}

async function run() {
    let gateway;
    let shuttingDown=false;
    let shutdownDeadline;
    let shutdownPromise;

    const shutdown=async signal => {
        if(shuttingDown) return;
        shuttingDown=true;
        console.info({ event:'mail.shutdown',signal });
        shutdownDeadline=setTimeout(() => {
            console.error({ event:'mail.shutdown_timeout' });
            process.exit(1);
        },gateway?.drainTimeoutMs || 30_000);
        shutdownDeadline.unref?.();
        if(!gateway) return;
        try {
            shutdownPromise=gateway.close();
            await shutdownPromise;
            clearTimeout(shutdownDeadline);
        } catch(error) {
            console.error({ code:error?.code || 'SHUTDOWN_FAILED',event:'mail.shutdown_failed' });
            process.exitCode=1;
        }
    };

    process.once('SIGINT',() => { void shutdown('SIGINT'); });
    process.once('SIGTERM',() => { void shutdown('SIGTERM'); });

    try {
        gateway=await startFromEnvironment();
        if(shuttingDown) {
            shutdownPromise ||= gateway.close();
            await shutdownPromise;
            clearTimeout(shutdownDeadline);
        }
    } catch(error) {
        clearTimeout(shutdownDeadline);
        console.error({
            event:'mail.start_failed',
            message:error instanceof ConfigurationError ? error.message : 'Unable to start mail gateway',
        });
        process.exitCode=1;
    }
}

const isMain=process.argv[1]
    && import.meta.url===pathToFileURL(process.argv[1]).href;
if(isMain) void run();
