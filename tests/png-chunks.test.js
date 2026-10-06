// 块解析校验测试：长度、CRC、IHDR 约束、块白名单，坏块一律报错而非降级。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePng, PngError } from '../site/js/png-chunks.js';
import { crc32 } from '../site/js/crc32.js';
import { SIGNATURE, chunk, ihdr, idatFromRgba, solid, concatBytes, buildApng } from './helpers.js';

function minimalPng(w = 4, h = 4) {
  return concatBytes(SIGNATURE, ihdr(w, h), idatFromRgba(solid(w, h, [1, 2, 3, 255]), w, h), chunk('IEND'));
}

test('crc32 已知向量：IEND 空数据块的 CRC 为 0xAE426082', () => {
  assert.equal(crc32(new Uint8Array([0x49, 0x45, 0x4e, 0x44])), 0xae426082);
});

test('合法静态 PNG 解析成功', () => {
  const parsed = parsePng(minimalPng());
  assert.equal(parsed.ihdr.width, 4);
  assert.deepEqual(parsed.chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
});

test('CRC 不匹配 → 报错', () => {
  const bytes = minimalPng();
  const bad = bytes.slice();
  bad[bad.length - 1] ^= 0xff; // 破坏 IEND 记录的 CRC 值
  assert.throws(() => parsePng(bad), /CRC 校验失败/);
});

test('文件截断 → 报错', () => {
  const bytes = minimalPng();
  assert.throws(() => parsePng(bytes.slice(0, bytes.length - 6)), /截断|超出文件剩余/);
});

test('签名错误 → 报错', () => {
  const bad = minimalPng().slice();
  bad[0] = 0x00;
  assert.throws(() => parsePng(bad), /签名/);
});

test('超过 64 KiB → 报错', () => {
  assert.throws(() => parsePng(new Uint8Array(64 * 1024 + 1)), /64 KiB/);
});

test('画布超过 64×64 → 报错', () => {
  const bytes = concatBytes(SIGNATURE, ihdr(65, 4), idatFromRgba(solid(65, 4, [0, 0, 0, 255]), 65, 4), chunk('IEND'));
  assert.throws(() => parsePng(bytes), /64×64/);
});

test('非 RGBA8（颜色类型 2）→ 报错', () => {
  const bytes = concatBytes(SIGNATURE, ihdr(4, 4, { colorType: 2 }), idatFromRgba(solid(4, 4, [0, 0, 0, 255]), 4, 4), chunk('IEND'));
  assert.throws(() => parsePng(bytes), /RGBA8|颜色类型/);
});

test('隔行扫描 → 报错', () => {
  const bytes = concatBytes(SIGNATURE, ihdr(4, 4, { interlace: 1 }), idatFromRgba(solid(4, 4, [0, 0, 0, 255]), 4, 4), chunk('IEND'));
  assert.throws(() => parsePng(bytes), /隔行/);
});

test('颜色管理扩展块（gAMA/iCCP/sRGB/cHRM）→ 报错', () => {
  for (const type of ['gAMA', 'iCCP', 'sRGB', 'cHRM']) {
    const bytes = concatBytes(SIGNATURE, ihdr(4, 4), chunk(type, new Uint8Array(4)), idatFromRgba(solid(4, 4, [0, 0, 0, 255]), 4, 4), chunk('IEND'));
    assert.throws(() => parsePng(bytes), new RegExp(`颜色管理扩展块 ${type}`), type);
  }
});

test('白名单外的块（PLTE/未知块）→ 报错', () => {
  for (const type of ['PLTE', 'bLOK']) {
    const bytes = concatBytes(SIGNATURE, ihdr(4, 4), chunk(type, new Uint8Array(3)), idatFromRgba(solid(4, 4, [0, 0, 0, 255]), 4, 4), chunk('IEND'));
    assert.throws(() => parsePng(bytes), /不允许的块类型/, type);
  }
});

test('IEND 之后有多余数据 → 报错', () => {
  const bytes = concatBytes(minimalPng(), new Uint8Array([1, 2, 3]));
  assert.throws(() => parsePng(bytes), /IEND 之后/);
});

test('缺少 IEND → 报错', () => {
  const bytes = concatBytes(SIGNATURE, ihdr(4, 4), idatFromRgba(solid(4, 4, [0, 0, 0, 255]), 4, 4));
  assert.throws(() => parsePng(bytes), /IEND/);
});

test('IDAT 不连续 → 报错', () => {
  const idat = idatFromRgba(solid(4, 4, [0, 0, 0, 255]), 4, 4);
  const bytes = concatBytes(SIGNATURE, ihdr(4, 4), idat, chunk('tEXt', new Uint8Array([65, 0, 66])), idat, chunk('IEND'));
  assert.throws(() => parsePng(bytes), /IDAT 块必须连续/);
});

test('acTL 出现在 IDAT 之后 → 报错', () => {
  const idat = idatFromRgba(solid(4, 4, [0, 0, 0, 255]), 4, 4);
  const actlData = new Uint8Array(8);
  const bytes = concatBytes(SIGNATURE, ihdr(4, 4), idat, chunk('acTL', actlData), chunk('IEND'));
  assert.throws(() => parsePng(bytes), /acTL 必须出现在第一个 IDAT 之前/);
});

test('错误是 PngError，携带定位信息', () => {
  const bytes = minimalPng();
  const bad = bytes.slice();
  bad[41] ^= 0x01; // 破坏 IDAT 数据（签名 8 + IHDR 25 + IDAT 头 8 = 41）→ CRC 失败
  try {
    parsePng(bad);
    assert.fail('应当抛出');
  } catch (e) {
    assert.ok(e instanceof PngError);
    assert.match(e.message, /IDAT/);
    assert.match(e.message, /偏移 \d+/);
  }
});

test('合法 APNG 的块顺序解析成功', () => {
  const bytes = buildApng({
    width: 8, height: 8,
    frames: [{ width: 8, height: 8, rgba: solid(8, 8, [1, 2, 3, 255]) }],
  });
  const parsed = parsePng(bytes);
  assert.deepEqual(parsed.chunks.map((c) => c.type), ['IHDR', 'acTL', 'IDAT', 'fcTL', 'fdAT', 'IEND']);
});
