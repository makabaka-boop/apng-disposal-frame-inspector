// PNG 编码（用于“下载当前合成帧”）：RGBA 画布 → 合法 PNG 字节。
// deflate 使用平台成熟实现（浏览器 CompressionStream / Node zlib）。
import { crc32 } from './crc32.js';

export async function deflate(data) {
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate'); // zlib 包装，与 PNG 一致
    const stream = new Blob([data]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { deflateSync } = await import('node:zlib');
  return new Uint8Array(deflateSync(data));
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// width/height：画布尺寸；rgba：width*height*4 字节。返回完整 PNG 文件字节。
export async function encodePngRgba(width, height, rgba) {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1)); // 每行前置滤波类型 0
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;  // 位深 8
  ihdr[9] = 6;  // 颜色类型 6（RGBA）
  // 10/11/12：compression/filter/interlace 均为 0
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
