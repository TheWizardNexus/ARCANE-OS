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
