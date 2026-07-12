(function installArcane(global) {
  'use strict';

  const PROTOCOL = 'arcane/1';
  const LONG_OPERATION_TIMEOUT = 50 * 60 * 1000;
  const pending = new Map();
  const listeners = new Map();
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
      emit(message.event, message.data || {});
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
          message: 'Arcane could not communicate with its Windows host.',
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

  class DevelopmentHttpTransport {
    constructor() {
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
    if (global.__ARCANE_DEV_HTTP__) return new DevelopmentHttpTransport();
    throw new ArcaneError({
      code: 'ARCANE_TRANSPORT_UNAVAILABLE',
      message: 'This interface is not connected to an Arcane native host.',
      resolution: 'Open it through ArcaneShell or ArcaneProvisioner, or use the development launcher.',
    });
  }

  async function invoke(method, parameters, options) {
    if (!transport) transport = chooseTransport();
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

    try { await transport.send(request); }
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
  });

  const Arcane = Object.freeze({
    protocol: PROTOCOL,
    Error: ArcaneError,
    events: events,
    app: Object.freeze({ current: function () { return invoke('app.current'); } }),
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
      restoreShell: function (username) { return invoke('users.restoreShell', { username: String(username || '').trim() }, { timeoutMs: LONG_OPERATION_TIMEOUT }); },
    }),
    system: Object.freeze({
      lock: function () { return invoke('system.lock'); },
      ping: function () { return invoke('system.ping', {}, { timeoutMs: 10000 }); },
      metrics: function () { return invoke('system.metrics'); },
    }),
    network: Object.freeze({ status: function () { return invoke('network.status'); } }),
    storage: Object.freeze({
      list: function () { return invoke('storage.list'); },
      get: function (key) { return invoke('storage.get', { key: String(key || '').trim() }); },
      set: function (key, value) { return invoke('storage.set', { key: String(key || '').trim(), value: value }); },
      delete: function (key) { return invoke('storage.delete', { key: String(key || '').trim() }); },
    }),
    session: Object.freeze({ logout: function () { return invoke('session.logout'); } }),
    provisioning: Object.freeze({
      plan: function (usernames) { return invoke('provisioning.plan', { usernames: Array.isArray(usernames) ? usernames : [usernames].filter(Boolean) }); },
    }),
    diagnostics: Object.freeze({
      recentErrors: function () { return invoke('diagnostics.recent'); },
      get: function (diagnosticId) { return invoke('diagnostics.get', { diagnosticId: diagnosticId }); },
    }),
  });

  Object.defineProperty(global, 'Arcane', {
    value: Arcane,
    enumerable: true,
    configurable: false,
    writable: false,
  });
})(window);
