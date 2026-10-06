// 内置示例（页面“载入内置示例”按钮）必须自身通过完整管线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSampleApng } from '../site/js/sample.js';
import { parsePng } from '../site/js/png-chunks.js';
import { assembleApng } from '../site/js/apng.js';
import { decodePngPixels } from '../site/js/png-decode.js';
import { computeFrameStates } from '../site/js/compositor.js';
import { px } from './helpers.js';

test('内置示例 APNG 通过校验并可合成', async () => {
  const bytes = await buildSampleApng();
  assert.ok(bytes.length <= 64 * 1024);
  const parsed = parsePng(bytes);
  const anim = assembleApng(parsed);
  assert.equal(anim.isAnimated, true);
  assert.equal(anim.defaultInAnimation, false);
  assert.equal(anim.frames.length, 4);
  for (const f of anim.frames) f.pixels = await decodePngPixels(f.compressed, f.width, f.height);
  const states = computeFrameStates(anim.frames, 32, 32);
  // 第 3 帧 dispose=PREVIOUS：清理后 (20,4) 处恢复透明（帧矩形 16,0 16×16 内、首帧矩形外）
  assert.deepEqual(px(states[2].display, 32, 20, 4), [40, 200, 60, 255]);
  assert.deepEqual(px(states[2].after, 32, 20, 4), [0, 0, 0, 0]);
});
