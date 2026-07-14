# Arcane AI module

`arcane/modules/AI.js` provides browser-side chat completion, streaming, text-to-speech, and speech-to-text helpers. It publishes the `window.ai` singleton and dispatches `ai-ready` after the user profile has supplied its preferred provider and model settings.

The module intentionally starts without a hosted-provider credential. A parent application may supply an OpenAI key at runtime through `globalThis.arcane.config.openAI.apiKey` before importing the module, or assign `ai.license` from a user-owned profile after initialization. Never place a real key in a tracked HTML or JavaScript file. A selected local Ollama provider does not require an OpenAI key.

## Safe request pattern

```js
import './arcane/modules/AI.js'

window.addEventListener('ai-ready',async event => {
    const ai=event.detail.db

    if(!ai.configured){
        console.info('Select an AI provider before sending a request.')
        return
    }

    try{
        await ai.fetch(
            [{ role:'user',content:'Hello, AI.' }],
            response => {
                const text=response?.choices?.[0]?.message?.content||''
                console.log('AI reply:',text)
            }
        )
    }catch(error){
        console.warn('The configured AI service could not respond.',error.code)
    }
})
```

All network methods return promises. Await them so provider configuration, network, HTTP, and callback failures can be handled by the parent application.

## Public methods

- `setAI(...)` applies provider and model selections.
- `fetch(...)` performs a non-streaming chat request.
- `streamMessage(...)` streams chat content and tool calls.
- `fetchSTT(...)` submits audio for transcription.
- `streamTTS(...)` queues text for speech playback.
- `stopAudio()` stops active speech playback.

The runnable page in this directory demonstrates the same guarded request flow. It requires a parent/user profile to select a provider before the Ask button can reach a service.
