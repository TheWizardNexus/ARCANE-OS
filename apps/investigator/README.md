# Arcane Investigator

Arcane Investigator is a same-app, source-cited workspace for reviewing case 24FL001068. It keeps the local filing corpus, separated evidence, generated investigative analysis, and future police work product below `apps/investigator/data/cases/24FL001068/`; that entire tree is ignored by Git and excluded from the shareable Arcane package.

## Pages

- `index.html` — filing overview with clickable alleged-conduct leads.
- `brief.html` — five-minute Police / DA intake brief with a synchronized allegation dossier: official legal screens, element-by-element proof, motive hypothesis and alternative, candidate-specific chronology, contrary evidence, exact-source opening, contacts, investigative requests, and report artifacts.
- `data.html` — every filing PDF/Markdown pair and separated evidence record.
- `conduct.html` — per-filing lead lists and promoted cross-record comparisons.
- `timeline.html` — filing, statement, comparison, police, treatment, counseling, order, scheduling, and compliance chronology.
- `motives.html` — source-grounded motive hypotheses with innocent explanations.
- `case-map.html` — accessible relationship board linking people, comparisons, orders, and hypotheses.

Every alleged offense or credibility lead is provisional. The app never treats a filing title, contradiction, accusation, or motive as proof of guilt. Human reviewers can change actor, disposition, confidence, notes, and contrary facts in app-scoped Arcane storage.

Coverage counters distinguish import/automated screening from substantive review. For the current coupled dataset, `262 / 262` means complete PDF/Markdown pairs were machine-scanned; it does not mean those filings were human-reviewed. Human source-review progress is counted separately.

## Evidence mapping boundary

- Shared Arcane core: `arcane/modules/CaseEvidenceIndexer.js` conservatively maps exhibit headings to rendered parent-PDF pages and returns `resolved`, `ambiguous`, or `unresolved` provenance; `arcane/components/document-inspector.html` accepts an optional validated `pdfPage` and opens the same-origin PDF there.
- Investigator adapter: the case builder attaches each evidence record to its canonical `F####.pdf` and `F####.md` parent without copying PDFs into `Evidence/`; the document dialog decides whether to start on the PDF or evidence text and explains unresolved candidate pages.
- Generated summaries use stable `Evidence/MD/E####.md` names. Descriptive titles and parent filenames remain in the index and Markdown, keeping browser-served paths below Windows legacy path limits without losing provenance.
- Current coupled result: 96 evidence records have a unique page mapping, 4 retain multiple candidate pages, and 32 remain unresolved. No ambiguous page is silently selected. The generated `Import/import-audit.json` lists all seven excluded PDF-only sources and canonical document counts.
- Theme and accessibility: the existing shared inspector remains keyboard-tabbed, same-origin, titled for assistive technology, and based on Arcane theme variables; Investigator supplies only case-specific labels and metadata.

## Local build

Run the dataset builder against the coupled case source. It rebuilds the filing/evidence index and then automatically rebuilds `Analysis/investigative-analysis.json`:

```powershell
& 'C:\Users\codex\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' apps/investigator/scripts/build_case_dataset.mjs 'C:\Users\codex\Desktop\24FL001068'
```

To refresh only the analysis after changing rules or curated comparisons:

```powershell
& 'C:\Users\codex\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' apps/investigator/scripts/build_investigative_analysis.mjs
```

To rebuild the human-curated referral model after updating its source comparisons or private contact overrides:

```powershell
& 'C:\Users\codex\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' apps/investigator/scripts/build_referral_case.mjs
```

To regenerate the Police / DA Markdown, PDF, source index, and SHA-256 manifest from that referral model:

```powershell
& 'C:\Users\codex\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' apps/investigator/scripts/build_police_reports.py
```

The shareable contracts are `schemas/investigative-analysis.schema.json` and `schemas/referral-case.schema.json`. Generated JSON, contacts, reports, PDFs, evidence, and the source corpus remain below the ignored and package-excluded `data/cases/24FL001068/` folder. Git/package exclusion is a privacy guardrail, not encryption or an agency access-control boundary.
