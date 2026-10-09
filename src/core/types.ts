import type { AppleCompatibility } from '../formats/apple-compat.js';
export type Range = { offset: number; length: number };
export type Patch = Range & { bytes: Buffer };
export interface Inspection {
  input: string;
  format: 'jpeg' | 'unsupported';
  vendor: { value: 'oppo' | 'other' | 'unknown'; evidence: string[] };
  motion: { status: 'valid' | 'absent' | 'invalid' | 'unsupported'; method?: 'xmp-directory' | 'microvideo-offset' | 'recovery-scan'; video?: Range; extra?: Range };
  profile?: 'oplus-v2';
  warnings: string[];
  error?: { code: string; message: string };
  /** Internal extraction details; omitted from CLI JSON. */
  layout?: { imageEnd: number; patches: Patch[]; fingerprint: string };
}
export interface ExtractOptions {
  out: string; base: string; conflict: 'error' | 'skip' | 'rename';
  /** Deprecated compatibility option; valid layouts are accepted regardless of vendor. */
  allowUnknownVendor?: boolean; videoCompat?: 'original' | 'apple'; saveExtra?: boolean; dryRun?: boolean; signal?: AbortSignal;
}
export interface ExtractionResult {
  input: string; status: 'extracted' | 'planned' | 'skipped' | 'failed';
  videoCompatibility?: AppleCompatibility;
  image?: string; video?: string; extra?: string; warnings?: string[]; outputsCommitted?: boolean; cleanupIssues?: { path: string; message: string }[]; reason?: string; code?: string;
}
export class PhotoError extends Error {
  constructor(public code: string, message: string, public details?: { cleanupIssues?: { path: string; message: string }[] }) { super(message); }
}
