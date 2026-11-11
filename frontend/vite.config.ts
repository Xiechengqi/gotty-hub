import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {readFileSync, readdirSync} from 'node:fs';
export default defineConfig({
  // esbuild 0.25.12's syntax minifier drops the local enum variable when lowering
  // xterm's `value ||= {}` to the ES2020 target. Vim's DECRQM then throws and
  // permanently stalls xterm's write queue. Keep browser compatibility and the
  // identifier/whitespace optimizations, without that unsafe syntax rewrite.
  esbuild: {minifySyntax: false},
  plugins: [react(), {name: 'terminal-font-licenses', generateBundle() {
    const root = new URL('./node_modules/@gotty/terminal-core/', import.meta.url);
    for (const name of readdirSync(new URL('font-licenses/', root))) this.emitFile({type: 'asset', fileName: `assets/font-licenses/${name}`, source: readFileSync(new URL(`font-licenses/${name}`, root))});
    this.emitFile({type: 'asset', fileName: 'assets/font-licenses/manifest.json', source: readFileSync(new URL('font-manifest.json', root))});
  }}, {
  name: 'independent-page-bootstrap',
  transformIndexHtml: {order: 'post', handler: html => html.replace('<!--hub-bootstrap-->',
    `<style>${readFileSync(new URL('./bootstrap.css', import.meta.url), 'utf8')}</style><script id="hub-bootstrap">${readFileSync(new URL('./bootstrap.js', import.meta.url), 'utf8')}</script>`)},
}], server:{proxy:{'/api':{target:'http://127.0.0.1:8088',ws:true},'/connector':{target:'http://127.0.0.1:8088',ws:true}}}, resolve: { alias: { '@': new URL('.', import.meta.url).pathname } } });
