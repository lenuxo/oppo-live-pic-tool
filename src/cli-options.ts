export interface RunOptions {
  agent?: boolean; requestId?: string; recursive?: boolean; json?: boolean; color?: boolean; recover?: boolean; jobs: number;
  report?: string; saveExtra?: boolean; out: string; onConflict: 'error' | 'skip' | 'rename';
  allowUnknownVendor?: boolean; videoCompat?: 'original' | 'apple'; dryRun?: boolean;
}
