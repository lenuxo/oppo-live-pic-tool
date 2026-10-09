import { mkdir, lstat } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { OutputTransaction, temporaryPath } from '../io/writer.js';
import { Reader } from '../io/reader.js';
import { inside } from '../io/scanner.js';
import { parseJpeg } from '../formats/jpeg.js';
import { parseXmp } from '../formats/xmp.js';
import { validateMp4 } from '../formats/mp4.js';
import { PhotoError, type Inspection, type ExtractOptions, type ExtractionResult } from './types.js';
export interface ExtractionPlan { inspection: Inspection; image: string; video: string; extra?: string; options: ExtractOptions }
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export async function planExtraction(inspection: Inspection, options: ExtractOptions, reserved = new Set<string>()): Promise<ExtractionPlan | ExtractionResult> {
  const input = inspection.input;
  if (inspection.error && inspection.motion.status === 'invalid') return { input, status: 'failed', reason: inspection.error.message, code: inspection.error.code };
  if (inspection.motion.status !== 'valid' || !inspection.layout) return { input, status: 'skipped', reason: inspection.error?.message ?? (inspection.motion.status === 'absent' ? '普通照片' : '暂不支持此格式'), code: inspection.error?.code ?? (inspection.motion.status === 'absent' ? 'ORDINARY_PHOTO' : 'UNSUPPORTED_FORMAT') };
  if (inspection.vendor.value === 'other' || (inspection.vendor.value === 'unknown' && !inspection.profile && !options.allowUnknownVendor)) return { input, status: 'skipped', reason: inspection.vendor.value === 'other' ? '非 OPPO 来源' : '来源未知，使用 --allow-unknown-vendor 可提取', code: inspection.vendor.value === 'other' ? 'NON_OPPO_VENDOR' : 'UNKNOWN_VENDOR' };
  const root = resolve(options.out), base = resolve(options.base);
  if (!inside(base, input)) throw new PhotoError('INVALID_INPUT', '输入文件不在扫描根目录内');
  const rel = relative(base, input), target = resolve(root, rel);
  if (!rel) throw new PhotoError('INVALID_INPUT', '扫描根目录必须是文件所在目录，不能是文件本身');
  if (!inside(root, target)) throw new PhotoError('INVALID_OUTPUT', '输出路径越界');
  const extension = extname(target);
  const stem = extension ? target.slice(0, -extension.length) : target;
  let image = `${stem}.jpg`, video = `${stem}.mp4`;
  let extra = options.saveExtra && inspection.motion.extra ? `${stem}.extra.bin` : undefined;
  if (resolve(image) === resolve(input)) throw new PhotoError('INVALID_OUTPUT', '输出图片不能与输入文件相同');
  for (let suffix = 1; reserved.has(image) || reserved.has(video) || (extra && reserved.has(extra)) || await exists(image) || await exists(video) || (extra && await exists(extra)); suffix++) {
    if (options.conflict === 'skip') return { input, status: 'skipped', reason: '输出文件已存在', code: 'OUTPUT_CONFLICT' };
    if (options.conflict === 'error') return { input, status: 'failed', reason: '输出文件已存在', code: 'OUTPUT_CONFLICT' };
    image = `${stem}-${suffix}.jpg`; video = `${stem}-${suffix}.mp4`;
    if (extra) extra = `${stem}-${suffix}.extra.bin`;
  }
  reserved.add(image); reserved.add(video); if (extra) reserved.add(extra);
  return { inspection, image, video, extra, options };
}
export async function executeExtraction(plan: ExtractionPlan): Promise<ExtractionResult> {
  const { inspection, image, video, extra, options } = plan;
  const result: ExtractionResult = { input: inspection.input, status: options.dryRun ? 'planned' : 'extracted', image, video, ...(extra ? { extra } : {}) };
  if (options.dryRun) return result;
  const tempImage = temporaryPath(image);
  const tempVideo = temporaryPath(video);
  const tempExtra = extra ? temporaryPath(extra) : undefined;
  const transaction = new OutputTransaction(options.signal);
  let failure: unknown;
  let reader: Reader | undefined;
  try {
    options.signal?.throwIfAborted();
    reader = await Reader.open(inspection.input, options.signal);
    if (reader.stamp !== inspection.layout!.fingerprint) throw new PhotoError('SOURCE_CHANGED', '源文件在检查后发生变化');
    await mkdir(dirname(image), { recursive: true });
    async function write(path: string, mode: 'image' | 'video' | 'extra') {
      const out = await transaction.create(path);
      try {
        async function bytes(data: Buffer) {
          let p = 0;
          while (p < data.length) {
            options.signal?.throwIfAborted();
            const { bytesWritten } = await out.write(data, p, data.length - p);
            if (!bytesWritten) throw new PhotoError('WRITE_ERROR', '输出写入不完整');
            p += bytesWritten;
          }
        }
        async function copy(start: number, end: number) {
          for (let p = start; p < end; p += 65536) { options.signal?.throwIfAborted(); await bytes(await reader!.read(p, Math.min(65536, end - p))); }
        }
        if (mode === 'image') {
          let cursor = 0;
          for (const patch of inspection.layout!.patches) {
            await copy(cursor, patch.offset); await bytes(patch.bytes); cursor = patch.offset + patch.length;
          }
          await copy(cursor, inspection.layout!.imageEnd);
        } else {
          const range = mode === 'extra' ? inspection.motion.extra! : inspection.motion.video!;
          await copy(range.offset, range.offset + range.length);
        }
        await out.sync();
      } finally { await out.close(); }
    }
    await write(tempImage, 'image'); await write(tempVideo, 'video');
    if (tempExtra) await write(tempExtra, 'extra');
    const jpg = await Reader.open(tempImage);
    try {
      const parsed = await parseJpeg(jpg), xmp = parseXmp(parsed.segments);
      let end = parsed.end;
      if (xmp.items.some(i => i.Semantic === 'GainMap')) end = (await parseJpeg(jpg, end)).end;
      if (end !== jpg.size || xmp.hasMotion) throw new PhotoError('OUTPUT_VALIDATION', '静态图片仍含实况数据或布局无效');
    } finally { await jpg.close(); }
    const mp4 = await Reader.open(tempVideo);
    try { await validateMp4(mp4, { offset: 0, length: mp4.size }); } finally { await mp4.close(); }
    await reader.assertUnchanged(); options.signal?.throwIfAborted();
    await transaction.publish(tempImage, image);
    await transaction.publish(tempVideo, video);
    if (tempExtra && extra) await transaction.publish(tempExtra, extra);
    options.signal?.throwIfAborted();
    if (transaction.usedCopyFallback) result.warnings = ['输出文件系统不支持硬链接，已通过独占创建与分块复制提交'];
  } catch (e) { failure = e; }
  finally { await reader?.close().catch(e => { failure ??= e; }); }
  const cleanupIssues = await transaction.cleanup(failure !== undefined);
  if (options.signal?.aborted) {
    if (cleanupIssues.length) throw new PhotoError('CLEANUP_FAILED', `任务已取消，但有文件未能清理：${cleanupIssues.map(i => i.path).join('、')}`, { cleanupIssues });
    throw options.signal.reason;
  }
  if (failure !== undefined || cleanupIssues.length) {
    return {
      input: inspection.input, status: 'failed',
      code: cleanupIssues.length ? 'CLEANUP_FAILED' : failure instanceof PhotoError ? failure.code : (failure as NodeJS.ErrnoException)?.code ?? 'WRITE_ERROR',
      reason: failure instanceof Error ? failure.message : cleanupIssues.length ? '输出已提交，但临时文件未能完全清理；请查看残留路径' : String(failure),
      ...(cleanupIssues.length ? { cleanupIssues, outputsCommitted: failure === undefined, image, video, ...(extra ? { extra } : {}) } : {}),
    };
  }
  return result;
}
