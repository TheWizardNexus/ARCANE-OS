# DevelopmentWorkspace example

`DevelopmentWorkspace` is a provider-neutral client for an explicitly selected
local development directory. The native provider is responsible for validating
and canonicalizing that directory, returning bounded context, and exposing a
fixed setup-task allowlist. The client does not scan for repositories and does
not accept shell commands. A provider may also expose one fixed, privileged
Node.js prerequisite installer through `installNode()`; the client cannot pass
it a package, URL, command, or installer option.

The synthetic example injects a harmless in-memory provider so its contract can
be inspected in a browser without native filesystem access.
