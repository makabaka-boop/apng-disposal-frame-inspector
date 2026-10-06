// 真实 PNG 块解析：签名校验、块长度、CRC、IHDR 约束、块白名单。
// 任何校验失败都抛出 PngError，调用方不得回退为静态图静默显示。
import { crc32 } from './crc32.js';

export class PngError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PngError';
  }
}

export const LIMITS = {
  MAX_FILE_BYTES: 64 * 1024, // 64 KiB
  MAX_DIMENSION: 64,         // 画布最大 64×64
  MAX_FRAMES: 16,            // 最多 16 帧
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// 白名单：动画必需块 + 少量无害元数据块，其余一律拒绝。
const ALLOWED_CHUNKS = new Set([
  'IHDR', 'acTL', 'fcTL', 'IDAT', 'fdAT', 'IEND',
  'tEXt', 'zTXt', 'iTXt', 'tIME', 'pHYs',
]);
// 颜色管理扩展：按约束明确拒绝，并给出专门提示。
const COLOR_MANAGEMENT_CHUNKS = new Set(['gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT']);

function readU32(bytes, at) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function ascii4(bytes, at) {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function parseIhdr(chunk) {
  if (chunk.length !== 13) throw new PngError(`IHDR 长度应为 13 字节，实际 ${chunk.length}`);
  const d = chunk.data;
  const width = readU32(d, 0);
  const height = readU32(d, 4);
  const bitDepth = d[8];
  const colorType = d[9];
  const compression = d[10];
  const filter = d[11];
  const interlace = d[12];
  if (width < 1 || height < 1) throw new PngError(`画布尺寸必须 ≥ 1×1，实际 ${width}×${height}`);
  if (width > LIMITS.MAX_DIMENSION || height > LIMITS.MAX_DIMENSION) {
    throw new PngError(`画布 ${width}×${height} 超过 ${LIMITS.MAX_DIMENSION}×${LIMITS.MAX_DIMENSION} 上限`);
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw new PngError(`仅接受 RGBA8（位深 8、颜色类型 6），实际位深 ${bitDepth}、颜色类型 ${colorType}`);
  }
  if (compression !== 0 || filter !== 0) {
    throw new PngError(`不支持的压缩/滤波方法（compression=${compression}, filter=${filter}）`);
  }
  if (interlace !== 0) throw new PngError('不接受隔行扫描（interlace=1）的 PNG');
  return { width, height, bitDepth, colorType, interlace };
}

// 解析并校验整个文件，返回 { ihdr, chunks }；chunks 按文件顺序，含偏移与长度。
export function parsePng(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length > LIMITS.MAX_FILE_BYTES) {
    throw new PngError(`文件 ${bytes.length} 字节，超过 64 KiB 上限`);
  }
  if (bytes.length < 8) throw new PngError('文件太小，不是 PNG');
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new PngError('PNG 签名不匹配');
  }

  const chunks = [];
  let pos = 8;
  let sawIend = false;
  while (pos < bytes.length) {
    if (sawIend) throw new PngError('IEND 之后还有多余数据');
    if (pos + 8 > bytes.length) throw new PngError(`偏移 ${pos} 处块头被截断`);
    const offset = pos;
    const length = readU32(bytes, pos);
    const type = ascii4(bytes, pos + 4);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw new PngError(`偏移 ${offset} 处块类型含非法字符`);
    }
    if (pos + 12 + length > bytes.length) {
      throw new PngError(`块 ${type}（偏移 ${offset}）声明长度 ${length} 超出文件剩余，文件被截断`);
    }
    const dataStart = pos + 8;
    const data = bytes.subarray(dataStart, dataStart + length);
    const crcExpected = readU32(bytes, dataStart + length);
    const crcActual = crc32(bytes.subarray(pos + 4, dataStart + length));
    if (crcActual !== crcExpected) {
      throw new PngError(
        `块 ${type}（偏移 ${offset}）CRC 校验失败：` +
        `记录值 0x${crcExpected.toString(16).padStart(8, '0')}，` +
        `计算值 0x${crcActual.toString(16).padStart(8, '0')}`
      );
    }
    if (COLOR_MANAGEMENT_CHUNKS.has(type)) {
      throw new PngError(`包含颜色管理扩展块 ${type}，按约束不予接受`);
    }
    if (!ALLOWED_CHUNKS.has(type)) {
      throw new PngError(`不允许的块类型 ${type}（仅接受 RGBA8、非隔行、无颜色管理扩展的 APNG）`);
    }
    chunks.push({ type, offset, length, data });
    pos = dataStart + length + 4;
    if (type === 'IEND') sawIend = true;
  }

  if (chunks.length === 0 || chunks[0].type !== 'IHDR') throw new PngError('第一个块必须是 IHDR');
  if (!sawIend) throw new PngError('缺少 IEND 结束块');

  // 结构规则：单一 IHDR、IDAT 必须连续且至少一个、acTL 必须在首个 IDAT 之前。
  let seenIdat = false;
  let idatClosed = false;
  let seenActl = false;
  for (const c of chunks) {
    if (c.type === 'IHDR' && c !== chunks[0]) throw new PngError('出现多个 IHDR 块');
    if (c.type === 'IDAT') {
      if (idatClosed) throw new PngError('IDAT 块必须连续出现，中间不允许插入其他块');
      seenIdat = true;
    } else if (seenIdat) {
      idatClosed = true;
    }
    if (c.type === 'acTL') {
      if (seenActl) throw new PngError('出现多个 acTL 块');
      if (seenIdat) throw new PngError('acTL 必须出现在第一个 IDAT 之前');
      seenActl = true;
    }
  }
  if (!seenIdat) throw new PngError('缺少 IDAT 图像数据块');

  return { ihdr: parseIhdr(chunks[0]), chunks };
}
