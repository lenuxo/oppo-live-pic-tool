export { inspectFile } from './core/inspect.js';
export { planExtraction, executeExtraction } from './core/extract.js';
export type { ExtractionPlan } from './core/extract.js';
export type { Inspection, ExtractOptions, ExtractionResult, Range } from './core/types.js';
export { PhotoError } from './core/types.js';

export { inspectionReport, extractionReport, saveReport } from './core/report.js';
export type { Report, ReportOutput } from './core/report.js';

export { agentResponse, populateAgent, capabilities } from './core/agent.js';
export type { AgentResponse, AgentCommand } from './core/agent.js';
