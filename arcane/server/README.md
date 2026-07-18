# Arcane static domain server

`StaticDomainServer.mjs` is the reusable transport and publication boundary for an Arcane-controlled static domain. Domain-specific hostnames, copy, app selections, certificate locations, and public assets belong in a `domains/<name>/` adapter.

## Contract

The server accepts a JSON configuration with:

- one canonical site hostname and zero or more exact redirect hostnames;
- an allowlist that maps subdomain labels to registered `dist/<app>` packages;
- a deployment-specific public-origin allowlist that can only narrow the app registry and accepts HTTPS origins, never inherited loopback HTTP services;
- a positive site-release inventory and each app's `ARCANE_APP_RELEASE.json` inventory;
- optional, individually allowlisted site mounts and asset aliases backed by a verified app release;
- an ACME challenge webroot and optional TLS certificate/key paths.

The public API is:

- `loadDomainConfiguration(configPath)` to validate configuration, registry membership, package releases, and inventories;
- `listConfiguredHostnames(configuration)` to return the exact certificate/DNS name set;
- `createDomainRequestHandler(configuration, options)` for focused integration tests or an existing Node listener;
- `startDomainServer(options)` for paired HTTP/HTTPS listeners and in-process TLS reload;
- `createStaticSiteRelease(siteRoot)` to build a deterministic positive file inventory.

The handler serves only `GET` and `HEAD`, never lists directories, rejects request bodies and malformed or traversing paths, resolves and rechecks real paths inside their configured roots, and hashes bytes against the selected release before serving them. Unknown or duplicate host authorities fail closed. Browser CSP origins come from `publicAppSecurity`, must already exist in the native registry, and must be exact HTTPS origins (or the registry-approved `https:` frame scheme). The only mutable publication path is an exact ACME HTTP-01 token file under the configured challenge directory.

## Non-goals

This module is not a reverse proxy, application server, authentication service, dynamic upload endpoint, DNS client, certificate issuer, or repository browser. It does not emulate native `window.Arcane` capabilities for browser-hosted apps. It must not be pointed at a repository root or an unpackaged `apps/<id>` tree.

## Configuration and failures

Configuration errors and invalid release inventories stop startup. A release byte that changes after startup returns a generic server error instead of being published. HTTP request errors disclose no filesystem paths or manifest details. TLS is optional for loopback development; `requireTls` makes missing or unreadable key material a startup failure for production.

Adding a new consumer should require a domain configuration and thin launcher only. If a future consumer needs dynamic routes, authentication, proxying, uploads, or application-specific response logic, keep that behavior out of this static server and design a separate capability boundary.
