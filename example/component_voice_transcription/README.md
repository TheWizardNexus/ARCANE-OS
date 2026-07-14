# Arcane voice transcription component

## Overview

The shared voice transcription component records microphone segments, sends them through the configured speech-to-text service, renders the accumulated transcript, and delegates persistence and completion to its parent.

The example includes a separate synthetic callback button. It can demonstrate the parent contract without recording audio or sending a transcription request.

## Run the example

Serve the repository root over HTTP and open `/example/component_voice_transcription/`.

```powershell
python -m http.server 8000
```

Microphone recording requires a browser secure context such as HTTPS or localhost, microphone permission, and a configured speech-to-text provider. Use only a short non-sensitive phrase when testing live recording.

## Parent API demonstrated

The parent provides asynchronous save and completion callbacks:

```js
voice.save=async ({transcript,segment}) => {
    return saveWhereTheParentChooses({transcript,segment});
};

voice.complete=async ({transcript}) => {
    return finishTheParentWorkflow({transcript});
};
```

After `voice-transcription-ready`, labels can be customized:

```js
voice.configure({
    description:'Record a short non-sensitive test phrase.',
    transcriptionLabel:'Reusable voice transcription example',
    emptyLabel:'Example transcription appears here.',
    completeLabel:'Finish Example Transcript'
});
```

### Members and methods

| API | Purpose |
|---|---|
| `value` | Reads the accumulated transcript. |
| `configure(options)` | Changes description, accessibility text, empty text, and completion label. |
| `save({transcript, segment})` | Parent-provided callback after each transcribed segment. |
| `complete({transcript})` | Parent-provided callback when the user completes the transcription. |

### Events

| Event | Detail | Purpose |
|---|---|---|
| `voice-transcription-ready` | None | The parent can configure the component. |
| `voice-transcription-segment` | `{ text }` | A new segment was transcribed and saved. |
| `speech-transcription-complete` | `{ text }` | Compatibility event for a completed speech segment. |

## Dependencies

- `arcane/components/voice-transcription.html`
- `arcane/modules/AI.js`
- `arcane/modules/MD.js`
- `arcane/modules/HTMLImport.js`
- Browser microphone and `MediaRecorder` support for live recording
