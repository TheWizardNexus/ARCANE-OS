# PreCrisis public-site accessibility verification

Date: 2026-07-18  
Scope: `precrisis.ai` marketing and privacy pages served by the local domain host  
Status: implementation evidence, not release-candidate accessibility approval

## Supported journey and structure

The affected journey is: arrive at the public page; understand the product and its limits; find emergency resources; review the available product, approach, people, story, and support sections; open the mobile section menu; read the privacy/data boundary; and optionally continue to the explicitly labeled product preview.

Both pages declare English, UTF-8, a unique title and description, a skip link, one main landmark, ordered headings, native links, meaningful link names, and a content footer. The timeline is a real ordered list. The mobile section menu uses native `details`/`summary`, closes after a section link, and closes on Escape while returning focus to its summary. The skip target is programmatically focusable. Joshua Mateo is absent; Erich Zimmer and George Davis Jr. are present as clearly pending profiles without invented roles or biographies.

Emergency content states that PreCrisis AI does not monitor emergencies, provides U.S. 988 and 911 routes, and distinguishes the product from diagnosis, licensed care, and emergency response. The product link is labeled as a preview while its packaged first-run terms remain incomplete, and a dedicated privacy page explains browser storage, device/profile access, network-model transmission, exports, deletion, infrastructure logs, and email limitations.

## Evidence completed

| Check | Evidence | Result |
|---|---|---|
| Semantic source | Focused test plus browser accessibility-tree snapshot | Pass for language, title, landmarks, heading order, native controls, fragment targets, timeline list, people, preview warning, privacy link, and emergency links. |
| Theme order | Focused test | Pass: shared theme, shared primitives, then site CSS; `ThemeBootstrap.js` loads before the site interaction module. |
| Contrast | CSS values measured with WCAG relative luminance | Pass for corrected text pairs: light primary button 5.13:1; dark primary button 7.48:1; light timeline date 5.77:1; light Principles eyebrow 5.13:1; dark Principles eyebrow 11.52:1; dark timeline date 10.45:1. |
| Reflow | In-app browser at 320 by 800 CSS pixels | Pass: document `scrollWidth` equaled `clientWidth` (305 pixels after the scrollbar); no page-level horizontal scrolling. The earlier decorative-ring/body overflow was corrected. |
| Responsive navigation | In-app browser at 320 pixels | Pass: menu exposed all five section links, section activation updated the fragment and closed the menu, and Escape closed the menu and restored summary focus. |
| Desktop layout | In-app browser at 1280 by 720 CSS pixels | Pass: document width matched the usable viewport and the final page reported no browser warnings or errors. |
| Privacy page | In-app browser at 320 pixels | Pass: one H1, ordered H2 regions, no horizontal overflow, and complete preview/data-boundary content in the accessibility tree. |
| Focus target | In-app browser | Partial pass: activating the skip link transferred focus to `main`; the automated browser keyboard driver did not reliably produce the initial Tab/Enter sequence, so a manual keyboard-only pass remains required. |
| Motion and forced colors | Source inspection and focused assertions | Rules are present for reduced motion and forced colors; real operating-system modes were not exercised. |

## Remaining mandatory evidence

Before public accessibility approval or any release-candidate claim, complete the journey on the actual production HTTPS host with:

- manual keyboard-only tab order, skip-link visibility/activation, section navigation, menu behavior, and external/email/telephone links;
- NVDA and Narrator announcements for headings, landmarks, `details` state, emergency language, preview warning, and privacy sections;
- light, dark, system, forced-colors, and any supported custom theme in the real host;
- 200% and 400% zoom, text-spacing overrides, font substitution, and target-size measurements;
- reduced-motion behavior and sticky-header/fragment positioning;
- representative-user comprehension of the emergency, AI fallibility, network-provider, browser-storage, payment, and preview language;
- the complete `app.precrisis.ai` journey, including its first-run terms after they are corrected and the package is rebuilt; and
- production error, DNS/TLS failure, unavailable-provider, denied-microphone, storage-loss, and recovery states.

No screen reader, production HTTPS origin, high-contrast operating-system mode, native Arcane host, or representative participant was available in this implementation pass. Those gaps are explicit blockers for a final accessibility or release-candidate approval.
