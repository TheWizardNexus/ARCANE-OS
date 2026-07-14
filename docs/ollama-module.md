# Arcane Ollama module

Arcane applications can use the managed, machine-wide Ollama service without connecting directly to `localhost:11434`. Import the shared module and let the Arcane runtime enforce the application's declared capabilities.

## Arcane OS model

Arcane OS includes `arcane/models/Arcane-20B.Modelfile` and `arcane/models/Arcane-120B.Modelfile`. They create the durable `arcane:20b` and `arcane:120b` variants, while `arcane:latest` points to the user's effective choice through the machine-wide `ArcaneOllama` service.

On every production boot, both Arcane Provisioner and Arcane Shell start an asynchronous `ollama.model.ensure` operation after Core is ready. Automatic selection chooses 120B only when the native GPU inventory reliably reports a single GPU with at least 80,000,000,000 bytes of dedicated memory; otherwise it chooses 20B. This follows the published requirement that gpt-oss-120b fits on a single 80 GB GPU, while gpt-oss-20b can run with 16 GB of memory. The Shell's Settings dialog lets the user override Automatic with 20B or 120B. A manual 120B override is honored even on lower-memory hardware.

Only the effective variant is downloaded on demand. Arcane reports byte progress through `operation.progress`, creates the named variant when missing, selects it as `arcane:latest`, and verifies both names through the service API. Both interfaces show the operation in a floating progress notification without blocking boot. Switching variants from Settings uses the same notification and progress path.

The service is configured with the global `OLLAMA_MODELS` directory. Arcane clients never write model layers directly into that protected directory. A maintenance run follows the saved preference with `npm run model:ensure`, or can explicitly select a variant with `npm run model:ensure -- --model=20b` or `npm run model:ensure -- --model=120b`.

```js
import ollama from '/arcane/modules/Ollama.js'

const reply = await ollama.chatText({
  model: 'arcane:latest',
  messages: [{ role: 'user', content: 'Summarize this record.' }],
})
```

## Capabilities

Add only the capabilities the application needs to its `arcane-package.json` or Arcane app-catalog entry:

- `ai.inference` — `generate`, `chat`, and `embed`
- `ai.models.read` — `version`, `models`, `running`, and `show`
- `ai.models.manage` — `pull`, `push`, `create`, `copy`, and `delete`

The existing `Arcane.ai.chat()` and `Arcane.ai.models()` calls remain supported. New applications should prefer `Arcane.ollama` or this module when they need Ollama-specific features.

## Streaming

Pass an `onChunk` callback as the second argument to `chat`, `generate`, or `create`. For `pull` and `push`, pass it as the third argument because the second argument contains model options.

```js
await ollama.pull('gemma4', {}, {
  onChunk(chunk) {
    console.log(chunk.status, chunk.completed, chunk.total)
  },
})

await ollama.chat({
  model: 'gemma4',
  messages: [{ role: 'user', content: 'Hello' }],
}, {
  onChunk(chunk) {
    output.append(chunk.message?.content || '')
  },
})
```

Chunk callbacks run as `ollama.chunk` events arrive from Arcane Core. The returned promise resolves with Ollama's final chunk. All operations are bounded by Arcane request and response limits and remain restricted to the loopback ArcaneOllama service.

## API

The module exposes `version`, `models`/`list`, `running`, `show`, `generate`, `chat`, `embed`, `pull`, `push`, `create`, `copy`, `delete`, `selection`, `select`, `unload`, `generateText`, and `chatText`. The selection methods are restricted to Arcane Shell by Core policy. Request objects follow Ollama's native API field names; Arcane forces non-streaming mode unless a chunk callback is supplied.
