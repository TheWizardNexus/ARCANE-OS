"""Deterministic, build-time assembly of source-page PDF packets.

The caller owns all domain policy: which files and pages are included, attachment
labels, factual callouts, and footer wording.  This module only validates a
bounded neutral contract, extracts the explicitly allowlisted pages, places each
page inside reserved header/footer bands, removes active PDF features, and
writes a fresh packet plus a machine-readable page inventory.

The operation is local, synchronous, and destructive only to the requested
output path.  It never mutates a source PDF.  Source and output paths must stay
inside caller-supplied roots and may not traverse a symbolic link or junction.
"""

from __future__ import annotations

import copy
import io
import os
import re
from pathlib import Path
from typing import Any, Iterable

try:
    from pypdf import PdfReader, PdfWriter, Transformation
    from pypdf._page import PageObject
    from pypdf.generic import NameObject
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas
except ImportError as exc:  # pragma: no cover - runtime setup failure
    raise RuntimeError(
        "PdfSourcePacket requires pypdf and ReportLab in the build runtime."
    ) from exc


BUILDER_VERSION = "1.0.0"
MAX_ATTACHMENTS = 200
MAX_SOURCE_PAGES = 2_000
MAX_CALLOUTS_PER_ATTACHMENT = 8
MAX_TEXT_LENGTH = 2_400
MAX_CALLOUT_EXCERPT = 900
MAX_CALLOUT_TOTAL = 4_800

_PACKET_WIDTH, _PACKET_HEIGHT = letter
_CONTENT_LEFT = 0.30 * 72
_CONTENT_RIGHT = 0.30 * 72
_CONTENT_BOTTOM = 0.62 * 72
_CONTENT_TOP = 0.62 * 72

_PAGE_ACTIVE_KEYS = (
    "/Annots",
    "/AA",
    "/B",
    "/Dur",
    "/PresSteps",
    "/Trans",
)
_ROOT_ACTIVE_KEYS = (
    "/AA",
    "/AcroForm",
    "/AF",
    "/Collection",
    "/EmbeddedFiles",
    "/JavaScript",
    "/Names",
    "/OpenAction",
    "/PageMode",
    "/Perms",
)
_CONTROL_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class PacketBuildError(ValueError):
    """Raised when an input fails the packet's fail-closed contract."""


def _text(value: Any, label: str, *, required: bool = True, maximum: int = MAX_TEXT_LENGTH) -> str:
    if not isinstance(value, str):
        raise PacketBuildError(f"{label} must be a string.")
    result = value.strip()
    if required and not result:
        raise PacketBuildError(f"{label} is required.")
    if len(result) > maximum:
        raise PacketBuildError(f"{label} exceeds {maximum} characters.")
    if _CONTROL_PATTERN.search(result):
        raise PacketBuildError(f"{label} contains a control character.")
    return result


def _string_list(value: Any, label: str, *, maximum: int = 200) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        raise PacketBuildError(f"{label} must be an array.")
    if len(value) > maximum:
        raise PacketBuildError(f"{label} has too many entries.")
    result = tuple(_text(item, f"{label}[{index}]", maximum=300) for index, item in enumerate(value))
    if len(result) != len(set(result)):
        raise PacketBuildError(f"{label} must not contain duplicates.")
    return result


def _positive_pages(value: Any, label: str) -> tuple[int, ...]:
    if not isinstance(value, (list, tuple)) or not value:
        raise PacketBuildError(f"{label} must be a non-empty array.")
    pages: list[int] = []
    for index, page in enumerate(value):
        if isinstance(page, bool) or not isinstance(page, int) or page < 1:
            raise PacketBuildError(f"{label}[{index}] must be a positive integer.")
        pages.append(page)
    if len(pages) != len(set(pages)):
        raise PacketBuildError(f"{label} must not contain duplicates.")
    if pages != sorted(pages):
        raise PacketBuildError(f"{label} must be sorted in ascending order.")
    return tuple(pages)


def _reject_unknown(record: dict[str, Any], allowed: Iterable[str], label: str) -> None:
    unknown = sorted(set(record) - set(allowed))
    if unknown:
        raise PacketBuildError(f"{label} contains unknown fields: {', '.join(unknown)}")


def _is_link_or_junction(path: Path) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(os.path, "isjunction", None)
    return bool(is_junction and is_junction(path))


def _validate_root(root: Path, label: str) -> Path:
    try:
        resolved = Path(root).resolve(strict=True)
    except OSError as exc:
        raise PacketBuildError(f"{label} does not exist: {root}") from exc
    if not resolved.is_dir():
        raise PacketBuildError(f"{label} must be a directory: {root}")
    if _is_link_or_junction(Path(root)):
        raise PacketBuildError(f"{label} may not be a link or junction: {root}")
    return resolved


def _assert_no_link_components(root: Path, target: Path, label: str) -> None:
    current = target
    while current != root:
        if _is_link_or_junction(current):
            raise PacketBuildError(f"{label} crosses a link or junction: {current}")
        parent = current.parent
        if parent == current:
            raise PacketBuildError(f"{label} escaped its allowed root.")
        current = parent


def _source_path(value: Any, root: Path, label: str) -> Path:
    if not isinstance(value, (str, os.PathLike)):
        raise PacketBuildError(f"{label} must be a filesystem path.")
    supplied = Path(value)
    candidate = supplied if supplied.is_absolute() else root / supplied
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, ValueError) as exc:
        raise PacketBuildError(f"{label} must resolve inside {root}.") from exc
    _assert_no_link_components(root, resolved, label)
    if not resolved.is_file():
        raise PacketBuildError(f"{label} must be a regular file: {resolved}")
    if resolved.suffix.lower() != ".pdf":
        raise PacketBuildError(f"{label} must be a PDF file: {resolved}")
    return resolved


def _output_path(value: Any, root: Path) -> Path:
    if not isinstance(value, (str, os.PathLike)):
        raise PacketBuildError("output_path must be a filesystem path.")
    supplied = Path(value)
    candidate = supplied if supplied.is_absolute() else root / supplied
    try:
        parent = candidate.parent.resolve(strict=True)
        parent.relative_to(root)
    except (OSError, ValueError) as exc:
        raise PacketBuildError(f"output_path must resolve inside {root}.") from exc
    _assert_no_link_components(root, parent, "output_path")
    resolved = parent / candidate.name
    if resolved.suffix.lower() != ".pdf" or resolved.name in {".pdf", ""}:
        raise PacketBuildError("output_path must name a PDF file.")
    if resolved.exists() and _is_link_or_junction(resolved):
        raise PacketBuildError("output_path may not be a link or junction.")
    return resolved


def _normalize_callout(record: Any, attachment_label: str, index: int) -> dict[str, str]:
    label = f"{attachment_label}.callouts[{index}]"
    if not isinstance(record, dict):
        raise PacketBuildError(f"{label} must be an object.")
    _reject_unknown(record, ("id", "source_id", "label", "excerpt", "relevance", "limitation", "mode"), label)
    mode = _text(record.get("mode", "guide-only"), f"{label}.mode", maximum=40)
    if mode not in {"guide-only", "context", "limitation"}:
        raise PacketBuildError(f"{label}.mode is unsupported: {mode}")
    return {
        "id": _text(record.get("id"), f"{label}.id", maximum=80),
        "source_id": _text(record.get("source_id"), f"{label}.source_id", maximum=120),
        "label": _text(record.get("label"), f"{label}.label", maximum=180),
        "excerpt": _text(record.get("excerpt"), f"{label}.excerpt", maximum=MAX_CALLOUT_EXCERPT),
        "relevance": _text(record.get("relevance", ""), f"{label}.relevance", required=False, maximum=500),
        "limitation": _text(record.get("limitation", ""), f"{label}.limitation", required=False, maximum=500),
        "mode": mode,
    }


def _normalize_attachment(record: Any, index: int, source_root: Path) -> dict[str, Any]:
    label = f"attachments[{index}]"
    if not isinstance(record, dict):
        raise PacketBuildError(f"{label} must be an object.")
    _reject_unknown(
        record,
        (
            "id",
            "title",
            "source_path",
            "source_filename",
            "pages",
            "source_ids",
            "candidate_ids",
            "purpose",
            "callouts",
        ),
        label,
    )
    callout_records = record.get("callouts", [])
    if not isinstance(callout_records, (list, tuple)):
        raise PacketBuildError(f"{label}.callouts must be an array.")
    if len(callout_records) > MAX_CALLOUTS_PER_ATTACHMENT:
        raise PacketBuildError(f"{label}.callouts has too many entries.")
    callouts = tuple(_normalize_callout(item, label, offset) for offset, item in enumerate(callout_records))
    if sum(len(item["excerpt"]) for item in callouts) > MAX_CALLOUT_TOTAL:
        raise PacketBuildError(f"{label}.callouts contains too much excerpt text.")
    callout_ids = [item["id"] for item in callouts]
    if len(callout_ids) != len(set(callout_ids)):
        raise PacketBuildError(f"{label}.callouts contains duplicate ids.")
    source_ids = _string_list(record.get("source_ids"), f"{label}.source_ids")
    for callout in callouts:
        if callout["source_id"] not in source_ids:
            raise PacketBuildError(
                f"{label}.callout {callout['id']} references source id outside the attachment."
            )
    filename = _text(record.get("source_filename"), f"{label}.source_filename", maximum=500)
    if Path(filename).name != filename or "/" in filename or "\\" in filename:
        raise PacketBuildError(f"{label}.source_filename must be a display filename, not a path.")
    return {
        "id": _text(record.get("id"), f"{label}.id", maximum=80),
        "title": _text(record.get("title"), f"{label}.title", maximum=500),
        "source_path": _source_path(record.get("source_path"), source_root, f"{label}.source_path"),
        "source_filename": filename,
        "pages": _positive_pages(record.get("pages"), f"{label}.pages"),
        "source_ids": source_ids,
        "candidate_ids": _string_list(record.get("candidate_ids", []), f"{label}.candidate_ids"),
        "purpose": _text(record.get("purpose"), f"{label}.purpose", maximum=1_000),
        "callouts": callouts,
    }


def _font_pair() -> tuple[str, str]:
    candidates = (
        (
            Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "arial.ttf",
            Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "arialbd.ttf",
        ),
        (
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ),
    )
    for regular_path, bold_path in candidates:
        if regular_path.is_file() and bold_path.is_file():
            if "ArcanePacket" not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(TTFont("ArcanePacket", str(regular_path)))
            if "ArcanePacket-Bold" not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(TTFont("ArcanePacket-Bold", str(bold_path)))
            return "ArcanePacket", "ArcanePacket-Bold"
    return "Helvetica", "Helvetica-Bold"


def _wrapped_lines(text: str, font_name: str, font_size: float, width: float) -> list[str]:
    paragraphs = text.replace("\r", "").split("\n")
    lines: list[str] = []
    for paragraph in paragraphs:
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        current = words[0]
        for word in words[1:]:
            candidate = f"{current} {word}"
            if pdfmetrics.stringWidth(candidate, font_name, font_size) <= width:
                current = candidate
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines


def _draw_wrapped(
    page: canvas.Canvas,
    text: str,
    *,
    x: float,
    y: float,
    width: float,
    font_name: str,
    font_size: float,
    leading: float,
    maximum_lines: int | None = None,
) -> float:
    lines = _wrapped_lines(text, font_name, font_size, width)
    if maximum_lines is not None and len(lines) > maximum_lines:
        raise PacketBuildError("Divider content exceeds its configured page space.")
    page.setFont(font_name, font_size)
    for line in lines:
        page.drawString(x, y, line)
        y -= leading
    return y


def _draw_global_footer(
    page: canvas.Canvas,
    *,
    page_number: int,
    page_count: int,
    footer_label: str,
    notice: str,
    font_name: str,
    bold_name: str,
) -> None:
    page.saveState()
    page.setStrokeColor(colors.Color(0.68, 0.72, 0.77))
    page.setLineWidth(0.45)
    page.line(0.32 * 72, 0.50 * 72, _PACKET_WIDTH - 0.32 * 72, 0.50 * 72)
    page.setFillColor(colors.Color(0.29, 0.35, 0.41))
    page.setFont(bold_name, 6.0)
    page.drawString(0.32 * 72, 0.36 * 72, notice)
    page.setFont(font_name, 6.2)
    page.drawString(0.32 * 72, 0.22 * 72, footer_label)
    page.drawRightString(
        _PACKET_WIDTH - 0.32 * 72,
        0.22 * 72,
        f"Page {page_number} of {page_count}",
    )
    page.restoreState()


def _reportlab_page(draw: Any) -> PageObject:
    buffer = io.BytesIO()
    page = canvas.Canvas(buffer, pagesize=letter, invariant=1, pageCompression=1)
    draw(page)
    page.showPage()
    page.save()
    buffer.seek(0)
    rendered = PdfReader(buffer, strict=True)
    return copy.deepcopy(rendered.pages[0])


def _divider_page(
    attachment: dict[str, Any],
    *,
    page_number: int,
    page_count: int,
    packet_title: str,
    footer_label: str,
    notice: str,
    font_name: str,
    bold_name: str,
) -> PageObject:
    def draw(page: canvas.Canvas) -> None:
        page.setTitle(packet_title)
        page.setFillColor(colors.Color(0.09, 0.20, 0.30))
        page.setFont(bold_name, 8.0)
        page.drawString(0.55 * 72, _PACKET_HEIGHT - 0.45 * 72, packet_title.upper())
        page.setStrokeColor(colors.Color(0.64, 0.70, 0.76))
        page.line(0.55 * 72, _PACKET_HEIGHT - 0.53 * 72, _PACKET_WIDTH - 0.55 * 72, _PACKET_HEIGHT - 0.53 * 72)

        page.setFont(bold_name, 18)
        y = _PACKET_HEIGHT - 0.90 * 72
        y = _draw_wrapped(
            page,
            f"{attachment['id']} - {attachment['title']}",
            x=0.60 * 72,
            y=y,
            width=7.30 * 72,
            font_name=bold_name,
            font_size=18,
            leading=21,
            maximum_lines=3,
        )
        y -= 6
        page.setFillColor(colors.Color(0.22, 0.29, 0.35))
        y = _draw_wrapped(
            page,
            f"Source: {attachment['source_filename']}",
            x=0.60 * 72,
            y=y,
            width=7.30 * 72,
            font_name=bold_name,
            font_size=8.0,
            leading=10,
            maximum_lines=4,
        )
        pages = ", ".join(str(value) for value in attachment["pages"])
        candidates = ", ".join(attachment["candidate_ids"]) or "Context only"
        page.setFont(font_name, 7.6)
        page.drawString(0.60 * 72, y - 2, f"Included source pages: {pages}")
        page.drawString(0.60 * 72, y - 14, f"Candidate cross-reference: {candidates}")
        y -= 32
        page.setFillColor(colors.Color(0.12, 0.16, 0.20))
        y = _draw_wrapped(
            page,
            attachment["purpose"],
            x=0.60 * 72,
            y=y,
            width=7.30 * 72,
            font_name=font_name,
            font_size=8.1,
            leading=10.2,
            maximum_lines=8,
        )
        y -= 8

        if attachment["callouts"]:
            page.setFillColor(colors.Color(0.37, 0.26, 0.02))
            page.setFont(bold_name, 8.4)
            page.drawString(0.60 * 72, y, "GUIDE-ONLY FACTUAL CALLOUTS")
            y -= 13
            for callout in attachment["callouts"]:
                label_lines = _wrapped_lines(
                    f"{callout['id']} - {callout['label']}", bold_name, 7.2, 6.96 * 72
                )
                excerpt_lines = _wrapped_lines(
                    f'"{callout["excerpt"]}"', font_name, 7.0, 6.96 * 72
                )
                relevance_lines = _wrapped_lines(
                    f"Why indexed: {callout['relevance']}", font_name, 6.7, 6.96 * 72
                ) if callout["relevance"] else []
                limitation_lines = _wrapped_lines(
                    f"Limit: {callout['limitation']}", font_name, 6.7, 6.96 * 72
                ) if callout["limitation"] else []
                line_count = len(label_lines) + len(excerpt_lines) + len(relevance_lines) + len(limitation_lines)
                height = max(38, line_count * 8.1 + 12)
                if y - height < 0.76 * 72:
                    raise PacketBuildError(
                        f"Divider {attachment['id']} callouts do not fit on one page."
                    )
                page.setFillColor(colors.Color(1.0, 0.97, 0.72))
                page.roundRect(0.56 * 72, y - height + 3, 7.38 * 72, height, 4, fill=1, stroke=0)
                page.setStrokeColor(colors.Color(0.82, 0.69, 0.24))
                page.roundRect(0.56 * 72, y - height + 3, 7.38 * 72, height, 4, fill=0, stroke=1)
                cursor = y - 9
                page.setFillColor(colors.Color(0.20, 0.15, 0.03))
                page.setFont(bold_name, 7.2)
                for line in label_lines:
                    page.drawString(0.77 * 72, cursor, line)
                    cursor -= 8.2
                page.setFont(font_name, 7.0)
                for line in excerpt_lines:
                    page.drawString(0.77 * 72, cursor, line)
                    cursor -= 8.0
                page.setFillColor(colors.Color(0.31, 0.25, 0.10))
                page.setFont(font_name, 6.7)
                for line in (*relevance_lines, *limitation_lines):
                    page.drawString(0.77 * 72, cursor, line)
                    cursor -= 7.7
                y -= height + 7

        page.setFillColor(colors.Color(0.29, 0.35, 0.41))
        page.setFont(bold_name, 7.0)
        page.drawString(
            0.60 * 72,
            0.67 * 72,
            "VERIFY EACH CALLOUT AGAINST THE FOLLOWING ORIGINAL SOURCE PAGE(S).",
        )
        _draw_global_footer(
            page,
            page_number=page_number,
            page_count=page_count,
            footer_label=footer_label,
            notice=notice,
            font_name=font_name,
            bold_name=bold_name,
        )

    return _reportlab_page(draw)


def _source_overlay(
    *,
    source_filename: str,
    source_page: int,
    packet_title: str,
    page_number: int,
    page_count: int,
    footer_label: str,
    notice: str,
    font_name: str,
    bold_name: str,
) -> PageObject:
    def draw(page: canvas.Canvas) -> None:
        page.setTitle(packet_title)
        page.setStrokeColor(colors.Color(0.68, 0.72, 0.77))
        page.setLineWidth(0.45)
        page.line(0.32 * 72, _PACKET_HEIGHT - 0.50 * 72, _PACKET_WIDTH - 0.32 * 72, _PACKET_HEIGHT - 0.50 * 72)
        page.setFillColor(colors.Color(0.28, 0.34, 0.40))
        header = source_filename
        font_size = 6.5
        available = 6.5 * 72
        while len(header) > 24 and pdfmetrics.stringWidth(header, font_name, font_size) > available:
            header = header[:-2].rstrip() + "..."
        page.setFont(font_name, font_size)
        page.drawString(0.32 * 72, _PACKET_HEIGHT - 0.38 * 72, header)
        page.setFont(bold_name, 6.5)
        page.drawRightString(
            _PACKET_WIDTH - 0.32 * 72,
            _PACKET_HEIGHT - 0.38 * 72,
            f"Source page {source_page}",
        )
        _draw_global_footer(
            page,
            page_number=page_number,
            page_count=page_count,
            footer_label=footer_label,
            notice=notice,
            font_name=font_name,
            bold_name=bold_name,
        )

    return _reportlab_page(draw)


def _remove_active_page_features(page: PageObject) -> None:
    for key in _PAGE_ACTIVE_KEYS:
        name = NameObject(key)
        if name in page:
            del page[name]


def _fresh_source_page(source: PageObject, overlay: PageObject) -> PageObject:
    page = copy.deepcopy(source)
    _remove_active_page_features(page)
    try:
        page.transfer_rotation_to_content()
    except Exception as exc:  # pypdf raises several parse/content exceptions
        raise PacketBuildError("A source page rotation could not be normalized.") from exc
    crop = page.cropbox
    source_width = float(crop.right) - float(crop.left)
    source_height = float(crop.top) - float(crop.bottom)
    if source_width <= 0 or source_height <= 0:
        raise PacketBuildError("A source page has an invalid crop box.")
    content_width = _PACKET_WIDTH - _CONTENT_LEFT - _CONTENT_RIGHT
    content_height = _PACKET_HEIGHT - _CONTENT_TOP - _CONTENT_BOTTOM
    scale = min(content_width / source_width, content_height / source_height)
    rendered_width = source_width * scale
    rendered_height = source_height * scale
    offset_x = _CONTENT_LEFT + (content_width - rendered_width) / 2
    offset_y = _CONTENT_BOTTOM + (content_height - rendered_height) / 2
    transform = (
        Transformation()
        .translate(-float(crop.left), -float(crop.bottom))
        .scale(scale, scale)
        .translate(offset_x, offset_y)
    )
    target = PageObject.create_blank_page(width=_PACKET_WIDTH, height=_PACKET_HEIGHT)
    try:
        target.merge_transformed_page(page, transform, over=True, expand=False)
        target.merge_page(overlay, over=True, expand=False)
    except Exception as exc:
        raise PacketBuildError("A source page could not be safely merged into the packet.") from exc
    _remove_active_page_features(target)
    return target


def _validate_output(path: Path, expected_pages: int) -> None:
    try:
        reader = PdfReader(str(path), strict=True)
    except Exception as exc:
        raise PacketBuildError("The generated packet could not be parsed.") from exc
    if len(reader.pages) != expected_pages:
        raise PacketBuildError("The generated packet page count is inconsistent.")
    root = reader.trailer.get("/Root", {})
    for key in _ROOT_ACTIVE_KEYS:
        if key in root:
            raise PacketBuildError(f"The generated packet retained active catalog key {key}.")
    for index, page in enumerate(reader.pages, start=1):
        for key in _PAGE_ACTIVE_KEYS:
            if key in page:
                raise PacketBuildError(
                    f"The generated packet retained active page key {key} on page {index}."
                )


def build_source_packet(
    output_path: str | os.PathLike[str],
    attachments: list[dict[str, Any]] | tuple[dict[str, Any], ...],
    *,
    allowed_source_root: str | os.PathLike[str],
    allowed_output_root: str | os.PathLike[str],
    packet_title: str,
    footer_label: str,
    notice: str,
    author: str = "Arcane",
    subject: str = "Source-page packet",
) -> dict[str, Any]:
    """Build a fresh, inactive PDF from an explicit source-page allowlist.

    ``attachments`` is an ordered array.  Every record requires ``id``,
    ``title``, ``source_path``, ``source_filename``, sorted positive ``pages``,
    ``source_ids``, ``candidate_ids``, ``purpose``, and ``callouts``.  A callout
    is guide text on the divider; it is never positioned over source content.

    Returns a JSON-serializable inventory containing output packet page numbers.
    Raises :class:`PacketBuildError` before replacing the prior output whenever
    paths, PDFs, pages, bounds, or content fail validation.
    """

    source_root = _validate_root(Path(allowed_source_root), "allowed_source_root")
    output_root = _validate_root(Path(allowed_output_root), "allowed_output_root")
    target = _output_path(output_path, output_root)
    title = _text(packet_title, "packet_title", maximum=300)
    footer = _text(footer_label, "footer_label", maximum=180)
    private_notice = _text(notice, "notice", maximum=180)
    author_text = _text(author, "author", maximum=180)
    subject_text = _text(subject, "subject", maximum=300)
    if not isinstance(attachments, (list, tuple)) or not attachments:
        raise PacketBuildError("attachments must be a non-empty array.")
    if len(attachments) > MAX_ATTACHMENTS:
        raise PacketBuildError(f"attachments exceeds {MAX_ATTACHMENTS} entries.")
    normalized = tuple(
        _normalize_attachment(record, index, source_root)
        for index, record in enumerate(attachments)
    )
    attachment_ids = [item["id"] for item in normalized]
    if len(attachment_ids) != len(set(attachment_ids)):
        raise PacketBuildError("attachments contains duplicate ids.")
    total_source_pages = sum(len(item["pages"]) for item in normalized)
    if total_source_pages > MAX_SOURCE_PAGES:
        raise PacketBuildError(f"attachments exceeds {MAX_SOURCE_PAGES} source pages.")
    total_pages = len(normalized) + total_source_pages

    readers: dict[Path, PdfReader] = {}
    for attachment in normalized:
        source_path = attachment["source_path"]
        if source_path == target:
            raise PacketBuildError("A source PDF may not also be the packet output.")
        if source_path not in readers:
            try:
                reader = PdfReader(str(source_path), strict=True)
            except Exception as exc:
                raise PacketBuildError(f"Malformed source PDF: {source_path}") from exc
            if reader.is_encrypted:
                raise PacketBuildError(f"Encrypted source PDFs are not supported: {source_path}")
            readers[source_path] = reader
        page_count = len(readers[source_path].pages)
        for page_number in attachment["pages"]:
            if page_number > page_count:
                raise PacketBuildError(
                    f"{attachment['id']} requests source page {page_number}; "
                    f"{source_path.name} has {page_count} pages."
                )

    font_name, bold_name = _font_pair()
    writer = PdfWriter()
    page_inventory: list[dict[str, Any]] = []
    packet_page = 0
    for attachment in normalized:
        packet_page += 1
        divider = _divider_page(
            attachment,
            page_number=packet_page,
            page_count=total_pages,
            packet_title=title,
            footer_label=footer,
            notice=private_notice,
            font_name=font_name,
            bold_name=bold_name,
        )
        _remove_active_page_features(divider)
        writer.add_page(divider)
        callout_ids = [item["id"] for item in attachment["callouts"]]
        page_inventory.append(
            {
                "packetPage": packet_page,
                "kind": "divider",
                "attachmentId": attachment["id"],
                "sourceIds": list(attachment["source_ids"]),
                "highlightIds": callout_ids,
                "originalPdf": attachment["source_filename"],
                "originalPage": None,
                "originalPages": list(attachment["pages"]),
            }
        )
        reader = readers[attachment["source_path"]]
        for source_page_number in attachment["pages"]:
            packet_page += 1
            overlay = _source_overlay(
                source_filename=attachment["source_filename"],
                source_page=source_page_number,
                packet_title=title,
                page_number=packet_page,
                page_count=total_pages,
                footer_label=footer,
                notice=private_notice,
                font_name=font_name,
                bold_name=bold_name,
            )
            output_page = _fresh_source_page(reader.pages[source_page_number - 1], overlay)
            writer.add_page(output_page)
            page_inventory.append(
                {
                    "packetPage": packet_page,
                    "kind": "source-page",
                    "attachmentId": attachment["id"],
                    "sourceIds": list(attachment["source_ids"]),
                    "highlightIds": callout_ids,
                    "originalPdf": attachment["source_filename"],
                    "originalPage": source_page_number,
                    "originalPages": [source_page_number],
                }
            )

    writer.add_metadata(
        {
            "/Title": title,
            "/Author": author_text,
            "/Subject": subject_text,
            "/Creator": f"Arcane PdfSourcePacket {BUILDER_VERSION}",
            "/Producer": f"Arcane PdfSourcePacket {BUILDER_VERSION}",
        }
    )
    for key in _ROOT_ACTIVE_KEYS:
        name = NameObject(key)
        if name in writer._root_object:  # pypdf has no public catalog-removal API
            del writer._root_object[name]

    temporary = target.with_name(f".{target.name}.tmp")
    try:
        with temporary.open("wb") as handle:
            writer.write(handle)
        _validate_output(temporary, total_pages)
        os.replace(temporary, target)
    except Exception:
        try:
            temporary.unlink(missing_ok=True)
        finally:
            raise

    return {
        "builder": {"name": "PdfSourcePacket.py", "version": BUILDER_VERSION},
        "outputPath": str(target),
        "pageCount": total_pages,
        "dividerPageCount": len(normalized),
        "sourcePageCount": total_source_pages,
        "attachments": [
            {
                "id": item["id"],
                "sourcePath": str(item["source_path"]),
                "sourceFilename": item["source_filename"],
                "sourcePages": list(item["pages"]),
                "sourceIds": list(item["source_ids"]),
                "candidateIds": list(item["candidate_ids"]),
                "highlightIds": [callout["id"] for callout in item["callouts"]],
            }
            for item in normalized
        ],
        "pages": page_inventory,
    }


__all__ = ["BUILDER_VERSION", "PacketBuildError", "build_source_packet"]
