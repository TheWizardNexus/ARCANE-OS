# ARCANE Microsoft NT Release-Candidate Accessibility Baseline

## Purpose and status

This document declares the minimum accessibility conformance and evidence baseline for an ARCANE release candidate (RC) on Microsoft NT. It operationalizes the [accessibility verification SOP](accessibility-verification.md); it is not itself verification evidence and does not claim that the current implementation or any candidate passes.

The engineering target is WCAG 2.2 Level AA for applicable user-facing content and operation, supplemented by the platform and complete-journey requirements below. This is an internal RC acceptance target, not a legal certification or a claim of formal third-party conformance.

The accessibility authority must bind every completed record to an exact source revision, packaged candidate, Microsoft NT build, native host version, WebView2 runtime, application catalog, and test date. Results from a development browser, source inspection, or a different build do not transfer automatically to the candidate.

## Supported reference environment

The candidate's release record must replace every `TBD` value before verification begins.

| Dimension | Required RC declaration |
|---|---|
| Microsoft NT | Exact supported Windows edition, version, OS build, architecture, and patch level: `TBD` |
| Native host | Exact ARCANE host and machine-bundle version: `TBD` |
| Embedded runtime | Exact Microsoft Edge WebView2 runtime version and distribution mode: `TBD` |
| Display | 1920 x 1080 at 100%; supported low-resolution viewport; 200% and 400% browser/content zoom or equivalent reflow; Windows display scaling at 100%, 150%, and 200% |
| Input | Keyboard only; keyboard plus pointer; touch when claimed as supported; no speech-only requirement |
| Screen reader | NVDA current stable with the candidate WebView2 runtime; Windows Narrator on the declared Windows build as a secondary platform check |
| Visual adaptation | Windows Contrast Themes/forced colors; ARCANE light, dark, system; one valid custom theme; one deliberately low-contrast custom-theme attempt and safe warning/rejection/correction/reset path |
| Motion | Windows animation effects off and ARCANE reduced-motion preference where available |
| Language | English (`en`) for RC; additional languages require their own declaration and evidence |
| Applications | Exact packaged application catalog and versions from the candidate's `arcane-apps.json`: `TBD` |

NVDA is the primary RC screen-reader combination because it supplies a repeatable Windows test target. Narrator is not a substitute for NVDA evidence and NVDA is not a substitute for representative-user evaluation. If the product later claims another screen reader or Windows version, that combination must be added rather than inferred.

## Conformance requirements

A supported user must be able to perceive, understand, and complete the same protected outcome without relying exclusively on vision, hearing, color, motion, speech, fine pointer control, or memorized layout. An accessible route must preserve the same authentication, authorization, privacy, confirmation, audit, and recovery boundaries as the default route.

The candidate must demonstrate all of the following:

1. Native semantic structure, names, roles, states, values, relationships, and status announcements are accurate in the rendered accessibility tree.
2. Every supported action is reachable and operable by keyboard with logical order, visible focus, documented composite-widget behavior, no trap, and safe focus restoration.
3. Dynamic readiness, busy state, progress, result, error, authority, and recovery are exposed without requiring visual DOM inspection. ARCANE's event-plus-sticky-state contract in [readiness.md](readiness.md) remains a runtime contract; accessible status must also reach the user.
4. Text, meaningful graphics, focus, selection, required, disabled, warning, error, and success states meet the declared contrast target and do not depend on color alone.
5. Content remains understandable and operable at the required zoom, display scaling, font substitution, text spacing, and reflow conditions without clipping or loss of controls.
6. Windows forced colors, light, dark, system, and a valid custom ARCANE theme retain meaning, focus visibility, and operation.
7. Reduced motion suppresses nonessential movement; audio and speech have complete text/visual alternatives; media has the alternatives required by its purpose.
8. Errors identify what happened, what did not happen, and the safe next action. Cancellation, denial, interruption, retry, correction, lock/logout, restart, degraded mode, and recovery return focus and context predictably.
9. Security-sensitive prompts identify the action, actor, target, data movement, destination, consequence, and cancel path before commitment. Native UAC transitions have understandable ARCANE context before and after the secure-desktop boundary.
10. Supported applications inherit the shared ARCANE theme and interaction foundations without weakening these requirements through app-local behavior.

## Required verification matrix

Each row requires a pass/fail result, evidence location, verifier, date, finding IDs, and exact environment. “Inspect” means rendered/runtime inspection, not source-only review.

| Layer | Required cases | Method | Minimum evidence |
|---|---|---|---|
| Static and contract checks | Candidate provisioner, shell, shared components, and every packaged app entry point | HTML/ARIA validation; applicable automated accessibility rules; focused contract tests; package and nested-route checks | Tool name/version/configuration, raw output, exclusions, false-positive disposition, and test command exit code |
| Accessibility tree | Provisioner, shell, modal, navigation, forms, tables, file manager, chat/output, terminal, notifications, errors, and recovery | WebView2 accessibility-tree inspection | Captures or structured exports showing names, roles, states, relationships, hidden/inert behavior, and live regions |
| Keyboard | Every critical journey and representative component state | Keyboard only, including Tab, Shift+Tab, arrows, Enter, Space, Escape, and documented shortcuts | Step log; focus order; focus-return result; trap/shortcut findings; video only as supplemental evidence |
| NVDA | Every critical journey, including failure and recovery | NVDA current stable with focus and browse modes as applicable | NVDA version/configuration, speech-viewer or transcript excerpts, exact missing/duplicated/misleading announcements, task result |
| Narrator | Provisioner, shell launch, sensitive confirmation, one representative app, error, and recovery | Narrator on the declared Microsoft NT build | Version/build, navigation method, announcement notes, task result |
| Visual themes | Light, dark, system, valid custom theme, low-contrast custom-theme attempt/recovery, and Windows forced colors | Runtime inspection, computed-color measurement, keyboard/screen-reader recovery, and persistence/restart check | Screens/captures for required states, measured foreground/background/focus values, warning/rejection or safe-correction behavior, reset evidence, and tool version |
| Scaling and reflow | Declared low-resolution viewport; 100%, 150%, and 200% Windows scaling; supported 200% and 400% content magnification/reflow mechanism per provisioner, shell, and packaged app | Complete tasks at each required condition; record the exact host/platform mechanism | Resolution, scaling/magnification mechanism, clipping/reflow/scroll result, and unreachable-control findings. The current Windows shell disables WebView zoom and browser accelerators, so absence of another supported content-magnification/reflow mechanism is an implementation blocker, not an assumed equivalent. |
| Text and target adaptation | Increased text spacing, supported font substitution, pointer-target sizing/separation, and alternatives to drag, hover, path gestures, or precise movement | Apply each adaptation independently and complete representative critical tasks | Exact settings/style override, clipping/overlap result, target measurements, alternative operation, keyboard result, and findings |
| WCAG 2.2 A/AA applicability | Every Level A and AA success criterion | Criterion-ledger review plus linked automated/manual/assistive-technology tests | Applicable / Not applicable with rationale, mapped test IDs, evidence, finding IDs, disposition, reviewer, and date. This ledger is required before describing the candidate as meeting the engineering target. |
| Motion and sensory alternatives | Reduced motion; speech input; audible status; capture/media permission states | Platform preference plus functional alternatives | Before/after behavior, text-input path, visual status path, captions/transcript decision where applicable |
| Error and interruption | Invalid input, unavailable dependency, denied capability, slow operation, cancellation, retry, renderer/Core/model failure, lock/logout, maintenance/recovery where supported | Deliberately induced one condition at a time | Preserved initial state, exact condition, announcement/focus/result, safe next step, retest evidence |
| Representative user | At least the provisioner-to-shell journey and one sensitive application journey | Facilitated evaluation by users with relevant access needs where available | Participant needs without unnecessary personal data, task outcome, observed barriers, severity/disposition |

Automated evidence may include the repository's focused component and machine smoke suites where their assertions cover the stated accessibility contract. Existing tests such as modal, theme-manager, file-manager, shared-shell, basic-user-app, shell-catalog, and provisioner partial-retry checks are candidate inputs, not proof of accessibility by themselves. The release record must list the exact commands actually run; do not cite a test merely because it exists.

## Critical RC journeys

All applicable journeys must pass in the actual packaged Microsoft NT candidate. Test the success path and then introduce each failure or interruption independently so the cause and result remain attributable.

| ID | Journey | Required accessible outcome |
|---|---|---|
| AX-J01 | Administrator opens the provisioner and reviews trust, preflight, operating-system, installation, and permission state | Structure and status are announced; focus is visible; meaning is not color-only; the administrator understands why and when elevation may occur |
| AX-J02 | Administrator installs, updates, or repairs ARCANE through the native privilege boundary | Exact action and consequence are stated before UAC; progress and completion are exposed; denial/cancel returns to an operable, explained state |
| AX-J03 | Administrator adds or activates a standard ARCANE user and handles temporary credentials | Labels, validation, protected-user boundaries, credential handling, errors, cancellation, and completion are understandable without exposing secrets through live regions |
| AX-J03B | Administrator resets an existing account password through separate prepare and apply requests | The prepared credential can be privately saved without announcement, logs, or clipboard automation; the later apply action and UAC boundary are separately explained and confirmed; cancellation, invalid/stale credential, denial, failure, and recovery preserve the existing password until protected apply succeeds |
| AX-J04 | User signs in, reaches the shell, identifies identity/system state/help, and completes first-run orientation | Focus begins logically; identity and system state are available nonvisually; orientation is keyboard/screen-reader operable and reopenable; no inaccessible dead end exists. Orientation is mandatory before pilot entry; a candidate without it records this journey as absent/failing rather than not applicable. |
| AX-J05 | User navigates the shell application catalog and launches each application included in the candidate claim | Catalog loading/busy/error state is announced; every card is keyboard operable; application transition and return path preserve context |
| AX-J06 | User changes light/dark/system/custom appearance and reduced-motion preferences in Settings | Control names/states are exposed; changes retain contrast and focus; persistence does not cause an unreadable flash or trap |
| AX-J07 | User enters text intent or application input, reviews output/provenance, corrects or cancels, and handles unavailable AI/network/provider state | Input never requires speech; generated versus system content is distinguishable; busy/result/error is timely but not disruptive; correction and cancel remain available |
| AX-J08 | User reviews and accepts or denies a sensitive capability, data movement, external-open, capture, microphone, or terminal action where included | Authority, target, destination, data, consequence, and cancellation are explicit; equivalent access does not weaken the protection |
| AX-J09 | User operates representative shared mechanisms: modal, navigation, file manager, table, chat/output, notifications, and terminal/editor surfaces | Documented keyboard model works; modal containment/Escape/return focus works; dynamic content and errors are announced once; embedded surfaces do not trap focus |
| AX-J10 | User locks or logs out, returns after restart, encounters degraded/error state, and reaches recovery or help | Completed work and unchanged state are clear; focus/context are restored safely; recovery is reachable without pointer or vision |
| AX-J11 | Authorized administrator enters and exits maintenance/recovery when that capability is present in the candidate | Maintenance authority and system impact are announced; irreversible steps receive proportionate confirmation; exit restores an operable user state |

Every packaged app in the RC claim must complete AX-J05 plus its primary user task, primary error path, settings/help route, and return-to-shell path. High-impact applications also require a domain-specific journey: AI and clinical/wellness applications must distinguish model output and urgent/support language; Terminal must expose sessions, output, search, and command state; Capture must expose recording/listening state and nonvisual stop/cancel controls; embedded-media applications must document the boundary between ARCANE and third-party accessibility.

## Severity and release gates

Use the finding meanings in the [accessibility verification SOP](accessibility-verification.md) with these RC gates:

| Severity | RC gate |
|---|---|
| Blocker | No RC label, pilot, or release. Retest the original task, focused regression, and nearest full journey after repair. |
| High | No RC label or affected supported claim. Exclusion is allowed only when the surface is removed from the candidate and its user-facing claim; a waiver does not make an inaccessible critical path conformant. |
| Medium | Requires an owner, dated remediation target, documented user impact and reliable workaround, accessibility-authority acceptance, and confirmation that no critical journey or protected control is compromised. |
| Low | Track with owner and rationale. Accumulated low findings must be reviewed for systemic impact before go/no-go. |
| Untested | Treat as not conformant for the affected supported claim. A missing environment, tool, or human verifier is a release-readiness gap, not a pass. |

A candidate fails the baseline when any critical journey is incomplete, any required matrix cell lacks objective evidence, the exact candidate/environment is not recorded, a Blocker or High remains in scope, or the accessibility authority has not signed the disposition.

## Current source indications and unverified areas

Repository inspection identified foundations that should be exercised: shared theme variables and reduced-motion rules, visible-focus rules in shared styles/components, native HTML dialog behavior in the shared modal, semantic/live-region patterns across components and apps, a dual event-plus-sticky readiness contract, a provisioner with status and progress surfaces, a keyboard-addressable shell catalog, and focused component/machine tests.

These are implementation indications only. As of this baseline's creation, the following remain unverified for an exact RC candidate and therefore cannot support a conformance claim:

- exact supported Microsoft NT, WebView2, native-host, and assistive-technology versions;
- NVDA and Narrator operation in the native WebView2 host;
- clean-machine keyboard-only provisioner, UAC, shell, lock/logout, maintenance, and recovery journeys;
- accessibility-tree correctness across imported components, shadow roots, embedded web content, terminal/editor surfaces, and native transitions;
- 200%/400% zoom, Windows scaling, text spacing/font substitution, low-resolution reflow, and pointer target sizing;
- Windows forced-colors behavior and computed contrast for provisioner, shell, shared components, every application, and every status/focus/error state;
- system and custom theme persistence across shell and packaged applications;
- warning, rejection, safe correction, persistence, and keyboard/screen-reader reset recovery for a low-contrast custom-theme attempt;
- complete reduced-motion behavior and speech/audio/media alternatives;
- failure, cancellation, retry, interruption, and focus restoration across Core, renderer, model, provider, network, permission, and application failures;
- accessibility of third-party embedded pages and a documented boundary/alternative when ARCANE cannot control that content;
- representative-user evaluation and accessibility-authority disposition;
- an automated accessibility toolchain, versions, configuration, exclusions, retained output, and CI gate for the exact package;
- a criterion-level WCAG 2.2 A/AA applicability ledger mapped to test IDs, evidence, findings, and dispositions;
- first-run orientation, governed intent review, action ledger, and maintenance experiences that are absent or not included in the candidate.

Absence from the current implementation does not waive a journey promised by the RC scope. The release claim must either implement and verify it or explicitly remove it from the candidate scope in the requirements traceability and go/no-go records.

## Candidate evidence record

Create one record per candidate and link all artifacts rather than embedding secrets or personal data.

```markdown
### ARCANE RC accessibility baseline record

- Candidate/version:
- Source revision:
- Package hash/signing identity:
- Application catalog/version:
- Microsoft NT edition/version/build/architecture:
- Native host and WebView2 versions:
- Test dates:
- Implementer:
- Accessibility verifier:
- Representative-user evaluator:
- Accessibility authority:
- Baseline: ARCANE Microsoft NT RC Accessibility Baseline; WCAG 2.2 AA engineering target

#### Matrix results

| Matrix layer/case | Environment and tool version | Result | Evidence | Finding IDs | Verifier/date |
|---|---|---|---|---|---|

#### WCAG 2.2 A/AA applicability

| Success criterion | Applicable / Not applicable | Rationale | Test IDs | Evidence | Finding/disposition | Reviewer/date |
|---|---|---|---|---|---|---|

#### Critical journeys

| Journey | Starting identity/state | Input/AT/settings | Expected result | Actual result | Evidence | Finding IDs | Retest |
|---|---|---|---|---|---|---|---|

#### Application coverage

| App/version | Primary task | Primary failure | Settings/help | Return to shell | Result/evidence | Finding IDs |
|---|---|---|---|---|---|---|

#### Findings

| ID | Surface/task | Finding | Severity | User/security impact | Evidence | Owner | Disposition/deadline | Retest |
|---|---|---|---|---|---|---|---|---|

#### Decision

- Pass / Conditional pass / Fail:
- Blocked or excluded claims:
- Accepted Medium/Low findings and reliable workarounds:
- Untested paths (each is nonconformant for its claim):
- Accessibility authority, decision, and date:
```

## Completion test

ARCANE meets this baseline only when the exact packaged candidate has objective evidence for every required matrix row, every applicable WCAG 2.2 Level A/AA criterion, every in-scope critical journey including AX-J03B and mandatory pilot orientation, every packaged application's required task set, every failure and recovery path, and every supported theme/adaptation; all findings have owners and dispositions; no Blocker or High remains in scope; and the accessibility authority records the go/no-go result.
