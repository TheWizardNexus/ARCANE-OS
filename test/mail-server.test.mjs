import assert from 'node:assert/strict';
import { createServer as createTcpServer } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import {
    ConfigurationError,
    MAIL_TYPES,
    createBoundedSmtpTransport,
    createMailGateway,
    loadConfig,
} from '../arcane/server/MailGateway.mjs';

const ORIGIN='https://app.example.test';
const LOCAL_ORIGIN='http://127.0.0.1:8080';
const TEST_APP_NAME='precrisis-test';
const TEST_APP_KEY='synthetic-mail-key-for-tests-only-0000000000000000000000000000';
const SECOND_APP_NAME='warrior-spirit-test';
const SECOND_APP_KEY='second-synthetic-mail-key-for-tests-only-000000000000000000';
const runningGateways=[];

function config(overrides={}) {
    return {
        appKeys:new Map([[TEST_APP_NAME,TEST_APP_KEY]]),
        allowedOrigins:new Set([ORIGIN]),
        bodyLimitBytes:1024,
        errorRecipients:[
            'error-one@example.test',
            'error-two@example.test',
            'error-three@example.test',
        ],
        healthPath:'/healthz',
        idempotencyMaxEntries:100,
        idempotencyTtlMs:60_000,
        localDevelopmentApps:new Set(),
        localDevelopmentOriginAuth:false,
        mailPath:'/v1/mail',
        maxConcurrentSends:1,
        maxMessageBytes:500,
        maxQueuedSends:1,
        maxRecipients:10,
        maxSubjectLength:160,
        messageIdDomain:'example.test',
        rateLimitMax:20,
        rateLimitWindowMs:60_000,
        readyPath:'/readyz',
        requestTimeoutMs:2_000,
        senders:{
            error:'errors@example.test',
            report:'reports@example.test',
            crisis_detected:'crisis@example.test',
        },
        smtp:{
            connectionTimeout:100,
            greetingTimeout:100,
            socketTimeout:100,
        },
        smtpAttemptTimeoutMs:300,
        smtpRetryBaseMs:1,
        smtpRetryAttempts:2,
        trustProxy:false,
        ...overrides,
    };
}

function makeTransport(sendMail=async () => ({
    accepted:['contact@example.test'],
    rejected:[],
    response:'250 queued',
})) {
    return {
        close() {},
        sendMail,
    };
}

async function start({ gatewayConfig=config(), sendMail, logger,transporter }={}) {
    const gateway=createMailGateway({
        config:gatewayConfig,
        logger:logger || { error() {}, info() {}, warn() {} },
        sleep:async () => {},
        transporter:transporter || makeTransport(sendMail),
    });

    gateway.setReady(true);
    await gateway.listen(0,'127.0.0.1');
    runningGateways.push(gateway);

    const address=gateway.server.address();
    return {
        gateway,
        url:`http://127.0.0.1:${address.port}`,
    };
}

function headers(overrides={}) {
    return {
        'content-type':'application/json',
        origin:ORIGIN,
        'x-mail-app':TEST_APP_NAME,
        'x-mail-key':TEST_APP_KEY,
        ...overrides,
    };
}

function payload(overrides={}) {
    return {
        subject:'Safety update',
        text:'A concise plain-text update.',
        to:['contact@example.test'],
        type:'report',
        ...overrides,
    };
}

function environment(overrides={}) {
    return {
        MAIL_ALLOWED_ORIGINS:ORIGIN,
        MAIL_APP_KEYS:JSON.stringify({ [TEST_APP_NAME]:TEST_APP_KEY }),
        MAIL_ERROR_RECIPIENTS:'errors@example.test',
        MAIL_SMTP_HOST:'smtp.example.test',
        MAIL_SMTP_PASS:'not-a-real-password',
        MAIL_SMTP_USER:'alerts@example.test',
        ...overrides,
    };
}

afterEach(async () => {
    await Promise.all(runningGateways.splice(0).map(gateway => gateway.close()));
});

describe('configuration', () => {
    it('fails closed when required SMTP secrets are missing', () => {
        assert.throws(
            () => loadConfig({}),
            error => error instanceof ConfigurationError
                && error.message.includes('MAIL_SMTP_PASS')
                && error.message.includes('MAIL_SMTP_USER'),
        );
    });

    it('fails closed without production application keys or required error routing', () => {
        assert.throws(
            () => loadConfig(environment({ MAIL_ALLOWED_ORIGINS:'',MAIL_APP_KEYS:'',MAIL_ERROR_RECIPIENTS:'' })),
            error => error instanceof ConfigurationError
                && error.message.includes('MAIL_APP_KEYS is required')
                && error.message.includes('MAIL_ERROR_RECIPIENTS is required')
                && error.message.includes('MAIL_ALLOWED_ORIGINS is required'),
        );
    });

    it('uses the SMTP identity as each default sender and keeps large message limits', () => {
        const loaded=loadConfig(environment({
            MAIL_ALLOWED_ORIGINS:`${ORIGIN},null`,
        }));

        assert.equal(loaded.host,'127.0.0.1');
        assert.equal(loaded.port,8025);
        assert.equal(loaded.smtp.secure,true);
        assert.equal(loaded.allowedOrigins.has('null'),true);
        assert.deepEqual(loaded.errorRecipients,['errors@example.test']);
        assert.deepEqual(loaded.senders,{
            error:'alerts@example.test',
            report:'alerts@example.test',
            crisis_detected:'alerts@example.test',
        });
        assert.equal(loaded.appKeys.get(TEST_APP_NAME),TEST_APP_KEY);
        assert.equal(loaded.localDevelopmentOriginAuth,false);
        assert.equal(loaded.maxMessageBytes,25*1024*1024);
        assert.equal(loaded.bodyLimitBytes,52*1024*1024);
        assert.ok(loaded.bodyLimitBytes>loaded.maxMessageBytes*2);
        assert.equal(loaded.drainTimeoutMs,425_500);
        assert.equal(loaded.maxQueuedSends,2);
    });

    it('allows keyless authentication only in explicit loopback development mode', () => {
        const loaded=loadConfig(environment({
            MAIL_ALLOWED_ORIGINS:LOCAL_ORIGIN,
            MAIL_APP_KEYS:'',
            MAIL_LOCAL_DEVELOPMENT_APPS:TEST_APP_NAME,
            MAIL_LOCAL_DEVELOPMENT_ORIGIN_AUTH:'true',
        }));

        assert.equal(loaded.appKeys.size,0);
        assert.equal(loaded.localDevelopmentOriginAuth,true);
        assert.equal(loaded.localDevelopmentApps.has(TEST_APP_NAME),true);
        assert.deepEqual([...loaded.allowedOrigins],[LOCAL_ORIGIN]);

        const ipv6=loadConfig(environment({
            MAIL_ALLOWED_ORIGINS:'http://[::1]:8080',
            MAIL_APP_KEYS:'',
            MAIL_HOST:'::1',
            MAIL_LOCAL_DEVELOPMENT_APPS:TEST_APP_NAME,
            MAIL_LOCAL_DEVELOPMENT_ORIGIN_AUTH:'true',
        }));
        assert.equal(ipv6.allowedOrigins.has('http://[::1]:8080'),true);
    });

    it('rejects keyless development mode outside an explicit loopback boundary', () => {
        for(const invalid of [
            { MAIL_HOST:'0.0.0.0' },
            { MAIL_ALLOWED_ORIGINS:ORIGIN },
            { MAIL_LOCAL_DEVELOPMENT_APPS:'' },
        ]) {
            assert.throws(
                () => loadConfig(environment({
                    MAIL_ALLOWED_ORIGINS:LOCAL_ORIGIN,
                    MAIL_APP_KEYS:'',
                    MAIL_LOCAL_DEVELOPMENT_APPS:TEST_APP_NAME,
                    MAIL_LOCAL_DEVELOPMENT_ORIGIN_AUTH:'true',
                    ...invalid,
                })),
                ConfigurationError,
            );
        }
    });

    it('rejects weak, malformed, and conflicting application key configuration', () => {
        for(const invalid of [
            { MAIL_APP_KEYS:'not-json' },
            { MAIL_APP_KEYS:JSON.stringify({ [TEST_APP_NAME]:'too-short' }) },
            {
                MAIL_APP_KEY:'different-key-000000000000000000000000000000000000',
                MAIL_APP_NAME:TEST_APP_NAME,
            },
        ]) {
            assert.throws(() => loadConfig(environment(invalid)),ConfigurationError);
        }
    });

    it('keeps the listener loopback-only and bounds endpoint configuration strings', () => {
        for(const invalid of [
            { MAIL_HOST:'0.0.0.0' },
            { MAIL_PATH:'/v1/mail?debug=true' },
            { MAIL_SMTP_HOST:'https://smtp.example.test' },
            { MAIL_SMTP_PASS:`valid${String.fromCharCode(10)}injected` },
            { MAIL_MESSAGE_ID_DOMAIN:'-invalid.example.test' },
        ]){
            assert.throws(() => loadConfig(environment(invalid)),ConfigurationError);
        }
    });

    it('rejects an envelope too small for worst-case JSON escaping', () => {
        assert.throws(
            () => loadConfig(environment({
                MAIL_BODY_LIMIT_BYTES:String(26*1024*1024),
                MAIL_MAX_MESSAGE_BYTES:String(25*1024*1024),
            })),
            error => error instanceof ConfigurationError
                && error.message.includes('twice MAIL_MAX_MESSAGE_BYTES'),
        );
    });

    it('rejects timeout overrides that can outlive the proxy or browser', () => {
        assert.throws(
            () => loadConfig(environment({ MAIL_REQUEST_TIMEOUT_MS:'200000' })),
            error => error instanceof ConfigurationError
                && error.message.includes('timeout settings exceed'),
        );
        assert.throws(
            () => loadConfig(environment({ MAIL_SMTP_ATTEMPT_TIMEOUT_MS:'1000' })),
            error => error instanceof ConfigurationError
                && error.message.includes('stage timeouts must not exceed'),
        );
    });
});

describe('HTTP and authorization boundary', () => {
    it('rejects unauthenticated requests without touching SMTP', async () => {
        let calls=0;
        const { url }=await start({
            gatewayConfig:config({ rateLimitMax:1 }),
            sendMail:async () => {
                calls++;
                return { accepted:['team@example.test'],rejected:[] };
            },
        });

        for(const invalidHeaders of [
            { 'x-mail-app':undefined },
            { 'x-mail-app':'wrong-app' },
            { 'x-mail-key':undefined },
            { 'x-mail-key':'wrong-key' },
        ]) {
            const response=await fetch(`${url}/v1/mail`,{
                method:'POST',
                headers:headers(invalidHeaders),
                body:JSON.stringify(payload()),
            });
            assert.equal(response.status,401);
            assert.equal(response.headers.get('access-control-allow-origin'),ORIGIN);
            assert.equal(response.headers.get('cache-control'),'no-store');
        }

        const authorized=await fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers(),
            body:JSON.stringify(payload()),
        });
        assert.equal(authorized.status,202);
        assert.equal(calls,1);
    });

    it('accepts keyless loopback development requests and rejects cross-site claims', async () => {
        let calls=0;
        const { url }=await start({
            gatewayConfig:config({
                allowedOrigins:new Set([LOCAL_ORIGIN]),
                appKeys:new Map(),
                localDevelopmentApps:new Set([TEST_APP_NAME]),
                localDevelopmentOriginAuth:true,
            }),
            sendMail:async message => {
                calls++;
                return { accepted:message.bcc,rejected:[] };
            },
        });
        const localHeaders={
            'content-type':'application/json',
            origin:LOCAL_ORIGIN,
            'x-mail-app':TEST_APP_NAME,
        };

        const accepted=await fetch(`${url}/v1/mail`,{
            method:'POST',headers:localHeaders,body:JSON.stringify(payload()),
        });
        const crossSite=await fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:{ ...localHeaders,'sec-fetch-site':'cross-site' },
            body:JSON.stringify(payload()),
        });
        const wrongApp=await fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:{ ...localHeaders,'x-mail-app':'unlisted-app' },
            body:JSON.stringify(payload()),
        });

        assert.equal(accepted.status,202);
        assert.equal(crossSite.status,401);
        assert.equal(wrongApp.status,401);
        assert.equal(calls,1);
    });

    it('isolates production keys and idempotency records by application', async () => {
        let calls=0;
        const { url }=await start({
            gatewayConfig:config({
                appKeys:new Map([
                    [TEST_APP_NAME,TEST_APP_KEY],
                    [SECOND_APP_NAME,SECOND_APP_KEY],
                ]),
            }),
            sendMail:async message => {
                calls++;
                return { accepted:message.bcc,rejected:[] };
            },
        });
        const idempotencyKey='shared-request-key';
        const first=await fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers({ 'idempotency-key':idempotencyKey }),
            body:JSON.stringify(payload()),
        });
        const second=await fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers({
                'idempotency-key':idempotencyKey,
                'x-mail-app':SECOND_APP_NAME,
                'x-mail-key':SECOND_APP_KEY,
            }),
            body:JSON.stringify(payload()),
        });
        const crossedKey=await fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers({
                'x-mail-app':SECOND_APP_NAME,
                'x-mail-key':TEST_APP_KEY,
            }),
            body:JSON.stringify(payload()),
        });

        assert.equal(first.status,202);
        assert.equal(second.status,202);
        assert.equal(crossedKey.status,401);
        assert.equal(calls,2);
    });

    it('rejects disallowed origins and non-POST methods', async () => {
        let calls=0;
        const { url }=await start({ sendMail:async () => { calls++; } });
        const forbidden=await fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers({ origin:'https://evil.example' }),
            body:JSON.stringify(payload()),
        });
        const wrongMethod=await fetch(`${url}/v1/mail`,{
            method:'GET',
            headers:headers(),
        });
        const noOriginHeaders=headers();
        delete noOriginHeaders.origin;
        const missingOrigin=await fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:noOriginHeaders,
            body:JSON.stringify(payload()),
        });

        assert.equal(forbidden.status,403);
        assert.equal(missingOrigin.status,403);
        assert.equal(wrongMethod.status,405);
        assert.equal(wrongMethod.headers.get('allow'),'POST, OPTIONS');
        assert.equal(calls,0);
    });

    it('handles allowed CORS preflight without authentication', async () => {
        const { url }=await start();
        const response=await fetch(`${url}/v1/mail`,{
            method:'OPTIONS',
            headers:{ origin:ORIGIN },
        });

        assert.equal(response.status,204);
        assert.equal(response.headers.get('access-control-allow-origin'),ORIGIN);
        assert.match(response.headers.get('access-control-allow-headers'),/X-Mail-Key/i);
        assert.equal(response.headers.get('vary'),'Origin');
    });

    it('supports the Electron null origin only when explicitly allowed', async () => {
        const { url }=await start({
            gatewayConfig:config({ allowedOrigins:new Set(['null']) }),
        });
        const response=await fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers({ origin:'null' }),
            body:JSON.stringify(payload()),
        });

        assert.equal(response.status,202);
        assert.equal(response.headers.get('access-control-allow-origin'),'null');
    });
});

describe('input validation and category routing', () => {
    it('rejects malformed, null, and oversized JSON deterministically', async () => {
        let calls=0;
        const { url }=await start({ sendMail:async () => { calls++; } });

        const malformed=await fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers(),
            body:'{',
        });
        const nullBody=await fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers(),
            body:'null',
        });
        const oversized=await fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers(),
            body:JSON.stringify(payload({ text:'x'.repeat(2_000) })),
        });

        assert.equal(malformed.status,400);
        assert.equal(nullBody.status,422);
        assert.equal(oversized.status,413);
        assert.equal(calls,0);
    });

    it('blocks address-parser abuse, header injection, and caller-controlled mail fields', async () => {
        let calls=0;
        const { url }=await start({ sendMail:async () => { calls++; } });

        for(const invalidPayload of [
            payload({ to:'contact@example.test' }),
            payload({ to:['g0: g1: victim@example.test;'] }),
            payload({ subject:'Hello\r\nBcc: attacker@evil.example' }),
            payload({ text:'Invalid\u0000control' }),
            { ...payload(), from:'attacker@evil.example' },
            { ...payload(), headers:{ Bcc:'attacker@evil.example' } },
            { ...payload(), envelope:{ to:'attacker@evil.example' } },
            { ...payload(), attachments:[] },
        ]) {
            const response=await fetch(`${url}/v1/mail`,{
                method:'POST',
                headers:headers(),
                body:JSON.stringify(invalidPayload),
            });
            assert.equal(response.status,422);
        }

        assert.equal(calls,0);
    });

    it('delivers to any valid recipient supplied by an authenticated caller', async () => {
        let message;
        const { url }=await start({
            sendMail:async value => {
                message=value;
                return { accepted:value.bcc,rejected:[] };
            },
        });

        const response=await fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers(),
            body:JSON.stringify(payload({ to:['outside@example.org'] })),
        });

        assert.equal(response.status,202);
        assert.deepEqual(message.bcc,['outside@example.org']);
    });

    it('rejects missing or unknown categories and recipientless non-error mail', async () => {
        let calls=0;
        const { url }=await start({ sendMail:async () => { calls++; } });
        const { type:_type,...withoutType }=payload();

        for(const invalidPayload of [
            withoutType,
            payload({ type:'other' }),
            payload({ type:'crisis' }),
            payload({ to:[] }),
        ]) {
            const response=await fetch(`${url}/v1/mail`,{
                method:'POST',
                headers:headers(),
                body:JSON.stringify(invalidPayload),
            });
            assert.equal(response.status,422);
        }

        assert.equal(calls,0);
    });

    it('enforces the raw recipient count before normalization and deduplication', async () => {
        let calls=0;
        const { url }=await start({
            gatewayConfig:config({ maxRecipients:2 }),
            sendMail:async () => { calls++; },
        });
        const response=await fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers(),
            body:JSON.stringify(payload({
                to:[
                    'contact@example.test',
                    'CONTACT@example.test',
                    'contact@example.test',
                ],
            })),
        });

        assert.equal(response.status,422);
        assert.equal(calls,0);
    });

    it('selects the sender by category and adds fixed recipients only to errors', async () => {
        const messages=[];
        const { url }=await start({
            sendMail:async message => {
                messages.push(message);
                return { accepted:message.bcc,rejected:[] };
            },
        });

        for(const messagePayload of [
            payload({ to:['report-reader@example.org'],type:MAIL_TYPES.report }),
            payload({ to:['support-person@example.org'],type:MAIL_TYPES.crisisDetected }),
            payload({ to:['request-owner@example.org'],type:MAIL_TYPES.error }),
            payload({ to:[],type:MAIL_TYPES.error }),
        ]) {
            const response=await fetch(`${url}/v1/mail`,{
                method:'POST',
                headers:headers(),
                body:JSON.stringify(messagePayload),
            });
            assert.equal(response.status,202);
        }

        assert.equal(messages[0].from,'reports@example.test');
        assert.deepEqual(messages[0].bcc,['report-reader@example.org']);
        assert.equal(messages[1].from,'crisis@example.test');
        assert.deepEqual(messages[1].bcc,['support-person@example.org']);
        assert.equal(messages[2].from,'errors@example.test');
        assert.deepEqual(messages[2].bcc,[
            'request-owner@example.org',
            'error-one@example.test',
            'error-two@example.test',
            'error-three@example.test',
        ]);
        assert.deepEqual(messages[3].bcc,config().errorRecipients);
    });

    it('supports text, HTML, or both and enforces a combined UTF-8 byte limit', async () => {
        const messages=[];
        const { url }=await start({
            gatewayConfig:config({ maxMessageBytes:64 }),
            sendMail:async message => {
                messages.push(message);
                return { accepted:message.bcc,rejected:[] };
            },
        });

        const html='<table><tr><td>Private report</td></tr></table>';
        const htmlOnly=await fetch(`${url}/v1/mail`,{
            method:'POST',headers:headers(),
            body:JSON.stringify(payload({ html,text:undefined })),
        });
        const both=await fetch(`${url}/v1/mail`,{
            method:'POST',headers:headers(),
            body:JSON.stringify(payload({ html:'<b>OK</b>',text:'Fallback' })),
        });
        const tooLarge=await fetch(`${url}/v1/mail`,{
            method:'POST',headers:headers(),
            body:JSON.stringify(payload({ text:'\u00e9'.repeat(33) })),
        });

        assert.equal(htmlOnly.status,202);
        assert.equal(messages[0].html,html);
        assert.equal('text' in messages[0],false);
        assert.equal(both.status,202);
        assert.equal(messages[1].html,'<b>OK</b>');
        assert.equal(messages[1].text,'Fallback');
        assert.equal(tooLarge.status,422);
        assert.equal(messages.length,2);
    });

    it('sends plain text to deduplicated BCC recipients only', async () => {
        let message;
        const { url }=await start({
            sendMail:async value => {
                message=value;
                return {
                    accepted:['contact@example.test'],
                    rejected:[],
                };
            },
        });

        const response=await fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers({ 'idempotency-key':'safe-request-001' }),
            body:JSON.stringify(payload({
                text:'<img src=x onerror=alert(1)>',
                to:['contact@example.test','CONTACT@example.test'],
            })),
        });

        assert.equal(response.status,202);
        assert.deepEqual(message.bcc,['contact@example.test']);
        assert.equal(message.from,'reports@example.test');
        assert.equal(message.text,'<img src=x onerror=alert(1)>');
        assert.equal('html' in message,false);
        assert.equal('attachments' in message,false);
        assert.equal('envelope' in message,false);
        assert.equal(message.disableFileAccess,true);
        assert.equal(message.disableUrlAccess,true);
        assert.match(message.messageId,/^<[a-f0-9]+@example\.test>$/);
    });
});

describe('delivery reliability controls', () => {
    it('enforces one absolute SMTP deadline and destroys the owned connection', async () => {
        let acceptConnection;
        const acceptedConnection=new Promise(resolve => { acceptConnection=resolve; });
        const smtpServer=createTcpServer(socket => {
            const closed=new Promise(resolve => socket.once('close',resolve));
            acceptConnection(closed);
        });
        await new Promise((resolve,reject) => {
            smtpServer.once('error',reject);
            smtpServer.listen(0,'127.0.0.1',resolve);
        });

        const { default:nodemailer }=await import('nodemailer');
        const transporter=createBoundedSmtpTransport({
            attemptTimeoutMs:100,
            nodemailer,
            smtp:{
                connectionTimeout:200,
                dnsTimeout:200,
                greetingTimeout:200,
                host:'127.0.0.1',
                port:smtpServer.address().port,
                requireTLS:false,
                secure:false,
                socketTimeout:200,
                tls:{ minVersion:'TLSv1.2',rejectUnauthorized:true },
            },
        });
        try {
            const startedAt=Date.now();
            const delivery=transporter.sendMail({
                from:'sender@example.test',
                subject:'Bounded test',
                text:'Synthetic test content',
                to:'recipient@example.test',
            });
            const rejected=assert.rejects(
                delivery,
                error => error?.code==='EATTEMPTTIMEOUT',
            );
            const closed=await acceptedConnection;
            await rejected;
            await closed;
            assert.ok(Date.now()-startedAt<1_000);
        } finally {
            transporter.close();
            await new Promise(resolve => smtpServer.close(resolve));
        }
    });

    it('awaits SMTP and returns a deterministic upstream failure', async () => {
        const events=[];
        let release;
        let markStarted;
        const pending=new Promise(resolve => { release=resolve; });
        const started=new Promise(resolve => { markStarted=resolve; });
        const { url }=await start({
            logger:{
                error:event => events.push(event),
                info:event => events.push(event),
                warn:event => events.push(event),
            },
            sendMail:async () => {
                markStarted();
                await pending;
                const error=new Error('authentication failed for secret-address@example.test');
                error.code='EAUTH';
                throw error;
            },
        });

        let settled=false;
        const responsePromise=fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers(),
            body:JSON.stringify(payload()),
        }).then(response => {
            settled=true;
            return response;
        });

        await started;
        assert.equal(settled,false);
        release();
        const response=await responsePromise;
        assert.equal(response.status,502);
        assert.doesNotMatch(await response.text(),/secret-address/);
        const logged=JSON.stringify(events);
        assert.doesNotMatch(logged,/secret-address|contact@example\.test|A concise plain-text update/);
        assert.equal(logged.includes(TEST_APP_KEY),false);
    });

    it('retries bounded transient SMTP failures but not permanent failures', async () => {
        let transientCalls=0;
        const transient=await start({
            sendMail:async () => {
                transientCalls++;
                if(transientCalls===1) {
                    const error=new Error('temporary outage');
                    error.responseCode=421;
                    throw error;
                }
                return { accepted:['team@example.test'], rejected:[] };
            },
        });
        const transientResponse=await fetch(`${transient.url}/v1/mail`,{
            method:'POST',
            headers:headers(),
            body:JSON.stringify(payload()),
        });

        let permanentCalls=0;
        const permanent=await start({
            sendMail:async () => {
                permanentCalls++;
                const error=new Error('bad credentials');
                error.code='EAUTH';
                throw error;
            },
        });
        const permanentResponse=await fetch(`${permanent.url}/v1/mail`,{
            method:'POST',
            headers:headers(),
            body:JSON.stringify(payload()),
        });

        assert.equal(transientResponse.status,202);
        assert.equal(transientCalls,2);
        assert.equal(permanentResponse.status,502);
        assert.equal(permanentCalls,1);
    });

    it('does not retry or forget an uncertain partial acceptance', async () => {
        let calls=0;
        const { url }=await start({
            sendMail:async () => {
                calls++;
                const error=new Error('connection closed after partial acceptance');
                error.code='ECONNRESET';
                error.accepted=['team@example.test'];
                error.rejected=['contact@example.test'];
                throw error;
            },
        });
        const request=() => fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers({ 'idempotency-key':'partial-request-001' }),
            body:JSON.stringify(payload()),
        });

        const first=await request();
        const second=await request();

        assert.equal(first.status,207);
        assert.equal(second.status,207);
        assert.equal((await second.json()).replayed,true);
        assert.equal(calls,1);
    });

    it('does not retry an ambiguous disconnect without acceptance metadata', async () => {
        let calls=0;
        const { url }=await start({
            sendMail:async () => {
                calls++;
                const error=new Error('socket closed after DATA');
                error.code='ECONNRESET';
                throw error;
            },
        });
        const request=() => fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers({ 'idempotency-key':'ambiguous-request-001' }),
            body:JSON.stringify(payload()),
        });

        const first=await request();
        const second=await request();
        const secondBody=await second.json();

        assert.equal(first.status,207);
        assert.equal(second.status,207);
        assert.equal(secondBody.status,'delivery_uncertain');
        assert.equal(secondBody.replayed,true);
        assert.equal(calls,1);
    });

    it('returns an upstream failure when every recipient is rejected', async () => {
        const { url }=await start({
            sendMail:async () => ({
                accepted:[],
                rejected:['team@example.test','contact@example.test'],
            }),
        });
        const response=await fetch(`${url}/v1/mail`,{
            method:'POST',headers:headers(),body:JSON.stringify(payload()),
        });

        assert.equal(response.status,502);
    });

    it('deduplicates concurrent and completed idempotent requests', async () => {
        let calls=0;
        const { url }=await start({
            sendMail:async () => {
                calls++;
                await new Promise(resolve => setImmediate(resolve));
                return { accepted:['team@example.test'], rejected:[] };
            },
        });
        const request=() => fetch(`${url}/v1/mail`,{
            method:'POST',
            headers:headers({ 'idempotency-key':'same-request-001' }),
            body:JSON.stringify(payload()),
        });

        const [first,second]=await Promise.all([request(),request()]);
        const third=await request();

        assert.deepEqual([first.status,second.status,third.status],[202,202,202]);
        assert.equal(calls,1);
        assert.equal((await third.json()).replayed,true);
    });

    it('applies bounded queue backpressure and per-client rate limits', async () => {
        let release;
        let markStarted;
        const pending=new Promise(resolve => { release=resolve; });
        const started=new Promise(resolve => { markStarted=resolve; });
        const queueLimited=await start({
            gatewayConfig:config({ maxConcurrentSends:1, maxQueuedSends:0 }),
            sendMail:async () => {
                markStarted();
                await pending;
                return { accepted:['team@example.test'], rejected:[] };
            },
        });
        const first=fetch(`${queueLimited.url}/v1/mail`,{
            method:'POST', headers:headers(), body:JSON.stringify(payload()),
        });
        await started;
        const busy=await fetch(`${queueLimited.url}/v1/mail`,{
            method:'POST', headers:headers(), body:JSON.stringify(payload()),
        });
        release();
        await first;

        const rateLimited=await start({
            gatewayConfig:config({ rateLimitMax:1 }),
        });
        const allowed=await fetch(`${rateLimited.url}/v1/mail`,{
            method:'POST', headers:headers(), body:JSON.stringify(payload()),
        });
        const limited=await fetch(`${rateLimited.url}/v1/mail`,{
            method:'POST', headers:headers(), body:JSON.stringify(payload()),
        });

        assert.equal(busy.status,503);
        assert.equal(allowed.status,202);
        assert.equal(limited.status,429);
        assert.equal(limited.headers.get('retry-after'),'60');
    });

    it('exposes minimal health/readiness and closes gracefully', async () => {
        const { gateway,url }=await start();
        const health=await fetch(`${url}/healthz`);
        const ready=await fetch(`${url}/readyz`);
        gateway.setReady(false);
        const notReady=await fetch(`${url}/readyz`);
        const unavailable=await fetch(`${url}/v1/mail`,{
            method:'POST',headers:headers(),body:JSON.stringify(payload()),
        });

        assert.equal(health.status,200);
        assert.deepEqual(await health.json(),{ status:'ok' });
        assert.equal(ready.status,200);
        assert.equal(notReady.status,503);
        assert.equal(unavailable.status,503);
    });

    it('drains an active delivery before closing the transport', async () => {
        let release;
        let markStarted;
        let transportClosed=false;
        const pending=new Promise(resolve => { release=resolve; });
        const started=new Promise(resolve => { markStarted=resolve; });
        const transporter={
            close() { transportClosed=true; },
            async sendMail() {
                markStarted();
                await pending;
                return { accepted:['team@example.test'],rejected:[] };
            },
        };
        const { gateway,url }=await start({ transporter });
        const responsePromise=fetch(`${url}/v1/mail`,{
            method:'POST',headers:headers(),body:JSON.stringify(payload()),
        });
        await started;

        let closed=false;
        const closePromise=gateway.close().then(() => { closed=true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(closed,false);
        assert.equal(transportClosed,false);

        release();
        const response=await responsePromise;
        await closePromise;
        assert.equal(response.status,202);
        assert.equal(transportClosed,true);
    });
});
