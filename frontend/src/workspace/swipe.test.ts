import {expect, it} from 'vitest';
import {adjacentSwipeTarget, SWIPE_IDLE_MS, TabSwipeGesture} from './swipe';
import {workspaceReducer, type Workspace} from './state';

const state = (): Workspace => ({opened: ['a', 'b', 'c', 'd'], order: ['a', 'b', 'c', 'd'], active: 'a', groups: []});
const sample = (x: number, y = 0, at = 0, extra = {}) => ({x, y, at, eligible: true, cancelable: true, context: 'a', ...extra});

it('claims horizontal intent before the threshold and drains inertia after one switch', () => {
  const gesture = new TabSwipeGesture();
  expect(gesture.push(sample(20, 2))).toEqual({consume: true});
  expect(gesture.push(sample(30, 2, 16))).toEqual({consume: true});
  expect(gesture.push(sample(40, 2, 32))).toEqual({consume: true, direction: 1});
  for (let at = 48; at < 1000; at += 16) {
    expect(gesture.push(sample(30, 0, at, {context: 'new-tab'}))).toEqual({consume: true});
  }
  expect(gesture.push(sample(-90, 0, 1000 + SWIPE_IDLE_MS))).toEqual({consume: true, direction: -1});
});

it('never converts a vertical, ambiguous or ineligible burst into a tab switch', () => {
  for (const first of [sample(2, 20), sample(20, 15), sample(50, 0, 0, {eligible: false}), sample(50, 0, 0, {cancelable: false})]) {
    const gesture = new TabSwipeGesture();
    expect(gesture.push(first)).toEqual({consume: false});
    expect(gesture.push(sample(200, 0, 16))).toEqual({consume: false});
  }
});

it('accepts a renewed same-direction swipe while the previous inertia is still arriving', () => {
  const gesture = new TabSwipeGesture();
  expect(gesture.push(sample(90))).toEqual({consume: true, direction: 1});
  for (const [at, x] of [[16, 60], [48, 36], [80, 20], [112, 12], [144, 5], [176, 2]]) {
    expect(gesture.push(sample(x, 0, at))).toEqual({consume: true});
  }
  expect(gesture.push(sample(25, 0, 192, {context: 'b'}))).toEqual({consume: true});
  expect(gesture.push(sample(60, 0, 208, {context: 'b'}))).toEqual({consume: true, direction: 1});
  for (let at = 224; at <= 1200; at += 16) expect(gesture.push(sample(25, 0, at))).toEqual({consume: true});
});

it('accepts a deliberate reversal without waiting for silence, but ignores tiny rebound noise', () => {
  const gesture = new TabSwipeGesture(); gesture.push(sample(90));
  for (const at of [30, 60, 90, 120, 150, 180]) expect(gesture.push(sample(-1, 0, at))).toEqual({consume: true});
  expect(gesture.push(sample(-40, 0, 196))).toEqual({consume: true});
  expect(gesture.push(sample(-45, 0, 212))).toEqual({consume: true, direction: -1});
});

it('does not restart on long decaying momentum, early acceleration or after cancellation', () => {
  const gesture = new TabSwipeGesture(); gesture.push(sample(90));
  gesture.push(sample(5, 0, 16));
  expect(gesture.push(sample(120, 0, 32))).toEqual({consume: true});
  for (let at = 48; at < 1800; at += 16) expect(gesture.push(sample(110 * Math.exp(-at / 250), 0, at))).toEqual({consume: true});
  gesture.cancel();
  expect(gesture.push(sample(90, 0, 1800))).toEqual({consume: true});
});

it('cancels a pending switch when its origin, direction or eligibility changes', () => {
  for (const next of [sample(70, 0, 16, {context: 'reordered'}), sample(-70, 0, 16), sample(70, 0, 16, {eligible: false}), sample(1, 30, 16)]) {
    const gesture = new TabSwipeGesture(); gesture.push(sample(30));
    expect(gesture.push(next)).toEqual({consume: true});
    expect(gesture.push(sample(200, 0, 32))).toEqual({consume: true});
  }
});

it('cancels pending input on blur and releases modified gestures to the browser', () => {
  const gesture = new TabSwipeGesture(); gesture.push(sample(30)); gesture.cancel();
  expect(gesture.push(sample(100, 0, 16))).toEqual({consume: true});
  gesture.release(32);
  expect(gesture.push(sample(200, 0, 48))).toEqual({consume: false});
});

it('uses visual tab order, stops at boundaries and never opens hidden legacy tabs', () => {
  const reordered = {...state(), order: ['a', 'd', 'c', 'b'], opened: ['a', 'b', 'd']};
  expect(adjacentSwipeTarget(reordered, 1, true)).toBe('d');
  expect(adjacentSwipeTarget(reordered, -1, true)).toBeUndefined();
  expect(adjacentSwipeTarget({...reordered, active: 'b'}, 1, true)).toBeUndefined();
  expect(adjacentSwipeTarget({...reordered, active: 'unknown'}, 1, true)).toBeUndefined();
});

it('navigates an expanded pair as one screen and restores its remembered pane', () => {
  let paired = workspaceReducer(state(), {type: 'start', id: 'b', right: 'c'});
  paired = workspaceReducer(paired, {type: 'select', id: 'c'});
  expect(adjacentSwipeTarget(paired, -1, true)).toBe('a');
  expect(adjacentSwipeTarget(paired, 1, true)).toBe('d');
  expect(adjacentSwipeTarget({...paired, active: 'a'}, 1, true)).toBe('c');
  expect(adjacentSwipeTarget(paired, -1, false)).toBe('b');
  expect(adjacentSwipeTarget({...paired, active: 'a'}, 1, false)).toBe('b');
});
