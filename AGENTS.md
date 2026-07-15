# Arcane repository instructions

## Mandatory app-building SOP

Before designing, creating, copying, or materially changing any application, component, module, entity, style system, asset, model, adapter, service, or other runtime capability, read and follow [`docs/app-building.md`](docs/app-building.md) in full.

This requirement applies to both new work and changes that expand the responsibility of an existing artifact. It applies even when the request names an app-local destination or asks for a quick implementation.

The implementing agent must:

1. search the shared Arcane runtime and examples before creating a new implementation;
2. answer the SOP's four core questions;
3. separate reusable mechanism from app-specific business logic before implementation;
4. place reusable work under the appropriate `arcane/` layer;
5. load `arcane/css/theme.css` and `arcane/modules/ThemeBootstrap.js` in every app, then layer shared primitives and app or component CSS after the theme base;
6. use `rgb(...)` or `rgba(...)` for new CSS color values so theme channels remain animation-friendly;
7. add or update contracts, focused tests, examples, packaging, and capability declarations as applicable;
8. report the capability decision, theme compliance, and verification in the final handoff.

Do not create an app-local copy of reusable behavior. If the requested placement conflicts with the SOP, preserve the user's intended behavior while applying the shared-core/app-adapter boundary and explain the placement in the handoff.

## Mandatory debugging SOP

Before diagnosing or fixing any defect, failure, regression, crash, incorrect result, integration problem, performance problem, flaky test, packaging failure, or unexpected runtime behavior, read and follow [`docs/debugging.md`](docs/debugging.md) in full.

ASS-U-ME is a warning: **do not assume; an assumption makes an ass out of you and me.** A reported bug is a difference between an observed result and an expected result, and the expectation itself may be incomplete, outdated, misguided, mistaken, or wrong. Verify the basis for the expectation before deciding that the implementation is defective.

Use the required process one proven step at a time:

> **Reproduce -> Preserve -> Inspect -> Isolate -> Manually fix -> Manually verify -> Fix the code -> Rebuild -> Retest from a clean state**

Never stack speculative fixes or change multiple independent variables in one debugging step. If the request is diagnosis-only, stop before changing the code. Report the verified expectation, observed result, cause, evidence, fix (if authorized), and clean-state retest in the final handoff.

## Mandatory build and release SOP

Before changing dependency locks, build launchers, packaging, signing, generated manifests, machine bundles, or release automation, read and follow [`docs/build-release.md`](docs/build-release.md) in full.

Build and release work must keep dependency sources public and reproducible, preserve canonical file bytes across operating systems, stop on every nonzero tool exit, keep unsigned local verification separate from signed production publication, and finish with a clean-state build through the affected platform gate.

## Mandatory release-candidate acceptance SOP

Before labeling, approving, publishing, or piloting any ARCANE build as a release candidate, read and follow [`docs/rc-acceptance.md`](docs/rc-acceptance.md) and [`docs/rc-success-criteria.md`](docs/rc-success-criteria.md) in full and update [`docs/rc-requirements-traceability.md`](docs/rc-requirements-traceability.md) against the exact candidate. A release candidate requires traceable requirements, production signing, automated gates, security/privacy review, accessibility verification, clean-machine Microsoft NT acceptance, operational readiness, rollback evidence, measurable success criteria, and an accountable go/no-go decision.

## Mandatory security and privacy review SOP

Before release-candidate review or materially changing identity, authorization, capabilities, privilege, IPC, rendering, packages, updates, recovery, storage, memory, models, providers, networking, diagnostics, audit, or sensitive data movement, read and follow [`docs/security-privacy-review.md`](docs/security-privacy-review.md) in full and update [`docs/threat-model.md`](docs/threat-model.md) for affected assets, actors, trust boundaries, data classes, abuse cases, controls, evidence, and residual risks.

## Mandatory accessibility verification SOP

Before release-candidate review or creating or materially changing a user interface, interaction, confirmation, notification, provisioning step, maintenance path, error, or recovery experience, read and follow [`docs/accessibility-verification.md`](docs/accessibility-verification.md) and [`docs/accessibility-baseline.md`](docs/accessibility-baseline.md) in full. Verification must include the actual supported host, keyboard and assistive-technology behavior, supported themes and contrast modes, errors and recovery, and the complete affected user journey.
