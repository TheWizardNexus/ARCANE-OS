# Codex Project Instructions

Use this document as persistent project context.

## Project

Build **ARCANE**, an AI-native operating environment by **The Wizard Nexus**.

ARCANE stands for:

**Adaptive Runtime for Cognitive AI Native Environments**

The expansion is technically useful but should not be forced into every user-facing surface.

## Current Implementation Direction

Use a Node.js single executable application as the primary runtime, shell coordinator, and provisioner.

Do not add Electron, Tauri, or another desktop framework merely for access to Node or the file system.

A separate rendering adapter is still required. Keep it replaceable and unprivileged.

## Architectural Rules

1. Keep privileged system operations outside the UI.
2. Expose OS functionality through typed capabilities.
3. Keep Windows-specific logic behind a System Platform Adapter.
4. Use OS accounts, groups, ACLs, and process boundaries.
5. Do not rely on prompts for security.
6. Do not let plugins choose their own storage or privilege scope.
7. Do not use `node:vm` as a sandbox.
8. Keep user, machine, organizational, and policy memory separate.
9. Make all privileged actions auditable.
10. Prefer deterministic schemas and policy checks.
11. Treat offline operation as a first-class mode.
12. Pin versions and make builds reproducible.
13. Never silently fall back from ARCANE into Explorer for a normal user.
14. Maintenance mode requires an authenticated administrator.
15. Keep the core domain-neutral; implement vertical behavior as capabilities and policy packages.

## Preferred Module Boundaries

```text
src/
├── runtime/
├── intent/
├── capabilities/
├── memory/
├── compass/
├── platform/
│   ├── common/
│   └── windows/
├── renderer/
├── provisioning/
├── update/
├── audit/
└── config/
```

## Storage Interface

Maintain a common asynchronous storage interface so web and native builds can swap implementations.

Example conceptual interface:

```js
export interface StorageProvider {
  get(namespace, key);
  set(namespace, key, value, options);
  delete(namespace, key);
  list(namespace, query);
  transaction(operations);
}
```

Implementations may include:

- OPFS provider;
- native file-system provider;
- encrypted database provider;
- in-memory test provider.

Do not let calling code infer the user's profile path manually. Resolve scope through the storage service.

## Capability Requirements

Every capability must have:

- a stable identifier;
- version;
- input and output schemas;
- required role;
- requested OS privileges;
- network declaration;
- audit classification;
- TWiN Compass hooks;
- timeout;
- cancellation;
- error model.

## Code Quality

- prefer small modules;
- validate all external input;
- use structured errors;
- avoid shell command string concatenation;
- use argument arrays for subprocesses;
- log security-relevant decisions;
- include unit and integration tests;
- make failure and rollback explicit;
- document assumptions.
