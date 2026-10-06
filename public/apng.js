// APNG 结构解析、序号/CRC 校验与手工合成。
// 普通单帧 PNG 的最终像素解码由调用方传入的成熟 PNG 解码器完成；
// 本文件不使用任何现成 APNG 播放器。

export const MAX_DIMENSION = 64;
export const MAX_FRAMES = 16;
export const MAX_FILE_BYTES = 64 * 1024;

const PNG_SIGNATURE = Object.freeze([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const COLOR_MANAGEMENT_CHUNKS = new Set([
  'cHRM',
  'gAMA',
  'iCCP',
  'sRGB',
  'mDCv',
  'cLLi',
]);

export class ApngError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApngError';
  }
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c >>> 0;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunkType(bytes, offset) {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function makeChunk(type, data = new Uint8Array(0)) {
  const typeBytes = new TextEncoder().encode(type);
  const output = new Uint8Array(12 + data.length);
  const view = new DataView(output.buffer);

  view.setUint32(0, data.length);
  output.set(typeBytes, 4);
  output.set(data, 8);
  view.setUint32(8 + data.length, crc32(output.subarray(4, 8 + data.length)));
  return output;
}

function parseFcTL(data, chunkOffset) {
  if (data.length !== 26) {
    throw new ApngError(
      `偏移 ${chunkOffset} 的 fcTL 长度为 ${data.length}，应为 26`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sequenceNumber = view.getUint32(0);
  const width = view.getUint32(4);
  const height = view.getUint32(8);
  const xOffset = view.getUint32(12);
  const yOffset = view.getUint32(16);
  const delayNumerator = view.getUint16(20);
  const delayDenominator = view.getUint16(22);
  const disposeOp = view.getUint8(24);
  const blendOp = view.getUint8(25);

  if (disposeOp > 2) {
    throw new ApngError(`fcTL 序号 ${sequenceNumber} 的 dispose_op=${disposeOp} 无效`);
  }
  if (blendOp > 1) {
    throw new ApngError(`fcTL 序号 ${sequenceNumber} 的 blend_op=${blendOp} 无效`);
  }

  const denominator = delayDenominator === 0 ? 100 : delayDenominator;
  const delayMs = delayNumerator / denominator * 1000;

  return {
    sequenceNumber,
    width,
    height,
    xOffset,
    yOffset,
    delayNumerator,
    delayDenominator,
    delayMs,
    disposeOp,
    blendOp,
  };
}

function validateRect(canvasWidth, canvasHeight, frame) {
  const right = frame.xOffset + frame.width;
  const bottom = frame.yOffset + frame.height;

  if (frame.width === 0 || frame.height === 0) {
    throw new ApngError(`fcTL 序号 ${frame.sequenceNumber} 的宽高不能为 0`);
  }
  if (right > canvasWidth || bottom > canvasHeight) {
    throw new ApngError(
      `fcTL 序号 ${frame.sequenceNumber} 的矩形 ${frame.width}×${frame.height}`
      + `@(${frame.xOffset},${frame.yOffset}) 超出画布 ${canvasWidth}×${canvasHeight}`,
    );
  }
}

export function parsePngStructure(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (bytes.length > MAX_FILE_BYTES) {
    throw new ApngError(
      `文件为 ${bytes.length} 字节，超过 ${MAX_FILE_BYTES} 字节（64 KiB）限制`,
    );
  }
  if (bytes.length < 8 || PNG_SIGNATURE.some((value, i) => bytes[i] !== value)) {
    throw new ApngError('不是 PNG 文件：PNG 签名不匹配');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let ihdr = null;
  let actl = null;
  const defaultDataChunks = [];
  const frames = [];
  const chunkLog = [];

  let currentFrame = null;
  let sawIdat = false;
  let idatSequenceOpen = false;
  let sawFdat = false;
  let sawIend = false;
  let defaultInAnimation = false;
  let expectedSequence = 0;

  let position = 8;

  while (position < bytes.length) {
    const chunkStart = position;
    if (position + 8 > bytes.length) {
      throw new ApngError('块长度字段被截断');
    }

    const length = view.getUint32(position);
    const typeOffset = position + 4;
    const dataOffset = position + 8;
    const crcOffset = dataOffset + length;
    const nextChunk = crcOffset + 4;

    if (nextChunk > bytes.length) {
      throw new ApngError(`偏移 ${chunkStart} 的块声明 ${length} 字节，但文件数据不足`);
    }

    const type = chunkType(bytes, typeOffset);
    const data = bytes.subarray(dataOffset, crcOffset);
    const storedCrc = view.getUint32(crcOffset);
    const actualCrc = crc32(bytes.subarray(typeOffset, crcOffset));

    if (actualCrc !== storedCrc) {
      throw new ApngError(
        `${type} 块 CRC 错误：偏移 ${chunkStart}，文件值 0x${storedCrc
          .toString(16).padStart(8, '0')}，计算值 0x${actualCrc
          .toString(16).padStart(8, '0')}`,
      );
    }

    if (sawIend) {
      throw new ApngError('IEND 之后不允许再有数据或块');
    }

    // PNG 要求所有 IDAT 连续。遇到任何非 IDAT 即表示默认图像的 IDAT 序列结束。
    if (sawIdat && type !== 'IDAT') {
      idatSequenceOpen = false;
    }

    let loggedSequence = null;

    switch (type) {
      case 'IHDR': {
        if (chunkStart !== 8) {
          throw new ApngError('IHDR 必须是第一个块');
        }
        if (ihdr) {
          throw new ApngError('存在多个 IHDR 块');
        }
        if (length !== 13) {
          throw new ApngError('IHDR 长度必须为 13');
        }

        ihdr = {
          width: view.getUint32(dataOffset),
          height: view.getUint32(dataOffset + 4),
          bitDepth: view.getUint8(dataOffset + 8),
          colorType: view.getUint8(dataOffset + 9),
          compressionMethod: view.getUint8(dataOffset + 10),
          filterMethod: view.getUint8(dataOffset + 11),
          interlaceMethod: view.getUint8(dataOffset + 12),
        };

        if (ihdr.width === 0 || ihdr.height === 0) {
          throw new ApngError('IHDR 宽高不能为 0');
        }
        if (ihdr.width > MAX_DIMENSION || ihdr.height > MAX_DIMENSION) {
          throw new ApngError(
            `画布为 ${ihdr.width}×${ihdr.height}，超过 ${MAX_DIMENSION}×${MAX_DIMENSION} 限制`,
          );
        }
        if (ihdr.bitDepth !== 8 || ihdr.colorType !== 6) {
          throw new ApngError(
            `仅支持 RGBA8：当前位深 ${ihdr.bitDepth}、colour type ${ihdr.colorType}（需要 8/6）`,
          );
        }
        if (ihdr.compressionMethod !== 0 || ihdr.filterMethod !== 0) {
          throw new ApngError('PNG 压缩方法或筛选方法不受支持');
        }
        if (ihdr.interlaceMethod !== 0) {
          throw new ApngError('不支持隔行扫描 PNG（interlace 必须为 0）');
        }
        break;
      }

      case 'acTL': {
        if (!ihdr) {
          throw new ApngError('acTL 不能位于 IHDR 之前');
        }
        if (actl) {
          throw new ApngError('存在多个 acTL 块');
        }
        if (sawIdat) {
          throw new ApngError('acTL 必须位于第一个 IDAT 之前');
        }
        if (length !== 8) {
          throw new ApngError('acTL 长度必须为 8');
        }

        const frameCount = view.getUint32(dataOffset);
        const playCount = view.getUint32(dataOffset + 4);
        if (frameCount === 0) {
          throw new ApngError('acTL 帧数不能为 0');
        }
        if (frameCount > MAX_FRAMES) {
          throw new ApngError(`acTL 声明 ${frameCount} 帧，超过 ${MAX_FRAMES} 帧限制`);
        }

        actl = { frameCount, playCount };
        break;
      }

      case 'fcTL': {
        if (!actl) {
          throw new ApngError('发现 fcTL，但前面没有有效的 acTL');
        }
        if (currentFrame && currentFrame.dataChunks.length === 0) {
          throw new ApngError(
            `第 ${currentFrame.number + 1} 个 fcTL 后面没有任何图像数据`,
          );
        }

        const control = parseFcTL(data, chunkStart);
        let expectedForChunk = expectedSequence;

        // 默认图不属于动画时，IDAT 本身不占动画序号；它前面的 fdAT 第一帧
        // 仍按规范从序号 1 开始（序号 0 被跳过但连续校验知道这一点）。
        if (sawIdat && frames.length === 0) {
          expectedSequence = 1;
          expectedForChunk = 1;
        }

        if (control.sequenceNumber !== expectedForChunk) {
          throw new ApngError(
            `动画序号不连续：在偏移 ${chunkStart} 期望 ${expectedForChunk}，实际 ${control.sequenceNumber}`,
          );
        }
        expectedSequence = control.sequenceNumber + 1;
        loggedSequence = control.sequenceNumber;

        validateRect(ihdr.width, ihdr.height, control);

        // IDAT 之前的第一个 fcTL 表示默认图像本身就是第一帧。
        // APNG 规范要求该帧矩形与 IHDR 画布完全一致。
        if (!sawIdat) {
          if (
            control.width !== ihdr.width
            || control.height !== ihdr.height
            || control.xOffset !== 0
            || control.yOffset !== 0
          ) {
            throw new ApngError(
              '使用默认 IDAT 图像作为第一帧时，fcTL 矩形必须等于完整画布且偏移为 (0,0)',
            );
          }
        }

        currentFrame = {
          number: frames.length,
          control,
          encoding: null,
          dataChunks: [],
        };
        frames.push(currentFrame);
        break;
      }

      case 'IDAT': {
        if (!ihdr) {
          throw new ApngError('IDAT 不能位于 IHDR 之前');
        }

        if (!sawIdat) {
          sawIdat = true;
          idatSequenceOpen = true;

          if (actl && currentFrame && currentFrame.number === 0) {
            defaultInAnimation = true;
            currentFrame.encoding = 'IDAT';
          } else if (actl) {
            // acTL 存在，但 IDAT 前没有第一帧 fcTL：
            // 默认图像只作兼容图，不属于动画时间轴。
            defaultInAnimation = false;
          }
        }

        if (!idatSequenceOpen) {
          throw new ApngError('IDAT 块必须连续，不能被其他块分隔');
        }

        if (actl) {
          if (defaultInAnimation) {
            if (currentFrame !== frames[0] || currentFrame.encoding !== 'IDAT') {
              throw new ApngError('第一帧之后不能再出现 IDAT，后续帧必须使用 fdAT');
            }
            currentFrame.dataChunks.push(data);
          } else if (currentFrame) {
            throw new ApngError('默认图像之外的动画帧不能使用 IDAT');
          }
        }

        defaultDataChunks.push(data);
        break;
      }

      case 'fdAT': {
        if (!actl) {
          throw new ApngError('发现 fdAT，但文件没有 acTL 动画控制块');
        }
        if (!sawIdat) {
          throw new ApngError('fdAT 不能位于默认 IDAT 图像之前');
        }
        if (!currentFrame) {
          throw new ApngError('fdAT 前面缺少对应的 fcTL');
        }
        if (currentFrame.encoding === 'IDAT') {
          throw new ApngError('fdAT 不能追加到使用 IDAT 的第一帧');
        }
        if (length < 4) {
          throw new ApngError(`偏移 ${chunkStart} 的 fdAT 缺少 4 字节序号`);
        }

        const sequenceNumber = view.getUint32(dataOffset);
        loggedSequence = sequenceNumber;
        if (sequenceNumber !== expectedSequence) {
          throw new ApngError(
            `动画序号不连续：在偏移 ${chunkStart} 期望 ${expectedSequence}，实际 ${sequenceNumber}`,
          );
        }
        expectedSequence += 1;

        currentFrame.encoding = 'fdAT';
        currentFrame.dataChunks.push(data.subarray(4));
        sawFdat = true;
        break;
      }

      case 'PLTE': {
        if (!ihdr) {
          throw new ApngError('PLTE 不能位于 IHDR 之前');
        }
        if (sawIdat || sawFdat) {
          throw new ApngError('PLTE 必须位于图像数据之前');
        }
        if (length % 3 !== 0) {
          throw new ApngError('PLTE 长度必须是 3 的倍数');
        }
        break;
      }

      case 'tRNS':
        throw new ApngError('RGBA8 图像不允许 tRNS 透明块');

      case 'IEND':
        if (length !== 0) {
          throw new ApngError('IEND 长度必须为 0');
        }
        sawIend = true;
        break;

      default: {
        if (COLOR_MANAGEMENT_CHUNKS.has(type)) {
          throw new ApngError(`不允许颜色管理扩展块 ${type}`);
        }

        const firstChar = type.charCodeAt(0);
        const isCritical = firstChar >= 65 && firstChar <= 90;
        if (isCritical) {
          throw new ApngError(`遇到未知关键块 ${type}，校验器拒绝继续解析`);
        }
        // 其他已知或安全的辅助块仅记录，不参与手工合成。
      }
    }

    chunkLog.push({
      type,
      offset: chunkStart,
      length,
      sequence: loggedSequence,
    });
    position = nextChunk;
  }

  if (!ihdr) {
    throw new ApngError('缺少 IHDR 块');
  }
  if (!sawIend) {
    throw new ApngError('缺少 IEND 结束块');
  }
  if (defaultDataChunks.length === 0) {
    throw new ApngError('缺少默认图像的 IDAT 数据');
  }
  if (currentFrame && currentFrame.dataChunks.length === 0) {
    throw new ApngError(`第 ${currentFrame.number + 1} 帧缺少图像数据`);
  }

  const defaultImageBytes = concatBytes(defaultDataChunks);
  const parsedFrames = frames.map((frame) => ({
    number: frame.number,
    encoding: frame.encoding,
    control: frame.control,
    data: concatBytes(frame.dataChunks),
  }));

  if (actl && parsedFrames.length !== actl.frameCount) {
    throw new ApngError(
      `acTL 声明 ${actl.frameCount} 帧，但实际找到 ${parsedFrames.length} 个 fcTL`,
    );
  }
  if (actl) {
    for (const frame of parsedFrames) {
      if (frame.data.length === 0) {
        throw new ApngError(`第 ${frame.number + 1} 帧没有 IDAT/fdAT 图像数据`);
      }
    }
  }

  return {
    width: ihdr.width,
    height: ihdr.height,
    ihdr,
    isAnimated: Boolean(actl),
    animation: actl,
    defaultImage: {
      inAnimation: actl ? defaultInAnimation : null,
      data: defaultImageBytes,
    },
    frames: parsedFrames,
    chunks: chunkLog,
  };
}

export function buildSingleFramePng(ihdr, width, height, imageData) {
  const ihdrData = new Uint8Array(13);
  const view = new DataView(ihdrData.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  view.setUint8(8, ihdr.bitDepth);
  view.setUint8(9, ihdr.colorType);
  view.setUint8(10, ihdr.compressionMethod);
  view.setUint8(11, ihdr.filterMethod);
  view.setUint8(12, ihdr.interlaceMethod);

  const signature = Uint8Array.from(PNG_SIGNATURE);
  return concatBytes([
    signature,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', imageData),
    makeChunk('IEND'),
  ]);
}

function assertBitmap(bitmap, expectedWidth, expectedHeight, label) {
  if (!bitmap || bitmap.width !== expectedWidth || bitmap.height !== expectedHeight) {
    throw new ApngError(
      `${label} 解码尺寸应为 ${expectedWidth}×${expectedHeight}，实际为 ${
        bitmap?.width ?? '?'}×${bitmap?.height ?? '?'}`,
    );
  }
  const expectedLength = expectedWidth * expectedHeight * 4;
  if (!bitmap.data || bitmap.data.length < expectedLength) {
    throw new ApngError(`${label} 解码后的 RGBA 像素数组长度不足`);
  }
}

function blendOver(destination, destinationIndex, source, sourceIndex) {
  const sourceAlpha = source[sourceIndex + 3];

  // alpha 为 0 的 OVER 必须完全保留目标像素。
  if (sourceAlpha === 0) {
    return;
  }

  const destinationAlpha = destination[destinationIndex + 3];
  if (sourceAlpha === 255) {
    destination[destinationIndex] = source[sourceIndex];
    destination[destinationIndex + 1] = source[sourceIndex + 1];
    destination[destinationIndex + 2] = source[sourceIndex + 2];
    destination[destinationIndex + 3] = 255;
    return;
  }

  const inverseAlpha = 255 - sourceAlpha;
  const outAlpha = sourceAlpha + destinationAlpha * inverseAlpha / 255;

  if (outAlpha <= 0) {
    return;
  }

  for (let channel = 0; channel < 3; channel += 1) {
    const sourceContribution = sourceAlpha * source[sourceIndex + channel] / 255;
    const destinationContribution =
      destinationAlpha * destination[destinationIndex + channel]
      * inverseAlpha
      / (255 * 255);
    destination[destinationIndex + channel] =
      Math.round((sourceContribution + destinationContribution) / outAlpha * 255);
  }
  destination[destinationIndex + 3] = Math.round(outAlpha);
}

function copyRectangle(destination, source, width, rectangle) {
  const { xOffset: x, yOffset: y, width: rectWidth, height: rectHeight } = rectangle;
  for (let row = 0; row < rectHeight; row += 1) {
    const sourceStart = ((y + row) * width + x) * 4;
    destination.set(
      source.subarray(sourceStart, sourceStart + rectWidth * 4),
      sourceStart,
    );
  }
}

function clearRectangle(pixels, width, rectangle) {
  const { xOffset: x, yOffset: y, width: rectWidth, height: rectHeight } = rectangle;
  for (let row = 0; row < rectHeight; row += 1) {
    const start = ((y + row) * width + x) * 4;
    pixels.fill(0, start, start + rectWidth * 4);
  }
}

export function compositeFrame(canvas, canvasWidth, canvasHeight, frame) {
  const pre = new Uint8ClampedArray(canvas);
  const working = new Uint8ClampedArray(canvas);
  const { control, bitmap } = frame;
  const {
    xOffset: x,
    yOffset: y,
    width: frameWidth,
    height: frameHeight,
    blendOp,
    disposeOp,
  } = control;

  for (let row = 0; row < frameHeight; row += 1) {
    for (let column = 0; column < frameWidth; column += 1) {
      const sourceIndex = (row * frameWidth + column) * 4;
      const destinationIndex = ((y + row) * canvasWidth + x + column) * 4;

      if (blendOp === 0) {
        // SOURCE：连同 alpha 一起替换当前矩形。
        working[destinationIndex] = bitmap.data[sourceIndex];
        working[destinationIndex + 1] = bitmap.data[sourceIndex + 1];
        working[destinationIndex + 2] = bitmap.data[sourceIndex + 2];
        working[destinationIndex + 3] = bitmap.data[sourceIndex + 3];
      } else {
        blendOver(working, destinationIndex, bitmap.data, sourceIndex);
      }
    }
  }

  const post = new Uint8ClampedArray(working);
  const cleaned = new Uint8ClampedArray(post);

  if (disposeOp === 1) {
    // BACKGROUND：当前矩形恢复为全透明黑色。
    clearRectangle(cleaned, canvasWidth, control);
  } else if (disposeOp === 2) {
    // PREVIOUS：恢复“本帧绘制之前”的矩形，而不是上一帧展示后的矩形。
    copyRectangle(cleaned, pre, canvasWidth, control);
  }

  return { pre, post, cleaned };
}

export function composeAnimation(width, height, frames) {
  let canvas = new Uint8ClampedArray(width * height * 4);
  const states = [];

  for (const frame of frames) {
    const state = compositeFrame(canvas, width, height, frame);
    states.push(state);
    canvas = state.cleaned;
  }

  return states;
}

export async function inspectApng(input, decodePng) {
  const structure = parsePngStructure(input);
  const { width, height, ihdr } = structure;

  if (!structure.isAnimated) {
    const pngBytes = buildSingleFramePng(
      ihdr,
      width,
      height,
      structure.defaultImage.data,
    );
    const bitmap = await decodePng(pngBytes);
    assertBitmap(bitmap, width, height, '普通 PNG');

    const control = {
      sequenceNumber: null,
      width,
      height,
      xOffset: 0,
      yOffset: 0,
      delayNumerator: 0,
      delayDenominator: 1,
      delayMs: 0,
      disposeOp: 0,
      blendOp: 0,
    };
    const timeline = [{
      number: 0,
      encoding: 'IDAT',
      control,
      bitmap,
    }];

    return {
      ...structure,
      timeline,
      states: composeAnimation(width, height, timeline),
    };
  }

  const timeline = [];

  for (const parsedFrame of structure.frames) {
    const { control } = parsedFrame;
    const pngBytes = buildSingleFramePng(
      ihdr,
      control.width,
      control.height,
      parsedFrame.data,
    );

    let bitmap;
    try {
      bitmap = await decodePng(pngBytes);
    } catch (error) {
      throw new ApngError(
        `第 ${parsedFrame.number + 1} 帧的单帧 PNG 解码失败：${error.message}`,
      );
    }
    assertBitmap(bitmap, control.width, control.height, `第 ${parsedFrame.number + 1} 帧`);

    timeline.push({
      ...parsedFrame,
      bitmap,
    });
  }

  return {
    ...structure,
    timeline,
    states: composeAnimation(width, height, timeline),
  };
}

export async function decodePngInBrowser(input) {
  const blob = input instanceof Blob
    ? input
    : new Blob([input], { type: 'image/png' });
  const imageBitmap = await createImageBitmap(blob);

  try {
    const canvas = document.createElement('canvas');
    canvas.width = imageBitmap.width;
    canvas.height = imageBitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(imageBitmap, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    imageBitmap.close?.();
  }
}

export function exportImageDataBlob(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext('2d');
  const normalized = imageData instanceof ImageData
    ? imageData
    : new ImageData(
      new Uint8ClampedArray(imageData.data),
      imageData.width,
      imageData.height,
    );
  context.putImageData(normalized, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new ApngError('浏览器未能导出 PNG Blob'));
      }
    }, 'image/png');
  });
}
