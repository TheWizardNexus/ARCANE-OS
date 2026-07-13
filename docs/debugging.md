# ASS-U-ME: No-Assumptions Debugging Standard Operating Procedure

> **Mandatory use:** Follow this Standard Operating Procedure (SOP) whenever diagnosing or fixing a defect, failure, regression, crash, incorrect result, integration problem, performance problem, flaky test, packaging failure, or unexpected runtime behavior in Arcane OS.

## Meaning of ASS-U-ME

ASS-U-ME is a warning, not a list of invented steps:

> **Do not assume. An assumption makes an ass out of you and me.**

Debugging starts with facts. Do not assume that the report is correct, the expectation is correct, the code is wrong, the environment is current, a dependency is working, or a proposed cause is relevant. Verify each one.

## What a bug is

A reported bug is usually a difference between an **observed result** and an **expected result**.

That difference does not prove the implementation is defective. The expectation may be incomplete, outdated, misguided, mistaken, or wrong. The observation may also be misunderstood, stale, or taken from a different environment. The first job is therefore to verify both sides of the comparison.

Use this statement:

> Under [specific conditions], I observed [result]. I expected [result] because [verified requirement, contract, design, or user instruction].

If the expectation has no verified basis, do not change the system to satisfy it. Clarify the intended behavior first.

## Governing rules

1. Work one proven step at a time.
2. Separate facts, expectations, questions, and possible explanations.
3. Reproduce before changing anything when it is safe to do so.
4. Preserve the failing state and evidence before resetting, rebuilding, restarting, clearing, or repairing it.
5. Inspect the exact point where reality first differs from the verified expectation.
6. Change only one independent variable at a time.
7. Prove the correction manually before encoding it in code whenever the failure permits a manual correction.
8. Retest the original report from a clean state after the code is fixed.
9. Never call a disappearing symptom a root cause.

One step at a time does not mean one file at a time. A coherent fix may require coordinated edits. It means that every action answers one question and produces a result that can be interpreted before the next action is chosen.

## The required process

Follow this order:

> **Reproduce -> Preserve -> Inspect -> Isolate -> Manually fix -> Manually verify -> Fix the code -> Rebuild -> Retest from a clean state**

Do not skip ahead because a likely solution seems obvious.

### 1. Reproduce

Perform the exact action that is reported to fail.

Record:

- the precise action, input, command, route, or workflow;
- the observed result, including exact error identity where available;
- the claimed expected result;
- the app, component, module, entity, version, host, browser, configuration, and data involved;
- whether the result is consistent, intermittent, timing-dependent, or environment-dependent.

Do not improve, simplify, or substitute a different reproduction before proving the original one. If it cannot be reproduced, say so and improve observability; do not make a speculative fix.

**Gate:** The original behavior has been observed, or the exact reason it cannot currently be observed is recorded.

### 2. Preserve

Preserve the evidence and failing state before an action can erase or alter them.

As applicable, save:

- the relevant error, log, screenshot, response, stack, state, or data;
- the exact version and configuration;
- cache, storage, process, network, package, and service state;
- the smallest useful before-state for later comparison;
- unrelated user work in the worktree.

Do not clear a cache, restart a service, reinstall a dependency, rebuild a package, migrate data, delete a record, or reset the environment until the original state is captured. Those actions are experiments, not housekeeping.

**Gate:** A later reviewer can tell what failed before the investigation changed it.

### 3. Inspect

Inspect the system as it exists. Prefer read-only checks first.

Verify:

- what code and assets are actually running, not merely what is on disk;
- the input entering the failing operation;
- the output leaving it;
- state immediately before and after it;
- the applicable requirement, interface contract, design decision, or user instruction;
- whether the expectation is correct for this version, environment, and input.

Label every statement as one of:

- **Observed fact** — directly seen or measured;
- **Verified expectation** — supported by a requirement, contract, design, or explicit user instruction;
- **Question** — not yet known;
- **Possible explanation** — something to test, never a fact.

Do not convert a possible explanation into a conclusion through confident wording.

**Gate:** The observed behavior and the verified expectation are both known. If the expectation was wrong, correct the expectation or documentation and stop treating the implementation as defective.

### 4. Isolate

Find the first boundary or step where the observed state differs from the verified expectation.

Move through the workflow one boundary at a time. At each boundary:

1. identify the expected input and output;
2. observe the actual input and output;
3. change or test one independent variable only;
4. inspect and record the result before continuing.

Useful boundaries include user action, event, component, module, entity, storage layer, request, response, service, host bridge, package, and cache.

Do not apply several plausible fixes together. Do not refactor, upgrade dependencies, reset state, and change configuration in the same experiment. A result with several changed variables does not establish which change mattered.

**Gate:** The first incorrect transition is identified closely enough that a manual correction can test the expected outcome.

### 5. Manually fix

Before changing the implementation, manually place the isolated boundary into the state the system was expected to produce, when safe and practical.

Examples include supplying the verified input, correcting one record in a disposable copy, invoking the expected operation directly, loading the known-current asset, or performing the missing transition through a diagnostic interface.

The manual correction must be:

- narrow;
- reversible or performed on disposable data;
- recorded exactly;
- limited to the isolated variable.

This is a diagnostic experiment, not the final repair. If a manual correction would be destructive, unsafe, affect real users, or require new authority, stop and request direction.

**Gate:** One controlled manual change has been made and nothing unrelated was changed with it.

### 6. Manually verify

Repeat the affected step with the manual correction in place.

Compare the result to both:

- the preserved failing baseline; and
- the verified expectation.

Classify the result:

- **Proven useful:** the exact failure is corrected and the predicted downstream behavior occurs;
- **Disproven:** the exact failure remains or the predicted behavior does not occur;
- **Inconclusive:** the result cannot distinguish the proposed mechanism from another cause.

If disproven or inconclusive, undo the diagnostic change when appropriate, return to **Inspect** or **Isolate**, and take one new step. Do not leave a failed experiment in place while stacking another one on top.

**Gate:** The manual correction has demonstrated what the implementation must do. A temporary disappearance after a restart, retry, delay, cache clear, or broad rebuild is not enough.

### 7. Fix the code

Only after the manual correction is verified, change the implementation to produce that same proven result.

The fix must:

- address the isolated cause rather than hide the symptom;
- be the smallest coherent correction;
- preserve unrelated behavior and user work;
- include a focused regression check where practical;
- avoid unrelated cleanup, formatting, refactoring, or dependency changes;
- follow the Arcane app-building SOP when it adds or changes a reusable capability.

If the request was diagnosis-only, stop before this step and report the proven cause.

**Gate:** The code change can be explained directly from the manually verified correction.

### 8. Rebuild

Rebuild, repackage, restart, or invalidate caches only to the extent required for the changed implementation to become the implementation under test.

Verify which artifact, version, process, module, or cached resource is actually running afterward. A successful build proves only that the build completed; it does not prove the bug is fixed.

**Gate:** The test environment is known to be running the corrected output.

### 9. Retest from a clean state

Return to a clean, representative starting state and repeat the **original reproduction exactly**.

Then verify in this order:

1. the original reproduction;
2. the focused regression or contract check;
3. the nearest integration, browser, runtime, host, or package path;
4. broader checks proportional to the risk.

A task is not complete because a new test passes while the original workflow remains untested. Record any check that could not be performed and why.

**Gate:** The original observed failure no longer occurs, the verified expectation is met, and the result is attributable to the supported fix.

## Compact debugging record

Humans and artificial-intelligence (AI) agents must maintain this record during an investigation:

```markdown
### ASS-U-ME debugging record

**Reported behavior**
- Conditions/action:
- Observed result:
- Claimed expectation:
- Verified basis for expectation:

**Reproduce**
- Exact reproduction:
- Result:

**Preserve**
- Evidence and failing state saved:

**Inspect**
- Observed facts:
- Verified expectations:
- Questions:
- Possible explanation under test:

**Isolate**
- Boundary:
- One variable tested:
- Result:

**Manual correction**
- One change:
- Manual verification result:
- Classification: Proven useful / Disproven / Inconclusive

**Implementation**
- Root cause:
- Code fix:
- Rebuild/current artifact proof:

**Clean-state retest**
- Original reproduction after fix:
- Focused regression check:
- Broader checks:
- Remaining uncertainty:
```

## Rules for AI agents

An AI agent must:

- read this SOP before beginning diagnostic or fix work;
- use the sequence in this document, not substitute a generic hypothesis workflow;
- never present an assumption as a fact;
- verify the expectation before deciding that observed behavior is a defect;
- state the current step in meaningful progress updates;
- perform only one state-changing diagnostic action at a time;
- inspect its result before choosing the next action;
- preserve unrelated user changes;
- stop before implementation when the request is diagnosis-only;
- report the evidence, root cause, fix, and clean-state retest in the final handoff.

The agent may continue through safe, in-scope steps without pausing for approval after every step. “One step at a time” means one interpretable action at a time, not unnecessary conversational pauses.

## Prohibited behavior

Do not:

- begin with “the cause is probably...” and change code to match the guess;
- accept the reported expectation without verifying its basis;
- use the proposed fix as the problem statement;
- make a code change before reproducing and preserving the failure when that is safely possible;
- change multiple independent variables in one experiment;
- erase the original evidence before capturing it;
- treat correlation, timing, or a disappearing symptom as root cause;
- change a test to accept behavior that contradicts the verified requirement;
- weaken security, validation, or error handling to hide a failure;
- suppress an error, ignore an exit code, add an empty catch, or retry forever;
- claim success from compilation or an unrelated test;
- leave temporary logging, bypasses, credentials, unsafe flags, or diagnostic data behind.

## Urgent containment

If the failure is actively causing data loss, security exposure, destructive behavior, notification storms, or widespread outage, contain the harm first with the smallest reversible action. Record what was changed, preserve whatever evidence remains, and then begin the normal process at **Reproduce**.

Containment stops harm. It does not establish the cause or complete the fix.

## Completion test

A debugging task is complete only when a reviewer can trace a straight line from:

1. the exact observed result;
2. the verified expectation;
3. the preserved failing state;
4. the first isolated incorrect transition;
5. the manually proven correction;
6. the code change that implements that correction;
7. the original reproduction passing from a clean state.

If that chain contains an assumption, the investigation is not complete.
