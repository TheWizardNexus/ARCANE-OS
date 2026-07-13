#!/usr/bin/env python3
"""Create a tightly cropped transparent BOSS navigation wordmark."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw


APP_ROOT = Path(__file__).resolve().parents[1]
SOURCE = APP_ROOT / "img" / "boss-libraries-logo-horizontal.png"
OUTPUT = APP_ROOT / "img" / "boss-libraries-logo-horizontal-transparent.png"
FLOOD_THRESHOLD = 42
WORDMARK_START_X = 642
WORDMARK_OPAQUE_DISTANCE = 112
ALPHA_NOISE_FLOOR = 8
PADDING = 24


def border_key(image: Image.Image) -> tuple[int, int, int]:
    rgb = image.convert("RGB")
    width, height = rgb.size
    border = [
        *(rgb.getpixel((x, 0)) for x in range(width)),
        *(rgb.getpixel((x, height - 1)) for x in range(width)),
        *(rgb.getpixel((0, y)) for y in range(height)),
        *(rgb.getpixel((width - 1, y)) for y in range(height)),
    ]
    return Counter(border).most_common(1)[0][0]


def clamp_channel(value: float) -> int:
    return max(0,min(255,round(value)))


def dematte_pixel(
    pixel: tuple[int, int, int, int],
    key: tuple[int, int, int],
    alpha: int,
) -> tuple[int, int, int, int]:
    """Recover edge color from a pixel composited over the source matte."""
    if alpha <= 0:
        return (0,0,0,0)
    if alpha >= 255:
        return pixel

    coverage = alpha / 255
    foreground = tuple(
        clamp_channel(
            (pixel[channel] - key[channel] * (1 - coverage)) / coverage
        )
        for channel in range(3)
    )
    return (*foreground,alpha)


def create_transparent_logo(source: Path, output: Path) -> None:
    original = Image.open(source).convert("RGBA")
    key = border_key(original)
    marker = (1, 255, 254)
    flooded = original.convert("RGB")

    for corner in [
        (0, 0),
        (flooded.width - 1, 0),
        (0, flooded.height - 1),
        (flooded.width - 1, flooded.height - 1),
    ]:
        ImageDraw.floodfill(
            flooded,
            corner,
            marker,
            thresh=FLOOD_THRESHOLD,
        )

    source_pixels = list(original.getdata())
    flooded_pixels = list(flooded.getdata())
    output_pixels = []

    for index,(pixel,flood_pixel) in enumerate(zip(source_pixels,flooded_pixels)):
        if flood_pixel == marker:
            output_pixels.append((0,0,0,0))
            continue

        x = index % original.width
        if x < WORDMARK_START_X:
            output_pixels.append(pixel)
            continue

        distance = max(abs(pixel[channel] - key[channel]) for channel in range(3))
        if distance >= WORDMARK_OPAQUE_DISTANCE:
            output_pixels.append(pixel)
            continue

        alpha = round(255 * distance / WORDMARK_OPAQUE_DISTANCE)
        if alpha <= ALPHA_NOISE_FLOOR:
            alpha = 0
        output_pixels.append(dematte_pixel(pixel,key,alpha))

    transparent = Image.new("RGBA",original.size)
    transparent.putdata(output_pixels)

    wordmark_key_residue = sum(
        pixel[3] > 0
        and index % original.width >= WORDMARK_START_X
        and max(abs(pixel[channel] - key[channel]) for channel in range(3)) <= 20
        for index,pixel in enumerate(output_pixels)
    )
    if wordmark_key_residue:
        raise RuntimeError(
            f"White wordmark matte remains in {wordmark_key_residue} pixels."
        )

    bounds = transparent.getchannel("A").getbbox()

    if not bounds:
        raise RuntimeError("No opaque logo pixels remained after background removal.")

    cropped = transparent.crop(bounds)
    final = Image.new(
        "RGBA",
        (cropped.width + PADDING * 2,cropped.height + PADDING * 2),
        (0,0,0,0),
    )
    final.alpha_composite(cropped,(PADDING,PADDING))

    partial_white = sum(
        0 < alpha < 255 and min(red,green,blue) >= 240
        for red,green,blue,alpha in final.getdata()
    )
    if partial_white:
        raise RuntimeError(
            f"White matte contamination remains in {partial_white} edge pixels."
        )

    output.parent.mkdir(parents=True,exist_ok=True)
    final.save(output,optimize=True)

    print(
        f"Created {output.relative_to(APP_ROOT)}: "
        f"{original.width}x{original.height} -> {final.width}x{final.height}; "
        f"key={key}; crop={bounds}"
    )


if __name__ == "__main__":
    create_transparent_logo(SOURCE,OUTPUT)
