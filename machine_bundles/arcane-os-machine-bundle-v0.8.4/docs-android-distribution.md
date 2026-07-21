# Arcane Android multi-package distribution

## Arcane capability decision

- I need to make a: distribution that installs Arcane Launcher as the Android HOME application and installs each Arcane application as an independently launchable Android package.
- Could other applications use it: yes. Package discovery, verified asset hosting, Android bridge admission, network policy, and sandboxed command sessions are platform mechanisms shared by every Arcane application.
- App-specific business logic: application identifier, display name, icon, capability grants, network policy, Android intent roles, and the existing packaged web application remain application-specific.
- Reusable core: the Android WebView host, application catalog validation, installed-package launcher, bridge protocol, system adapter, and terminal process provider remain under `src/hosts/android/` and are compiled into the launcher or per-app host.
- Extraction boundary: generated package metadata and Gradle product-flavor configuration inject identity and policy; activities compose shared providers; application HTML continues to consume the shared `arcane/1` API.
- Arcane theme base: every packaged application continues to load `arcane/css/theme.css` and `arcane/modules/ThemeBootstrap.js` through its verified portable package.
- CSS layer order: unchanged: Arcane theme -> shared primitives/features -> application styles -> narrow component overrides.
- User-theme verification: focused package checks plus emulator inspection of Launcher and Terminal; full Android assistive-technology and custom-theme acceptance remains outside this local unsigned build.
- Shared files: Android host/runtime sources and Android packaging tools.
- App files: existing `apps/<id>/` packages; no Android-only copy of application UI or business logic.
- Contract and compatibility impact: Android host availability expands to the existing terminal session methods; desktop Core behavior remains unchanged. Launcher application launching changes from an internal activity to an explicit installed-package intent.
- Verification: projection tests, bridge/host tests, Gradle debug assembly, exact APK inventory checks, clean emulator installation, Launcher HOME/WebView/catalog instrumentation, Browser navigator configuration and remote home-frame load, and a Terminal command/output check through the real app-UID shell.

## Distribution boundary

The unsigned local Android distribution contains:

- `ArcaneLauncher-debug.apk` (`os.arcane.host.android`), eligible for Android HOME and explicit launch;
- one `ArcaneApp-<id>-debug.apk` package for every registered Arcane application;
- `arcane-android-distribution.json`, which binds each application ID to its package name, APK filename, byte size, and SHA-256.

The launcher embeds no registered application payload directories. It contains the Shell, generated presentation catalog, shared runtime assets, and launcher-package provisioner support assets. Each application APK embeds one verified portable application payload and the shared runtime assets required by that application.

Android `INTERNET` is derived from the application's registered `connectOrigins`, `frameOrigins`, and `mediaOrigins`. The APK permission is present only when at least one such origin is declared; the generated CSP remains the finer per-origin renderer restriction. Terminal, Calculator, Capture, Developer, Files, Markdown, Scamurai, and Settings are built without `INTERNET` in this distribution.

## Android Terminal boundary

Arcane Terminal runs `/system/bin/sh` under the Terminal APK's ordinary Android application UID. It receives no root, ADB, Android `shell` UID, broad storage, package-management, accessibility, or device-administration authority. Sessions are bounded, use an app-private working directory by default, accept only the existing terminal API contract, cap input and forwarded output, and are closed when the hosting activity is destroyed.

This is an application-sandbox terminal. It is not an ADB terminal and cannot claim device-administrator or operating-system-shell authority.

## Security and privacy review record

- Scope/candidate: Arcane 0.8.4 unsigned local Android multi-APK distribution.
- Protected assets: HOME availability, package identity, packaged application bytes, per-package Android storage, command input/output, application permissions, and user recovery to another launcher.
- Trust boundaries: Shell renderer -> Android bridge -> explicit installed package; app renderer -> app-scoped bridge; Terminal renderer -> bounded app-UID child process.
- Controls: explicit package names from generated metadata; package/version checks; no caller-supplied grants or entries; per-app Android UID; positive package inventories; exact origin and app identity binding; capability and application-ID checks; bounded terminal sessions/input/output; no terminal elevation path.
- Residual risk: debug signing does not establish publisher continuity; Android package update/rollback and signer verification are incomplete; web-capable applications intentionally process remote untrusted content; full accessibility and security authority review are not supplied by this implementation.
- Decision: local development evidence only. This document does not approve a release candidate or accept high/critical residual risk.

## Accessibility verification scope

The API 35 emulator check covers Launcher rendering/readiness, the 17-card installed catalog, Terminal input/output state, and a real shell command. TalkBack, switch access, external keyboard traversal, 200%/400% reflow, forced colors, representative-user evaluation, and accessibility-authority disposition remain required before Android is described as a supported release platform.
