import {expect, it} from 'vitest';
import {TouchTabSwipeGesture} from './touchSwipe';

const point = (x = 300, y = 200, at = 0, extra = {}) => ({x, y, at, context: 'a', eligible: true, ...extra});

it('commits once on lift and accepts an immediate second swipe in the opposite direction', () => {
  const gesture = new TouchTabSwipeGesture(); gesture.start(point());
  expect(gesture.move(point(275, 202, 25), true)).toEqual({consume: true});
  expect(gesture.move(point(170, 204, 100), true)).toEqual({consume: true});
  expect(gesture.end(point(170, 204, 120))).toEqual({consume: true, direction: 1});
  gesture.start(point(100, 200, 130, {context: 'b'}));
  gesture.move(point(220, 201, 180, {context: 'b'}), true);
  expect(gesture.end(point(220, 201, 190, {context: 'b'}))).toEqual({consume: true, direction: -1});
  expect(gesture.end(point())).toEqual({consume: false});
});

it('leaves taps, vertical/diagonal scrolling, long presses and native-owned gestures alone', () => {
  for (const next of [point(295, 203, 40), point(280, 260, 40), point(260, 230, 40), point(180, 200, 260)]) {
    const gesture = new TouchTabSwipeGesture(); gesture.start(point());
    expect(gesture.move(next, true)).toEqual({consume: false});
    expect(gesture.end(next)).toEqual({consume: false});
  }
  const gesture = new TouchTabSwipeGesture(); gesture.start(point());
  gesture.move(point(300, 250, 40), true);
  expect(gesture.move(point(100, 250, 80), true)).toEqual({consume: false});
  expect(gesture.end(point(100, 250, 90))).toEqual({consume: false});
});

it('drains short, canceled, reversed or invalidated horizontal gestures without switching', () => {
  for (const next of [point(250, 200, 80), point(320, 200, 80), point(160, 300, 80),
    point(160, 200, 80, {context: 'reordered'}), point(160, 200, 80, {eligible: false})]) {
    const gesture = new TouchTabSwipeGesture(); gesture.start(point()); gesture.move(point(270, 200, 30), true);
    expect(gesture.move(next, true)).toEqual({consume: true});
    expect(gesture.end(next)).toEqual({consume: true});
  }
  const gesture = new TouchTabSwipeGesture(); gesture.start(point()); gesture.move(point(180, 200, 50), true);
  gesture.cancel(); expect(gesture.end(point(180, 200, 80))).toEqual({consume: true});
});

it('resets canceled touches and refuses changes at lift or noncancelable motion', () => {
  const gesture = new TouchTabSwipeGesture(); gesture.start(point());
  expect(gesture.move(point(180, 200, 50), false)).toEqual({consume: false});
  expect(gesture.end(point(180, 200, 80))).toEqual({consume: false});
  gesture.start(point()); gesture.move(point(180, 200, 50), true);
  expect(gesture.end(point(180, 200, 80, {context: 'b'}))).toEqual({consume: true});
  gesture.start(point()); gesture.move(point(180, 200, 50), true); gesture.reset();
  expect(gesture.end(point(180, 200, 80))).toEqual({consume: false});
});
