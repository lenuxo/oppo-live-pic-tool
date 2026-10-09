import { resolve } from 'node:path';
import { Reader } from '../io/reader.js';
import { parseJpeg } from '../formats/jpeg.js';
import { parseXmp, integer } from '../formats/xmp.js';
import { patchMpf } from '../formats/mpf.js';
import { validateMp4, recoverMp4 } from '../formats/mp4.js';
import { PhotoError, type Inspection, type Range } from './types.js';
export async function inspectFile(input: string, options: { recover?: boolean; signal?: AbortSignal } = {}): Promise<Inspection> {
  const result: Inspection = { input: resolve(input), format: 'unsupported', vendor: { value: 'unknown', evidence: [] }, motion: { status: 'absent' }, warnings: [] };
  let r: Reader | undefined;
  try {
    options.signal?.throwIfAborted();
    r = await Reader.open(result.input, options.signal);
    if (r.size < 2 || !(await r.read(0, 2)).equals(Buffer.from([0xff, 0xd8]))) { result.motion.status = 'unsupported'; return result; }
    result.format = 'jpeg';
    const jpeg = await parseJpeg(r);
    if (jpeg.make) result.vendor = { value: /^oppo(?:\b|$)/i.test(jpeg.make) ? 'oppo' : 'other', evidence: [`EXIF Make: ${jpeg.make}`] };
    if (jpeg.model) result.vendor.evidence.push(`EXIF Model: ${jpeg.model}`);
    const xmp = parseXmp(jpeg.segments);
    if (xmp.extended) throw new PhotoError('UNSUPPORTED_LAYOUT', '扩展 XMP 暂不支持拆分');
    if (xmp.oplusVersion === '2') {
      result.profile = 'oplus-v2';
      result.vendor.evidence.push(`Oplus 实况格式 v2，Owner: ${xmp.oplusOwner ?? 'unknown'}`);
      if (result.vendor.value === 'unknown') result.warnings.push('EXIF 厂商未知，按兼容的 Oplus v2 实况格式处理');
    }
    let imageEnd = jpeg.end;
    let range: Range | undefined;
    const primary = xmp.items[0];
    const secondary = xmp.items.slice(1);
    const videoItem = secondary.find(i => i.Semantic === 'MotionPhoto');
    const gain = secondary.find(i => i.Semantic === 'GainMap');
    if (xmp.items.length) {
      if (primary?.Mime !== 'image/jpeg' || primary.Semantic !== 'Primary' || secondary.some(i => !((i.Semantic === 'GainMap' && i.Mime === 'image/jpeg') || (i.Semantic === 'MotionPhoto' && i.Mime === 'video/mp4'))) || secondary.length > 2 || (secondary.length === 2 && secondary[0] !== gain)) throw new PhotoError('UNSUPPORTED_LAYOUT', '不支持此 XMP 容器条目布局');
      if (secondary.filter(i => i.Semantic === 'GainMap').length > 1 || secondary.filter(i => i.Semantic === 'MotionPhoto').length > 1) throw new PhotoError('UNSUPPORTED_LAYOUT', '重复的容器条目');
      if (integer(primary.Length, 0) !== 0 || integer(primary.Padding, 0) !== 0 || secondary.some(i => integer(i.Padding, 0) !== 0)) throw new PhotoError('UNSUPPORTED_LAYOUT', '带填充的容器布局暂不支持');
      if (gain) {
        const gainLength = integer(gain.Length);
        const gainJpeg = await parseJpeg(r, jpeg.end);
        if (gainJpeg.end !== jpeg.end + gainLength) throw new PhotoError('INVALID_GAINMAP', '增益图长度与 JPEG 数据不一致');
        imageEnd = gainJpeg.end;
      }
      if (videoItem) {
        const declaredLength = integer(videoItem.Length);
        const videoLength = result.profile && xmp.oplusVideoLength ? integer(xmp.oplusVideoLength) : declaredLength;
        range = { offset: imageEnd, length: videoLength };
        try {
          if (videoLength <= 0 || videoLength > declaredLength || imageEnd + declaredLength !== r.size) throw new PhotoError('INVALID_VIDEO_RANGE', 'XMP 视频范围与文件边界不一致');
          await validateMp4(r, range);
          result.motion.method = 'xmp-directory';
          if (videoLength < declaredLength) {
            result.motion.extra = { offset: imageEnd + videoLength, length: declaredLength - videoLength };
            result.warnings.push(`主 MP4 后有 ${declaredLength - videoLength} 字节 Oplus 附加数据；可用 --save-extra 单独保存，原文件保留`);
          }
        } catch (e) {
          if (!options.recover) throw e;
          range = undefined; result.warnings.push('XMP 定位失败，尝试从图片尾部恢复');
        }
      }
    } else if (jpeg.hasMpf && r.size !== jpeg.end) throw new PhotoError('UNSUPPORTED_LAYOUT', '无容器目录的多图 MPF 图片暂不支持拆分');
    if (!range && options.recover && r.size > imageEnd) {
      range = await recoverMp4(r, imageEnd, options.signal);
      if (range) { result.motion.method = 'recovery-scan'; result.warnings.push('视频通过恢复搜索定位，未经 XMP 范围确认'); }
    }
    if (!range) {
      if (xmp.hasMotion) throw new PhotoError('INVALID_MOTION_METADATA', '存在实况标记，但未找到可验证的视频；可尝试 --recover');
      if (r.size > imageEnd) result.warnings.push('图片后存在额外数据；未启用恢复搜索');
      await r.assertUnchanged(); return result;
    }
    const patches = [...xmp.patches, ...patchMpf(jpeg.segments, jpeg.end, imageEnd, xmp.patches)].sort((a, b) => a.offset - b.offset);
    await r.assertUnchanged();
    result.motion.status = 'valid'; result.motion.video = range;
    result.layout = { imageEnd, patches, fingerprint: r.stamp };
    if (gain) result.warnings.push('静态图片将保留 HDR 增益图和 MP Index');
    result.warnings.push('已验证 MP4 容器与视频轨道结构；未进行视频解码验证');
  } catch (e) {
    if (options.signal?.aborted) throw e;
    const error = e instanceof PhotoError ? e : new PhotoError('READ_ERROR', e instanceof Error ? e.message : String(e));
    result.motion.status = error.code.startsWith('UNSUPPORTED') ? 'unsupported' : 'invalid';
    result.error = { code: error.code, message: error.message };
  } finally { await r?.close(); }
  return result;
}
