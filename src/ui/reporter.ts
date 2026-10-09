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
    const labels = { valid: '实况', absent: '静态', invalid: '失败', unsupported: '暂不支持' };
    for (const item of data) {
      const text = `${safeText(basename(item.input))}  ${labels[item.motion.status]}${item.motion.video ? ` · MP4 ${(item.motion.video.length / 1024 / 1024).toFixed(2)} MB` : ''}`;
      if (this.pretty) p.log.info(text, { output: process.stderr }); else process.stdout.write(`${text}\n`);
      if (item.error) this.note(item.error.message, true);
      for (const warning of item.warnings) this.detail(warning);
    }
    this.reportStatus(report);
    if (this.pretty) p.outro('检查完成', { output: process.stderr });
  }
  private reportStatus(report: ReportOutput) {
    if (report.error) this.note(report.error.message, true);
    if (report.reportFile?.status === 'saved') {
      const message = `报告已保存至 ${safeText(report.reportFile.path)}`;
      if (this.pretty) p.log.info(message, { output: process.stderr }); else process.stdout.write(`${message}\n`);
    } else if (report.reportFile?.status === 'planned') this.note('预演未保存报告；可使用 --json 重定向保存');
  }
  private detail(message: string) {
    if (this.pretty && /保留 HDR|未进行视频解码验证/.test(message)) p.log.info(safeText(message), { output: process.stderr });
    else this.note(message);
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
    for (const r of results.filter(r => r.status === 'planned').slice(0, 10)) {
      const targets = [r.image, r.video, r.extra].filter((path): path is string => !!path).map(path => relative(out, path));
      const message = safeText(`${basename(r.input)} → ${targets.join(' + ')}`);
      if (this.pretty) p.log.step(message, { output: process.stderr }); else process.stdout.write(`${message}\n`);
    }
    const hiddenPlans = Math.max(0, results.filter(r => r.status === 'planned').length - 10);
    if (hiddenPlans) this.note(`另有 ${hiddenPlans} 个提取计划，使用 --json 查看完整路径`);
    for (const r of results.filter(r => r.status === 'failed' || r.status === 'skipped').slice(0, 10)) {
      const message = safeText(`${basename(r.input)}：${r.reason ?? r.status}`);
      if (r.status === 'skipped' && this.pretty) p.log.info(message, { output: process.stderr });
      else this.note(message, r.status === 'failed');
    }
    const visible = new Set(results.filter(r => r.status === 'extracted' || r.status === 'planned').map(r => r.input));
    const warnings = [...new Set(report.results.filter(r => visible.has(r.input)).flatMap(r => (r.warnings ?? []).map(w => `${basename(r.input)}：${w}`)))];
    for (const warning of warnings.slice(0, 10)) this.detail(warning);
    const hidden = Math.max(0, results.filter(r => r.status === 'failed' || r.status === 'skipped').length - 10) + Math.max(0, warnings.length - 10);
    if (hidden) this.note(`另有 ${hidden} 条详情，使用 --json 查看完整报告`);
    for (const r of results) for (const issue of r.cleanupIssues ?? []) this.note(`未能清理 ${issue.path}：${issue.message}`, true);
    this.reportStatus(report);
    const end = counts.planned ? '预演完成，未写入文件' : counts.extracted ? `文件已保存至 ${safeText(out)}` : '处理完成，没有新文件';
    if (this.pretty) p.outro(end, { output: process.stderr }); else process.stdout.write(`${end}\n`);
  }
}
