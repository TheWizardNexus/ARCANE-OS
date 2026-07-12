# PreCrisis AI UserEntity Module

***Uses the DBOPFS persistence layer available globally on `window.dbopfs`***

---

# **Overview**

`UserEntity` represents the canonical user configuration object used by PreCrisis AI.

The entity provides:

* strict runtime validation using **strong-type**
* schema-controlled mutation
* automatic persistence to OPFS storage
* JSON import/export
* async non-blocking writes
* type-safe getters and setters
* batch updates with controlled persistence
* migration from DBLS to OPFS

User data is stored as a **single JSON file** in the OPFS `users` table.

---

# **Design Philosophy**

UserEntity follows a **state-first, overwrite-persist model**:

* state is updated immediately in memory
* persistence occurs asynchronously
* setters trigger persistence when enabled
* batch operations suppress redundant writes
* schema defines all valid fields
* invalid values are rejected at runtime

The system prioritizes:

* clarity
* explicit behavior
* minimal abstraction
* controlled mutation
* developer awareness

---

# **Usage**

Create a user entity.

```js
import UserEntity from './entities/User.js';

const user=new UserEntity(
    {
        username:'Captain Pixel Pudding',
        email:'captain@pudding.ai'
    }
);
```

Update properties.

```js
user.phone='1-800-PUDDING';
user.skin='dark';
```

Changes persist automatically.

---

# **Persistence Model**

UserEntity uses an **overwrite model**.

Each save rewrites the full JSON record.

Example file:

```json
{
    "username":"alex",
    "email":"alex@example.com",
    "phone":"555-1111",
    "skin":"dark"
}
```

---

## Behavior

| Action          | Result                     |
| --------------- | -------------------------- |
| set property    | updates memory immediately |
| persist=true    | triggers async save        |
| persist=false   | memory only                |
| save()          | rewrites full file         |
| explicit setter | batch update + single save |

---

# **Persistence Behavior**

Persistence is **async and non-blocking**.

Setters call:

```js
this.#persist()
```

which triggers:

```js
dbopfs.set(...)
```

### Implications

* writes are not awaited
* failures surface through global error handling
* application continues execution immediately

To guarantee persistence:

```js
await user.save();
```

---

# **Constructor**

```js
new UserEntity(src,fileName='users.json')
```

| parameter | type                                      | description         |
| --------- | ----------------------------------------- | ------------------- |
| src       | `UserEntityData \| JSON string \| Object` | initialization data |
| fileName  | string                                    | storage file name   |

---

### Behavior

* sets default table to `users`
* disables persistence during initialization
* applies provided data via `.explicit`
* if `src` is invalid → calls `.load()`
* restores persistence state after initialization

---

# **Instance Members**

| Member   | Type    | Description                             |
| -------- | ------- | --------------------------------------- |
| fileName | string  | storage file name                       |
| persist  | boolean | enable or disable automatic persistence |

---

# **Entity Members**

| Member         | Type            | Description                   |
| -------------- | --------------- | ----------------------------- |
| username       | string | number | user identifier               |
| email          | string          | validated email               |
| phone          | string | number | primary phone                 |
| language       | string          | preferred language            |
| license_key    | string          | system license key            |
| contact_1–6    | string | number | emergency contacts            |
| AI_personality | string          | AI personality configuration  |
| religion       | string          | optional spiritual preference |
| AI_voice       | string          | voice configuration           |
| skin           | string | number | UI theme                      |

---

# **Schema Contract**

The schema defines all allowed fields:

```js
[
    'username','email','phone','language','license_key',
    'contact_1','contact_2','contact_3','contact_4','contact_5','contact_6',
    'AI_personality','religion','AI_voice','skin'
]
```

### Guarantees

* only schema-defined fields are applied
* unknown fields are ignored
* invalid values throw or warn
* schema iteration ensures consistency

---

# **Methods**

| Method        | parameters       | description              |
| ------------- | ---------------- | ------------------------ |
| constructor   | `(src,fileName)` | create new entity        |
| async `.load` | `()`             | load entity from OPFS    |
| async `.save` | `()`             | persist entity to OPFS   |
| `.toJSON`     | `()`             | serialize entity to JSON |

---

# **Explicit Interface**

## Get full schema

```js
const data=user.explicit;
```

Returns full schema object.

---

## Batch update

```js
user.explicit={
    username:'alex',
    phone:'555-1111'
};
```

---

## JSON input

```js
user.explicit='{
    "username":"alex",
    "email":"alex@example.com"
}';
```

---

## Behavior

* disables persistence during updates
* applies only valid fields
* restores persistence state
* triggers one save

---

# **Batch Updates Without Auto Persistence**

```js
const user=new UserEntity();

user.persist=false;

user.username='alex';
user.phone='555-2222';

await user.save();
```

---

# **Loading From Storage**

```js
const user=new UserEntity();

await user.load();
```

### Behavior

* migrates DBLS data if present
* reads OPFS record
* applies via `.explicit`
* dispatches event

---

# **Events**

| Event Name           | Description                |
| -------------------- | -------------------------- |
| `user-entity-loaded` | fired after load completes |

Example:

```js
window.addEventListener(
    'user-entity-loaded',
    function(e){
        console.log(e.detail.user.username);
    }
);
```

---

# **Migration Model**

UserEntity automatically migrates legacy DBLS data.

### Behavior

```js
dbls.getMany(this.#schema)
```

* reads localStorage values
* applies via `.explicit`
* deletes migrated keys

Migration runs during `.load()`.

---

# **Consistency Model**

UserEntity uses:

> **memory-first, overwrite-persist, async-consistency**

Implications:

* memory updates immediately
* persistence may lag
* failures are externally handled
* eventual consistency is expected

---

# **Design Notes**

* schema-driven ensures data integrity
* overwrite model simplifies persistence
* async writes improve performance
* batch operations prevent redundant writes
* migration ensures backward compatibility
* event dispatch enables safe async usage

---

# **Roshi Note**

You spoke your name…

and then you slept.

When you woke,
there was no record of it.

So you spoke it again.

This time, you wrote it down.

And when you woke,
it was still there.

The student asked,
“Why did it disappear before?”

The master smiled:

“You remembered…
but you did not persist.”

---

# **Summary**

UserEntity is:

* state-driven
* schema-controlled
* mutable
* async-persistent
* batch-efficient
* migration-aware
* production-ready
