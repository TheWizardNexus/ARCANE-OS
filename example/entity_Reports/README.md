# PreCrisis AI Reports Module

***Uses the DBOPFS persistence layer available globally on `window.dbopfs`***

---

# **Overview**

`Reports` manages assessment and evaluation reports stored in the OPFS `reports` directory.

Reports are generated during the assessment process and contain:

* Mental health assessment results
* Crisis detection evaluations
* Fitness for service determinations
* Risk assessments
* Relationship abuse evaluations

Each report is stored as JSON with metadata (type, user ID, timestamp, content).

---

# **Integration**

| Event / Handler | Where | Action |
| --- | --- | --- |
| `assessment_complete(params)` | `chat.html` | Save assessment report via `Reports.save()` |
| `crisis_detection(params)` | `chat.html` | Save crisis report via `Reports.save()` |
| `fitness_for_service(params)` | `chat.html` | Save fitness report via `Reports.save()` |
| `possible_risks(params)` | `chat.html` | Save risk report via `Reports.save()` |
| `possible_risks_relationship(params)` | `chat.html` | Save relationship report via `Reports.save()` |

---

# **Methods**

| Method | Params | What it does |
| --- | --- | --- |
| `constructor(id)` | `string` | Create report instance (optionally load existing). |
| `save(reportData)` | `{type, userId, data}` | Generate ID and persist report to OPFS. |
| `count()` | — | Get total report count. |

---

# **Properties**

| Property | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Report ID (`score-{uuid}-{type}`) auto-generated on save. |
| `type` | `string` | Report type (assessment_complete, crisis_detection, etc.). |
| `userId` | `string` | User this report belongs to. |
| `generatedAt` | `number` | Timestamp in milliseconds. |
| `data` | `object` | Report payload/content. |
| `meta` | `object` | Snapshot: `{id, type, userId, generatedAt, data}`. |

---

# **Quick Example**

```js
import Reports from '/apps/precrisis/entities/Reports.js';

const report = new Reports();

await report.save({
	type: 'assessment_complete',
	userId: 'user123',
	data: { /* assessment params */ }
});
```
