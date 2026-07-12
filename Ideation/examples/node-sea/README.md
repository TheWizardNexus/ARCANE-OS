# Node SEA Concept Example

This is a conceptual scaffold for Codex. It is not a complete ARCANE shell.

It demonstrates:

- a single Node entry point;
- separation between runtime and privileged platform adapters;
- local API startup;
- renderer supervision;
- structured shutdown.

The final Windows implementation must add:

- signed release construction;
- renderer selection;
- proper IPC authentication;
- Windows shell registration;
- ACL provisioning;
- service installation where required;
- recovery and rollback;
- tests.
