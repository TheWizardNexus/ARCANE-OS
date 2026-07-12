import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
    ConfigurationError,
    DEFAULT_ERROR_RECIPIENTS,
    DEFAULT_SENDERS,
    MAIL_APP_KEY,
    MAIL_APP_NAME,
    MAIL_TYPES,
    createMailGateway,
    loadConfig,
} from '../../mailer.js';

const ORIGIN='https://app.example.test';
const runningGateways=[];

function config(overrides={}) {
    return {
        appKey:MAIL_APP_KEY,
        appName:MAIL_APP_NAME,
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
        'x-mail-app':MAIL_APP_NAME,
        'x-mail-key':MAIL_APP_KEY,
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

    it('uses the default category senders, error recipients, and large limits', () => {
        const loaded=loadConfig({
            MAIL_ALLOWED_ORIGINS:`${ORIGIN},null`,
            MAIL_SMTP_PASS:'not-a-real-password',
            MAIL_SMTP_USER:'alerts@example.test',
        });

        assert.equal(loaded.host,'127.0.0.1');
        assert.equal(loaded.smtp.secure,true);
        assert.equal(loaded.allowedOrigins.has('null'),true);
        assert.deepEqual(loaded.errorRecipients,[...DEFAULT_ERROR_RECIPIENTS]);
        assert.deepEqual(loaded.senders,DEFAULT_SENDERS);
        assert.equal(loaded.maxMessageBytes,25*1024*1024);
        assert.equal(loaded.bodyLimitBytes,52*1024*1024);
        assert.ok(loaded.bodyLimitBytes>loaded.maxMessageBytes*2);
        assert.equal(loaded.maxQueuedSends,2);
    });

    it('rejects an envelope too small for worst-case JSON escaping', () => {
        assert.throws(
            () => loadConfig({
                MAIL_BODY_LIMIT_BYTES:String(26*1024*1024),
                MAIL_MAX_MESSAGE_BYTES:String(25*1024*1024),
                MAIL_SMTP_PASS:'not-a-real-password',
                MAIL_SMTP_USER:'alerts@example.test',
            }),
            error => error instanceof ConfigurationError
                && error.message.includes('twice MAIL_MAX_MESSAGE_BYTES'),
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

        assert.equal(forbidden.status,403);
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
            body:JSON.stringify(payload({ text:'é'.repeat(33) })),
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
    it('awaits SMTP and returns a deterministic upstream failure', async () => {
        let release;
        let markStarted;
        const pending=new Promise(resolve => { release=resolve; });
        const started=new Promise(resolve => { markStarted=resolve; });
        const { url }=await start({
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

        assert.equal(health.status,200);
        assert.deepEqual(await health.json(),{ status:'ok' });
        assert.equal(ready.status,200);
        assert.equal(notReady.status,503);
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
