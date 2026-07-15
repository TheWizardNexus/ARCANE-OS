const AGGREGATE_MAXIMUM_BYTES = 64 * 1024;
const AMBIGUITY_MAXIMUM = 32;
const CONSTRAINT_MAXIMUM = 64;
const DESCRIPTION_MAXIMUM_BYTES = 2048;
const EXPRESSION_MAXIMUM_BYTES = 32 * 1024;
const GOAL_MAXIMUM_BYTES = 8 * 1024;
const IDENTIFIER_MAXIMUM_CHARACTERS = 128;
const LABEL_MAXIMUM_BYTES = 256;
const OPTION_MAXIMUM = 16;
const OPTION_MAXIMUM_BYTES = 512;
const RESOURCE_LOCATOR_MAXIMUM_BYTES = 4096;
const RESOURCE_MAXIMUM = 64;
const SENSITIVITY_LABEL_MAXIMUM = 32;

const SCHEMA = 'arcane.intent-envelope';
const VERSION = 1;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESERVED_KEYS_VALUES = ['__proto__', 'constructor', 'prototype'];
const CONSTRAINT_KIND_VALUES = ['exclusion', 'limit', 'other', 'preference', 'requirement'];
const RESOURCE_TYPE_VALUES = ['application', 'device', 'directory', 'file', 'other', 'record', 'uri'];
const AMBIGUITY_KIND_VALUES = ['meaning', 'other', 'reference', 'scope', 'target'];
const SENSITIVITY_LEVEL_VALUES = ['confidential', 'internal', 'public', 'restricted', 'unknown'];
const PROVENANCE_SOURCE_VALUES = ['application', 'import', 'system', 'user'];
const PROVENANCE_CHANNEL_VALUES = ['automation', 'selection', 'speech', 'text'];
const RESERVED_KEYS = new Set(RESERVED_KEYS_VALUES);
const CONSTRAINT_KINDS = new Set(CONSTRAINT_KIND_VALUES);
const RESOURCE_TYPES = new Set(RESOURCE_TYPE_VALUES);
const AMBIGUITY_KINDS = new Set(AMBIGUITY_KIND_VALUES);
const SENSITIVITY_LEVELS = new Set(SENSITIVITY_LEVEL_VALUES);
const PROVENANCE_SOURCES = new Set(PROVENANCE_SOURCE_VALUES);
const PROVENANCE_CHANNELS = new Set(PROVENANCE_CHANNEL_VALUES);
const ROOT_KEY_VALUES = [
    'schema', 'version', 'id', 'createdAt', 'originalExpression', 'normalizedGoal',
    'constraints', 'resources', 'ambiguities', 'sensitivity', 'provenance'
];
const PAYLOAD_KEY_VALUES = [
    'originalExpression', 'normalizedGoal', 'constraints', 'resources', 'ambiguities', 'sensitivity'
];
const TRUSTED_CONTEXT_KEY_VALUES = [
    'id', 'createdAt', 'source', 'channel', 'actorId', 'applicationId', 'sessionId'
];
const GOAL_KEY_VALUES = ['text', 'producer', 'version', 'confidence'];
const CONSTRAINT_KEY_VALUES = ['id', 'kind', 'value', 'description'];
const RESOURCE_KEY_VALUES = ['id', 'type', 'locator', 'description'];
const AMBIGUITY_KEY_VALUES = ['id', 'kind', 'description', 'options'];
const SENSITIVITY_KEY_VALUES = ['level', 'labels'];
const PROVENANCE_KEY_VALUES = ['source', 'channel', 'actorId', 'applicationId', 'sessionId'];
const ROOT_KEYS = Object.freeze(ROOT_KEY_VALUES);
const PAYLOAD_KEYS = Object.freeze(PAYLOAD_KEY_VALUES);
const TRUSTED_CONTEXT_KEYS = Object.freeze(TRUSTED_CONTEXT_KEY_VALUES);
const GOAL_KEYS = Object.freeze(GOAL_KEY_VALUES);
const CONSTRAINT_KEYS = Object.freeze(CONSTRAINT_KEY_VALUES);
const RESOURCE_KEYS = Object.freeze(RESOURCE_KEY_VALUES);
const AMBIGUITY_KEYS = Object.freeze(AMBIGUITY_KEY_VALUES);
const SENSITIVITY_KEYS = Object.freeze(SENSITIVITY_KEY_VALUES);
const PROVENANCE_KEYS = Object.freeze(PROVENANCE_KEY_VALUES);

const encoder = new TextEncoder();
const constructionToken = Symbol('IntentEnvelope construction');

export class IntentEnvelopeValidationError extends TypeError {
    constructor(code, path, message, options) {
        super(message, options);
        this.name = 'IntentEnvelopeValidationError';
        this.code = code;
        this.path = path;
    }
}

function fail(code, path, message, options) {
    throw new IntentEnvelopeValidationError(code, path, message, options);
}

function isReservedKey(key) {
    return typeof key === 'string' && RESERVED_KEYS.has(key);
}

function validateUnicode(value, path) {
    for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xD800 && unit <= 0xDBFF) {
            const following = value.charCodeAt(index + 1);
            if (!(following >= 0xDC00 && following <= 0xDFFF)) {
                fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope text contains invalid Unicode.');
            }
            index += 1;
        } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
            fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope text contains invalid Unicode.');
        }
    }
    return value;
}

function byteLength(value) {
    return encoder.encode(value).byteLength;
}

function boundedString(value, path, maximum, options = {}) {
    const nullable = options.nullable === true;
    const nonempty = options.nonempty !== false;

    if (nullable && value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope field has an invalid type.');
    }
    validateUnicode(value, path);
    if (nonempty && !value.trim()) {
        fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope field must contain text.');
    }
    if (byteLength(value) > maximum) {
        fail('INTENT_ENVELOPE_LIMIT_EXCEEDED', path, 'Intent envelope field exceeds its size limit.');
    }
    return value;
}

function identifier(value, path, options = {}) {
    const nullable = options.nullable === true;

    if (nullable && value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope identifier has an invalid type.');
    }
    validateUnicode(value, path);
    if (value.length > IDENTIFIER_MAXIMUM_CHARACTERS || !IDENTIFIER_PATTERN.test(value)) {
        fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope identifier is invalid.');
    }
    return value;
}

function enumeration(value, path, values) {
    if (typeof value !== 'string' || !values.has(value)) {
        fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope enum value is invalid.');
    }
    return value;
}

function plainRecord(value, path, allowedKeys, active) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope field must be a plain record.');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope record prototype is invalid.');
    }
    if (active.has(value)) {
        fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope data must not contain cycles.');
    }
    active.add(value);
    const allowed = new Set(allowedKeys);
    const ownKeys = Reflect.ownKeys(value);

    for (const key of ownKeys) {
        if (typeof key !== 'string' || isReservedKey(key) || !allowed.has(key)) {
            active.delete(value);
            fail('INTENT_ENVELOPE_UNKNOWN_FIELD', path, 'Intent envelope contains an unsupported field.');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            active.delete(value);
            fail('INTENT_ENVELOPE_INVALID', `${path}.${key}`, 'Intent envelope accessors are not allowed.');
        }
    }
    return value;
}

function finishRecord(value, active) {
    active.delete(value);
}

function ownValue(record, key, path, options = {}) {
    const required = options.required !== false;
    const defaultValue = options.defaultValue;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);

    if (!descriptor) {
        if (required) {
            fail('INTENT_ENVELOPE_INVALID', `${path}.${key}`, 'Intent envelope required field is missing.');
        }

        return defaultValue;
    }
    return descriptor.value;
}

function denseArray(value, path, maximum, active) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope field must be an array.');
    }
    if (active.has(value)) {
        fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope data must not contain cycles.');
    }
    if (value.length > maximum) {
        fail('INTENT_ENVELOPE_LIMIT_EXCEEDED', path, 'Intent envelope array exceeds its item limit.');
    }
    active.add(value);
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
        if (key === 'length') {
            continue;
        }
        if (typeof key !== 'string' || isReservedKey(key) || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
            active.delete(value);
            fail('INTENT_ENVELOPE_UNKNOWN_FIELD', path, 'Intent envelope array contains an unsupported field.');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            active.delete(value);
            fail('INTENT_ENVELOPE_INVALID', `${path}[${key}]`, 'Intent envelope accessors are not allowed.');
        }
    }
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
            active.delete(value);
            fail('INTENT_ENVELOPE_INVALID', `${path}[${index}]`, 'Intent envelope sparse arrays are not allowed.');
        }
    }
    return value;
}

function finishArray(value, active) {
    active.delete(value);
}

function normalizeTimestamp(value, path) {
    if (typeof value !== 'string') {
        fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope timestamp is invalid.');
    }
    const instant = new Date(value);
    if (Number.isNaN(instant.valueOf()) || instant.toISOString() !== value) {
        fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope timestamp is invalid.');
    }
    return value;
}

function normalizeTrustedTimestamp(value, path) {
    if (!(typeof value === 'string' || value instanceof Date)) {
        fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope timestamp is invalid.');
    }

    const instant = new Date(value);

    if (Number.isNaN(instant.valueOf())) {
        fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope timestamp is invalid.');
    }

    return instant.toISOString();
}

function normalizeGoal(value, path, active) {
    if (value === null) {
        return null;
    }
    const record = plainRecord(value, path, GOAL_KEYS, active);
    const textValue = ownValue(record, 'text', path);
    const producerValue = ownValue(record, 'producer', path);
    const versionValue = ownValue(record, 'version', path);
    const text = boundedString(textValue, `${path}.text`, GOAL_MAXIMUM_BYTES);
    const producer = identifier(producerValue, `${path}.producer`);
    const version = identifier(versionValue, `${path}.version`);
    const confidenceValue = ownValue(record, 'confidence', path);
    if (confidenceValue !== null && (
        typeof confidenceValue !== 'number' || !Number.isFinite(confidenceValue) || confidenceValue < 0 || confidenceValue > 1
    )) {
        finishRecord(record, active);
        fail('INTENT_ENVELOPE_INVALID', `${path}.confidence`, 'Intent envelope confidence is invalid.');
    }
    finishRecord(record, active);
    const goal = { text, producer, version, confidence: confidenceValue };
    return Object.freeze(goal);
}

function normalizeScalar(value, path) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        if (typeof value === 'string') {
            validateUnicode(value, path);
        }

        return value;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    fail('INTENT_ENVELOPE_INVALID', path, 'Intent envelope scalar value is invalid.');
}

function normalizeConstraint(value, index, active) {
    const path = `constraints[${index}]`;
    const record = plainRecord(value, path, CONSTRAINT_KEYS, active);
    const idValue = ownValue(record, 'id', path);
    const kindValue = ownValue(record, 'kind', path);
    const scalarValue = ownValue(record, 'value', path);
    const id = identifier(idValue, `${path}.id`);
    const kind = enumeration(kindValue, `${path}.kind`, CONSTRAINT_KINDS);
    const scalar = normalizeScalar(scalarValue, `${path}.value`);
    const description = boundedString(
        ownValue(
            record,
            'description',
            path,
            {
                required: false,
                defaultValue: null
            }
        ),
        `${path}.description`,
        DESCRIPTION_MAXIMUM_BYTES,
        {
            nullable: true
        }
    );
    finishRecord(record, active);
    const constraint = { id, kind, value: scalar, description };
    return Object.freeze(constraint);
}

function normalizeResource(value, index, active) {
    const path = `resources[${index}]`;
    const record = plainRecord(value, path, RESOURCE_KEYS, active);
    const idValue = ownValue(record, 'id', path);
    const typeValue = ownValue(record, 'type', path);
    const locatorValue = ownValue(record, 'locator', path);
    const id = identifier(idValue, `${path}.id`);
    const type = enumeration(typeValue, `${path}.type`, RESOURCE_TYPES);
    const locator = boundedString(locatorValue, `${path}.locator`, RESOURCE_LOCATOR_MAXIMUM_BYTES);
    const description = boundedString(
        ownValue(
            record,
            'description',
            path,
            {
                required: false,
                defaultValue: null
            }
        ),
        `${path}.description`,
        DESCRIPTION_MAXIMUM_BYTES,
        {
            nullable: true
        }
    );
    finishRecord(record, active);
    const resource = { id, type, locator, description };
    return Object.freeze(resource);
}

function normalizeOptions(value, path, active) {
    const options = denseArray(value, path, OPTION_MAXIMUM, active);
    const normalized = [];
    for (let index = 0; index < options.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(options, String(index));
        const normalizedOption = boundedString(descriptor.value, `${path}[${index}]`, OPTION_MAXIMUM_BYTES);
        normalized.push(normalizedOption);
    }
    finishArray(options, active);
    return Object.freeze(normalized);
}

function normalizeAmbiguity(value, index, active) {
    const path = `ambiguities[${index}]`;
    const record = plainRecord(value, path, AMBIGUITY_KEYS, active);
    const idValue = ownValue(record, 'id', path);
    const kindValue = ownValue(record, 'kind', path);
    const id = identifier(idValue, `${path}.id`);
    const kind = enumeration(kindValue, `${path}.kind`, AMBIGUITY_KINDS);
    const description = boundedString(
        ownValue(record, 'description', path),
        `${path}.description`,
        DESCRIPTION_MAXIMUM_BYTES,
    );
    const options = normalizeOptions(
        ownValue(
            record,
            'options',
            path,
            {
                required: false,
                defaultValue: []
            }
        ),
        `${path}.options`,
        active,
    );
    finishRecord(record, active);
    const ambiguity = { id, kind, description, options };
    return Object.freeze(ambiguity);
}

function normalizeList(value, path, maximum, normalizer, active) {
    const list = denseArray(value, path, maximum, active);
    const normalized = [];
    const ids = new Set();
    for (let index = 0; index < list.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
        const item = normalizer(descriptor.value, index, active);
        if (ids.has(item.id)) {
            finishArray(list, active);
            fail('INTENT_ENVELOPE_INVALID', `${path}[${index}].id`, 'Intent envelope item identifiers must be unique.');
        }
        ids.add(item.id);
        normalized.push(item);
    }
    finishArray(list, active);
    return Object.freeze(normalized);
}

function normalizeSensitivity(value, path, active) {
    const record = plainRecord(value, path, SENSITIVITY_KEYS, active);
    const levelValue = ownValue(record, 'level', path);
    const level = enumeration(levelValue, `${path}.level`, SENSITIVITY_LEVELS);
    const labelsValue = ownValue(
        record,
        'labels',
        path,
        {
            required: false,
            defaultValue: []
        }
    );
    const labels = denseArray(labelsValue, `${path}.labels`, SENSITIVITY_LABEL_MAXIMUM, active);
    const normalized = [];
    const seen = new Set();
    for (let index = 0; index < labels.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(labels, String(index));
        const label = boundedString(
            descriptor.value,
            `${path}.labels[${index}]`,
            LABEL_MAXIMUM_BYTES,
        ).trim();
        if (seen.has(label)) {
            finishArray(labels, active);
            finishRecord(record, active);
            fail('INTENT_ENVELOPE_INVALID', `${path}.labels[${index}]`, 'Intent envelope sensitivity labels must be unique.');
        }
        seen.add(label);
        normalized.push(label);
    }
    normalized.sort();
    finishArray(labels, active);
    finishRecord(record, active);
    const sensitivity = {
        level,
        labels: Object.freeze(normalized)
    };
    return Object.freeze(sensitivity);
}

function normalizeProvenance(value, path, active) {
    const record = plainRecord(value, path, PROVENANCE_KEYS, active);
    const sourceValue = ownValue(record, 'source', path);
    const channelValue = ownValue(record, 'channel', path);
    const actorIdValue = ownValue(record, 'actorId', path);
    const applicationIdValue = ownValue(record, 'applicationId', path);
    const sessionIdValue = ownValue(record, 'sessionId', path);
    const source = enumeration(sourceValue, `${path}.source`, PROVENANCE_SOURCES);
    const channel = enumeration(channelValue, `${path}.channel`, PROVENANCE_CHANNELS);
    const nullableIdentifierOptions = {
        nullable: true
    };
    const actorId = identifier(actorIdValue, `${path}.actorId`, nullableIdentifierOptions);
    const applicationId = identifier(applicationIdValue, `${path}.applicationId`, nullableIdentifierOptions);
    const sessionId = identifier(sessionIdValue, `${path}.sessionId`, nullableIdentifierOptions);
    finishRecord(record, active);
    const provenance = { source, channel, actorId, applicationId, sessionId };
    return Object.freeze(provenance);
}

function cloneGoal(value) {
    if (value === null) {
        return null;
    }
    return {
        text: value.text,
        producer: value.producer,
        version: value.version,
        confidence: value.confidence
    };
}

function cloneConstraint(value) {
    return {
        id: value.id,
        kind: value.kind,
        value: value.value,
        description: value.description
    };
}

function cloneResource(value) {
    return {
        id: value.id,
        type: value.type,
        locator: value.locator,
        description: value.description
    };
}

function cloneAmbiguity(value) {
    return {
        id: value.id,
        kind: value.kind,
        description: value.description,
        options: [...value.options]
    };
}

function cloneSensitivity(value) {
    return {
        level: value.level,
        labels: [...value.labels]
    };
}

function cloneProvenance(value) {
    return {
        source: value.source,
        channel: value.channel,
        actorId: value.actorId,
        applicationId: value.applicationId,
        sessionId: value.sessionId,
    };
}

function canonicalRecord(values) {
    return {
        schema: SCHEMA,
        version: VERSION,
        id: values.id,
        createdAt: values.createdAt,
        originalExpression: values.originalExpression,
        normalizedGoal: cloneGoal(values.normalizedGoal),
        constraints: values.constraints.map(cloneConstraint),
        resources: values.resources.map(cloneResource),
        ambiguities: values.ambiguities.map(cloneAmbiguity),
        sensitivity: cloneSensitivity(values.sensitivity),
        provenance: cloneProvenance(values.provenance),
    };
}

function validateAggregate(values) {
    const canonical = canonicalRecord(values);
    const serialized = JSON.stringify(canonical);
    if (byteLength(serialized) > AGGREGATE_MAXIMUM_BYTES) {
        fail('INTENT_ENVELOPE_LIMIT_EXCEEDED', '$', 'Intent envelope exceeds its aggregate size limit.');
    }
}

function normalizeValues(input) {
    const active = new WeakSet();
    const record = plainRecord(input, '$', ROOT_KEYS, active);
    const schema = ownValue(record, 'schema', '$');
    if (schema !== SCHEMA) {
        finishRecord(record, active);
        fail('INTENT_ENVELOPE_UNSUPPORTED_VERSION', 'schema', 'Intent envelope schema is unsupported.');
    }
    const version = ownValue(record, 'version', '$');
    if (version !== VERSION) {
        finishRecord(record, active);
        fail('INTENT_ENVELOPE_UNSUPPORTED_VERSION', 'version', 'Intent envelope version is unsupported.');
    }
    const idValue = ownValue(record, 'id', '$');
    const createdAtValue = ownValue(record, 'createdAt', '$');
    const normalizedGoalValue = ownValue(record, 'normalizedGoal', '$');
    const sensitivityValue = ownValue(record, 'sensitivity', '$');
    const provenanceValue = ownValue(record, 'provenance', '$');
    const values = {
        id: identifier(idValue, 'id'),
        createdAt: normalizeTimestamp(createdAtValue, 'createdAt'),
        originalExpression: boundedString(
            ownValue(record, 'originalExpression', '$'),
            'originalExpression',
            EXPRESSION_MAXIMUM_BYTES,
        ),
        normalizedGoal: normalizeGoal(normalizedGoalValue, 'normalizedGoal', active),
        constraints: normalizeList(
            ownValue(record, 'constraints', '$'),
            'constraints',
            CONSTRAINT_MAXIMUM,
            normalizeConstraint,
            active,
        ),
        resources: normalizeList(
            ownValue(record, 'resources', '$'),
            'resources',
            RESOURCE_MAXIMUM,
            normalizeResource,
            active,
        ),
        ambiguities: normalizeList(
            ownValue(record, 'ambiguities', '$'),
            'ambiguities',
            AMBIGUITY_MAXIMUM,
            normalizeAmbiguity,
            active,
        ),
        sensitivity: normalizeSensitivity(sensitivityValue, 'sensitivity', active),
        provenance: normalizeProvenance(provenanceValue, 'provenance', active)
    };
    finishRecord(record, active);
    validateAggregate(values);
    return values;
}

function normalizeCreatePayload(payload, trustedContext) {
    const active = new WeakSet();
    const source = plainRecord(payload, 'payload', PAYLOAD_KEYS, active);
    const context = plainRecord(trustedContext, 'trustedContext', TRUSTED_CONTEXT_KEYS, active);
    const canonical = {
        schema: SCHEMA,
        version: VERSION,
        id: ownValue(context, 'id', 'trustedContext'),
        createdAt: normalizeTrustedTimestamp(
            ownValue(context, 'createdAt', 'trustedContext'),
            'createdAt'
        ),
        originalExpression: ownValue(source, 'originalExpression', 'payload'),
        normalizedGoal: ownValue(
            source,
            'normalizedGoal',
            'payload',
            {
                required: false,
                defaultValue: null
            }
        ),
        constraints: ownValue(
            source,
            'constraints',
            'payload',
            {
                required: false,
                defaultValue: []
            }
        ),
        resources: ownValue(
            source,
            'resources',
            'payload',
            {
                required: false,
                defaultValue: []
            }
        ),
        ambiguities: ownValue(
            source,
            'ambiguities',
            'payload',
            {
                required: false,
                defaultValue: []
            }
        ),
        sensitivity: ownValue(
            source,
            'sensitivity',
            'payload',
            {
                required: false,
                defaultValue: {
                    level: 'unknown',
                    labels: []
                }
            }
        ),
        provenance: {
            source: ownValue(context, 'source', 'trustedContext'),
            channel: ownValue(context, 'channel', 'trustedContext'),
            actorId: ownValue(context, 'actorId', 'trustedContext'),
            applicationId: ownValue(context, 'applicationId', 'trustedContext'),
            sessionId: ownValue(context, 'sessionId', 'trustedContext'),
        },
    };
    finishRecord(context, active);
    finishRecord(source, active);
    return canonical;
}

function auditConstraint(value) {
    const valueType = value.value === null ? 'null' : typeof value.value;
    return {
        id: value.id,
        kind: value.kind,
        valueType
    };
}

function auditResource(value) {
    return {
        id: value.id,
        type: value.type
    };
}

function auditAmbiguity(value) {
    return {
        id: value.id,
        kind: value.kind,
        optionCount: value.options.length
    };
}

class IntentEnvelope {
    constructor(token, values) {
        if (token !== constructionToken) {
            fail('INTENT_ENVELOPE_INVALID', '$', 'Intent envelopes must be created through the public factory.');
        }
        this.schema = SCHEMA;
        this.version = VERSION;
        this.id = values.id;
        this.createdAt = values.createdAt;
        this.originalExpression = values.originalExpression;
        this.normalizedGoal = values.normalizedGoal;
        this.constraints = values.constraints;
        this.resources = values.resources;
        this.ambiguities = values.ambiguities;
        this.sensitivity = values.sensitivity;
        this.provenance = values.provenance;
        Object.freeze(this);
    }

    toJSON() {
        return canonicalRecord(this);
    }
}

function buildEnvelope(canonical) {
    const values = normalizeValues(canonical);
    return new IntentEnvelope(constructionToken, values);
}

export function createIntentEnvelope(payload, trustedContext) {
    const canonical = normalizeCreatePayload(payload, trustedContext);
    return buildEnvelope(canonical);
}

export function rehydrateIntentEnvelope(canonical) {
    if (canonical instanceof IntentEnvelope) {
        return canonical;
    }

    if (typeof canonical === 'string') {
        try {
            const parsed = JSON.parse(canonical);
            return buildEnvelope(parsed);
        } catch (error) {
            if (error instanceof IntentEnvelopeValidationError) {
                throw error;
            }

            fail(
                'INTENT_ENVELOPE_INVALID',
                '$',
                'Intent envelope JSON is invalid.'
            );
        }
    }
    return buildEnvelope(canonical);
}

export function serializeIntentEnvelope(envelope) {
    const hydrated = rehydrateIntentEnvelope(envelope);
    return JSON.stringify(hydrated);
}

export function intentEnvelopeAuditProjection(envelope) {
    const value = rehydrateIntentEnvelope(envelope);
    const projection = {
        schema: value.schema,
        version: value.version,
        id: value.id,
        createdAt: value.createdAt,
        constraints: value.constraints.map(auditConstraint),
        resources: value.resources.map(auditResource),
        ambiguities: value.ambiguities.map(auditAmbiguity),
        sensitivity: cloneSensitivity(value.sensitivity),
        provenance: cloneProvenance(value.provenance),
    };
    const frozenConstraints = projection.constraints.map(Object.freeze);
    const frozenResources = projection.resources.map(Object.freeze);
    const frozenAmbiguities = projection.ambiguities.map(Object.freeze);
    const frozenSensitivity = {
        ...projection.sensitivity,
        labels: Object.freeze(projection.sensitivity.labels)
    };
    const frozenProjection = {
        ...projection,
        constraints: Object.freeze(frozenConstraints),
        resources: Object.freeze(frozenResources),
        ambiguities: Object.freeze(frozenAmbiguities),
        sensitivity: Object.freeze(frozenSensitivity),
        provenance: Object.freeze(projection.provenance)
    };
    return Object.freeze(frozenProjection);
}

const intentEnvelopeLimits = {
    aggregateBytes: AGGREGATE_MAXIMUM_BYTES,
    ambiguityCount: AMBIGUITY_MAXIMUM,
    constraintCount: CONSTRAINT_MAXIMUM,
    descriptionBytes: DESCRIPTION_MAXIMUM_BYTES,
    expressionBytes: EXPRESSION_MAXIMUM_BYTES,
    goalBytes: GOAL_MAXIMUM_BYTES,
    identifierCharacters: IDENTIFIER_MAXIMUM_CHARACTERS,
    labelBytes: LABEL_MAXIMUM_BYTES,
    optionBytes: OPTION_MAXIMUM_BYTES,
    optionCount: OPTION_MAXIMUM,
    resourceCount: RESOURCE_MAXIMUM,
    resourceLocatorBytes: RESOURCE_LOCATOR_MAXIMUM_BYTES,
    sensitivityLabelCount: SENSITIVITY_LABEL_MAXIMUM
};
const ambiguityKinds = [...AMBIGUITY_KINDS];
const constraintKinds = [...CONSTRAINT_KINDS];
const provenanceChannels = [...PROVENANCE_CHANNELS];
const provenanceSources = [...PROVENANCE_SOURCES];
const resourceTypes = [...RESOURCE_TYPES];
const sensitivityLevels = [...SENSITIVITY_LEVELS];
const intentEnvelopeContractValue = {
    schema: SCHEMA,
    version: VERSION,
    limits: Object.freeze(intentEnvelopeLimits),
    ambiguityKinds: Object.freeze(ambiguityKinds),
    constraintKinds: Object.freeze(constraintKinds),
    provenanceChannels: Object.freeze(provenanceChannels),
    provenanceSources: Object.freeze(provenanceSources),
    resourceTypes: Object.freeze(resourceTypes),
    sensitivityLevels: Object.freeze(sensitivityLevels)
};

export const intentEnvelopeContract = Object.freeze(intentEnvelopeContractValue);
