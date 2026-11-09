import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@':new URL('.',import.meta.url).pathname}},test:{environment:'jsdom',include:['src/**/*.test.{ts,tsx}'],environmentOptions:{jsdom:{pretendToBeVisual:true}}}});
