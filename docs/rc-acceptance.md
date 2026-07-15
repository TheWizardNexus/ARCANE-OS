# ARCANE Release Candidate Acceptance Standard Operating Procedure

> **Mandatory use:** Follow this SOP before labeling, approving, publishing, or piloting any ARCANE build as a release candidate.

## Required outcome

An ARCANE release candidate is a production-signed, evidence-backed candidate that demonstrates the supported operating-system journey on a clean Microsoft NT machine. Passing compilation, unit tests, portable package checks, an unsigned local installation, or an application launch is not sufficient.

Candidate eligibility, pilot entry, pilot expansion, and pilot exit must also satisfy the measurable floors and human-authority decisions in [`rc-success-criteria.md`](rc-success-criteria.md).

The release authority must be able to trace every P0 requirement to an implemented behavior, objective evidence, an accountable owner, and a disposition. Unknown, simulated, deferred, or manually unverified behavior must never be reported as complete.

## Roles

| Role | Responsibility |
|---|---|
| Release owner | Coordinates the candidate, freezes scope, assembles evidence, and records the recommendation. |
| Product authority | Confirms the supported user journey, product boundary, and accepted limitations. |
| Engineering authority | Confirms source revision, build provenance, migrations, compatibility, and technical evidence. |
| Security and privacy authority | Applies [`security-privacy-review.md`](security-privacy-review.md) and accepts or rejects residual risk. |
| Accessibility authority | Applies [`accessibility-verification.md`](accessibility-verification.md) and accepts or rejects accessibility limitations. |
| Microsoft NT acceptance operator | Performs the controlled clean-machine and real-login sequence without automating protected user actions. |
| Final release authority | Makes and signs the go, conditional-go, or no-go decision. This role must not be replaced by an automated check. |

One person may hold multiple roles when organizational policy permits, but the evidence and decisions remain separately recorded.

## Governing rules

1. Evaluate one immutable candidate: exact source revision, version, manifest inventory, signer, timestamp evidence, and hashes.
2. Keep development-signed, unsigned-local-test, and production-signed evidence separate.
3. Use the build and release SOP for dependency, canonical-byte, signing, packaging, and clean-build requirements.
4. Use the debugging SOP for every unexpected result. Do not patch the acceptance environment and continue calling it clean.
5. Use the security/privacy and accessibility SOPs before go/no-go.
6. Treat `Ideation/` as direction, not evidence of implemented behavior.
7. Record absent evidence as absent. A plausible explanation, source assertion, or simulated transaction is not runtime proof.
8. Never bypass SmartScreen, UAC, authentication, credential-change, secure-attention, or publisher-continuity controls to complete acceptance.
9. A changed binary, manifest, package, policy, model baseline, or migration produces a new candidate and invalidates affected downstream evidence.

## Required release artifacts

Create a release evidence directory or controlled release record containing:

- candidate version, source revision, build time, platform, and release owner;
- exact release inventory, sizes, SHA-256 hashes, security mode, signer identity, and RFC 3161 timestamp evidence;
- dependency-lock verification, public dependency sources, toolchain versions, and software bill of materials;
- [`rc-requirements-traceability.md`](rc-requirements-traceability.md), updated with candidate status, named owners, evidence locations, and dispositions;
- automated test results and exact commands;
- security/privacy review record and unresolved findings;
- accessibility verification record and unresolved findings;
- clean-machine Microsoft NT acceptance record;
- install, update, rollback, recovery, and maintenance results;
- known defects, limitations, operational prerequisites, support path, and rollback triggers;
- final decision, decision-makers, conditions, and date.

Do not place credentials, private signing material, temporary passwords, protected user content, or unnecessary personal information in release evidence.

## Procedure

### 1. Declare the candidate boundary

Record:

- product name and semantic version;
- exact source revision and whether the worktree was clean;
- supported Microsoft NT editions, architecture, hardware floor, renderer, model runtime, and network modes;
- included applications and capability versions;
- installation, update, rollback, and recovery paths;
- supported user and administrator roles;
- explicit exclusions and experimental targets;
- production signing identity and expected publisher continuity.

**Gate:** Every reviewer is evaluating the same immutable candidate and supported deployment profile.

### 2. Freeze requirements and traceability

For every release requirement, record:

- stable requirement identifier;
- source requirement or stakeholder decision;
- P0, P1, or P2 priority;
- implemented, partial, simulated, manually verified, absent, or deferred status;
- implementation surface;
- automated and manual evidence;
- accountable owner;
- open finding or approved disposition.

Every P0 requirement must be implemented and objectively evidenced. A P1 deferral requires a named owner, impact statement, workaround where applicable, and explicit release-authority acceptance. P2 work does not block the first Microsoft NT RC unless it invalidates a supported claim.

**Gate:** No P0 requirement lacks an owner, implementation, evidence, or disposition.

### 3. Verify build provenance and production signing

Follow `docs/build-release.md` from a fresh checkout. At minimum:

1. verify committed dependency locks use approved public sources;
2. install locked dependencies with `npm ci`;
3. run focused generation and contract checks;
4. run `npm run release:check`;
5. build through the authorized production-signing path;
6. verify every distributed executable, manifest, application asset, content binding, signer, and RFC 3161 timestamp;
7. record the exact commands, outputs, hashes, and exit codes.

Development-signed and unsigned-local-test results may support engineering iteration but cannot satisfy this gate.

**Gate:** The candidate is reproducibly built, production-signed, timestamped, exact-inventory verified, and bound to the declared source revision.

### 4. Run automated verification

Run the full repository and platform gates without suppressing or reinterpreting failures. Preserve:

- command line and working directory;
- environment and toolchain versions;
- start and completion time;
- unmodified output and exit code;
- generated reports and fixtures;
- any skipped or unavailable check and its impact.

Rerunning a flaky or failed check does not erase the first result. Investigate it using `docs/debugging.md`, correct the code, build a new candidate when required, and rerun the affected chain from a clean state.

**Gate:** Every required automated check passes on the candidate or the candidate is rejected.

### 5. Complete security and privacy review

Apply [`security-privacy-review.md`](security-privacy-review.md) to the exact candidate. Confirm review of the privileged broker, identity and ACLs, application allowlists, renderer isolation, IPC, package verification, update/rollback, intent and policy boundaries when present, memory and storage, model/provider boundaries, diagnostics, and recovery.

**Gate:** No unresolved critical or high-severity security/privacy finding remains unless the named release authority records a formal risk acceptance permitted by organizational policy.

### 6. Complete accessibility verification

Apply [`accessibility-verification.md`](accessibility-verification.md) to the provisioner, shell, confirmations, supported applications, errors, maintenance, and recovery paths. Test the complete reference journey, not only isolated components.

**Gate:** No unresolved accessibility blocker prevents a supported user from installing, signing in, understanding, controlling, or recovering ARCANE within the declared conformance baseline.

### 7. Perform controlled Microsoft NT acceptance

Use a disposable supported Microsoft NT machine and the production-signed candidate. Follow the current machine bundle's `VALIDATION.md` acceptance sequence, substituting only values explicitly authorized in the test plan.

The operator must verify:

1. clean-machine prerequisites and before-state;
2. publisher, version, security mode, target path, and requested elevation;
3. transactional install or update and baseline record;
4. staged creation of a standard ARCANE test user without changing protected accounts;
5. private capture of the temporary credential outside logs and automation;
6. separate activation and stable SID, groups, profile, ACLs, and shell bindings;
7. real sign-in and private first-password change;
8. ARCANE Shell as the normal environment;
9. approved application launch and allowed/denied capability behavior;
10. lock, unlock, logout, login, renderer/Core failure, hung initialization, and recovery;
11. update and deterministic rollback when included in the candidate;
12. audited administrator maintenance and shell restoration when included;
13. after-state proving unrelated accounts, groups, ACLs, and platform configuration remain unchanged.

Do not automate password entry, password-change UI, UAC approval, or other protected operator actions.

**Gate:** Every expected state is observed from the real ARCANE user session and preserved in the acceptance record.

### 8. Exercise the supported ARCANE reference journey

For the capabilities included in the candidate, verify the user can:

- identify the current user, role, release, model/network state, and policy context;
- express or select a supported intent;
- understand the proposed action and material ambiguity;
- see the capabilities, data, applications, destinations, and confirmations involved;
- approve, deny, interrupt, correct, cancel, or resume as supported;
- receive progress, errors, and results without hidden privilege expansion;
- inspect action provenance and audit evidence;
- restart or recover without replaying sensitive actions or crossing memory/storage scopes.

If a defining ideated layer is not yet implemented, the candidate must not claim it. Record the limitation in the product boundary and release notes.

**Gate:** Supported claims match observed behavior and the traceability matrix.

### 9. Review defects, operational readiness, and rollback

Classify every known defect by user/mission impact, security/privacy impact, accessibility impact, likelihood, detectability, workaround, and rollback consequence.

Confirm:

- installation and recovery instructions are current;
- diagnostic and support-bundle paths protect sensitive data;
- model/runtime prerequisites and offline behavior are documented;
- support ownership and escalation contacts are assigned;
- rollback triggers are measurable;
- the previous known-good baseline remains available and verified;
- release notes distinguish implemented behavior, limitations, and future direction.

**Gate:** Operations can detect failure, support the deployment, and return to a verified baseline.

### 10. Make the go/no-go decision

The final release authority records one decision:

- **Go:** Every P0 gate passes and no unaccepted blocker remains.
- **Conditional go:** Every P0 safety and security gate passes; narrowly defined P1 conditions have named owners, deadlines, monitoring, and rollback triggers.
- **No-go:** A required gate failed, evidence is absent or invalid, the candidate changed, or residual risk exceeds authority.

Silence, a meeting without a record, or shipment by schedule does not constitute approval.

## Compact RC acceptance record

```markdown
### ARCANE RC acceptance record

- Candidate version:
- Source revision:
- Production signer and timestamp evidence:
- Supported deployment profile:
- Release owner:
- Final release authority:

#### Evidence gates

- Requirements traceability: Pass / Fail
- Clean build and production signing: Pass / Fail
- Automated release gate: Pass / Fail
- Security and privacy review: Pass / Fail
- Accessibility verification: Pass / Fail
- Clean-machine Microsoft NT acceptance: Pass / Fail
- Reference journey: Pass / Fail
- Update, rollback, maintenance, and recovery: Pass / Fail / Not in scope
- Operational readiness: Pass / Fail

#### Findings

- P0 blockers:
- Accepted P1 limitations:
- Known P2 work:
- Invalidated or unavailable evidence:

#### Decision

- Decision: Go / Conditional go / No-go
- Conditions and rollback triggers:
- Decision-makers:
- Date:
```

## Prohibited shortcuts

Do not:

- call an unsigned-local-test or development-signed artifact an RC;
- count simulation, source review, compilation, or package generation as real-login acceptance;
- reuse evidence from a different binary, manifest, signer, policy, model baseline, or source revision;
- hide a failed first run behind a successful retry;
- downgrade, disable, or bypass security to finish acceptance;
- expose credentials or protected user data in evidence;
- approve a candidate with an ownerless P0 requirement;
- describe ideation as shipped behavior;
- let an automated agent make the final release decision.

## Completion test

The RC process is complete only when an independent reviewer can start with the declared candidate and trace a continuous evidence chain through requirements, source/build provenance, production signing, automated gates, security/privacy, accessibility, real Microsoft NT behavior, supported user journeys, operations, rollback, and the signed release decision.
