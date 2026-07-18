import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {readMethodPolicies} from './method-policies.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function read(relative) {
    return readFile(path.join(root, ...relative.split('/')), 'utf8');
}

test('frontend exposes external.open as one bounded native request', async function testFrontendExternalOpen() {
    const source = await read('src/frontend/shared/arcane-api.js');
    let request;
    const window = {
        __ARCANE_DEV_HTTP__: true,
        crypto: {
            randomUUID: function randomUUID() {
                return 'external-open-request';
            },
        },
    };
    async function fetch(_url, options) {
        request = JSON.parse(options.body);
        return {
            ok: true,
            json: async function json() {
                return {
                    protocol: 'arcane/1',
                    type: 'response',
                    id: request.id,
                    ok: true,
                    result: {
                        opened: true,
                        uri: 'mailto:test@example.com',
                    },
                };
            },
        };
    }
    const context = {
        window,
        fetch,
        console,
        setTimeout,
        clearTimeout,
    };
    const options = {
        filename: 'arcane-api.js',
    };
    vm.runInNewContext(source, context, options);
    const result = await window.Arcane.external.open('mailto:test@example.com');
    assert.equal(request.method, 'external.open');
    assert.deepEqual(
        request.parameters,
        {
            uri: 'mailto:test@example.com',
        }
    );
    assert.deepEqual(
        result,
        {
            opened: true,
            uri: 'mailto:test@example.com',
        }
    );
});

test('core and native adapters enforce the mailto-only external-open contract', async function testExternalOpenContract() {
    const [core, windows, linux, packager, host, targetBuild, policies] = await Promise.all(
        [
            read('src/core/arcane-core.template.cjs'),
            read('src/native/windows.cjs'),
            read('src/native/linux.cjs'),
            read('tools/app-packager-lib.mjs'),
            read('src/hosts/windows/ArcaneHost.cs'),
            read('tools/build-windows-target-app.ps1'),
            readMethodPolicies(root),
        ]
    );
    assert.deepEqual(
        policies['external.open'],
        {
            capability: 'external.open',
            hosts: [
                'android',
                'core',
            ],
        }
    );
    assert.match(core, /case 'external\.open': return openExternalUri\(parameters\)/);
    assert.match(core, /canonicalContractMailto\(value,METHOD_CONTRACTS\['external\.open'\]\.input\)/);
    assert.match(core, /value!==value\.trim\(\)/);
    assert.match(core, /EXTERNAL_SCHEME_NOT_ALLOWED/);
    assert.match(windows, /explorer\.exe/);
    assert.match(windows, /EXTERNAL_OPEN_SIMULATED/);
    assert.doesNotMatch(windows.match(/function openExternalUri[\s\S]*?\n  \}/)?.[0] || '', /cmdExe|powershell|shell:\s*true/);
    assert.match(linux, /ctx\.spawn\(opener, \[uri\]/);
    assert.match(linux, /EXTERNAL_OPEN_SIMULATED/);
    assert.match(packager, /'external\.open'/);
    assert.match(host, /Program\.AllowExternalOpen/);
    assert.match(host, /String\.Equals\(uri\.Scheme, "mailto"/);
    assert.match(host, /UseShellExecute = true/);
    assert.match(targetBuild, /-contains 'external\.open'/);
});
