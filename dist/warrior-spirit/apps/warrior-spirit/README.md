# Warrior Spirit Companion

Warrior Spirit Companion is the Warrior Spirit white-label of The Wizard Nexus's PreCrisis.ai. It keeps the existing PreCrisis functionality and Arcane components, then adds Warrior Spirit organization copy, logo, navigation, and visual treatment.

## Pages

- `index.html` — Warrior Spirit organization landing page and program overview.
- `companion.html` — the established PreCrisis conversation workflow presented as the Warrior Spirit Companion.
- `reflection.html` — the existing PreCrisis journal and post-save workflow.
- `mental-health.html` — the existing Personal Mental Health Center charts and notes.
- `memories.html` — the existing on-device PreCrisis data browser.
- `profile.html` — the existing PreCrisis profile with the Warrior Spirit AI Licence key visible and its color-palette, model setup, developer, and support-email controls hidden from the Warrior view.

The functional Warrior routes are direct top-level copies of the proven PreCrisis page documents, with no iframe boundary. They keep using the authoritative shared Arcane and PreCrisis modules, entities, and components. The app-local `modules/PreCrisisFrame.js` adapter applies only Warrior Spirit presentation and policy to the current page. `scripts/build_public_release.mjs` includes the PreCrisis dependencies in the public package.

## Theme

Arcane's system/light/dark appearance remains the base. `precrisis-skin.css` adds the Warrior Spirit-inspired navy, amber, and green treatment after the shared theme. Profile does not offer separate palette choices in this edition.

## Local data and artificial intelligence

The app uses the existing PreCrisis DBOPFS tables for profile, chats, journal entries, memories, notes, reports, and scores. Those records remain on this device unless the user exports them. AI requests send the necessary conversation or reflection content to the configured provider. The Warrior Spirit AI Licence key is stored in the on-device PreCrisis profile and supplies the inherited Cloud AI credential field.

## Crisis support

The existing PreCrisis crisis workflow remains in place. In the Warrior white-label, its 988 action opens the official [988 Lifeline](https://988lifeline.org/) website in a new window and keeps the in-app 988 control visible as a fallback.
