# BOSS Libraries Conversion Report

- Builder: `boss-library-md-v1`
- Source files discovered: 500
- Normalized records generated: 500
- Coverage: 500/500
- Unique IDs: 500
- Unique output filenames: 500
- Exact duplicate groups: 0
- Duplicate alias records: 0
- Raw binaries copied: 0

## By source format

| Format | Count |
|---|---:|
| `.csv` | 1 |
| `.docx` | 6 |
| `.jpg` | 5 |
| `.md` | 420 |
| `.odp` | 3 |
| `.pdf` | 55 |
| `.png` | 1 |
| `.ppt` | 1 |
| `.pptx` | 7 |
| `.txt` | 1 |

## By extraction status

| Status | Count |
|---|---:|
| `complete` | 481 |
| `human-described` | 1 |
| `partial` | 18 |

## By access classification

| Access | Count |
|---|---:|
| `public` | 500 |

## Title provenance

| Title source | Count |
|---|---:|
| `filename_preferred` | 72 |
| `first_text_heading` | 1 |
| `human_special_case` | 1 |
| `human_visual_description` | 6 |
| `markdown_h1` | 420 |

## Exact duplicate groups


## Known extraction limitations

- PDF extraction is text-first. Image-only pages are flagged because OCR is not bundled into this build.
- DOCX, PPTX, and ODP embedded media is counted; only the standalone image sources received human visual descriptions.
- Legacy `.ppt` extraction is a best-effort printable-string scan and does not preserve slide order or layout.
- Spreadsheet formulas are read as stored and are not recalculated.
- The RTB board exposes readable board metadata, but its canvas/table payloads use an application-level encoded or encrypted representation.
- Restricted records intentionally omit identifiers, account values, signatures, and detailed private content.

## Validation result

The builder validated source coverage, unique IDs, unique output filenames, source existence, output existence, H1/title alignment, duplicate targets, and manifest/output hashes.
