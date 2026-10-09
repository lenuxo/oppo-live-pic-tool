import { VERSION } from '../version.js';
import { type Inspection, type ExtractionResult } from './types.js';
import { publicInspection } from './report.js';
export type AgentCommand = 'inspect' | 'extract' | 'capabilities' | null;
export interface AgentResponse {
  schemaVersion: 1;
  protocol: 'oppo-live.agent';
  tool: { name: 'oppo-live'; version: string };
  requestId: string | null;
  command: AgentCommand;
  status: 'success' | 'partial' | 'failed' | 'cancelled';
  summary: { total: number; processed: number; inspected: number; extracted: number; planned: number; skipped: number; failed: number; pending: number };
  results: Record<string, unknown>[];
  error: { code: string; message: string; cleanupIssues?: { path: string; message: string }[] } | null;
  capabilities?: ReturnType<typeof capabilities>;
  reportFile?: { path: string; status: 'saved' | 'planned' | 'failed' };
  information?: string;
}
export function capabilities() {
  return {
    agentSchemaVersion: 1,
    transport: { input: 'argv', output: 'single-json-object', diagnostics: 'stderr', interactive: false },
    commands: [
      { name: 'capabilities', requiredArguments: [], writesFiles: false },
      { name: 'inspect', requiredArguments: ['input'], writesFiles: 'only-with-report', options: ['--recursive', '--recover', '--jobs', '--report'] },
      { name: 'extract', requiredArguments: ['input'], writesFiles: true, dryRunWritesFiles: false, options: ['--recursive', '--recover', '--jobs', '--out', '--on-conflict', '--allow-unknown-vendor', '--save-extra', '--dry-run', '--report'] },
    ],
    globalOptions: ['--agent', '--request-id', '--help', '--version'],
    optionSchema: {
      '--agent': { type: 'boolean' }, '--request-id': { type: 'string' },
      '--recursive': { type: 'boolean', default: false }, '--recover': { type: 'boolean', default: false },
      '--jobs': { type: 'integer', default: 4, minimum: 1, maximum: 32 },
      '--out': { type: 'path', default: './oppo-live-output' }, '--report': { type: 'path', overwrite: false },
      '--on-conflict': { type: 'enum', values: ['error', 'skip', 'rename'], default: 'error' },
      '--allow-unknown-vendor': { type: 'boolean', default: false }, '--save-extra': { type: 'boolean', default: false },
      '--dry-run': { type: 'boolean', default: false },
    },
    responseSchema: {
      requiredFields: ['schemaVersion', 'protocol', 'tool', 'requestId', 'command', 'status', 'summary', 'results', 'error'],
      resultStatuses: { inspect: ['inspected', 'failed', 'pending'], extract: ['extracted', 'planned', 'skipped', 'failed', 'pending'] },
      summaryInvariant: 'processed + pending = total',
      error: 'null or {code, message, optional cleanupIssues}',
      outputPaths: 'absolute paths; pending means not completed, not safe to blindly retry',
    },
    defaults: { preserveSource: true, overwrite: false, jobs: 4, out: './oppo-live-output', onConflict: 'error', saveExtra: false },
    constraints: { jobs: { minimum: 1, maximum: 32 }, onConflict: ['error', 'skip', 'rename'], followsSymlinks: false },
    formats: { supported: ['JPEG', 'JPEG + HDR GainMap', 'Oplus v2 MotionPhoto'], verifiedSamples: ['OPPO Find X9 HDR', 'Oplus v2 VESDK'], unsupported: ['HEIC', 'AVIF', 'extended XMP', 'unknown multi-media layouts'] },
    statuses: ['success', 'partial', 'failed', 'cancelled'],
    exitCodes: { '0': 'success (may include skipped files)', '1': 'partial or failed processing', '2': 'invalid invocation', '130': 'cancelled' },
    reasonCodes: ['ORDINARY_PHOTO', 'UNSUPPORTED_FORMAT', 'UNSUPPORTED_LAYOUT', 'NON_OPPO_VENDOR', 'UNKNOWN_VENDOR', 'OUTPUT_CONFLICT', 'PENDING'],
    errorGuidance: {
      OUTPUT_CONFLICT: { suggestedOptions: ['--on-conflict skip', '--on-conflict rename'], automaticRetry: false },
      UNKNOWN_VENDOR: { suggestedOptions: ['--allow-unknown-vendor'], automaticRetry: false },
      INVALID_MOTION_METADATA: { suggestedOptions: ['--recover'], automaticRetry: false },
      CLEANUP_FAILED: { action: 'inspect cleanupIssues and existing outputs before retry', automaticRetry: false },
      REPORT_CONFLICT: { action: 'choose a new report path', automaticRetry: false },
      CANCELLED: { action: 'inspect completed results and output conflicts before retry', automaticRetry: false },
    },
    validation: 'container structure only; no runtime image/video decoding',
  };
}
export function agentResponse(command: AgentCommand, requestId?: string): AgentResponse {
  return { schemaVersion: 1, protocol: 'oppo-live.agent', tool: { name: 'oppo-live', version: VERSION }, requestId: requestId ?? null, command, status: 'success', summary: { total: 0, processed: 0, inspected: 0, extracted: 0, planned: 0, skipped: 0, failed: 0, pending: 0 }, results: [], error: null };
}
export function inspectionCode(i: Inspection): string {
  return i.error?.code ?? ({ valid: 'MOTION_PHOTO', absent: 'ORDINARY_PHOTO', invalid: 'INVALID_PHOTO', unsupported: 'UNSUPPORTED_FORMAT' }[i.motion.status]);
}
export function extractionCode(r: ExtractionResult, i?: Inspection): string {
  if (r.code) return r.code;
  if (r.status !== 'skipped') return { extracted: 'EXTRACTED', planned: 'PLANNED', failed: 'EXTRACTION_FAILED' }[r.status];
  if (!i) return 'SKIPPED';
  if (i.motion.status !== 'valid') return inspectionCode(i);
  return i.vendor.value === 'other' ? 'NON_OPPO_VENDOR' : 'UNKNOWN_VENDOR';
}
export function populateAgent(response: AgentResponse, inspections: Inspection[], results?: ExtractionResult[], files: string[] = inspections.map(i => i.input)): AgentResponse {
  response.summary.total = files.length;
  response.summary.inspected = inspections.length;
  const byPath = new Map(inspections.map(i => [i.input, i]));
  response.results = results ? results.map(r => ({ ...r, code: extractionCode(r, byPath.get(r.input)), message: r.reason ?? r.status, outputsCommitted: r.outputsCommitted ?? r.status === 'extracted', inspection: byPath.has(r.input) ? publicInspection(byPath.get(r.input)!) : undefined })) : inspections.map(i => ({ ...publicInspection(i), status: i.motion.status === 'invalid' ? 'failed' : 'inspected', code: inspectionCode(i), message: i.error?.message ?? i.motion.status, outputsCommitted: false }));
  response.summary.processed = response.results.length;
  response.summary.extracted = results?.filter(r => r.status === 'extracted').length ?? 0;
  response.summary.planned = results?.filter(r => r.status === 'planned').length ?? 0;
  response.summary.skipped = results?.filter(r => r.status === 'skipped').length ?? 0;
  response.summary.failed = results ? results.filter(r => r.status === 'failed').length : inspections.filter(i => i.motion.status === 'invalid').length;
  const seen = new Set(response.results.map(r => r.input));
  const pending = files.filter(f => !seen.has(f));
  response.summary.pending = pending.length;
  response.results.push(...pending.map(input => ({ input, status: 'pending', code: 'PENDING', message: '未完成处理', outputsCommitted: false, ...(byPath.has(input) ? { inspection: publicInspection(byPath.get(input)!) } : {}) })));
  if (response.summary.failed) response.status = response.summary.failed === response.summary.processed ? 'failed' : 'partial';
  return response;
}
