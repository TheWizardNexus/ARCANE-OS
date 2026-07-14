# PreCrisis AI Notes Module

***Uses the DBOPFS persistence layer available globally on `window.dbopfs`***

---

# **Overview**

`Notes` manages structured clinical note records stored in the OPFS `notes` directory.

Notes are generated from `text_assessment` output and contain:

* Assessment note text
* Topics of discussion
* Treatment options
* A timestamp and unique note ID

Each note is stored as JSON with metadata (`id`, `type`, `note`, `timestamps`).

---

# **Integration**

| Event / Handler | Where | Action |
| --- | --- | --- |
| `text_assessment(params)` | `chat.html` | Save generated notes via `Notes.saveFromTextAssessment(params)` |

---

# **Methods**

| Method | Params | What it does |
| --- | --- | --- |
| `constructor(id)` | `string` | Create note instance (optionally with existing ID). |
| `saveFromTextAssessment(params)` | `object` | Creates and saves standard note rows from assessment output. |
| `load(fileName)` | `string` | Load an existing note record by OPFS file name. |
| `save(noteData)` | `{type, note, timestamps}` | Generate ID (if needed) and persist note JSON to OPFS. |

---

# **Properties**

| Property | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Note ID (UUID), auto-generated on save when not provided. |
| `type` | `string` | Note type (for example: assessment note, topics of discussion, treatment options). |
| `note` | `string` | Main note text/content. |
| `timestamps` | `string` | Timestamp string (defaults to `Date.now()`). |
| `fileName` | `string` | OPFS key format: `notes-{id}-{type}`. |
| `meta` | `object` | Snapshot: `{id, type, note, timestamps}`. |

---

# **Quick Example**

```js
import Notes from '/apps/precrisis/entities/Notes.js';

const note = new Notes();

await note.save({
	type: 'assessment note',
	note: 'User reports improved sleep this week.',
	timestamps: `${Date.now()}`
});
```
