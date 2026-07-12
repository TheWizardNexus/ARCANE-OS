import assert from 'node:assert/strict';
import { describe,it } from 'node:test';

import { sendMailReport } from '../arcane/modules/MailTransport.mjs';

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
            status:'accepted',
            statusCode:202,
        });
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
});
