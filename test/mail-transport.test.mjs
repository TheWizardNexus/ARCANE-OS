import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe,it } from 'node:test';

import { resolveMailConfig } from '../arcane/modules/Mail.js';
import {
    normalizeMailEndpoint,
    sendMailReport,
} from '../arcane/modules/MailTransport.mjs';

const TEST_ENDPOINT='https://mail.example.test/v1/mail';

function createTestTransportConfig(){
    return {
        appKey:'private-test-key',
        appName:'arcane-test',
        endpoint:TEST_ENDPOINT,
    };
}

describe('Arcane OS mail transport', () => {

    it('adds the configured app headers and idempotency key automatically', async () => {
        let captured;
        const config=createTestTransportConfig();
        const result=await sendMailReport({
            ...config,
            fetchImpl:async (endpoint,options) => {
                captured={ endpoint,options };
                return new Response(
                    JSON.stringify({ requestId:'request-123',status:'accepted' }),
                    { status:202,headers:{ 'Content-Type':'application/json' } }
                );
            },
            report:{
                subject:'Safety update',
                text:'Plain text',
                to:['person@example.test'],
                type:'report',
            },
            reportKey:'report-request-001',
        });

        assert.equal(captured.endpoint,TEST_ENDPOINT);
        assert.equal(captured.options.method,'POST');
        assert.equal(captured.options.credentials,'same-origin');
        assert.equal(captured.options.redirect,'error');
        assert.equal(captured.options.referrerPolicy,'no-referrer');
        assert.deepEqual(captured.options.headers,{
            'Content-Type':'application/json',
            'Idempotency-Key':'report-request-001',
            'X-Mail-App':config.appName,
            'X-Mail-Key':config.appKey,
        });
        assert.deepEqual(JSON.parse(captured.options.body),{
            subject:'Safety update',
            text:'Plain text',
            to:['person@example.test'],
            type:'report',
        });
        assert.deepEqual(result,{
            requestId:'request-123',
            sent:true,
            partial:false,
            uncertain:false,
            status:'accepted',
            statusCode:202,
        });
    });

    it('uses keyless loopback delivery locally and same-origin delivery when hosted', async () => {
        const document={
            querySelector:selector => selector==='meta[name="arcane-app-id"]'
                ? { content:'precrisis' }
                : null,
        };
        const hosted=resolveMailConfig({}, {
            document,
            location:{
                href:'https://app.precrisis.ai/chat.html',
                hostname:'app.precrisis.ai',
                origin:'https://app.precrisis.ai',
                port:'',
                protocol:'https:',
            },
        });
        const local=resolveMailConfig({}, {
            document,
            location:{
                href:'http://localhost:8000/apps/precrisis/chat.html',
                hostname:'localhost',
                origin:'http://localhost:8000',
                port:'8000',
                protocol:'http:',
            },
        });

        assert.equal(hosted.appName,'precrisis');
        assert.equal(hosted.appKey,'');
        assert.equal(hosted.endpoint,'https://app.precrisis.ai/v1/mail');
        assert.equal(hosted.requestTimeout,590_000);
        assert.equal(local.endpoint,'http://localhost:8025/v1/mail');
        assert.equal(local.requestTimeout,590_000);
        assert.equal(resolveMailConfig({}, {
            document,
            location:{
                href:'http://127.0.0.1:8000/apps/precrisis/chat.html',
                hostname:'127.0.0.1',
                origin:'http://127.0.0.1:8000',
                port:'8000',
                protocol:'http:',
            },
        }).endpoint,'http://127.0.0.1:8025/v1/mail');
        assert.equal(resolveMailConfig({}, {
            document,
            location:{
                href:'http://[::1]:8000/apps/precrisis/chat.html',
                hostname:'[::1]',
                origin:'http://[::1]:8000',
                port:'8000',
                protocol:'http:',
            },
        }).endpoint,'http://[::1]:8025/v1/mail');

        let headers;
        const result=await sendMailReport({
            ...local,
            fetchImpl:async (_endpoint,options) => {
                headers=options.headers;
                return new Response(
                    JSON.stringify({ requestId:'request-local-1',status:'accepted' }),
                    { status:202 },
                );
            },
            report:{ subject:'Local report',text:'Synthetic',to:['user@example.test'],type:'report' },
            reportKey:'local-report-001',
        });

        assert.equal('X-Mail-Key' in headers,false);
        assert.equal(headers['X-Mail-App'],'precrisis');
        assert.equal(result.sent,true);
    });

    it('reports partial and uncertain provider outcomes without claiming delivery', async () => {
        for(const [status,requestId,expected] of [
            ['partially_accepted','request-partial-1',{ partial:true,uncertain:false }],
            ['delivery_uncertain','request-uncertain-1',{ partial:false,uncertain:true }],
        ]){
            const result=await sendMailReport({
                ...createTestTransportConfig(),
                fetchImpl:async () => new Response(
                    JSON.stringify({ accepted:1,rejected:1,requestId,status }),
                    { status:207 },
                ),
                report:{ subject:'Safety update',text:'Plain text',to:['person@example.test'],type:'report' },
                reportKey:`report-${status}`,
            });

            assert.equal(result.sent,false);
            assert.equal(result.partial,expected.partial);
            assert.equal(result.uncertain,expected.uncertain);
            assert.equal(result.status,status);
            assert.equal(result.statusCode,207);
        }
    });

    it('keeps the PreCrisis crisis recovery path visible unless delivery is fully accepted', async () => {
        const sources=await Promise.all([
            readFile(new URL('../apps/precrisis/chat.html',import.meta.url),'utf8'),
            readFile(new URL('../apps/warrior-spirit/companion.html',import.meta.url),'utf8'),
        ]);

        for(const source of sources){
            assert.match(source,/if\(!delivery\.sent\)/);
            assert.match(source,/delivery\.uncertain/);
            assert.match(source,/Support Contact Delivery Was Not Fully Confirmed/);
            assert.match(source,/Speak to Someone Now \(988\)/);
            assert.match(source,/modal\.open\(\)/);
            assert.doesNotMatch(source,/console\.table\(/);
        }
    });

    it('sends deterministic error mail without loading AI or browser storage', async () => {
        const previous={
            arcane:globalThis.arcane,
            fetch:globalThis.fetch,
            location:globalThis.location,
            window:globalThis.window,
        };
        let captured;

        try {
            const config=createTestTransportConfig();
            globalThis.arcane={ config:{ mail:config } };
            globalThis.window={};
            globalThis.location={ pathname:'/chat.html' };
            globalThis.fetch=async (endpoint,options) => {
                captured={ endpoint,options };
                return new Response(
                    JSON.stringify({ requestId:'error-request-1',status:'accepted' }),
                    { status:202,headers:{ 'Content-Type':'application/json' } },
                );
            };

            const moduleUrl=new URL('../arcane/modules/Mail.js',import.meta.url);
            moduleUrl.searchParams.set('test','direct-error');
            await import(moduleUrl);
            const result=await globalThis.window.mail.send(
                [],
                'PRECRISIS JS ERROR',
                { message:'Example failure',stack:'example.js:1' },
                '',
                'error',
            );
            const body=JSON.parse(captured.options.body);

            assert.equal(captured.endpoint,TEST_ENDPOINT);
            assert.equal(captured.options.headers['X-Mail-App'],config.appName);
            assert.equal(captured.options.headers['X-Mail-Key'],config.appKey);
            assert.equal(body.type,'error');
            assert.deepEqual(body.to,[]);
            assert.match(body.text,/Example failure/);
            assert.equal('html' in body,false);
            assert.equal(result.sent,true);
        } finally {
            if(previous.window===undefined) delete globalThis.window;
            else globalThis.window=previous.window;
            if(previous.location===undefined) delete globalThis.location;
            else globalThis.location=previous.location;
            if(previous.arcane===undefined) delete globalThis.arcane;
            else globalThis.arcane=previous.arcane;
            globalThis.fetch=previous.fetch;
        }
    });

    it('rejects non-success responses without leaking the response body', async () => {
        await assert.rejects(
            sendMailReport({
                ...createTestTransportConfig(),
                fetchImpl:async () => new Response(
                    JSON.stringify({ error:'sensitive upstream detail' }),
                    { status:401 }
                ),
                report:{ subject:'Safety update',text:'Plain text',to:[],type:'error' },
                reportKey:'report-request-002',
            }),
            error => error.message==='Mail server rejected the request (401)',
        );
    });

    it('rejects invalid success bodies and contradictory status codes', async () => {
        for(const response of [
            new Response('not-json',{ status:202 }),
            new Response(JSON.stringify({ requestId:'request-123',status:'unknown' }),{ status:202 }),
            new Response(JSON.stringify({ requestId:'request-123',status:'partially_accepted' }),{ status:202 }),
        ]){
            await assert.rejects(
                sendMailReport({
                    ...createTestTransportConfig(),
                    fetchImpl:async () => response,
                    report:{ subject:'Safety update',text:'Plain text',to:[],type:'error' },
                    reportKey:'report-request-003',
                }),
                error => error.message==='Mail server returned an invalid success response',
            );
        }
    });

    it('validates endpoint, idempotency key, timeout, and serializable report before fetch', async () => {
        assert.equal(
            normalizeMailEndpoint('/v1/mail','https://app.example.test/chat.html'),
            'https://app.example.test/v1/mail',
        );
        assert.throws(
            () => normalizeMailEndpoint('http://app.example.test/v1/mail'),
            /HTTPS or loopback HTTP/,
        );

        const cyclic={};
        cyclic.self=cyclic;
        for(const override of [
            { reportKey:'short' },
            { requestTimeout:0 },
            { report:cyclic },
        ]){
            await assert.rejects(sendMailReport({
                ...createTestTransportConfig(),
                fetchImpl:async () => { throw new Error('fetch must not run'); },
                report:{ subject:'Safety update',text:'Plain text',to:[],type:'error' },
                reportKey:'report-request-004',
                ...override,
            }));
        }
    });
});
