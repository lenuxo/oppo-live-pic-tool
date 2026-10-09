import * as p from '@clack/prompts';
import { basename, relative } from 'node:path';
import { inspectionReport, extractionReport, type ReportOutput } from '../core/report.js';
export { publicInspection } from '../core/report.js';
import type { ExtractionResult, Inspection } from '../core/types.js';
export function safeText(text: string): string { return text.replace(/[\x00-\x1f\x7f-\x9f]/g, '?'); }
export class Reporter {
  private active?: ReturnType<typeof p.progress> | ReturnType<typeof p.spinner>;
  readonly pretty: boolean;
  constructor(public json: boolean, noColor = false) {
    this.pretty = !json && !!process.stderr.isTTY && process.env.TERM !== 'dumb' && !process.env.CI;
    if (noColor || process.env.NO_COLOR !== undefined) process.env.NO_COLOR = '1';
  }
  intro(input: string, out?: string, alreadyStarted = false) {
    if (this.json) return;
    if (this.pretty) { if (!alreadyStarted) p.intro('OPPO Live · 实况照片整理', { output: process.stderr }); p.log.info(`输入  ${safeText(input)}${out ? `\n输出  ${safeText(out)}` : ''}`, { output: process.stderr }); }
  }
  start(message: string, total?: number) {
    if (!this.pretty) return;
    this.active = total === undefined ? p.spinner({ output: process.stderr, onCancel: () => {} }) : p.progress({ output: process.stderr, max: Math.max(1, total), style: 'block', onCancel: () => {} });
    this.active.start(message);
  }
  advance(done: number, total: number, file: string) {
    if (!this.active) return;
    const text = `${done} / ${total}  ${safeText(basename(file))}`;
    if ('advance' in this.active) this.active.advance(1, text); else this.active.message(text);
  }
  stop(message: string) { this.active?.stop(message); this.active = undefined; }
  cancel() { this.active?.cancel('已停止，清理临时文件'); this.active = undefined; }
  inspections(data: Inspection[], report: ReportOutput = inspectionReport(data)) {
    if (this.json) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return; }
    const counts = { valid: 0, absent: 0, invalid: 0, unsupported: 0 };
    for (const item of data) counts[item.motion.status]++;
    const overview = [
      `共 ${data.length} 张  ·  实况 ${counts.valid}  ·  静态 ${counts.absent}`,
      ...(counts.unsupported || counts.invalid ? [`暂不支持 ${counts.unsupported}  ·  失败 ${counts.invalid}`] : []),
    ].join('\n');
    this.inspectionPanel('检查概览', overview);
    const labels = { valid: '实况', absent: '静态', invalid: '失败', unsupported: '暂不支持' };
    const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(2)} KiB` : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
    const names = new Map<string, number>();
    for (const item of data) names.set(basename(item.input), (names.get(basename(item.input)) ?? 0) + 1);
    const lines: string[] = [];
    for (const item of data) {
      const name = names.get(basename(item.input))! > 1 ? relative(process.cwd(), item.input) || item.input : basename(item.input);
      const fields = [labels[item.motion.status]];
      if (item.motion.status === 'valid') {
        if (item.motion.video) fields.push(`MP4 ${size(item.motion.video.length)}`);
      }
      lines.push(`${safeText(name)}  ·  ${fields.join(' · ')}`);
      if (item.error) lines.push(`  ↳ ${safeText(item.error.message)}`);
    }
    this.inspectionPanel('文件结果', lines.join('\n') || '没有找到可检查的图片。');
    if (data.length) {
      if (this.pretty) p.log.info('完整详情：--json', { output: process.stderr });
      else process.stdout.write('完整详情：--json\n');
    }
    this.reportStatus(report);
    if (this.pretty) p.outro('检查完成', { output: process.stderr });
  }
  private inspectionPanel(title: string, body: string) {
    if (this.pretty) p.note(body, title, { output: process.stderr });
    else process.stdout.write(`\n${title}\n${'─'.repeat(36)}\n${body}\n`);
  }
  private reportStatus(report: ReportOutput) {
    if (report.error) this.note(report.error.message, true);
    if (report.reportFile?.status === 'saved') {
      const message = `报告已保存至 ${safeText(report.reportFile.path)}`;
      if (this.pretty) p.log.info(message, { output: process.stderr }); else process.stdout.write(`${message}\n`);
    } else if (report.reportFile?.status === 'planned') this.note('预演未保存报告；可使用 --json 重定向保存');
  }
  private note(message: string, error = false) {
    if (this.pretty) (error ? p.log.error : p.log.warn)(safeText(message), { output: process.stderr });
    else process.stderr.write(`  ${safeText(message)}\n`);
  }
  summary(results: ExtractionResult[], inspections: Inspection[], out: string, report: ReportOutput = extractionReport(results, inspections)) {
    const counts = { extracted: 0, planned: 0, skipped: 0, failed: 0 };
    for (const r of results) counts[r.status]++;
    if (this.json) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return; }
    const extraCount = results.filter(r => r.extra && ['extracted', 'planned'].includes(r.status)).length;
    const text = `成功提取  ${counts.extracted}\n计划提取  ${counts.planned}\n跳过      ${counts.skipped}\n失败      ${counts.failed}${extraCount ? `\n另存附加  ${extraCount}` : ''}`;
    if (this.pretty) p.note(text, '处理结果', { output: process.stderr }); else process.stdout.write(`${text}\n`);
    const compatibility = results.filter(r => r.status === 'extracted' || r.status === 'planned').map(r => r.videoCompatibility).filter(r => !!r);
    if (compatibility.length) {
      const adjusted = compatibility.filter(r => r.status === 'adjusted').length;
      const planned = compatibility.filter(r => r.status === 'planned').length;
      const retained = compatibility.filter(r => r.code === 'APPLE_COMPAT_UNAVAILABLE').length;
      const message = `Apple 兼容：已调整 ${adjusted}${planned ? ` · 计划调整 ${planned}` : ''} · 保留原视频 ${compatibility.length - adjusted - planned}${retained ? `（${retained} 个无法安全调整，原因见 JSON 报告）` : ''}`;
      if (this.pretty) p.log.info(message, { output: process.stderr }); else process.stdout.write(`${message}\n`);
    }
    const plans = results.filter(r => r.status === 'planned');
    for (const r of plans.slice(0, 3)) {
      const targets = [r.image, r.video, r.extra].filter((path): path is string => !!path).map(path => relative(out, path));
      const message = safeText(`${basename(r.input)} → ${targets.join(' + ')}`);
      if (this.pretty) p.log.step(message, { output: process.stderr }); else process.stdout.write(`${message}\n`);
    }
    if (plans.length > 3) this.note(`另有 ${plans.length - 3} 个提取计划，使用 --json 查看完整路径`);
    const skipped = new Map<string, number>();
    for (const r of results.filter(r => r.status === 'skipped')) {
      const reason = r.reason ?? '跳过';
      skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    }
    if (skipped.size) {
      const reasons = [...skipped].slice(0, 5).map(([reason, count]) => `${safeText(reason)} ${count} 张`);
      if (skipped.size > 5) reasons.push(`另有 ${skipped.size - 5} 类原因`);
      const message = `跳过原因：${reasons.join(' · ')}`;
      if (this.pretty) p.log.info(message, { output: process.stderr }); else process.stdout.write(`${message}\n`);
    }
    const failed = results.filter(r => r.status === 'failed');
    for (const r of failed.slice(0, 5)) this.note(`${basename(r.input)}：${r.reason ?? '处理失败'}`, true);
    if (failed.length > 5) this.note(`另有 ${failed.length - 5} 个失败文件，使用 --json 或 --report 查看完整详情`, true);
    const cleanup = results.flatMap(r => r.cleanupIssues ?? []);
    for (const issue of cleanup.slice(0, 5)) this.note(`未能清理 ${issue.path}：${issue.message}`, true);
    if (cleanup.length > 5) this.note(`另有 ${cleanup.length - 5} 个清理残留，请查看 JSON 报告中的 cleanupIssues`, true);
    const hint = '完整详情：--json 或 --report <file>';
    if (this.pretty) p.log.info(hint, { output: process.stderr }); else process.stdout.write(`${hint}\n`);
    this.reportStatus(report);
    const end = counts.planned ? '预演完成，未写入文件' : counts.extracted ? `文件已保存至 ${safeText(out)}` : '处理完成，没有新文件';
    if (this.pretty) p.outro(end, { output: process.stderr }); else process.stdout.write(`${end}\n`);
  }
}
