# PreCrisis AI DBLS Module

***This is a Singleton assigned on the window object***

## **Overview**

The **DBLS module** provides a lightweight wrapper around the browser's **LocalStorage** API.

DBLS exists primarily for:

quick synchronous storage
small configuration values
temporary or legacy persistence
compatibility with older versions of the system

Unlike DBOPFS, which uses the **Origin Private File System**, DBLS stores data in app-qualified **LocalStorage key/value pairs**. A page must declare its stable app identity before importing DBLS:

```html
<meta name="arcane-app-id" content="my-app">
```

Physical keys use `arcane.apps.<application-id>:`. Public DBLS methods expose only the logical keys belonging to the current app.

Because LocalStorage is synchronous and widely supported, DBLS is useful for:

UI settings
cached preferences
small pieces of user state
migration bridges between persistence systems

When the module loads it automatically attaches a singleton instance to:

```js
dbls
```

This instance is also attached to `window.dbls`, but in browser environments it can be accessed directly without specifying `window`.

---

# Data Structure

LocalStorage stores simple key/value pairs. For app `my-app`, logical key
`username` is stored as `arcane.apps.my-app:username`.

DBLS automatically handles JSON serialization when necessary.

Example storage:

```
LocalStorage
│
├── username → "alex"
├── email → "alex@example.com"
├── contact_1 → "+1 555 123 4567"
├── skin → "warrior"
```

Objects passed to DBLS are automatically serialized.

Example:

```js
dbls.set(
    'user_preferences',
    {
        theme:'warrior',
        notifications:true
    }
)
```

Stored value:

```
"user_preferences" → '{"theme":"warrior","notifications":true}'
```

When retrieved, DBLS will attempt to **parse JSON automatically**.

---

# Usage

The module initializes automatically when imported.

```js
import '/arcane/modules/DBLS.js'
```

After initialization the singleton is available globally:

```js
dbls.set('username','alex')

const username=dbls.get('username')
```

---

# Events

| Event Name | Details          | Description                                                    |
| ---------- | ---------------- | -------------------------------------------------------------- |
| dbls-ready | `{ dbls: DBLS }` | Fired when DBLS has initialized and the singleton is available |

Example:

```js
window.addEventListener(
    'dbls-ready',
    function(e){
        //dbls is available on the window at this point
        console.log('DBLS ready',dbls)
    }
)
```

---

# Members

| Members | Type    | Description                            |
| ------- | ------- | -------------------------------------- |
| ready   | boolean | Indicates whether DBLS has initialized |
| storage | Storage | Reference to `window.localStorage`     |
| applicationId | string | Canonical owner of the exposed keys |
| storagePrefix | string | Physical `arcane.apps.<id>:` prefix |
| dbls    | DBLS    | Global singleton instance              |

---

# Methods

| Method            | Parameters    | Description                                     |
| ----------------- | ------------- | ----------------------------------------------- |
| set               | `(key,value)` | Stores a value in LocalStorage                  |
| setMany           | `(items)`     | Stores multiple key/value pairs                 |
| get               | `(key)`       | Retrieves and automatically parses stored value |
| getMany           | `(keys)`      | Retrieves multiple keys                         |
| filterKeyIncludes | `(substring)` | Returns keys containing substring               |
| getAll            | `()`          | Returns all values owned by the current app     |
| delete            | `(key)`       | Removes a key from storage                      |
| deleteMany        | `(keys)`      | Removes multiple keys                           |
| clear             | `()`          | Clears only the current app's values            |
| getAllKeys        | `()`          | Returns only the current app's logical keys     |
| hasKey            | `(key)`       | Checks if key exists                            |
| count             | `()`          | Returns number of stored keys                   |

---

# Example Usage

### Basic Storage

```js
dbls.set(
    'username',
    'alex'
)

const username=dbls.get(
    'username'
)
```

---

### Storing Multiple Values

```js
dbls.setMany(
    {
        username:'alex',
        skin:'warrior',
        language:'english'
    }
)
```

---

### Retrieving Multiple Keys

```js
const user=dbls.getMany(
    [
        'username',
        'language'
    ]
)

console.log(user)
```

Output:

```
{
    username:'alex',
    language:'english'
}
```

---

### Filtering Keys

```js
const contacts=dbls.filterKeyIncludes(
    'contact_'
)
```

Example result:

```
{
    contact_1:"+1 555 123 4567",
    contact_2:"+1 555 123 9876"
}
```

---

# Typical Use Cases

DBLS is commonly used for:

| Use Case          | Example             |
| ----------------- | ------------------- |
| User preferences  | theme, language     |
| temporary caching | UI state            |
| legacy storage    | migration to DBOPFS |
| configuration     | feature toggles     |

---

# Relationship to DBOPFS

DBLS and DBOPFS serve different purposes:

| Feature      | DBLS            | DBOPFS                     |
| ------------ | --------------- | -------------------------- |
| storage type | LocalStorage    | Origin Private File System |
| speed        | synchronous     | asynchronous               |
| size limits  | small           | large                      |
| structure    | key/value       | file-based tables          |
| persistence  | browser managed | persistent filesystem      |

Typical application flow:

```
User Settings → DBLS
Application Data → DBOPFS
Legacy Migration → DBLS → DBOPFS
```

Unprefixed legacy values are preserved but are not guessed into an app. Browser
prefixing prevents accidental collisions and clear-all operations; it is not a
security boundary against another hostile script running on the same origin.
