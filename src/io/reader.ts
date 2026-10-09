import { open, type FileHandle } from 'node:fs/promises';
import { PhotoError } from '../core/types.js';
export function fingerprint(s: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}
export class Reader {
  private cache: Buffer = Buffer.alloc(0);
  private cacheStart = -1;
  constructor(public handle: FileHandle, public size: number, public stamp: string, public signal?: AbortSignal) {}
  static async open(path: string, signal?: AbortSignal): Promise<Reader> {
    const handle = await open(path, 'r');
    try {
      const s = await handle.stat({ bigint: true });
      if (!s.isFile() || s.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new PhotoError('INVALID_INPUT', '输入必须是大小可安全寻址的普通文件');
      return new Reader(handle, Number(s.size), fingerprint(s), signal);
    } catch (e) { await handle.close(); throw e; }
  }
  async read(offset: number, length: number): Promise<Buffer> {
    this.signal?.throwIfAborted();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size) throw new PhotoError('INVALID_RANGE', '读取范围超出文件边界');
    const b = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.handle.read(b, done, length - done, offset + done);
      if (!bytesRead) throw new PhotoError('TRUNCATED_FILE', '文件被截断或读取不完整');
      done += bytesRead;
    }
    return b;
  }
  async byte(offset: number): Promise<number> {
    if (offset < 0 || offset >= this.size) throw new PhotoError('TRUNCATED_JPEG', 'JPEG 数据不完整');
    if (offset < this.cacheStart || offset >= this.cacheStart + this.cache.length) {
      this.cacheStart = offset;
      this.cache = await this.read(offset, Math.min(65536, this.size - offset));
    }
    return this.cache[offset - this.cacheStart]!;
  }
  async findByte(value: number, offset: number): Promise<number> {
    while (offset < this.size) {
      await this.byte(offset);
      const found = this.cache.indexOf(value, offset - this.cacheStart);
      if (found >= 0) return this.cacheStart + found;
      offset = this.cacheStart + this.cache.length;
    }
    throw new PhotoError('TRUNCATED_JPEG', 'JPEG 扫描数据不完整');
  }
  async assertUnchanged(): Promise<void> {
    if (fingerprint(await this.handle.stat({ bigint: true })) !== this.stamp) throw new PhotoError('SOURCE_CHANGED', '处理期间源文件发生变化');
  }
  close() { return this.handle.close(); }
}
