import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
    readMethodPolicies,
    renderAndroidApplicationRegistry,
    renderAndroidCapabilityRegistry,
    renderCoreMethodPolicies,
    validateMethodPolicies,
} from './method-policies.mjs';

const moduleFile = fileURLToPath(import.meta.url);
const moduleDirectory = path.dirname(moduleFile);
const root = path.resolve(
    moduleDirectory,
    '..'
);

test(
    'canonical registry preserves the exact current method authority surface',
    async function testCanonicalRegistry() {
        const policies = await readMethodPolicies(root);
        assert.equal(
            Object.keys(
                policies
            ).length,
            76
        );
        assert.deepEqual(
            policies['system.ping'],
            {
                hosts: [
                    'android',
                    'core'
                ]
            }
        );
        assert.deepEqual(
            policies['platform.status'],
            {
                capability: 'system.read',
                hosts: [
                    'android',
                    'core'
                ]
            }
        );
        assert.deepEqual(
            policies['external.open'],
            {
                capability: 'external.open',
                hosts: [
                    'android',
                    'core'
                ]
            }
        );
        assert.deepEqual(
            policies['network.status'],
            {
                capability: 'network.status.read',
                hosts: [
                    'android',
                    'core'
                ]
            }
        );
        assert.deepEqual(
            policies['users.add'],
            {
                capability: 'users.manage',
                appTypes: [
                    'provisioner'
                ],
                privileged: true,
                exclusiveMutation: true
            }
        );
    }
);

test(
    'Android shell authority is generated from the canonical application manifest',
    async function testAndroidApplicationGeneration() {
        const policies = await readMethodPolicies(root);
        const manifestText = await fs.readFile(
            path.join(
                root,
                'arcane-bundle.json'
            ),
            'utf8'
        );
        const bundleManifest = JSON.parse(manifestText);
        const generatedPath = path.join(
            root,
            'src',
            'hosts',
            'android',
            'GeneratedAndroidApplicationRegistry.kt'
        );
        const generated = await fs.readFile(
            generatedPath,
            'utf8'
        );
        assert.equal(
            generated,
            renderAndroidApplicationRegistry(
                bundleManifest,
                policies
            )
        );
        assert.match(generated, /SHELL_ENTRY = "shell\/index\.html"/);
        assert.match(generated, /internal fun shellGrants\(\): Set<String>/);
        assert.match(generated, /GeneratedAndroidCapabilityRegistry\.PLATFORM_STATUS_CAPABILITY/);
        assert.match(generated, /GeneratedAndroidCapabilityRegistry\.NETWORK_STATUS_CAPABILITY/);
        assert.match(generated, /Collections\.unmodifiableSet\(grants\)/);
        assert.doesNotMatch(generated, /EXTERNAL_OPEN_CAPABILITY/);
    }
);

test(
    'Core rendering freezes policies and omits host-generation metadata',
    async function testCoreRendering() {
        const policies = await readMethodPolicies(root);
        const sandbox = {
        };
        const renderedPolicies = renderCoreMethodPolicies(policies);
        vm.runInNewContext(
            `globalThis.policies=${renderedPolicies};`,
            sandbox
        );
        const policiesAreFrozen = Object.isFrozen(sandbox.policies);
        const platformPolicyIsFrozen = Object.isFrozen(sandbox.policies['platform.status']);
        const userAppTypesAreFrozen = Object.isFrozen(sandbox.policies['users.add'].appTypes);
        const appListIdsAreFrozen = Object.isFrozen(sandbox.policies['apps.list'].appIds);
        const platformPolicyHasHosts = Object.hasOwn(
            sandbox.policies['platform.status'],
            'hosts'
        );
        assert.equal(policiesAreFrozen, true);
        assert.equal(platformPolicyIsFrozen, true);
        assert.equal(userAppTypesAreFrozen, true);
        assert.equal(appListIdsAreFrozen, true);
        assert.equal(sandbox.policies['platform.status'].capability, 'system.read');
        assert.equal(platformPolicyHasHosts, false);
        assert.throws(
            function mutateAppTypes() {
                sandbox.policies['users.add'].appTypes.push('shell');
            },
            {
                name: 'TypeError'
            }
        );
        assert.deepEqual(
            Array.from(
                sandbox.policies['users.add'].appTypes
            ),
            [
                'provisioner'
            ]
        );
    }
);

test(
    'registry validation rejects ambiguous or broadened authority metadata',
    function testRegistryValidation() {
        const invalidPolicies = [
            {
                'platform.status': {
                    capability: 'system.read',
                    unknown: true
                }
            },
            {
                'platform.status': {
                    capability: 'system.read',
                    privileged: false
                }
            },
            {
                'platform.status': {
                    capability: 'system.read',
                    appIds: [
                        'shell',
                        'settings'
                    ]
                }
            },
            {
                'platform.status': {
                    capability: 'system.read',
                    hosts: [
                        'android'
                    ]
                }
            },
            {
                'Platform.Status': {
                    capability: 'system.read'
                }
            }
        ];

        for (const invalid of invalidPolicies) {
            assert.throws(
                function validateInvalidRegistry() {
                    validateMethodPolicies(invalid);
                },
                /Invalid Arcane method policy registry/
            );
        }
    }
);

test(
    'Android generated constants match the canonical host policy exactly',
    async function testAndroidGeneration() {
        const policies = await readMethodPolicies(root);
        const generatedPath = path.join(
            root,
            'src',
            'hosts',
            'android',
            'GeneratedAndroidCapabilityRegistry.kt'
        );
        const generated = await fs.readFile(
            generatedPath,
            'utf8'
        );
        assert.equal(
            generated,
            renderAndroidCapabilityRegistry(
                policies
            )
        );
        assert.match(generated, /PLATFORM_STATUS_METHOD = "platform\.status"/);
        assert.match(generated, /SYSTEM_PING_METHOD = "system\.ping"/);
        assert.match(generated, /internal fun isSupported\(method: String\): Boolean/);
        assert.match(generated, /PLATFORM_STATUS_CAPABILITY = "system\.read"/);
        assert.match(generated, /EXTERNAL_OPEN_METHOD = "external\.open"/);
        assert.match(generated, /EXTERNAL_OPEN_CAPABILITY = "external\.open"/);
        assert.match(generated, /NETWORK_STATUS_METHOD = "network\.status"/);
        assert.match(generated, /NETWORK_STATUS_CAPABILITY = "network\.status\.read"/);
        assert.match(generated, /methods = listOf\(APP_CURRENT_METHOD, APPS_LAUNCH_METHOD, APPS_LIST_METHOD, EXTERNAL_OPEN_METHOD, NETWORK_STATUS_METHOD, PLATFORM_STATUS_METHOD, SYSTEM_PING_METHOD, USER_CURRENT_METHOD, VERSION_CURRENT_METHOD\)/);
        assert.match(generated, /if \(method == APPS_LAUNCH_METHOD\) return applicationId in setOf\("shell", "terminal"\)/);
    }
);

test(
    'Android registry generation scales from policy data without handwritten method branches',
    async function testScalableAndroidGeneration() {
        const sourcePolicies = await readMethodPolicies(root);
        const policies = structuredClone(sourcePolicies);
        const manifestText = await fs.readFile(
            path.join(
                root,
                'arcane-bundle.json'
            ),
            'utf8'
        );
        const bundleManifest = JSON.parse(manifestText);
        policies['appearance.current'].hosts = [
            'android',
            'core'
        ];
        policies['version.current'].hosts = [
            'android',
            'core'
        ];
        const generated = renderAndroidCapabilityRegistry(policies);
        assert.match(generated, /APPEARANCE_CURRENT_METHOD = "appearance\.current"/);
        assert.match(generated, /APPEARANCE_CURRENT_CAPABILITY = "appearance\.read"/);
        assert.match(generated, /VERSION_CURRENT_METHOD = "version\.current"/);
        assert.doesNotMatch(generated, /VERSION_CURRENT_CAPABILITY/);
        assert.match(generated, /if \(method == APPEARANCE_CURRENT_METHOD\) return APPEARANCE_CURRENT_CAPABILITY/);
        assert.match(generated, /methods = listOf\(APP_CURRENT_METHOD, APPEARANCE_CURRENT_METHOD, APPS_LAUNCH_METHOD, APPS_LIST_METHOD, EXTERNAL_OPEN_METHOD, NETWORK_STATUS_METHOD, PLATFORM_STATUS_METHOD, SYSTEM_PING_METHOD, USER_CURRENT_METHOD, VERSION_CURRENT_METHOD\)/);
        const applicationRegistry = renderAndroidApplicationRegistry(bundleManifest, policies);
        assert.match(applicationRegistry, /GeneratedAndroidCapabilityRegistry\.APPEARANCE_CURRENT_CAPABILITY/);
        assert.doesNotMatch(applicationRegistry, /VERSION_CURRENT_CAPABILITY/);
    }
);
