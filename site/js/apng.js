// APNG 结构组装：acTL 帧数核对、fcTL/fdAT 连续序号、默认图是否参与动画。
import { PngError, LIMITS } from './png-chunks.js';

export const DISPOSE_OPS = { 0: 'NONE', 1: 'BACKGROUND', 2: 'PREVIOUS' };
export const BLEND_OPS = { 0: 'SOURCE', 1: 'OVER' };

function readU32(d, at) {
  return ((d[at] << 24) | (d[at + 1] << 16) | (d[at + 2] << 8) | d[at + 3]) >>> 0;
}
function readU16(d, at) {
  return (d[at] << 8) | d[at + 1];
}

function concatParts(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function parseFctl(chunk, ihdr) {
  if (chunk.length !== 26) throw new PngError(`fcTL 长度应为 26 字节，实际 ${chunk.length}`);
  const d = chunk.data;
  const width = readU32(d, 4);
  const height = readU32(d, 8);
  const x = readU32(d, 12);
  const y = readU32(d, 16);
  const delayNum = readU16(d, 20);
  const delayDenRaw = readU16(d, 22);
  const dispose = d[24];
  const blend = d[25];
  if (width < 1 || height < 1) throw new PngError(`fcTL 帧宽高必须 ≥ 1，实际 ${width}×${height}`);
  if (x + width > ihdr.width || y + height > ihdr.height) {
    throw new PngError(`帧矩形 (${x},${y}) ${width}×${height} 超出画布 ${ihdr.width}×${ihdr.height}`);
  }
  if (dispose > 2) throw new PngError(`非法 dispose_op ${dispose}（仅 0=NONE 1=BACKGROUND 2=PREVIOUS）`);
  if (blend > 1) throw new PngError(`非法 blend_op ${blend}（仅 0=SOURCE 1=OVER）`);
  // 规范：delay_den 为 0 时按 100 处理。
  return { width, height, x, y, delayNum, delayDen: delayDenRaw === 0 ? 100 : delayDenRaw, dispose, blend };
}

// 从已校验的块序列组装动画。返回：
// { isAnimated, defaultInAnimation, numPlays, frames[], defaultImageCompressed }
// frames[i] = { index, x, y, width, height, delayNum, delayDen, dispose, blend, fromIdat, compressed }
export function assembleApng(parsed) {
  const { ihdr, chunks } = parsed;
  let actl = null;
  let firstFctlSeen = false;
  let firstIdatSeen = false;
  let defaultInAnimation = false;
  let seqExpected = 0;
  const idatParts = [];
  const frames = [];
  let current = null; // 正在收集 fdAT 的帧

  const checkSeq = (chunk) => {
    const seq = readU32(chunk.data, 0);
    if (seq !== seqExpected) {
      throw new PngError(
        `块 ${chunk.type}（偏移 ${chunk.offset}）序号为 ${seq}，期望 ${seqExpected}：` +
        'fcTL/fdAT 序号必须从 0 开始连续递增'
      );
    }
    seqExpected++;
  };

  for (const c of chunks) {
    switch (c.type) {
      case 'acTL': {
        if (c.length !== 8) throw new PngError(`acTL 长度应为 8 字节，实际 ${c.length}`);
        const numFrames = readU32(c.data, 0);
        const numPlays = readU32(c.data, 4);
        if (numFrames < 1) throw new PngError('acTL 声明的帧数必须 ≥ 1');
        if (numFrames > LIMITS.MAX_FRAMES) {
          throw new PngError(`acTL 声明 ${numFrames} 帧，超过 ${LIMITS.MAX_FRAMES} 帧上限`);
        }
        actl = { numFrames, numPlays };
        break;
      }
      case 'fcTL': {
        if (!actl) throw new PngError('fcTL 出现在 acTL 之前');
        checkSeq(c);
        if (!firstFctlSeen) {
          firstFctlSeen = true;
          // 规范：首个 fcTL 在首个 IDAT 之前 ⇒ 默认图即动画第一帧。
          defaultInAnimation = !firstIdatSeen;
        }
        if (current) frames.push(current);
        current = { fctl: parseFctl(c, ihdr), parts: [] };
        break;
      }
      case 'IDAT': {
        firstIdatSeen = true;
        idatParts.push(c.data);
        break;
      }
      case 'fdAT': {
        if (!actl) throw new PngError('fdAT 出现在 acTL 之前');
        if (!current) throw new PngError('fdAT 出现在任何 fcTL 之前');
        if (c.length < 5) throw new PngError(`fdAT 长度至少为 5（序号 + 数据），实际 ${c.length}`);
        checkSeq(c);
        current.parts.push(c.data.subarray(4));
        break;
      }
      default:
        break; // IHDR/IEND/元数据块在此无需处理
    }
  }
  if (current) frames.push(current);

  if (!actl) {
    return { isAnimated: false, defaultInAnimation: false, numPlays: 0, frames: [], defaultImageCompressed: concatParts(idatParts) };
  }
  if (frames.length !== actl.numFrames) {
    throw new PngError(`acTL 声明 ${actl.numFrames} 帧，实际 fcTL 共 ${frames.length} 个`);
  }

  const result = frames.map((f, i) => ({
    index: i,
    ...f.fctl,
    fromIdat: false,
    compressed: null,
    _parts: f.parts,
  }));

  if (defaultInAnimation) {
    // 默认图即第一帧：数据来自 IDAT，且规范要求其 fcTL 覆盖整个画布。
    const f0 = result[0];
    if (f0.x !== 0 || f0.y !== 0 || f0.width !== ihdr.width || f0.height !== ihdr.height) {
      throw new PngError('默认图作为第一帧时，其 fcTL 必须覆盖整个画布');
    }
    if (f0._parts.length > 0) throw new PngError('默认图作为第一帧时不应再携带 fdAT 数据');
    f0._parts = idatParts;
    f0.fromIdat = true;
  }

  for (const f of result) {
    if (f._parts.length === 0) throw new PngError(`第 ${f.index + 1} 帧没有任何图像数据（IDAT/fdAT）`);
    f.compressed = concatParts(f._parts);
    delete f._parts;
  }

  return {
    isAnimated: true,
    defaultInAnimation,
    numPlays: actl.numPlays,
    frames: result,
    defaultImageCompressed: defaultInAnimation ? null : concatParts(idatParts),
  };
}
