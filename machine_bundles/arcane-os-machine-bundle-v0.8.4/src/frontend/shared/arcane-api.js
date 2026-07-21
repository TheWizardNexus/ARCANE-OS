(function installArcane(global) {
  'use strict';

  const PROTOCOL = 'arcane/1';
  const LONG_OPERATION_TIMEOUT = 50 * 60 * 1000;
  const pending = new Map();
  const listeners = new Map();
  const completedEvents = new Map();
  const completionEventNames = new Set(['core.ready', 'transport.ready']);
  let transport = null;

  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function hresultFrom(value) {
    const match = String(value || '').match(/\b0x[0-9a-f]{8}\b/i);
    return match ? match[0].toUpperCase() : null;
  }

  class ArcaneError extends Error {
    constructor(value) {
      const source = value && typeof value === 'object' ? value : { message: String(value || 'Arcane operation failed.') };
      super(source.message || source.userMessage || 'Arcane operation failed.');
      this.name = 'ArcaneError';
      Object.assign(this, source);
      this.code = typeof source.code === 'string' && source.code ? source.code : 'ARCANE_ERROR';
      this.resolution = source.resolution || null;
      this.diagnosticId = source.diagnosticId || null;
      this.technicalMessage = source.technicalMessage || source.message || null;
      this.hresult = source.hresult || hresultFrom(source.message) || null;
      this.causeName = source.causeName || (source.name && source.name !== 'ArcaneError' ? source.name : null);
      this.stack = source.stack || this.stack;
    }
  }

  function emit(eventName, data) {
    const group = listeners.get(eventName);
    if (group) for (const listener of [...group]) {
      try { listener(data); } catch (error) { console.error('Arcane event listener failed', error); }
    }
    const all = listeners.get('*');
    if (all) for (const listener of [...all]) {
      try { listener({ event: eventName, data: data }); } catch (error) { console.error('Arcane event listener failed', error); }
    }
  }

  function receive(input) {
    let message = input;
    if (typeof message === 'string') {
      try { message = JSON.parse(message); }
      catch (error) { console.error('Arcane received invalid native JSON.', error, input); return; }
    }
    if (!message || message.protocol !== PROTOCOL) return;

    if (message.type === 'event') {
      const data = Object.prototype.hasOwnProperty.call(message, 'data') ? message.data : {};
      if (completionEventNames.has(message.event)) complete(message.event, data);
      else emit(message.event, data);
      return;
    }
    if (message.type !== 'response' || !message.id) return;

    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.result);
    else request.reject(new ArcaneError(message.error));
  }

  Object.defineProperty(global, '__arcaneReceive', {
    value: receive,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  class WebView2Transport {
    constructor() {
      this.name = 'webview2';
      this.bridge = global.chrome.webview.hostObjects.arcaneBridge;
      global.chrome.webview.addEventListener('message', function onNativeMessage(event) {
        receive(event.data);
      });
    }
    async send(request) {
      let acknowledgement;
      try {
        acknowledgement = await this.bridge.Send(JSON.stringify(request));
      } catch (error) {
        throw new ArcaneError({
          code: 'ARCANE_BRIDGE_CALL_FAILED',
          message: 'Arcane could not communicate with its native host.',
          resolution: 'Close Arcane, reopen the provisioner, and try again. If this continues, reinstall the complete Arcane bundle so the executable and app files match.',
          technicalMessage: error && error.message || String(error),
          hresult: hresultFrom(error && error.message || error),
          causeName: error && error.name || null,
          method: request && request.method || null,
          transport: 'webview2',
          stack: error && error.stack || null,
        });
      }
      if (acknowledgement) {
        let parsed = acknowledgement;
        if (typeof parsed === 'string') {
          try { parsed = JSON.parse(parsed); } catch (_) { parsed = null; }
        }
        if (parsed && parsed.accepted === false) throw new ArcaneError(parsed.error || { code: 'BRIDGE_REJECTED', message: 'The Arcane native bridge rejected the request.' });
      }
    }
  }

  class WebKitGtkTransport {
    constructor() {
      this.name = 'webkitgtk';
    }

    async send(request) {
      const handler = global.webkit.messageHandlers.arcane;
      let acknowledgement = await handler.postMessage(JSON.stringify(request));
      if (typeof acknowledgement === 'string') {
        try { acknowledgement = JSON.parse(acknowledgement); } catch (_) { acknowledgement = null; }
      }
      if (acknowledgement && acknowledgement.accepted === false) {
        throw new ArcaneError(acknowledgement.error || { code: 'BRIDGE_REJECTED', message: 'The Arcane native bridge rejected the request.' });
      }
    }
  }

  function immutableCompletionSnapshot(value) {
    if (value === null || typeof value !== 'object') return value;
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return Object.freeze({});
    const snapshot = JSON.parse(serialized);
    const queue = [snapshot];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (!current || typeof current !== 'object' || Object.isFrozen(current)) continue;
      for (const child of Object.values(current)) {
        if (child && typeof child === 'object') queue.push(child);
      }
      Object.freeze(current);
    }
    return snapshot;
  }

  function complete(eventName, data) {
    if (!completionEventNames.has(eventName) || completedEvents.has(eventName)) return false;
    const snapshot = immutableCompletionSnapshot(data);
    completedEvents.set(eventName, snapshot);
    emit(eventName, snapshot);
    return true;
  }

  class AndroidWebViewTransport {
    constructor() {
      this.name = 'android-webview';
      this.bridge = global.arcaneAndroid;
      this.bridge.onmessage = function onAndroidNativeMessage(message) {
        receive(message && typeof message === 'object' && 'data' in message ? message.data : message);
      };
    }

    async send(request) {
      try {
        await this.bridge.postMessage(JSON.stringify(request));
      } catch (error) {
        throw new ArcaneError(
          {
            code: 'ARCANE_ANDROID_BRIDGE_CALL_FAILED',
            message: 'Arcane could not communicate with its Android host.',
            resolution: 'Close Arcane, reopen the launcher, and try again.',
            technicalMessage: error && error.message || String(error),
            causeName: error && error.name || null,
            method: request && request.method || null,
            transport: 'android-webview',
            stack: error && error.stack || null,
          }
        );
      }
    }
  }

  class DevelopmentHttpTransport {
    constructor() {
      this.name = 'development-http';
      if (typeof EventSource === 'function') {
        this.events = new EventSource('/events');
        this.events.onmessage = function (event) { receive(event.data); };
      }
    }
    async send(request) {
      const response = await fetch('/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const payload = await response.json().catch(function () { return null; });
      if (!response.ok) throw new ArcaneError(payload && payload.error || { code: 'DEV_BRIDGE_FAILED', message: 'The Arcane development bridge failed.' });
      if (payload && payload.type === 'response') receive(payload);
    }
  }

  function chooseTransport() {
    if (global.chrome && global.chrome.webview && global.chrome.webview.hostObjects) return new WebView2Transport();
    if (global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.arcane) return new WebKitGtkTransport();
    if (global.arcaneAndroid && typeof global.arcaneAndroid.postMessage === 'function') {
      return new AndroidWebViewTransport();
    }
    if (global.__ARCANE_DEV_HTTP__) return new DevelopmentHttpTransport();
    throw new ArcaneError({
      code: 'ARCANE_TRANSPORT_UNAVAILABLE',
      message: 'This interface is not connected to an Arcane native host.',
      resolution: 'Open it through ArcaneShell or ArcaneProvisioner, or use the development launcher.',
    });
  }

  function ensureTransport() {
    if (!transport) {
      transport = chooseTransport();
      complete('transport.ready', { protocol: PROTOCOL, transport: transport.name });
    }
    return transport;
  }

  async function invoke(method, parameters, options) {
    const selectedTransport = ensureTransport();
    const id = uuid();
    const timeoutMs = Number(options && options.timeoutMs || 10 * 60 * 1000);
    const request = {
      protocol: PROTOCOL,
      type: 'request',
      id: id,
      method: String(method),
      parameters: parameters && typeof parameters === 'object' ? parameters : {},
      sentAt: new Date().toISOString(),
    };

    const promise = new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        pending.delete(id);
        reject(new ArcaneError({
          code: 'ARCANE_REQUEST_TIMEOUT',
          message: 'Arcane did not finish this operation before the request timed out.',
          resolution: 'Open diagnostics to see the last reported step, then try again.',
          method: method,
        }));
      }, timeoutMs);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer, method: method });
    });

    try { await selectedTransport.send(request); }
    catch (error) {
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(error instanceof ArcaneError ? error : new ArcaneError(error));
      }
    }
    return promise;
  }

  const events = Object.freeze({
    on: function on(eventName, listener) {
      if (typeof listener !== 'function') throw new TypeError('Arcane event listener must be a function.');
      const group = listeners.get(eventName) || new Set();
      group.add(listener);
      listeners.set(eventName, group);
      return function unsubscribe() { group.delete(listener); };
    },
    once: function once(eventName, listener) {
      let unsubscribe = null;
      unsubscribe = events.on(eventName, function oneShot(value) {
        if (unsubscribe) unsubscribe();
        listener(value);
      });
      return unsubscribe;
    },
    when: function when(eventName, listener) {
      if (!completionEventNames.has(eventName)) throw new TypeError('Arcane completion event is not designated as durable.');
      if (typeof listener !== 'function') throw new TypeError('Arcane event listener must be a function.');
      if (!completedEvents.has(eventName)) return events.once(eventName, listener);
      const value = completedEvents.get(eventName);
      let active = true;
      Promise.resolve().then(function replayCompletedEvent() {
        if (!active) return;
        try { listener(value); } catch (error) { console.error('Arcane event listener failed', error); }
      });
      return function unsubscribe() { active = false; };
    },
    completed: function completed(eventName) {
      return completionEventNames.has(eventName) && completedEvents.has(eventName);
    },
  });

  function ollamaInvoke(operation, request, options) {
    const input = request && typeof request === 'object' ? Object.assign({}, request) : {};
    const onChunk = typeof options === 'function' ? options : options && options.onChunk;
    const timeoutMs = Number(options && options.timeoutMs || (/^(pull|push|create)$/.test(operation) ? LONG_OPERATION_TIMEOUT : 10 * 60 * 1000));
    function send() {
      switch (operation) {
        case 'generate': return invoke('ollama.generate', input, { timeoutMs: timeoutMs });
        case 'chat': return invoke('ollama.chat', input, { timeoutMs: timeoutMs });
        case 'pull': return invoke('ollama.pull', input, { timeoutMs: timeoutMs });
        case 'push': return invoke('ollama.push', input, { timeoutMs: timeoutMs });
        case 'create': return invoke('ollama.create', input, { timeoutMs: timeoutMs });
        default: throw new TypeError('Unsupported streaming Ollama operation.');
      }
    }
    if (typeof onChunk !== 'function') return send();
    const streamId = uuid();
    input.stream = true;
    input.streamId = streamId;
    const unsubscribe = events.on('ollama.chunk', function onOllamaChunk(event) {
      if (event && event.streamId === streamId) onChunk(event.chunk, { operation: operation, streamId: streamId });
    });
    return send().finally(unsubscribe);
  }

  const Arcane = Object.freeze({
    protocol: PROTOCOL,
    Error: ArcaneError,
    events: events,
    ai: Object.freeze({
      models: function () { return invoke('ai.models'); },
      chat: function (request) { return invoke('ai.chat', request || {}, { timeoutMs: 130000 }); },
      profile: function () { return invoke('ai.profile.current'); },
      providerSettings: function () { return invoke('ai.provider.settings.get'); },
      saveProviderSettings: function (settings) { return invoke('ai.provider.settings.set', settings || {}, { timeoutMs: 130000 }); },
      providerModels: function () { return invoke('ai.provider.models', {}, { timeoutMs: 130000 }); },
    }),
    ollama: Object.freeze({
      version: function () { return invoke('ollama.version'); },
      models: function () { return invoke('ollama.models'); },
      list: function () { return invoke('ollama.models'); },
      running: function () { return invoke('ollama.running'); },
      show: function (model, options) { return invoke('ollama.show', Object.assign({}, options || {}, { model: String(model || '') })); },
      generate: function (request, options) { return ollamaInvoke('generate', request, options); },
      chat: function (request, options) { return ollamaInvoke('chat', request, options); },
      embed: function (request) { return invoke('ollama.embed', request || {}, { timeoutMs: 10 * 60 * 1000 }); },
      pull: function (model, options, streamOptions) { return ollamaInvoke('pull', Object.assign({}, options || {}, { model: String(model || '') }), streamOptions); },
      push: function (model, options, streamOptions) { return ollamaInvoke('push', Object.assign({}, options || {}, { model: String(model || '') }), streamOptions); },
      create: function (request, options) { return ollamaInvoke('create', request, options); },
      copy: function (source, destination) { return invoke('ollama.copy', { source: String(source || ''), destination: String(destination || '') }, { timeoutMs: 2 * 60 * 1000 }); },
      delete: function (model) { return invoke('ollama.delete', { model: String(model || '') }, { timeoutMs: 2 * 60 * 1000 }); },
      selection: function () { return invoke('ollama.selection.get'); },
      select: function (preference) { return invoke('ollama.selection.set', { preference: String(preference || 'auto') }, { timeoutMs: LONG_OPERATION_TIMEOUT }); },
      settings: function () { return invoke('ollama.settings.get'); },
      saveSettings: function (settings) { return invoke('ollama.settings.set', settings || {}, { timeoutMs: LONG_OPERATION_TIMEOUT }); },
      createBrain: function (definition) { return invoke('ollama.brain.create', definition || {}, { timeoutMs: LONG_OPERATION_TIMEOUT }); },
      serviceSettings: function () { return invoke('ollama.service.settings.get'); },
      saveServiceSettings: function (settings) { return invoke('ollama.service.settings.set', settings || {}, { timeoutMs: LONG_OPERATION_TIMEOUT }); },
    }),
    app: Object.freeze({ current: function () { return invoke('app.current'); } }),
    applications: Object.freeze({
      list: function () { return invoke('apps.list'); },
      launch: function (id) { return invoke('apps.launch', { id: id }); },
    }),
    external: Object.freeze({
      open: function (uri) { return invoke('external.open', { uri: String(uri || '') }); },
    }),
    terminal: Object.freeze({
      start: function (options) {
        const source = options && typeof options === 'object' ? options : {};
        return invoke('terminal.start', {
          shell: String(source.shell || 'auto'),
          cwd: String(source.cwd || ''),
          columns: Number(source.columns || 120),
          rows: Number(source.rows || 32),
        });
      },
      list: function () { return invoke('terminal.list'); },
      write: function (sessionId, data) { return invoke('terminal.write', { sessionId: String(sessionId || ''), data: String(data ?? '') }); },
      resize: function (sessionId, columns, rows) { return invoke('terminal.resize', { sessionId: String(sessionId || ''), columns: Number(columns), rows: Number(rows) }); },
      signal: function (sessionId, signal) { return invoke('terminal.signal', { sessionId: String(sessionId || ''), signal: String(signal || 'interrupt') }); },
      close: function (sessionId) { return invoke('terminal.close', { sessionId: String(sessionId || '') }); },
    }),
    capabilities: Object.freeze({ list: function () { return invoke('capabilities.list'); } }),
    platform: Object.freeze({ status: function () { return invoke('platform.status'); } }),
    permissions: Object.freeze({ status: function () { return invoke('permissions.status'); } }),
    version: Object.freeze({ current: function () { return invoke('version.current'); }, installation: function () { return invoke('installation.status'); } }),
    machine: Object.freeze({ status: function () { return invoke('machine.status'); } }),
    user: Object.freeze({ current: function () { return invoke('user.current'); } }),
    requirements: Object.freeze({
      list: function () { return invoke('requirements.list'); },
      ensure: function (requirementIds) { return invoke('requirements.ensure', { requirementIds: Array.isArray(requirementIds) ? requirementIds : null }, { timeoutMs: LONG_OPERATION_TIMEOUT }); },
    }),
    installation: Object.freeze({
      status: function () { return invoke('installation.status'); },
      ensure: function () { return invoke('installation.ensure', {}, { timeoutMs: LONG_OPERATION_TIMEOUT }); },
    }),
    users: Object.freeze({
      list: function () { return invoke('users.list'); },
      validate: function (usernames) { return invoke('users.validate', { usernames: Array.isArray(usernames) ? usernames : [usernames] }); },
      add: function (usernames) { return invoke('users.add', { usernames: Array.isArray(usernames) ? usernames : [usernames] }, { timeoutMs: LONG_OPERATION_TIMEOUT }); },
      activate: function (username) { return invoke('users.activate', { username: String(username || '').trim() }, { timeoutMs: LONG_OPERATION_TIMEOUT }); },
      resetPassword: function (username) { return invoke('users.resetPassword', { username: String(username || '').trim() }, { timeoutMs: LONG_OPERATION_TIMEOUT }); },
      applyPassword: function (username, temporaryPassword) { return invoke('users.applyPassword', { username: String(username || '').trim(), temporaryPassword: String(temporaryPassword || '') }, { timeoutMs: LONG_OPERATION_TIMEOUT }); },
      verifyShell: function (username) { return invoke('users.verifyShell', { username: String(username || '').trim() }, { timeoutMs: LONG_OPERATION_TIMEOUT }); },
      restoreShell: function (username) { return invoke('users.restoreShell', { username: String(username || '').trim() }, { timeoutMs: LONG_OPERATION_TIMEOUT }); },
    }),
    system: Object.freeze({
      lock: function () { return invoke('system.lock'); },
      ping: function () { return invoke('system.ping', {}, { timeoutMs: 10000 }); },
      metrics: function () { return invoke('system.metrics'); },
    }),
    network: Object.freeze({ status: function () { return invoke('network.status'); } }),
    filesystem: Object.freeze({
      selectDirectory: function (options) {
        const source = options == null ? {} : options;
        if (typeof source !== 'object' || Array.isArray(source)) throw new TypeError('Arcane directory selection options must be an object.');
        return invoke('filesystem.directory.select', Object.assign({}, source), { timeoutMs: LONG_OPERATION_TIMEOUT });
      },
    }),
    storage: Object.freeze({
      list: function () { return invoke('storage.list'); },
      get: function (key) { return invoke('storage.get', { key: String(key || '').trim() }); },
      set: function (key, value) { return invoke('storage.set', { key: String(key || '').trim(), value: value }); },
      delete: function (key) { return invoke('storage.delete', { key: String(key || '').trim() }); },
    }),
    preferences: Object.freeze({
      list: function () { return invoke('preferences.list'); },
      get: function (key) { return invoke('preferences.get', { key: String(key || '').trim() }); },
      set: function (key, value) { return invoke('preferences.set', { key: String(key || '').trim(), value: value }); },
      delete: function (key) { return invoke('preferences.delete', { key: String(key || '').trim() }); },
    }),
    appearance: Object.freeze({
      current: function () { return invoke('appearance.current'); },
      apply: function (appearance) { return invoke('appearance.apply', appearance || {}); },
    }),
    session: Object.freeze({ logout: function () { return invoke('session.logout'); } }),
    provisioning: Object.freeze({
      plan: function (usernames) { return invoke('provisioning.plan', { usernames: Array.isArray(usernames) ? usernames : [usernames].filter(Boolean) }); },
    }),
    diagnostics: Object.freeze({
      recentErrors: function () { return invoke('diagnostics.recent'); },
      get: function (diagnosticId) { return invoke('diagnostics.get', { diagnosticId: diagnosticId }); },
    }),
    development: Object.freeze({
      inspect: function (root) { return invoke('development.inspect', { root: String(root || '') }); },
      context: function (root, query) { return invoke('development.context', { root: String(root || ''), query: String(query || '') }, { timeoutMs: 130000 }); },
      setup: function (root, taskId) { return invoke('development.setup', { root: String(root || ''), taskId: String(taskId || '') }, { timeoutMs: LONG_OPERATION_TIMEOUT }); },
      installNode: function () { return invoke('development.node.install', {}, { timeoutMs: LONG_OPERATION_TIMEOUT }); },
    }),
  });

  Object.defineProperty(global, 'Arcane', {
    value: Arcane,
    enumerable: true,
    configurable: false,
    writable: false,
  });

  try {
    ensureTransport();
  } catch (error) {
    if (!(error instanceof ArcaneError) || error.code !== 'ARCANE_TRANSPORT_UNAVAILABLE') {
      console.error('Arcane transport initialization failed', error);
    }
  }
})(window);
