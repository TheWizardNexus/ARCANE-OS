# Application data isolation

Arcane assigns every packaged application one canonical identifier and keeps
that application's durable state below an app-owned directory. Shared runtime
code supplies the mechanism; an application supplies only its stable package
identifier, schemas, retention rules, and user-facing import/export policy.

## Canonical identity

Application identifiers must match
`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` and contain no more than 64 characters.
Packaged HTML declares the same identifier with:

```html
<meta name="arcane-app-id" content="example-app">
```

In a native host, `Arcane.app.current().id` is authoritative. A disagreement
between the host identity, an explicit adapter identity, and document metadata
fails before storage is opened. Browser-only previews use the document
declaration; a URL or imported module path is never treated as application
identity.

## Storage layout

`<app-id>` below always means the validated canonical identifier.

| Mechanism | App-owned location |
|---|---|
| Arcane Core storage | `<state-root>/Arcane OS/apps/<app-id>/storage.json` |
| Arcane Core preferences | `<state-root>/Arcane OS/apps/<app-id>/preferences.json` |
| Microsoft NT WebView2 profile | `%LOCALAPPDATA%/Arcane OS/apps/<app-id>/webview2/` |
| Linux WebKitGTK persistent session | `$XDG_DATA_HOME/arcane-os/apps/<app-id>/webkit/` |
| Linux WebKitGTK cache | `$XDG_CACHE_HOME/arcane-os/apps/<app-id>/webkit/` |
| Android WebView browsing profile | `arcane-app-<app-id>` (provider-managed on-disk location) |
| Browser OPFS | `apps/<app-id>/<table-or-namespace>/` |
| DBLS browser fallback | local-storage keys prefixed with `arcane.apps.<app-id>:` |
| PreCrisis Cache API | cache names prefixed with `arcane-precrisis-cache-` |

On platforms where the relevant XDG variable is absent, GLib or Core uses the
platform's normal per-user data, cache, or state default before appending the
listed Arcane path.

DBOPFS backups, restores, table enumeration, and clear-all operations start at
`apps/<app-id>`, not the origin root. The file worker receives the already
resolved app identity and revalidates it before opening that same subtree.
Scoped OPFS caches add their exact namespace below the app directory.

Android binds each WebView to a non-default profile before reading settings or
installing the bridge. The host fails closed when the installed WebView
provider does not support multiple profiles; it never falls back to shared
Default-profile state. The provider controls the physical profile directory,
so the stable contract is the validated `arcane-app-<app-id>` profile name.

The Cache API and local storage do not expose real folders. Their app-qualified
names prevent accidental cross-app operations in a shared browser preview. A
native per-app WebView profile or a distinct browser origin remains the
security boundary against hostile same-origin code; any same-origin script can
otherwise request the raw browser storage APIs directly.

## Legacy data

Arcane does not guess ownership for old origin-root DBOPFS tables, unprefixed
local-storage keys, or global preference files. Those records are preserved in
place and are not copied into every app. Generic records such as `users.json`,
timestamp-only chats, and memories do not carry reliable provenance, so an
automatic split could disclose one app's data to another.

The Microsoft NT host may move the unambiguous legacy profile
`Arcane OS/WebView2/<app-id>` to the canonical app directory. It performs one
same-volume directory move and refuses to merge when both old and new locations
exist. Linux's formerly shared default WebKit data is preserved and not
automatically assigned. Android's legacy Default-profile data is also preserved
and is not copied into an app profile.

A future migration tool must require an explicit source app, destination app,
schema, table allowlist, preview, and user confirmation. Import and restore
flows must never accept a backup as authority to select a different app scope.

## Deliberately shared state

Operating-system appearance and accessibility choices are user/platform state,
not application-owned business data. They remain behind the separately
capability-gated `Arcane.appearance` boundary. Apps may reuse entities, schemas,
components, and service adapters, but that code reuse does not grant access to
another application's storage folder.

The selected system AI provider, managed model inventory, and protected
provider credential are also runtime service configuration rather than an
application record. They stay behind capability-gated Core APIs; applications
receive service results and never receive the saved credential. App-owned
prompts, conversations, memories, and provider-derived artifacts remain in the
originating app scope.

User-selected external files and repositories are references or explicit
imports. Arcane does not relocate them into an app folder merely because an app
has been granted access.

## Verification contract

Focused tests must prove all of the following:

- malformed, traversal, conflicting, and overlong app identities fail closed;
- two apps can use the same table and key without observing each other;
- clearing one app preserves the other app and unrelated origin sentinels;
- main-thread and worker OPFS paths resolve to the same app directory;
- native storage and preferences create separate on-disk files per app;
- native browser profiles are resolved before the renderer environment opens;
- Android rejects a missing multi-profile feature rather than using Default;
- legacy unowned data is preserved rather than copied or deleted.

These tests prove path selection and operation scope. They do not prove
filesystem ACLs, link/reparse resistance, encryption, hostile same-origin
containment, backup policy, or release-candidate acceptance.
