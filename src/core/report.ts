import { lstat, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { AgentResponse } from './agent.js';
import { VERSION } from '../version.js';
import { OutputTransaction, temporaryPath } from '../io/writer.js';
import { PhotoError, type Inspection, type ExtractionResult } from './types.js';
export function publicInspection({ layout: _layout, ...data }: Inspection) { return data; }
export function inspectionReport(inspections: Inspection[]) {
  const summary = { valid: 0, absent: 0, invalid: 0, unsupported: 0 };
  for (const i of inspections) summary[i.motion.status]++;
  return { schemaVersion: 1, tool: { name: 'oppo-live', version: VERSION }, createdAt: new Date().toISOString(), command: 'inspect' as const, summary, results: inspections.map(publicInspection) };
}
export function extractionReport(results: ExtractionResult[], inspections: Inspection[]) {
  const summary = { extracted: 0, planned: 0, skipped: 0, failed: 0 };
  const byPath = new Map(inspections.map(i => [i.input, i]));
  for (const r of results) summary[r.status]++;
  return {
    schemaVersion: 1, tool: { name: 'oppo-live', version: VERSION }, createdAt: new Date().toISOString(), command: 'extract' as const, summary,
    results: results.map(r => {
      const i = byPath.get(r.input);
      return { ...r, format: i?.format, vendor: i?.vendor, motion: i?.motion, profile: i?.profile, warnings: [...(i?.warnings ?? []).map(w => r.extra && ['extracted', 'planned'].includes(r.status) ? w.replace('可用 --save-extra 单独保存', r.status === 'planned' ? '计划另存附加数据' : '已另存附加数据') : w), ...(r.warnings ?? [])] };
    }),
  };
}
export type Report = ReturnType<typeof inspectionReport> | ReturnType<typeof extractionReport>;
export type ReportOutput = Report & { reportFile?: { path: string; status: 'saved' | 'planned' | 'failed' }; error?: { code: string; message: string } };
export async function assertReportAvailable(path: string): Promise<void> {
  try { await lstat(resolve(path)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw new PhotoError('REPORT_CONFLICT', '报告文件已存在，请使用新路径；不会覆盖已有文件');
}
export async function saveReport(path: string, report: ReportOutput | AgentResponse, signal?: AbortSignal): Promise<void> {
  const target = resolve(path), temporary = temporaryPath(target);
  const tx = new OutputTransaction(signal);
  let failure: unknown;
  try {
    signal?.throwIfAborted();
    await mkdir(dirname(target), { recursive: true });
    const out = await tx.create(temporary);
    try { await out.writeFile(`${JSON.stringify(report, null, 2)}\n`); await out.sync(); } finally { await out.close(); }
    await tx.publish(temporary, target);
    signal?.throwIfAborted();
  } catch (e) { failure = e; }
  const issues = await tx.cleanup(failure !== undefined);
  if (issues.length) throw new PhotoError('CLEANUP_FAILED', `报告清理失败：${issues.map(i => i.path).join('、')}`, { cleanupIssues: issues });
  if (failure !== undefined) throw failure;
}
