# Arcane Docs site accessibility verification record

## Scope and status

- **Scope:** Arcane Docs home, documentation catalog/viewer, component gallery, browser test lab, optional assistant disclosure/composer, provisioning guide, developer guide, themes, narrow layouts, and failure states.
- **Baseline:** public standards-based browser experience; repository accessibility SOP and the WCAG 2.2 A/AA-oriented Arcane baseline guide implementation. This is not the Microsoft NT release-candidate host claim.
- **Verifier:** automated implementation review plus local browser inspection of the deterministic `dist/docs` package served beneath a project-style `/dist/docs/` base path.
- **Status:** source, focused-test, keyboard-focus, route, live-component, screenshot, browser-check, AI-unavailable, and dark-theme contrast evidence is recorded below. Full screen-reader, operating-system forced-colors, 200%/400% scaling, representative-user, and accessibility-authority evidence remains unverified and therefore cannot support an RC conformance claim.

## Implemented accessibility contract

- A first-focusable **Skip to content** link reaches the single `main` landmark.
- Each hash route exposes one visible page-level heading; route changes move focus to that heading without forcing scroll.
- App navigation uses the shared `app-bar`, real links, `aria-current="page"`, and the shared theme switcher.
- Search uses labeled native `input type="search"` fields and forms with the `search` role. Results are real links with title, summary, and metadata; the live status reports result counts.
- The documentation workspace uses complementary catalog navigation and an article region. The Markdown component exposes content and table-of-contents labels, native headings/lists/tables/code, deterministic fragments, and loading/empty/error/ready states.
- Live specimens are labeled articles. They retain their own readiness/event contracts and are paired with source links.
- Browser checks run only from a labeled button; disabled/busy state prevents duplicate runs. Results use an ordered list, text status, symbols hidden from assistive technology, and a polite live region. Meaning does not depend on color alone.
- The assistant disclosure precedes the composer in reading order. Cloud transmission requires a labeled native checkbox; unavailable AI remains an explicit error state and sends nothing.
- Theme styling derives from Arcane tokens, loads `theme.css` then `primitives.css` then app CSS, preserves system/light/dark/custom choices, retains visible focus, provides forced-colors adjustments, and removes smooth scrolling under reduced-motion preference.
- Layouts reflow from two/three columns to one column without changing DOM order. No hover, drag, speech, audio, color, or animation is the only route to a task.
- The provisioning guide does not display, collect, copy, or announce credentials. It preserves the separate save-credential and activate-account steps and points to the native Provisioner for the actual sensitive journey.

## Verification matrix

| Surface or task | Automated/source evidence | Manual browser evidence required | Current result |
|---|---|---|---|
| Landmarks, headings, labels, lists, and link/button semantics | `test/docs-site.test.mjs`; native elements in `apps/docs/index.html` | Inspect accessibility tree on every route | Packaged Home, Docs, Components, Tests, and Ask snapshots exposed the expected navigation, main, region, article, complementary, search, status, list, heading, link, button, textbox, progressbar, and footer semantics. Full assistive-technology inspection remains pending. |
| Keyboard route navigation and focus | Shared app-bar contract; route heading focus; skip link; no positive tabindex | Tab/Shift+Tab through every route; Enter/Space; verify no trap and logical return | Skip-link activation moved focus to the Home page heading; Home, provisioning, developer, Components, Tests, and Ask route activations moved focus to their page heading. A complete reverse-tab traversal remains pending. |
| Documentation search and viewer | Local deterministic search; live result status; viewer state/TOC contract | Search zero/one/many results, open a document, use TOC/fragments, return to results | Provisioning and developer documents rendered from the verified catalog. Filtering for `security` produced one labeled result and a live status stating that search stayed in the browser. Malformed document routing cleared selection and `aria-current` rather than retaining stale content. Zero/many-result and full TOC traversal remain pending. |
| Live components | Persistent readiness tests and existing component contracts | Operate calculator and interactive specimens by keyboard at narrow/zoomed sizes | Four live specimens loaded. Entering `2+3` and activating `=` produced `5`; all six recorded-state images completed with nonzero natural width. Full keyboard operation at magnified sizes remains pending. |
| Test lab states | Fixed suite, disabled run button, ordered textual results | Run pass/fail/skip cases and verify announcements are timely and not repetitive | The packaged lab completed 6/6 checks with a textual `Passed` result, per-check descriptions, zero failed, and zero skipped. Deliberate fail/skip announcement exercises remain pending. |
| AI unavailable and remote-consent states | Fail-closed contract test and disclosure source checks | Verify Pages state, checkbox naming/focus, provider-change error in compatible host | Pages mode displayed the explicit unavailable alert, public-catalog-only boundary, disabled provider path, and no close control that could permanently hide the docked surface. Injected local/cloud host, consent, and provider-change paths remain untested. |
| Light, dark, system, and saved appearance | Theme order and `ThemeBootstrap` test; focused light/dark/forced-colors source contrast gate | Switch each mode, reload/deep-link, inspect focus and all status states | Dark mode was activated through the labeled theme control; the active Home link computed to `rgb(237, 241, 250)` on `rgb(26, 33, 52)` (14.16:1), then Auto was restored. Light, saved reload, custom skin, and operating-system forced-colors manual runs remain pending. |
| Reduced motion and forced colors | CSS media rules | Windows reduced motion and forced-colors manual run | Pending. |
| Reflow and magnification | Responsive CSS; no fixed viewport shell | 320 CSS px, 200% browser zoom, 400% text/reflow-equivalent check | Pending. |
| Screen reader | Semantic source foundation only | Current NVDA and Narrator with Chrome/Edge across primary tasks and errors | Untested; blocks any supported conformance claim. |
| Provisioning and developer guidance | Guide-contract source tests | Read complete journeys with screen reader; verify code blocks and warnings | Pending. Actual native provisioning AX-J03 remains outside this site's authority. |

## Known limitations and gates

- GitHub Pages browser testing does not substitute for the complete native Microsoft NT/WebView2 Provisioner-to-Shell accessibility journeys in `docs/accessibility-baseline.md`.
- Imported components use open shadow roots. Accessibility-tree correctness must be inspected in the actual supported browsers; DOM/source checks alone are insufficient.
- The external GitHub repository link leaves Arcane Docs. GitHub's accessibility is a third-party boundary; the documentation content remains available inside the site.
- AI provider setup and provider responses are not available on ordinary Pages. An injected-host AI claim requires separate keyboard, screen-reader, busy/error, consent, network-loss, and provider-change evidence.
- No representative-user evaluation or accessibility-authority disposition has occurred.

## Release decision

The implementation may be published for public testing only after its focused tests, deterministic package check, and local browser smoke pass. It must not be labeled accessibility-conformant or included in an Arcane OS release-candidate claim until every applicable matrix row has objective evidence and all Blocker/High findings are resolved or the affected claim is removed.
