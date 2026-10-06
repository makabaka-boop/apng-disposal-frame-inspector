// 测试辅助：构造真实的 PNG/APNG 字节流（正确的 CRC 与 zlib 数据）。
import { deflateSync } from 'node:zlib';
import { crc32 } from '../site/js/crc32.js';

export const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function chunk(type, data = new Uint8Array(0)) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function u32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
}

export function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) { out.set(a, at); at += a.length; }
  return out;
}

export function ihdr(width, height, { bitDepth = 8, colorType = 6, interlace = 0 } = {}) {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  d[8] = bitDepth;
  d[9] = colorType;
  d[12] = interlace;
  return chunk('IHDR', d);
}

export function rawFromRgba(rgba, w, h) {
  const stride = w * 4;
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return raw;
}

export function idatFromRgba(rgba, w, h) {
  return chunk('IDAT', new Uint8Array(deflateSync(rawFromRgba(rgba, w, h))));
}

export function actl(numFrames, numPlays = 0) {
  const d = new Uint8Array(8);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, numFrames);
  dv.setUint32(4, numPlays);
  return chunk('acTL', d);
}

export function fctl(seq, { width, height, x = 0, y = 0, delayNum = 1, delayDen = 10, dispose = 0, blend = 0 }) {
  const d = new Uint8Array(26);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, seq);
  dv.setUint32(4, width);
  dv.setUint32(8, height);
  dv.setUint32(12, x);
  dv.setUint32(16, y);
  dv.setUint16(20, delayNum);
  dv.setUint16(22, delayDen);
  d[24] = dispose;
  d[25] = blend;
  return chunk('fcTL', d);
}

export function fdat(seq, rgba, w, h) {
  const compressed = new Uint8Array(deflateSync(rawFromRgba(rgba, w, h)));
  return chunk('fdAT', concatBytes(u32(seq), compressed));
}

export function solid(w, h, [r, g, b, a]) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
  }
  return out;
}

// 构造 APNG。frames: [{x,y,width,height,rgba,dispose,blend,delayNum,delayDen}]
// defaultImage: 全画布 RGBA；defaultInAnimation=true 时默认图即第一帧（frames[0] 用 IDAT）。
export function buildApng({ width, height, frames, defaultImage = null, defaultInAnimation = false, numPlays = 0 }) {
  const parts = [SIGNATURE, ihdr(width, height), actl(frames.length, numPlays)];
  let seq = 0;
  if (defaultInAnimation) {
    const f0 = frames[0];
    parts.push(fctl(seq++, { ...f0, width, height, x: 0, y: 0 }));
    parts.push(idatFromRgba(defaultImage ?? f0.rgba, width, height));
    for (const f of frames.slice(1)) {
      parts.push(fctl(seq++, f));
      parts.push(fdat(seq++, f.rgba, f.width, f.height));
    }
  } else {
    parts.push(idatFromRgba(defaultImage ?? solid(width, height, [0, 0, 0, 255]), width, height));
    for (const f of frames) {
      parts.push(fctl(seq++, f));
      parts.push(fdat(seq++, f.rgba, f.width, f.height));
    }
  }
  parts.push(chunk('IEND'));
  return concatBytes(...parts);
}

// 读取画布 (x,y) 处像素的 [r,g,b,a]
export function px(bytes, width, x, y) {
  const i = (y * width + x) * 4;
  return [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]];
}
