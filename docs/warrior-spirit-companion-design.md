# Warrior Spirit Companion white-label decision

## App-building questions

1. **I need to make a:** Warrior Spirit-branded edition of the existing PreCrisis.ai application.
2. **Could this be useful for other applications?** The chat, journal, data browser, dashboard, profile, DBOPFS, AI, modal, and theme mechanisms already exist and are already reused from Arcane and PreCrisis. No parallel replacement is needed.
3. **What business logic is specific to this app?** Warrior Spirit organization copy, logo, Companion terminology, route visibility and order, the partner skin, Profile field visibility, and opening the official 988 website for the white-label safety action.
4. **Can the business logic be extracted?** The reusable mechanisms remain in their existing Arcane and PreCrisis sources. The small Warrior adapter stays product-specific because it maps one partner brand onto one established product. The release adapter packages the authoritative PreCrisis sources; it does not maintain a second copy.

## Source and runtime boundary

- `apps/precrisis/chat.html` remains the source for the Companion implementation and continues using `arcane/components/chat.html`, `arcane/entities/Chat.js`, the existing assessment tools, and the established DBOPFS chat/memory schemas.
- `apps/precrisis/journal.html` remains the Reflection implementation and continues using `arcane/components/markdown-editor.html`, `apps/precrisis/entities/Journal.js`, and the existing post-save assessment workflow.
- `apps/precrisis/dashboard.html` remains the Mental Health Center, including its historic charts and notes.
- `apps/precrisis/data.html` remains the on-device data and memory browser.
- `apps/precrisis/admin.html` remains Profile, including the name, OpenAI key, AI personality, voice, contacts, and provider/model preferences.
- The functional pages under `apps/warrior-spirit/` are direct top-level copies of the proven PreCrisis page documents. They keep the same shared Arcane and PreCrisis dependencies and do not use iframes.
- `apps/warrior-spirit/modules/PreCrisisFrame.js` is the app-local presentation adapter. It applies Warrior Spirit labels, destinations, logo, and 988 action to the current page; exposes the OpenAI key; and hides the color-palette and support-email sections in this edition. Normal PreCrisis pages are unchanged.

The public package uses an app-specific adapter to include the authoritative PreCrisis runtime beside Warrior Spirit. This avoids a copied Warrior fork and keeps fixes to the functional product in one source location.

## Data and provider behavior

The white-label deliberately reuses the PreCrisis DBOPFS table names and record schemas:

- `users`
- `chats`
- `memories`
- `journal_entries`
- `notes`
- `reports`
- `scores`

Every Warrior page declares `<meta name="arcane-app-id" content="warrior-spirit">`. DBOPFS therefore stores these records under the Warrior Spirit application-data folder, separate from the `precrisis` folder even though both apps use compatible tables and entities. Warrior backup, restore, clear, and normal reads operate only on Warrior-owned records; they do not include PreCrisis records.

Warrior records are stored on this device and are not synchronized by the application. Clearing Warrior Spirit application data can remove them. The OpenAI key is stored in the local Warrior Spirit profile using the inherited profile schema. Conversation and journal content is transmitted to the configured AI provider when AI chat or post-save assessment work runs; “stored on this device” does not mean provider requests remain on-device.

## Theme and brand

Every Warrior route loads `arcane/css/theme.css`, then Arcane primitives, then `precrisis-skin.css`, and loads `ThemeBootstrap.js`. The embedded PreCrisis surface already loads the Arcane theme and receives the Warrior skin after that base. New color values use `rgb(...)` or `rgba(...)`.

The Profile OpenAI key remains visible, while its color-palette and support-email sections are hidden for the Warrior edition. Support-email actions are also disabled in the Warrior adapter for now, including for profiles that previously stored contacts. Legacy PreCrisis body skin classes are removed in the white-label view, so Arcane's selected system/light/dark appearance remains authoritative. The Warrior skin adds the organization-inspired navy, amber, and green treatment without replacing the user's light or dark base.

## Safety behavior

PreCrisis crisis controls and assessment behavior remain intact. In the Warrior edition, a visible 988 action opens `https://988lifeline.org/` in a new browser window instead of navigating to `tel:988`. When a PreCrisis crisis modal is populated, the adapter also attempts that website opening and leaves the visible 988 control available if a popup is blocked. The interface continues to show 911 guidance for immediate danger and does not claim that anyone was contacted.

## Verification contract

- Source tests confirm the five PreCrisis-derived surfaces, shared components, Profile fields, Mental Health Center, prompt/personality wiring, DBOPFS schemas, explicit Warrior app identity, isolated-data wording, 988 website behavior, theme order, and package policy.
- Public packaging must include both the Warrior shell and the authoritative PreCrisis runtime while excluding the large research HTML file.
- Native packaging must resolve the same local dependencies.
- Browser verification covers route loading; the exact Warrior Spirit Companion header; Home, Companion, and Mental Health Center navigation order; system light/dark behavior; a visible OpenAI key; hidden Profile palette and support-email sections; and the existing functional components.
