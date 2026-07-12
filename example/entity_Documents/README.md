# PreCrisis AI DocumentEntity Module

***Uses the DBOPFS persistence layer available globally on `window.dbopfs`***

---

# **Overview**

`DocumentEntity` represents a file-backed document record stored in OPFS.

The entity provides:

* validated document metadata access
* optional automatic persistence on upload
* direct file retrieval as a native browser `File`
* explicit save behavior for raw binary content
* minimal document-oriented abstraction over OPFS

Each document is stored as a **single file** in the OPFS `documents` table.

---

# **Events**

Current upload events are emitted by the chat UI integration (`components/chat.html`) and handled in `chat.html`:

| Event name                  | Trigger                                  |
| --------------------------- | ---------------------------------------- |
| `chat-file-uploaded`        | user selected a valid upload file        |
| `chat-file-upload-rejected` | user selected an unsupported upload file |

```js
chat.addEventListener('chat-file-uploaded', fileUpload);
chat.addEventListener('chat-file-upload-rejected', fileUploadRejected);

async function fileUpload(event){
	const file = event.detail.file;
	const doc = new DocumentEntity();
	await doc.uploadFile(file);
}

function fileUploadRejected(event){
	console.warn(event?.detail?.reason);
}
```

---

# **Design Philosophy**

DocumentEntity follows a **file-first, metadata-assisted model**:

* the file itself is the source of truth
* metadata is cached on the entity instance
* uploads write raw bytes directly to OPFS
* file retrieval returns a native browser `File`
* persistence is explicit and simple

The system prioritizes:

* clarity
* predictable storage behavior
* minimal abstraction
* browser-native file handling

---

# **Usage**

Create a document entity.

```js
import DocumentEntity from './entities/Document.js';

const doc=new DocumentEntity();
```

Upload a browser file.

```js
const input=document.querySelector('input[type="file"]');

input.addEventListener('change',async e=>{
	const file=e.target.files[0];
	await doc.uploadFile(file);
});
```

Retrieve the stored file.

```js
const file=await doc.getFile();
```

---

# **Persistence Model**

DocumentEntity stores the uploaded file bytes directly into OPFS.

There is no JSON wrapper and no record envelope.

The stored OPFS file is the document.

---

## Behavior

| Action        | Result                                 |
| ------------- | -------------------------------------- |
| upload file   | updates entity metadata                |
| persist=true  | writes file bytes to OPFS              |
| persist=false | updates entity state without writing   |
| save(buffer)  | writes provided raw bytes to OPFS      |
| loadMeta()    | refreshes metadata from stored file    |
| getFile()     | returns native browser `File` instance |

---

# **Storage Contract**

DocumentEntity relies on the following invariants:

* one document entity points to one file in the `documents` table
* `storedAs` is the OPFS file key used for reads and writes
* file contents are written exactly as provided
* metadata is derived from the uploaded file or from OPFS file inspection

### Notes

* changing `storedAs` changes which OPFS file the entity points at
* changing `storedAs` does **not** rename an existing file in OPFS
* `uploadedAt` is stored as a millisecond timestamp
* `loadMeta()` uses the OPFS file `lastModified` timestamp

---

# **Constructor**

```js
new DocumentEntity(fileName='')
```

| parameter | type   | description                          |
| --------- | ------ | ------------------------------------ |
| fileName  | string | optional existing OPFS file name     |

### Behavior

* validates `fileName` as a string
* if provided, points the entity at an existing OPFS file key
* does not read metadata automatically
* does not write anything during construction

---

# **Instance Members**

| Member     | Type      | Description                                  |
| ---------- | --------- | -------------------------------------------- |
| persist    | boolean   | enable or disable automatic save on upload   |
| tableName  | string    | read-only OPFS table name                    |
| storedAs   | string    | OPFS file key used for reads and writes      |
| type       | string    | cached MIME type                             |
| size       | number    | cached file size                             |
| uploadedAt | number    | cached timestamp in milliseconds             |
| meta       | object    | snapshot of cached metadata                  |

---

# **DocumentMeta Schema**

```js
{
	type:string,
	size:number,
	uploadedAt:number,
	storedAs:string
}
```

---

# **Methods**

| Method             | parameters   | description                                  |
| ------------------ | ------------ | -------------------------------------------- |
| constructor        | `(fileName)` | create entity for a new or existing file     |
| async `.uploadFile`| `(file)`     | cache metadata and optionally persist bytes  |
| async `.loadMeta`  | `()`         | refresh metadata from OPFS                   |
| async `.getFile`   | `()`         | return stored file as browser `File`         |
| async `.save`      | `(buffer)`   | write raw binary content to OPFS             |

---

# **Metadata Access**

```js
const meta=doc.meta;
```

Returns:

```js
{
	type:doc.type,
	size:doc.size,
	uploadedAt:doc.uploadedAt,
	storedAs:doc.storedAs
}
```

### Guarantees

* values are validated before assignment
* `meta` is derived from current entity state
* no hidden conversion to ISO date strings occurs

---

# **Uploading Files**

```js
await doc.uploadFile(file);
```

### Behavior

* validates that `file` is file-like
* sets `storedAs` from `file.name`
* caches `type`, `size`, and `uploadedAt`
* writes bytes immediately when `persist=true`

---

# **Loading Metadata**

```js
await doc.loadMeta();
```

### Behavior

* opens the current OPFS file by `storedAs`
* reads file metadata from OPFS
* updates cached `type`, `size`, and `uploadedAt`
* returns the current `meta` snapshot

---

# **Retrieving The File**

```js
const file=await doc.getFile();
```

### Behavior

* opens the current OPFS file by `storedAs`
* reads the underlying OPFS file
* returns a native browser `File`
* preserves the current file key as the returned file name

---

# **Manual Save**

```js
const buffer=await file.arrayBuffer();
await doc.save(buffer);
```

### Behavior

* writes raw bytes to the current OPFS file key
* overwrites existing file contents
* does not recalculate metadata automatically

### Requirements

* `storedAs` must already be set before calling `save()`

---

# **Working Without Immediate Persistence**

```js
const previousPersist=doc.persist;

doc.persist=false;
await doc.uploadFile(file);

const buffer=await file.arrayBuffer();
await doc.save(buffer);

doc.persist=previousPersist;
```

Ensures:

* upload metadata can be staged before writing
* persistence remains explicit
* caller controls when bytes hit OPFS

---

# **Design Notes**

* the entity is intentionally narrow and file-oriented
* there is no document listing API on the entity
* file enumeration belongs in the storage layer, not on a single document instance
* `storedAs` is the storage key, not a rename operation
* `getFile()` is a document convenience that returns a browser-native `File`

---

# **Summary**

DocumentEntity is:

* minimal
* explicit
* file-oriented
* OPFS-backed
* browser-native
* persistence-aware
