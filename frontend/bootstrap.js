// This bootstrap must work when the application bundle and styles are absent.
// Its exact built bytes receive a CSP hash from the static resource service.
(function (window, document) {
  'use strict';
  var cssWait = 10000, moduleWait = 15000, maxRetries = 2;
  var cssAttempts = 0, moduleAttempts = 0, cssFailed = false, moduleFailed = false;
  var cssDeadline = 0, moduleDeadline = 0, timer = 0;
  var moduleReady = false, mounting = false, completed = false, started = false, mount;
  var probe, entry, entryURL, locale = 'zh-CN';
  try { locale = window.localStorage.getItem('gotty-hub.locale') || locale; } catch (_) {}
  var en = locale === 'en-US';
  function element(id) { return document.getElementById(id); }
  function message(failed) {
    var boot = element('hub-boot'), text = element('hub-boot-message'), retry = element('hub-boot-retry');
    if (!boot) return;
    boot.hidden = false;
    boot.dataset.state = failed ? 'error' : 'loading';
    if (text) text.textContent = failed
      ? (en ? 'Page resources could not be loaded. Retry or reload the page.' : '页面资源加载失败，请重试或重新加载。')
      : (en ? 'Loading terminal workspace…' : '正在加载终端工作台…');
    if (retry) { retry.hidden = !failed || mounting; retry.textContent = en ? 'Retry' : '重试'; }
    var reload = element('hub-boot-reload');
    if (reload) reload.textContent = en ? 'Reload page' : '重新加载';
  }
  function stylesReady() {
    if (window.getComputedStyle(document.documentElement).getPropertyValue('--hub-app-css').trim() !== 'ready') return false;
    if (!probe) {
      probe = document.createElement('div'); probe.className = 'xterm'; probe.hidden = true;
      var textarea = document.createElement('textarea'); textarea.className = 'xterm-helper-textarea';
      textarea.tabIndex = -1; probe.appendChild(textarea); document.body.appendChild(probe);
    }
    var style = window.getComputedStyle(probe.firstChild);
    return style.position === 'absolute' && style.opacity === '0';
  }
  function retryURL(value, attempt) {
    var url = new URL(value, window.location.href);
    url.searchParams.set('hub_retry', String(Date.now()) + '-' + attempt);
    return url.href;
  }
  function retryStyles() {
    cssFailed = false; cssAttempts++; cssDeadline = Date.now() + cssWait;
    document.querySelectorAll('link[rel="stylesheet"]').forEach(function (link) {
      link.href = retryURL(link.href, cssAttempts);
    });
  }
  function retryModule() {
    moduleFailed = false; moduleAttempts++; moduleDeadline = Date.now() + moduleWait;
    if (!entryURL) return;
    var next = document.createElement('script'); next.type = 'module'; next.crossOrigin = 'anonymous';
    next.src = retryURL(entryURL, moduleAttempts);
    if (entry) entry.remove(); entry = next; document.head.appendChild(next);
  }
  function fail(kind) {
    if (completed && kind !== 'application') return;
    // A fatal React render also removes an already mounted workspace. Offer a
    // deliberate reload in that case; never silently reload live terminals.
    if (kind === 'application') {
      var root = element('root'); if (root) root.hidden = true;
      mounting = true;
    }
    window.clearInterval(timer); timer = 0;
    message(true);
    // No request headers, query strings, accounts, or terminal data are logged.
    window.console.warn('[GoTTY Hub] Page loading failed: ' + kind);
  }
  function tick() {
    if (completed || !document.body) return;
    var styled = stylesReady(), now = Date.now();
    if (!styled && (now >= cssDeadline || cssFailed)) {
      if (cssAttempts >= maxRetries) { fail('styles'); return; }
      retryStyles();
    }
    if (!moduleReady && (now >= moduleDeadline || moduleFailed)) {
      if (moduleAttempts >= maxRetries) { fail('application bundle'); return; }
      retryModule();
    }
    if (styled && moduleReady && !mounting) {
      mounting = true;
      // Optional font loading must not indefinitely hold the page hostage.
      var fonts = document.fonts ? document.fonts.ready : Promise.resolve();
      var fontTimer;
      Promise.race([Promise.resolve(fonts).catch(function () {}), new Promise(function (resolve) { fontTimer = window.setTimeout(resolve, 1500); })])
        .then(function () { window.clearTimeout(fontTimer); try { mount(); } catch (_) { fail('application'); } });
    }
  }
  function start() {
    if (completed || started) return;
    started = true; window.clearInterval(parserTimer);
    var candidates = document.querySelectorAll('script[type="module"][src]');
    entry = candidates[candidates.length - 1]; entryURL = entry && entry.src;
    cssDeadline = Date.now() + cssWait; moduleDeadline = Date.now() + moduleWait;
    var retry = element('hub-boot-retry');
    if (retry) retry.addEventListener('click', function () {
      if (completed || mounting) return;
      cssAttempts = moduleAttempts = 0; cssFailed = moduleFailed = false;
      message(false); retryStyles(); if (!moduleReady) retryModule();
      window.clearInterval(timer); timer = window.setInterval(tick, 100); tick();
    });
    message(false); timer = window.setInterval(tick, 100); tick();
  }
  window.addEventListener('error', function (event) {
    if (completed) return;
    var target = event.target;
    if (target && target.tagName === 'LINK' && target.rel === 'stylesheet') cssFailed = true;
    if (target && target.tagName === 'SCRIPT' && target.type === 'module' && target.src && !target.src.includes('/@')) moduleFailed = true;
  }, true);
  window.hubBoot = {
    run: function (callback) {
      // Late scripts and retry responses can race; mount React exactly once.
      if (moduleReady) return;
      moduleReady = true; mount = callback; if (started) tick();
    },
    complete: function () {
      if (!mounting || completed) return;
      completed = true; window.clearInterval(timer);
      if (probe) probe.remove();
      var root = element('root'), boot = element('hub-boot');
      if (root) root.hidden = false;
      if (boot) { boot.hidden = true; boot.dataset.state = 'ready'; }
    },
    fail: function () { fail('application'); },
  };
  var parserTimer;
  if (document.readyState === 'loading') {
    // Module execution and DOMContentLoaded may themselves be blocked by CSS.
    parserTimer = window.setInterval(function () { if (element('root')) start(); }, 25);
    document.addEventListener('DOMContentLoaded', start, {once: true});
  } else start();
})(window, document);
