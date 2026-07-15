# ARCANE Security and Privacy Review Standard Operating Procedure

> **Mandatory use:** Follow this SOP for release-candidate review and whenever a change affects identity, authorization, capabilities, privilege, IPC, rendering, packages, updates, recovery, storage, memory, models, providers, networking, diagnostics, audit, or sensitive data movement.

## Required outcome

The reviewer must identify the assets and people ARCANE must protect, the trust boundaries crossed, plausible abuse paths, implemented controls, objective evidence, residual risk, and accountable disposition. Prompts, model behavior, UI wording, and good intentions are not security boundaries.

Use [`threat-model.md`](threat-model.md) as the current-system foundation. Update it when the reviewed change adds or alters an asset, actor, trust boundary, data class, abuse case, control, evidence path, or residual risk; candidate review still requires an independent finding and disposition record.

## Review independence and authority

- The implementer supplies architecture, tests, and evidence but does not unilaterally accept their own critical or high-severity residual risk.
- A qualified reviewer performs or leads the review.
- The named security/privacy authority accepts, rejects, or escalates findings according to organizational policy.
- An automated agent may assist inventory, testing, and analysis but may not provide final risk acceptance.

## Governing principles

1. Enforce identity and authority through the System Platform, process boundaries, signed policy, capabilities, and validated contracts.
2. Grant the least capability, resource scope, time, and privilege necessary.
3. Treat renderers, application content, model output, external content, plugins, and remote providers as untrusted unless a narrower verified boundary applies.
4. Preserve user control and bind sensitive confirmation to the exact action and data.
5. Separate user, application, role, machine, organization, audit, and immutable-policy data.
6. Minimize collected, retained, logged, exported, and remotely transmitted data.
7. Fail closed without silently widening authority or weakening policy.
8. Verify both the expected security property and the actual runtime behavior.

## Procedure

### 1. Declare the review scope

Record:

- change, feature, candidate, version, and source revision;
- supported platform and deployment modes;
- applications, capabilities, services, providers, packages, policies, and data involved;
- entry points and externally controlled inputs;
- identities and roles involved;
- explicit exclusions and assumptions that still require verification.

**Gate:** The review boundary is precise enough to determine when a later change invalidates it.

### 2. Inventory assets and harmful outcomes

Identify assets including:

- user identity, credentials, sessions, profiles, and role membership;
- private user records, conversations, files, memory, and application storage;
- organizational data, policy, audit, model, and machine state;
- signing identity, publisher continuity, package integrity, and release evidence;
- privileged operations, shell bindings, services, ACLs, and recovery journals;
- availability of the shell, Core, model runtime, recovery, and maintenance path;
- user understanding, confirmation, attribution, and ability to interrupt or recover.

For each asset, state the impact of unauthorized disclosure, modification, destruction, denial, impersonation, misattribution, or unsafe action.

**Gate:** The review is based on concrete assets and harm, not a generic security checklist.

### 3. Map trust boundaries and data flow

Diagram or enumerate flows across:

- user to shell or provisioner;
- application/renderer to `window.Arcane`;
- native host to Arcane Core IPC;
- normal Core to elevated worker and pipe guard;
- Core to Microsoft NT adapters and OS resources;
- application to per-user/per-application storage;
- intent/model output to plan, policy, and capability execution;
- local or remote AI provider boundaries;
- package/build/update source to installed baseline;
- diagnostics, audit, export, removable media, and support channels.

For every crossing, record identity, authentication, authorization, integrity, confidentiality, replay protection, input validation, failure behavior, audit, and data classification.

**Gate:** No sensitive or privileged flow is represented as an internal implementation detail without a trust decision.

### 4. Verify identity, authorization, and privilege

Confirm:

- runtime identity comes from the System Platform or another verified source;
- applications cannot grant themselves capabilities or widen them after elevation;
- sensitive methods enforce both capability and allowed application type where applicable;
- role and ACL decisions use stable Microsoft NT identity rather than display names;
- elevated work is short-lived and bound to the exact caller, application, request, parameters, and session;
- stale sessions, PID reuse, SID changes, disabled users, deleted users, and policy changes fail safely;
- normal users cannot use crash or maintenance behavior as an Explorer or administrator escape path.

Evidence should include focused authorization tests, adversarial worker/IPC tests, and real Microsoft NT behavior for affected boundaries.

### 5. Verify renderer, application, and content isolation

Confirm:

- navigation is restricted to approved packaged origins and entries;
- generated Content Security Policy and Permissions Policy default deny;
- renderer permissions are separately enforced from Core capabilities;
- microphone, camera, display capture, downloads, external navigation, clipboard, and embedded content follow explicit grants;
- cross-application storage and resource access are rejected;
- untrusted HTML, Markdown, model output, URLs, and documents cannot invoke native capabilities through injection;
- application packages use positive inventories and exclude development/private material.

### 6. Verify contracts and hostile-input behavior

Review every affected external contract: API, IPC, manifest, intent, plan, policy, memory, provider, package, update, and recovery record.

Test as applicable:

- missing, null, unknown, duplicate, reordered, and type-confused fields;
- oversized values, deep nesting, long streams, queue exhaustion, and storage exhaustion;
- stale, replayed, cross-session, cross-user, and cross-application requests;
- traversal, alternate path syntax, links/reparse points, changed-file races, and unsafe destinations;
- malformed encodings, control characters, command/script injection, and log injection;
- cancellation, timeout, partial response, crash, and restart during durable transitions.

Parsing, validation, retries, queues, logs, and storage must be bounded.

### 7. Verify package, update, and recovery trust

Apply `docs/build-release.md` and confirm:

- approved public dependency sources and locked dependencies;
- exact release inventory, byte size, SHA-256, and unsafe-path rejection;
- production signatures, RFC 3161 timestamps, publisher continuity, rotation, and signed-to-unsigned downgrade rejection;
- transaction-directory identity and safe cleanup;
- staged activation, last-known-good baseline, and deterministic rollback;
- recovery records cannot be substituted, traversed, or applied to the wrong identity or baseline;
- offline packages and removable media receive equivalent verification.

### 8. Review privacy and scoped data handling

For every data class, document:

- purpose and lawful/authorized use;
- source and provenance;
- identity or owner;
- scope and permitted consumers;
- sensitivity and retention;
- storage location and encryption;
- network and provider behavior;
- audit content and redaction;
- export, correction, deletion, backup, restore, and de-identification behavior.

Verify that:

- a participant number or pseudonym is still treated as sensitive when linkable;
- identity mappings, private records, aggregate output, diagnostics, and audit are separated;
- model output cannot promote itself into global, organizational, machine, or policy memory;
- remote-provider use is explicit and constrained before protected content leaves the machine;
- logs and support bundles do not become uncontrolled copies of user content or secrets;
- deletion promises distinguish mutable memory from legally or operationally required audit retention.

### 9. Analyze abuse cases and failure modes

At minimum consider:

- compromised or malicious renderer/application/package;
- prompt injection or hostile content causing tool use;
- model fabrication, over-broad planning, or policy manipulation;
- confused deputy and privilege-broker impersonation;
- stale confirmation or changed parameters after approval;
- policy downgrade, missing policy, conflicting policy, or rollback to weaker policy;
- memory poisoning, cross-scope promotion, or provenance loss;
- cross-user/application data access;
- package/update compromise and publisher substitution;
- diagnostics or audit exfiltration;
- denial of shell, Core, model, recovery, or maintenance availability;
- misleading system prompts, authority spoofing, confirmation fatigue, or inaccessible security controls;
- physical access, offline media, network loss, power loss, and partial durable writes.

For each credible case, record preventive, detective, responsive, and recovery controls plus remaining risk.

### 10. Test controls and preserve evidence

Use the smallest test that proves the actual boundary, then test the nearest integration and real platform where required. Preserve:

- exact candidate/revision and environment;
- test input and expected property;
- observed result and unmodified output;
- focused automated test or fixture;
- real-platform evidence for native, privilege, identity, session, renderer, update, or recovery behavior;
- limitations and untested paths.

Follow `docs/debugging.md` for any discrepancy. A test that checks only source text is not runtime evidence when the security property depends on compiled or installed behavior.

### 11. Classify and disposition findings

| Severity | Meaning | Default disposition |
|---|---|---|
| Critical | Likely or demonstrated compromise causing systemic privilege, code execution, publisher/update compromise, or catastrophic sensitive-data exposure. | Block release and affected deployment. |
| High | Material privilege, cross-user, sensitive-data, policy-bypass, or recovery failure with credible exploitation. | Block release unless formal risk acceptance is explicitly permitted and recorded. |
| Medium | Bounded security/privacy weakness requiring conditions, user action, or limited scope. | Remediate or accept with owner, deadline, monitoring, and workaround. |
| Low | Defense-in-depth, hardening, clarity, or low-impact issue. | Track with owner and rationale. |
| Informational | Observation or future consideration without a current adverse condition. | Record or convert to planned work. |

Severity must consider impact, exploitability, affected identities/data, detectability, persistence, recovery, and deployment context. Do not lower severity merely because exploitation is inconvenient in the review environment.

**Gate:** Every finding has evidence, severity, owner, remediation or acceptance, and validation status.

### 12. Re-review and close

After remediation:

1. reproduce the original failing or abusive condition;
2. preserve the before/after evidence;
3. verify the focused correction;
4. rerun the nearest integration and affected adversarial suite;
5. rebuild and retest the exact release candidate when release artifacts changed;
6. record whether the finding is fixed, mitigated, accepted, deferred, or invalid.

## Compact review record

```markdown
### ARCANE security and privacy review

- Scope/candidate:
- Source revision:
- Reviewer:
- Security/privacy authority:
- Supported deployment profile:

#### Assets and boundaries

- Protected assets:
- Identities and roles:
- Trust boundaries:
- Sensitive data classes and flows:

#### Evidence

- Authorization and privilege:
- Renderer and application isolation:
- Hostile-input/adversarial tests:
- Package, update, and recovery:
- Storage, memory, providers, diagnostics, and audit:
- Real-platform verification:
- Untested paths:

#### Findings

| ID | Finding | Severity | Evidence | Owner | Disposition | Validation |
|---|---|---|---|---|---|---|

#### Decision

- Pass / Conditional pass / Fail:
- Accepted residual risk:
- Required follow-up:
- Authority and date:
```

## Prohibited shortcuts

Do not:

- treat a prompt, system message, model refusal, hidden button, or disabled control as authorization;
- approve security from source inspection when runtime identity or process behavior matters;
- broaden administrator membership instead of defining narrow roles and ACLs;
- log credentials, tokens, temporary passwords, private keys, or unredacted protected content;
- weaken signing, CSP, permission, capability, IPC, or validation controls to make tests pass;
- accept unknown policy or missing evidence as permit;
- combine unrelated changes until a test result cannot identify which control worked;
- let the implementer or an automated agent silently accept critical or high residual risk.

## Completion test

The review is complete only when a reviewer can trace each protected asset through its trust boundaries, threats, controls, tests, findings, remediation, residual risk, and accountable decision for the exact implementation or release candidate under review.
