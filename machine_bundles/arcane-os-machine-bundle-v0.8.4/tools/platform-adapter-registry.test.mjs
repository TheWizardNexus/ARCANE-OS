import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = path.dirname(toolsRoot);
const registryPath = path.join(bundleRoot, 'src', 'native', 'platform-adapters.cjs');
const runtimePath = path.join(bundleRoot, 'runtime', 'arcane-core.cjs');
const coreTemplatePath = path.join(bundleRoot, 'src', 'core', 'arcane-core.template.cjs');

function loadRegistry() {
    const calls = [];
    const source = readFileSync(registryPath, 'utf8');
    const sandbox = {
        createLinuxNativeAdapter: function createLinuxNativeAdapter(context) {
            calls.push(
                {
                    context,
                    factory: 'linux'
                }
            );
            return {
                context,
                factory: 'linux'
            };
        },
        createWindowsNativeAdapter: function createWindowsNativeAdapter(context) {
            calls.push(
                {
                    context,
                    factory: 'windows'
                }
            );
            return {
                context,
                factory: 'windows'
            };
        }
    };
    vm.runInNewContext(
        `${source}\nglobalThis.registryApi={createCoreNativeAdapter,listSupportedCorePlatforms};`,
        sandbox,
        {
            filename: registryPath
        }
    );
    return {
        calls,
        createCoreNativeAdapter: sandbox.registryApi.createCoreNativeAdapter,
        listSupportedCorePlatforms: sandbox.registryApi.listSupportedCorePlatforms
    };
}

function runCore(argumentsToAdd, environmentToAdd) {
    if (!existsSync(runtimePath)) {
        return null;
    }

    const environment = Object.assign(
        {},
        process.env,
        {
            ARCANE_SIMULATE_PLATFORM: '',
            ARCANE_SIMULATE_PROVISIONING: '0'
        },
        environmentToAdd
    );
    return spawnSync(
        process.execPath,
        [
            runtimePath,
            '--app=shell',
            `--bundle-root=${bundleRoot}`,
            ...argumentsToAdd
        ],
        {
            cwd: bundleRoot,
            encoding: 'utf8',
            env: environment,
            timeout: 10000,
            windowsHide: true
        }
    );
}

function assertCoreRejection(argumentsToAdd, environmentToAdd, diagnostic) {
    const result = runCore(argumentsToAdd, environmentToAdd);
    if (result === null) {
        return;
    }

    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 4);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), diagnostic);
}

function assertUnsupportedRuntimePlatform(platform) {
    assertCoreRejection(
        [
            '--simulate',
            `--simulate-platform=${platform}`
        ],
        {},
        `Arcane Core does not yet support ${platform}.`
    );
}

test('registry exposes the exact frozen canonical platform list', function testCanonicalPlatformList() {
    const registry = loadRegistry();
    const first = registry.listSupportedCorePlatforms();
    const second = registry.listSupportedCorePlatforms();

    assert.deepEqual(Array.from(first), ['win32', 'linux']);
    assert.equal(first, second);
    assert.equal(Object.isFrozen(first), true);
    assert.throws(
        function mutateSupportedPlatforms() {
            first.push('android');
        },
        {
            name: 'TypeError'
        }
    );
});

test('registry dispatches each platform to only its exact factory', function testFactoryDispatch() {
    const registry = loadRegistry();
    const windowsContext = {request: 'windows'};
    const linuxContext = {request: 'linux'};

    assert.deepEqual(
        registry.createCoreNativeAdapter('win32', windowsContext),
        {
            context: windowsContext,
            factory: 'windows'
        }
    );
    assert.deepEqual(
        registry.createCoreNativeAdapter('linux', linuxContext),
        {
            context: linuxContext,
            factory: 'linux'
        }
    );
    assert.deepEqual(
        registry.calls,
        [
            {
                context: windowsContext,
                factory: 'windows'
            },
            {
                context: linuxContext,
                factory: 'linux'
            }
        ]
    );
});

test('registry rejects invalid platform and context inputs before dispatch', function testInvalidInputs() {
    const registry = loadRegistry();
    const invalidPlatforms = [
        undefined,
        null,
        1,
        1n,
        false,
        Symbol('platform'),
        {},
        [],
        function invalidPlatform() {}
    ];
    const invalidContexts = [
        undefined,
        null,
        'context',
        1,
        1n,
        false,
        Symbol('context'),
        [],
        function invalidContext() {}
    ];

    for (const platform of invalidPlatforms) {
        assert.throws(
            function createWithInvalidPlatform() {
                registry.createCoreNativeAdapter(platform, {});
            },
            {
                message: 'Core platform must be a string.',
                name: 'TypeError'
            }
        );
    }
    for (const context of invalidContexts) {
        assert.throws(
            function createWithInvalidContext() {
                registry.createCoreNativeAdapter('win32', context);
            },
            {
                message: 'Native adapter context must be an object.',
                name: 'TypeError'
            }
        );
    }
    assert.deepEqual(registry.calls, []);
});

test('registry fails closed for Android and unknown platform names', function testUnsupportedPlatforms() {
    const registry = loadRegistry();

    assert.equal(registry.createCoreNativeAdapter('android', {}), null);
    assert.equal(registry.createCoreNativeAdapter('plan9', {}), null);
    assert.equal(registry.createCoreNativeAdapter('constructor', {}), null);
    assert.equal(registry.createCoreNativeAdapter('__proto__', {}), null);
    assert.deepEqual(registry.calls, []);
});

test('Core source keeps simulation evidence separate from publisher evidence', function testSimulationEvidenceSource() {
    const source = readFileSync(coreTemplatePath, 'utf8');

    assert.match(
        source,
        /const assignedSecurityMode = simulate \? 'simulation' : installedReleaseSecurityMode\(\);/
    );
    assert.doesNotMatch(
        source,
        /simulate\s*\?\s*['"]publisher-verified['"]/
    );
    assert.doesNotMatch(
        source,
        /if\s*\(\s*simulate\s*\)[\s\S]{0,200}?assignedSecurityMode\s*=\s*['"]publisher-verified['"]/
    );
});

test('platform status source distinguishes host, effective platform, and evidence class', function testPlatformStatusSource() {
    const source = readFileSync(coreTemplatePath, 'utf8');

    assert.match(source, /function platformExecutionContext\(\)/);
    assert.match(source, /hostPlatform,/);
    assert.match(source, /effectivePlatform: platform,/);
    assert.match(source, /simulation: simulate,/);
    assert.match(source, /evidenceClass: simulate \? 'simulation' : 'real-host',/);
    assert.match(source, /execution: platformExecutionContext\(\),/);
});

test('generated Core exits instead of falling back for unsupported platforms', function testCoreUnsupportedPlatforms() {
    assertUnsupportedRuntimePlatform('android');
    assertUnsupportedRuntimePlatform('plan9');
    assertUnsupportedRuntimePlatform('windows');
    assertUnsupportedRuntimePlatform('WIN32');
    assertUnsupportedRuntimePlatform(' win32 ');
});

test('generated Core rejects simulation platform selection outside simulation', function testSimulationRequired() {
    assertCoreRejection(
        [
            '--simulate-platform=linux'
        ],
        {},
        'Arcane Core accepts a simulated platform only when simulation is enabled.'
    );
});

test('generated Core rejects duplicate simulation platform arguments', function testDuplicateSimulationPlatforms() {
    assertCoreRejection(
        [
            '--simulate',
            '--simulate-platform=win32',
            '--simulate-platform=linux'
        ],
        {},
        'Arcane Core accepts exactly one simulated platform argument.'
    );
});

test('generated Core rejects conflicting argument and environment platforms', function testSimulationPlatformConflict() {
    assertCoreRejection(
        [
            '--simulate',
            '--simulate-platform=win32'
        ],
        {
            ARCANE_SIMULATE_PLATFORM: 'linux'
        },
        'Arcane Core rejected conflicting simulated platform settings.'
    );
});
