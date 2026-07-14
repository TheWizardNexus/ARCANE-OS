# Readiness and load-timing contract

Arcane code must not depend on scripts, modules, entities, components, services, or other system processes loading in one particular order. A dependency may already be ready before its consumer loads, or it may become ready afterward.

Arcane handles both cases with a dual readiness check:

1. **Readiness event:** listen for the dependency's ready event so the consumer can wait for future initialization.
2. **Persistent `.ready` state:** check the dependency on the appropriate global or component scope so the consumer can immediately use something that became ready before the current code loaded.

Both checks are required. An event represents the transition to ready; `.ready` records the resulting state.

## Why both checks are required

An event alone is not enough. Browser events are not replayed for listeners that subscribe later. If `ai-ready` fired before a consumer loaded, that consumer would wait forever unless it also checked `window.ai.ready`.

A `.ready` check alone is also not enough. If the dependency is still initializing, the consumer needs an event that tells it when to try again. Polling, guessed delays, and assumed script order are not substitutes for that signal.

The contract therefore covers both possible load orders:

| Dependency state when consumer loads | Mechanism that continues initialization |
|---|---|
| Already ready | The consumer sees `.ready === true` and continues immediately. |
| Not ready yet | The consumer receives the ready event, verifies `.ready`, and continues then. |

## Producer contract

Every asynchronously initialized Arcane dependency must expose both parts of the contract.

For a global module, entity, service, or process:

```js
window.ai=ai;

// Finish all required initialization first.
await ai.configure();

// Record the state before announcing the transition.
ai.ready=true;
window.dispatchEvent(new CustomEvent('ai-ready',{detail:{ai}}));
```

For an imported component:

```js
// Install the component's public methods and finish initialization first.
host.configure=configure;
host.render=render;

// Record the state before announcing the transition.
host.ready=true;
host.dispatchEvent(new CustomEvent('example-ready',{
    bubbles:true,
    composed:true
}));
```

Producers must follow these rules:

- Initialize public state and methods before setting `.ready`.
- Set `.ready=true` before dispatching the ready event.
- Dispatch the ready event only when the dependency is actually usable.
- Use a stable, documented event name such as `ai-ready`, `dbopfs-ready`, `user-entity-loaded`, or `<component-name>-ready`.
- Put the ready object in `event.detail` when that helps consumers avoid another lookup, while keeping the persistent scoped object authoritative.
- If a dependency can stop being ready, set `.ready=false` before teardown and document whether it can later emit another ready event.

## Consumer contract

Consumers must install the event listener and check the persistent state. The event handler and immediate check should share one guarded, idempotent function.

### Global module, entity, service, or process

```js
function initializeWhenAIIsReady(){
    if(!window.ai?.ready){
        return false;
    }

    window.removeEventListener('ai-ready',initializeWhenAIIsReady);
    initializeFeature(window.ai);
    return true;
}

window.addEventListener('ai-ready',initializeWhenAIIsReady);
initializeWhenAIIsReady();
```

The listener is registered before the immediate check. This closes the small race in which the dependency could become ready after an initial check but before the listener was attached.

When a promise is more convenient:

```js
function waitForAI(){
    return new Promise(resolve=>{
        function complete(){
            if(!window.ai?.ready){
                return;
            }

            window.removeEventListener('ai-ready',complete);
            resolve(window.ai);
        }

        window.addEventListener('ai-ready',complete);
        complete();
    });
}
```

### Imported component

Use the shared `arcane/modules/WaitForComponent.js` helper for asynchronously imported components:

```js
import waitForComponent from './arcane/modules/WaitForComponent.js';

const panel=await waitForComponent(
    document.querySelector('#outputPanel'),
    {
        property:'ready',
        event:'output-panel-ready',
        methods:['configure','setBody']
    }
);
```

The helper subscribes to the component event and then checks its persistent readiness state and required methods. It therefore handles a component that finished importing either before or after the caller ran.

For a small component consumer that does not need the helper:

```js
function configurePanel(){
    if(panel.ready!==true||typeof panel.configure!=='function'){
        return false;
    }

    panel.removeEventListener('output-panel-ready',configurePanel);
    panel.configure(options);
    return true;
}

panel.addEventListener('output-panel-ready',configurePanel);
configurePanel();
```

## Multiple dependencies

When work depends on several objects, every relevant ready event may call the same guarded function. The function proceeds only after all persistent readiness checks pass.

```js
function populateUI(){
    if(!window.dbopfs?.ready||!window.user?.ready||!window.ai?.ready){
        return false;
    }

    renderApplication({
        database:window.dbopfs,
        user:window.user,
        ai:window.ai
    });
    return true;
}

window.addEventListener('dbopfs-ready',populateUI);
window.addEventListener('user-entity-loaded',populateUI);
window.addEventListener('ai-ready',populateUI);
populateUI();
```

The work itself must be idempotent or protected by its own initialization state because more than one readiness path can call the guard.

## Scope of `.ready`

Check readiness on the object that owns the lifecycle:

- Global module, entity, service, or process: `window.<name>.ready` or `globalThis.<name>.ready`.
- Imported HTML component: the component host element's `.ready` property.
- Locally owned instance: the instance's documented `.ready` property.

Do not create a separate app-local readiness flag for a shared dependency. The owning object is the persistent source of truth, and its ready event is the transition signal.

## Avoid these timing failures

- Do not rely only on a ready event; late consumers will miss it.
- Do not rely only on `.ready`; early consumers will not know when it changes.
- Do not assume document order, module import order, `DOMContentLoaded`, or `load` proves a dependency is initialized.
- Do not use arbitrary `setTimeout` delays as readiness.
- Do not poll when the dependency can emit a ready event.
- Do not dispatch the event before setting `.ready=true` and installing the public API.
- Do not perform initialization twice when both the event and immediate check reach the same code.
- Do not treat the existence of `window.<name>` or a component element as proof that it is ready.

## Verification checklist

Every readiness contract should be tested in both load orders:

1. The dependency becomes ready first; load the consumer afterward and verify the `.ready` path initializes it.
2. The consumer loads first; make the dependency ready afterward and verify the event path initializes it.
3. Trigger both paths close together and verify initialization happens only as intended.
4. Verify `.ready` is set before the ready event is observed.
5. For components, verify the documented public methods exist when readiness is reported.
6. For multiple dependencies, vary their completion order and verify work starts only after all are ready.

This dual system is the Arcane load-timing rule: **listen for readiness that has not happened yet, and check persistent readiness that may have happened already.**
