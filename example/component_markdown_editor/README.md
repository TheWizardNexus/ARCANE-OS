# Arcane Markdown editor component

## Overview

The shared Markdown editor provides a title field, formatting toolbar, safe preview, and a parent-owned asynchronous save callback. It does not choose a storage system.

The example preloads synthetic content and records only title and character-count metadata in its callback log.

## Run the example

Serve the repository root over HTTP and open `/example/component_markdown_editor/`.

```powershell
python -m http.server 8000
```

## Parent API demonstrated

The parent supplies the save behavior:

```js
editor.save=async ({title,markdown}) => {
    return persistWhereTheParentChooses({title,markdown});
};
```

After `markdown-editor-ready`, the parent may configure labels and initial values:

```js
editor.configure({
    bodyPlaceholder:'Write a reusable Markdown note...',
    previewLabel:'Synthetic note preview',
    saveLabel:'Save Synthetic Note',
    titlePlaceholder:'Synthetic note title'
});

editor.entryTitle='Synthetic release note';
editor.value='## Example update';
```

### Members and methods

| API | Purpose |
|---|---|
| `value` | Gets or sets the Markdown body. |
| `entryTitle` | Gets or sets the optional title. |
| `configure(options)` | Changes placeholders and visible labels. |
| `clear()` | Clears the title, body, and preview. |
| `focus()` | Focuses the Markdown textarea. |
| `save({title, markdown})` | Parent-provided asynchronous callback. |

### Events

| Event | Detail | Purpose |
|---|---|---|
| `markdown-editor-ready` | None | Component methods and properties are ready. |
| `markdown-editor-saved` | `{ title, markdown }` | The parent save callback completed. |

## Dependencies

- `arcane/components/markdown-editor.html`
- `arcane/modules/MD.js`
- `arcane/modules/HTMLImport.js`
- `arcane/css/layout.css`
