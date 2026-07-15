# ARCANE Intent Envelope v1

## Purpose

The intent envelope is ARCANE's model-independent, immutable intake record. It preserves what entered the intent boundary, any separately produced normalized goal, inert constraints and resource references, known ambiguity, an asserted sensitivity level, and trusted provenance.

The envelope is data, not authority. Constructing, serializing, or rehydrating one never plans work, selects a capability, grants access, evaluates policy, confirms an action, invokes a model, persists state, or executes anything.

## Public API

`arcane/entities/IntentEnvelope.js` exports:

- `createIntentEnvelope(payload, trustedContext)` for new intake. The untrusted payload cannot supply the authoritative envelope identifier, creation time, actor, application, or session.
- `rehydrateIntentEnvelope(canonical)` for syntax-validating a canonical object or JSON string. Successful syntax validation does not prove authenticity, freshness, authorization, or correct attribution. A caller must bind those properties through an external trusted transport, signature, storage, or session boundary.
- `serializeIntentEnvelope(envelope)` for deterministic canonical JSON suitable for transport and later external hashing. This contract performs no cryptographic hashing.
- `intentEnvelopeAuditProjection(envelope)` for a bounded, content-redacted structural projection. It excludes the original expression, normalized goal, resource locators, constraint/resource/ambiguity descriptions, ambiguity options, and constraint values. It still contains linkable attribution metadata and must remain restricted to authorized audit consumers under the applicable retention policy.
- `IntentEnvelopeValidationError` with stable `code` and `path` fields. Error messages never repeat rejected content.
- `intentEnvelopeContract`, a frozen description of the schema, version, closed enums, and limits.

## Canonical field order and shape

```json
{
  "schema": "arcane.intent-envelope",
  "version": 1,
  "id": "intent:example-1",
  "createdAt": "2026-07-15T14:30:00.000Z",
  "originalExpression": "Create a concise report from the selected files.",
  "normalizedGoal": {
    "text": "Create a concise report from selected files.",
    "producer": "intent-normalizer",
    "version": "1.0.0",
    "confidence": 0.8
  },
  "constraints": [
    {
      "id": "constraint:no-send",
      "kind": "exclusion",
      "value": true,
      "description": "Do not send the report."
    }
  ],
  "resources": [
    {
      "id": "resource:selected-files",
      "type": "file",
      "locator": "selection://files",
      "description": "Files selected by the user"
    }
  ],
  "ambiguities": [
    {
      "id": "ambiguity:format",
      "kind": "meaning",
      "description": "The requested output format is not stated.",
      "options": ["Markdown", "Plain text"]
    }
  ],
  "sensitivity": {
    "level": "unknown",
    "labels": ["user-content"]
  },
  "provenance": {
    "source": "user",
    "channel": "text",
    "actorId": "user:opaque-id",
    "applicationId": "shell",
    "sessionId": "session:opaque-id"
  }
}
```

Every object has an exact set of allowed own data properties. Unknown properties, accessors, inherited properties, nonplain prototypes, reserved pollution keys, sparse arrays, cyclic data, symbols, functions, bigint values, nonfinite numbers, and invalid Unicode fail closed.

## Field contract

| Field | Contract |
|---|---|
| `schema` | Exact string `arcane.intent-envelope`. |
| `version` | Exact safe integer `1`. Later versions require an explicit reader or migration. |
| `id` | Trusted stable identifier, at most 128 characters, using letters, digits, `.`, `_`, `:`, or `-`. |
| `createdAt` | Trusted creation accepts a valid `Date` or canonical UTC ISO timestamp and stores canonical UTC ISO form. Rehydration requires the already-canonical UTC ISO representation so ambiguous or local-time strings cannot be silently rewritten. There is no implicit clock. |
| `originalExpression` | Required original string, preserved as inert data. It is not trimmed, rewritten, interpreted, or content-filtered. It must contain non-whitespace text and is limited to 32 KiB of UTF-8. Hostile, offensive, or prompt-injection text remains evidence and does not gain authority. |
| `normalizedGoal` | `null` or exact `{text, producer, version, confidence}`. Text is limited to 8 KiB; producer and version are stable identifiers; confidence is `null` or a finite number from 0 through 1. The envelope does not produce or trust the goal automatically. |
| `constraints` | At most 64 inert records shaped `{id, kind, value, description}`. Kind is `requirement`, `preference`, `limit`, `exclusion`, or `other`. Value is a JSON scalar: string, finite number, boolean, or `null`. Description is `null` or at most 2 KiB. A constraint is not policy or authorization. |
| `resources` | At most 64 inert references shaped `{id, type, locator, description}`. Type is `file`, `directory`, `uri`, `application`, `record`, `device`, or `other`. Locator is at most 4 KiB and description is `null` or at most 2 KiB. A reference is never a native handle, capability, grant, proof of ownership, or permission. |
| `ambiguities` | At most 32 records shaped `{id, kind, description, options}`. Kind is `reference`, `scope`, `target`, `meaning`, or `other`. Description is at most 2 KiB. There are at most 16 options of at most 512 bytes each. The record preserves known uncertainty; it does not resolve it. |
| `sensitivity` | Exact `{level, labels}` assertion. Level is `unknown`, `public`, `internal`, `confidential`, or `restricted`; omitted intake defaults to `unknown`. There are at most 32 unique labels of at most 256 bytes, sorted for canonical output. `unknown` never means public, and this assertion does not replace classification or release policy. |
| `provenance` | Trusted `{source, channel, actorId, applicationId, sessionId}`. Source is `user`, `application`, `system`, or `import`; channel is `text`, `speech`, `selection`, or `automation`; identifiers are opaque values or `null`. Do not place names, email addresses, credentials, tokens, raw audio, or protected content in identifier fields. |

The complete canonical JSON is limited to 64 KiB of UTF-8, including structure and escaping. Identifiers are limited to 128 characters. Constraint/resource/ambiguity identifiers must be unique within their respective arrays.

## Creation authority boundary

The creation payload accepts only:

- `originalExpression`;
- `normalizedGoal`;
- `constraints`;
- `resources`;
- `ambiguities`;
- `sensitivity`.

The separate trusted context must supply:

- `id`;
- `createdAt`;
- `source` and `channel`;
- `actorId`, `applicationId`, and `sessionId`, including explicit `null` where unavailable.

Passing an authority field in the payload is an unknown-field error. Nothing generates an identifier or timestamp implicitly, so tests and callers remain deterministic.

## Immutability and serialization

The entity reconstructs and deeply freezes every nested value. It retains no caller-owned array or object. `toJSON()` returns a new mutable canonical copy in the documented key order, while `serializeIntentEnvelope()` returns the canonical JSON string.

V1 readers reject other schemas, versions, and unknown fields. They do not guess, discard new fields, or silently migrate. Any field addition, removal, meaning change, or enum-meaning change requires a new version and an explicit reviewed compatibility path. V1 must remain readable after a later version is introduced.

## Errors

| Code | Meaning |
|---|---|
| `INTENT_ENVELOPE_INVALID` | Invalid type, required field, Unicode, timestamp, identifier, enum, scalar, descriptor, prototype, cycle, or JSON syntax. |
| `INTENT_ENVELOPE_UNKNOWN_FIELD` | Unknown, symbolic, reserved, or otherwise unsupported property. |
| `INTENT_ENVELOPE_LIMIT_EXCEEDED` | A byte or item bound was exceeded. |
| `INTENT_ENVELOPE_UNSUPPORTED_VERSION` | The schema or version is not supported by this reader. |

The error `path` identifies the failing field without echoing its value. Public validation errors do not retain parser exceptions that may repeat rejected content.

## Non-goals

V1 intentionally provides no persistence, task state, lineage, replay protection, deduplication, audit ledger, planning, ambiguity resolution, TWiN Compass result, sensitivity inference, capability selection, capability execution, authorization, confirmation, native resource handle, credential, model/provider call, prompt construction, network operation, or user interface.

Those boundaries require separate contracts and must not infer permission from this envelope.
