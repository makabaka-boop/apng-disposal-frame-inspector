// 集成测试：真实 APNG 文件（落盘再读入，模拟文件导入）→ 解析 → 解码 → 合成 → 三阶段像素核对；
// 再走“下载当前合成帧”的编码路径，解码回读验证像素一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePng } from '../site/js/png-chunks.js';
import { assembleApng } from '../site/js/apng.js';
import { decodePngPixels } from '../site/js/png-decode.js';
import { computeFrameStates } from '../site/js/compositor.js';
import { encodePngRgba } from '../site/js/png-encode.js';
import { buildApng, solid, px } from './helpers.js';

const RED = [255, 0, 0, 255];
const SEMI_BLUE = [0, 0, 255, 128];
const GREEN = [0, 255, 0, 255];
const WHITE = [255, 255, 255, 255];
const TRANSPARENT = [0, 0, 0, 0];

async function loadApng(bytes) {
  const parsed = parsePng(bytes);
  const anim = assembleApng(parsed);
  for (const f of anim.frames) f.pixels = await decodePngPixels(f.compressed, f.width, f.height);
  const states = computeFrameStates(anim.frames, parsed.ihdr.width, parsed.ihdr.height);
  return { parsed, anim, states };
}

test('实际文件导入：8×8 四帧 APNG（默认图不属于动画），三阶段画布像素全部符合预期', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'apng-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const bytes = buildApng({
    width: 8, height: 8,
    defaultImage: solid(8, 8, [10, 20, 30, 255]),
    frames: [
      { x: 0, y: 0, width: 4, height: 4, rgba: solid(4, 4, RED), dispose: 0, blend: 0 },
      { x: 2, y: 2, width: 4, height: 4, rgba: solid(4, 4, SEMI_BLUE), dispose: 1, blend: 1 },
      { x: 0, y: 0, width: 2, height: 2, rgba: solid(2, 2, GREEN), dispose: 2, blend: 0 },
      { x: 6, y: 6, width: 2, height: 2, rgba: solid(2, 2, WHITE), dispose: 0, blend: 1 },
    ],
  });
  assert.ok(bytes.length <= 64 * 1024, '样例文件在 64 KiB 约束内');

  // 落盘再读回，模拟真实的文件导入路径
  const file = join(dir, 'sticker.apng');
  writeFileSync(file, bytes);
  const { parsed, anim, states } = await loadApng(new Uint8Array(readFileSync(file)));

  assert.equal(anim.isAnimated, true);
  assert.equal(anim.defaultInAnimation, false);
  assert.equal(anim.frames.length, 4);

  // 默认图（静态回退）可独立解码
  const def = await decodePngPixels(anim.defaultImageCompressed, 8, 8);
  assert.deepEqual(px(def, 8, 3, 3), [10, 20, 30, 255]);

  // 第 1 帧：SOURCE 不透明红，dispose NONE
  assert.deepEqual(px(states[0].before, 8, 0, 0), TRANSPARENT, '动画从全透明画布开始，与默认图无关');
  assert.deepEqual(px(states[0].display, 8, 3, 3), RED);
  assert.deepEqual(px(states[0].display, 8, 5, 5), TRANSPARENT, '矩形外保持透明');
  assert.deepEqual(px(states[0].after, 8, 3, 3), RED, 'NONE 不清理');

  // 第 2 帧：半透明蓝 OVER，dispose BACKGROUND
  assert.deepEqual(px(states[1].before, 8, 2, 2), RED, '帧前画布带着上一帧残留');
  assert.deepEqual(px(states[1].display, 8, 2, 2), [127, 0, 128, 255], '半透明蓝叠在红上');
  assert.deepEqual(px(states[1].display, 8, 4, 4), SEMI_BLUE, '半透明蓝叠在透明上即源像素');
  assert.deepEqual(px(states[1].after, 8, 2, 2), TRANSPARENT, 'BACKGROUND 清空帧矩形');
  assert.deepEqual(px(states[1].after, 8, 0, 0), RED, '矩形外的红保留');

  // 第 3 帧：绿 SOURCE，dispose PREVIOUS —— 恢复的是本帧绘制前的画布
  assert.deepEqual(px(states[2].before, 8, 0, 0), RED);
  assert.deepEqual(px(states[2].display, 8, 0, 0), GREEN);
  assert.deepEqual(px(states[2].after, 8, 0, 0), RED, 'PREVIOUS 恢复绘制前的红，而非第 2 帧展示图');
  assert.deepEqual(px(states[2].after, 8, 2, 2), TRANSPARENT, 'BACKGROUND 清理过的区域不会被 PREVIOUS 复活');

  // 第 4 帧：白 OVER，dispose NONE
  assert.deepEqual(px(states[3].display, 8, 7, 7), WHITE);
  assert.deepEqual(px(states[3].display, 8, 0, 0), RED, '历史帧残留仍在');
  assert.deepEqual(px(states[3].after, 8, 7, 7), WHITE);

  // 任意跳转一致性：打乱顺序访问与顺序访问像素相同
  for (const i of [3, 0, 2, 1, 3]) {
    const again = computeFrameStates(anim.frames, 8, 8);
    assert.deepEqual([...again[i].display], [...states[i].display], `第 ${i + 1} 帧展示图与访问顺序无关`);
  }

  // 下载路径：当前合成帧（第 4 帧展示图）编码为 PNG，回读解码像素必须一致
  const pngOut = await encodePngRgba(8, 8, states[3].display);
  const reparsed = parsePng(pngOut);
  const reanim = assembleApng(reparsed);
  assert.equal(reanim.isAnimated, false, '下载的是静态合成帧，不是动画');
  const roundTrip = await decodePngPixels(reanim.defaultImageCompressed, 8, 8);
  assert.deepEqual([...roundTrip], [...states[3].display], '下载的 PNG 与合成帧像素一致');
  assert.deepEqual(px(roundTrip, 8, 7, 7), WHITE);
  assert.notDeepEqual(px(roundTrip, 8, 2, 2), SEMI_BLUE, '下载的是合成结果而非某帧原始局部图');
});

test('实际文件导入：默认图属于动画（首帧来自 IDAT）', async () => {
  const bytes = buildApng({
    width: 8, height: 8,
    defaultInAnimation: true,
    defaultImage: solid(8, 8, [50, 60, 70, 255]),
    frames: [
      { width: 8, height: 8, rgba: solid(8, 8, [50, 60, 70, 255]), dispose: 0, blend: 0 },
      { x: 4, y: 4, width: 4, height: 4, rgba: solid(4, 4, [0, 255, 0, 128]), dispose: 2, blend: 1 },
      { x: 0, y: 0, width: 2, height: 2, rgba: solid(2, 2, [255, 255, 0, 255]), dispose: 1, blend: 0 },
    ],
  });
  const { anim, states } = await loadApng(bytes);
  assert.equal(anim.defaultInAnimation, true);
  assert.equal(anim.frames[0].fromIdat, true);

  assert.deepEqual(px(states[0].display, 8, 0, 0), [50, 60, 70, 255], '首帧即默认图');
  assert.deepEqual(px(states[1].display, 8, 5, 5), [25, 158, 35, 255], '半透绿 OVER 默认图');
  assert.deepEqual(px(states[1].after, 8, 5, 5), [50, 60, 70, 255], 'PREVIOUS 恢复默认图像素');
  assert.deepEqual(px(states[2].display, 8, 0, 0), [255, 255, 0, 255]);
  assert.deepEqual(px(states[2].after, 8, 0, 0), TRANSPARENT, 'BACKGROUND 清空为透明');
});

test('坏块不降级：破坏 fdAT 数据后整个管线报错，而非静默显示静态图', async () => {
  const bytes = buildApng({
    width: 8, height: 8,
    frames: [{ width: 4, height: 4, rgba: solid(4, 4, RED) }],
  });
  const bad = bytes.slice();
  // 找到 fdAT 数据区并破坏一个字节（CRC 随之失效）
  const idx = bad.findIndex((v, i) => v === 0x66 && bad[i + 1] === 0x64 && bad[i + 2] === 0x41 && bad[i + 3] === 0x54);
  assert.ok(idx > 0, '找到 fdAT');
  bad[idx + 8] ^= 0xff;
  assert.throws(() => parsePng(bad), /CRC 校验失败/);
});
