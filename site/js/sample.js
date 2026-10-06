// 生成内置示例 APNG（32×32、4 帧，覆盖 OVER/BACKGROUND/PREVIOUS 组合），
// 便于不准备文件也能体验检查流程。数据全部在内存中构造。
import { crc32 } from './crc32.js';
import { deflate } from './png-encode.js';

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function u32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v);
  return b;
}

function rawFromRgba(rgba, w, h) {
  const stride = w * 4;
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return raw;
}

function solidRect(w, h, r, g, b, a) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
  }
  return out;
}

function fctl(seq, { width, height, x, y, delayNum, delayDen, dispose, blend }) {
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

async function fdat(seq, rgba, w, h) {
  const compressed = await deflate(rawFromRgba(rgba, w, h));
  const d = new Uint8Array(4 + compressed.length);
  d.set(u32(seq), 0);
  d.set(compressed, 4);
  return chunk('fdAT', d);
}

export async function buildSampleApng() {
  const W = 32, H = 32;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W);
  dv.setUint32(4, H);
  ihdr[8] = 8; ihdr[9] = 6;

  const actl = new Uint8Array(8);
  new DataView(actl.buffer).setUint32(0, 4); // 4 帧
  // num_plays = 0（无限循环），仅作展示

  // 默认图（不属于动画）：深灰底
  const defaultImage = solidRect(W, H, 40, 40, 48, 255);
  const idat = chunk('IDAT', await deflate(rawFromRgba(defaultImage, W, H)));

  const frames = [
    { width: 16, height: 16, x: 0, y: 0, delayNum: 5, delayDen: 10, dispose: 0, blend: 0, rgba: solidRect(16, 16, 220, 40, 40, 255) },
    { width: 16, height: 16, x: 8, y: 8, delayNum: 5, delayDen: 10, dispose: 1, blend: 1, rgba: solidRect(16, 16, 40, 40, 220, 128) },
    { width: 16, height: 16, x: 16, y: 0, delayNum: 5, delayDen: 10, dispose: 2, blend: 0, rgba: solidRect(16, 16, 40, 200, 60, 255) },
    { width: 8, height: 8, x: 12, y: 12, delayNum: 5, delayDen: 10, dispose: 0, blend: 1, rgba: solidRect(8, 8, 240, 220, 40, 200) },
  ];

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('acTL', actl),
    idat,
  ];
  let seq = 0;
  for (const f of frames) {
    parts.push(fctl(seq++, f));
    parts.push(await fdat(seq++, f.rgba, f.width, f.height));
  }
  parts.push(chunk('IEND', new Uint8Array(0)));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
