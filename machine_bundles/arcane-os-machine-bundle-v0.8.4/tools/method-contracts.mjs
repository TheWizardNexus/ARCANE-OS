import fs from 'node:fs/promises';
import path from 'node:path';

const METHOD_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const CONTRACT_FIELDS = [
    'version',
    'effect',
    'risk',
    'audit',
    'network',
    'osPermissions',
    'policyHooks',
    'cancellation',
    'reversibility',
    'idempotency',
    'dataMovement',
    'input',
    'output',
];
const FIELDS = new Set(CONTRACT_FIELDS);
const AUTHORITY_FIELDS = new Set(
    ['appIds', 'appTypes', 'capability', 'exclusiveMutation', 'hosts', 'privileged']
);
const ENUMS = Object.freeze(
    {
        audit: new Set(
            ['none', 'metadata']
        ),
        cancellation: new Set(
            ['not-applicable', 'pre-dispatch-only']
        ),
        dataMovement: new Set(
            ['host-to-application', 'operating-system-handoff']
        ),
        effect: new Set(
            ['external-handoff', 'observe']
        ),
        idempotency: new Set(
            ['non-idempotent', 'repeatable-read']
        ),
        network: new Set(
            ['none']
        ),
        reversibility: new Set(
            ['not-applicable', 'not-reversible']
        ),
        risk: new Set(
            ['low', 'moderate', 'high', 'critical']
        )
    }
);
const CONTRACT_METHODS = Object.freeze(
    [
        'app.current',
        'external.open',
        'network.status',
        'platform.status',
        'system.ping',
        'user.current',
        'version.current'
    ]
);

function fail(message) {
    throw new Error(`Invalid Arcane method contract registry: ${message}`);
}

function validateSortedStringList(value, label) {
    function invalidEntry(entry) {
        return typeof entry !== 'string' || !entry;
    }
    function outOfOrder(entry, index) {
        return entry !== value[index];
    }
    if (!Array.isArray(value)) fail(`${label} must be an array.`);
    if (value.some(invalidEntry)) fail(`${label} contains an invalid value.`);
    if (new Set(value).size !== value.length) fail(`${label} contains a duplicate value.`);
    if ([...value].sort().some(outOfOrder)) fail(`${label} must be sorted.`);
}

function validateShape(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
    if (value.exact !== true || typeof value.kind !== 'string' || !value.kind) fail(`${label} must name an exact shape.`);
    const fieldsByKind = {
        'application-descriptor-v1': ['kind', 'exact', 'maxApplicationIdLength', 'maxDisplayNameLength', 'maxApplicationEntryLength', 'maxApplicationVersionLength'],
        'empty-object-v1': ['kind', 'exact'],
        'external-open-v1': ['kind', 'exact', 'maxUriLength', 'scheme'],
        'external-open-result-v1': ['kind', 'exact', 'maxUriLength', 'scheme'],
        'network-status-v1': ['kind', 'exact', 'onlineMeaning', 'maxInterfaceCount'],
        'platform-status-v1': ['kind', 'exact', 'maxStatusStringLength', 'maxListItems', 'maxProbeItems', 'maxApplicationIdLength', 'maxApplicationEntryLength', 'maxApplicationVersionLength', 'maxRendererExecutableLength'],
        'system-ping-result-v1': ['kind', 'exact'],
        'user-identity-v1': [
            'kind',
            'exact',
            'maxUsernameLength',
            'maxAccountNameLength',
            'maxDisplayNameLength'
        ],
        'version-string-v1': ['kind', 'exact', 'maxLength', 'meaning'],
    };
    const expected = fieldsByKind[value.kind];
    const actualFields = Object.keys(value);
    if (!expected || JSON.stringify(actualFields) !== JSON.stringify(expected)) fail(`${label} contains an unknown kind or noncanonical fields.`);
    for (const field of ['maxAccountNameLength', 'maxApplicationEntryLength', 'maxApplicationIdLength', 'maxApplicationVersionLength', 'maxDisplayNameLength', 'maxInterfaceCount', 'maxLength', 'maxListItems', 'maxProbeItems', 'maxRendererExecutableLength', 'maxStatusStringLength', 'maxUriLength', 'maxUsernameLength']) {
        if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || value[field] < 1 || value[field] > 65536)) fail(`${label}.${field} is invalid.`);
    }
    if (value.scheme !== undefined && value.scheme !== 'mailto') fail(`${label}.scheme is invalid.`);
    if (value.onlineMeaning !== undefined && value.onlineMeaning !== 'non-loopback-interface-present') fail(`${label}.onlineMeaning is invalid.`);
    if (value.meaning !== undefined && value.meaning !== 'active-arcane-host-release-version') fail(`${label}.meaning is invalid.`);
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

export function validateMethodContracts(value, policies) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('the root must be an object.');
    const methods = Object.keys(value);
    if (JSON.stringify(methods) !== JSON.stringify(CONTRACT_METHODS)) fail('the reviewed contract methods must be canonical and complete.');
    for (const method of methods) {
        if (!METHOD_PATTERN.test(method) || !policies?.[method]) fail(`${method} does not name a canonical policy method.`);
        const crossHostPolicy = ['android', 'core'];
        if (JSON.stringify(policies[method].hosts) !== JSON.stringify(crossHostPolicy)) fail(`${method} must remain a reviewed cross-host method.`);
        const contract = value[method];
        if (!contract || typeof contract !== 'object' || Array.isArray(contract)) fail(`${method} must map to an object.`);
        const contractFields = Object.keys(contract);
        if (JSON.stringify(contractFields) !== JSON.stringify(CONTRACT_FIELDS)) fail(`${method} fields must be canonical and complete.`);
        for (const field of Object.keys(contract)) {
            if (!FIELDS.has(field)) fail(`${method} contains unknown field ${field}.`);
            if (AUTHORITY_FIELDS.has(field)) fail(`${method} must not redefine authority field ${field}.`);
        }
        if (!SEMVER_PATTERN.test(contract.version)) fail(`${method}.version is invalid.`);
        for (const [field, allowed] of Object.entries(ENUMS)) if (!allowed.has(contract[field])) fail(`${method}.${field} is invalid.`);
        validateSortedStringList(contract.osPermissions, `${method}.osPermissions`);
        validateSortedStringList(contract.policyHooks, `${method}.policyHooks`);
        validateShape(contract.input, `${method}.input`);
        validateShape(contract.output, `${method}.output`);
    }
    const external = value['external.open'];
    if (external.input.kind !== 'external-open-v1' || external.input.scheme !== 'mailto' || external.input.maxUriLength !== 4096) fail('external.open input semantics have drifted.');
    if (external.output.kind !== 'external-open-result-v1' || external.output.scheme !== 'mailto' || external.output.maxUriLength !== 4096) fail('external.open output semantics have drifted.');
    const network = value['network.status'];
    if (network.input.kind !== 'empty-object-v1' || network.output.kind !== 'network-status-v1' || network.output.onlineMeaning !== 'non-loopback-interface-present' || network.output.maxInterfaceCount !== 64) fail('network.status semantics have drifted.');
    const platform = value['platform.status'];
    if (platform.input.kind !== 'empty-object-v1' || platform.output.kind !== 'platform-status-v1' || platform.output.maxStatusStringLength !== 256 || platform.output.maxListItems !== 256 || platform.output.maxProbeItems !== 64 || platform.output.maxApplicationIdLength !== 64 || platform.output.maxApplicationEntryLength !== 512 || platform.output.maxApplicationVersionLength !== 64 || platform.output.maxRendererExecutableLength !== 4096) fail('platform.status semantics have drifted.');
    const ping = value['system.ping'];
    if (ping.input.kind !== 'empty-object-v1' || ping.output.kind !== 'system-ping-result-v1') fail('system.ping semantics have drifted.');
    const user = value['user.current'];
    if (user.input.kind !== 'empty-object-v1' || user.output.kind !== 'user-identity-v1' || user.output.maxUsernameLength !== 128 || user.output.maxAccountNameLength !== 256 || user.output.maxDisplayNameLength !== 256) fail('user.current semantics have drifted.');
    const app = value['app.current'];
    if (app.input.kind !== 'empty-object-v1' || app.output.kind !== 'application-descriptor-v1' || app.output.maxApplicationIdLength !== 64 || app.output.maxDisplayNameLength !== 256 || app.output.maxApplicationEntryLength !== 512 || app.output.maxApplicationVersionLength !== 64) fail('app.current semantics have drifted.');
    const version = value['version.current'];
    if (version.input.kind !== 'empty-object-v1' || version.output.kind !== 'version-string-v1' || version.output.maxLength !== 64 || version.output.meaning !== 'active-arcane-host-release-version') fail('version.current semantics have drifted.');
    return deepFreeze(value);
}

export async function readMethodContracts(bundleRoot, policies) {
    const contractPath = path.join(bundleRoot, 'src', 'api', 'method-contracts.json');
    const source = await fs.readFile(contractPath, 'utf8');
    const parsedContracts = JSON.parse(source);
    const contracts = validateMethodContracts(parsedContracts, policies);
    if (source !== renderMethodContractsJson(contracts)) fail('the source must use canonical serialization without duplicate keys.');
    return contracts;
}

export function renderMethodContractsJson(contracts) {
    return `${JSON.stringify(contracts, null, 2)}\n`;
}

function renderFrozenValue(value) {
    if (Array.isArray(value)) {
        const renderedEntries = value.map(renderFrozenValue).join(',');
        return `Object.freeze([${renderedEntries}])`;
    }
    if (value && typeof value === 'object') {
        function renderFrozenField([field, fieldValue]) {
            return `${JSON.stringify(field)}:${renderFrozenValue(fieldValue)}`;
        }
        const fields = Object.entries(value).map(renderFrozenField);
        return `Object.freeze({${fields.join(',')}})`;
    }
    return JSON.stringify(value);
}

export function renderCoreMethodContracts(contracts, policies) {
    validateMethodContracts(contracts, policies);
    return renderFrozenValue(contracts);
}

export function renderAndroidMethodContracts(contracts, policies) {
    validateMethodContracts(contracts, policies);
    const lines = [];
    for (const [method, contract] of Object.entries(contracts)) {
        const prefix = method.replaceAll('.', '_').toUpperCase();
        lines.push(`    internal const val ${prefix}_VERSION = ${JSON.stringify(contract.version)}`);
        for (const section of ['input', 'output']) {
            for (const [field, value] of Object.entries(contract[section])) {
                const fieldName = field.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
                lines.push(`    internal const val ${prefix}_${section.toUpperCase()}_${fieldName} = ${JSON.stringify(value)}`);
            }
        }
    }
    return `package os.arcane.host.android\n\ninternal object GeneratedAndroidMethodContracts {\n${lines.join('\n')}\n}\n`;
}
