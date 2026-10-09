import { lstat, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, extname, dirname, isAbsolute, sep } from 'node:path';
import { PhotoError } from '../core/types.js';
export const inside = (parent: string, child: string) => { const rel = relative(parent, child); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
export async function scanFiles(input: string, options: { recursive?: boolean; exclude?: string; signal?: AbortSignal } = {}): Promise<{ files: string[]; base: string }> {
  const path = resolve(input), stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new PhotoError('SYMLINK_INPUT', '输入路径不能是符号链接');
  if (stat.isFile()) return { files: [path], base: dirname(path) };
  if (!stat.isDirectory()) throw new PhotoError('INVALID_INPUT', '输入必须是文件或目录');
  const excluded = options.exclude ? resolve(options.exclude) : undefined;
  let realExcluded = excluded;
  if (excluded) { try { realExcluded = await realpath(excluded); } catch { /* not created yet */ } }
  if (excluded && (inside(excluded, path) || inside(realExcluded!, await realpath(path)))) throw new PhotoError('INVALID_OUTPUT', '输入目录不能位于输出目录中');
  const files: string[] = [];
  async function walk(dir: string) {
    options.signal?.throwIfAborted();
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (excluded && (inside(excluded, full) || inside(realExcluded!, full))) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && options.recursive) await walk(full);
      else if (entry.isFile() && /^(\.jpe?g|\.heic|\.heif|\.avif|\.png|\.webp|\.tiff?|\.bmp)$/i.test(extname(full))) files.push(full);
    }
  }
  await walk(path);
  return { files, base: path };
}
