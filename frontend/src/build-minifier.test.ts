// @vitest-environment node
import {expect, it} from 'vitest';
import {transform} from 'esbuild';
import config from '../vite.config';

it('keeps xterm mode queries executable after ES2020 lowering and production minification', async () => {
  // The shape emitted by xterm 6.0.0: the enum object is initialized by ||=,
  // while enum accesses are already inlined. esbuild's syntax minifier used to
  // remove the variable but leave the lowered assignment to an undeclared name.
  const source = `function requestMode() { let value;
    (v => (v[v.SET = 1] = "SET", v[v.RESET = 2] = "RESET"))(value ||= {});
    return "\\x1b[?1;2$y";
  } globalThis.modeReply = requestMode();`;
  const {code} = await transform(source, {target: 'es2020', minifyIdentifiers: true, minifyWhitespace: true, minifySyntax: (config.esbuild && config.esbuild.minifySyntax) ?? true});
  const target: {modeReply?: string} = {};
  new Function('globalThis', code)(target);
  expect(target.modeReply).toBe('\x1b[?1;2$y');
});
