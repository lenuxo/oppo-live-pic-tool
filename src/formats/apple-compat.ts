import type { Reader } from '../io/reader.js';
import { PhotoError, type Patch, type Range } from '../core/types.js';

interface Box { type: string; start: number; end: number; header: number }
export interface AppleCompatibility {
  mode: 'apple';
  status: 'adjusted' | 'planned' | 'unchanged';
  code: 'APPLE_HVC1' | 'ALREADY_HVC1' | 'NOT_HEVC' | 'APPLE_COMPAT_UNAVAILABLE';
  reason: string;
}
/** Conservative, non-fragmented MP4 support. Never changes media samples. */
export async function planAppleCompatibility(r: Reader, range: Range): Promise<{ patches: Patch[]; compatibility: AppleCompatibility }> {
  const unchanged = (code: AppleCompatibility['code'], reason: string) => ({ patches: [], compatibility: { mode: 'apple' as const, status: 'unchanged' as const, code, reason } });
  const reject = (reason: string): never => { throw new PhotoError('APPLE_COMPAT_UNAVAILABLE', reason); };
  let boxCount = 0;
  async function boxes(start: number, end: number): Promise<Box[]> {
    const list: Box[] = [];
    while (start < end) {
      if (++boxCount > 10000 || end - start < 8) reject('容器结构超出兼容处理范围');
      const h = await r.read(start, 8);
      let length = h.readUInt32BE(), header = 8;
      if (length === 1) {
        if (end - start < 16) reject('容器扩展长度不完整');
        const n = (await r.read(start + 8, 8)).readBigUInt64BE();
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) reject('容器长度不可安全寻址');
        length = Number(n); header = 16;
      } else if (length === 0) length = end - start;
      if (length < header || length > end - start) reject('容器边界无效');
      list.push({ type: h.toString('ascii', 4, 8), start, end: start + length, header });
      start += length;
    }
    return list;
  }
  const children = (b: Box) => boxes(b.start + b.header, b.end);
  const one = (list: Box[], type: string): Box => {
    const found = list.filter(b => b.type === type);
    if (found.length !== 1) reject(`需要唯一的 ${type} 条目`);
    return found[0]!;
  };
  async function table(b: Box, width: number, prefix = 8): Promise<Buffer> {
    const length = b.end - b.start - b.header;
    if (length < prefix || length > 8 * 1024 * 1024) reject('样本表大小超出兼容处理范围');
    const data = await r.read(b.start + b.header, length);
    if (data.readUInt32BE(0) !== 0) reject('不支持此样本表版本');
    const count = data.readUInt32BE(prefix - 4);
    if (count > 100000 || length !== prefix + count * width) reject('样本表长度或条目数无效');
    return data;
  }
  try {
    const top = await boxes(range.offset, range.offset + range.length);
    if (top.some(b => b.type === 'moof')) reject('分片 MP4 暂不支持兼容调整');
    const movie = await children(one(top, 'moov'));
    if (movie.some(b => b.type === 'mvex')) reject('分片 MP4 暂不支持兼容调整');
    const videoTables: Box[][] = [];
    for (const track of movie.filter(b => b.type === 'trak')) {
      const media = await children(one(await children(track), 'mdia'));
      const handler = one(media, 'hdlr');
      if (handler.end - handler.start < handler.header + 12) reject('轨道处理器无效');
      if ((await r.read(handler.start + handler.header + 8, 4)).toString('ascii') !== 'vide') continue;
      videoTables.push(await children(one(await children(one(media, 'minf')), 'stbl')));
    }
    if (videoTables.length !== 1) reject('兼容调整仅支持单视频轨道');
    const tables = videoTables[0]!, stsd = one(tables, 'stsd');
    if (stsd.end - stsd.start < stsd.header + 8) reject('样本描述头不完整');
    const description = await r.read(stsd.start + stsd.header, 8);
    if (description.readUInt32BE(0) !== 0 || description.readUInt32BE(4) !== 1) reject('兼容调整仅支持单一样本描述');
    const entries = await boxes(stsd.start + stsd.header + 8, stsd.end);
    if (entries.length !== 1) reject('样本描述数量不一致');
    const entry = entries[0]!;
    if (entry.type === 'hvc1') return unchanged('ALREADY_HVC1', '视频已使用 hvc1 封装，保留原视频');
    if (entry.type !== 'hev1') return unchanged('NOT_HEVC', '视频不是 hev1，保留原视频');
    if (entry.header !== 8 || entry.end - entry.start < 86) reject('HEVC 样本描述无效');
    const entryBoxes = await boxes(entry.start + 86, entry.end);
    if (entryBoxes.some(b => b.type === 'sinf')) reject('加密视频不支持兼容调整');
    const config = one(entryBoxes, 'hvcC');
    const configSize = config.end - config.start - config.header;
    if (configSize < 23 || configSize > 1024 * 1024) reject('HEVC 配置大小无效');
    const data = await r.read(config.start + config.header, configSize);
    if (data[0] !== 1) reject('不支持此 HEVC 配置版本');
    const lengthSize = (data[21]! & 3) + 1;
    const complete = Buffer.from(data), types = new Set<number>();
    let cursor = 23;
    for (let i = 0; i < data[22]!; i++) {
      if (cursor + 3 > data.length) reject('HEVC 参数集不完整');
      const type = data[cursor]! & 63, arrayStart = cursor, count = data.readUInt16BE(cursor + 1);
      cursor += 3;
      for (let j = 0; j < count; j++) {
        if (cursor + 2 > data.length) reject('HEVC 参数集长度缺失');
        const size = data.readUInt16BE(cursor); cursor += 2;
        if (size < 2 || cursor + size > data.length || (data[cursor]! & 0x80) || ((data[cursor]! >> 1) & 63) !== type || !(data[cursor + 1]! & 7)) reject('HEVC 参数集结构无效');
        cursor += size;
      }
      if ([32, 33, 34].includes(type)) {
        if (!count || types.has(type)) reject('HEVC 参数集为空或重复');
        types.add(type); complete[arrayStart] = data[arrayStart]! | 0x80;
      }
    }
    if (cursor !== data.length || types.size !== 3) reject('缺少完整的 VPS/SPS/PPS 参数集');
    const sizesBox = one(tables, 'stsz');
    const sizeLength = sizesBox.end - sizesBox.start - sizesBox.header;
    if (sizeLength < 12 || sizeLength > 8 * 1024 * 1024) reject('样本大小表无效');
    const sizes = await r.read(sizesBox.start + sizesBox.header, sizeLength);
    const fixedSize = sizes.readUInt32BE(4), sampleCount = sizes.readUInt32BE(8);
    if (sizes.readUInt32BE(0) !== 0 || !sampleCount || sampleCount > 100000 || sizeLength !== 12 + (fixedSize ? 0 : sampleCount * 4)) reject('样本大小表无效');
    const offsetsBox = one(tables.filter(b => b.type === 'stco' || b.type === 'co64').map(b => ({ ...b, type: 'offsets' })), 'offsets');
    const is64 = tables.some(b => b.type === 'co64'), offsets = await table(offsetsBox, is64 ? 8 : 4);
    const mapping = await table(one(tables, 'stsc'), 12);
    const chunkCount = offsets.readUInt32BE(4), mapCount = mapping.readUInt32BE(4);
    if (!chunkCount || !mapCount) reject('样本块映射为空');
    for (let j = 0; j < mapCount; j++) {
      const at = 8 + j * 12, first = mapping.readUInt32BE(at);
      if ((j === 0 && first !== 1) || first > chunkCount || (j > 0 && first <= mapping.readUInt32BE(at - 12)) || !mapping.readUInt32BE(at + 4) || mapping.readUInt32BE(at + 8) !== 1) reject('样本块映射无效');
    }
    const mdats = top.filter(b => b.type === 'mdat');
    let sample = 0, map = 0, nalCount = 0;
    for (let chunk = 1; chunk <= chunkCount; chunk++) {
      while (map + 1 < mapCount && mapping.readUInt32BE(8 + (map + 1) * 12) <= chunk) map++;
      const count = mapping.readUInt32BE(12 + map * 12);
      const raw = is64 ? offsets.readBigUInt64BE(8 + (chunk - 1) * 8) : BigInt(offsets.readUInt32BE(8 + (chunk - 1) * 4));
      if (raw > BigInt(Number.MAX_SAFE_INTEGER)) reject('媒体偏移不可安全寻址');
      let position = range.offset + Number(raw);
      for (let k = 0; k < count; k++) {
        if (sample >= sampleCount) reject('样本数量与块映射不一致');
        const size = fixedSize || sizes.readUInt32BE(12 + sample * 4), end = position + size;
        if (!size || !mdats.some(b => position >= b.start + b.header && end <= b.end)) reject('样本超出媒体数据边界');
        while (position < end) {
          if (++nalCount > 2000000 || end - position < lengthSize + 2) reject('HEVC 样本结构或数量无效');
          const n = (await r.read(position, lengthSize)).readUIntBE(0, lengthSize); position += lengthSize;
          if (n < 2 || n > end - position) reject('HEVC NAL 范围无效');
          const h = await r.read(position, 2), type = (h[0]! >> 1) & 63;
          if ((h[0]! & 0x80) || !(h[1]! & 7)) reject('HEVC NAL 头无效');
          if ([32, 33, 34].includes(type)) reject('视频样本中含参数集，保留原视频；暂不重排参数集');
          position += n;
        }
        sample++;
      }
    }
    if (sample !== sampleCount) reject('样本数量与块映射不一致');
    const patches: Patch[] = [{ offset: entry.start + 4, length: 4, bytes: Buffer.from('hvc1') }];
    if (!complete.equals(data)) patches.push({ offset: config.start + config.header, length: data.length, bytes: complete });
    return { patches, compatibility: { mode: 'apple', status: 'adjusted', code: 'APPLE_HVC1', reason: '已检查参数集与全部视频样本，调整为 hvc1；音视频样本不变' } };
  } catch (e) {
    if (!(e instanceof PhotoError) || e.code !== 'APPLE_COMPAT_UNAVAILABLE') throw e;
    return unchanged('APPLE_COMPAT_UNAVAILABLE', `${e.message}；未调整封装`);
  }
}
