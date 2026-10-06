#!/usr/bin/env node
// Node 侧命令行自检：用内置 zlib 解码普通单帧 PNG，验证真实 APNG 导入。
// 浏览器侧导出/下载往返由页面“运行自检”按钮验证。

import zlib from 'node:zlib';
import {
  ApngError,
  compositeFrame,
  crc32,
  inspectApng,
} from '../public/apng.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertPixel(actual, expected, message) {
  for (let i = 0; i < 4; i += 1) {
    assert(
      actual[i] === expected[i],
      `${message}: 通道 ${i} 期望 ${expected[i]}，实际 ${actual[i]}`,
    );
  }
}

function chunk(type, data = Buffer.alloc(0)) {
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  output.write(type, 4, 'ascii');
  data.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, 8 + data.length)), 8 + data.length);
  return output;
}

function ihdr(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data.writeUInt8(8, 8);
  data.writeUInt8(6, 9); // RGBA
  return chunk('IHDR', data);
}

function adler32(data) {
  let a = 1;
  let b = 0;
  for (const value of data) {
    a = (a + value) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function storeDeflate(input) {
  const blocks = [];
  for (let offset = 0; offset < input.length; offset += 65535) {
    const part = input.subarray(offset, Math.min(input.length, offset + 65535));
    const block = Buffer.alloc(5 + part.length);
    block.writeUInt8(offset + part.length >= input.length ? 1 : 0, 0);
    block.writeUInt16LE(part.length, 1);
    block.writeUInt16LE(part.length ^ 0xffff, 3);
    part.copy(block, 5);
    blocks.push(block);
  }

  const body = Buffer.concat(blocks);
  const output = Buffer.alloc(6 + body.length);
  output.writeUInt8(0x78, 0);
  output.writeUInt8(0x01, 1);
  body.copy(output, 2);
  output.writeUInt32BE(adler32(input), 2 + body.length);
  return output;
}

function encodeRgbaPng(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const targetOffset = y * (width * 4 + 1);
    raw.writeUInt8(0, targetOffset);
    for (let x = 0; x < width; x += 1) {
      raw.set(pixels[y * width + x], targetOffset + 1 + x * 4);
    }
  }
  return Buffer.concat([SIGNATURE, ihdr(width, height), chunk('IDAT', storeDeflate(raw)), chunk('IEND')]);
}

function fctl(sequenceNumber, options) {
  const data = Buffer.alloc(26);
  data.writeUInt32BE(sequenceNumber, 0);
  data.writeUInt32BE(options.width, 4);
  data.writeUInt32BE(options.height, 8);
  data.writeUInt32BE(options.x ?? 0, 12);
  data.writeUInt32BE(options.y ?? 0, 16);
  data.writeUInt16BE(options.delayNum ?? 0, 20);
  data.writeUInt16BE(options.delayDen ?? 1, 22);
  data.writeUInt8(options.dispose ?? 0, 24);
  data.writeUInt8(options.blend ?? 0, 25);
  return chunk('fcTL', data);
}

function readChunks(bytes) {
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    chunks.push({
      type,
      offset,
      dataStart: offset + 8,
      dataEnd: offset + 8 + length,
      next: offset + 12 + length,
    });
    offset += 12 + length;
  }
  return chunks;
}

function idatData(png) {
  const idat = readChunks(png).find((item) => item.type === 'IDAT');
  return png.subarray(idat.dataStart, idat.dataEnd);
}

function fdat(sequenceNumber, png) {
  const data = Buffer.alloc(4 + idatData(png).length);
  data.writeUInt32BE(sequenceNumber, 0);
  idatData(png).copy(data, 4);
  return chunk('fdAT', data);
}

function encodeApng(width, height, frameSpecs, options = {}) {
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frameSpecs.length, 0);

  const parts = [SIGNATURE, ihdr(width, height), chunk('acTL', actl)];
  let sequence = 0;

  if (!options.defaultInAnimation) {
    // 默认静态图只放在 IDAT 中，不写第一个 fcTL。规范动画序号从 fdAT 前的 fcTL=1 开始。
    const defaultPng = encodeRgbaPng(width, height, options.defaultPixels
      ?? frameSpecs[0].pixels.map(() => [0, 0, 0, 0]));
    parts.push(chunk('IDAT', idatData(defaultPng)));
    sequence = 1;

    frameSpecs.forEach((spec, index) => {
      parts.push(fctl(sequence, spec));
      sequence += 1;
      const framePng = encodeRgbaPng(spec.width, spec.height, spec.pixels);
      parts.push(fdat(sequence, framePng));
      sequence += 1;
    });
  } else {
    frameSpecs.forEach((spec, index) => {
      parts.push(fctl(sequence, spec));
      sequence += 1;
      const framePng = encodeRgbaPng(spec.width, spec.height, spec.pixels);
      if (index === 0) {
        parts.push(chunk('IDAT', idatData(framePng)));
      } else {
        parts.push(fdat(sequence, framePng));
        sequence += 1;
      }
    });
  }

  parts.push(chunk('IEND'));
  return Buffer.concat(parts);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodeNodePng(input) {
  const bytes = Buffer.from(input);
  assert(bytes.subarray(0, 8).equals(SIGNATURE), 'PNG 签名错误');

  let width = 0;
  let height = 0;
  const idat = [];

  for (const item of readChunks(bytes)) {
    const data = bytes.subarray(item.dataStart, item.dataEnd);
    if (item.type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert(data.readUInt8(8) === 8, '仅 8 位');
      assert(data.readUInt8(9) === 6, '仅 RGBA');
      assert(data.readUInt8(12) === 0, '不允许隔行');
    } else if (item.type === 'IDAT') {
      idat.push(data);
    }
  }

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);

  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * (stride + 1);
    const filter = inflated[sourceOffset];
    const targetOffset = row * stride;

    for (let column = 0; column < stride; column += 1) {
      const raw = inflated[sourceOffset + 1 + column];
      const left = column >= bytesPerPixel ? pixels[targetOffset + column - bytesPerPixel] : 0;
      const up = row > 0 ? pixels[targetOffset - stride + column] : 0;
      const upLeft = row > 0 && column >= bytesPerPixel
        ? pixels[targetOffset - stride + column - bytesPerPixel]
        : 0;

      let value = raw;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paeth(left, up, upLeft);
      else throw new Error(`未知 PNG filter ${filter}`);
      pixels[targetOffset + column] = value & 255;
    }
  }

  return { width, height, data: new Uint8ClampedArray(pixels) };
}

function makeFrame(control, data) {
  return {
    control: {
      sequenceNumber: 0,
      delayNumerator: 0,
      delayDenominator: 1,
      delayMs: 0,
      xOffset: 0,
      yOffset: 0,
      ...control,
    },
    bitmap: {
      width: control.width,
      height: control.height,
      data: new Uint8ClampedArray(data),
    },
  };
}

function testTinyArray() {
  let canvas = new Uint8ClampedArray([255, 255, 255, 255]);
  const over = makeFrame(
    { width: 1, height: 1, disposeOp: 0, blendOp: 1 },
    [0, 0, 255, 128],
  );
  const state = compositeFrame(canvas, 1, 1, over);
  assertPixel(state.post, [127, 127, 255, 255], '透明 OVER 结果错误');

  canvas = new Uint8ClampedArray([
    255, 255, 255, 255,
    255, 255, 255, 255,
  ]);

  const first = makeFrame(
    { width: 1, height: 1, xOffset: 0, yOffset: 0, disposeOp: 0, blendOp: 1 },
    [0, 0, 255, 128],
  );
  const second = makeFrame(
    { width: 1, height: 1, xOffset: 0, yOffset: 1, disposeOp: 2, blendOp: 0 },
    [255, 0, 0, 255],
  );
  const third = makeFrame(
    { width: 1, height: 1, xOffset: 0, yOffset: 1, disposeOp: 2, blendOp: 0 },
    [0, 255, 0, 255],
  );

  const states = [];
  for (const frame of [first, second, third]) {
    const next = compositeFrame(canvas, 2, 1, frame);
    states.push(next);
    canvas = next.cleaned;
  }
  assertPixel(states[2].cleaned.slice(4, 8), [255, 255, 255, 255], '连续 PREVIOUS 错误');
  const snapshots = states.map((state) => new Uint8ClampedArray(state.post));
  for (const index of [2, 0, 1, 2, 1, 0]) {
    for (let i = 0; i < snapshots[index].length; i += 1) {
      assert(
        states[index].post[i] === snapshots[index][i],
        `任意跳转到帧 ${index} 后第 ${i} 个像素通道漂移`,
      );
    }
  }
}

function flipCrc(type, occurrence = 0) {
  return (bytes) => {
    const matches = readChunks(bytes).filter((chunkInfo) => chunkInfo.type === type);
    const target = matches[occurrence];
    bytes[target.next - 1] ^= 0xff;
    return bytes;
  };
}

async function expectFailure(label, bytes) {
  let failed = false;
  try {
    await inspectApng(bytes, decodeNodePng);
  } catch (error) {
    assert(error instanceof ApngError, `${label}: 应为 ApngError，实际 ${error}`);
    failed = true;
  }
  assert(failed, label);
}

async function testRealApng() {
  const staticPng = encodeRgbaPng(1, 1, [[10, 20, 30, 255]]);
  const staticResult = await inspectApng(staticPng, decodeNodePng);
  assert(!staticResult.isAnimated, '普通 PNG 类型错误');
  assert(staticResult.defaultImage.inAnimation === null, '普通 PNG 默认图标记错误');

  const apng = encodeApng(2, 1, [
    {
      width: 2,
      height: 1,
      dispose: 0,
      blend: 1,
      pixels: [[0, 0, 255, 128], [255, 255, 255, 255]],
    },
    {
      width: 1,
      height: 1,
      x: 1,
      dispose: 2,
      blend: 0,
      pixels: [[255, 0, 0, 255]],
    },
  ], { defaultInAnimation: true });

  const result = await inspectApng(apng, decodeNodePng);
  assert(result.isAnimated, 'APNG 类型错误');
  assert(result.animation.frameCount === 2, 'acTL 帧数错误');
  assert(result.defaultImage.inAnimation, '默认图应属于动画');
  assertPixel(result.states[0].post.slice(0, 4), [0, 0, 255, 128], '真实文件首帧在透明画布上的 OVER 错误');
  assertPixel(result.states[1].cleaned.slice(4, 8), [255, 255, 255, 255], '真实文件 PREVIOUS 错误');

  const excludedDefaultApng = encodeApng(
    1,
    1,
    [{
      width: 1,
      height: 1,
      dispose: 0,
      blend: 0,
      pixels: [[10, 20, 30, 255]],
    }],
    {
      defaultPixels: [[200, 100, 50, 255]],
    },
  );
  const excludedDefaultResult = await inspectApng(excludedDefaultApng, decodeNodePng);
  assert(excludedDefaultResult.animation.frameCount === 1, '默认图不属于动画时 acTL 仍应为 1');
  assert(excludedDefaultResult.defaultImage.inAnimation === false, '默认图不应被错误纳入时间轴');
  assertPixel(
    excludedDefaultResult.states[0].post,
    [10, 20, 30, 255],
    '默认图不属于动画时应从透明画布合成 fdAT 第一帧',
  );

  await expectFailure('IEND CRC 坏块不能通过', flipCrc('IEND')(apng));
  await expectFailure('IDAT CRC 坏块不能降级为静态 PNG', flipCrc('IDAT')(staticPng));

  const badSequence = Buffer.from(apng);
  const fdatInfo = readChunks(badSequence).find((item) => item.type === 'fdAT');
  badSequence.writeUInt32BE(99, fdatInfo.dataStart);
  badSequence.writeUInt32BE(
    crc32(badSequence.subarray(fdatInfo.offset + 4, fdatInfo.dataEnd)),
    fdatInfo.dataEnd,
  );
  await expectFailure('fdAT 非连续序号不能通过', badSequence);
}

await testTinyArray();
await testRealApng();
console.log('Node 自检通过：独立像素数组、真实 PNG/APNG 解析、CRC 与序号错误均符合预期。');
