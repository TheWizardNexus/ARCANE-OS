# PreCrisis mail recovery accessibility record

Date: 2026-07-18

Scope: PreCrisis and Warrior Spirit crisis-notification delivery result

Status: source and focused automated verification only; not release-candidate conformance evidence

## Expected journey

The user asks PreCrisis to notify configured support contacts. The dialog may close only after the gateway reports full acceptance. When delivery is partial, uncertain, rejected, unavailable, or has no recipients, the dialog remains open with:

- a heading that identifies the delivery problem without relying on color;
- plain text distinguishing an unconfirmed result from a definite failure;
- a direct-contact recovery instruction; and
- a native button labeled `Speak to Someone Now (988)`.

This preserves a keyboard/text alternative and does not weaken the authenticated mail boundary. The existing shared modal owns dialog semantics, focus containment, Escape behavior, and focus restoration.

## Automated evidence

`npm run mail:test` verifies that 202 `accepted` is the only result with `sent: true`; 207 partial/uncertain responses remain distinct; both app sources branch on `delivery.sent`; the recovery heading and 988 button remain present; and affected source no longer prints structured health/recipient values with `console.table`.

No new app-local CSS, color, animation, pointer-only action, timeout, or speech-only action was introduced. The shared Arcane theme remains the base.

## Required manual evidence

Before a supported release or hosted pilot, exercise accepted, partial, uncertain, rejected, timeout, offline, and missing-recipient states on the actual HTTPS host and packaged native host. Record keyboard-only focus order/return, NVDA and Narrator announcements, 200%/400% reflow, Windows scaling, light/dark/system/custom themes, forced colors, reduced motion, and slow/interrupted delivery. Confirm the status is announced once, protected content is not announced or logged unexpectedly, the 988 action is reachable, and the user can cancel or recover without a trap.

These paths are currently untested with assistive technology and therefore cannot support an accessibility or release-candidate pass claim.
