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
const CROSS_HOST_POLICY = Object.freeze(
    ['android', 'core']
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
            ['application-to-host', 'bidirectional', 'host-to-application', 'operating-system-handoff']
        ),
        effect: new Set(
            ['application-dispatch', 'external-handoff', 'observe', 'process-control', 'process-input', 'process-start']
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
        'application-catalog-v1': ['kind', 'exact', 'maxApplications', 'maxApplicationIdLength', 'maxDisplayNameLength', 'maxDescriptionLength', 'maxIconUrlLength', 'maxApplicationVersionLength', 'maxOrder', 'maxSecurityEvidenceLength', 'ordering'],
        'application-descriptor-v1': ['kind', 'exact', 'maxApplicationIdLength', 'maxDisplayNameLength', 'maxApplicationEntryLength', 'maxApplicationVersionLength'],
        'application-launch-result-v1': ['kind', 'exact', 'maxApplicationIdLength', 'acceptedMeaning'],
        'application-launch-v1': ['kind', 'exact', 'maxApplicationIdLength', 'idMeaning'],
        'empty-object-v1': ['kind', 'exact'],
        'external-open-v1': ['kind', 'exact', 'maxUriLength', 'scheme'],
        'external-open-result-v1': ['kind', 'exact', 'maxUriLength', 'scheme'],
        'network-status-v1': ['kind', 'exact', 'onlineMeaning', 'maxInterfaceCount'],
        'platform-status-v1': ['kind', 'exact', 'maxStatusStringLength', 'maxListItems', 'maxProbeItems', 'maxApplicationIdLength', 'maxApplicationEntryLength', 'maxApplicationVersionLength', 'maxRendererExecutableLength'],
        'system-ping-result-v1': ['kind', 'exact'],
        'terminal-close-result-v1': ['kind', 'exact', 'maxSessionIdLength', 'acceptedMeaning'],
        'terminal-list-v1': ['kind', 'exact', 'maxSessions', 'maxSessionIdLength', 'maxShellLength', 'maxCwdLength', 'maxTimestampLength'],
        'terminal-resize-v1': ['kind', 'exact', 'maxSessionIdLength', 'minColumns', 'maxColumns', 'minRows', 'maxRows'],
        'terminal-resize-result-v1': ['kind', 'exact', 'maxSessionIdLength', 'minColumns', 'maxColumns', 'minRows', 'maxRows'],
        'terminal-session-id-v1': ['kind', 'exact', 'maxSessionIdLength'],
        'terminal-session-v1': ['kind', 'exact', 'maxSessionIdLength', 'maxShellLength', 'maxCwdLength', 'maxTitleLength', 'maxTimestampLength'],
        'terminal-signal-v1': ['kind', 'exact', 'maxSessionIdLength', 'signalMeaning'],
        'terminal-signal-result-v1': ['kind', 'exact', 'maxSessionIdLength', 'signalMeaning', 'acceptedMeaning'],
        'terminal-start-v1': ['kind', 'exact', 'maxShellLength', 'maxCwdLength', 'minColumns', 'maxColumns', 'minRows', 'maxRows'],
        'terminal-write-v1': ['kind', 'exact', 'maxSessionIdLength', 'maxDataBytes'],
        'terminal-write-result-v1': ['kind', 'exact', 'maxSessionIdLength', 'maxDataBytes'],
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
    for (const field of ['maxAccountNameLength', 'maxApplications', 'maxApplicationEntryLength', 'maxApplicationIdLength', 'maxApplicationVersionLength', 'maxColumns', 'maxCwdLength', 'maxDataBytes', 'maxDescriptionLength', 'maxDisplayNameLength', 'maxIconUrlLength', 'maxInterfaceCount', 'maxLength', 'maxListItems', 'maxOrder', 'maxProbeItems', 'maxRendererExecutableLength', 'maxRows', 'maxSecurityEvidenceLength', 'maxSessionIdLength', 'maxSessions', 'maxShellLength', 'maxStatusStringLength', 'maxTimestampLength', 'maxTitleLength', 'maxUriLength', 'maxUsernameLength', 'minColumns', 'minRows']) {
        const maximum = field === 'maxOrder' ? 100000 : 65536;
        if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || value[field] < 1 || value[field] > maximum)) fail(`${label}.${field} is invalid.`);
    }
    if (value.acceptedMeaning !== undefined && !['close-request-accepted', 'dispatch-request-accepted', 'signal-request-accepted'].includes(value.acceptedMeaning)) fail(`${label}.acceptedMeaning is invalid.`);
    if (value.idMeaning !== undefined && value.idMeaning !== 'installed-launchable-application-id') fail(`${label}.idMeaning is invalid.`);
    if (value.scheme !== undefined && value.scheme !== 'mailto') fail(`${label}.scheme is invalid.`);
    if (value.onlineMeaning !== undefined && value.onlineMeaning !== 'non-loopback-interface-present') fail(`${label}.onlineMeaning is invalid.`);
    if (value.meaning !== undefined && value.meaning !== 'active-arcane-host-release-version') fail(`${label}.meaning is invalid.`);
    if (value.ordering !== undefined && value.ordering !== 'ascending-order') fail(`${label}.ordering is invalid.`);
    if (value.signalMeaning !== undefined && value.signalMeaning !== 'interrupt-or-terminate') fail(`${label}.signalMeaning is invalid.`);
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

export function validateMethodContracts(value, policies) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('the root must be an object.');
    if (!policies || typeof policies !== 'object' || Array.isArray(policies)) fail('the method policy registry is required.');
    const methods = Object.keys(value);
    const sortedMethods = [...methods].sort();
    if (JSON.stringify(methods) !== JSON.stringify(sortedMethods)) fail('the reviewed contract methods must be sorted.');
    const crossHostMethods = Object.entries(policies)
        .filter(function reviewedCrossHostMethod([, policy]) {
            return JSON.stringify(policy.hosts) === JSON.stringify(CROSS_HOST_POLICY);
        })
        .map(function crossHostMethodName([method]) {
            return method;
        })
        .sort();
    if (JSON.stringify(methods) !== JSON.stringify(crossHostMethods)) fail('every reviewed cross-host method must have exactly one semantic contract.');
    for (const method of methods) {
        if (!METHOD_PATTERN.test(method) || !policies?.[method]) fail(`${method} does not name a canonical policy method.`);
        if (JSON.stringify(policies[method].hosts) !== JSON.stringify(CROSS_HOST_POLICY)) fail(`${method} must remain a reviewed cross-host method.`);
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
    const launch = value['apps.launch'];
    if (launch.input.kind !== 'application-launch-v1' || launch.input.maxApplicationIdLength !== 64 || launch.input.idMeaning !== 'installed-launchable-application-id') fail('apps.launch input semantics have drifted.');
    if (launch.output.kind !== 'application-launch-result-v1' || launch.output.maxApplicationIdLength !== 64 || launch.output.acceptedMeaning !== 'dispatch-request-accepted') fail('apps.launch output semantics have drifted.');
    const catalog = value['apps.list'];
    if (catalog.input.kind !== 'empty-object-v1' || catalog.output.kind !== 'application-catalog-v1' || catalog.output.maxApplications !== 256 || catalog.output.maxApplicationIdLength !== 64 || catalog.output.maxDisplayNameLength !== 80 || catalog.output.maxDescriptionLength !== 240 || catalog.output.maxIconUrlLength !== 1024 || catalog.output.maxApplicationVersionLength !== 64 || catalog.output.maxOrder !== 100000 || catalog.output.maxSecurityEvidenceLength !== 256 || catalog.output.ordering !== 'ascending-order') fail('apps.list semantics have drifted.');
    const external = value['external.open'];
    if (external.input.kind !== 'external-open-v1' || external.input.scheme !== 'mailto' || external.input.maxUriLength !== 4096) fail('external.open input semantics have drifted.');
    if (external.output.kind !== 'external-open-result-v1' || external.output.scheme !== 'mailto' || external.output.maxUriLength !== 4096) fail('external.open output semantics have drifted.');
    const network = value['network.status'];
    if (network.input.kind !== 'empty-object-v1' || network.output.kind !== 'network-status-v1' || network.output.onlineMeaning !== 'non-loopback-interface-present' || network.output.maxInterfaceCount !== 64) fail('network.status semantics have drifted.');
    const platform = value['platform.status'];
    if (platform.input.kind !== 'empty-object-v1' || platform.output.kind !== 'platform-status-v1' || platform.output.maxStatusStringLength !== 256 || platform.output.maxListItems !== 256 || platform.output.maxProbeItems !== 64 || platform.output.maxApplicationIdLength !== 64 || platform.output.maxApplicationEntryLength !== 512 || platform.output.maxApplicationVersionLength !== 64 || platform.output.maxRendererExecutableLength !== 4096) fail('platform.status semantics have drifted.');
    const ping = value['system.ping'];
    if (ping.input.kind !== 'empty-object-v1' || ping.output.kind !== 'system-ping-result-v1') fail('system.ping semantics have drifted.');
    const terminalStart = value['terminal.start'];
    if (terminalStart.input.kind !== 'terminal-start-v1' || terminalStart.input.maxColumns !== 500 || terminalStart.input.maxRows !== 200 || terminalStart.output.kind !== 'terminal-session-v1') fail('terminal.start semantics have drifted.');
    const terminalWrite = value['terminal.write'];
    if (terminalWrite.input.kind !== 'terminal-write-v1' || terminalWrite.input.maxDataBytes !== 65536 || terminalWrite.output.kind !== 'terminal-write-result-v1') fail('terminal.write semantics have drifted.');
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
