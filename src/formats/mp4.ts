import type { Reader } from '../io/reader.js';
import { PhotoError, type Range } from '../core/types.js';
interface Box { type: string; start: number; end: number; header: number }
export async function validateMp4(r: Reader, range: Range): Promise<void> {
  const end = range.offset + range.length;
  if (range.offset < 0 || range.length < 24 || end > r.size) throw new PhotoError('INVALID_VIDEO_RANGE', '视频范围无效');
  let count = 0;
  async function boxes(start: number, stop: number): Promise<Box[]> {
    const list: Box[] = [];
    while (start < stop) {
      if (++count > 10000 || stop - start < 8) throw new PhotoError('INVALID_MP4', 'MP4 box 结构无效');
      const h = await r.read(start, 8), size32 = h.readUInt32BE();
      const type = h.toString('ascii', 4, 8);
      let size = size32, header = 8;
      if (size32 === 1) {
        if (stop - start < 16) throw new PhotoError('INVALID_MP4', 'MP4 扩展长度不完整');
        const big = (await r.read(start + 8, 8)).readBigUInt64BE();
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new PhotoError('INVALID_MP4', 'MP4 box 过大');
        size = Number(big); header = 16;
      } else if (size32 === 0) size = stop - start;
      if (size < header || start + size > stop) throw new PhotoError('INVALID_MP4', 'MP4 box 超出视频边界');
      list.push({ type, start, end: start + size, header }); start += size;
    }
    return list;
  }
  const top = await boxes(range.offset, end);
  const first = top[0];
  if (!first || first.type !== 'ftyp' || first.end - first.start < first.header + 8) throw new PhotoError('INVALID_MP4', '视频缺少有效 ftyp 文件头');
  const moov = top.filter(b => b.type === 'moov');
  if (moov.length !== 1 || !top.some(b => b.type === 'mdat' && b.end > b.start + b.header)) throw new PhotoError('INVALID_MP4', '视频缺少 moov 或媒体数据');
  let videoTrack = false;
  for (const track of await boxes(moov[0]!.start + moov[0]!.header, moov[0]!.end)) {
    if (track.type !== 'trak') continue;
    for (const media of await boxes(track.start + track.header, track.end)) {
      if (media.type !== 'mdia') continue;
      for (const box of await boxes(media.start + media.header, media.end)) {
        if (box.type === 'hdlr' && box.end - box.start >= box.header + 12) {
          if ((await r.read(box.start + box.header + 8, 4)).toString('ascii') === 'vide') videoTrack = true;
        }
      }
    }
  }
  if (!videoTrack) throw new PhotoError('INVALID_MP4', 'MP4 中未找到视频轨道');
}
/** Recovery scans only appended bytes, with overlap for split headers. */
export async function recoverMp4(r: Reader, start: number, signal?: AbortSignal): Promise<Range | undefined> {
  let candidates = 0;
  for (let p = start; p < r.size; p += 65536) {
    signal?.throwIfAborted();
    const data = await r.read(p, Math.min(65536 + 7, r.size - p));
    let at = 0;
    while ((at = data.indexOf('ftyp', at, 'ascii')) >= 0) {
      const offset = p + at - 4; at++;
      if (offset < start || offset >= p + 65536) continue;
      if (++candidates > 128) throw new PhotoError('RECOVERY_LIMIT', '视频候选过多，停止恢复搜索');
      const range = { offset, length: r.size - offset };
      try { await validateMp4(r, range); return range; }
      catch (e) { if (!(e instanceof PhotoError)) throw e; }
    }
  }
  return undefined;
}
