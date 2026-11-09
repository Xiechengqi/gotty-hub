import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {readFileSync} from 'node:fs';
export default defineConfig({ plugins: [react(), {
  name: 'independent-page-bootstrap',
  transformIndexHtml: {order: 'post', handler: html => html.replace('<!--hub-bootstrap-->',
    `<style>${readFileSync(new URL('./bootstrap.css', import.meta.url), 'utf8')}</style><script id="hub-bootstrap">${readFileSync(new URL('./bootstrap.js', import.meta.url), 'utf8')}</script>`)},
}], server:{proxy:{'/api':{target:'http://127.0.0.1:8088',ws:true},'/connector':{target:'http://127.0.0.1:8088',ws:true}}}, resolve: { alias: { '@': new URL('.', import.meta.url).pathname } } });
