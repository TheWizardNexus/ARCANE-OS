# PreCrisis AI ImageEntity Module

***Uses the DBOPFS persistence layer available globally on `window.dbopfs`***

---

# **Overview**

`ImageEntity` is an image-focused extension of `DocumentEntity`.

The entity provides:

* OPFS-backed file persistence via inherited document behavior
* image-only upload validation
* helper methods for image display and transport (`base64` and `blob:` URL forms)
* static file-type checks for image and PNG workflows

`ImageEntity` stores files in the OPFS `images` table while reusing the same file metadata model as `DocumentEntity`.

---

# **Integration**

| Usage                           | Where                                                     |
| ------------------------------- | --------------------------------------------------------- |
| `ImageEntity.isImageFile(file)` | `chat.html` — route uploads to ImageEntity                |
| `ImageEntity.isPNGFile(file)`   | `import.html`, `import-many.html` — strict PNG validation |
| `chat-file-uploaded`            | component emits when valid file selected                  |
| `chat-file-upload-rejected`     | component emits when unsupported file selected            |

For full base behavior, see `example/entity_Document/README.md`.

---

# **Design Philosophy**

ImageEntity follows a **reuse-first inheritance model**:

* persistence logic is inherited from `DocumentEntity`
* image-specific concerns are added at the edge
* file bytes remain the source of truth in OPFS
* conversion helpers are opt-in convenience methods

The system prioritizes:

* consistency with existing entities
* minimal duplication
* explicit validation
* browser-native file interoperability

---

# **Usage**

Create an image entity.

```js
import ImageEntity from './entities/Image.js';

const image = new ImageEntity();
```

Upload an image file.

```js
const input = document.querySelector('input[type="file"]');

input.addEventListener('change', async function(e){
	const file = e.target.files[0];
	await image.uploadFile(file);
});
```

Create display-ready URLs.

```js
const dataUrl = await image.getBase64DataURL();
const blobUrl = await image.getBlobURL();

// Later, when no longer needed:
ImageEntity.revokeBlobURL(blobUrl);
```

---

# **Persistence Model**

ImageEntity inherits persistence directly from `DocumentEntity`.

Files are saved as raw bytes in OPFS using the inherited `save(buffer)` path.

There is no separate image-side metadata file.

---

## Behavior

| Action                 | Result                                                         |
| ---------------------- | -------------------------------------------------------------- |
| `uploadFile(file)`     | validates image file then persists via inherited document flow |
| `save(buffer)`         | writes raw file bytes to OPFS via `DocumentEntity.save`        |
| `getFile()`            | inherited native `File` reconstruction from OPFS               |
| `getBase64DataURL()`   | returns base64 data URL string for UI/embed workflows          |
| `getBlobURL()`         | returns temporary `blob:` URL for preview/display              |
| `revokeBlobURL(url)`   | releases object URL memory when preview is complete            |

---

# **Storage Contract**

ImageEntity relies on the same storage invariants as `DocumentEntity`:

* one entity points to one OPFS file key (`storedAs`)
* writes occur to the inherited table/file handle path
* file content is written exactly as provided
* metadata (`type`, `size`, `uploadedAt`, `storedAs`) is inherited

### Notes

* ImageEntity targets the OPFS `images` table via constructor configuration
* `storedAs` still controls which OPFS file is targeted
* image helper methods read from the persisted file representation

---

# **Constructor**

```js
new ImageEntity(fileName='')
```

| parameter | type   | description                          |
| --------- | ------ | ------------------------------------ |
| fileName  | string | optional existing OPFS file name     |

### Behavior

* forwards to `DocumentEntity` constructor
* preserves inherited validation and initialization behavior
* does not persist during construction

---

# **Instance Members**

Inherited members from `DocumentEntity` remain available:

| Member     | Type      | Description                                  |
| ---------- | --------- | -------------------------------------------- |
| `persist`  | boolean   | enable or disable automatic save on upload   |
| `tableName`| string    | read-only OPFS table name                    |
| `storedAs` | string    | OPFS file key used for reads and writes      |
| `type`     | string    | cached MIME type                             |
| `size`     | number    | cached file size                             |
| `uploadedAt`| number   | cached timestamp in milliseconds             |
| `meta`     | object    | snapshot of cached metadata                  |

---

# **Methods**

| Method                    | parameters   | description                                             |
| ------------------------- | ------------ | ------------------------------------------------------- |
| constructor               | `(fileName)` | initialize inherited document identity                  |
| async `.uploadFile`       | `(file)`     | require image file, then persist through base class     |
| async `.save`             | `(buffer)`   | explicit proxy to inherited OPFS write                  |
| async `.getFile`          | `()`         | inherited document retrieval as browser `File`          |
| async `.getBase64DataURL` | `()`         | convert stored image into data URL string               |
| async `.getBlobURL`       | `()`         | generate object URL from stored image file              |
| static `.isImageFile`     | `(file)`     | check MIME/extension against common image formats       |
| static `.isPNGFile`       | `(file)`     | strict PNG-focused check used by import flows           |
| static `.revokeBlobURL`   | `(url)`      | revoke created object URL to avoid memory leaks         |

---

# **Validation Helpers**

```js
ImageEntity.isImageFile(file);
ImageEntity.isPNGFile(file);
```

### Behavior

* `isImageFile` accepts common image MIME or extension patterns
* `isPNGFile` accepts explicit PNG MIME or `.png` extension
* both methods are static and can be reused in UI/import layers

---

# **Base64 Conversion**

```js
const dataUrl = await image.getBase64DataURL();
```

### Behavior

* loads stored file via inherited `getFile()`
* uses `FileReader.readAsDataURL`
* resolves to a `data:*/*;base64,...` style string

---

# **Blob URL Workflow**

```js
const blobUrl = await image.getBlobURL();

// Use in UI:
img.src = blobUrl;

// Cleanup when done:
ImageEntity.revokeBlobURL(blobUrl);
```

### Behavior

* creates a temporary object URL for efficient preview
* requires explicit revoke when no longer needed
* avoids unnecessary base64 expansion for rendering

---

# **Design Notes**

* image persistence is inherited, not duplicated
* image-specific logic is limited to validation and conversion helpers
* this keeps parity with the entity architecture while adding practical image utilities

---

# **Summary**

ImageEntity is:

* document-compatible
* image-aware
* OPFS-backed
* minimal
* reusable across import and UI flows
