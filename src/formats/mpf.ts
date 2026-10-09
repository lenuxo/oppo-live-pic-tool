import { PhotoError, type Patch } from '../core/types.js';
import type { Segment } from './jpeg.js';
/** Update the MP Index after metadata size changes, retaining HDR gain-map bytes. */
export function patchMpf(segments: Segment[], primaryEnd: number, imageEnd: number, patches: Patch[]): Patch[] {
  const deltaBefore = (offset: number) => patches.filter(p => p.offset + p.length <= offset).reduce((n, p) => n + p.bytes.length - p.length, 0);
  const result: Patch[] = [];
  const indexes = segments.filter(s => s.marker === 0xe2 && s.data.subarray(0, 4).equals(Buffer.from('MPF\0')));
  if (indexes.length > 1) throw new PhotoError('UNSUPPORTED_MPF', '多个 MP Index 暂不支持');
  for (const seg of indexes) {
    const data = Buffer.from(seg.data), t = data.subarray(4);
    const le = t.toString('ascii', 0, 2) === 'II';
    if (!le && t.toString('ascii', 0, 2) !== 'MM') throw new PhotoError('INVALID_MPF', 'MP Index 字节序无效');
    const u16 = (p: number) => le ? t.readUInt16LE(p) : t.readUInt16BE(p);
    const u32 = (p: number) => le ? t.readUInt32LE(p) : t.readUInt32BE(p);
    const put = (p: number, n: number) => { if (n < 0 || n > 0xffffffff) throw new PhotoError('INVALID_MPF', 'MP Index 偏移越界'); if (le) t.writeUInt32LE(n, p); else t.writeUInt32BE(n, p); };
    try {
      if (u16(2) !== 42) throw new Error();
      const dir = u32(4), count = u16(dir);
      let entries = -1, bytes = 0, images = 0;
      for (let i = 0; i < count; i++) {
        const p = dir + 2 + i * 12, tag = u16(p);
        if (tag === 0xb001) images = u32(p + 8);
        if (tag === 0xb002) { bytes = u32(p + 4); entries = u32(p + 8); }
      }
      const expected = imageEnd > primaryEnd ? 2 : 1;
      if (images !== expected || bytes !== expected * 16 || entries < 0 || entries + bytes > t.length) throw new PhotoError('UNSUPPORTED_MPF', 'MP Index 与已验证图片数量不一致');
      const origin = seg.start + 8;
      put(entries + 4, primaryEnd + deltaBefore(primaryEnd));
      if (u32(entries + 8) !== 0) throw new PhotoError('INVALID_MPF', '主图 MP Index 偏移无效');
      if (expected === 2) {
        if (origin + u32(entries + 24) !== primaryEnd || u32(entries + 20) !== imageEnd - primaryEnd) throw new PhotoError('INVALID_MPF', '增益图 MP Index 范围与 JPEG 数据不一致');
        put(entries + 24, primaryEnd + deltaBefore(primaryEnd) - origin - deltaBefore(origin));
      }
      const header = Buffer.alloc(4); header[0] = 255; header[1] = 226; header.writeUInt16BE(data.length + 2, 2);
      result.push({ offset: seg.start, length: seg.end - seg.start, bytes: Buffer.concat([header, data]) });
    } catch (e) {
      if (e instanceof PhotoError) throw e;
      throw new PhotoError('INVALID_MPF', 'MP Index 数据无效');
    }
  }
  return result;
}
