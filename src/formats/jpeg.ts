import type { Reader } from '../io/reader.js';
import { PhotoError } from '../core/types.js';
export interface Segment { marker: number; start: number; end: number; data: Buffer }
export interface Jpeg { end: number; segments: Segment[]; hasMpf: boolean; width: number; height: number; make?: string; model?: string }
function exif(data: Buffer): { make?: string; model?: string } {
  if (!data.subarray(0, 6).equals(Buffer.from('Exif\0\0'))) return {};
  const t = data.subarray(6);
  const le = t.toString('ascii', 0, 2) === 'II';
  if (!le && t.toString('ascii', 0, 2) !== 'MM') return {};
  const u16 = (p: number) => { if (p < 0 || p + 2 > t.length) throw new Error(); return le ? t.readUInt16LE(p) : t.readUInt16BE(p); };
  const u32 = (p: number) => { if (p < 0 || p + 4 > t.length) throw new Error(); return le ? t.readUInt32LE(p) : t.readUInt32BE(p); };
  try {
    if (u16(2) !== 42) return {};
    const dir = u32(4), count = u16(dir);
    const result: { make?: string; model?: string } = {};
    for (let i = 0; i < count; i++) {
      const p = dir + 2 + i * 12, tag = u16(p);
      if ((tag !== 0x10f && tag !== 0x110) || u16(p + 2) !== 2) continue;
      const n = u32(p + 4), start = n <= 4 ? p + 8 : u32(p + 8);
      if (n > 4096 || start + n > t.length) continue;
      const value = t.toString('utf8', start, start + n).replace(/\0.*$/s, '').trim();
      if (tag === 0x10f) result.make = value; else result.model = value;
    }
    return result;
  } catch { return {}; }
}
export async function parseJpeg(r: Reader, startOffset = 0): Promise<Jpeg> {
  if (r.size < 2 || !(await r.read(startOffset, 2)).equals(Buffer.from([0xff, 0xd8]))) throw new PhotoError('NOT_JPEG', '文件内容不是 JPEG');
  const segments: Segment[] = [];
  let p = startOffset + 2, entropy = false, sawScan = false, hasMpf = false;
  let frame: { width: number; height: number; components: number[] } | undefined;
  let metadataBytes = 0;
  let metadata: { make?: string; model?: string } = {};
  while (p < r.size) {
    let start = p;
    if (entropy) {
      p = await r.findByte(0xff, p);
      start = p++;
      while (await r.byte(p) === 0xff) p++;
      const m = await r.byte(p);
      if (m === 0 || (m >= 0xd0 && m <= 0xd7)) { p++; continue; }
      entropy = false;
    } else {
      if (await r.byte(p++) !== 0xff) throw new PhotoError('INVALID_JPEG', 'JPEG 标记边界无效');
      while (await r.byte(p) === 0xff) p++;
    }
    const marker = await r.byte(p++);
    if (marker === 0xd9) {
      if (!sawScan || !frame) throw new PhotoError('INVALID_JPEG', 'JPEG 缺少图像帧或扫描数据');
      return { end: p, segments, hasMpf, width: frame.width, height: frame.height, ...metadata };
    }
    if (marker === 0xd8 || marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) throw new PhotoError('INVALID_JPEG', 'JPEG 标记顺序无效');
    if (marker === 1) continue;
    const length = (await r.read(p, 2)).readUInt16BE();
    if (length < 2 || p + length > r.size) throw new PhotoError('INVALID_JPEG', 'JPEG segment 长度无效');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || sawScan || length < 11) throw new PhotoError('INVALID_JPEG', 'JPEG 帧结构无效');
      const data = await r.read(p + 2, length - 2);
      const count = data[5]!;
      if (length !== 8 + count * 3 || count < 1 || count > 4 || ![8, 12].includes(data[0]!)) throw new PhotoError('INVALID_JPEG', 'JPEG 帧组件或精度无效');
      const width = data.readUInt16BE(3), height = data.readUInt16BE(1);
      if (!width || !height) throw new PhotoError('UNSUPPORTED_JPEG', '零尺寸或延迟声明尺寸的 JPEG 暂不支持');
      const components = Array.from({ length: count }, (_, i) => data[6 + i * 3]!);
      if (new Set(components).size !== count) throw new PhotoError('INVALID_JPEG', 'JPEG 帧组件重复');
      frame = { width, height, components };
    } else if ([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      throw new PhotoError('UNSUPPORTED_JPEG', '此 JPEG 编码方式暂不支持');
    }
    if (marker === 0xda) {
      const data = await r.read(p + 2, length - 2), count = data[0] ?? 0;
      if (!frame || count < 1 || count > frame.components.length || length !== 6 + count * 2) throw new PhotoError('INVALID_JPEG', 'JPEG 扫描头无效');
      const components = Array.from({ length: count }, (_, i) => data[1 + i * 2]!);
      if (new Set(components).size !== count || components.some(c => !frame!.components.includes(c))) throw new PhotoError('INVALID_JPEG', 'JPEG 扫描组件无效');
    }
    if (marker === 0xe1 || marker === 0xe2) {
      const data = await r.read(p + 2, length - 2);
      metadataBytes += data.length;
      if (segments.length >= 1024 || metadataBytes > 16 * 1024 * 1024) throw new PhotoError('METADATA_LIMIT', 'JPEG 元数据条目过多');
      segments.push({ marker, start, end: p + length, data });
      if (marker === 0xe1) metadata = { ...metadata, ...exif(data) };
      if (marker === 0xe2 && data.subarray(0, 4).equals(Buffer.from('MPF\0'))) hasMpf = true;
    }
    p += length;
    if (marker === 0xda) { sawScan = true; entropy = true; }
  }
  throw new PhotoError('TRUNCATED_JPEG', 'JPEG 缺少结束标记');
}
