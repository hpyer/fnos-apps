(() => {
  const base = new URL(document.currentScript.src).pathname.replace(/\/_fnos\/subpath\.js$/, '');
  const managerBase = base.slice(0, base.lastIndexOf('/'));
  function resourceUrl(value) {
    const text = String(value);
    const url = new URL(text, location.href);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.host !== location.host) return text;
    if (url.pathname === managerBase || url.pathname.startsWith(`${managerBase}/`)) return text;
    url.pathname = base + url.pathname;
    return url.href;
  }
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const request = input instanceof Request ? new Request(resourceUrl(input.url), input) : new Request(resourceUrl(input));
    const next = new Request(request, init);
    if (new URL(next.url).origin === location.origin && new URL(next.url).pathname.startsWith(`${base}/`)) {
      next.headers.set('X-Fnos-Request', '1');
    }
    return originalFetch(next);
  };
  for (const name of ['WebSocket', 'EventSource', 'Worker', 'SharedWorker']) {
    const Native = globalThis[name];
    if (Native) globalThis[name] = new Proxy(Native, { construct(Target, args) {
      args[0] = resourceUrl(args[0]);
      return Reflect.construct(Target, args);
    } });
  }
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const mapped = resourceUrl(url);
    this.__fnosLocal = new URL(mapped, location.href).origin === location.origin && new URL(mapped, location.href).pathname.startsWith(`${base}/`);
    return open.call(this, method, mapped, ...rest);
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__fnosLocal) this.setRequestHeader('X-Fnos-Request', '1');
    return send.apply(this, args);
  };
  // DSH's module loader assigns script.src from its boot graph; plugins also
  // create images, styles and frames dynamically. Map before the browser loads.
  for (const [name, prop] of [['HTMLScriptElement', 'src'], ['HTMLLinkElement', 'href'], ['HTMLImageElement', 'src'], ['HTMLIFrameElement', 'src'], ['HTMLMediaElement', 'src'], ['HTMLSourceElement', 'src'], ['HTMLAnchorElement', 'href'], ['HTMLFormElement', 'action']]) {
    const proto = globalThis[name]?.prototype;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (descriptor?.set) Object.defineProperty(proto, prop, { ...descriptor, set(value) { descriptor.set.call(this, resourceUrl(value)); } });
  }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    return setAttribute.call(this, name, /^(src|href|action|poster)$/i.test(name) ? resourceUrl(value) : value);
  };
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name].bind(history);
    history[name] = (state, unused, url) => original(state, unused, url == null ? url : resourceUrl(url));
  }
})();
