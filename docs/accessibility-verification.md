# ARCANE Accessibility Verification Standard Operating Procedure

> **Mandatory use:** Follow this SOP for release-candidate review and whenever creating or materially changing a user interface, interaction, confirmation, notification, provisioning step, maintenance path, error, or recovery experience.

## Required outcome

ARCANE must remain perceivable, operable, understandable, and robust throughout the complete supported journey. Accessibility is not satisfied by a component checklist if a user cannot install, sign in, understand authority, express an intent, review and control an action, use an application, recover from failure, or reach help.

This SOP establishes repeatable verification and evidence. It does not replace consultation with people who use assistive technology or a declared legal/regulatory conformance target.

Use [`accessibility-baseline.md`](accessibility-baseline.md) for the current Microsoft NT RC engineering target, environment matrix, critical journeys, WCAG applicability ledger, and release gates. The baseline defines required evidence; it does not claim that a candidate passes.

## Governing rules

1. Test the actual implementation and supported host, not screenshots or source alone.
2. Test complete tasks and failure/recovery paths in addition to isolated controls.
3. Preserve keyboard, focus, screen-reader, contrast, zoom, motion, timing, and non-voice alternatives in shared ARCANE mechanisms.
4. Do not make security or privacy weaker for accessibility. Provide an equivalent accessible path to the same protected action.
5. Do not require speech, hearing, color perception, precise pointer movement, or memorization as the only path.
6. User theme and adaptation choices remain subordinate only to minimum legibility, focus visibility, safety, and platform constraints.
7. Record assistive technology, platform settings, versions, test data, result, and limitations.

## Test roles

| Role | Responsibility |
|---|---|
| Implementer | Supplies the intended behavior, keyboard model, semantic structure, and focused checks. |
| Accessibility verifier | Performs repeatable component, application, and journey verification. |
| Representative user evaluator | Tests comprehension and usability with relevant access needs where available. |
| Accessibility authority | Determines whether findings block the supported release or require accepted limitations. |

An automated checker supports review but cannot replace keyboard, screen-reader, visual, cognitive, or real-user evaluation.

## Required test matrix

For the supported Microsoft NT RC, record at least:

- Windows version, display scaling, resolution, and input devices;
- keyboard-only operation;
- one supported Windows screen reader and browser/host combination;
- 200% and 400% zoom or equivalent reflow conditions where applicable;
- Windows high-contrast/forced-colors behavior;
- ARCANE light, dark, system, and one custom user theme;
- reduced-motion preference;
- text-only alternative for speech input and audible output;
- representative slow interaction and interruption of time-sensitive behavior;
- provisioner, shell, confirmation, supported applications, maintenance, and recovery surfaces.

Add platform, assistive-technology, language, device, or domain-specific cases when the supported deployment requires them.

## Procedure

### 1. Define the user task and expected accessible behavior

For each test, record:

- user goal;
- starting state and identity/role;
- input methods and assistive technology;
- expected sequence and result;
- required announcements, focus changes, confirmations, errors, and recovery;
- any safety, privacy, or timing constraint;
- source requirement or declared conformance baseline.

Do not begin with a list of selectors or ARIA attributes. Begin with what a person must accomplish.

**Gate:** The expected accessible outcome is explicit and testable.

### 2. Verify semantic structure and accessible names

Confirm:

- page language, title, landmarks, headings, lists, tables, forms, and dialogs use appropriate native semantics;
- every interactive element has an accurate accessible name, role, state, value, and description where needed;
- labels and instructions remain programmatically associated with controls;
- required, invalid, expanded, selected, busy, current, and disabled states are exposed;
- icons, status marks, charts, and meaningful images have equivalent text or structured data;
- decorative content is not announced as meaningful;
- dynamic components expose their readiness and state without requiring DOM inspection.

Prefer native HTML semantics. Add ARIA only when native behavior cannot express the required contract, and test the resulting accessibility tree.

### 3. Verify keyboard and focus behavior

Using only the keyboard, complete the task and confirm:

- all actions are reachable and operable in a logical order;
- focus is always visible and distinguishable;
- no keyboard trap exists, including embedded content and terminal/editor surfaces;
- dialogs move focus to an appropriate element, contain focus while modal, support the documented Escape behavior, and restore focus to the invoking control;
- application navigation, menus, tabs, lists, grids, and composite widgets follow a documented keyboard model;
- shortcuts do not conflict with text entry or assistive technology and have an alternative;
- adding, removing, hiding, loading, or failing content does not move focus unexpectedly;
- destructive or privileged actions cannot be triggered accidentally by focus movement or a single ambiguous keystroke.

### 4. Verify screen-reader behavior

With the supported screen reader:

- navigate by landmarks, headings, controls, forms, lists, tables, and links;
- complete the task without relying on visual position;
- confirm labels, roles, states, values, errors, help, progress, and completion are announced once and at the correct time;
- confirm live regions do not interrupt excessively, repeat stale messages, or expose secrets;
- verify dialogs, notifications, confirmations, application changes, and recovery surfaces announce context and authority;
- confirm typed intent, model output, code, tables, citations, and generated artifacts remain understandable;
- verify hidden, inert, off-screen, or background modal content is not incorrectly exposed.

Record exact confusing, missing, duplicated, or misleading announcements.

### 5. Verify visual presentation and user themes

Test light, dark, system, custom, and high-contrast/forced-colors states. Confirm:

- text and meaningful non-text content maintain the declared contrast baseline;
- focus, selection, error, warning, success, disabled, and required states do not depend on color alone;
- ARCANE theme variables remain the base and application/component overrides do not erase user preferences;
- text spacing and font substitution do not clip, overlap, or hide controls;
- charts and status visualizations provide labels, patterns, values, or equivalent data;
- translucent, animated, image-backed, or disabled surfaces remain legible;
- platform UAC and other native transitions provide enough surrounding ARCANE context for the user to understand why they appeared.

Use computed/runtime colors and rendered states when measuring contrast, not source tokens alone.

### 6. Verify zoom, scaling, reflow, and target operation

At required zoom and display scaling:

- content reflows without losing information or operation;
- essential controls do not require two-dimensional scrolling unless the content itself requires it;
- dialogs, menus, notifications, tables, editors, and terminal surfaces remain reachable;
- text is not replaced by icons solely to fit;
- pointer targets have adequate size and separation for the declared baseline;
- actions requiring drag, path gestures, hover, or precise movement have a simple alternative;
- orientation or viewport assumptions do not block the supported task.

### 7. Verify motion, media, speech, and sensory alternatives

Confirm:

- reduced-motion preferences disable or reduce nonessential animation and parallax;
- flashing, rapid changes, and autoplay behavior remain within the declared safety baseline;
- speech input has a complete keyboard/text alternative;
- spoken output, alerts, and audio cues have visual/text equivalents;
- video or instructional media provides required captions, transcript, and audio description according to content purpose;
- microphone, camera, and display-capture permission states are visible, understandable, and operable without relying on one sense;
- recording or listening state never depends on a color or animation alone.

### 8. Verify comprehension, consistency, and cognitive load

Confirm:

- system, application, model, and external-content voices are distinguishable;
- confirmation identifies the exact action, target, data, destination, consequence, and ability to cancel;
- errors explain what happened, what remains unchanged, and the safe next action;
- instructions are concise, consistent, and available when needed;
- destructive, irreversible, privileged, networked, or data-releasing actions receive proportionate friction;
- time limits can be extended, disabled, or safely recovered where policy permits;
- repeated interactions use consistent labels and placement;
- first-run orientation, memory controls, policy denials, maintenance state, and recovery are understandable without specialized technical knowledge.

Do not use clarity as a reason to conceal material risk or technical authority.

### 9. Verify errors, interruption, and recovery

Exercise:

- invalid and missing input;
- unavailable model, network, device, provider, or permission;
- denied capability or policy decision;
- application, renderer, Core, and model failure;
- slow operation, cancellation, retry, correction, and resume;
- session lock/logout and shell recovery;
- maintenance entry and exit;
- installation/update failure where in scope.

Confirm the user receives accessible status, retains or regains logical focus, understands what completed, and can reach a safe next step without an inaccessible dead end.

### 10. Run automated checks

Use applicable HTML validation, accessibility-tree inspection, automated rules, contrast measurement, and component tests. Automated checks should cover repeatable regressions such as:

- missing names or labels;
- duplicate identifiers;
- invalid ARIA relationships or states;
- focusable hidden content;
- missing dialog semantics;
- contrast-token or theme regressions where reliably testable;
- documented keyboard and focus contracts;
- package paths and nested-route component loading.

Preserve tool name, version, configuration, exclusions, output, and false-positive disposition. A zero-error automated report is not proof that a person can complete the task.

### 11. Test the complete ARCANE reference journey

On the supported Microsoft NT candidate, verify as applicable:

1. administrator reads and operates provisioner preflight;
2. user account staging and activation states are understandable without exposing credentials;
3. user signs in and completes first-run orientation;
4. user identifies identity, role, system state, and help;
5. user enters an intent by keyboard and, when supported, speech;
6. user reviews ambiguity, plan, data movement, policy, and confirmation;
7. user interrupts, corrects, denies, or cancels;
8. user receives and navigates progress, result, provenance, and action ledger;
9. user opens and operates supported applications;
10. user survives lock/logout, error, restart, degraded mode, and recovery;
11. authorized administrator enters and exits maintenance when supported.

**Gate:** Isolated component success does not override a blocked end-to-end journey.

### 12. Classify, remediate, and retest findings

| Severity | Meaning | Default disposition |
|---|---|---|
| Blocker | A supported user cannot complete a critical journey, understand/control a sensitive action, or recover safely. | Block release. |
| High | A major task or security/privacy control is inaccessible without a reliable equivalent path. | Block affected claim or release until fixed or formally excluded. |
| Medium | Material difficulty, inefficiency, confusion, or inconsistent support with an available workaround. | Fix or accept with owner, deadline, documented workaround, and impact. |
| Low | Limited issue or enhancement that does not prevent the supported task. | Track with owner and rationale. |

After a fix, repeat the original user task with the same assistive technology and settings, then run the focused regression and nearest complete journey. Follow `docs/debugging.md` when observed and expected behavior differ.

## Compact verification record

```markdown
### ARCANE accessibility verification record

- Scope/candidate:
- Source revision:
- Verifier:
- Accessibility authority:
- Declared baseline:

#### Environment

- Microsoft NT version and host:
- Assistive technology and version:
- Keyboard/pointer/input:
- Display, scaling, zoom, contrast, themes, and motion settings:

#### Task

- User goal:
- Starting state and role:
- Expected accessible behavior:
- Actual result:
- Automated evidence:
- Manual evidence:
- Representative-user evidence:

#### Findings

| ID | Surface/task | Finding | Severity | Evidence | Owner | Disposition | Retest |
|---|---|---|---|---|---|---|---|

#### Decision

- Pass / Conditional pass / Fail:
- Accepted limitations and workarounds:
- Untested paths:
- Authority and date:
```

## Prohibited shortcuts

Do not:

- rely only on automated scanning;
- use ARIA to recreate behavior already supplied correctly by native HTML;
- remove focus outlines without an equally visible replacement;
- require a pointer, hover, drag, speech, hearing, color perception, or animation as the only path;
- move focus to hide an error or force progress;
- announce secrets or protected content through live regions;
- create an accessibility bypass that weakens authentication, confirmation, authorization, privacy, or audit;
- test only the default theme, ideal data, success path, or development browser;
- call a component accessible when the complete user journey remains blocked.

## Completion test

Accessibility verification is complete only when the declared test matrix, critical tasks, errors, confirmations, supported applications, and recovery journey have objective automated and manual evidence; every finding has an owner and disposition; and the accessibility authority has recorded the result for the exact implementation or release candidate.
