import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server:{proxy:{'/api':{target:'http://127.0.0.1:8088',ws:true},'/connector':{target:'http://127.0.0.1:8088',ws:true}}}, resolve: { alias: { '@': new URL('.', import.meta.url).pathname } } });
