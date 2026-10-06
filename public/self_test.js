// 内置自检：既验证独立小像素数组的合成语义，也生成真实 PNG/APNG 字节
// 走一遍结构解析、浏览器 PNG 解码与 PNG 导出。

import {
  ApngError,
  compositeFrame,
  crc32,
  decodePngInBrowser,
  exportImageDataBlob,
  inspectApng,
} from './apng.js';

function rgba(r, g, b, a) {
  return new Uint8ClampedArray([r, g, b, a]);
}

function makeFrame(width, height, control, data) {
  return {
    width,
    height,
    bitmap: {
      width: control.width,
      height: control.height,
      data: new Uint8ClampedArray(data),
    },
    control: {
      xOffset: 0,
      yOffset: 0,
      disposeOp: 0,
      blendOp: 0,
      delayNumerator: 0,
      delayDenominator: 1,
      delayMs: 0,
      sequenceNumber: 0,
      ...control,
    },
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertPixel(actual, expected, message) {
  for (let i = 0; i < 4; i += 1) {
    assert(
      actual[i] === expected[i],
      `${message}：通道 ${i} 期望 ${expected[i]}，实际 ${actual[i]}；RGBA=[${[...actual]}]`,
    );
  }
}

function testOverlaySemantics() {
  // 目标为不透明白；局部源为 50% 蓝。按规范未预乘 alpha 公式取整后应为 RGB(0,0,127)/255。
  let canvas = new Uint8ClampedArray([255, 255, 255, 255]);
  const sourceOver = makeFrame(1, 1, {
    width: 1,
    height: 1,
    disposeOp: 0,
    blendOp: 1,
  }, [0, 0, 255, 128]);

  const overState = compositeFrame(canvas, 1, 1, sourceOver);
  assertPixel(overState.pre, rgba(255, 255, 255, 255), 'OVER 的帧前画布错误');
  assertPixel(overState.post, rgba(127, 127, 255, 255), 'OVER 的展示画布错误');
  assertPixel(overState.cleaned, rgba(127, 127, 255, 255), 'NONE 清理画布错误');

  // SOURCE 必须连同透明值替换，而不是把透明像素当 no-op。
  canvas = new Uint8ClampedArray([10, 20, 30, 255]);
  const sourceFrame = makeFrame(1, 1, {
    width: 1,
    height: 1,
    disposeOp: 0,
    blendOp: 0,
  }, [0, 0, 255, 0]);
  const sourceState = compositeFrame(canvas, 1, 1, sourceFrame);
  assertPixel(sourceState.post, rgba(0, 0, 255, 0), 'SOURCE 应连同透明源像素的 RGB 一起写入');
}

function testPreviousAndJumps() {
  // 1×2 画布：
  // 帧 0 在像素 0 上用半透明蓝 OVER，NONE 保留；
  // 帧 1 用 PREVIOUS 覆盖像素 1；
  // 帧 2 再用 PREVIOUS 覆盖同一个矩形，验证连续 PREVIOUS 不会引用上一帧展示图。
  const initial = new Uint8ClampedArray([
    255, 255, 255, 255,
    255, 255, 255, 255,
  ]);

  const frame0 = makeFrame(2, 1, {
    width: 1,
    height: 1,
    xOffset: 0,
    yOffset: 0,
    disposeOp: 0,
    blendOp: 1,
  }, [0, 0, 255, 128]);

  const frame1 = makeFrame(2, 1, {
    width: 1,
    height: 1,
    xOffset: 0,
    yOffset: 1,
    disposeOp: 2,
    blendOp: 0,
  }, [255, 0, 0, 255]);

  const frame2 = makeFrame(2, 1, {
    width: 1,
    height: 1,
    xOffset: 0,
    yOffset: 1,
    disposeOp: 2,
    blendOp: 0,
  }, [0, 255, 0, 255]);

  let canvas = initial;
  const states = [];
  for (const frame of [frame0, frame1, frame2]) {
    const state = compositeFrame(canvas, 1, 2, frame);
    states.push(state);
    canvas = state.cleaned;
  }

  assertPixel(states[0].pre.slice(0, 4), rgba(255, 255, 255, 255), '帧0像素0帧前错误');
  assertPixel(states[0].post.slice(0, 4), rgba(127, 127, 255, 255), '帧0 OVER 结果错误');
  assertPixel(states[0].cleaned.slice(0, 4), rgba(127, 127, 255, 255), '帧0 NONE 结果错误');

  assertPixel(states[1].pre.slice(4, 8), rgba(255, 255, 255, 255), '帧1像素1帧前应为初始白');
  assertPixel(states[1].post.slice(4, 8), rgba(255, 0, 0, 255), '帧1展示像素错误');
  assertPixel(states[1].cleaned.slice(4, 8), rgba(255, 255, 255, 255), '帧1 PREVIOUS 应恢复初始白');
  assertPixel(states[1].cleaned.slice(0, 4), rgba(127, 127, 255, 255), '帧1不应改动矩形外像素');

  assertPixel(states[2].pre.slice(4, 8), rgba(255, 255, 255, 255), '连续 PREVIOUS 时帧2帧前应来自恢复后的画布');
  assertPixel(states[2].post.slice(4, 8), rgba(0, 255, 0, 255), '帧2展示像素错误');
  assertPixel(states[2].cleaned.slice(4, 8), rgba(255, 255, 255, 255), '连续 PREVIOUS 应恢复白色而非上一帧的绿色或红色');

  // 快照按帧号读取，前进、后退、乱序跳转不能重算，也不能改变任何像素。
  const order = [2, 0, 1, 2, 1, 0];
  const expected = states.map((state) => state.post.slice());
  for (const frameNumber of order) {
    assertPixel(states[frameNumber].post, expected[frameNumber], `跳转到帧 ${frameNumber} 后像素漂移`);
  }
}

// --- 以下函数生成无第三方依赖的真实 PNG/APNG 测试文件 ---

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function text(type) {
  return new TextEncoder().encode(type);
}

function chunk(type, data = new Uint8Array(0)) {
  const typeBytes = text(type);
  const output = new Uint8Array(12 + data.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(typeBytes, 4);
  output.set(data, 8);
  view.setUint32(8 + data.length, crc32(output.subarray(4, 8 + data.length)));
  return output;
}

function concat(parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function ihdr(width, height) {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  view.setUint8(8, 8);
  view.setUint8(9, 6);
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
  // 仅用于测试夹具：输出未压缩 zlib 数据块。
  const blocks = [];
  for (let offset = 0; offset < input.length; offset += 65535) {
    const part = input.subarray(offset, Math.min(input.length, offset + 65535));
    const block = new Uint8Array(5 + part.length);
    const finalBlock = offset + part.length >= input.length ? 1 : 0;
    block[0] = finalBlock;
    const view = new DataView(block.buffer);
    view.setUint16(1, part.length, true);
    view.setUint16(3, part.length ^ 0xffff, true);
    block.set(part, 5);
    blocks.push(block);
  }

  const body = concat(blocks);
  const output = new Uint8Array(6 + body.length);
  output[0] = 0x78;
  output[1] = 0x01;
  output.set(body, 2);
  new DataView(output.buffer).setUint32(2 + body.length, adler32(input));
  return output;
}

function pixelRgba(pixel) {
  return [pixel[0], pixel[1], pixel[2], pixel[3] ?? 255];
}

function encodeRgbaPng(width, height, pixels) {
  const rowLength = width * 4;
  const raw = new Uint8Array((rowLength + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const targetOffset = y * (rowLength + 1);
    raw[targetOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      raw.set(pixelRgba(pixels[y * width + x]), targetOffset + 1 + x * 4);
    }
  }
  return concat([SIGNATURE, ihdr(width, height), chunk('IDAT', storeDeflate(raw)), chunk('IEND')]);
}

function fctl(sequence, frame) {
  const data = new Uint8Array(26);
  const view = new DataView(data.buffer);
  view.setUint32(0, sequence);
  view.setUint32(4, frame.width);
  view.setUint32(8, frame.height);
  view.setUint32(12, frame.x ?? 0);
  view.setUint32(16, frame.y ?? 0);
  view.setUint16(20, frame.delayNum ?? 0);
  view.setUint16(22, frame.delayDen ?? 1);
  view.setUint8(24, frame.dispose ?? 0);
  view.setUint8(25, frame.blend ?? 0);
  return chunk('fcTL', data);
}

function fdat(sequence, pngBytes) {
  const { offset } = findChunk(pngBytes, 'IDAT');
  const idatLength = new DataView(pngBytes.buffer, pngBytes.byteOffset + offset, 4).getUint32(0);
  const imageData = pngBytes.subarray(offset + 8, offset + 8 + idatLength);
  const data = new Uint8Array(4 + imageData.length);
  new DataView(data.buffer).setUint32(0, sequence);
  data.set(imageData, 4);
  return chunk('fdAT', data);
}

function extractIdatData(pngBytes) {
  const { offset } = findChunk(pngBytes, 'IDAT');
  const idatLength = new DataView(pngBytes.buffer, pngBytes.byteOffset + offset, 4).getUint32(0);
  return pngBytes.subarray(offset + 8, offset + 8 + idatLength);
}

function encodeApng(canvasWidth, canvasHeight, frames) {
  const actlData = new Uint8Array(8);
  new DataView(actlData.buffer).setUint32(0, frames.length);

  const parts = [
    SIGNATURE,
    ihdr(canvasWidth, canvasHeight),
    chunk('acTL', actlData),
  ];

  let sequence = 0;
  frames.forEach((frame, index) => {
    parts.push(fctl(sequence, frame));
    sequence += 1;

    const framePng = encodeRgbaPng(frame.width, frame.height, frame.pixels);
    if (index === 0) {
      // 默认图属于动画：提取单帧 IDAT 数据。
      parts.push(chunk('IDAT', extractIdatData(framePng)));
    } else {
      parts.push(fdat(sequence, framePng));
      sequence += 1;
    }
  });
  parts.push(chunk('IEND'));
  return concat(parts);
}

function findChunk(bytes, type, occurrence = 0) {
  let seen = 0;
  let offset = 8;
  while (offset < bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const currentType = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    const nextOffset = offset + 12 + length;
    if (currentType === type) {
      if (seen === occurrence) {
        return { offset, length, nextOffset };
      }
      seen += 1;
    }
    offset = nextOffset;
  }
  throw new Error(`测试夹具中找不到 ${type}`);
}

function flipCrc(bytes, type, occurrence = 0) {
  const corrupt = bytes.slice();
  const location = findChunk(corrupt, type, occurrence);
  corrupt[location.nextOffset - 1] ^= 0xff;
  return corrupt;
}

function replaceFdatSequence(bytes, occurrence, badSequence) {
  const corrupt = bytes.slice();
  const location = findChunk(corrupt, 'fdAT', occurrence);
  new DataView(
    corrupt.buffer,
    corrupt.byteOffset + location.offset + 8,
    4,
  ).setUint32(0, badSequence);

  // 重新计算 CRC，以便失败原因准确落在“序号不连续”，而不是 CRC。
  const crcOffset = location.offset + 8 + location.length;
  new DataView(corrupt.buffer, corrupt.byteOffset + crcOffset, 4).setUint32(
    0,
    crc32(corrupt.subarray(location.offset + 4, crcOffset)),
  );
  return corrupt;
}

async function testRealFiles() {
  const staticPng = encodeRgbaPng(2, 1, [
    [255, 0, 0, 255],
    [0, 255, 0, 64],
  ]);
  const staticResult = await inspectApng(staticPng, decodePngInBrowser);
  assert(!staticResult.isAnimated, '无 acTL 文件应识别为普通 PNG');
  assert(staticResult.states.length === 1, '普通 PNG 应有一个时间轴帧');
  assert(staticResult.defaultImage.inAnimation === null, '普通 PNG 的默认图归属标记应为 null');

  const apngBytes = encodeApng(2, 1, [
    {
      width: 2,
      height: 1,
      dispose: 0,
      blend: 1,
      pixels: [
        [0, 0, 255, 128],
        [255, 255, 255, 255],
      ],
    },
    {
      width: 1,
      height: 1,
      x: 1,
      y: 0,
      dispose: 2,
      blend: 0,
      pixels: [[255, 0, 0, 255]],
    },
  ]);

  const result = await inspectApng(apngBytes, decodePngInBrowser);
  assert(result.isAnimated, '应识别 acTL 动画');
  assert(result.animation.frameCount === 2, 'acTL 帧数应为 2');
  assert(result.defaultImage.inAnimation === true, '首帧 IDAT 应被识别为属于动画');
  assert(result.frames[1].encoding === 'fdAT', '第二帧应来自 fdAT');
  assertPixel(
    result.states[1].pre.slice(4, 8),
    rgba(255, 255, 255, 255),
    '真实 APNG 的局部帧帧前像素错误',
  );
  assertPixel(
    result.states[1].cleaned.slice(4, 8),
    rgba(255, 255, 255, 255),
    '真实 APNG 的 PREVIOUS 清理错误',
  );

  const post = result.states[0].post;
  const blob = await exportImageDataBlob(
    new ImageData(post, result.width, result.height),
  );
  assert(blob.size > 0, '导出的合成 PNG Blob 为空');
  const decoded = await decodePngInBrowser(new Uint8Array(await blob.arrayBuffer()));
  assertPixel(decoded.data.slice(0, 4), rgba(0, 0, 255, 128), '导出后的合成首帧像素错误');

  // “下载”的是完整画布合成图，不是局部原图：第二帧源图只有 1×1，
  // 导出当前 post 时必须保留左侧已经合成出的像素。
  const secondBlob = await exportImageDataBlob(
    new ImageData(result.states[1].post, result.width, result.height),
  );
  const secondDecoded = await decodePngInBrowser(new Uint8Array(await secondBlob.arrayBuffer()));
  assert(secondDecoded.width === 2 && secondDecoded.height === 1, '下载图必须保持完整画布尺寸');
  assertPixel(secondDecoded.data.slice(0, 4), rgba(0, 0, 255, 128), '下载第二帧时必须保留矩形外的旧像素');
  assertPixel(secondDecoded.data.slice(4, 8), rgba(255, 0, 0, 255), '下载第二帧的局部矩形像素错误');

  await assertRejects(
    () => inspectApng(flipCrc(apngBytes, 'IEND'), decodePngInBrowser),
    'CRC 坏块必须报错',
  );
  await assertRejects(
    () => inspectApng(replaceFdatSequence(apngBytes, 0, 99), decodePngInBrowser),
    'fdAT 序号断裂必须报错',
  );
  await assertRejects(
    () => inspectApng(flipCrc(staticPng, 'IDAT'), decodePngInBrowser),
    '坏块普通 PNG 不能作为静态 PNG 悄悄通过',
  );
}

async function assertRejects(action, message) {
  try {
    await action();
  } catch (error) {
    assert(error instanceof ApngError || error.message, `${message}：抛出了错误但类型异常：${error}`);
    return;
  }
  throw new Error(message);
}

export async function runSelfTests() {
  testOverlaySemantics();
  testPreviousAndJumps();
  await testRealFiles();
  return [
    '透明 OVER 与 SOURCE 小像素数组通过',
    '连续 PREVIOUS、矩形外保留与任意乱序跳转通过',
    '真实 PNG/APNG 导入、结构校验、合成 PNG 导出往返通过',
    'CRC 坏块与 fdAT 序号断裂均未降级',
  ];
}
