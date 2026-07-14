# Node.js Single-Executable Strategy

## Decision

Use a **Node.js single executable application** as the primary ARCANE shell and provisioning runtime.

This keeps the principal implementation in one language while preserving access to:

- the native file system;
- subprocesses;
- local networking;
- cryptography;
- operating-system identity;
- Windows ACLs through approved system adapters;
- local AI model services;
- web UI assets;
- capability modules.

## Why This Fits ARCANE

The project already benefits from:

- strong JavaScript and web architecture expertise;
- existing browser-oriented interfaces;
- storage abstraction patterns;
- a need for a local API boundary;
- a desire for offline and controlled deployment;
- a need to reuse components across native and web environments.

A Node single-file executable can package the runtime and startup application without requiring Tauri or Electron merely to provide Node capability.

## Important Boundary

Node.js does **not** by itself provide the desktop window or graphical compositor.

ARCANE still requires a display adapter. Acceptable implementations may include:

- a controlled system WebView host;
- a local full-screen browser surface;
- a small native window host;
- a dedicated rendering process;
- a future platform-specific renderer.

The display adapter must not receive unrestricted Node access. It should communicate with ARCANE through an explicit, typed API.

## Recommended Process Model

```text
arcane.exe
├── Runtime coordinator
├── Local API / IPC broker
├── Capability registry
├── Policy hooks
├── Provisioning commands
├── Updater and verifier
├── Model-service supervisor
└── Renderer supervisor
    └── Unprivileged UI process
```

For higher assurance deployments, split provisioning and ongoing operation:

```text
arcane-shell.exe          Standard user context
arcane-provisioner.exe    Elevated only when explicitly invoked
arcane-service.exe        Narrow privileged broker, if required
```

All three can share the same JavaScript libraries and build system while having separate privileges and entry points.

## Single Executable Packaging

Node's official Single Executable Applications feature can package a prepared application blob into a Node binary. Newer Node versions also document a direct `--build-sea` workflow, though that specific command is still described as active development in current documentation.

Use a pinned Node version and a reproducible release process. Do not build regulated baselines using an unpinned “latest” runtime.

## Node Permission Model

The Node Permission Model can restrict access to resources such as:

- file system paths;
- child processes;
- worker threads;
- native addons or FFI, where applicable.

It is an additional containment layer, not a replacement for:

- Windows ACLs;
- separate user accounts;
- process boundaries;
- service identities;
- capability authorization;
- code signing.

## Untrusted Code

Do not use `node:vm` as a security sandbox. Node's own documentation explicitly states that it is not a security mechanism.

Generated or third-party plugins must run through one of these patterns:

- declarative capability manifests with no arbitrary code;
- a separate restricted process;
- an OS sandbox;
- a WebAssembly boundary with narrowly exposed imports;
- a reviewed and signed trusted module.

## Recommended Direction

Use Node as the **language and orchestration runtime**, while continuing to rely on the System Platform for security boundaries and lower-level enforcement.
