import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readMethodContracts, renderAndroidMethodContracts, renderCoreMethodContracts, renderMethodContractsJson, validateMethodContracts } from './method-contracts.mjs';
import { readMethodPolicies } from './method-policies.mjs';

const root = path.resolve(
    path.dirname(
        fileURLToPath(import.meta.url)
    ),
    '..'
);

test(
    'semantic contracts are canonical and separate from authority',
    async function testCanonicalContracts() {
        const policies = await readMethodPolicies(root);
        const contracts = await readMethodContracts(root, policies);
        assert.deepEqual(
            Object.keys(contracts),
            [
                'app.current',
                'apps.launch',
                'apps.list',
                'external.open',
                'network.status',
                'platform.status',
                'system.ping',
                'terminal.close',
                'terminal.list',
                'terminal.resize',
                'terminal.signal',
                'terminal.start',
                'terminal.write',
                'user.current',
                'version.current'
            ]
        );
        for (const contract of Object.values(
            contracts
        )) {
            for (const authorityField of [
                'appIds',
                'appTypes',
                'capability',
                'exclusiveMutation',
                'hosts',
                'privileged'
            ]) {
                assert.equal(
                    Object.hasOwn(
                        contract,
                        authorityField
                    ),
                    false
                );
            }
        }
        assert.equal(
            renderMethodContractsJson(contracts).endsWith('\n'),
            true
        );
        assert.equal(
            Object.isFrozen(contracts),
            true
        );
        assert.equal(
            Object.isFrozen(contracts['external.open'].input),
            true
        );
        assert.match(
            renderCoreMethodContracts(
                contracts,
                policies
            ),
            /^Object\.freeze\(/
        );
        assert.match(
            renderAndroidMethodContracts(
                contracts,
                policies
            ),
            /APPS_LAUNCH_OUTPUT_ACCEPTED_MEANING = "dispatch-request-accepted"/
        );
        assert.match(
            renderAndroidMethodContracts(
                contracts,
                policies
            ),
            /APPS_LIST_OUTPUT_MAX_APPLICATIONS = 256/
        );
        assert.match(
            renderAndroidMethodContracts(
                contracts,
                policies
            ),
            /EXTERNAL_OPEN_INPUT_MAX_URI_LENGTH = 4096/
        );
        assert.match(
            renderAndroidMethodContracts(
                contracts,
                policies
            ),
            /PLATFORM_STATUS_OUTPUT_MAX_STATUS_STRING_LENGTH = 256/
        );
        assert.match(
            renderAndroidMethodContracts(
                contracts,
                policies
            ),
            /APP_CURRENT_OUTPUT_KIND = "application-descriptor-v1"/
        );
        assert.match(
            renderAndroidMethodContracts(
                contracts,
                policies
            ),
            /VERSION_CURRENT_OUTPUT_MAX_LENGTH = 64/
        );
        assert.match(
            renderAndroidMethodContracts(
                contracts,
                policies
            ),
            /TERMINAL_START_INPUT_MAX_CWD_LENGTH = 4096/
        );
    }
);

test(
    'semantic contract validation fails closed on drift and authority injection',
    async function testContractValidation() {
        const policies = await readMethodPolicies(root);
        const contracts = await readMethodContracts(root, policies);
        const mutations = [
            function injectAuthority(copy) {
                copy['platform.status'].capability = 'system.read';
            },
            function broadenScheme(copy) {
                copy['external.open'].input.scheme = 'https';
            },
            function falseNetworkClaim(copy) {
                copy['external.open'].network = 'allowlisted';
            },
            function unsortHooks(copy) {
                copy['external.open'].policyHooks = [
                    'uri-scheme-allowlist',
                    'capability-grant'
                ];
            },
            function removeContract(copy) {
                delete copy['network.status'];
            },
            function addUncontractedCrossHostMethod(copy, policyCopy) {
                policyCopy['capabilities.list'].hosts = [
                    'android',
                    'core'
                ];
            },
            function changeHost(copy, policyCopy) {
                policyCopy['network.status'].hosts = [
                    'core'
                ];
            },
            function wrongShapeField(copy) {
                copy['platform.status'].input.scheme = 'mailto';
            },
            function wrongShapeLimit(copy) {
                copy['network.status'].output.maxInterfaceCount = 0;
            },
            function broadenLaunchMeaning(copy) {
                copy['apps.launch'].output.acceptedMeaning = 'application-ready';
            },
            function broadenCatalogLimit(copy) {
                copy['apps.list'].output.maxApplications = 257;
            }
        ];
        for (const mutate of mutations) {
            const copy = structuredClone(contracts);
            const policyCopy = structuredClone(policies);
            mutate(copy, policyCopy);
            assert.throws(
                function validateInvalidContract() {
                    validateMethodContracts(copy, policyCopy);
                },
                /Invalid Arcane method contract registry/
            );
        }
    }
);

test(
    'every cross-host policy method requires a semantic contract',
    async function testCrossHostContractCompleteness() {
        const policies = await readMethodPolicies(root);
        const contracts = await readMethodContracts(root, policies);
        const policyCopy = structuredClone(policies);
        policyCopy['capabilities.list'].hosts = [
            'android',
            'core'
        ];
        assert.throws(
            function validateMissingCrossHostContract() {
                validateMethodContracts(
                    structuredClone(contracts),
                    policyCopy
                );
            },
            /every reviewed cross-host method must have exactly one semantic contract/
        );
    }
);

test(
    'contracts state narrow meanings instead of false reachability or completion guarantees',
    async function testNarrowMeanings() {
        const policies = await readMethodPolicies(root);
        const contracts = await readMethodContracts(root, policies);
        assert.equal(contracts['network.status'].output.onlineMeaning, 'non-loopback-interface-present');
        assert.equal(contracts['network.status'].network, 'none');
        assert.equal(contracts['external.open'].effect, 'external-handoff');
        assert.equal(contracts['external.open'].network, 'none');
        assert.equal(contracts['external.open'].reversibility, 'not-reversible');
        assert.equal(contracts['external.open'].audit, 'none');
        assert.equal(contracts['system.ping'].output.kind, 'system-ping-result-v1');
        assert.equal(contracts['version.current'].output.meaning, 'active-arcane-host-release-version');
        assert.equal(contracts['app.current'].output.kind, 'application-descriptor-v1');
        assert.equal(contracts['apps.list'].output.kind, 'application-catalog-v1');
        assert.equal(contracts['apps.list'].output.ordering, 'ascending-order');
        assert.equal(contracts['apps.launch'].input.idMeaning, 'installed-launchable-application-id');
        assert.equal(contracts['apps.launch'].output.acceptedMeaning, 'dispatch-request-accepted');
        assert.equal(contracts['apps.launch'].effect, 'application-dispatch');
        assert.equal(contracts['user.current'].output.kind, 'user-identity-v1');
    }
);

test(
    'Core source enforces the shared cross-host contract bounds',
    async function testCoreContractBounds() {
        const core = await fs.readFile(
            path.join(
                root,
                'src',
                'core',
                'arcane-core.template.cjs'
            ),
            'utf8'
        );
        assert.match(core, /activeNames\.length>64/);
        assert.match(core, /value!==value\.trim\(\)/);
        assert.match(core, /validateApplicationCatalogV1\(result,contract\.output\)/);
        assert.match(core, /validateApplicationLaunchV1\(parameters,contract\.input\)/);
        assert.match(core, /validateApplicationLaunchResultV1\(result,contract\.output\)/);
        assert.match(core, /validateTerminalStartV1\(parameters,contract\.input\)/);
        assert.match(core, /validateTerminalSessionV1\(result,contract\.output\)/);
        assert.match(core, /validateTerminalListV1\(result,contract\.output\)/);
        assert.match(core, /canonicalContractMailto\(value,METHOD_CONTRACTS\['external\.open'\]\.input\)/);
    }
);
