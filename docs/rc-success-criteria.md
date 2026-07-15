# ARCANE Release Candidate and Pilot Success Criteria

> **Purpose:** This standard defines the measurable evidence required to call an ARCANE build a release candidate, admit it to a controlled pilot, expand that pilot, or exit the pilot. It supplements the [release candidate acceptance SOP](rc-acceptance.md); it does not replace any SOP gate or authorize release activity.

## Decision model

ARCANE uses four distinct decisions. Evidence for one decision does not silently satisfy another.

| Decision | Meaning | Accountable authority |
|---|---|---|
| RC eligible | One immutable candidate has passed every applicable technical and review gate. | Release owner recommends; final release authority approves. |
| Pilot entry | An RC is approved for a named, bounded deployment with support and rollback ready. | Product, security/privacy, accessibility, operations, and final release authorities. |
| Pilot expansion | Observed results permit a larger but still controlled deployment. | Final release authority, with the same functional authorities reviewing affected evidence. |
| Pilot exit | The pilot has met its minimum duration, coverage, reliability, safety, usability, support, and rollback measures. | Final release authority records go, conditional go, or no-go for the next release stage. |

An automated agent may collect, validate, and summarize evidence. It may not approve risk, waive a gate, authorize pilot entry, or make the final decision.

## Measurement rules

1. Measure one immutable candidate by semantic version, source revision, release inventory, SHA-256 hashes, signer, timestamp evidence, policy baseline, model baseline, and supported deployment profile.
2. Count a check only when its command, environment, start and finish time, unmodified output, and exit code are preserved.
3. Count a user journey only when every required step reaches its expected state. A partial journey is a failure for that attempt.
4. Count retries, recovered failures, and operator workarounds in the first-attempt and incident measures. A successful retry does not erase the original result.
5. Separate automated, simulated, development-signed, unsigned-local-test, production-signed, and real-session evidence.
6. Use the [RC requirements traceability matrix](rc-requirements-traceability.md) as the requirement inventory. Ideation and source presence are not runtime evidence.
7. Exclude planned maintenance only when it was declared before the measurement window. Do not exclude crashes, hangs, failed updates, recovery actions, security denials, or support interventions.
8. Redact credentials and protected user content from evidence without removing the timestamps, identifiers, outcomes, or correlations needed to verify a result.
9. A changed binary, manifest, policy, model baseline, migration, or package creates a new candidate. Rerun every affected gate and downstream journey.
10. Record unavailable evidence as unavailable and treat it as a failed gate when the evidence is required.

## Severity and priority model

Requirement priority and defect severity answer different questions. Priority states whether a capability is required for the supported claim. Severity states the impact of an observed defect or incident.

| Severity | Definition | Examples | RC and pilot disposition |
|---|---|---|---|
| S0 Critical | Actual or credible loss of trust boundary, uncontrolled privilege or data disclosure, unrecoverable corruption, unsafe account or shell change, signing or update-chain compromise, or loss of control that can materially harm a person or mission. | Capability authorization bypass; credential exposure; cross-user memory disclosure; rollback corrupts the known-good baseline. | Immediate no-go or pilot stop. No waiver in this standard. |
| S1 High | A supported P0 journey cannot complete safely or reliably; recovery, security, privacy, accessibility, identity, install, update, rollback, or normal shell operation fails without an acceptable bounded workaround. | User cannot sign in or recover; protected account changes; privileged operation executes with incorrect binding; keyboard-only user cannot complete provisioning. | Blocks RC and pilot entry. Stops expansion. An active pilot pauses affected use and invokes rollback or containment. |
| S2 Moderate | Supported behavior is materially degraded, produces an incorrect result, or requires a documented workaround, but preserves trust boundaries, data integrity, user control, and recovery. | One noncritical application action fails; status is misleading but the action remains controllable; support intervention restores bounded state. | Must have owner, impact, workaround, target date, monitoring, and explicit release-authority disposition. It cannot invalidate a P0 requirement or supported claim. |
| S3 Low | Minor presentation, wording, discoverability, or efficiency defect with no material effect on correctness, safety, privacy, accessibility baseline, or recovery. | Cosmetic alignment issue; nonblocking copy inconsistency. | Tracked with owner and target disposition; does not independently block entry or exit. |

When impact is uncertain, assign the more severe plausible level until evidence narrows it. Security/privacy and accessibility authorities may raise severity within their accountable domains. Only the final release authority may accept an S2 limitation for pilot entry or exit, and the acceptance must be recorded.

## RC eligibility criteria

The release owner may recommend **RC eligible** only when all criteria below pass for the exact candidate.

### Requirements and product boundary

- 100% of P0 rows in `docs/rc-requirements-traceability.md` are implemented and linked to objective evidence.
- 0 P0 rows are absent, simulated-only, ownerless, or without disposition. A P0 requirement may leave the RC boundary only through an explicit priority and disposition change in the traceability matrix approved by the accountable product and release authorities before candidate freeze; narrowing release wording does not remove it.
- 100% of P1 deferrals identify impact, workaround where applicable, named owner, target date, monitoring, and explicit release-authority acceptance.
- 100% of exclusions, experimental targets, and unimplemented ideation are absent from supported product claims and release notes describe the limitation accurately.
- Every accountable role in the candidate acceptance record is bound to a named person.

### Build, package, and signing

- `npm run release:check` completes once from the required clean state with exit code `0`; no required check is skipped or suppressed.
- 100% of distributed files match the declared positive inventory, byte size, and SHA-256 hash.
- 100% of distributed executables that require signing have the authorized production signer, valid publisher continuity, and valid RFC 3161 timestamp evidence.
- 0 unapproved, extra, changed, unsafe-path, unsigned, development-signed, or unsigned-local-test artifacts are present in the production candidate.
- Dependency locks use approved public sources and the candidate record includes toolchain versions, lock verification, build provenance, and the required software bill of materials.

The repository's current command hierarchy is authoritative: `npm run check` covers shared, application, package, and portable machine-bundle gates; `npm run release:check` adds the compiled Microsoft NT gate. Neither command substitutes for production signing or real-session acceptance.

### Security, privacy, and accessibility

- The exact candidate passes the security/privacy review required by `docs/security-privacy-review.md`.
- The exact candidate passes the accessibility verification required by `docs/accessibility-verification.md` across the complete supported journey.
- 0 unresolved S0 or S1 findings remain.
- 0 accepted S2 findings invalidate a P0 requirement, supported security/privacy claim, or declared accessibility baseline.
- 100% of accepted residual findings have an owner, bounded affected scope, workaround or containment, target date, monitoring signal, and rollback trigger.

### Real Microsoft NT acceptance

- The production-signed candidate completes the controlled Microsoft NT acceptance sequence in the current machine bundle's [validation record](../machine_bundles/arcane-os-machine-bundle-v0.8.4/VALIDATION.md), using the adaptation authorized by `docs/rc-acceptance.md`: launch the exact production-signed artifact without `--allow-unsigned-local-release`, require the expected verified-publisher identity instead of the unsigned-local warning, and preserve every other account, UAC, credential, shell, application, failure, recovery, and after-state check.
- The account staging, private credential handling, separate activation, first real sign-in, password change, shell session, allowed and denied capability behavior, lock/unlock, logout/login, failure recovery, and after-state are observed on a disposable supported machine.
- 0 protected or unrelated accounts, groups, SIDs, ACLs, shell bindings, or platform settings differ unexpectedly between the recorded before-state and after-state.
- 100% of requested UAC approvals, password entry, password changes, and other protected interactions are performed by the authorized human operator; none are automated or bypassed.
- Every expected state is evidenced from the real ARCANE user session. Simulation, source assertions, or compiled dispatch tests do not count toward this measure.

### Reliability, recovery, and operations

- Each supported critical journey passes on its first attempt in the final acceptance run.
- Required install, update, rollback, recovery, maintenance, and shell-restoration cases pass with their expected state and preserved evidence.
- Every injected or naturally observed failure has a recorded disposition following `docs/debugging.md`; no unexplained flaky or intermittent failure remains.
- The previous known-good baseline is available, exact-inventory verified, and successfully restored in the required rollback exercise.
- Support ownership, escalation path, diagnostics procedure, privacy-safe support-bundle process, rollback triggers, release notes, prerequisites, and known limitations are complete and current.

### RC blocker thresholds

RC eligibility is **Fail** when any of the following is true:

- one or more S0 or S1 findings is unresolved;
- one P0 requirement lacks implementation, evidence, owner, or acceptable disposition under the frozen traceability matrix;
- one required automated, signing, package, security/privacy, accessibility, clean-machine, real-login, recovery, or rollback gate fails or is unavailable;
- the candidate or its declared baseline changes after evidence collection;
- a successful result depends on bypassing a platform protection, hiding a first-run failure, or using evidence from another candidate;
- operations cannot detect the failure modes, support the pilot, or restore the verified baseline.

## Controlled pilot entry criteria

Pilot entry requires an RC-eligible candidate plus a written pilot plan containing:

- named sponsor, final release authority, operations lead, security/privacy authority, accessibility authority, and support contacts;
- exact candidate and known-good rollback baseline;
- supported Microsoft NT editions, architecture, hardware, renderer, model/provider, network mode, and included applications;
- named participants or approved participant cohort, sites, machines, roles, and maximum deployment count;
- start date, minimum observation period, review cadence, and planned end date;
- critical journeys and expected attempt volume;
- consent, privacy notice, data-handling rules, and participant support path;
- telemetry and evidence that are necessary, minimized, access-controlled, and retention-bounded;
- S0/S1 stop triggers, S2 containment rules, rollback triggers, and the person authorized to invoke them;
- communication plan for incidents, rollback, and pilot closure.

Before the first participant uses ARCANE:

- 100% of pilot machines pass the approved preflight and exact candidate verification;
- 100% have a tested path to the exact known-good baseline;
- 100% of pilot operators and support personnel acknowledge the runbook and escalation path;
- monitoring and support intake are operational;
- no pilot participant is required to exercise an excluded or experimental capability.

## Pilot measures

Measure these values for the entire pilot and by candidate, site, supported machine profile, and critical journey.

The numeric values below are minimum evidence floors for the first controlled pilot, not statistical proof of production reliability. Before pilot entry, the product, engineering, security/privacy, accessibility, operations, and final release authorities must document why the selected duration, cohort, machine profiles, journey volumes, and percentages are proportionate to the deployment risk. They may raise any floor. Lowering one requires an explicit traceability and risk decision before candidate freeze and cannot weaken a P0, security/privacy, accessibility, recovery, or rollback gate.

Every percentage measure must declare its numerator, denominator, minimum planned exercise count, and supported profiles before the pilot begins. Mandatory recovery, rollback, install/update, accessibility-mode, participant-control, and boundary evidence must include planned exercises even when no natural incident occurs. A zero denominator, volume below the approved minimum, or profile without required observations is **unavailable** and fails the associated evidence gate; it is never treated as 100%.

| Measure | Calculation | Required pilot-exit threshold |
|---|---|---:|
| Critical-journey completion | Completed attempts without S0/S1 impact divided by all started attempts. | At least 99%. |
| First-attempt critical-journey completion | Completed without retry, restart, rollback, or support intervention divided by all started attempts. | At least 95%. |
| Unexpected shell or Core termination | Count of unplanned terminations during active supported use. | 0 causing S0/S1 impact; all others diagnosed and dispositioned. |
| Recovery success | Recovery attempts reaching the documented safe expected state divided by all recovery attempts. | 100%. |
| Install/update success | Supported install or update attempts reaching the health-gated baseline divided by all such attempts. | 100%; every failure must roll back safely. |
| Rollback success | Invoked rollbacks restoring the exact verified known-good baseline divided by all invoked rollbacks. | 100%. |
| Capability-boundary correctness | Tested allowed operations allowed plus tested denied operations denied, divided by all boundary tests. | 100%. |
| Data and identity integrity | Pilot machines with no unexplained user, group, SID, ACL, shell-binding, package, memory-scope, or artifact-integrity change. | 100%. |
| Support-contained incidents | S2/S3 incidents resolved or acceptably contained within the documented response target. | 100%; every incident also requires individual explanation and disposition. |
| Evidence completeness | Required pilot events with correlated candidate, user/session-safe identifier, journey, outcome, incident, and disposition evidence. | 100%. |
| Accessibility journey completion | Completed supported journeys by participants using declared accessibility modes divided by attempts in those modes. | At least 95%, with 0 accessibility S0/S1 findings. |
| Participant control | Sampled sensitive actions where approval, denial, cancellation, correction, and provenance behaved as declared. | 100%. |

Percentages never override severity. One S0 or S1 event fails the associated safety gate even when the aggregate percentage remains above threshold.

## Pilot exit criteria

The final release authority may record a successful pilot exit only when the approved risk rationale establishes that the minimum evidence floors below are sufficient for this bounded pilot:

1. The pilot ran for at least 14 consecutive calendar days after the last candidate-changing deployment.
2. At least 5 approved participants completed the pilot on at least 3 independently provisioned supported Microsoft NT machines.
3. Each declared critical journey has at least 10 completed attempts and has been exercised by at least 3 participants, unless the pilot plan establishes a higher requirement.
4. Every required pilot measure meets its threshold for the full observation window and for each supported profile with enough attempts to evaluate.
5. There are 0 unresolved S0 or S1 findings and 0 unexplained security, privacy, accessibility, identity, data-integrity, update, rollback, or recovery events.
6. Every S2 finding has explicit final-release-authority disposition, owner, bounded impact, workaround or containment, target date, and monitoring. No accepted S2 invalidates a P0 claim.
7. Every P0 requirement remains evidenced on the candidate used during the final observation window.
8. Security/privacy, accessibility, operations, engineering, and product authorities review the pilot evidence and record their recommendation.
9. Support records show the deployment can be diagnosed and recovered without credentials, protected content, or uncontrolled personal data in evidence.
10. The final release authority records go, conditional go, or no-go for the next stage, including conditions, deadlines, monitoring, and rollback triggers.

If the candidate changes, restart the 14-day observation window and rerun affected criteria. A documentation-only correction that does not change the candidate, supported claim, operator procedure, or measured interpretation may be accepted without restarting only when the release authority records that determination.

## Immediate pilot stop and rollback triggers

Pause affected use immediately and invoke the approved containment or rollback plan when any of the following occurs:

- an S0 event or credible S0 condition;
- an S1 security, privacy, accessibility, identity, data-integrity, shell, update, rollback, or recovery event;
- candidate identity, signer, inventory, policy baseline, or model baseline cannot be verified;
- a protected or unrelated account, ACL, shell binding, group, package, or platform setting changes unexpectedly;
- ARCANE cannot restore user control through the documented recovery path;
- required monitoring or evidence collection becomes unavailable long enough that safe operation cannot be established;
- incident volume exceeds support capacity or an incident cannot be contained within its documented response target;
- the final release authority, security/privacy authority, or accessibility authority orders a stop within their accountable boundary.

The incident must follow `docs/debugging.md` one verified step at a time. Do not patch pilot machines and continue measuring the old candidate as though it were unchanged.

## Evidence record

```markdown
### ARCANE RC and pilot success record

- Candidate version and source revision:
- Inventory and SHA-256 evidence:
- Production signer and RFC 3161 timestamp evidence:
- Supported deployment profile:
- Known-good rollback baseline:
- Pilot cohort, sites, and machines:
- Observation window:
- Final release authority:

#### RC eligibility

- P0 requirements evidenced:
- Automated release gate:
- Package and production signing:
- Security/privacy review:
- Accessibility verification:
- Microsoft NT acceptance:
- Recovery and rollback:
- Operations readiness:

#### Pilot results

- Critical-journey completion:
- First-attempt completion:
- Install/update success:
- Recovery success:
- Rollback success:
- Capability-boundary correctness:
- Data and identity integrity:
- Accessibility journey completion:
- Participant-control sampling:
- Support-contained incidents:
- Evidence completeness:

#### Findings and decision

- S0 findings:
- S1 findings:
- Accepted S2 findings:
- S3 findings:
- Stop or rollback events:
- Authority recommendations:
- Decision: Go / Conditional go / No-go
- Conditions, deadlines, monitoring, and rollback triggers:
- Decision-makers and date:
```

## Human-authority decisions

This standard supplies a conservative first-pilot baseline. Before pilot entry, the named authorities must approve:

- the exact supported product claim and P0/P1/P2 boundary;
- the cohort, deployment count, sites, critical journeys, and every selected threshold; lowering a minimum evidence floor requires the product, engineering, security/privacy, accessibility, operations, and final release authorities to approve the documented traceability and risk rationale before candidate freeze;
- organizational incident-response times used by the support-contained-incident measure;
- what constitutes a candidate-changing policy, model, procedure, or documentation change;
- consent, privacy, evidence retention, and access rules;
- every accepted S2 limitation and every conditional-go term;
- production signing, protected operator actions, pilot entry, expansion, exit, and final go/no-go.

These decisions cannot be inferred from ticket completion or delegated to automation.
