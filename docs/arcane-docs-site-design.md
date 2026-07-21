# Arcane Docs site capability decision

## User-facing need

I need to make a capability that allows a user to browse and search the Arcane OS documentation, follow verified onboarding journeys, inspect working shared components and screenshots, run trusted browser checks, and optionally ask an Arcane-configured AI questions grounded in a bounded public source catalog.

Inputs are reviewed repository Markdown, selected shared source files, synthetic examples, screenshot assets, an optional browser-local cache, and an optional injected Arcane AI provider. Outputs are rendered documentation, deterministic search results, source and example links, browser-check results, bounded AI context, and a verified static GitHub Pages artifact. The site must remain useful when storage, network access, or native Arcane AI is unavailable.

## Four core questions

1. **I need to make a:** public documentation and component-learning capability with onboarding, search, examples, screenshots, trusted browser checks, and optional bounded codebase assistance.
2. **Could other applications use it:** yes. Static document catalog validation/search, source-aware Markdown rendering, bounded context selection, and trusted test-result orchestration are domain-neutral.
3. **App-specific business logic:** Arcane Docs branding and navigation; the public-source allowlist; the provisioning and developer journeys; component/example/screenshot mappings; GitHub repository links; AI prompt and disclosure language; GitHub Pages deployment policy.
4. **Can that business logic be extracted:** yes. The shared runtime accepts catalog records, document sources, routing callbacks, test callbacks, cache adapters, and chat providers. The app supplies Arcane-specific records, labels, routes, prompts, and publication choices.

## Placement and extraction boundary

### Reusable core

- `arcane/modules/StaticDocumentCatalog.js`: validates a versioned, positive-inventory catalog; performs deterministic weighted search; hydrates only bounded same-origin text; verifies declared content hashes; and builds bounded untrusted context. Persistence is injected rather than selected by the module.
- `arcane/components/markdown-document.html`: renders reviewed Markdown through the shared Marked/`MD.js` path, applies a positive HTML and attribute allowlist, assigns deterministic heading identifiers, emits a table of contents, rewrites document-relative links through an injected route callback, and exposes loading, empty, error, ready, and navigation states.
- `arcane/components/source-code-viewer.html`: renders bounded source exclusively through text nodes, exposes original-path/language metadata and safe line focus, and supplies loading, empty, error, and ready states without parsing source as markup.
- `arcane/modules/BrowserTestSuite.js`: runs parent-supplied trusted checks sequentially with bounded timeouts and normalized pass, fail, and skip results. It does not evaluate visitor-authored code.
- `arcane/modules/AsyncBoundary.js`: gives fetch, body-read, profile, and prompt operations one reusable finite timeout/abort contract with stable error codes.
- `arcane/modules/AppDataScope.js` and `arcane/modules/ScopedOPFSCache.js`: resolve one canonical application identity, open only `apps/<application-id>`, and expose exact-key bounded JSON cache operations without enumeration, export, restore, or whole-origin clearing.
- `arcane/modules/WaitForComponent.js`: supports persistent readiness plus optional error events and finite startup timeouts so a failed optional import cannot strand an application.
- `arcane/modules/HTMLImport.js`: loads executable component HTML only from same-origin redirect-free network responses; origin storage is never treated as executable publication authority.
- `tools/document-catalog/`: deterministic build and verification helpers that copy only app-selected public files and generate the catalog, hashes, and relationships.
- Focused contracts under `test/` and synthetic examples under `example/` document the shared behavior.

### App-specific shell

- `apps/docs/` owns the route map, content taxonomy, onboarding copy, component gallery, screenshot choices, browser checks, provider disclosure, prompt, and positive publication manifest.
- A thin app-local package adapter supplies the public allowlist to the shared catalog builder and verifies the generated Pages tree.
- `.github/workflows/arcane-docs-pages.yml` validates the same deterministic package on pull requests with read-only permissions; trusted `main` runs alone upload `dist/docs` and receive the separate Pages deployment authority.

Dependencies flow from `apps/docs` to `arcane/` and `tools/`. Shared code does not import the docs app.

## Theme and visual contract

- CSS order: optional `arcane/css/layout.css` -> `arcane/css/theme.css` -> `arcane/css/primitives.css` -> `apps/docs/docs.css` -> narrow route/state overrides.
- `arcane/modules/ThemeBootstrap.js` loads before app orchestration so system, light, dark, and saved custom appearance choices remain authoritative.
- New colors use `rgb(...)` or `rgba(...)`; existing Arcane tokens are preferred for surface, text, border, focus, action, and status concepts.
- The information architecture uses native landmarks, headings, lists, buttons, links, forms, and status regions. Search, navigation, component examples, tests, cache controls, and AI controls remain keyboard-operable with visible focus and do not depend on color alone.

## Public content and deployment boundary

- The repository root is never a web root. The only deployable unit is the packager-verified `dist/docs` directory.
- Git attributes pin every Docs and shared browser-runtime text extension to LF, so Microsoft NT and Linux checkouts feed the packager the same canonical source bytes. Dependency bytes still come from the public lockfile and the immutable registry package.
- The app policy explicitly selects documentation, shared runtime source, synthetic examples, and reviewed screenshots. It excludes local data, case material, BOSS working documents, machine build output, credentials, caches, repository metadata, and untracked files.
- The generated catalog records normalized published and original paths, kind, language, media type, title, summary, tags, bounded code search terms, byte size, SHA-256, headings, and optional example/screenshot relationships. Reviewed source is copied beneath `catalog/sources` with an added `.txt` suffix, so HTML source is served as inert text rather than executable page content.
- GitHub Pages is treated as static hosting. All asset and content URLs are project-path safe, routing uses the URL hash, and the artifact contains `.nojekyll` plus a root entry document.
- Browser packages do not gain native Arcane authority. Provisioning and developer pages explain supported native workflows but cannot execute them.

## Storage and AI boundary

- Search works directly from the static catalog and does not require persistence.
- Optional offline source caching automatically stores only the published public corpus in `apps/docs/arcane-docs-public-corpus-v2` on the shared GitHub Pages origin. It does not request persistent-storage treatment, accept private checkout content, enumerate arbitrary origin files, or call whole-origin DBOPFS clear, backup, or restore operations. Each item remains version/hash/size-bound and non-authoritative; browser site-data controls remain the deletion path.
- GitHub Pages never asks for or stores an OpenAI key. The legacy BOSS browser provider, user entity, chat memory, and automatic private-upload retrieval paths are not reused.
- AI is enabled only when a provider implementing the configured Arcane chat contract is injected. The default path is `window.Arcane.ai.chat`; ordinary GitHub Pages therefore shows local search and an explicit unavailable state.
- Selected documentation and source excerpts are bounded, hash-verified, labeled untrusted, and inserted through `ConfiguredAIChatSession` as data rather than system instructions. Code identifiers are represented by build-generated bounded search terms so reviewed files remain discoverable without granting filesystem enumeration. The Ask surface reports attached original paths and line ranges. Provider identity and local/remote status are disclosed before transmission; a remote provider requires explicit confirmation for the current site session.
- AI output is advisory Markdown only. The site exposes no tool execution, filesystem authority, shell, package, provisioning, or repository-write operation.

## Onboarding journeys

### Provision an Arcane OS user

The platform-specific guides are grounded in the machine-bundle README and security/accessibility contracts. The Microsoft NT guide covers the supported Microsoft NT Provisioner, prerequisite readiness, disabled-account staging, private temporary-credential capture, separate activation, first sign-in, password-reset prepare/apply separation, shell restoration, and failure/recovery boundaries. The Linux guide covers the experimental unsigned-local build and verification path, separately authorized root launch, locked-and-expired staging, separate activation, native X11 sign-in, console/SSH fallback, WSLg manual launch, existing-password preservation, and shell recovery. Neither guide displays or collects credentials, and the Linux guide explicitly distinguishes controlled simulation evidence from unfinished real clean-host acceptance.

### Set up as an Arcane developer

The guide is grounded in the root README, build/release SOP, and developer command reference. It identifies `setup-developer.bat` as the normal Microsoft NT entry point, explains public locked dependencies and development-only signing, distinguishes focused checks from complete gates, and separates development-signed or unsigned-local verification from production publication.

## Security and privacy review scope

- Protected assets: repository-publication integrity, user browser storage, provider credentials, selected source excerpts, provider requests/responses, user understanding, and Pages deployment authority.
- Trust boundaries: repository -> build adapter -> Pages artifact; Markdown/source -> renderer; Pages origin -> browser storage; query -> bounded context -> injected provider; feature branch -> GitHub Actions -> `github-pages` environment.
- Primary abuse cases: unintended private-file publication, traversal or case collisions, Markdown/custom-element injection, passive remote-resource requests, cross-project storage collision, oversized corpus/resource exhaustion, provider secret exposure, prompt injection, silent remote transmission, and branch deployment confusion.
- Controls: positive inventories, link/symlink rejection, content hashes and bounds, positive render allowlist, same-origin content resolution, project-specific storage namespace, local-search default, no browser credentials, explicit provider disclosure/confirmation, untrusted user-role context, fail-closed AI availability, verified package tree, and a dedicated Pages artifact.
- Residual risk and independent authority decisions are recorded separately; this design is not security or privacy approval.

## Verification plan

1. Focused module and build tests for hostile catalog records, deterministic source search terms, source-to-inert-path publication, source tampering, total/per-file bounds, deterministic ranking, bounded hydration/context, line ranges, hash mismatch, cache-version handling, timeouts, and normalized test results.
2. Component contract tests for Markdown injection, custom elements, unsafe protocols and remote images, duplicate headings, nested relative links, inert source rendering, bounded line focus, loading/error states, readiness in both orders, keyboard semantics, and emitted events.
3. App tests for Arcane theme order, saved appearance bootstrap, route and landmark structure, public allowlist coverage, component/example/screenshot truthfulness, provisioning/developer guide sources, AI fail-closed behavior, storage namespace, and Pages project-path resolution.
4. Package inspection, build, and verification with the existing Arcane application packager.
5. Local HTTP browser checks at a simulated `/ARCANE-OS/` project path, including keyboard flow, narrow and zoomed layouts, light/dark/system themes, reduced motion, and error states.
6. GitHub Actions build/deploy evidence and live Pages smoke testing. Full Microsoft NT/WebView2 assistive-technology and representative-user evidence remains required before any release-candidate accessibility claim.
