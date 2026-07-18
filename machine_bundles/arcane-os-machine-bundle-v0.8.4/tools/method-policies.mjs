import fs from 'node:fs/promises';
import path from 'node:path';

const METHOD_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const POLICY_FIELDS = new Set(
    ['appIds', 'appTypes', 'capability', 'exclusiveMutation', 'hosts', 'privileged']
);
const APP_TYPES = new Set(
    ['app', 'provisioner', 'shell']
);
const HOSTS = new Set(
    ['android', 'core']
);

function fail(message) {
    throw new Error(`Invalid Arcane method policy registry: ${message}`);
}

function validateStringList(value, label, allowed) {
    if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a nonempty array.`);
    function invalidStringEntry(entry) {
        return typeof entry !== 'string' || !entry;
    }
    function outOfOrderEntry(entry, index) {
        return entry !== value[index];
    }
    function unsupportedEntry(entry) {
        return !allowed.has(entry);
    }
    if (value.some(invalidStringEntry)) fail(`${label} contains an invalid value.`);
    if (new Set(value).size !== value.length) fail(`${label} contains a duplicate value.`);
    if ([...value].sort().some(outOfOrderEntry)) fail(`${label} must be sorted.`);
    if (allowed && value.some(unsupportedEntry)) fail(`${label} contains an unsupported value.`);
}

export function validateMethodPolicies(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('the root must be an object.');
    const methods = Object.keys(value);
    if (!methods.length) fail('at least one method is required.');
    for (const method of methods) {
        if (!METHOD_PATTERN.test(method)) fail(`${method} is not a canonical method name.`);
        const policy = value[method];
        if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail(`${method} must map to an object.`);
        for (const field of Object.keys(policy)) if (!POLICY_FIELDS.has(field)) fail(`${method} contains unknown field ${field}.`);
        if (policy.capability !== undefined && (typeof policy.capability !== 'string' || !CAPABILITY_PATTERN.test(policy.capability))) {
            fail(`${method}.capability is invalid.`);
        }
        for (const field of ['exclusiveMutation', 'privileged']) {
            if (policy[field] !== undefined && policy[field] !== true) fail(`${method}.${field} may only be true when present.`);
        }
        if (policy.appIds !== undefined) {
            validateStringList(policy.appIds, `${method}.appIds`);
            function invalidApplicationId(entry) {
                return !ID_PATTERN.test(entry);
            }
            if (policy.appIds.some(invalidApplicationId)) fail(`${method}.appIds contains an invalid application id.`);
        }
        if (policy.appTypes !== undefined) validateStringList(policy.appTypes, `${method}.appTypes`, APP_TYPES);
        if (policy.hosts !== undefined) validateStringList(policy.hosts, `${method}.hosts`, HOSTS);
        if (policy.hosts?.includes('android') && (policy.hosts.length !== 2 || !policy.hosts.includes('core'))) {
            fail(`${method} may expose Android only as an additional Core-compatible host.`);
        }
    }
    return value;
}

export async function readMethodPolicies(bundleRoot) {
    const policyPath = path.join(bundleRoot, 'src', 'api', 'method-policies.json');
    const source = await fs.readFile(policyPath, 'utf8');
    const parsedPolicies = JSON.parse(source);
    const policies = validateMethodPolicies(parsedPolicies);
    if (source !== renderMethodPoliciesJson(policies)) fail('the source must use canonical serialization without duplicate keys.');
    return policies;
}

export function renderMethodPoliciesJson(policies) {
    validateMethodPolicies(policies);
    function renderPolicyEntry([method, policy]) {
        const compact = JSON.stringify(policy).replaceAll(':', ': ').replaceAll(',', ', ');
        const renderedPolicy = compact === '{}' ? compact : `{ ${compact.slice(1, -1)} }`;
        return `  ${JSON.stringify(method)}: ${renderedPolicy}`;
    }
    const entries = Object.entries(policies).map(renderPolicyEntry);
    return `{\n${entries.join(',\n')}\n}\n`;
}

function renderPolicy(policy) {
    function corePolicyField([field]) {
        return field !== 'hosts';
    }
    function renderCorePolicyField([field, value]) {
        const expression = Array.isArray(value) ? `Object.freeze(${JSON.stringify(value)})` : JSON.stringify(value);
        return `${field}:${expression}`;
    }
    const fields = Object.entries(policy).filter(corePolicyField);
    if (!fields.length) return 'Object.freeze({})';
    const rendered = fields.map(renderCorePolicyField).join(', ');
    return `Object.freeze({ ${rendered} })`;
}

export function renderCoreMethodPolicies(policies) {
    validateMethodPolicies(policies);
    function renderCorePolicyEntry([method, policy]) {
        return `  '${method}': ${renderPolicy(policy)},`;
    }
    const entries = Object.entries(policies).map(renderCorePolicyEntry);
    return `Object.freeze({\n${entries.join('\n')}\n})`;
}

function androidConstantPrefix(method) {
    return method.replace(/[^a-zA-Z0-9]+/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

export function renderAndroidCapabilityRegistry(policies) {
    validateMethodPolicies(policies);
    function androidPolicyEntry([, policy]) {
        return policy.hosts?.includes('android');
    }
    function sortAndroidPolicyEntries([left], [right]) {
        return left.localeCompare(right, 'en');
    }
    function capabilityPolicyEntry([, policy]) {
        return Boolean(policy.capability);
    }
    function capabilityConstant([method]) {
        return `${androidConstantPrefix(method)}_CAPABILITY`;
    }
    function methodConstant([method]) {
        return `${androidConstantPrefix(method)}_METHOD`;
    }
    function capabilityMapping([method]) {
        const prefix = androidConstantPrefix(method);
        return `        if (method == ${prefix}_METHOD) return ${prefix}_CAPABILITY`;
    }
    function applicationPolicyMapping([method, policy]) {
        const prefix = androidConstantPrefix(method);
        const checks = [];
        if (policy.appIds) checks.push(`applicationId in setOf(${policy.appIds.map((value) => JSON.stringify(value)).join(', ')})`);
        if (policy.appTypes) checks.push(`applicationType in setOf(${policy.appTypes.map((value) => JSON.stringify(value)).join(', ')})`);
        if (!checks.length) return null;
        return `        if (method == ${prefix}_METHOD) return ${checks.join(' && ')}`;
    }
    const entries = Object.entries(policies)
        .filter(androidPolicyEntry)
        .sort(sortAndroidPolicyEntries);
    if (!entries.length) fail('Android must expose at least one reviewed host policy.');
    const constants = [];
    for (const [method, policy] of entries) {
        const prefix = androidConstantPrefix(method);
        constants.push(`    internal const val ${prefix}_METHOD = ${JSON.stringify(method)}`);
        if (policy.capability) constants.push(`    internal const val ${prefix}_CAPABILITY = ${JSON.stringify(policy.capability)}`);
    }
    const capabilityEntries = entries.filter(capabilityPolicyEntry);
    const grants = capabilityEntries.map(capabilityConstant);
    const methods = entries.map(methodConstant);
    const mappings = capabilityEntries.map(capabilityMapping);
    const applicationMappings = entries.map(applicationPolicyMapping).filter(Boolean);
    return `package os.arcane.host.android\n\ninternal object GeneratedAndroidCapabilityRegistry {\n${constants.join('\n')}\n    internal val grants = listOf(${grants.join(', ')})\n    internal val methods = listOf(${methods.join(', ')})\n\n    internal fun isSupported(method: String): Boolean {\n        return methods.contains(method)\n    }\n\n    internal fun capabilityFor(method: String): String? {\n${mappings.join('\n')}\n        return null\n    }\n\n    internal fun isAllowedForApplication(method: String, applicationId: String, applicationType: String): Boolean {\n${applicationMappings.join('\n')}\n        return isSupported(method)\n    }\n}\n`;
}

export function renderAndroidApplicationRegistry(bundleManifest, policies) {
    validateMethodPolicies(policies);
    const shell = bundleManifest?.apps?.shell;
    const bundleVersion = bundleManifest?.version;
    if (typeof bundleVersion !== 'string' || !bundleVersion || bundleVersion.length > 64) fail('the Android bundle version is invalid.');
    if (!shell || shell.displayName !== 'Arcane Shell' || shell.type !== 'shell' || shell.entry !== 'shell/index.html') fail('the Android shell application descriptor must match the canonical bundle manifest.');
    if (!Array.isArray(shell.capabilities) || new Set(shell.capabilities).size !== shell.capabilities.length) fail('the Android shell capability manifest is invalid.');
    for (const capability of shell.capabilities) if (typeof capability !== 'string' || !capability) fail('the Android shell capability manifest is invalid.');
    function shellAndroidGrant([, policy]) {
        return policy.hosts?.includes('android') && policy.capability && shell.capabilities.includes(policy.capability);
    }
    function sortShellAndroidGrants([left], [right]) {
        return left.localeCompare(right, 'en');
    }
    function shellCapability([, policy]) {
        return policy.capability;
    }
    function grantOutsideManifest(capability) {
        return !shell.capabilities.includes(capability);
    }
    function uniqueGrantEntry([, policy], index, values) {
        function firstCapability([, candidate]) {
            return candidate.capability === policy.capability;
        }
        return values.findIndex(firstCapability) === index;
    }
    function renderGrantLine([method]) {
        return `        grants.add(GeneratedAndroidCapabilityRegistry.${androidConstantPrefix(method)}_CAPABILITY)`;
    }
    const grantEntries = Object.entries(policies)
        .filter(shellAndroidGrant)
        .sort(sortShellAndroidGrants);
    const mappedGrantCapabilities = grantEntries.map(shellCapability);
    const grants = [...new Set(mappedGrantCapabilities)].sort();
    if (grants.some(grantOutsideManifest)) fail('the Android shell grant intersection escaped the canonical manifest.');
    const grantLines = grantEntries
        .filter(uniqueGrantEntry)
        .map(renderGrantLine);
    return `package os.arcane.host.android\n\nimport java.util.Collections\nimport java.util.LinkedHashSet\n\ninternal object GeneratedAndroidApplicationRegistry {\n    internal const val BUNDLE_VERSION = "${bundleVersion}"\n    internal const val SHELL_ID = "shell"\n    internal const val SHELL_DISPLAY_NAME = "Arcane Shell"\n    internal const val SHELL_TYPE = "shell"\n    internal const val SHELL_ENTRY = "shell/index.html"\n\n    internal fun shellGrants(): Set<String> {\n        val grants = LinkedHashSet<String>()\n${grantLines.join('\n')}\n        return Collections.unmodifiableSet(grants)\n    }\n}\n`;
}
