# Arcane app-building Standard Operating Procedure

> **Mandatory use:** Follow this SOP every time a human or artificial-intelligence (AI) agent is asked to create, copy, or materially change an Arcane app, component, module, entity, style system, asset, model, adapter, service, or other runtime capability. Complete the decision process before implementation begins.

## Quick execution checklist

Use this checklist for every applicable request. The later sections explain each step and provide the review standard.

- [ ] Restate the need as: “I need to make a capability that allows a user or system to _____.”
- [ ] Search `arcane/`, `example/`, and relevant `apps/` code for an existing capability to reuse or extend.
- [ ] Decide whether the capability could be useful to another application.
- [ ] List the business logic that is specific to the requested app.
- [ ] Choose how to extract that business logic from the reusable core.
- [ ] Record shared and app-specific file placement before creating files.
- [ ] For visual work, identify the Arcane base theme, user-theme loading, and CSS layer order before writing custom styles.
- [ ] Define or extend the public contract without silently breaking existing consumers.
- [ ] Implement the shared core first, then the app adapter and orchestration.
- [ ] Add focused shared tests, app tests, and a synthetic example as applicable.
- [ ] Update package allowlists, cache references, versions, and machine capabilities as applicable.
- [ ] Update `docs/arcane-api.md` for every added or changed application-facing `Arcane` native bridge method, following `docs/developer-reference-sop.md`.
- [ ] Run relevant verification and include the completed capability decision in the handoff.

If any answer is unclear, stop designing files and clarify the boundary. Do not use uncertainty as permission to default to an app-local implementation.

## How humans and AI agents use this SOP

### Human implementers and reviewers

The implementer completes the [required design record](#required-design-record) in the issue, work note, or pull request before substantive implementation. Reviewers use the [definition of done](#definition-of-done) and [review gate](#review-gate) before approval.

### AI agents

An AI agent must read this SOP before taking implementation action on an applicable request. The agent must inspect the repository rather than relying only on the requested filename or assumed architecture. It must make reasonable boundary decisions autonomously when the repository provides enough evidence, and ask the user only when a missing business decision would materially change the result.

The AI agent's final handoff must state, at minimum:

- the reusable core created, reused, or extended;
- the app-specific business logic and where it remains;
- the extraction mechanism used, such as configuration, events, adapters, slots, providers, or record mapping;
- how the app or component inherits the Arcane base theme and preserves the user's appearance choices;
- the verification performed and any checks not run.

If no shared artifact is created for a generally useful capability, the agent must explicitly justify that exception against this SOP.

## Purpose

This Standard Operating Procedure (SOP) governs the creation and modification of Arcane applications, components, modules, entities, styles, assets, models, adapters, and other runtime capabilities.

Arcane applications must be thin compositions of shared platform capabilities. Reusable behavior belongs in the repository-level `arcane/` runtime. An application under `apps/<id>/` should contain only its business-specific policy, language, data definitions, routes, and orchestration.

This is a required design and review process, not an optional refactoring exercise after an app is complete.

## Core rule

Before creating any file or copying an existing implementation, write down answers to these questions in order:

1. **I need to make a _____.** Describe the user-facing capability or domain behavior, not the proposed filename or technology.
2. **Could this be useful to another application?** Consider current and plausible future Arcane applications, not only the app being changed today.
3. **Does it contain business logic specific to this application?** Identify app-specific terminology, rules, permissions, prompts, schemas, routes, persistence choices, and workflows.
4. **Can that business logic be extracted from the core behavior?** Prefer configuration, adapters, callbacks, events, slots, or injected providers so the core remains reusable.

If the core behavior can be useful elsewhere, it **must** be created in or moved to the appropriate shared `arcane/` layer. The app may configure and orchestrate it; the app must not own a private copy.

## Procedure

### 1. Define the capability

Complete this statement in plain language:

> I need to make a capability that allows a user or system to _____.

Describe inputs, outputs, state changes, failure states, permissions, and user-visible behavior. Do not begin with “I need a component named…” because that assumes the solution before the boundary is understood.

### 2. Search before creating

Inspect the existing shared runtime and examples before adding a new implementation:

- `arcane/components/` for reusable visual and interactive behavior.
- `arcane/modules/` for reusable state, integration, storage, processing, and service behavior.
- `arcane/entities/` for reusable domain-neutral records, validation, and value behavior.
- `arcane/css/` for shared tokens, layouts, and interface primitives.
- `arcane/img/` and `arcane/models/` for shared assets and model definitions.
- `example/` for documented usage and extension patterns.
- `apps/` for existing app orchestration that may reveal a capability ready to be extracted.

Prefer extending a compatible shared contract over creating a near-duplicate. Do not change a shared contract in a way that silently breaks its existing consumers.

### 3. Apply the reuse test

Treat a capability as reusable when its purpose can be described without the name of one app, customer, case type, program, or business workflow.

Examples of reusable behavior include:

- displaying, editing, selecting, uploading, previewing, or organizing data;
- opening and closing dialogs;
- storing preferences or files;
- validating common value shapes;
- invoking mail, artificial-intelligence, speech, or storage providers through neutral interfaces;
- reporting progress, errors, status, or results;
- importing HTML and coordinating component readiness.

The fact that only one app needs the capability today is not sufficient reason to keep a generally useful implementation app-local.

### 4. Identify app-specific business logic

Mark each requirement that depends on the app. Common business-specific concerns are:

- product names, domain terminology, instructions, and prompts;
- workflow ordering and decisions unique to the app;
- domain schemas, scoring rules, legal or clinical meaning, and record relationships;
- app permissions, publication policy, and capability requests;
- app routes and navigation;
- which provider, repository, or persistence policy the app selects;
- transformations between the app's domain records and a neutral shared contract;
- app-specific success, escalation, and failure actions.

Business logic belongs in `apps/<id>/`. Visual mechanics, generic state transitions, provider-neutral integrations, and domain-neutral validation do not become app-specific merely because an app uses them.

### 5. Extract the reusable core

Separate mechanism from policy using one or more of these boundaries:

- **Configuration:** labels, options, schemas, limits, feature flags, and initial state supplied through `configure(...)`, properties, or data attributes.
- **Events:** shared components emit domain-neutral `CustomEvent` messages; the parent app decides what the event means and what happens next.
- **Callbacks or adapters:** the app supplies conversion, persistence, authorization, or provider operations to a shared capability.
- **Slots or child content:** the app supplies business-specific content without forking the shared visual shell.
- **Injected providers:** shared modules depend on a narrow interface rather than app credentials, endpoints, or global business policy.
- **Record mapping:** app code converts domain records into shared entity or component input shapes and converts results back when necessary.

A shared implementation must have useful neutral defaults, validate its public inputs, expose predictable outputs, and avoid importing from `apps/`.

### 6. Place each responsibility

| Responsibility | Location | Boundary |
|---|---|---|
| Reusable user interface or interaction | `arcane/components/` | Parent-controlled data, labels, actions, and persistence |
| Reusable state, service, integration, or processing behavior | `arcane/modules/` | Provider-neutral interface with explicit errors and outputs |
| Reusable record, value object, or validation behavior | `arcane/entities/` | Domain-neutral data contract and invariants |
| Shared tokens, layouts, and interface primitives | `arcane/css/` | Neutral styling that apps may compose without duplicating |
| Shared image or model asset | `arcane/img/` or `arcane/models/` | No app-specific branding or private content unless intentionally platform-wide |
| App schema, prompt, route, policy, wording, or orchestration | `apps/<id>/` | May depend on `arcane/`; must not redefine it |
| Reusable usage demonstration | `example/<type>_<name>/` | Minimal, synthetic, and independent of an app's private data |
| Cross-app behavioral contract test | `test/` | Covers the shared contract and reuse boundary |
| App-specific business behavior test | `apps/<id>/test/` or the established app suite | Covers domain policy and orchestration |

Dependencies flow from an app to `arcane/`. Shared Arcane code must never import app code or assume a particular app is present.

System appearance follows the same dependency rule. Applications consume the shared theme manager and named design tokens. User-created skins are validated data, not arbitrary CSS, so they remain portable and cannot introduce selectors or network resources into another app.

### 7. Start every user interface with the Arcane theme

Every app and shared visual component must use the Arcane theme as its base. This preserves the user's selected appearance across Arcane OS while still allowing each app and component to develop an appropriate visual identity.

Use this cascade order:

1. **Optional shared layout:** include `arcane/css/layout.css` first when the shared application layout is appropriate.
2. **Arcane theme:** every app must load `arcane/css/theme.css`, which supplies the canonical light/dark variables and user-preference selectors.
3. **Arcane primitives and shared feature styles:** load `arcane/css/primitives.css` and any other reusable Arcane styles required by the capability.
4. **App styles:** load `apps/<id>/...css` after all shared Arcane styles.
5. **Component styles:** apply component-specific CSS after the shared base within the component while continuing to consume Arcane variables.
6. **Narrow overrides:** place route, state, or instance overrides last and keep their scope as narrow as possible.

The resulting order should be visible in an app document:

```html
<link rel="stylesheet" href="./arcane/css/theme.css?v=1">
<link rel="stylesheet" href="./arcane/css/primitives.css?v=1">
<link rel="stylesheet" href="./arcane/css/<shared-feature>.css?v=1">
<link rel="stylesheet" href="./apps/<id>/<app>.css?v=1">
```

Paths and version values may differ, but the shared-to-specific order must not.

Apps must load `arcane/modules/ThemeBootstrap.js` to apply the user's shared appearance through `ThemeManager`. Do this early enough to avoid presenting a conflicting app-default theme before the saved preference is applied. Apps that provide a theme switcher or editor must use the shared Arcane theme components and persistence rather than establishing an app-only preference that other apps cannot respect.

Custom CSS must consume the Arcane theme variables, including shared surface, text, action, border, focus, status, spacing, and radius tokens, whenever those concepts apply. App and component styles may add new semantic variables, but their defaults should derive from Arcane variables. For example:

```css
:root{
    --case-priority:var(--arcane-warning);
}

.case-card{
    background:var(--arcane-surface-raised);
    border:1px solid var(--arcane-border);
    border-radius:var(--arcane-radius-large);
    color:var(--text-color);
}
```

Write new color values with `rgb(...)` or `rgba(...)` rather than hexadecimal notation. RGB and RGBA keep channel values explicit and make color and opacity transitions easier to animate. Existing hexadecimal values may be migrated when their surrounding code is changed; do not perform unrelated palette rewrites solely for notation.

Overrides are allowed and expected when they serve an app or component. They must be layered on top of the Arcane base, remain compatible with light, dark, system, and custom user themes, and preserve accessible contrast and focus visibility. Do not replace the Arcane theme with a fixed app palette or use hard-coded colors for concepts already represented by theme tokens.

### 8. Define the contract before implementation

For every new shared capability, document:

- its purpose and non-goals;
- accepted inputs, configuration, and defaults;
- public methods or exported functions;
- emitted events, returned values, and error behavior;
- required providers or browser capabilities;
- accessibility and keyboard behavior for user interfaces;
- security, privacy, and persistence boundaries;
- compatibility expectations for existing consumers.

Use `arcane/modules/ComponentContracts.js` when multiple components or consumers need the same validated option shape or a testable domain-neutral transformation.

Shared components should allow the parent to supply domain data and decisions. A component must not silently select business policy, persist to an app-specific location, or call an app route unless that behavior is explicitly injected.

### 9. Implement the smallest complete split

A normal implementation consists of:

1. the reusable mechanism in `arcane/`;
2. the app-specific adapter or orchestration in `apps/<id>/`;
3. focused tests for both sides of the boundary;
4. a synthetic example and usage notes when a new public shared contract is introduced;
5. updated package allowlists, cache references, or machine capabilities when required.

Do not build the full feature app-local with a promise to extract it later. Establish the boundary as part of the first implementation.

## Rules by artifact type

### Shared components

A shared component must:

- use domain-neutral names and default language;
- accept parent data and configuration instead of reading app globals;
- expose a documented readiness signal and stable methods when asynchronous HTML import is involved;
- emit domain-neutral events with documented `detail` shapes;
- let the app own persistence, routing, authorization, and business outcomes;
- resolve its own shared dependencies from a stable component or module-relative base;
- support keyboard use, focus behavior, accessible labels, empty states, loading states, and errors;
- load the Arcane visual base and use shared theme variables and style primitives;
- layer component-specific styles after the Arcane base without resetting or overriding the user's theme at document scope;
- remain legible and operable under the supported light, dark, system, and custom Arcane themes;
- be usable by a synthetic example that contains no app-specific data.

An app may wrap or configure a shared component. It may not copy the component merely to change labels, data sources, persistence, actions, or layout options that can reasonably be expressed through the public contract.

### Shared modules

A shared module must:

- perform one coherent, reusable responsibility;
- accept configuration or narrow dependencies instead of app-specific imports;
- avoid embedded credentials, private endpoints, and app-only environment assumptions;
- validate inputs and make failure behavior observable;
- avoid uncontrolled global side effects;
- export testable behavior when browser-independent logic exists;
- document whether operations are synchronous, asynchronous, persistent, destructive, or networked.

### Shared entities

A shared entity must:

- represent a reusable record or value concept rather than an app workflow;
- define defaults, normalization, serialization, and validation deliberately;
- keep app-specific scoring, labels, permissions, and workflow transitions outside the entity;
- remain usable without loading a particular app;
- preserve backward compatibility or include an explicit migration when its stored shape changes.

If an entity name only makes sense inside one application's business domain, it normally belongs in that app. Extract reusable value objects or validators from it when possible.

### Applications

An application must:

- compose shared Arcane capabilities rather than duplicate them;
- load Arcane base styles before all app-specific styles;
- load and apply the user's shared Arcane theme instead of imposing an app-only default palette;
- build app-level visual customization and overrides from Arcane theme variables;
- keep only app-specific policy, content, routes, schemas, and orchestration locally;
- map app records into neutral shared contracts at the app boundary;
- request only the machine capabilities it needs;
- use an `arcane-package.json` positive allowlist when distributable;
- keep private source material, credentials, and development-only files outside public packages;
- explain why every app-local component, module, or entity is business-specific.

## Decision examples

### Example: business-specific editor

Need: “Allow a user to draft and save a case analysis.”

- Reusable core: Markdown editing, preview, validation hooks, save state, and accessible controls.
- App-specific logic: the case-analysis schema, prompt text, authorization, case identifier, storage location, and post-save workflow.
- Placement: editor in `arcane/components/`; contract normalization in `arcane/modules/` if shared; case adapter and persistence orchestration in `apps/<id>/`.

### Example: app dashboard

Need: “Let users choose which operational panels appear.”

- Reusable core: render available definitions, track selection state, emit changes, and display neutral empty/error states.
- App-specific logic: available panels, their business meaning, user permissions, and where preferences are stored.
- Placement: configuration component in `arcane/components/`; definitions and persistence adapter in `apps/<id>/`.

### Example: domain record

Need: “Represent a legal matter with parties, deadlines, and filing status.”

- App-specific entity: the legal matter and its workflow belong in the legal app.
- Reusable extraction: generic file descriptors, people/contact values, date validation, and persistence interfaces may belong in `arcane/entities/` or `arcane/modules/` if their contracts are genuinely cross-app.

## Prohibited shortcuts

Do not:

- copy a shared component or module into an app to make a small variation;
- put app names, domain terminology, hard-coded routes, private endpoints, or credentials in shared code;
- make shared code import from `apps/`;
- load app or component CSS before the Arcane base and depend on accidental cascade behavior;
- replace the user's Arcane theme with a fixed app palette;
- hard-code colors where an Arcane theme token expresses the same purpose;
- reset shared theme variables at broad scope merely to brand one component;
- use an app global when configuration, an event, or an injected provider provides a clear boundary;
- create a second entity for the same record shape because an app uses different labels;
- let a shared component decide domain authorization, persistence, or workflow completion;
- expose a breaking shared contract change without updating and verifying every consumer;
- publish repository roots or broad directories in place of positive package allowlists;
- defer obvious reuse extraction until after release.

## Verification

Verification must be proportional to the change and must exercise the actual boundary.

For a shared capability:

- add focused tests under `test/` for input normalization, outputs, errors, and compatibility;
- test that shared sources remain domain-neutral when practical;
- add or update a browser example for interactive behavior;
- verify component lifecycle, readiness, events, accessibility, and nested-route asset resolution;
- verify visual behavior against the Arcane base and supported user themes, including focus and contrast-sensitive states;
- run the consumers most likely to expose contract regressions.

For an app:

- test its adapter, mapping, policy, and orchestration independently from the shared mechanism;
- verify that Arcane styles load before app styles and that shared appearance preferences are applied;
- inspect the app with default, light, dark, system, and custom themes when visual styling changes;
- inspect the effective package with `npm run app:inspect -- <app>`;
- build or dry-run the package as appropriate;
- verify the packaged output with `npm run app:check -- <app>` after packaging.

Before completion, run the narrow relevant tests and then the broadest practical repository check. The full repository gate is:

```powershell
npm run check
```

## Required design record

Use this short record in an issue, pull request, implementation note, or review description:

```markdown
### Arcane capability decision

- I need to make a: [user-facing capability]
- Could other applications use it: [yes/no and why]
- App-specific business logic: [policy, terms, routes, schemas, providers, or none]
- Reusable core: [mechanism and neutral contract]
- Extraction boundary: [configuration/events/adapters/slots/providers/record mapping]
- Arcane theme base: [shared styles and theme loader]
- CSS layer order: [Arcane base -> shared feature -> app/component -> narrow override]
- User-theme verification: [themes and states checked]
- Shared files: [arcane paths or none]
- App files: [apps/<id> paths or none]
- Contract and compatibility impact: [new/extended/unchanged and affected consumers]
- Verification: [tests, example, app checks, packaging checks]
```

If “Shared files” is `none` for a generally useful behavior, the record must explain why extraction is not currently safe or coherent. Convenience and schedule alone are not sufficient reasons.

## Definition of done

A new capability is complete only when all applicable statements are true:

- The four core questions have written answers.
- Existing Arcane capabilities were checked before new code was created.
- Reusable mechanism and app-specific business logic are separated.
- Shared code is domain-neutral and has no dependency on an app.
- Public inputs, outputs, events, errors, and defaults are documented.
- Shared visual behavior is configurable and accessible.
- Every app and visual component starts from the Arcane theme, applies saved user appearance preferences, and layers custom CSS afterward.
- App and component overrides derive from Arcane tokens and remain usable across supported themes.
- App-local files can be justified as business-specific orchestration or policy.
- Focused shared and app tests cover the boundary.
- A synthetic example documents a new shared public contract when applicable.
- Package allowlists, cache references, capabilities, and versioned asset references are updated when applicable.
- Relevant app packages and repository checks pass.

## Review gate

Reviewers must be able to explain every app-local component, module, and entity as business-specific policy or orchestration. If an app-local file implements a general form control, persistence adapter, file browser, modal, status panel, provider wrapper, record validator, or other reusable mechanism, the change is not ready until that behavior is moved to the shared Arcane layer or a specific exception is documented and approved.

For visual work, reviewers must also confirm that the Arcane theme is the first layer, the user's saved appearance is applied, app and component CSS follows the shared layer, and overrides do not defeat user taste, accessibility, or cross-app consistency.
