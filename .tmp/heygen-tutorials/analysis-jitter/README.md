# ARCANE Presence facial-stability baseline

Source analyzed: `what-is-arcane-os-presence-raw.mp4` (1920x1080, 25 fps,
92.56 s).

## What the metric measures

`analyze_jitter.py` crops the presenter, excludes the mouth and eyes, then
computes the temporal second difference in five nominally rigid face-panel
regions: forehead, both cheeks, and both sides of the chin. This suppresses
smooth deliberate movement and highlights frame-to-frame geometry flicker. A
pair of hood regions is measured as a control.

Baseline results (8-bit pixel-intensity levels):

- rigid-face curvature: p95 **6.9537**, p99 **10.2155**
- hood curvature: p95 **1.1087**, p99 **2.0010**
- face/hood curvature ratio: p95 **15.4527**
- worst non-overlapping one-second mean: **5.3543**
- worst single-frame rigid-face event: **13.4857** at **60.44 s**

The face is therefore changing much faster than the hood; the effect is
localized to facial generation rather than overall head motion or compression.
The viewer-right metallic cheek/eye plate is the dominant unstable region
(regional p95 9.3545, p99 12.9867, max 18.6586).

## Clearest inspection regions

- **57.04-58.00 s**: strongest sustained interval; cheek and chin plates pulse
  while the hood stays comparatively fixed.
- **1.96-2.92 s**: seven frames at or above the clip's p95; cheek/forehead seams
  change shape during speech.
- **61.96-62.92 s**: repeated viewer-right cheek displacement.
- **52.76-53.72 s**: face-panel deformation, followed by a blink near the end.
- **75.24-76.20 s**: strong cheek/forehead instability.
- **14.92-15.88 s**: shorter but visible whole-face panel wobble.
- Sharpest individual transitions: **0.44, 15.36, 44.60, 59.56, 60.44, 75.36,
  and 81.68 s**. The events at 38.28 and 81.68 s overlap blinks, so they should
  not be used alone to reject a candidate.

Frame strips for the top events and windows are saved alongside this file.

## Acceptance gate for the next motion test

Use the same 1920x1080/25-fps framing and a 10-15 second test containing normal
speech, a pause, one blink, and one gentle head motion. Run:

```powershell
python `
  .tmp\heygen-tutorials\analysis-jitter\analyze_jitter.py `
  NEW-MOTION-TEST.mp4 `
  .tmp\heygen-tutorials\analysis-jitter\candidate
```

Pass only if all of these hold:

1. rigid-face curvature p95 <= **5.0** and p99 <= **7.5** (at least about 27%
   better than this baseline);
2. worst one-second mean <= **4.0**;
3. face/hood curvature ratio p95 <= **10.0**;
4. no non-blink event exceeds **10.0**, and a 200% face-crop review shows no
   forehead or cheek seam snapping/reversing direction across three adjacent
   frames.

If the new avatar is repositioned, update `CROP`, `REGIONS`, and `HOOD_REGIONS`
in the script before comparing. The manual filmstrip review remains mandatory,
because intentional blinks and lip motion can produce legitimate peaks.
