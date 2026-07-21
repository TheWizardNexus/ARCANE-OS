import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
    path.dirname(
        fileURLToPath(
            import.meta.url
        )
    ),
    '..'
);
const fixtures = JSON.parse(
    await fs.readFile(
        path.join(
            root,
            'src',
            'api',
            'shared-method-contract-fixtures.json'
        ),
        'utf8'
    )
);

function createClient(options = {}) {
    const simulatedPlatform = process.platform === 'win32' ? 'win32' : 'linux';
    const simulationArguments = [
        '--simulate'
    ];

    if (options.explicitPlatform !== false) {
        simulationArguments.push(
            `--simulate-platform=${simulatedPlatform}`
        );
    }

    const child = spawn(
        process.execPath,
        [
            path.join(
                root,
                'runtime',
                'arcane-core.cjs'
            ),
            '--app=shell',
            ...simulationArguments,
            '--simulate-capabilities=system.read,network.status.read,external.open,identity.read',
            `--bundle-root=${root}`,
        ],
        {
            stdio: [
                'pipe',
                'pipe',
                'pipe'
            ]
        }
    );
    let buffer = Buffer.alloc(0);
    let expectedLength = null;
    const pending = new Map();
    let stderr = '';

    function rejectPending(error) {
        for (const callback of pending.values()) {
            callback.reject(error);
        }

        pending.clear();
    }

    function consumeOutput(chunk) {
        buffer = Buffer.concat(
            [
                buffer,
                chunk
            ]
        );

        while (true) {
            if (expectedLength === null) {
                const marker = buffer.indexOf('\r\n\r\n');

                if (marker < 0) {
                    return;
                }

                const match = buffer
                    .subarray(
                        0,
                        marker
                    )
                    .toString('ascii')
                    .match(/Content-Length:\s*(\d+)/i);

                if (!match) {
                    return rejectPending(
                        new Error('Arcane response omitted Content-Length.')
                    );
                }

                expectedLength = Number(match[1]);
                buffer = buffer.subarray(marker + 4);
            }

            if (buffer.length < expectedLength) {
                return;
            }

            const response = JSON.parse(
                buffer
                    .subarray(
                        0,
                        expectedLength
                    )
                    .toString('utf8')
            );
            buffer = buffer.subarray(expectedLength);
            expectedLength = null;

            if (response.type !== 'response') {
                continue;
            }

            const callback = pending.get(response.id);

            if (!callback) {
                continue;
            }

            pending.delete(response.id);

            if (response.ok) {
                callback.resolve(response.result);
            } else {
                callback.reject(
                    Object.assign(
                        new Error(response.error.message),
                        response.error
                    )
                );
            }
        }
    }

    function captureError(chunk) {
        stderr = `${stderr}${chunk.toString()}`.slice(-4096);
    }

    function handleExit(code, signal) {
        rejectPending(
            new Error(`Arcane Core exited early code=${code} signal=${signal}. ${stderr}`)
        );
    }

    child.stdout.on(
        'data',
        consumeOutput
    );
    child.stderr.on(
        'data',
        captureError
    );
    child.once(
        'error',
        rejectPending
    );
    child.once(
        'exit',
        handleExit
    );

    function call(method, parameters) {
        const id = crypto.randomUUID();
        const request = {
            protocol: 'arcane/1',
            type: 'request',
            id,
            method,
            parameters
        };
        const body = Buffer.from(
            JSON.stringify(
                request
            )
        );
        const frame = Buffer.concat(
            [
                Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
                body
            ]
        );

        return new Promise(
            function awaitResponse(resolve, reject) {
                const timer = setTimeout(
                    function timeoutRequest() {
                        pending.delete(id);
                        reject(
                            new Error(`Timed out waiting for ${method}. ${stderr}`)
                        );
                    },
                    5000
                );

                function resolveRequest(value) {
                    clearTimeout(timer);
                    resolve(value);
                }

                function rejectRequest(error) {
                    clearTimeout(timer);
                    reject(error);
                }

                pending.set(
                    id,
                    {
                        resolve: resolveRequest,
                        reject: rejectRequest
                    }
                );
                child.stdin.write(frame);
            }
        );
    }

    function close() {
        child.stdin.end();
        child.kill();
    }

    return {
        call,
        close
    };
}

test(
    'Core enforces exact shared contract inputs before dispatch',
    async function testExactInputs() {
        const client = createClient();

        try {
            await assert.rejects(
                client.call(
                    'platform.status',
                    {
                        unexpected: true
                    }
                ),
                {
                    code: 'METHOD_CONTRACT_INPUT_INVALID'
                }
            );
            await assert.rejects(
                client.call(
                    'network.status',
                    null
                ),
                {
                    code: 'METHOD_CONTRACT_INPUT_INVALID'
                }
            );
            await assert.rejects(
                client.call(
                    'external.open',
                    {
                        uri: ' https://example.com'
                    }
                ),
                {
                    code: 'METHOD_CONTRACT_INPUT_INVALID'
                }
            );
            await assert.rejects(
                client.call(
                    'external.open',
                    {
                        uri: 'mailto:test@example.com%0D%0ABcc:other@example.com'
                    }
                ),
                {
                    code: 'METHOD_CONTRACT_INPUT_INVALID'
                }
            );
        } finally {
            client.close();
        }
    }
);

test(
    'Core reports simulation when no platform override is supplied',
    async function testCurrentPlatformSimulationStatus() {
        const client = createClient(
            {
                explicitPlatform: false
            }
        );

        try {
            const platform = await client.call(
                'platform.status',
                {
                }
            );

            assert.equal(
                platform.simulated,
                true
            );
            assert.equal(
                platform.execution.simulation,
                true
            );
            assert.equal(
                platform.execution.evidenceClass,
                'simulation'
            );
        } finally {
            client.close();
        }
    }
);

test(
    'Core accepts valid status outputs and never simulates an external handoff',
    async function testOutputsAndSimulation() {
        const client = createClient();

        try {
            const platform = await client.call(
                'platform.status',
                {
                }
            );
            assert.equal(
                platform.protocol,
                'arcane/1'
            );
            assert.equal(
                platform.application,
                platform.capabilities.app.id
            );
            const network = await client.call(
                'network.status',
                {
                }
            );
            assert.equal(
                network.online,
                network.interfaceCount > 0
            );
            assert.deepEqual(
                await client.call(
                    'system.ping',
                    {
                    }
                ),
                {
                    ok: true
                }
            );
            const version = await client.call(
                'version.current',
                {
                }
            );
            const app = await client.call(
                'app.current',
                {
                }
            );
            const user = await client.call(
                'user.current',
                {
                }
            );
            assert.equal(
                version,
                '0.8.4'
            );
            assert.equal(
                app.version,
                version
            );
            assert.equal(
                app.id,
                platform.capabilities.app.id
            );
            assert.deepEqual(
                app,
                platform.capabilities.app
            );
            assert.equal(
                user.identityKind,
                'host-account'
            );
            assert.equal(
                ['windows', 'linux'].includes(user.source),
                true
            );
            assert.equal(
                typeof user.username,
                'string'
            );
            assert.equal(
                Object.hasOwn(user, 'computerName'),
                false
            );
            assert.equal(
                Object.hasOwn(user, 'domain'),
                false
            );
            assert.deepEqual(
                Object.keys(app).sort(),
                [
                    'displayName',
                    'entry',
                    'id',
                    'publisherTrustSource',
                    'revocationStatus',
                    'securityMode',
                    'type',
                    'version'
                ]
            );
            await assert.rejects(
                client.call(
                    'system.ping',
                    {
                        diagnostic: true
                    }
                ),
                {
                    code: 'METHOD_CONTRACT_INPUT_INVALID'
                }
            );
            await assert.rejects(
                client.call(
                    'version.current',
                    {
                        diagnostic: true
                    }
                ),
                {
                    code: 'METHOD_CONTRACT_INPUT_INVALID'
                }
            );
            await assert.rejects(
                client.call(
                    'user.current',
                    {
                        diagnostic: true
                    }
                ),
                {
                    code: 'METHOD_CONTRACT_INPUT_INVALID'
                }
            );
            await assert.rejects(
                client.call(
                    'app.current',
                    null
                ),
                {
                    code: 'METHOD_CONTRACT_INPUT_INVALID'
                }
            );
            await assert.rejects(
                client.call(
                    'external.open',
                    {
                        uri: 'MAILTO:test@example.com?subject=Arcane'
                    }
                ),
                {
                    code: 'EXTERNAL_OPEN_SIMULATED'
                }
            );
        } finally {
            client.close();
        }
    }
);

test(
    'Core consumes the canonical shared request conformance fixtures',
    async function testSharedFixtures() {
        const client = createClient();

        try {
            for (const fixture of fixtures.emptyObject) {
                if (fixture.accepted) {
                    await client.call(
                        'platform.status',
                        fixture.parameters
                    );
                } else {
                    await assert.rejects(
                        client.call(
                            'platform.status',
                            fixture.parameters
                        ),
                        {
                            code: 'METHOD_CONTRACT_INPUT_INVALID'
                        }
                    );
                }
            }

            for (const fixture of fixtures.externalOpen) {
                const request = client.call(
                    'external.open',
                    {
                        uri: fixture.uri
                    }
                );

                if (fixture.accepted) {
                    await assert.rejects(
                        request,
                        {
                            code: 'EXTERNAL_OPEN_SIMULATED'
                        }
                    );
                } else {
                    await assert.rejects(
                        request,
                        {
                            code: 'METHOD_CONTRACT_INPUT_INVALID'
                        }
                    );
                }
            }
        } finally {
            client.close();
        }
    }
);
