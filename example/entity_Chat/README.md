# PreCrisis AI ChatEntity Module

***Uses the DBOPFS persistence layer available globally on `window.dbopfs`***

---

# **Overview**

`ChatEntity` represents a high-performance, append-optimized chat session entity used by PreCrisis AI.

The entity provides:

* immutable external access to message history
* append-only persistence to OPFS
* async non-blocking writes
* timestamped message records
* internal saved-state tracking
* disciplined mutation through controlled methods
* console-guided developer behavior (trace-based enforcement of attempts to mutate the immutable)

Each chat session is stored as a **single file** in the OPFS `chats` table.

---

# **Design Philosophy**

ChatEntity follows a **memory-first, append-persist model**:

* messages are committed to memory immediately
* persistence occurs asynchronously
* failures propagate via exceptions
* no artificial control flow is introduced
* developer awareness is preferred over guardrails

The system prioritizes:

* speed
* clarity
* minimal overhead
* explicit behavior

---

# **Usage**

Create a chat session.

```js
import ChatEntity from '/arcane/entities/Chat.js';

const chat=new ChatEntity(
    'You are a calm and supportive evaluator'
);
```

Add messages.

```js
chat.addUserMessage('Hello');
chat.addAIMessage('Hi there');
```

Use directly in AI pipelines.

```js
ai.streamMessage(
    chat.messages,
    streamHandler
);
```

---

# **Persistence Model**

ChatEntity uses an **append-only log model**.

Each message is written as a serialized JSON object followed by a newline.

Example file:

```txt
{"role":"system","content":"You are calm","timestamp":1719930112231}
{"role":"user","content":"Hello","timestamp":1719930112232}
{"role":"assistant","content":"Hi there","timestamp":1719930112233}
```

---

## Behavior

| Action        | Result                     |
| ------------- | -------------------------- |
| add message   | updates memory immediately |
| persist=true  | appends message to file    |
| persist=false | memory only                |
| save()        | rewrites full file         |

---

# **File Format Contract**

ChatEntity relies on the following invariants:

* messages are serialized using `JSON.stringify(message)`
* each message is appended as a JSON object followed by `\n`
* parsing reconstructs objects using `}\n{` boundary detection
* content must remain valid JSON

### Notes

* pretty-printing is allowed as long as object boundary integrity is preserved
* parsing assumes messages remain valid JSON objects
* malformed boundaries will break reconstruction

---

# **Constructor**

```js
new ChatEntity(systemPrompt='')
```

| parameter    | type   | description             |
| ------------ | ------ | ----------------------- |
| systemPrompt | string | optional system message |

### Behavior

* generates unique file name using timestamp
* initializes empty message array
* optionally inserts system message with timestamp
* marks entity as unsaved

---

# **Instance Members**

| Member   | Type    | Description                             |
| -------- | ------- | --------------------------------------- |
| fileName | string  | storage file name                       |
| persist  | boolean | enable or disable automatic persistence |

---

# **Entity Members**

| Member   | Type            | Description                |
| -------- | --------------- | -------------------------- |
| messages | `ChatMessage[]` | immutable message array    |
| saved    | boolean         | internal persistence state |

---

# **ChatMessage Schema**

```js
{
    role:'system'|'user'|'assistant',
    content:string|number,
    timestamp:number
}
```

---

# **Methods**

| Method            | parameters       | description                     |
| ----------------- | ---------------- | ------------------------------- |
| constructor       | `(systemPrompt)` | create new chat session         |
| `.addUserMessage` | `(text)`         | add validated user message      |
| `.addAIMessage`   | `(text)`         | add validated assistant message |
| async `.load`     | `()`             | load chat from OPFS             |
| async `.save`     | `()`             | rewrite entire chat file        |

---

# **Message Access**

```js
const msgs=chat.messages;
```

Returns:

```js
Object.freeze(this.#messages.slice())
```

### Guarantees

* immutable externally
* safe for AI pipelines
* snapshot-based

---

# **Mutation Behavior (Console Koan)**

Direct mutation is not allowed.

```js
chat.messages = [];
```

Console output:

```txt
Trace: Direct mutation of messages is not allowed. Use addUserMessage or addAIMessage methods.
```

The system:

* does not throw
* does not mutate
* returns the current state
* provides a trace for awareness

---

# **Saved State**

```js
chat.saved
```

Represents whether in-memory state is persisted.

### State transitions

| Event                   | saved |
| ----------------------- | ----- |
| constructor with system | false |
| message append          | false |
| append success          | true  |
| save()                  | true  |

---

# **Batch Updates Without Persistence**

```js
const chat=new ChatEntity();

const prevPersist=chat.persist;

chat.persist=false;

chat.addUserMessage('Hello');
chat.addAIMessage('Hi');

await chat.save();

chat.persist=prevPersist;
```

Ensures:

* no unintended persistence behavior
* consistent system state after batch operation

---

# **Loading From Storage**

```js
const chat=new ChatEntity();

chat.fileName='chat-1719930112231.json';

await chat.load();
```

### Behavior

* reads file
* splits using `}\n{`
* reconstructs JSON objects
* replaces internal message array

---

# **Full Save**

```js
await chat.save();
```

* rewrites entire file
* synchronizes memory → disk
* sets `saved=true`

---

# **Streaming Pattern (Correct Usage)**

Do not store each chunk.

```js
let buffer='';

await ai.streamMessage(
    chat.messages,
    function(chunk){
        buffer+=chunk;
        render(chunk);
    }
);

chat.addAIMessage(buffer);
```

---

# **Performance Characteristics**

| Operation      | Complexity |
| -------------- | ---------- |
| append message | O(1)       |
| save() rewrite | O(n)       |
| load()         | O(n)       |

---

# **Consistency Model**

ChatEntity uses:

> **memory-first, append-persist, exception-driven consistency**

Implications:

* memory updates immediately
* persistence may fail
* application handles errors
* temporary divergence is possible

---

# **Design Notes**

* append-only architecture ensures performance
* timestamps enable ordering and audit
* immutable access prevents corruption
* console traces guide developer behavior
* persistence is explicit, not hidden

---

# **Roshi Note**

When a developer seeks to change the immutable,
the system does not resist with force.

It simply does not move…
and shows the path to enlightenment,
mutability is not found in the immutable,
and the immutable is mutable when following the path.

---

# **Summary**

ChatEntity is:

* fast
* minimal
* explicit
* append-optimized
* disciplined
* production-ready
