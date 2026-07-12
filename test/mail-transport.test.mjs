import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe,it } from 'node:test';

import { MAIL_APP_KEY,MAIL_APP_NAME } from '../../../mail-auth.js';
import { sendMailReport } from '../modules/MailTransport.mjs';

describe('Nelson mail transport', () => {
    it('keeps the temporary Nelson class defaults aligned with the gateway', async () => {
        const source=await readFile(
            new URL('../modules/Mail.js',import.meta.url),
            'utf8'
        );

        assert.equal(source.includes(`this.appName='${MAIL_APP_NAME}'`),true);
        assert.equal(source.includes(`this.appKey='${MAIL_APP_KEY}'`),true);
        assert.match(source,/messageType=''\)/);
        assert.doesNotMatch(source,/messageType='report'/);
        assert.match(source,/if\(messageType==='error'\)/);
    });

    it('adds the configured app headers and idempotency key automatically', async () => {
        let captured;
        const result=await sendMailReport({
            appKey:'private-test-key',
            appName:'nelson',
            endpoint:'https://mail.example.test/v1/mail',
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

        assert.equal(captured.endpoint,'https://mail.example.test/v1/mail');
        assert.equal(captured.options.method,'POST');
        assert.deepEqual(captured.options.headers,{
            'Content-Type':'application/json',
            'Idempotency-Key':'report-request-001',
            'X-Mail-App':'nelson',
            'X-Mail-Key':'private-test-key',
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
            fetch:globalThis.fetch,
            location:globalThis.location,
            window:globalThis.window,
        };
        let captured;

        try {
            globalThis.window={};
            globalThis.location={ pathname:'/chat.html' };
            globalThis.fetch=async (endpoint,options) => {
                captured={ endpoint,options };
                return new Response(
                    JSON.stringify({ requestId:'error-request-1',status:'accepted' }),
                    { status:202,headers:{ 'Content-Type':'application/json' } },
                );
            };

            const moduleUrl=new URL('../modules/Mail.js',import.meta.url);
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
            globalThis.fetch=previous.fetch;
        }
    });

    it('rejects non-success responses without leaking the response body', async () => {
        await assert.rejects(
            sendMailReport({
                appKey:'private-test-key',
                appName:'nelson',
                endpoint:'https://mail.example.test/v1/mail',
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
