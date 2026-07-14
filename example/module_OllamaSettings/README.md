# Ollama settings module example

`OllamaSettings.js` provides domain-neutral preference schemas for a model loaded at boot and for the global ArcaneOllama service. Apps render these schemas with the shared `preferences-form` component and persist them through the capability-gated Arcane API.

Custom brain names can be previewed with `arcaneBrainModelName(name)`. Actual creation uses `Arcane.ollama.createBrain()` so Arcane Core can pull the base, apply the verified Arcane model prompt, report progress, and write to the protected global model store.
