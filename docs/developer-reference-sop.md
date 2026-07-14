# Developer Reference Maintenance Standard Operating Procedure

> **Mandatory use:** Follow this SOP whenever adding, removing, renaming, or changing a public developer command, system tool, launcher, npm script, or application-facing `Arcane` native bridge API method.

## Required references

- [Developer Command Reference](developer-commands.md) is authoritative for supported system-level development commands.
- [Arcane API Reference](arcane-api.md) is authoritative for the application-facing `window.Arcane` methods available through WebView2, WebKitGTK, and the development bridge.

## Procedure

1. Change the implementation and its focused tests.
2. In the same change, add or update the corresponding reference row:
   - every system tool, developer launcher, root npm command, or machine-bundle npm command belongs in `developer-commands.md`;
   - every application-facing `Arcane` native bridge method belongs in `arcane-api.md` with its method name, parameters, return, and description.
3. Mark commands as development, unsigned-local-test, or production and state their signing requirements. Never present a production command as ordinary developer setup.
4. Describe normalized public inputs and outputs, not undocumented internal implementation detail. State when a return shape is provider- or platform-dependent.
5. Update aliases and deprecated names; do not silently leave a stale command or method in either table.
6. Run the developer-reference contract test and the relevant implementation suite.

## Review gate

A command or API change is incomplete when its reference row is missing or stale. Reviewers must compare public command manifests and `arcane-api.js` against both tables before approval.
