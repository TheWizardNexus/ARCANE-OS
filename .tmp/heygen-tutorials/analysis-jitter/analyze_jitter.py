"""Measure short-timescale facial instability in a HeyGen presenter render.

The metric intentionally ignores the mouth and eyes. It scores the temporal
second difference in metallic forehead/cheek/chin panels, where a rigid face
should move smoothly. Smooth head movement has a small second difference;
frame-to-frame geometry flicker or "jiggle" has a large one.

Usage:
    python analyze_jitter.py INPUT.mp4 OUTPUT_PREFIX

Outputs OUTPUT_PREFIX.frames.csv and OUTPUT_PREFIX.summary.json.
"""

from __future__ import annotations

import csv
import json
import subprocess
import sys
from pathlib import Path

import numpy as np


FFMPEG = r"C:\ProgramData\chocolatey\bin\ffmpeg.exe"
FPS = 25.0

# The current ARCANE Presence presenter occupies this stable, fixed region in
# a 1920x1080 frame. Extracting at half scale keeps the analysis lightweight.
CROP = (560, 180, 520, 600)  # x, y, width, height in source pixels
SIZE = (260, 300)  # width, height after scaling

# Regions are (x0, y0, x1, y1) in the scaled crop. Eyes and mouth are omitted.
REGIONS = {
    "forehead": (77, 46, 174, 98),
    "left_cheek": (44, 116, 106, 177),
    "right_cheek": (139, 116, 201, 177),
    "left_chin": (58, 176, 111, 216),
    "right_chin": (135, 176, 191, 216),
}

# Control regions on the hood. These share the character's overall head motion
# but should not inherit facial geometry deformation. A high face/hood ratio is
# evidence that the instability is localized to the generated face.
HOOD_REGIONS = {
    "left_hood": (12, 76, 47, 221),
    "right_hood": (204, 76, 246, 221),
}


def decode_gray(video: Path) -> np.ndarray:
    x, y, w, h = CROP
    ow, oh = SIZE
    cmd = [
        FFMPEG,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(video),
        "-vf",
        f"crop={w}:{h}:{x}:{y},scale={ow}:{oh}:flags=lanczos,format=gray",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
    ]
    proc = subprocess.run(cmd, check=True, stdout=subprocess.PIPE)
    frame_bytes = ow * oh
    count = len(proc.stdout) // frame_bytes
    if count < 3 or len(proc.stdout) != count * frame_bytes:
        raise RuntimeError("Unexpected raw-video byte count")
    return np.frombuffer(proc.stdout, dtype=np.uint8).reshape(count, oh, ow)


def metrics(frames_u8: np.ndarray) -> dict[str, np.ndarray]:
    frames = frames_u8.astype(np.float32)
    count = len(frames)
    out: dict[str, np.ndarray] = {}

    # Second temporal difference, in 8-bit intensity levels. This suppresses
    # constant-velocity motion while exposing one-frame deformation/flicker.
    second = np.abs(frames[:-2] - 2.0 * frames[1:-1] + frames[2:])
    first = np.abs(frames[1:] - frames[:-1])

    region_second = []
    region_first = []
    for name, (x0, y0, x1, y1) in REGIONS.items():
        s = second[:, y0:y1, x0:x1]
        v = first[:, y0:y1, x0:x1]

        # Ignore sub-2-level residuals (mostly codec noise). Mean gives a
        # stable scalar; p90 makes a small warping edge visible in the score.
        s_denoised = np.maximum(s - 2.0, 0.0)
        region_second.append(np.mean(s_denoised, axis=(1, 2)))
        region_first.append(np.mean(np.maximum(v - 1.0, 0.0), axis=(1, 2)))
        out[f"{name}_curvature_px"] = np.pad(
            region_second[-1], (1, 1), constant_values=np.nan
        )

    region_second_arr = np.stack(region_second, axis=1)
    region_first_arr = np.stack(region_first, axis=1)

    # Median across five rigid regions prevents lip/eye motion or one bright
    # highlight from dominating. The regional max still records local warps.
    out["rigid_curvature_px"] = np.pad(
        np.median(region_second_arr, axis=1), (1, 1), constant_values=np.nan
    )
    out["local_peak_curvature_px"] = np.pad(
        np.max(region_second_arr, axis=1), (1, 1), constant_values=np.nan
    )
    out["rigid_velocity_px"] = np.pad(
        np.median(region_first_arr, axis=1), (1, 0), constant_values=np.nan
    )

    hood_second = []
    for x0, y0, x1, y1 in HOOD_REGIONS.values():
        h = second[:, y0:y1, x0:x1]
        hood_second.append(np.mean(np.maximum(h - 2.0, 0.0), axis=(1, 2)))
    hood_second_arr = np.stack(hood_second, axis=1)
    out["hood_curvature_px"] = np.pad(
        np.median(hood_second_arr, axis=1), (1, 1), constant_values=np.nan
    )
    out["face_to_hood_curvature_ratio"] = out["rigid_curvature_px"] / np.maximum(
        out["hood_curvature_px"], 0.25
    )

    # A ratio above one means acceleration/deformation exceeds ordinary
    # inter-frame motion. The denominator floor keeps near-static frames sane.
    denom = np.maximum(
        0.5 * (out["rigid_velocity_px"][:-2] + out["rigid_velocity_px"][1:-1]),
        0.5,
    )
    ratio_mid = out["rigid_curvature_px"][1:-1] / denom
    out["curvature_velocity_ratio"] = np.pad(
        ratio_mid, (1, 1), constant_values=np.nan
    )

    # Robust z-score relative to this clip. This is for locating events, not
    # cross-clip acceptance; absolute curvature percentiles are cross-clip.
    valid = out["rigid_curvature_px"][1:-1]
    median = float(np.median(valid))
    mad = float(np.median(np.abs(valid - median)))
    scale = max(1.4826 * mad, 1e-6)
    out["robust_z"] = (out["rigid_curvature_px"] - median) / scale
    return out


def group_events(times: np.ndarray, scores: np.ndarray, threshold: float) -> list[dict]:
    indices = np.flatnonzero(np.isfinite(scores) & (scores >= threshold))
    if not len(indices):
        return []
    groups: list[list[int]] = [[int(indices[0])]]
    for idx in indices[1:]:
        # Merge peaks separated by <=0.40 seconds into one visible event.
        if int(idx) - groups[-1][-1] <= int(round(FPS * 0.40)):
            groups[-1].append(int(idx))
        else:
            groups.append([int(idx)])

    events = []
    for group in groups:
        peak_idx = max(group, key=lambda i: float(scores[i]))
        events.append(
            {
                "start_s": round(float(times[group[0]]), 3),
                "end_s": round(float(times[group[-1]]), 3),
                "peak_s": round(float(times[peak_idx]), 3),
                "peak_rigid_curvature_px": round(float(scores[peak_idx]), 4),
            }
        )
    return sorted(events, key=lambda e: e["peak_rigid_curvature_px"], reverse=True)


def top_one_second_windows(valid_scores: np.ndarray, limit: int = 10) -> list[dict]:
    window = int(round(FPS))
    means = np.convolve(valid_scores, np.ones(window) / window, mode="valid")
    p95 = float(np.percentile(valid_scores, 95.0))
    hot_counts = np.convolve((valid_scores >= p95).astype(np.float32), np.ones(window), mode="valid")
    # Greedy non-overlapping selection. valid_scores[0] corresponds to frame 1.
    ranked = np.argsort(means)[::-1]
    chosen: list[int] = []
    for raw_idx in ranked:
        idx = int(raw_idx)
        if all(abs(idx - other) >= window for other in chosen):
            chosen.append(idx)
            if len(chosen) >= limit:
                break
    return [
        {
            "start_s": round((idx + 1) / FPS, 3),
            "end_s": round((idx + window) / FPS, 3),
            "mean_rigid_curvature_px": round(float(means[idx]), 4),
            "frames_at_or_above_clip_p95": int(hot_counts[idx]),
        }
        for idx in chosen
    ]


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: analyze_jitter.py INPUT.mp4 OUTPUT_PREFIX")
    video = Path(sys.argv[1]).resolve()
    prefix = Path(sys.argv[2]).resolve()
    prefix.parent.mkdir(parents=True, exist_ok=True)

    frames = decode_gray(video)
    data = metrics(frames)
    times = np.arange(len(frames), dtype=np.float64) / FPS
    valid = data["rigid_curvature_px"][1:-1]

    hood_valid = data["hood_curvature_px"][1:-1]
    face_hood_valid = data["face_to_hood_curvature_ratio"][1:-1]

    percentiles = {
        f"p{p}": round(float(np.percentile(valid, p)), 4)
        for p in (50, 75, 90, 95, 97.5, 99, 99.5)
    }
    threshold = float(np.percentile(valid, 99.0))
    events = group_events(times, data["rigid_curvature_px"], threshold)
    for event in events:
        peak_frame = int(round(float(event["peak_s"]) * FPS))
        region_values = {
            name: round(float(data[f"{name}_curvature_px"][peak_frame]), 4)
            for name in REGIONS
        }
        event["dominant_region"] = max(region_values, key=region_values.get)
        event["region_curvature_px"] = region_values

    region_percentiles = {
        name: {
            "p95": round(
                float(np.nanpercentile(data[f"{name}_curvature_px"], 95.0)), 4
            ),
            "p99": round(
                float(np.nanpercentile(data[f"{name}_curvature_px"], 99.0)), 4
            ),
            "max": round(
                float(np.nanmax(data[f"{name}_curvature_px"])), 4
            ),
        }
        for name in REGIONS
    }

    fields = ["frame", "time_s", *data.keys()]
    csv_path = prefix.with_suffix(".frames.csv")
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for idx, time_s in enumerate(times):
            row: dict[str, object] = {"frame": idx, "time_s": f"{time_s:.3f}"}
            for key, values in data.items():
                value = float(values[idx])
                row[key] = "" if not np.isfinite(value) else f"{value:.6f}"
            writer.writerow(row)

    summary = {
        "input": str(video),
        "fps": FPS,
        "frames": len(frames),
        "duration_s": round(len(frames) / FPS, 3),
        "crop_source_px": {"x": CROP[0], "y": CROP[1], "width": CROP[2], "height": CROP[3]},
        "analysis_size_px": {"width": SIZE[0], "height": SIZE[1]},
        "metric": "median denoised temporal second-difference across rigid face regions, 8-bit pixel levels",
        "rigid_curvature_percentiles_px": percentiles,
        "per_region_curvature_px": region_percentiles,
        "hood_curvature_percentiles_px": {
            f"p{p}": round(float(np.percentile(hood_valid, p)), 4)
            for p in (50, 90, 95, 99)
        },
        "face_to_hood_ratio_percentiles": {
            f"p{p}": round(float(np.percentile(face_hood_valid, p)), 4)
            for p in (50, 90, 95, 99)
        },
        "p99_event_threshold_px": round(threshold, 4),
        "events_ranked": events[:15],
        "top_nonoverlapping_one_second_windows": top_one_second_windows(valid),
    }
    json_path = prefix.with_suffix(".summary.json")
    json_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
