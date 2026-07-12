# PreCrisis AI Score Module

***Uses the DBOPFS persistence layer available globally on `window.dbopfs`***

---

# **Overview**

`Score` manages score records stored in the OPFS `scores` directory.

Scores are generated during assessment and crisis workflows and contain:

* Crisis detection score payloads
* Assessment score payloads
* Fitness score payloads
* Risk score payloads
* Crisis warning severity values

Each score is stored as JSON with metadata (`type`, `username`, `date`, `data`) and a UUID-based ID.

---

# **Integration**

| Event / Handler | Where | Action |
| --- | --- | --- |
| `crisis_detection(params)` | `chat.html` | Save score via `Score.save()` |
| `assessment_complete(params)` | `chat.html` | Save score via `Score.save()` |
| `fitness_for_service(params)` | `chat.html` | Save score via `Score.save()` |
| `possible_risks(params)` | `chat.html` | Save score via `Score.save()` |
| `possible_risks_relationship(params)` | `chat.html` | Save score via `Score.save()` |
| `crisis_warning_shown` | `chat.html` | Save max warning severity via `Score.save()` |
| `crisis_possible_warning_shown` | `chat.html` | Save prediction warning via `Score.save()` |
| `crisis_intervention_required` | `chat.html` | Save intervention severity via `Score.save()` |

---

# **Methods**

| Method | Params | What it does |
| --- | --- | --- |
| `constructor(id)` | `string` | Create score instance (optionally with existing ID). |
| `save(scoreData)` | `{type, data, username}` | Sets date to `Date.now()`, generates UUID ID, and persists score to OPFS. |

---

# **Properties**

| Property | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Score ID (`score-{uuid}-{type}`) auto-generated on save. |
| `type` | `string` | Score label/category (for example `crisis_detection`). |
| `username` | `string` | User this score belongs to. |
| `date` | `number` | Timestamp in milliseconds (maps to `generatedAt`). |
| `data` | `*` | Score payload/content. |
| `meta` | `object` | Snapshot: `{id, type, data, date, username}`. |

---

# **Quick Example**

```js
import Score from '/apps/precrisis/entities/Score.js';

const score = new Score();

await score.save({
	type: 'assessment_complete',
	username: 'user123',
	data: { stress: 7, anxiety: 6 }
});

console.log(score.meta);
```
