# Arcane chart component

## Overview

The shared chart component renders timestamped numeric data with the bundled uPlot library. The parent owns the data, display options, and response to the optional remove action.

The example uses fixed synthetic values; it does not load user or application data.

## Run the example

Serve the repository root over HTTP, then open:

```text
/example/component_chart/
```

For example:

```powershell
python -m http.server 8000
```

Then visit `http://localhost:8000/example/component_chart/`.

## Parent API demonstrated

The parent waits for `chart-ready` and calls:

```js
await chart.populate(
    syntheticData,
    {
        title:'Synthetic weekly throughput',
        style:'area',
        seriesLabel:'Throughput',
        valueLabel:'Items',
        timeLabel:'Week',
        min:0,
        max:50,
        removable:true,
        key:'synthetic-throughput'
    }
);
```

### Methods

| Method | Purpose |
|---|---|
| `populate(data, options)` | Configures and renders a complete data set. |
| `update(data)` | Replaces the current data. |
| `addData(data)` | Adds rows and re-renders the normalized data. |
| `destroy()` | Disconnects observers and destroys the plot. |

### Events

| Event | Detail | Purpose |
|---|---|---|
| `chart-ready` | None | The parent may call the chart methods. |
| `chart-remove` | `{ key }` | The parent decides whether and how to remove the chart. |

### Data formats

Rows may be `[timestamp, value]` pairs or objects containing `timestamp`/`date`/`x` and `value`/`score`/`y`. Timestamps are JavaScript milliseconds.

## Dependencies

- `arcane/components/chart.html`
- `arcane/modules/ChartLibrary.js`
- Bundled uPlot JavaScript and CSS under `arcane/modules/`
- `arcane/modules/HTMLImport.js`
- `arcane/css/layout.css`
