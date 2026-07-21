#!/usr/bin/env python3
"""Build the app-owned police / DA intake report artifacts for case 24FL001068.

The generator intentionally treats referral-case.json as the only report data
contract. It does not infer allegations from the larger case corpus and it does
not copy source evidence into the report directory.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import io
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas
    from reportlab.platypus import (
        KeepTogether,
        LongTable,
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )
except ImportError as exc:  # pragma: no cover - exercised only on an incomplete runtime
    raise SystemExit(
        "ReportLab is required. Run this script with the Arcane workspace Python runtime."
    ) from exc


APP_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = APP_ROOT.parents[1]
SHARED_BUILD_ROOT = REPOSITORY_ROOT / "arcane" / "build"
if str(SHARED_BUILD_ROOT) not in sys.path:
    sys.path.insert(0, str(SHARED_BUILD_ROOT))

try:
    from PdfSourcePacket import BUILDER_VERSION as PACKET_BUILDER_VERSION
    from PdfSourcePacket import PacketBuildError, build_source_packet
except ImportError as exc:  # pragma: no cover - repository/runtime setup failure
    raise SystemExit(f"Shared PDF packet builder is unavailable: {SHARED_BUILD_ROOT}") from exc

DEFAULT_CASE_ID = "24FL001068"
DEFAULT_CASE_ROOT = APP_ROOT / "data" / "cases" / DEFAULT_CASE_ID
GENERATOR_VERSION = "1.2.0"
PRIVATE_PACKET_NOTICE = "PRIVATE-PARTY REFERRAL - UNVERIFIED - NOT AN AGENCY RECORD"


def clean_text(value: Any) -> str:
    """Return display text with Unicode dash characters normalized to ASCII hyphens."""
    if value is None:
        return ""
    text = str(value)
    translations = {
        ord("\u2010"): "-",
        ord("\u2011"): "-",
        ord("\u2012"): "-",
        ord("\u2013"): "-",
        ord("\u2014"): "-",
        ord("\u2212"): "-",
        ord("\u00ad"): "",
        ord("\u00a0"): " ",
        ord("\u2022"): "|",
        ord("\u00b7"): "|",
    }
    return re.sub(r"[ \t]+", " ", text.translate(translations)).strip()


def xml(value: Any) -> str:
    return html.escape(clean_text(value), quote=True).replace("\n", "<br/>")


def md_escape(value: Any) -> str:
    return clean_text(value).replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_atomic(path: Path, payload: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    if isinstance(payload, str):
        temporary.write_text(payload, encoding="utf-8", newline="\n")
    else:
        temporary.write_bytes(payload)
    os.replace(temporary, path)


def is_link_or_junction(path: Path) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(os.path, "isjunction", None)
    return bool(is_junction and is_junction(path))


def resolve_case_file(case_root: Path, relative_value: Any, *, suffix: str = "") -> Path:
    """Resolve a referral-owned path without permitting traversal or link indirection."""
    relative = clean_text(relative_value)
    candidate = Path(relative)
    if not relative or candidate.is_absolute() or candidate.drive or ".." in candidate.parts:
        raise SystemExit(f"Unsafe case-relative path in referral: {relative or '<blank>'}")
    try:
        resolved = (case_root / candidate).resolve(strict=True)
        resolved.relative_to(case_root)
    except (OSError, ValueError) as exc:
        raise SystemExit(f"Referral path does not resolve inside the case root: {relative}") from exc
    current = resolved
    while current != case_root:
        if is_link_or_junction(current):
            raise SystemExit(f"Referral path crosses a link or junction: {relative}")
        if current.parent == current:
            raise SystemExit(f"Referral path escaped the case root: {relative}")
        current = current.parent
    if not resolved.is_file():
        raise SystemExit(f"Referral path is not a regular file: {relative}")
    if suffix and resolved.suffix.lower() != suffix.lower():
        raise SystemExit(f"Referral path has the wrong file type: {relative}")
    return resolved


def read_referral(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"Referral dataset not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Referral dataset is not valid JSON: {path}: {exc}") from exc

    required = ("case", "theory", "contacts", "candidates", "chronology", "requests", "sources", "packetPlan")
    missing = [key for key in required if key not in data]
    if missing:
        raise SystemExit(f"Referral dataset is missing required keys: {', '.join(missing)}")
    if not data["candidates"]:
        raise SystemExit("Referral dataset has no human-curated candidates.")
    return data


def source_map(referral: dict[str, Any]) -> dict[str, dict[str, Any]]:
    sources: dict[str, dict[str, Any]] = {}
    for source in referral.get("sources", []):
        source_id = source.get("id")
        if not source_id:
            raise SystemExit("A referral source is missing its id.")
        if source_id in sources:
            if sources[source_id] == source:
                continue
            raise SystemExit(f"Conflicting duplicate referral source id: {source_id}")
        sources[source_id] = source
    return sources


def require_source_ids(referral: dict[str, Any], sources: dict[str, dict[str, Any]]) -> None:
    references: list[tuple[str, str]] = []
    for contact in referral.get("contacts", []):
        references.extend((contact.get("id", "contact"), item) for item in contact.get("sourceIds", []))
    for candidate in referral.get("candidates", []):
        owner = candidate.get("id", "candidate")
        for key in ("sourceIds", "contrarySourceIds"):
            references.extend((owner, item) for item in candidate.get(key, []))
        for element in candidate.get("elements", []):
            references.extend((element.get("id", owner), item) for item in element.get("sourceIds", []))
    for event in referral.get("chronology", []):
        references.extend((event.get("id", "chronology"), item) for item in event.get("sourceIds", []))
    for motive in referral.get("motives", []):
        references.extend((motive.get("id", "motive"), item) for item in motive.get("supportingSourceIds", []))
    unresolved = sorted({f"{owner} -> {source_id}" for owner, source_id in references if source_id not in sources})
    if unresolved:
        raise SystemExit("Unresolved report source references:\n" + "\n".join(unresolved))


def exact_citation(source: dict[str, Any]) -> str:
    filename = clean_text(source.get("filename") or source.get("recordId") or "Unknown source")
    page = source.get("page")
    lines = ""
    if source.get("lineStart") is not None:
        line_end = source.get("lineEnd", source.get("lineStart"))
        lines = f", MD lines {source['lineStart']}-{line_end}"
    page_text = f", PDF p. {page}" if page is not None else ", PDF page not assigned"
    return f"{filename}{page_text}{lines}"


def short_citation(source: dict[str, Any]) -> str:
    record_id = clean_text(source.get("recordId") or source.get("id") or "source")
    page = source.get("page")
    page_text = f"p.{page}" if page is not None else "p.?"
    if source.get("lineStart") is not None:
        line_end = source.get("lineEnd", source.get("lineStart"))
        return f"{record_id} {page_text} / MD {source['lineStart']}-{line_end}"
    return f"{record_id} {page_text}"


def citations(source_ids: Iterable[str], sources: dict[str, dict[str, Any]], *, short: bool = False) -> str:
    formatter = short_citation if short else exact_citation
    return "; ".join(formatter(sources[source_id]) for source_id in source_ids if source_id in sources) or "No source cited"


def clipped_excerpt(source: dict[str, Any], limit: int = 700) -> str:
    excerpt = clean_text(source.get("excerpt", ""))
    if len(excerpt) <= limit:
        return excerpt
    boundary = excerpt.rfind(" ", 0, limit)
    if boundary < limit // 2:
        boundary = limit
    return excerpt[:boundary].rstrip() + " ... [excerpt clipped]"


def contact_details(contact: dict[str, Any]) -> str:
    ordered_keys = (
        "organization",
        "address",
        "phone",
        "email",
        "contact",
        "contactStatus",
        "verificationNote",
        "notes",
    )
    values: list[str] = []
    seen: set[str] = set()
    for key in ordered_keys:
        value = contact.get(key)
        if isinstance(value, dict):
            for label, nested_value in value.items():
                rendered = clean_text(nested_value)
                if rendered and rendered not in seen:
                    values.append(f"{clean_text(label).title()}: {rendered}")
                    seen.add(rendered)
        elif isinstance(value, list):
            rendered = "; ".join(clean_text(item) for item in value if clean_text(item))
            if rendered and rendered not in seen:
                values.append(rendered)
                seen.add(rendered)
        else:
            rendered = clean_text(value)
            if rendered and rendered not in seen:
                values.append(rendered)
                seen.add(rendered)
    return " | ".join(values) or "Not supplied - verify before submission"


def sorted_candidates(referral: dict[str, Any]) -> list[dict[str, Any]]:
    return sorted(referral.get("candidates", []), key=lambda item: (item.get("rank", 999), item.get("id", "")))


def primary_contacts(referral: dict[str, Any]) -> list[dict[str, Any]]:
    markers = ("reporting party", "subject", "current counsel")
    return [
        contact
        for contact in referral.get("contacts", [])
        if any(marker in clean_text(contact.get("role")).lower() for marker in markers)
    ]


def additional_contacts(referral: dict[str, Any]) -> list[dict[str, Any]]:
    primary_ids = {contact.get("id") for contact in primary_contacts(referral)}
    return [contact for contact in referral.get("contacts", []) if contact.get("id") not in primary_ids]


def source_usage(referral: dict[str, Any]) -> dict[str, dict[str, set[str]]]:
    usage: dict[str, dict[str, set[str]]] = {
        source.get("id"): {"candidates": set(), "elements": set(), "contacts": set(), "chronology": set(), "motives": set()}
        for source in referral.get("sources", [])
    }
    for candidate in referral.get("candidates", []):
        for source_id in candidate.get("sourceIds", []) + candidate.get("contrarySourceIds", []):
            usage[source_id]["candidates"].add(candidate.get("id", ""))
        for element in candidate.get("elements", []):
            for source_id in element.get("sourceIds", []):
                usage[source_id]["candidates"].add(candidate.get("id", ""))
                usage[source_id]["elements"].add(element.get("id", ""))
    for contact in referral.get("contacts", []):
        for source_id in contact.get("sourceIds", []):
            usage[source_id]["contacts"].add(contact.get("id", ""))
    for event in referral.get("chronology", []):
        for source_id in event.get("sourceIds", []):
            usage[source_id]["chronology"].add(event.get("id", ""))
    for motive in referral.get("motives", []):
        for source_id in motive.get("supportingSourceIds", []):
            usage[source_id]["motives"].add(motive.get("id", ""))
    return usage


def build_source_index_csv(referral: dict[str, Any]) -> str:
    usage = source_usage(referral)
    unique_sources = source_map(referral)
    output = io.StringIO(newline="")
    fieldnames = [
        "source_id",
        "record_id",
        "role",
        "source_tier",
        "filed_date",
        "filing_party",
        "title",
        "filename",
        "pdf_page",
        "markdown_lines",
        "pdf_path",
        "markdown_path",
        "candidate_ids",
        "element_ids",
        "contact_ids",
        "chronology_ids",
        "motive_ids",
        "note",
        "excerpt",
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    for source in sorted(unique_sources.values(), key=lambda item: (item.get("recordId", ""), item.get("page") or 0, item.get("lineStart") or 0)):
        source_id = source["id"]
        source_use = usage[source_id]
        line_start = source.get("lineStart")
        line_end = source.get("lineEnd", line_start)
        writer.writerow(
            {
                "source_id": clean_text(source_id),
                "record_id": clean_text(source.get("recordId")),
                "role": clean_text(source.get("role")),
                "source_tier": clean_text(source.get("sourceTier")),
                "filed_date": clean_text(source.get("filedDate")),
                "filing_party": clean_text(source.get("filingParty")),
                "title": clean_text(source.get("title")),
                "filename": clean_text(source.get("filename")),
                "pdf_page": clean_text(source.get("page")),
                "markdown_lines": f"{line_start}-{line_end}" if line_start is not None else "",
                "pdf_path": clean_text(source.get("pdfPath")),
                "markdown_path": clean_text(source.get("markdownPath")),
                "candidate_ids": ";".join(sorted(source_use["candidates"])),
                "element_ids": ";".join(sorted(source_use["elements"])),
                "contact_ids": ";".join(sorted(source_use["contacts"])),
                "chronology_ids": ";".join(sorted(source_use["chronology"])),
                "motive_ids": ";".join(sorted(source_use["motives"])),
                "note": clean_text(source.get("note")),
                "excerpt": clean_text(source.get("excerpt")),
            }
        )
    return output.getvalue()


def prepare_packet_plan(
    referral: dict[str, Any],
    sources: dict[str, dict[str, Any]],
    case_root: Path,
) -> dict[str, Any]:
    """Validate and map the app-specific allowlist into the shared packet contract."""
    plan = referral.get("packetPlan")
    if not isinstance(plan, dict) or plan.get("schemaVersion") != 1:
        raise SystemExit("Referral packetPlan schemaVersion 1 is required.")
    if plan.get("status") != "human-curated-page-allowlist":
        raise SystemExit("Referral packetPlan must be an explicit human-curated page allowlist.")
    if plan.get("highlightMode") != "guide-only-callouts":
        raise SystemExit("Only guide-only packet callouts are supported without verified PDF coordinates.")
    raw_attachments = plan.get("attachments")
    if not isinstance(raw_attachments, list) or not raw_attachments:
        raise SystemExit("Referral packetPlan.attachments must be a non-empty array.")

    candidate_ids = {clean_text(item.get("id")) for item in referral.get("candidates", [])}
    expected_candidate_source_ids: set[str] = set()
    for candidate in referral.get("candidates", []):
        expected_candidate_source_ids.update(candidate.get("sourceIds", []))
        expected_candidate_source_ids.update(candidate.get("contrarySourceIds", []))
        for proof in candidate.get("elements", []):
            expected_candidate_source_ids.update(proof.get("sourceIds", []))

    contact_source_ids = {
        source_id
        for contact in referral.get("contacts", [])
        for source_id in contact.get("sourceIds", [])
    }
    expected_contact_only = contact_source_ids - expected_candidate_source_ids
    excluded_contact_source_ids = plan.get("contactOnlySourceIdsExcludedFromEvidenceSelection")
    if not isinstance(excluded_contact_source_ids, list):
        raise SystemExit("packetPlan contact exclusion list is required.")
    if len(excluded_contact_source_ids) != len(set(excluded_contact_source_ids)):
        raise SystemExit("packetPlan contact exclusion list contains duplicate source ids.")
    if set(excluded_contact_source_ids) != expected_contact_only:
        missing = sorted(expected_contact_only - set(excluded_contact_source_ids))
        extra = sorted(set(excluded_contact_source_ids) - expected_contact_only)
        raise SystemExit(
            "packetPlan contact-only exclusion mismatch. "
            f"Missing: {', '.join(missing) or 'none'}; extra: {', '.join(extra) or 'none'}."
        )

    shared_attachments: list[dict[str, Any]] = []
    indexed_attachments: list[dict[str, Any]] = []
    selected_candidate_source_ids: set[str] = set()
    selected_context_source_ids: set[str] = set()
    selected_source_ids: set[str] = set()
    selected_physical_pages: set[tuple[str, int]] = set()
    highlight_counter = 0
    attachment_ids: set[str] = set()

    for attachment_index, attachment in enumerate(raw_attachments):
        if not isinstance(attachment, dict):
            raise SystemExit(f"packetPlan attachment {attachment_index} must be an object.")
        attachment_id = clean_text(attachment.get("id"))
        if not attachment_id or attachment_id in attachment_ids:
            raise SystemExit(f"packetPlan attachment id is missing or duplicated: {attachment_id}")
        attachment_ids.add(attachment_id)
        record_id = clean_text(attachment.get("recordId"))
        if not re.fullmatch(r"F\d{4}", record_id):
            raise SystemExit(f"{attachment_id} has an invalid recordId: {record_id}")
        title = clean_text(attachment.get("title"))
        purpose = clean_text(attachment.get("purpose"))
        attachment_candidate_ids = attachment.get("candidateIds")
        if not isinstance(attachment_candidate_ids, list) or any(
            item not in candidate_ids for item in attachment_candidate_ids
        ):
            raise SystemExit(f"{attachment_id} has an unresolved candidate id.")
        source_reviews = attachment.get("sourceReviews")
        if not isinstance(source_reviews, list) or not source_reviews:
            raise SystemExit(f"{attachment_id} must contain sourceReviews.")

        attachment_source_ids: list[str] = []
        attachment_pages: set[int] = set()
        callouts: list[dict[str, str]] = []
        indexed_reviews: list[dict[str, Any]] = []
        attachment_pdf_path = ""
        attachment_filename = ""
        attachment_source_path: Path | None = None
        for review_index, review in enumerate(source_reviews):
            if not isinstance(review, dict):
                raise SystemExit(f"{attachment_id} source review {review_index} must be an object.")
            source_id = clean_text(review.get("sourceId"))
            source = sources.get(source_id)
            if not source:
                raise SystemExit(f"{attachment_id} references unknown packet source {source_id}.")
            if source_id in selected_source_ids:
                raise SystemExit(f"Packet source {source_id} is allowlisted more than once.")
            if clean_text(source.get("recordId")) != record_id:
                raise SystemExit(f"{attachment_id} source {source_id} does not belong to {record_id}.")
            use = clean_text(review.get("use"))
            if use not in {"candidate", "context"}:
                raise SystemExit(f"{attachment_id} source {source_id} has unsupported use {use}.")
            review_pages = review.get("pages")
            if (
                not isinstance(review_pages, list)
                or not review_pages
                or any(isinstance(page, bool) or not isinstance(page, int) or page < 1 for page in review_pages)
                or review_pages != sorted(set(review_pages))
            ):
                raise SystemExit(f"{attachment_id} source {source_id} has invalid reviewed pages.")
            if source.get("page") not in review_pages:
                raise SystemExit(
                    f"{attachment_id} source {source_id} does not include its cited page {source.get('page')}."
                )
            if use == "candidate":
                selected_candidate_source_ids.add(source_id)
            else:
                if source_id in expected_candidate_source_ids:
                    raise SystemExit(f"Candidate source {source_id} may not be downgraded to packet context.")
                selected_context_source_ids.add(source_id)
            selected_source_ids.add(source_id)
            attachment_source_ids.append(source_id)
            attachment_pages.update(review_pages)

            pdf_path = clean_text(source.get("pdfPath"))
            filename = clean_text(source.get("filename"))
            if not attachment_pdf_path:
                attachment_pdf_path = pdf_path
                attachment_filename = filename
                attachment_source_path = resolve_case_file(case_root, pdf_path, suffix=".pdf")
            elif pdf_path != attachment_pdf_path or filename != attachment_filename:
                raise SystemExit(f"{attachment_id} mixes different source PDFs.")

            highlight_counter += 1
            highlight_id = f"H{highlight_counter:03d}"
            role = clean_text(source.get("role") or use)
            mode = "context" if use == "context" else "limitation" if role == "limitation" else "guide-only"
            limitation_parts = [clean_text(review.get("note")), clean_text(source.get("note"))]
            if use == "context":
                limitation_parts.append("Context only; this source is not independent proof of a candidate element.")
            limitation = " ".join(part for part in limitation_parts if part)
            callout = {
                "id": highlight_id,
                "source_id": source_id,
                "label": f"{source_id} | {record_id} | {role} | cited source p.{source.get('page')}",
                "excerpt": clipped_excerpt(source, 390),
                "relevance": purpose[:480],
                "limitation": limitation[:480],
                "mode": mode,
            }
            callouts.append(callout)
            indexed_reviews.append(
                {
                    "highlightId": highlight_id,
                    "sourceId": source_id,
                    "use": use,
                    "role": role,
                    "citedSourcePage": source.get("page"),
                    "reviewedSourcePages": list(review_pages),
                    "excerpt": clean_text(source.get("excerpt")),
                    "relevance": purpose,
                    "limitation": limitation,
                }
            )

        if attachment_source_path is None:
            raise SystemExit(f"{attachment_id} has no source PDF.")
        pages = sorted(attachment_pages)
        for page in pages:
            key = (attachment_pdf_path, page)
            if key in selected_physical_pages:
                raise SystemExit(f"Physical source page is allowlisted more than once: {attachment_pdf_path} p.{page}")
            selected_physical_pages.add(key)

        shared_attachments.append(
            {
                "id": attachment_id,
                "title": title,
                "source_path": str(attachment_source_path),
                "source_filename": attachment_filename,
                "pages": pages,
                "source_ids": attachment_source_ids,
                "candidate_ids": attachment_candidate_ids,
                "purpose": purpose,
                "callouts": callouts,
            }
        )
        indexed_attachments.append(
            {
                "id": attachment_id,
                "title": title,
                "recordId": record_id,
                "candidateIds": list(attachment_candidate_ids),
                "purpose": purpose,
                "pdfPath": attachment_pdf_path,
                "filename": attachment_filename,
                "sourcePath": attachment_source_path,
                "sourcePages": pages,
                "sourceIds": attachment_source_ids,
                "reviews": indexed_reviews,
            }
        )

    if selected_candidate_source_ids != expected_candidate_source_ids:
        missing = sorted(expected_candidate_source_ids - selected_candidate_source_ids)
        extra = sorted(selected_candidate_source_ids - expected_candidate_source_ids)
        raise SystemExit(
            "packetPlan candidate source allowlist mismatch. "
            f"Missing: {', '.join(missing) or 'none'}; extra: {', '.join(extra) or 'none'}."
        )
    expected_page_count = plan.get("expectedSourcePageCount")
    if expected_page_count != len(selected_physical_pages):
        raise SystemExit(
            f"packetPlan expected {expected_page_count} physical pages but selected "
            f"{len(selected_physical_pages)}."
        )

    source_inputs: list[dict[str, Any]] = []
    for attachment in indexed_attachments:
        source_path = attachment["sourcePath"]
        source_inputs.append(
            {
                "path": source_path.relative_to(case_root).as_posix(),
                "filename": attachment["filename"],
                "recordId": attachment["recordId"],
                "byteLength": source_path.stat().st_size,
                "sha256": sha256_file(source_path),
                "pages": attachment["sourcePages"],
                "attachmentIds": [attachment["id"]],
            }
        )

    return {
        "plan": plan,
        "sharedAttachments": shared_attachments,
        "attachments": indexed_attachments,
        "candidateSourceIds": sorted(selected_candidate_source_ids),
        "contextSourceIds": sorted(selected_context_source_ids),
        "excludedContactSourceIds": list(excluded_contact_source_ids),
        "sourceInputs": source_inputs,
        "sourcePageCount": len(selected_physical_pages),
    }


def build_packet_highlight_guide(
    referral: dict[str, Any],
    sources: dict[str, dict[str, Any]],
    packet_context: dict[str, Any],
    packet_result: dict[str, Any],
    packet_path: Path,
    generated_at: str,
) -> str:
    packet_pages = packet_result["pages"]
    divider_by_attachment = {
        page["attachmentId"]: page["packetPage"]
        for page in packet_pages
        if page["kind"] == "divider"
    }
    source_page_lookup = {
        (page["attachmentId"], page["originalPage"]): page["packetPage"]
        for page in packet_pages
        if page["kind"] == "source-page"
    }
    lines = [
        "# Police / DA Evidence Packet - Highlight Guide",
        "",
        f"**Case:** {clean_text(referral.get('case', {}).get('id'))}  ",
        f"**Related case:** {clean_text(referral.get('case', {}).get('relatedCase'))}  ",
        f"**Referral snapshot:** {generated_at}  ",
        f"**Packet SHA-256:** `{sha256_file(packet_path)}`",
        "",
        f"> **{PRIVATE_PACKET_NOTICE}.** This guide and its yellow divider callouts are private-party derivative work product. They are not agency evidence, findings of guilt, or substitutes for the complete originals, certified records, native media, or independent review.",
        "",
        "## How to use this guide",
        "",
        "- Each attachment divider identifies an exact allowlisted PDF and reviewed source pages.",
        "- Yellow boxes contain narrow extracted passages for orientation only. Verify the wording against the immediately following original source page or pages.",
        "- Original source-page content is unmarked and scaled only into reserved header/footer space. No OCR-derived highlight rectangle is drawn over source content.",
        "- A context entry or contrary source is not independent proof of a candidate element. Preserve limitations, defenses, and the full surrounding record.",
        "",
        "## Packet attachment index",
        "",
        "| Attachment | Candidates | Source PDF | Source pages | Packet divider | Purpose |",
        "|---|---|---|---|---|---|",
    ]
    for attachment in packet_context["attachments"]:
        pages = ", ".join(str(page) for page in attachment["sourcePages"])
        candidates = ", ".join(attachment["candidateIds"]) or "Context only"
        lines.append(
            f"| {md_escape(attachment['id'])} | {md_escape(candidates)} | "
            f"{md_escape(attachment['filename'])} | {pages} | "
            f"Packet p. {divider_by_attachment[attachment['id']]} | {md_escape(attachment['purpose'])} |"
        )

    lines.extend(["", "## Guide-only factual callouts", ""])
    for attachment in packet_context["attachments"]:
        for review in attachment["reviews"]:
            source = sources[review["sourceId"]]
            packet_source_pages = [
                source_page_lookup[(attachment["id"], page)]
                for page in review["reviewedSourcePages"]
            ]
            lines.extend(
                [
                    f"### {review['highlightId']} - {review['sourceId']}",
                    "",
                    f"- **Use:** {clean_text(review['use'])}; source role `{clean_text(review['role'])}`.",
                    f"- **Source:** `{clean_text(source.get('filename'))}`, cited PDF p. {source.get('page')}; reviewed source pp. {', '.join(str(page) for page in review['reviewedSourcePages'])}.",
                    f"- **Packet location:** divider p. {divider_by_attachment[attachment['id']]}; original source content on packet pp. {', '.join(str(page) for page in packet_source_pages)}.",
                    f"- **Why indexed:** {clean_text(review['relevance'])}",
                ]
            )
            if review["limitation"]:
                lines.append(f"- **Limit / verification note:** {clean_text(review['limitation'])}")
            lines.extend(["", "**Exact extracted passage (verify against original):**", ""])
            excerpt_lines = clean_text(review["excerpt"]).splitlines() or [""]
            lines.extend(f"> {line}" for line in excerpt_lines)
            lines.append("")

    lines.extend(
        [
            "## Contact-only source rows available on request",
            "",
            clean_text(packet_context["plan"].get("contactPolicy")),
            "",
            "These rows are excluded from candidate-evidence selection to avoid reproducing contact material unnecessarily. F0144 page 1 is separately included only for reporter/transcript identity context.",
            "",
        ]
    )
    for source_id in packet_context["excludedContactSourceIds"]:
        source = sources[source_id]
        lines.append(
            f"- `{source_id}` - `{clean_text(source.get('filename'))}`, PDF p. {source.get('page')} (contact-directory source; available from the app-owned corpus)."
        )
    lines.extend(
        [
            "",
            "## Integrity and handling",
            "",
            f"- Packet: `{packet_path.name}`; {packet_result['pageCount']} packet pages ({packet_result['dividerPageCount']} dividers and {packet_result['sourcePageCount']} source pages).",
            f"- Packet builder: shared Arcane PdfSourcePacket {PACKET_BUILDER_VERSION}; source-page selection remains Investigator-specific.",
            "- The companion machine index maps every packet page to its attachment, callout/source IDs, original PDF/page, and full-original SHA-256.",
            "- The report manifest hashes this guide, packet, machine index, referral input, and every distinct source PDF used.",
            "- Use approved agency evidence-handling channels. Obtain certified/native records and preserve original devices/media rather than treating this derivative packet as chain-of-custody evidence.",
            "",
        ]
    )
    return "\n".join(lines)


def build_packet_index(
    referral: dict[str, Any],
    packet_context: dict[str, Any],
    packet_result: dict[str, Any],
    packet_path: Path,
    case_root: Path,
    generated_at: str,
) -> dict[str, Any]:
    source_input_by_path = {item["path"]: item for item in packet_context["sourceInputs"]}
    attachment_by_id = {item["id"]: item for item in packet_context["attachments"]}
    page_records: list[dict[str, Any]] = []
    divider_by_attachment: dict[str, int] = {}
    source_page_lookup: dict[tuple[str, int], int] = {}
    for raw_page in packet_result["pages"]:
        attachment = attachment_by_id[raw_page["attachmentId"]]
        input_record = source_input_by_path[attachment["pdfPath"]]
        original_page = raw_page["originalPage"]
        relevant_reviews = attachment["reviews"] if original_page is None else [
            review for review in attachment["reviews"] if original_page in review["reviewedSourcePages"]
        ]
        record = {
            "packetPage": raw_page["packetPage"],
            "kind": raw_page["kind"],
            "attachmentId": attachment["id"],
            "highlightIds": [review["highlightId"] for review in relevant_reviews],
            "sourceIds": [review["sourceId"] for review in relevant_reviews],
            "originalPdf": attachment["filename"],
            "originalPdfPath": attachment["pdfPath"],
            "originalPage": original_page,
            "originalPages": attachment["sourcePages"] if original_page is None else [original_page],
            "inputByteLength": input_record["byteLength"],
            "inputSha256": input_record["sha256"],
        }
        page_records.append(record)
        if raw_page["kind"] == "divider":
            divider_by_attachment[attachment["id"]] = raw_page["packetPage"]
        else:
            source_page_lookup[(attachment["id"], original_page)] = raw_page["packetPage"]

    highlight_records: list[dict[str, Any]] = []
    attachment_records: list[dict[str, Any]] = []
    for attachment in packet_context["attachments"]:
        attachment_records.append(
            {
                "id": attachment["id"],
                "title": attachment["title"],
                "recordId": attachment["recordId"],
                "candidateIds": attachment["candidateIds"],
                "purpose": attachment["purpose"],
                "sourceIds": attachment["sourceIds"],
                "sourcePages": attachment["sourcePages"],
                "dividerPacketPage": divider_by_attachment[attachment["id"]],
                "sourcePacketPages": [
                    source_page_lookup[(attachment["id"], page)] for page in attachment["sourcePages"]
                ],
            }
        )
        for review in attachment["reviews"]:
            highlight_records.append(
                {
                    **review,
                    "mode": "guide-only-callout",
                    "attachmentId": attachment["id"],
                    "dividerPacketPage": divider_by_attachment[attachment["id"]],
                    "sourcePacketPages": [
                        source_page_lookup[(attachment["id"], page)]
                        for page in review["reviewedSourcePages"]
                    ],
                }
            )

    return {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "caseId": clean_text(referral.get("case", {}).get("id")),
        "relatedCase": clean_text(referral.get("case", {}).get("relatedCase")),
        "notice": PRIVATE_PACKET_NOTICE,
        "selection": {
            "status": packet_context["plan"].get("status"),
            "policy": packet_context["plan"].get("selectionPolicy"),
            "highlightMode": packet_context["plan"].get("highlightMode"),
            "highlightPolicy": packet_context["plan"].get("highlightPolicy"),
            "candidateIds": [item.get("id") for item in sorted_candidates(referral)],
            "candidateSourceIds": packet_context["candidateSourceIds"],
            "contextSourceIds": packet_context["contextSourceIds"],
            "contactOnlySourceIdsExcludedFromEvidenceSelection": packet_context["excludedContactSourceIds"],
            "sourcePageCount": packet_context["sourcePageCount"],
        },
        "packet": {
            "path": packet_path.relative_to(case_root).as_posix(),
            "byteLength": packet_path.stat().st_size,
            "sha256": sha256_file(packet_path),
            "pageCount": packet_result["pageCount"],
            "dividerPageCount": packet_result["dividerPageCount"],
            "sourcePageCount": packet_result["sourcePageCount"],
            "sourceContentMarkup": "none",
            "activePdfFeatures": "removed-by-fresh-page-assembly",
        },
        "sourceInputs": packet_context["sourceInputs"],
        "attachments": attachment_records,
        "highlights": highlight_records,
        "pages": page_records,
    }


def build_markdown(referral: dict[str, Any], sources: dict[str, dict[str, Any]], generated_at: str) -> str:
    case = referral["case"]
    theory = referral["theory"]
    candidates = sorted_candidates(referral)
    requests = {item.get("id"): item for item in referral.get("requests", [])}
    motives = {item.get("candidateId"): item for item in referral.get("motives", [])}
    criminal = referral.get("reliefTracks", {}).get("criminalReferral", {})
    family = referral.get("reliefTracks", {}).get("familyCourt", {})
    lines: list[str] = []

    lines.extend(
        [
            "# Police / DA Action Report",
            "",
            f"**Case:** {clean_text(case.get('id'))}  ",
            f"**Related case:** {clean_text(case.get('relatedCase')) or 'None listed'}  ",
            f"**Court:** {clean_text(case.get('court'))}  ",
            f"**Prepared for:** {', '.join(clean_text(item) for item in case.get('preparedFor', []))}  ",
            f"**Generated:** {generated_at}  ",
            f"**Venue screen:** {clean_text(case.get('venue'))}",
            "",
            "> **Charging posture:** This is a source-indexed investigative referral, not a finding of guilt. No candidate is represented as charge-ready. Police and prosecutors retain complete intake, investigative, and charging discretion.",
            "",
            "## Contact and custodian directory",
            "",
            "Verify every contact before submission or outreach. A blank or verification warning is an investigative gap, not a verified address.",
            "",
            "| Role | Person / organization | Contact | Filed source |",
            "|---|---|---|---|",
        ]
    )
    for contact in referral.get("contacts", []):
        lines.append(
            "| "
            + " | ".join(
                [
                    md_escape(contact.get("role")),
                    md_escape(contact.get("name")),
                    md_escape(contact_details(contact)),
                    md_escape(citations(contact.get("sourceIds", []), sources)),
                ]
            )
            + " |"
        )

    lines.extend(
        [
            "",
            "## Requested agency action",
            "",
            clean_text(theory.get("actionRequested")),
            "",
            "## Executive intake theory",
            "",
            clean_text(theory.get("executiveSummary")),
            "",
            f"**Purpose:** {clean_text(case.get('purpose'))}",
            "",
            "## Authority boundary",
            "",
            f"**Police / prosecutor track:** {clean_text(criminal.get('requestedOutcome'))}",
            "",
            f"**Family-court track:** {clean_text(family.get('requestedOutcome'))}",
            "",
            f"**Boundary:** {clean_text(family.get('warning'))}",
            "",
            "## Ranked intake decision screen",
            "",
            "| Rank / actor | Potential offense | Victim or target | Event / venue | Evidence posture | Decisive blocker | Immediate action |",
            "|---|---|---|---|---|---|---|",
        ]
    )
    for candidate in candidates:
        immediate = requests.get(candidate.get("immediateActionId"), {})
        lines.append(
            f"| #{candidate.get('rank', '')} {md_escape(candidate.get('id'))} / {md_escape(candidate.get('actor'))} | "
            f"{md_escape(candidate.get('offenseTheory'))} | {md_escape(candidate.get('victimTarget'))} | "
            f"{md_escape(candidate.get('eventVenue'))} | {md_escape(candidate.get('evidencePosture'))} | "
            f"{md_escape(candidate.get('principalBlocker'))} | {md_escape(candidate.get('immediateActionId'))}: {md_escape(immediate.get('action'))} |"
        )

    for candidate in candidates:
        candidate_id = candidate.get("id", "")
        lines.extend(
            [
                "",
                f"## {candidate.get('rank', '')}. {candidate_id} - {clean_text(candidate.get('title'))}",
                "",
                f"**Alleged actor:** {clean_text(candidate.get('actor'))} ({clean_text(candidate.get('side'))})  ",
                f"**Potential offense:** {clean_text(candidate.get('offenseTheory'))}  ",
                f"**Victim / target:** {clean_text(candidate.get('victimTarget'))}  ",
                f"**Event / venue:** {clean_text(candidate.get('eventVenue'))}  ",
                f"**Current screen:** {clean_text(candidate.get('status'))}  ",
                f"**Readiness:** {clean_text(candidate.get('readiness'))}  ",
                f"**Evidence posture:** {clean_text(candidate.get('evidencePosture'))}  ",
                f"**Decisive blocker:** {clean_text(candidate.get('principalBlocker'))}  ",
                f"**Rank basis:** {clean_text(candidate.get('rankBasis'))}",
                "",
                f"**Assessment.** {clean_text(candidate.get('assessment'))}",
                "",
                f"**Why it may matter.** {clean_text(candidate.get('materiality'))}",
                "",
                "### Legal screens",
                "",
            ]
        )
        for authority in candidate.get("authority", []):
            lines.append(f"- [{clean_text(authority.get('label'))}]({clean_text(authority.get('url'))}) (screened {clean_text(authority.get('asOf'))})")

        lines.extend(
            [
                "",
                "### Element / evidence matrix",
                "",
                "| Status | Proposition to prove | Current source-based fact | Exact source | Missing proof / next step |",
                "|---|---|---|---|---|",
            ]
        )
        for element in candidate.get("elements", []):
            lines.append(
                "| "
                + " | ".join(
                    [
                        md_escape(element.get("status")),
                        md_escape(element.get("proposition")),
                        md_escape(element.get("fact")),
                        md_escape(citations(element.get("sourceIds", []), sources)),
                        md_escape(element.get("gap") or "No additional gap stated"),
                    ]
                )
                + " |"
            )

        lines.extend(["", "### Source excerpts", ""])
        displayed: set[str] = set()
        for role, source_ids in (
            ("Support", candidate.get("sourceIds", [])),
            ("Contrary / limitation", candidate.get("contrarySourceIds", [])),
        ):
            for source_id in source_ids:
                if source_id in displayed or source_id not in sources:
                    continue
                displayed.add(source_id)
                source = sources[source_id]
                lines.extend(
                    [
                        f"- **{role} - {source_id}:** {clean_text(exact_citation(source))}",
                        f"  - Extracted passage: \"{clean_text(clipped_excerpt(source))}\"",
                    ]
                )
                if source.get("note"):
                    lines.append(f"  - Source limitation: {clean_text(source.get('note'))}")

        lines.extend(["", "### Defenses and innocent explanations", ""])
        for defense in candidate.get("defenses", []):
            lines.append(f"- {clean_text(defense)}")
        lines.extend(["", "### Blocking gaps", ""])
        for gap in candidate.get("blockingGaps", []):
            lines.append(f"- {clean_text(gap)}")
        lines.extend(["", "### Requested investigative steps", ""])
        for action_id in candidate.get("actionIds", []):
            action = requests.get(action_id)
            if not action:
                lines.append(f"- {action_id}: unresolved request reference")
                continue
            lines.append(
                f"- **{action_id} / {clean_text(action.get('priority')).upper()}:** {clean_text(action.get('action'))} "
                f"Target: {clean_text(action.get('target'))}."
            )
        motive = motives.get(candidate_id)
        if motive:
            lines.extend(
                [
                    "",
                    "### Motive hypothesis - not proof",
                    "",
                    f"Trigger: {clean_text(motive.get('trigger'))}. Possible incentive: {clean_text(motive.get('incentive'))}. "
                    f"Possible benefit: {clean_text(motive.get('anticipatedBenefit'))}. Contrary explanation: {clean_text(motive.get('contrary'))}",
                ]
            )

    lines.extend(
        [
            "",
            "## Critical chronology",
            "",
            "Event date and filing date are kept separate. An unknown event date is not backfilled from a later filing.",
            "",
            "| Date | Filing date | Classification | Event | Candidate | Source |",
            "|---|---|---|---|---|---|",
        ]
    )
    for event in sorted(referral.get("chronology", []), key=lambda item: (item.get("date") is None, item.get("date") or "9999-99-99", item.get("id", ""))):
        lines.append(
            "| "
            + " | ".join(
                [
                    md_escape(event.get("date") or "Unknown"),
                    md_escape(event.get("filedDate") or "Unknown"),
                    md_escape(event.get("classification")),
                    md_escape(event.get("title")),
                    md_escape(", ".join(event.get("candidateIds", []))),
                    md_escape(citations(event.get("sourceIds", []), sources)),
                ]
            )
            + " |"
        )

    lines.extend(["", "## Agency action queue", ""])
    priority_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    for action in sorted(referral.get("requests", []), key=lambda item: (priority_order.get(item.get("priority"), 9), item.get("id", ""))):
        lines.append(
            f"- **{clean_text(action.get('id'))} / {clean_text(action.get('priority')).upper()} / {clean_text(action.get('status'))}:** "
            f"{clean_text(action.get('action'))} Target: {clean_text(action.get('target'))}. Candidates: {', '.join(action.get('candidateIds', []))}."
        )

    criminal = referral.get("reliefTracks", {}).get("criminalReferral", {})
    family = referral.get("reliefTracks", {}).get("familyCourt", {})
    lines.extend(
        [
            "",
            "## Criminal referral and family-court remedies are separate",
            "",
            f"**Criminal referral owner:** {clean_text(criminal.get('owner'))}. {clean_text(criminal.get('requestedOutcome'))}",
            "",
            f"**Family-court owner:** {clean_text(family.get('owner'))}. {clean_text(family.get('requestedOutcome'))}",
            "",
            f"**Boundary:** {clean_text(family.get('warning'))}",
            "",
            "## Evidence integrity and submission notes",
            "",
            "- The report is derivative work product. The cited filed PDFs, native media, original devices, provider records, and certified court records remain the evidence.",
            "- The source index records exact source filenames, PDF pages, Markdown line ranges, roles, and extracted passages.",
            "- Unicode dash characters are normalized to ASCII hyphens for report compatibility; no substantive wording is intentionally changed.",
            "- Preserve contrary evidence, privilege issues, authentication limits, venue, limitations, and innocent explanations with each candidate.",
            "- Verify contact details before outreach and use approved agency evidence-handling channels.",
            "",
            f"Prepared from referral schema version {clean_text(referral.get('schemaVersion'))}; generator version {GENERATOR_VERSION}.",
            "",
        ]
    )
    return "\n".join(lines)


def register_fonts() -> tuple[str, str]:
    candidates = [
        (Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "arial.ttf", Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "arialbd.ttf"),
        (Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")),
    ]
    for regular_path, bold_path in candidates:
        if regular_path.is_file() and bold_path.is_file():
            pdfmetrics.registerFont(TTFont("ArcaneReport", str(regular_path)))
            pdfmetrics.registerFont(TTFont("ArcaneReport-Bold", str(bold_path)))
            return "ArcaneReport", "ArcaneReport-Bold"
    return "Helvetica", "Helvetica-Bold"


class NumberedCanvas(canvas.Canvas):
    """Canvas that adds the global case header and Page X of Y footer."""

    def __init__(self, *args: Any, case_id: str, related_case: str = "", **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._saved_page_states: list[dict[str, Any]] = []
        self._case_id = clean_text(case_id)
        self._related_case = clean_text(related_case)

    def showPage(self) -> None:  # noqa: N802 - ReportLab API name
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self) -> None:
        page_count = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self._draw_header_footer(page_count)
            super().showPage()
        super().save()

    def _draw_header_footer(self, page_count: int) -> None:
        width, height = letter
        self.saveState()
        self.setStrokeColor(colors.HexColor("#AAB4C3"))
        self.setLineWidth(0.5)
        self.line(0.55 * inch, height - 0.47 * inch, width - 0.55 * inch, height - 0.47 * inch)
        self.line(0.55 * inch, 0.45 * inch, width - 0.55 * inch, 0.45 * inch)
        self.setFont("Helvetica-Bold", 7.2)
        self.setFillColor(colors.HexColor("#263547"))
        self.drawString(0.55 * inch, height - 0.36 * inch, "POLICE / DA ACTION REPORT")
        self.setFont("Helvetica", 7.2)
        case_label = f"CASE {self._case_id}"
        if self._related_case:
            case_label += f" | RELATED {self._related_case}"
        self.drawRightString(width - 0.55 * inch, height - 0.36 * inch, case_label)
        self.setFont("Helvetica", 7.2)
        self.setFillColor(colors.HexColor("#526273"))
        self.drawString(
            0.55 * inch,
            0.29 * inch,
            f"PRIVATE-PARTY REFERRAL - UNVERIFIED - NOT AN AGENCY RECORD | Case {self._case_id}",
        )
        self.drawRightString(width - 0.55 * inch, 0.29 * inch, f"Page {self._pageNumber} of {page_count}")
        self.restoreState()


def make_pdf_styles(font_name: str, bold_name: str) -> dict[str, ParagraphStyle]:
    sample = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "ReportTitle",
            parent=sample["Title"],
            fontName=bold_name,
            fontSize=21,
            leading=24,
            textColor=colors.HexColor("#17324D"),
            alignment=TA_LEFT,
            spaceAfter=8,
        ),
        "subtitle": ParagraphStyle(
            "ReportSubtitle",
            parent=sample["Normal"],
            fontName=font_name,
            fontSize=8.5,
            leading=11,
            textColor=colors.HexColor("#526273"),
            spaceAfter=5,
        ),
        "h1": ParagraphStyle(
            "ReportH1",
            parent=sample["Heading1"],
            fontName=bold_name,
            fontSize=14,
            leading=17,
            textColor=colors.HexColor("#17324D"),
            spaceBefore=10,
            spaceAfter=6,
            keepWithNext=True,
        ),
        "h2": ParagraphStyle(
            "ReportH2",
            parent=sample["Heading2"],
            fontName=bold_name,
            fontSize=10.5,
            leading=13,
            textColor=colors.HexColor("#1B5961"),
            spaceBefore=8,
            spaceAfter=4,
            keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "ReportBody",
            parent=sample["BodyText"],
            fontName=font_name,
            fontSize=8.4,
            leading=11.2,
            textColor=colors.HexColor("#19232D"),
            spaceAfter=5,
        ),
        "small": ParagraphStyle(
            "ReportSmall",
            parent=sample["BodyText"],
            fontName=font_name,
            fontSize=7,
            leading=9,
            textColor=colors.HexColor("#344554"),
            spaceAfter=2,
        ),
        "tiny": ParagraphStyle(
            "ReportTiny",
            parent=sample["BodyText"],
            fontName=font_name,
            fontSize=6.1,
            leading=7.7,
            textColor=colors.HexColor("#24313D"),
            spaceAfter=1,
        ),
        "callout": ParagraphStyle(
            "ReportCallout",
            parent=sample["BodyText"],
            fontName=bold_name,
            fontSize=8.5,
            leading=11.2,
            textColor=colors.HexColor("#5A3B00"),
            borderColor=colors.HexColor("#D9AD4E"),
            borderWidth=0.8,
            borderPadding=7,
            backColor=colors.HexColor("#FFF8E6"),
            spaceAfter=8,
        ),
        "quote": ParagraphStyle(
            "ReportQuote",
            parent=sample["BodyText"],
            fontName=font_name,
            fontSize=7.2,
            leading=9.5,
            leftIndent=8,
            rightIndent=4,
            borderColor=colors.HexColor("#A9BBC7"),
            borderWidth=0.5,
            borderPadding=5,
            backColor=colors.HexColor("#F4F7F8"),
            textColor=colors.HexColor("#263744"),
            spaceAfter=5,
        ),
        "table_header": ParagraphStyle(
            "ReportTableHeader",
            parent=sample["BodyText"],
            fontName=bold_name,
            fontSize=6.6,
            leading=8,
            textColor=colors.white,
            alignment=TA_LEFT,
        ),
    }


def paragraph(value: Any, style: ParagraphStyle) -> Paragraph:
    return Paragraph(xml(value) or "-", style)


def rich_paragraph(markup: str, style: ParagraphStyle) -> Paragraph:
    """Render trusted markup assembled only from xml()-escaped source values."""
    return Paragraph(markup or "-", style)


def heading(value: Any, styles: dict[str, ParagraphStyle], level: int = 1) -> Paragraph:
    return paragraph(value, styles["h1" if level == 1 else "h2"])


def bullet_paragraph(value: Any, styles: dict[str, ParagraphStyle], *, bold_prefix: str = "") -> Paragraph:
    prefix = f"<b>{xml(bold_prefix)}</b> " if bold_prefix else ""
    return Paragraph(f"<bullet>&#8226;</bullet>{prefix}{xml(value)}", ParagraphStyle("BulletCopy", parent=styles["body"], leftIndent=13, firstLineIndent=-7, bulletIndent=2, spaceAfter=3))


def report_table(
    rows: list[list[Any]],
    widths: list[float],
    styles: dict[str, ParagraphStyle],
    *,
    repeat_header: bool = True,
    font_size: float = 6.5,
) -> LongTable:
    converted: list[list[Paragraph]] = []
    for row_index, row in enumerate(rows):
        style = styles["table_header"] if row_index == 0 else ParagraphStyle(
            f"Cell-{font_size}", parent=styles["tiny"], fontSize=font_size, leading=font_size + 1.8
        )
        converted.append([paragraph(cell, style) for cell in row])
    table = LongTable(converted, colWidths=widths, repeatRows=1 if repeat_header else 0, hAlign="LEFT")
    commands: list[tuple[Any, ...]] = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#263E55")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#B8C3CC")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    for row_index in range(1, len(rows)):
        if row_index % 2 == 0:
            commands.append(("BACKGROUND", (0, row_index), (-1, row_index), colors.HexColor("#F2F5F7")))
    table.setStyle(TableStyle(commands))
    return table


def build_pdf_story(referral: dict[str, Any], sources: dict[str, dict[str, Any]], generated_at: str, styles: dict[str, ParagraphStyle]) -> list[Any]:
    case = referral["case"]
    theory = referral["theory"]
    candidates = sorted_candidates(referral)
    requests = {item.get("id"): item for item in referral.get("requests", [])}
    motives = {item.get("candidateId"): item for item in referral.get("motives", [])}
    criminal = referral.get("reliefTracks", {}).get("criminalReferral", {})
    family = referral.get("reliefTracks", {}).get("familyCourt", {})
    story: list[Any] = []

    story.extend(
        [
            paragraph("Police / DA Action Report", styles["title"]),
            paragraph(
                f"Case {case.get('id')} | Related {case.get('relatedCase') or 'none listed'} | Generated {generated_at}",
                styles["subtitle"],
            ),
            rich_paragraph(
                f"Prepared for: {', '.join(xml(item) for item in case.get('preparedFor', []))}<br/>"
                f"Court: {xml(case.get('court'))}<br/>Venue screen: {xml(case.get('venue'))}<br/>"
                f"Submission posture: private-party referral; agency report number and receiving officer not yet assigned",
                styles["body"],
            ),
            paragraph(
                "CHARGING POSTURE: This is a source-indexed investigative referral, not a finding of guilt. "
                "No candidate is represented as charge-ready. Police and prosecutors retain complete intake, "
                "investigative, and charging discretion.",
                styles["callout"],
            ),
            heading("Executive intake theory", styles, 2),
            paragraph(theory.get("executiveSummary"), styles["body"]),
            heading("Requested agency action", styles, 2),
            paragraph(theory.get("actionRequested"), styles["body"]),
            paragraph(
                f"AUTHORITY BOUNDARY: Police / prosecutor track - {clean_text(criminal.get('requestedOutcome'))} "
                f"Family-court track - {clean_text(family.get('requestedOutcome'))} "
                f"A criminal referral does not itself alter custody, visitation, sanctions, parental rights, or any family-court order.",
                styles["callout"],
            ),
            heading("Primary contacts", styles, 2),
            paragraph(
                "Verify every contact before submission or outreach. Additional witnesses and custodians appear after the candidate screens.",
                styles["small"],
            ),
        ]
    )
    contact_rows: list[list[Any]] = [["Role", "Person / organization", "Contact", "Filed source"]]
    for contact in primary_contacts(referral):
        contact_rows.append(
            [
                contact.get("role"),
                contact.get("name"),
                contact_details(contact),
                citations(contact.get("sourceIds", []), sources, short=True),
            ]
        )
    story.extend(
        [
            report_table(contact_rows, [1.22 * inch, 1.25 * inch, 2.45 * inch, 1.48 * inch], styles, font_size=6.2),
            paragraph(f"Purpose: {clean_text(case.get('purpose'))}", styles["small"]),
            heading("Ranked intake decision screen", styles),
        ]
    )
    overview_rows: list[list[Any]] = [["ID / actor", "Potential offense / target", "Event / venue", "Evidence posture", "Decisive blocker / first action"]]
    for candidate in candidates:
        immediate = requests.get(candidate.get("immediateActionId"), {})
        overview_rows.append(
            [
                f"#{candidate.get('rank')} {clean_text(candidate.get('id'))}\n{clean_text(candidate.get('actor'))}\n{clean_text(candidate.get('investigativeUrgency')).upper()} urgency",
                f"{clean_text(candidate.get('offenseTheory'))}\nTARGET: {clean_text(candidate.get('victimTarget'))}",
                candidate.get("eventVenue"),
                candidate.get("evidencePosture"),
                f"{clean_text(candidate.get('principalBlocker'))}\nFIRST: {clean_text(candidate.get('immediateActionId'))} - {clean_text(immediate.get('action'))}",
            ]
        )
    story.append(report_table(overview_rows, [0.8 * inch, 1.85 * inch, 1.35 * inch, 1.55 * inch, 1.85 * inch], styles, font_size=5.65))

    for candidate in candidates:
        candidate_id = candidate.get("id", "")
        story.extend(
            [
                PageBreak(),
                paragraph(
                    f"{candidate.get('rank', '')}. {candidate_id} - {clean_text(candidate.get('title'))}",
                    styles["title"],
                ),
                rich_paragraph(
                    f"Alleged actor: <b>{xml(candidate.get('actor'))}</b> ({xml(candidate.get('side'))}) | "
                    f"Current screen: <b>{xml(candidate.get('status'))}</b> | {xml(candidate.get('investigativeUrgency'))} urgency<br/>"
                    f"Potential offense: {xml(candidate.get('offenseTheory'))}<br/>"
                    f"Victim / target: {xml(candidate.get('victimTarget'))}<br/>"
                    f"Event / venue: {xml(candidate.get('eventVenue'))}<br/>"
                    f"Readiness: {xml(candidate.get('readiness'))}",
                    styles["body"],
                ),
                paragraph(f"Evidence posture: {clean_text(candidate.get('evidencePosture'))}", styles["small"]),
                paragraph(f"Decisive blocker: {clean_text(candidate.get('principalBlocker'))}", styles["small"]),
                paragraph(f"Rank basis: {clean_text(candidate.get('rankBasis'))}", styles["small"]),
                heading("Assessment and significance", styles, 2),
                paragraph(candidate.get("assessment"), styles["body"]),
                paragraph(f"Why it may matter: {clean_text(candidate.get('materiality'))}", styles["body"]),
                heading("Legal screens", styles, 2),
            ]
        )
        for authority in candidate.get("authority", []):
            story.append(
                bullet_paragraph(
                    f"{clean_text(authority.get('label'))} (screened {clean_text(authority.get('asOf'))}) - {clean_text(authority.get('url'))}",
                    styles,
                )
            )
        story.append(heading("Element / evidence matrix", styles, 2))
        element_rows: list[list[Any]] = [["Status", "Proposition to prove", "Current source-based fact and source", "Missing proof / next step"]]
        for element in candidate.get("elements", []):
            source_text = citations(element.get("sourceIds", []), sources, short=True)
            element_rows.append(
                [
                    element.get("status"),
                    element.get("proposition"),
                    f"{clean_text(element.get('fact'))}\nSOURCE: {source_text}",
                    element.get("gap") or "No additional gap stated",
                ]
            )
        story.append(report_table(element_rows, [0.65 * inch, 1.55 * inch, 2.4 * inch, 1.8 * inch], styles, font_size=6.15))

        story.append(heading("Source excerpts", styles, 2))
        displayed: set[str] = set()
        for role, source_ids in (
            ("SUPPORT", candidate.get("sourceIds", [])),
            ("CONTRARY / LIMITATION", candidate.get("contrarySourceIds", [])),
        ):
            for source_id in source_ids:
                if source_id in displayed or source_id not in sources:
                    continue
                displayed.add(source_id)
                source = sources[source_id]
                story.append(
                    rich_paragraph(
                        f"<b>{xml(role)} - {xml(source_id)}</b><br/>{xml(exact_citation(source))}",
                        styles["small"],
                    )
                )
                story.append(paragraph(f'Extracted passage: "{clipped_excerpt(source, 620)}"', styles["quote"]))
                if source.get("note"):
                    story.append(paragraph(f"Source limitation: {clean_text(source.get('note'))}", styles["small"]))

        story.append(heading("Defenses and innocent explanations", styles, 2))
        for defense in candidate.get("defenses", []):
            story.append(bullet_paragraph(defense, styles))
        story.append(heading("Blocking gaps", styles, 2))
        for gap in candidate.get("blockingGaps", []):
            story.append(bullet_paragraph(gap, styles))
        story.append(heading("Requested investigative steps", styles, 2))
        for action_id in candidate.get("actionIds", []):
            action = requests.get(action_id)
            if not action:
                story.append(bullet_paragraph("Unresolved request reference", styles, bold_prefix=action_id))
                continue
            story.append(
                bullet_paragraph(
                    f"{clean_text(action.get('action'))} Target: {clean_text(action.get('target'))}.",
                    styles,
                    bold_prefix=f"{action_id} / {clean_text(action.get('priority')).upper()}:",
                )
            )
        motive = motives.get(candidate_id)
        if motive:
            story.extend(
                [
                    heading("Motive hypothesis - not proof", styles, 2),
                    paragraph(
                        f"Trigger: {clean_text(motive.get('trigger'))}. Possible incentive: {clean_text(motive.get('incentive'))}. "
                        f"Possible benefit: {clean_text(motive.get('anticipatedBenefit'))}. Contrary explanation: {clean_text(motive.get('contrary'))}",
                        styles["body"],
                    ),
                ]
            )

    story.extend(
        [
            PageBreak(),
            heading("Critical chronology", styles),
            paragraph(
                "Event date and filing date are kept separate. An unknown event date is not backfilled from a later filing.",
                styles["small"],
            ),
        ]
    )
    timeline_rows: list[list[Any]] = [["Event date", "Filed", "Class", "Event", "Candidate / source"]]
    for event in sorted(referral.get("chronology", []), key=lambda item: (item.get("date") is None, item.get("date") or "9999-99-99", item.get("id", ""))):
        timeline_rows.append(
            [
                event.get("date") or "Unknown",
                event.get("filedDate") or "Unknown",
                event.get("classification"),
                event.get("title"),
                f"{', '.join(event.get('candidateIds', []))}\n{citations(event.get('sourceIds', []), sources, short=True)}",
            ]
        )
    story.append(report_table(timeline_rows, [0.68 * inch, 0.68 * inch, 0.83 * inch, 2.72 * inch, 1.49 * inch], styles, font_size=6.15))

    extra_contacts = additional_contacts(referral)
    if extra_contacts:
        story.append(heading("Additional witnesses and custodians", styles))
        story.append(paragraph("These contacts are later investigative leads. Verify each value before outreach.", styles["small"]))
        extra_rows: list[list[Any]] = [["Role", "Person / organization", "Contact", "Filed source"]]
        for contact in extra_contacts:
            extra_rows.append(
                [
                    contact.get("role"),
                    contact.get("name"),
                    contact_details(contact),
                    citations(contact.get("sourceIds", []), sources, short=True),
                ]
            )
        story.append(report_table(extra_rows, [1.22 * inch, 1.25 * inch, 2.45 * inch, 1.48 * inch], styles, font_size=6.2))

    story.append(heading("Agency action queue", styles))
    priority_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    action_rows: list[list[Any]] = [["ID / priority", "Candidates", "Action", "Target / status"]]
    for action in sorted(referral.get("requests", []), key=lambda item: (priority_order.get(item.get("priority"), 9), item.get("id", ""))):
        action_rows.append(
            [
                f"{clean_text(action.get('id'))}\n{clean_text(action.get('priority')).upper()}",
                ", ".join(action.get("candidateIds", [])),
                action.get("action"),
                f"{clean_text(action.get('target'))}\nStatus: {clean_text(action.get('status'))}",
            ]
        )
    story.append(report_table(action_rows, [0.75 * inch, 0.68 * inch, 3.15 * inch, 1.82 * inch], styles, font_size=6.25))

    story.extend(
        [
            heading("Criminal referral and family-court remedies are separate", styles),
            rich_paragraph(
                f"<b>Criminal referral owner:</b> {xml(criminal.get('owner'))}. {xml(criminal.get('requestedOutcome'))}",
                styles["body"],
            ),
            rich_paragraph(
                f"<b>Family-court owner:</b> {xml(family.get('owner'))}. {xml(family.get('requestedOutcome'))}<br/>"
                f"<b>Boundary:</b> {xml(family.get('warning'))}",
                styles["callout"],
            ),
            heading("Evidence integrity and submission notes", styles),
            bullet_paragraph(
                "This report is derivative work product. The cited filed PDFs, native media, original devices, provider records, and certified court records remain the evidence.",
                styles,
            ),
            bullet_paragraph(
                "The companion CSV records exact source filenames, PDF pages, Markdown line ranges, roles, and extracted passages.",
                styles,
            ),
            bullet_paragraph(
                "Unicode dash characters are normalized to ASCII hyphens for report compatibility; no substantive wording is intentionally changed.",
                styles,
            ),
            bullet_paragraph(
                "Preserve contrary evidence, privilege issues, authentication limits, venue, limitations, and innocent explanations with each candidate.",
                styles,
            ),
            bullet_paragraph("Verify contact details before outreach and use approved agency evidence-handling channels.", styles),
            Spacer(1, 6),
            paragraph(
                f"Prepared from referral schema version {clean_text(referral.get('schemaVersion'))}; generator version {GENERATOR_VERSION}.",
                styles["small"],
            ),
        ]
    )
    return story


def build_pdf(path: Path, referral: dict[str, Any], sources: dict[str, dict[str, Any]], generated_at: str) -> None:
    font_name, bold_name = register_fonts()
    styles = make_pdf_styles(font_name, bold_name)
    case = referral["case"]
    temporary = path.with_name(f".{path.name}.tmp")
    document = SimpleDocTemplate(
        str(temporary),
        pagesize=letter,
        rightMargin=0.55 * inch,
        leftMargin=0.55 * inch,
        topMargin=0.62 * inch,
        bottomMargin=0.58 * inch,
        title=f"Police / DA Action Report - Case {clean_text(case.get('id'))}",
        author="Arcane Investigator",
        subject="Source-indexed investigative referral for law-enforcement and prosecutor screening",
        keywords=f"case {clean_text(case.get('id'))}, evidence, police referral, district attorney",
    )

    def canvas_factory(*args: Any, **kwargs: Any) -> NumberedCanvas:
        return NumberedCanvas(
            *args,
            case_id=case.get("id", ""),
            related_case=case.get("relatedCase", ""),
            **kwargs,
        )

    document.build(build_pdf_story(referral, sources, generated_at, styles), canvasmaker=canvas_factory)
    os.replace(temporary, path)


def build_manifest(
    *,
    referral_path: Path,
    case_root: Path,
    outputs: list[Path],
    generated_at: str,
    case_id: str,
    source_inputs: list[dict[str, Any]],
) -> dict[str, Any]:
    def relative(path: Path) -> str:
        return path.relative_to(case_root).as_posix()

    return {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "caseId": case_id,
        "generator": {
            "name": "build_police_reports.py",
            "version": GENERATOR_VERSION,
        },
        "hashAlgorithm": "SHA-256",
        "input": {
            "path": relative(referral_path),
            "byteLength": referral_path.stat().st_size,
            "sha256": sha256_file(referral_path),
        },
        "sourceInputs": source_inputs,
        "outputs": [
            {
                "path": relative(path),
                "byteLength": path.stat().st_size,
                "sha256": sha256_file(path),
            }
            for path in outputs
        ],
        "manifestNote": "This manifest hashes the referral input, every distinct source PDF used by the evidence packet, and every generated report/packet artifact. It does not self-hash.",
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build app-owned Police / DA report artifacts.")
    parser.add_argument(
        "--case-root",
        type=Path,
        default=DEFAULT_CASE_ROOT,
        help=f"Case data root (default: {DEFAULT_CASE_ROOT})",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    case_root = args.case_root.resolve()
    referral_path = case_root / "Referral" / "referral-case.json"
    output_root = case_root / "Reports" / "Police"
    output_root.mkdir(parents=True, exist_ok=True)

    referral = read_referral(referral_path)
    sources = source_map(referral)
    require_source_ids(referral, sources)
    case_id = clean_text(referral.get("case", {}).get("id"))
    if not case_id:
        raise SystemExit("Referral case.id is required.")

    generated_at = clean_text(referral.get("generatedAt"))
    try:
        datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SystemExit("Referral generatedAt must be a valid ISO-8601 timestamp.") from exc
    markdown_path = output_root / "Police-DA-Action-Report.md"
    pdf_path = output_root / "Police-DA-Action-Report.pdf"
    source_index_path = output_root / "Police-DA-Source-Index.csv"
    packet_path = output_root / "Police-DA-Evidence-Packet.pdf"
    highlight_guide_path = output_root / "Police-DA-Evidence-Packet-Highlight-Guide.md"
    packet_index_path = output_root / "Police-DA-Evidence-Packet-Index.json"
    manifest_path = output_root / "Police-DA-Report-Manifest.json"

    write_atomic(markdown_path, build_markdown(referral, sources, generated_at) + "\n")
    write_atomic(source_index_path, build_source_index_csv(referral))
    build_pdf(pdf_path, referral, sources, generated_at)
    packet_context = prepare_packet_plan(referral, sources, case_root)
    try:
        packet_result = build_source_packet(
            packet_path,
            packet_context["sharedAttachments"],
            allowed_source_root=case_root,
            allowed_output_root=output_root,
            packet_title=f"Police / DA Evidence Packet - Case {case_id}",
            footer_label=f"Police / DA Evidence Packet | Case {case_id}",
            notice=PRIVATE_PACKET_NOTICE,
            author="Arcane Investigator",
            subject="Private-party source-page packet for law-enforcement and prosecutor screening",
        )
    except PacketBuildError as exc:
        raise SystemExit(f"Evidence packet build failed closed: {exc}") from exc
    write_atomic(
        highlight_guide_path,
        build_packet_highlight_guide(
            referral,
            sources,
            packet_context,
            packet_result,
            packet_path,
            generated_at,
        )
        + "\n",
    )
    packet_index = build_packet_index(
        referral,
        packet_context,
        packet_result,
        packet_path,
        case_root,
        generated_at,
    )
    write_atomic(packet_index_path, json.dumps(packet_index, indent=2, ensure_ascii=False) + "\n")
    manifest = build_manifest(
        referral_path=referral_path,
        case_root=case_root,
        outputs=[
            markdown_path,
            pdf_path,
            source_index_path,
            packet_path,
            highlight_guide_path,
            packet_index_path,
        ],
        generated_at=generated_at,
        case_id=case_id,
        source_inputs=packet_context["sourceInputs"],
    )
    write_atomic(manifest_path, json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")

    print(
        f"Police / DA reports written for case {case_id}: "
        f"{len(referral.get('candidates', []))} candidates, "
        f"{len(referral.get('sources', []))} sources, "
        f"{len(referral.get('requests', []))} actions."
    )
    for path in (
        markdown_path,
        pdf_path,
        source_index_path,
        packet_path,
        highlight_guide_path,
        packet_index_path,
        manifest_path,
    ):
        print(f"- {path.relative_to(case_root).as_posix()} ({path.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
