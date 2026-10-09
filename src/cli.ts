#!/usr/bin/env node
import { Command, Option, InvalidArgumentError, CommanderError } from 'commander';
import { resolve } from 'node:path';
import { scanFiles } from './io/scanner.js';
import { inspectFile } from './core/inspect.js';
import { planExtraction, executeExtraction, type ExtractionPlan } from './core/extract.js';
import { VERSION } from './version.js';
import { PhotoError } from './core/types.js';
import { inspectionReport, extractionReport, assertReportAvailable, saveReport, type ReportOutput } from './core/report.js';
import { Reporter, safeText } from './ui/reporter.js';
import { interactive } from './ui/interactive.js';
import type { RunOptions } from './cli-options.js';
import { agentResponse, populateAgent, capabilities, type AgentResponse, type AgentCommand } from './core/agent.js';
import type { Inspection, ExtractionResult } from './core/types.js';
// Bootstrap only affects rendering of parse errors; Commander still validates argv.
function bootstrap(args: string[]) {
  let agent = false, requestId: string | undefined, command: AgentCommand = null;
  const values = new Set(['--request-id', '--out', '-o', '--report', '--jobs', '--video-compat']);
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--') break;
    if (token === '--agent') agent = true;
    else if (token.startsWith('--request-id=')) requestId = token.slice(13);
    else if (values.has(token)) { const value = args[i + 1]; if (value && !value.startsWith('-')) { i++; if (token === '--request-id') requestId = value; } }
    else if (['inspect', 'extract', 'capabilities'].includes(token) && !command) command = token as AgentCommand;
  }
  return { agent, requestId, command };
}
const initial = bootstrap(process.argv.slice(2));
let machine = initial.agent;
let response = agentResponse(initial.command, initial.requestId);
let information = '';
let dispatched = false;
let knownFiles: string[] = [];
const completedInspections = new Map<string, Inspection>();
const completedResults = new Map<string, ExtractionResult>();
function snapshot() {
  return populateAgent(response, knownFiles.flatMap(f => completedInspections.has(f) ? [completedInspections.get(f)!] : []), response.command === 'extract' ? knownFiles.flatMap(f => completedResults.has(f) ? [completedResults.get(f)!] : []) : undefined, knownFiles);
}
function emitAgent() { process.stdout.write(`${JSON.stringify(response, null, 2)}\n`); }
const controller = new AbortController();
process.on('SIGINT', () => controller.abort(new Error('已取消')));
process.on('SIGTERM', () => controller.abort(new Error('已取消')));
let currentReporter: Reporter | undefined;
async function mapLimit<T, R>(items: T[], jobs: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let next = 0;
  const workers = Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) { controller.signal.throwIfAborted(); const i = next++; results[i] = await task(items[i]!, i); }
  });
  // Wait for all active writers to clean up even if one worker aborts.
  const settled = await Promise.allSettled(workers);
  const cleanupFailures = settled.filter(s => s.status === 'rejected' && s.reason instanceof PhotoError && s.reason.code === 'CLEANUP_FAILED');
  if (cleanupFailures.length) throw new PhotoError('CLEANUP_FAILED', cleanupFailures.map(s => s.status === 'rejected' ? s.reason.message : '').join('；'), { cleanupIssues: cleanupFailures.flatMap(s => s.status === 'rejected' ? s.reason.details?.cleanupIssues ?? [] : []) });
  const failed = settled.find(s => s.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results;
}
async function run(command: 'inspect' | 'extract', input: string, options: RunOptions, alreadyStarted = false) {
  dispatched = true;
  machine = !!options.agent;
  response = agentResponse(command, options.requestId);
  const reporter = currentReporter = new Reporter(machine || !!options.json, options.color === false);
  const out = resolve(options.out ?? './oppo-live-output');
  if (options.report && !options.dryRun) await assertReportAvailable(options.report);
  reporter.intro(resolve(input), command === 'extract' ? out : undefined, alreadyStarted);
  reporter.start('扫描图片');
  const { files, base } = await scanFiles(input, { recursive: options.recursive, exclude: command === 'extract' ? out : undefined, signal: controller.signal });
  knownFiles = files;
  reporter.stop(`扫描完成：${files.length} 张图片`);
  reporter.start('检查实况结构', files.length);
  let done = 0;
  const inspections = await mapLimit(files, options.jobs ?? 4, async file => {
    const result = await inspectFile(file, { recover: options.recover, signal: controller.signal });
    completedInspections.set(file, result);
    reporter.advance(++done, files.length, file); return result;
  });
  reporter.stop('检查完成');
  if (command === 'inspect') {
    if (machine) { snapshot(); await persistAgent(options); }
    else { const report = await persist(inspectionReport(inspections), options); reporter.inspections(inspections, report); }
    if (inspections.some(i => i.motion.status === 'invalid')) process.exitCode = 1;
    return;
  }
  const reserved = new Set<string>(options.report && !options.dryRun ? [resolve(options.report)] : []);
  const plans: (ExtractionPlan | ExtractionResult)[] = [];
  for (const inspection of inspections) {
    controller.signal.throwIfAborted();
    try {
      plans.push(await planExtraction(inspection, { out, base, conflict: options.onConflict ?? 'error', allowUnknownVendor: options.allowUnknownVendor, saveExtra: options.saveExtra, videoCompat: options.videoCompat, dryRun: options.dryRun, signal: controller.signal }, reserved));
    } catch (e) {
      if (controller.signal.aborted) throw e;
      plans.push({ input: inspection.input, status: 'failed', code: e instanceof PhotoError ? e.code : (e as NodeJS.ErrnoException).code ?? 'PLAN_ERROR', reason: e instanceof Error ? e.message : String(e) });
    }
  }
  done = 0;
  reporter.start(options.dryRun ? '生成提取计划' : '提取照片与视频', plans.length);
  const results = await mapLimit(plans, options.jobs ?? 4, async plan => {
    let r: ExtractionResult;
    try { r = 'inspection' in plan ? await executeExtraction(plan) : plan; }
    catch (e) {
      if (e instanceof PhotoError && e.code === 'CLEANUP_FAILED') completedResults.set('inspection' in plan ? plan.inspection.input : plan.input, { input: 'inspection' in plan ? plan.inspection.input : plan.input, status: 'failed', code: e.code, reason: e.message, cleanupIssues: e.details?.cleanupIssues });
      throw e;
    }
    completedResults.set(r.input, r);
    reporter.advance(++done, plans.length, r.input); return r;
  });
  reporter.stop(options.dryRun ? '预演完成' : '处理完成');
  if (machine) { snapshot(); await persistAgent(options); }
  else { const report = await persist(extractionReport(results, inspections), options); reporter.summary(results, inspections, out, report); }
  if (results.some(r => r.status === 'failed')) process.exitCode = 1;
}
async function persist(report: ReportOutput, options: RunOptions): Promise<ReportOutput> {
  if (!options.report) return report;
  report.reportFile = { path: resolve(options.report), status: options.dryRun ? 'planned' : 'saved' };
  if (options.dryRun) return report;
  try { await saveReport(options.report, report, controller.signal); }
  catch (e) {
    if (controller.signal.aborted) throw e;
    report.reportFile.status = 'failed';
    report.error = { code: e instanceof PhotoError ? e.code : 'REPORT_WRITE_ERROR', message: `照片处理结果已保留，但报告保存失败：${e instanceof Error ? e.message : String(e)}` };
    process.exitCode = 1;
  }
  return report;
}
async function persistAgent(options: RunOptions) {
  if (!options.report) return;
  response.reportFile = { path: resolve(options.report), status: options.dryRun ? 'planned' : 'saved' };
  if (options.dryRun) return;
  try { await saveReport(options.report, response, controller.signal); }
  catch (e) {
    if (controller.signal.aborted) throw e;
    response.reportFile.status = 'failed';
    response.error = { code: e instanceof PhotoError ? e.code : 'REPORT_WRITE_ERROR', message: e instanceof Error ? e.message : String(e) };
    response.status = response.status === 'failed' || !response.summary.processed ? 'failed' : 'partial';
    process.exitCode = 1;
  }
}
const program = new Command().name('oppo-live').description('检查兼容的 JPEG 实况照片，无损拆分为 JPG + MP4').version(VERSION).option('--agent', '机器模式：统一 JSON 响应，禁止交互').option('--request-id <id>', '原样返回调用方请求标识').exitOverride();
program.configureOutput({ writeOut: text => { if (machine) information += text; else process.stdout.write(text); }, outputError: (message, write) => { if (!machine && !process.argv.includes('--json')) write(message); } });
function common(command: Command) {
  return command.argument('<input>', '图片文件或目录').option('-r, --recursive', '递归扫描子目录')
    .option('--recover', '元数据定位失败时搜索附加 MP4')
    .option('--report <file>', '保存 JSON 报告，不覆盖已有文件')
    .option('--json', '输出 JSON 报告，关闭交互和动画')
    .option('--no-color', '关闭终端颜色')
    .option('--jobs <n>', '并发任务数（1–32）', value => { if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 32) throw new InvalidArgumentError('jobs 必须是 1–32 的整数'); return Number(value); }, 4);
}
common(program.command('inspect').description('检查实况结构，不写入文件')).action((input, _options, command) => run('inspect', input, command.optsWithGlobals()));
common(program.command('extract').description('保留原文件，拆分静态 JPG 和原始 MP4'))
  .option('-o, --out <dir>', '输出目录', './oppo-live-output')
  .addOption(new Option('--on-conflict <strategy>', '冲突策略').choices(['error', 'skip', 'rename']).default('error'))
  .option('--allow-unknown-vendor', '兼容旧版参数；有效实况已默认允许提取')
  .addOption(new Option('--video-compat <mode>', '视频输出：original 保留原视频；apple 安全调整 HEVC 封装，不转码').choices(['original', 'apple']).default('original'))
  .option('--save-extra', '另存 Oplus 附加数据为同名 .extra.bin')
  .option('--dry-run', '仅生成提取计划，不写文件')
  .action((input, _options, command) => run('extract', input, command.optsWithGlobals()));
program.command('capabilities').description('输出命令、格式和机器调用契约').action((_options, command) => {
  dispatched = true;
  const options = command.optsWithGlobals();
  machine = !!options.agent;
  response = agentResponse('capabilities', options.requestId);
  response.capabilities = capabilities();
  if (!machine) process.stdout.write(`${JSON.stringify(response.capabilities, null, 2)}\n`);
});
program.addHelpText('after', '\n示例：\n  oppo-live inspect ./photos -r\n  oppo-live extract ./photos -r -o ./output\n  oppo-live extract ./photos --dry-run --json\n\n不带参数运行可进入交互式引导。');
try {
  if (process.argv.length === 2 && process.stdin.isTTY && process.stderr.isTTY) {
    const selection = await interactive();
    if (selection) await run(selection.command, selection.input, selection.options, true);
  } else if (process.argv.length === 2) program.outputHelp();
  else {
    await program.parseAsync(process.argv, { from: 'node' });
    if (machine && !dispatched) throw new PhotoError('MISSING_COMMAND', '请选择 inspect、extract 或 capabilities 命令');
  }
} catch (e) {
  if (machine) {
    snapshot();
    const cancelled = controller.signal.aborted;
    const informational = e instanceof CommanderError && !e.exitCode;
    process.exitCode = cancelled ? 130 : informational ? 0 : e instanceof CommanderError || (e instanceof PhotoError && e.code === 'MISSING_COMMAND') ? 2 : 1;
    if (informational) { response.status = 'success'; response.information = information; }
    else {
      response.status = cancelled ? 'cancelled' : response.summary.processed ? 'partial' : 'failed';
      response.error = { code: cancelled && !(e instanceof PhotoError) ? 'CANCELLED' : e instanceof CommanderError ? 'INVALID_ARGUMENT' : (e as { code?: string }).code ?? 'CLI_ERROR', message: e instanceof Error ? e.message : String(e), ...(e instanceof PhotoError && e.details?.cleanupIssues ? { cleanupIssues: e.details.cleanupIssues } : {}) };
    }
  } else if (controller.signal.aborted) {
    currentReporter?.cancel();
    const message = e instanceof PhotoError && e.code === 'CLEANUP_FAILED' ? e.message : '已取消；已完成的输出保留，未完成任务已执行清理。';
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: { code: e instanceof PhotoError ? e.code : 'CANCELLED', message } })}\n`);
    else process.stderr.write(`${safeText(message)}\n`);
    process.exitCode = 130;
  } else if (e instanceof CommanderError) {
    process.exitCode = e.exitCode ? 2 : 0;
    if (e.exitCode && process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: { code: e.code, message: e.message } })}\n`);
  }
  else {
    currentReporter?.cancel();
    const message = e instanceof Error ? e.message : String(e);
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: { code: (e as { code?: string }).code ?? 'CLI_ERROR', message } })}\n`);
    else process.stderr.write(`错误：${safeText(message)}\n`);
    process.exitCode = 1;
  }
}

if (machine) emitAgent();
