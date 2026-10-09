import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { Reader } from './reader.js';
import { PhotoError } from '../core/types.js';
export const temporaryPath = (destination: string) => join(dirname(destination), `.oppo-live-${randomUUID()}.tmp`);
interface OwnedFile { path: string; kind: 'temporary' | 'output'; dev: bigint; ino: bigint }
export interface CleanupIssue { path: string; message: string }
const LINK_UNAVAILABLE = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);
/** Tracks only files created by this operation, including partially copied outputs. */
export class OutputTransaction {
  private files: OwnedFile[] = [];
  usedCopyFallback = false;
  constructor(private signal?: AbortSignal) {}
  async create(path: string, kind: OwnedFile['kind'] = 'temporary'): Promise<FileHandle> {
    this.signal?.throwIfAborted();
    const handle = await fs.open(path, 'wx', 0o600);
    try {
      const stat = await handle.stat({ bigint: true });
      this.files.push({ path, kind, dev: stat.dev, ino: stat.ino });
      return handle;
    } catch (e) { await handle.close(); await fs.unlink(path); throw e; }
  }
  async publish(temporary: string, destination: string): Promise<void> {
    this.signal?.throwIfAborted();
    const source = this.files.find(f => f.path === temporary);
    if (!source) throw new PhotoError('INVALID_TRANSACTION', '提交的临时文件不属于当前任务');
    try {
      await fs.link(temporary, destination);
      this.files.push({ ...source, path: destination, kind: 'output' });
      return;
    } catch (e) {
      if (!LINK_UNAVAILABLE.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
    }
    // Exclusive creation also works on exFAT/FAT-style filesystems. Readers may
    // see a partial file until copy finishes; it is removed on failure/cancel.
    const out = await this.create(destination, 'output');
    this.usedCopyFallback = true;
    let input: Reader | undefined;
    try {
      input = await Reader.open(temporary, this.signal);
      for (let offset = 0; offset < input.size; offset += 65536) {
        this.signal?.throwIfAborted();
        const bytes = await input.read(offset, Math.min(65536, input.size - offset));
        let written = 0;
        while (written < bytes.length) {
          this.signal?.throwIfAborted();
          const result = await out.write(bytes, written, bytes.length - written);
          if (!result.bytesWritten) throw new PhotoError('WRITE_ERROR', '提交输出时写入不完整');
          written += result.bytesWritten;
        }
      }
      await out.sync();
    } finally { await input?.close(); await out.close(); }
  }
  async cleanup(rollback: boolean): Promise<CleanupIssue[]> {
    const issues: CleanupIssue[] = [];
    for (const file of [...this.files].reverse()) {
      if (!rollback && file.kind === 'output') continue;
      try {
        const current = await fs.lstat(file.path, { bigint: true });
        if (current.dev !== file.dev || current.ino !== file.ino) throw new PhotoError('OUTPUT_REPLACED', '路径已被其他文件替换，未删除');
        await fs.unlink(file.path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        issues.push({ path: file.path, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return issues;
  }
}
