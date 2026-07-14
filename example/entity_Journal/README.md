# PreCrisis AI Journal Module

***Uses the DBOPFS persistence layer available globally on `window.dbopfs`***

---

# **Overview**

`Journal` manages user journal records stored in the OPFS `journal` directory.

Journal records include:

* `date`
* `title`
* `entry`
* `user`

Each journal entry is stored as JSON using the schema above.

---

# **Integration**

| Event / Handler | Where | Action |
| --- | --- | --- |
| Journal form submit | `test/journal.html` | Save journal entry via `Journal.save()` |

---

# **Methods**

| Method | Params | What it does |
| --- | --- | --- |
| `constructor(fileName)` | `string` | Create journal instance (optionally for an existing OPFS key). |
| `load(fileName)` | `string` | Load a journal record from OPFS `journal` table. |
| `save(journalData)` | `{date, title, entry, user}` | Generate file name (if needed) and persist journal JSON to OPFS. |

---

# **Properties**

| Property | Type | Notes |
| --- | --- | --- |
| `fileName` | `string` | OPFS key for this journal record. |
| `date` | `string` | Date/timestamp string for the journal entry. |
| `title` | `string` | Journal subject/title. |
| `entry` | `string` | Journal body/content. |
| `user` | `string` | Username associated with the entry. |
| `meta` | `object` | Snapshot: `{date, title, entry, user}`. |

---

# **Quick Example**

```js
import Journal from '/apps/precrisis/entities/Journal.js';

const journal = new Journal();

await journal.save({
	date: `${Date.now()}`,
	title: 'Daily Check-In',
	entry: 'Today I felt more stable and focused.',
	user: 'user123'
});
```
