// Invoked by WORKSPACE_SUITE=rendering in workspace-regressions.cjs. Both pages
// view the SAME disposable PTY, with identical ANSI bytes and independent fonts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {PNG} = require('../frontend/node_modules/pngjs');

const fixture = '\x1b[0m\x1b[2J\x1b[H\x1b[?25l' + [
  'Clarity fixture 0123456789 #@ ilMW',
  'Normal  \x1b[1mBold 0123456789 #@ ilMW\x1b[0m',
  '\x1b[48;5;22m+ const added = "Hello";       \x1b[0m',
  '\x1b[48;5;52m- const removed = "world";     \x1b[0m',
  '中文测试 终端清晰度 λ →',
  '┌──────────────────────────┐',
  '│ box drawing  ─ │ ┼       │',
  '└──────────────────────────┘',
].join('\r\n') + '\r\n';

function compare(a, b) {
  const first = PNG.sync.read(a), second = PNG.sync.read(b);
  assert.equal(first.width, second.width); assert.equal(first.height, second.height);
  let different = 0, ink = 0;
  for (let i = 0; i < first.data.length; i += 4) {
    const delta = Math.max(...[0, 1, 2].map(c => Math.abs(first.data[i + c] - second.data[i + c])));
    if (delta > 0) different++;
    if (Math.max(first.data[i], first.data[i + 1], first.data[i + 2]) > 130) ink++;
  }
  assert(ink > 1500, 'blank or missing terminal fixture');
  return different / (first.width * first.height);
}

module.exports = async ({page, context, browser, hub, ids, devices, api, wait, sleep, dir, report, installInspection, errors}) => {
  const settings = {schemaVersion: 1, theme: 'nord', fontSize: 14, fontId: 'dejavu-sans-mono'};
  await api('/me/terminal-settings', {revision: 0, settings}, 'PUT');
  // Only one mounted terminal is needed; avoid exhausting the GPU context quota.
  await api('/me/preferences', {opened: [ids[0]], instanceOrder: ids, active: ids[0], maximized: true, locale: 'zh-CN'}, 'PUT');
  const cookies = await context.cookies();
  await page.close();
  const file = path.join(dir, 'render-fixture.ansi'); fs.writeFileSync(file, fixture);
  const results = [];
  const cases = [{dpr: 1, renderer: 'webgl'}, {dpr: 1.25, renderer: 'webgl'}, {dpr: 2, renderer: 'webgl'}, {dpr: 1, renderer: 'dom'}, {dpr: 1, renderer: 'webgl', zoom: 1.25}];
  const launchOptions = {headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {}),
    env: {...process.env, ...(process.env.CHROMIUM_LIBRARY_PATH ? {LD_LIBRARY_PATH: process.env.CHROMIUM_LIBRARY_PATH} : {}), ...(process.env.CHROMIUM_FONTCONFIG ? {FONTCONFIG_FILE: process.env.CHROMIUM_FONTCONFIG} : {})},
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader']};
  for (const {dpr, renderer, zoom = 1} of cases) {
    const caseName = `${renderer}-${dpr}${zoom === 1 ? '' : `-zoom-${zoom}`}`;
    // CDP deviceScaleFactor alone changes window.devicePixelRatio but leaves
    // ResizeObserver.devicePixelContentBoxSize at the host DPR in Chromium.
    // xterm uses both; set the browser's native scale as well for a real HiDPI
    // canvas (otherwise the test itself resizes and clears the WebGL buffer).
    const scaled = dpr === 1 ? browser : await browser.browserType().launch({...launchOptions, args: [...launchOptions.args, `--force-device-scale-factor=${dpr}`]});
    let ctx;
    try {
      ctx = zoom === 1
        ? await scaled.newContext({viewport: {width: Math.round(1280 / (dpr === 1.25 ? 1.25 : 1)), height: 800}, deviceScaleFactor: dpr})
        : await browser.browserType().launchPersistentContext(path.join(dir, 'zoom-profile'), {...launchOptions, viewport: {width: 1280, height: 800}});
      if (zoom !== 1) {
        // Exercise Chromium's real page zoom, not CSS zoom or pinch emulation.
        const preferences = await ctx.newPage();
        await preferences.goto('chrome://settings/appearance');
        await preferences.evaluate(factor => new Promise(resolve => chrome.settingsPrivate.setDefaultZoom(factor, resolve)), zoom);
        await preferences.close();
      }
      await ctx.addCookies(cookies);
      await ctx.addInitScript(installInspection);
      if (renderer === 'dom') await ctx.addInitScript(() => {
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) {
          return type === 'webgl' || type === 'webgl2' ? null : getContext.call(this, type, ...args);
        };
      });
      const hubPage = await ctx.newPage(), direct = await ctx.newPage();
      for (const target of [hubPage, direct]) target.on('pageerror', error => errors.push(error.stack));
      const requests = [];
      ctx.on('request', req => {if (req.url().endsWith('.woff2')) requests.push(req.url());});
      await hubPage.goto(hub, {waitUntil: 'domcontentloaded'});
      await direct.goto(devices[0].url, {waitUntil: 'domcontentloaded'});
      const active = '.terminal-slot:not([hidden]) .xterm-host';
      const waitFont = async () => {
        await hubPage.locator(`${active}[data-font-status="ready"]`).waitFor();
        await direct.locator('.xterm[data-font-status="ready"]').waitFor();
        for (const [target, selector] of [[hubPage, active], [direct, '.xterm']]) {
          assert.equal(await target.locator(selector).getAttribute('data-font-applied'), "'DejaVu Sans Mono', monospace");
        }
        assert.equal(await hubPage.locator(active).getAttribute('data-terminal-renderer'), renderer);
        assert.equal(await direct.locator('#terminal').getAttribute('data-terminal-renderer'), renderer);
      };
      await waitFont();
      await wait(async () => await hubPage.evaluate(() => window.reviewSnapshot()?.pending === 0 && window.reviewSnapshot()?.text.includes('bash-'))
        && await hubPage.locator('.terminal-slot:not([hidden]) .terminal-clear-control').isEnabled(), 'shared shell ready');
      await hubPage.bringToFront();
      await hubPage.locator(`${active} .xterm-helper-textarea`).focus();
      await hubPage.keyboard.type(`cat '${file}'`); await hubPage.keyboard.press('Enter');
      await wait(() => hubPage.evaluate(() => window.reviewSnapshot()?.text.includes('Clarity fixture')), 'fixture output');
      await sleep(200);
      // The last prompt is below our eight sample rows and outside this crop.
      const metrics = await hubPage.evaluate(() => {
        const term = window.reviewTerm();
        const line = term.buffer.active.getLine(term.buffer.active.viewportY + 1);
        return {fontFamily: term.options.fontFamily, fontSize: term.options.fontSize, fontWeight: term.options.fontWeight,
          fontWeightBold: term.options.fontWeightBold, lineHeight: term.options.lineHeight, letterSpacing: term.options.letterSpacing,
          cell: term._core._renderService.dimensions.css.cell, dpr: devicePixelRatio,
          ansiBold: !line.getCell(0).isBold() && !!line.getCell(8).isBold()};
      });
      assert(metrics.ansiBold, 'normal and ANSI bold distinctions lost');
      assert.deepEqual([metrics.fontWeight, metrics.fontWeightBold, metrics.lineHeight, metrics.letterSpacing], [400, 700, 1, 0]);
      assert.equal(metrics.dpr, dpr * zoom);
      if (dpr === 1) assert.equal(metrics.cell.height, 16);
      async function shot(target, selector, name) {
        await target.bringToFront();
        await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const box = await target.locator(selector).boundingBox(); assert(box);
        const width = 44 * metrics.cell.width, height = 8 * metrics.cell.height;
        assert(box.width >= width && box.height >= height, 'terminal clips the fixture');
        // Chromium's screenshot clip uses device-independent page coordinates;
        // DOM bounding boxes remain CSS pixels when real browser zoom is active.
        const bytes = await target.screenshot({clip: {x: box.x * zoom, y: box.y * zoom, width: width * zoom, height: height * zoom}});
        fs.writeFileSync(path.join(dir, `${name}-${caseName}.png`), bytes); return bytes;
      }
      const before = await shot(hubPage, `${active} .xterm-screen`, 'hub');
      const original = await shot(direct, '#terminal .xterm-screen', 'gotty');
      fs.writeFileSync(path.join(dir, `metrics-${caseName}.json`), JSON.stringify(await hubPage.evaluate(() => {
        const term = window.reviewTerm(), core = term._core, b = term.buffer.active;
        return {options: term.options, cols: term.cols, rows: term.rows, dpr: devicePixelRatio,
          dimensions: core._renderService.dimensions, paused: core._renderService._isPaused,
          buffer: {base: b.baseY, viewport: b.viewportY, cursor: b.cursorY, lines: Array.from({length: term.rows}, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true))},
          canvases: [...document.querySelectorAll('.terminal-slot:not([hidden]) canvas')].map(c => ({width: c.width, height: c.height, style: c.getAttribute('style')}))};
      }), null, 2));
      const difference = compare(before, original);
      assert(difference < 0.025, `GoTTY / Hub pixel difference ${difference} (${renderer}, DPR ${dpr})`);
      assert(requests.every(url => url.includes('dejavu-sans-mono')), 'unselected font download');
      const coldRequests = requests.length; assert(coldRequests >= 8, 'both origins must load the four default faces');
      await ctx.route('**/*.woff2', route => route.abort());
      await hubPage.reload({waitUntil: 'domcontentloaded'}); await direct.reload({waitUntil: 'domcontentloaded'});
      await waitFont(); await sleep(200);
      assert.equal(requests.length, coldRequests, 'cached fonts unexpectedly use the network');
      const cached = await shot(hubPage, `${active} .xterm-screen`, 'hub-cached');
      assert(compare(before, cached) < 0.025, 'cached reload changes the terminal glyphs');
      results.push({renderer, dpr, zoom, cell: metrics.cell, difference, coldRequests, cachedNoNetwork: true});
    } finally {await ctx?.close(); if (scaled !== browser) await scaled.close();}
  }
  report('renderingParity', results);

  // A saved font unavailable on this device must be visible as a fallback,
  // retain the saved preference, and recover without replacing the live session.
  const snap = await api('/me/terminal-settings');
  await api('/me/terminal-settings', {revision: snap.revision, settings: {...settings, fontId: 'source-code-pro'}}, 'PUT');
  const ctx = await browser.newContext(); await ctx.addCookies(cookies); await ctx.addInitScript(installInspection);
  await ctx.route('**/*.woff2', route => route.abort());
  const fallback = await ctx.newPage(); fallback.on('pageerror', error => errors.push(error.stack));
  await fallback.goto(hub, {waitUntil: 'domcontentloaded'});
  const host = fallback.locator('.terminal-slot:not([hidden]) .xterm-host');
  await wait(async () => await host.getAttribute('data-font-status') === 'fallback', 'explicit fallback status');
  assert.equal(await host.getAttribute('data-font-applied'), 'monospace');
  assert.equal(await host.getAttribute('data-font-requested'), "'Source Code Pro', monospace");
  assert.equal((await api('/me/terminal-settings')).settings.fontId, 'source-code-pro');
  await fallback.evaluate(() => {window.originalTerminal = window.reviewTerm(); window.originalSockets = window.reviewSockets.length;});
  await ctx.unroute('**/*.woff2');
  await fallback.getByRole('button', {name: '设置', exact: true}).click();
  await fallback.getByRole('button', {name: '终端设置', exact: true}).click();
  const dialog = fallback.getByRole('dialog', {name: '终端设置', exact: true});
  await dialog.locator('.terminal-preview-host[data-font-status="ready"]').waitFor();
  assert.equal(await dialog.locator('.terminal-preview-host').getAttribute('data-font-applied'), "'Source Code Pro', monospace");
  await dialog.locator('.terminal-settings-preview').scrollIntoViewIfNeeded();
  await dialog.locator('.terminal-settings-preview').screenshot({path: path.join(dir, 'xterm-preview.png')});
  await dialog.getByRole('button', {name: '保存并应用', exact: true}).click();
  await wait(async () => await host.getAttribute('data-font-status') === 'ready', 'font retry applied');
  assert(await fallback.evaluate(() => window.originalTerminal === window.reviewTerm() && window.originalSockets === window.reviewSockets.length));
  report('fontFallback', {reported: true, preferencePreserved: true, previewUsesSavedFont: true, recoveredWithoutReconnect: true});
  await ctx.close();
};
