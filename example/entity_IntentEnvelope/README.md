# IntentEnvelope entity example

This synthetic example creates a model-independent immutable intent record. It performs no persistence, planning, policy evaluation, capability execution, model call, network operation, or user-interface work.

```js
import {
    createIntentEnvelope,
    intentEnvelopeAuditProjection,
    serializeIntentEnvelope,
} from '../../arcane/entities/IntentEnvelope.js';

const payload = {
    originalExpression: 'Summarize the selected notes without sending them.',
    normalizedGoal: null,
    constraints: [
        {
            id: 'constraint:no-send',
            kind: 'exclusion',
            value: true,
            description: 'Do not send the result.'
        }
    ],
    resources: [
        {
            id: 'resource:selected-notes',
            type: 'file',
            locator: 'selection://notes',
            description: 'The user-selected notes.'
        }
    ],
    ambiguities: []
};

const trustedContext = {
    id: 'intent:example-1',
    createdAt: '2026-07-15T14:30:00.000Z',
    source: 'user',
    channel: 'text',
    actorId: 'user:opaque-id',
    applicationId: 'shell',
    sessionId: 'session:opaque-id'
};

const envelope = createIntentEnvelope(
    payload,
    trustedContext
);
const canonicalJSON = serializeIntentEnvelope(envelope);
const audit = intentEnvelopeAuditProjection(envelope);
```

`canonicalJSON` contains the complete canonical envelope and may contain sensitive user data. `audit` contains structural attribution and counts but excludes the expression, normalized goal, locators, descriptions, ambiguity options, and constraint values. Its identity and session metadata remain sensitive and require authorized consumers and bounded retention.

A resource reference is inert. `selection://notes` does not prove that the resource exists, grant access to it, or authorize any operation. Rehydrating stored JSON proves only that its syntax satisfies v1; an external trusted boundary must establish authenticity, freshness, and attribution.

See [`docs/intent-envelope.md`](../../docs/intent-envelope.md) for the complete contract, limits, compatibility rules, and error codes.
