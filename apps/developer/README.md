# Arcane Developer

Arcane Developer pairs the current Arcane user with one explicitly selected
local Arcane OS checkout. It reports Git, Node.js, dependency, hook, and local
signing readiness; shows the selected AI provider's local/cloud mode and model;
reports the managed Ollama installation and service state; runs one fixed setup
task at a time with visible output; and sends bounded, filtered repository
excerpts through the AI provider selected in Arcane Settings.

The shared native folder selector returns only the one folder explicitly chosen
by the developer. Pairing does not scan the machine and is not a remote-device trust protocol. AI
chat is advisory and cannot execute commands or edit the checkout. Core requires
the checkout to descend from Arcane's supported company baseline before setup,
then runs only a fixed setup command selected by the developer. Those dependency
lifecycle and setup scripts still belong to the selected branch. When the
profile uses OpenAI, bounded excerpts leave the machine after filename filtering
and secret-pattern redaction; choose Ollama in Arcane Settings for local-only
repository context.

### Arcane capability decision

- I need to make a: capability that lets a developer pair one Arcane checkout, inspect and prepare its environment, and ask the profile-configured AI about bounded code context.
- Could other applications use it: yes; bounded configured-provider chat, native directory selection, and a validated development-workspace client are provider-neutral mechanisms.
- App-specific business logic: Arcane checkout wording, setup workflow, repository prompt, pairing preference, status presentation, and response labels.
- Reusable core: `ConfiguredAIChatSession`, `DirectoryPicker`, `directory-picker.html`, `DevelopmentWorkspace`, native directory selection, profile AI selection, managed requirement status, bounded tracked-file context, and fixed setup execution.
- Extraction boundary: injected AI and workspace providers, app-owned prompt/context formatting, shared component events, and capability-gated native methods.
- Arcane theme base: `arcane/css/theme.css`, `arcane/css/primitives.css`, and `ThemeBootstrap.js`.
- CSS layer order: Arcane theme -> Arcane primitives -> Developer app CSS -> component-local styles.
- User-theme verification: source contract covers theme order and token-only app CSS; targeted visual inspection remains part of a signed native build review.
- Shared files: `arcane/components/directory-picker.html`, `arcane/modules/DirectoryPicker.js`, `arcane/modules/ConfiguredAIChatSession.js`, `arcane/modules/DevelopmentWorkspace.js`, and their examples/tests.
- App files: `apps/developer/`.
- Contract and compatibility impact: additive native directory-selection API and capability plus a `requirements.read` grant; existing AI callers continue to work, while configured Ollama chat may now omit its model and use the saved profile default.
- Verification: focused shared/app/native-source tests, package inspection, generated-Core parse, and targeted package checks.
