// 合成器单元测试：独立小像素数组，覆盖透明 OVER、连续 PREVIOUS、任意跳转一致性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendRect, applyDispose, computeFrameStates, BLEND, DISPOSE } from '../site/js/compositor.js';

const px = (bytes, width, x, y) => {
  const i = (y * width + x) * 4;
  return [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]];
};

test('OVER：完全透明的源不改变目标', () => {
  const canvas = new Uint8Array([10, 20, 30, 40]);
  blendRect(canvas, 1, new Uint8Array([0, 0, 0, 0]), 0, 0, 1, 1, BLEND.OVER);
  assert.deepEqual([...canvas], [10, 20, 30, 40]);
});

test('OVER：不透明的源完全替换目标', () => {
  const canvas = new Uint8Array([10, 20, 30, 40]);
  blendRect(canvas, 1, new Uint8Array([200, 100, 50, 255]), 0, 0, 1, 1, BLEND.OVER);
  assert.deepEqual([...canvas], [200, 100, 50, 255]);
});

test('OVER：半透明源覆盖不透明目标（手算值）', () => {
  // src (200,50,0,128) over dst (100,150,200,255)
  // R=(200·128+100·127)/255≈150.2→150, G=(50·128+150·127)/255≈99.8→100, B=(0·128+200·127)/255≈99.6→100
  const canvas = new Uint8Array([100, 150, 200, 255]);
  blendRect(canvas, 1, new Uint8Array([200, 50, 0, 128]), 0, 0, 1, 1, BLEND.OVER);
  assert.deepEqual([...canvas], [150, 100, 100, 255]);
});

test('OVER：半透明源覆盖半透明目标（手算值）', () => {
  // src (255,0,0,128) over dst (0,0,0,128)：αo=128/255+128·127/255²≈0.75196→A=192，R≈170.2→170
  const canvas = new Uint8Array([0, 0, 0, 128]);
  blendRect(canvas, 1, new Uint8Array([255, 0, 0, 128]), 0, 0, 1, 1, BLEND.OVER);
  assert.deepEqual([...canvas], [170, 0, 0, 192]);
});

test('SOURCE：连同 alpha 一起覆盖', () => {
  const canvas = new Uint8Array([100, 150, 200, 255]);
  blendRect(canvas, 1, new Uint8Array([1, 2, 3, 0]), 0, 0, 1, 1, BLEND.SOURCE);
  assert.deepEqual([...canvas], [1, 2, 3, 0]);
});

test('BACKGROUND：只清空帧矩形，不动矩形外像素', () => {
  // 2×1 画布，只清理左半
  const canvas = new Uint8Array([1, 2, 3, 4, 9, 9, 9, 9]);
  const before = canvas.slice();
  applyDispose(canvas, 2, before, 0, 0, 1, 1, DISPOSE.BACKGROUND);
  assert.deepEqual([...canvas], [0, 0, 0, 0, 9, 9, 9, 9]);
});

test('PREVIOUS：恢复的是当前帧绘制之前的画布，而不是上一帧的展示图', () => {
  // 2×1 画布：
  // f0 SOURCE 全红，dispose NONE        → 画布 [红, 红]
  // f1 SOURCE 左格蓝，dispose BACKGROUND → 展示 [蓝, 红]，清理后 [透明, 红]
  // f2 SOURCE 左格绿，dispose PREVIOUS   → 展示 [绿, 红]，清理后必须回到 f2 绘制前 [透明, 红]
  // 若错误地恢复“上一帧展示图”，会得到 [蓝, 红]。
  const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255], GREEN = [0, 255, 0, 255];
  const frames = [
    { x: 0, y: 0, width: 2, height: 1, dispose: DISPOSE.NONE, blend: BLEND.SOURCE, pixels: new Uint8Array([...RED, ...RED]) },
    { x: 0, y: 0, width: 1, height: 1, dispose: DISPOSE.BACKGROUND, blend: BLEND.SOURCE, pixels: new Uint8Array(BLUE) },
    { x: 0, y: 0, width: 1, height: 1, dispose: DISPOSE.PREVIOUS, blend: BLEND.SOURCE, pixels: new Uint8Array(GREEN) },
  ];
  const states = computeFrameStates(frames, 2, 1);
  assert.deepEqual(px(states[1].display, 2, 0, 0), BLUE, 'f1 展示后左格为蓝');
  assert.deepEqual(px(states[1].after, 2, 0, 0), [0, 0, 0, 0], 'f1 BACKGROUND 清理后左格透明');
  assert.deepEqual(px(states[2].before, 2, 0, 0), [0, 0, 0, 0], 'f2 帧前是清理后的画布');
  assert.deepEqual(px(states[2].display, 2, 0, 0), GREEN, 'f2 展示后左格为绿');
  assert.deepEqual(px(states[2].after, 2, 0, 0), [0, 0, 0, 0], 'f2 PREVIOUS 恢复绘制前的透明，而非 f1 展示图的蓝');
  assert.deepEqual(px(states[2].after, 2, 1, 0), RED, '矩形外像素不受影响');
});

test('连续 PREVIOUS：每一帧都恢复各自的绘制前状态', () => {
  // 1×1 画布：f0 红 NONE；f1 蓝 PREVIOUS；f2 绿 PREVIOUS
  const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255], GREEN = [0, 255, 0, 255];
  const frames = [
    { x: 0, y: 0, width: 1, height: 1, dispose: DISPOSE.NONE, blend: BLEND.SOURCE, pixels: new Uint8Array(RED) },
    { x: 0, y: 0, width: 1, height: 1, dispose: DISPOSE.PREVIOUS, blend: BLEND.SOURCE, pixels: new Uint8Array(BLUE) },
    { x: 0, y: 0, width: 1, height: 1, dispose: DISPOSE.PREVIOUS, blend: BLEND.SOURCE, pixels: new Uint8Array(GREEN) },
  ];
  const states = computeFrameStates(frames, 1, 1);
  assert.deepEqual(px(states[1].display, 1, 0, 0), BLUE);
  assert.deepEqual(px(states[1].after, 1, 0, 0), RED, 'f1 清理后回到红');
  assert.deepEqual(px(states[2].before, 1, 0, 0), RED, 'f2 帧前仍是红');
  assert.deepEqual(px(states[2].display, 1, 0, 0), GREEN);
  assert.deepEqual(px(states[2].after, 1, 0, 0), RED, 'f2 清理后仍回到红');
});

test('首帧按规范处理：OVER 作用于全透明画布等价 SOURCE；PREVIOUS 等价 BACKGROUND', () => {
  const SEMI = [10, 20, 30, 128];
  const frames = [
    { x: 0, y: 0, width: 1, height: 1, dispose: DISPOSE.PREVIOUS, blend: BLEND.OVER, pixels: new Uint8Array(SEMI) },
  ];
  const states = computeFrameStates(frames, 1, 1);
  assert.deepEqual(px(states[0].before, 1, 0, 0), [0, 0, 0, 0], '帧前为全透明');
  assert.deepEqual(px(states[0].display, 1, 0, 0), SEMI, '首帧 OVER 结果即源像素');
  assert.deepEqual(px(states[0].after, 1, 0, 0), [0, 0, 0, 0], '首帧 PREVIOUS 恢复全透明');
});

test('任意访问顺序得到相同像素：预计算快照与访问顺序无关', () => {
  // 3×2 画布、4 帧混合各种 dispose/blend
  const mk = (rgba) => new Uint8Array(rgba);
  const frames = [
    { x: 0, y: 0, width: 2, height: 2, dispose: DISPOSE.NONE, blend: BLEND.SOURCE, pixels: mk([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]) },
    { x: 1, y: 0, width: 2, height: 1, dispose: DISPOSE.BACKGROUND, blend: BLEND.OVER, pixels: mk([0, 0, 255, 128, 0, 0, 255, 128]) },
    { x: 0, y: 1, width: 1, height: 1, dispose: DISPOSE.PREVIOUS, blend: BLEND.SOURCE, pixels: mk([0, 255, 0, 255]) },
    { x: 2, y: 1, width: 1, height: 1, dispose: DISPOSE.NONE, blend: BLEND.OVER, pixels: mk([255, 255, 0, 64]) },
  ];
  const states = computeFrameStates(frames, 3, 2);

  // 模拟任意跳转：0→3→1→2→0，访问到的快照必须与顺序计算 0→1→2→3 完全一致
  const jumpOrder = [0, 3, 1, 2, 0];
  const sequential = computeFrameStates(frames, 3, 2);
  for (const i of jumpOrder) {
    for (const stage of ['before', 'display', 'after']) {
      assert.deepEqual(
        [...states[i][stage]],
        [...sequential[i][stage]],
        `跳转到第 ${i} 帧的 ${stage} 与顺序计算一致`
      );
    }
  }

  // 重复计算（模拟重复载入/重复导航）结果确定
  const again = computeFrameStates(frames, 3, 2);
  for (let i = 0; i < frames.length; i++) {
    assert.deepEqual([...again[i].display], [...states[i].display]);
    assert.deepEqual([...again[i].after], [...states[i].after]);
  }
});
