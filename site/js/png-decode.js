// 普通 PNG 解码：inflate 使用平台成熟实现（浏览器 DecompressionStream / Node zlib），
// 此处只负责行滤波还原（RGBA8、非隔行，bpp=4）。
import { PngError } from './png-chunks.js';

export async function inflate(data) {
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('deflate'); // PNG 使用 zlib 包装的 deflate
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { inflateSync } = await import('node:zlib');
  return new Uint8Array(inflateSync(data));
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

// raw：每行 1 字节滤波类型 + width*4 字节像素。返回 RGBA 像素数组。
export function unfilter(raw, width, height) {
  const bpp = 4;
  const stride = width * bpp;
  const expected = height * (stride + 1);
  if (raw.length !== expected) {
    throw new PngError(`解压后数据长度 ${raw.length} 与期望 ${expected}（${width}×${height} RGBA8）不符`);
  }
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowIn = y * (stride + 1);
    const filter = raw[rowIn];
    if (filter > 4) throw new PngError(`第 ${y} 行使用未知滤波类型 ${filter}`);
    const rowOut = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[rowIn + 1 + x];
      const a = x >= bpp ? out[rowOut + x - bpp] : 0;
      const b = y > 0 ? out[rowOut - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[rowOut - stride + x - bpp] : 0;
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        default: r = v + paeth(a, b, c); break;
      }
      out[rowOut + x] = r & 0xff;
    }
  }
  return out;
}

export async function decodePngPixels(compressed, width, height) {
  return unfilter(await inflate(compressed), width, height);
}
