import {expect,it} from 'vitest';
import {terminalGrid} from './grid';

it('chooses portrait or landscape geometry without changing membership', () => {
  expect(terminalGrid(2, 744, 1133, 14, false)).toMatchObject({columns:1,rows:2,capacity:2});
  expect(terminalGrid(5, 1280, 800, 14, false)).toMatchObject({columns:3,rows:2,capacity:6});
});

it('makes space for every member in all-pane view and preserves equal cells for prime counts', () => {
  for (const n of [2,3,5,7,17,121,501]) {
    const grid = terminalGrid(n, 1024, 768, 16, false);
    expect(grid.columns * grid.rows).toBeGreaterThanOrEqual(n);
    expect(grid.columns * (grid.rows - 1)).toBeLessThan(n);
  }
});

it('computes page capacity from viewport and font instead of a group limit', () => {
  const small = terminalGrid(150, 768, 500, 20, true);
  const large = terminalGrid(150, 1920, 1000, 14, true);
  expect(small.capacity).toBeGreaterThanOrEqual(1);
  expect(large.capacity).toBeGreaterThan(small.capacity);
  expect(large.capacity).toBe(large.columns * large.rows);
});
