# Arcane Dashboard Config Component

## Overview

This example demonstrates the reusable, parent-driven dashboard configuration component. The parent page supplies synthetic definitions and a sparse visibility map, handles component events, and stores changes only in a JavaScript variable. Reloading the page resets all selections.

The `Experimental panel` definition uses `defaultVisible: false` and is intentionally absent from the initial visibility map. It therefore opens unchecked while the other missing or explicitly enabled definitions follow their own defaults.

## Usage

Serve the repository root over HTTP and open:

```text
/example/component_dashboard_config/index.html
```

The page uses `<base href="../../">`, loads the shared HTML importer, and points the imported element at `./arcane/components/dashboard-config.html`.

### Definition shape

```js
{
    key:'experimental',
    title:'Experimental panel',
    description:'Starts hidden when no explicit visibility value exists.',
    defaultVisible:false
}
```

### Events

| Event name | Detail | Description |
|---|---|---|
| `dashboard-config-ready` | Component readiness | The component API is installed. |
| `dashboard-config-opened` | `{visibility}` | The configuration modal opened. |
| `dashboard-config-change` | `{key, visible, definition, visibility}` | A checkbox changed. The parent decides whether and how to persist it. |
| `dashboard-config-closed` | `{visibility}` | The configuration modal closed. |

### Members

| Member | Type | Description |
|---|---|---|
| `ready` | `boolean` | Indicates that the component API is available. |
| `definitions` | `Array<object>` | Cloned dashboard definitions. |
| `visibility` | `Object<string, boolean>` | Cloned sparse visibility state. |

### Methods

| Method | Parameters | Description |
|---|---|---|
| `configure` | `{definitions, visibility, heading, description, triggerLabel}` | Configures definitions, state, and labels in one call. |
| `setDefinitions` | `definitions` | Replaces the available dashboard definitions. |
| `setVisibility` | `visibility` | Replaces the component's local visibility snapshot and synchronizes checkboxes. |
| `open` | none | Opens the configuration modal when definitions are available. |
| `close` | none | Closes the configuration modal. |

### Parent JavaScript

```js
const definitions=[
    {
        key:'summary',
        title:'Summary panel',
        defaultVisible:true
    },
    {
        key:'experimental',
        title:'Experimental panel',
        defaultVisible:false
    }
];

let visibility={summary:true};

dashboardConfig.addEventListener(
    'dashboard-config-change',
    event=>{
        visibility={...event.detail.visibility};
        dashboardConfig.setVisibility(visibility);
    }
);

dashboardConfig.configure(
    {
        definitions,
        visibility,
        heading:'Choose example panels',
        description:'Selections update only page memory.',
        triggerLabel:'Configure example dashboard'
    }
);
```

### HTML

```html
<base href="../../">
<link rel="stylesheet" href="./arcane/css/layout.css?v=3">
<script type="module" src="./arcane/modules/HTMLImport.js?v=2"></script>

<html-import
    id="dashboardConfig"
    href="./arcane/components/dashboard-config.html?v=3"
></html-import>
```
