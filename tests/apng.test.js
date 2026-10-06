// APNG 结构组装测试：acTL 帧数、fcTL/fdAT 连续序号、默认图归属判定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePng } from '../site/js/png-chunks.js';
import { assembleApng } from '../site/js/apng.js';
import { SIGNATURE, chunk, ihdr, idatFromRgba, actl, fctl, fdat, solid, concatBytes, buildApng } from './helpers.js';

const assemble = (bytes) => assembleApng(parsePng(bytes));

test('静态 PNG（无 acTL）：isAnimated=false，不当作动画', () => {
  const bytes = concatBytes(SIGNATURE, ihdr(4, 4), idatFromRgba(solid(4, 4, [9, 9, 9, 255]), 4, 4), chunk('IEND'));
  const anim = assemble(bytes);
  assert.equal(anim.isAnimated, false);
  assert.ok(anim.defaultImageCompressed.length > 0);
});

test('默认图不属于动画：首个 fcTL 在 IDAT 之后', () => {
  const bytes = buildApng({
    width: 8, height: 8,
    frames: [{ width: 4, height: 4, x: 1, y: 1, rgba: solid(4, 4, [255, 0, 0, 255]) }],
  });
  const anim = assemble(bytes);
  assert.equal(anim.isAnimated, true);
  assert.equal(anim.defaultInAnimation, false);
  assert.equal(anim.frames.length, 1);
  assert.equal(anim.frames[0].fromIdat, false);
  assert.ok(anim.defaultImageCompressed.length > 0, '默认图数据保留用于展示');
});

test('默认图属于动画：首个 fcTL 在 IDAT 之前，第一帧来自 IDAT', () => {
  const bytes = buildApng({
    width: 8, height: 8,
    defaultInAnimation: true,
    frames: [
      { width: 8, height: 8, rgba: solid(8, 8, [1, 1, 1, 255]) },
      { width: 4, height: 4, x: 2, y: 2, rgba: solid(4, 4, [2, 2, 2, 255]) },
    ],
  });
  const anim = assemble(bytes);
  assert.equal(anim.defaultInAnimation, true);
  assert.equal(anim.frames[0].fromIdat, true);
  assert.equal(anim.defaultImageCompressed, null);
});

test('acTL 帧数与实际 fcTL 数不符 → 报错', () => {
  const bytes = concatBytes(
    SIGNATURE, ihdr(8, 8), actl(2),
    idatFromRgba(solid(8, 8, [0, 0, 0, 255]), 8, 8),
    fctl(0, { width: 4, height: 4 }), fdat(1, solid(4, 4, [1, 2, 3, 255]), 4, 4),
    chunk('IEND')
  );
  assert.throws(() => assemble(bytes), /声明 2 帧，实际 fcTL 共 1 个/);
});

test('fcTL/fdAT 序号跳号 → 报错', () => {
  const bytes = concatBytes(
    SIGNATURE, ihdr(8, 8), actl(2),
    idatFromRgba(solid(8, 8, [0, 0, 0, 255]), 8, 8),
    fctl(0, { width: 4, height: 4 }), fdat(1, solid(4, 4, [1, 2, 3, 255]), 4, 4),
    fctl(5, { width: 4, height: 4 }), fdat(3, solid(4, 4, [4, 5, 6, 255]), 4, 4),
    chunk('IEND')
  );
  assert.throws(() => assemble(bytes), /序号为 5，期望 2/);
});

test('序号不从 0 开始 → 报错', () => {
  const bytes = concatBytes(
    SIGNATURE, ihdr(8, 8), actl(1),
    idatFromRgba(solid(8, 8, [0, 0, 0, 255]), 8, 8),
    fctl(1, { width: 4, height: 4 }), fdat(2, solid(4, 4, [1, 2, 3, 255]), 4, 4),
    chunk('IEND')
  );
  assert.throws(() => assemble(bytes), /序号为 1，期望 0/);
});

test('fdAT 出现在任何 fcTL 之前 → 报错', () => {
  const bytes = concatBytes(
    SIGNATURE, ihdr(8, 8), actl(1),
    idatFromRgba(solid(8, 8, [0, 0, 0, 255]), 8, 8),
    fdat(0, solid(4, 4, [1, 2, 3, 255]), 4, 4),
    chunk('IEND')
  );
  assert.throws(() => assemble(bytes), /fdAT 出现在任何 fcTL 之前/);
});

test('fcTL 后没有数据 → 报错', () => {
  const bytes = concatBytes(
    SIGNATURE, ihdr(8, 8), actl(2),
    idatFromRgba(solid(8, 8, [0, 0, 0, 255]), 8, 8),
    fctl(0, { width: 4, height: 4 }), fdat(1, solid(4, 4, [1, 2, 3, 255]), 4, 4),
    fctl(2, { width: 4, height: 4 }),
    chunk('IEND')
  );
  assert.throws(() => assemble(bytes), /第 2 帧没有任何图像数据/);
});

test('帧矩形超出画布 → 报错', () => {
  const bytes = concatBytes(
    SIGNATURE, ihdr(8, 8), actl(1),
    idatFromRgba(solid(8, 8, [0, 0, 0, 255]), 8, 8),
    fctl(0, { width: 4, height: 4, x: 6, y: 0 }), fdat(1, solid(4, 4, [1, 2, 3, 255]), 4, 4),
    chunk('IEND')
  );
  assert.throws(() => assemble(bytes), /超出画布/);
});

test('非法 dispose_op / blend_op → 报错', () => {
  const mk = (dispose, blend) => concatBytes(
    SIGNATURE, ihdr(8, 8), actl(1),
    idatFromRgba(solid(8, 8, [0, 0, 0, 255]), 8, 8),
    fctl(0, { width: 4, height: 4, dispose, blend }), fdat(1, solid(4, 4, [1, 2, 3, 255]), 4, 4),
    chunk('IEND')
  );
  assert.throws(() => assemble(mk(3, 0)), /dispose_op/);
  assert.throws(() => assemble(mk(0, 2)), /blend_op/);
});

test('超过 16 帧 → 报错', () => {
  const frames = Array.from({ length: 17 }, () => ({ width: 2, height: 2, rgba: solid(2, 2, [1, 1, 1, 255]) }));
  const bytes = buildApng({ width: 8, height: 8, frames });
  assert.throws(() => assemble(bytes), /16 帧上限/);
});

test('默认图作为首帧但 fcTL 未覆盖全画布 → 报错', () => {
  const bytes = concatBytes(
    SIGNATURE, ihdr(8, 8), actl(1),
    fctl(0, { width: 4, height: 4, x: 1, y: 1 }),
    idatFromRgba(solid(8, 8, [0, 0, 0, 255]), 8, 8),
    chunk('IEND')
  );
  assert.throws(() => assemble(bytes), /覆盖整个画布/);
});

test('delay_den 为 0 时按 100 处理', () => {
  const bytes = concatBytes(
    SIGNATURE, ihdr(8, 8), actl(1),
    idatFromRgba(solid(8, 8, [0, 0, 0, 255]), 8, 8),
    fctl(0, { width: 4, height: 4, delayNum: 1, delayDen: 0 }), fdat(1, solid(4, 4, [1, 2, 3, 255]), 4, 4),
    chunk('IEND')
  );
  assert.equal(assemble(bytes).frames[0].delayDen, 100);
});
