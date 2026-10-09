import * as p from '@clack/prompts';
import { lstat } from 'node:fs/promises';
import type { RunOptions } from '../cli-options.js';
class Cancelled extends Error {}
export async function interactive(): Promise<{ command: 'inspect' | 'extract'; input: string; options: RunOptions } | undefined> {
  const common = { output: process.stderr };
  const unwrap = <T>(value: T): Exclude<T, symbol> => { if (p.isCancel(value)) throw new Cancelled(); return value as Exclude<T, symbol>; };
  p.intro('OPPO Live · 实况照片整理', common);
  try {
    const command = unwrap(await p.select({ ...common, message: '选择操作', options: [{ value: 'extract' as const, label: '拆分实况照片', hint: '保留原图，输出 JPG + MP4' }, { value: 'inspect' as const, label: '检查照片', hint: '只分析，不写文件' }] }));
    const input = unwrap(await p.text({ ...common, message: '输入文件或目录路径', placeholder: './photos', validate: value => !value?.trim() ? '请输入路径' : undefined })).trim();
    const stat = await lstat(input);
    const recursive = stat.isDirectory() ? unwrap(await p.confirm({ ...common, message: '扫描子目录？', initialValue: true, active: '是', inactive: '否' })) : false;
    const options: RunOptions = { recursive, jobs: 4, out: './oppo-live-output', onConflict: 'error' };
    if (command === 'extract') {
      options.out = unwrap(await p.text({ ...common, message: '输出目录', defaultValue: './oppo-live-output', placeholder: './oppo-live-output' }));
      options.onConflict = unwrap(await p.select({ ...common, message: '输出文件已存在时', options: [{ value: 'error' as const, label: '报告冲突', hint: '继续处理其他照片' }, { value: 'skip' as const, label: '跳过' }, { value: 'rename' as const, label: '自动添加编号' }] }));
      options.saveExtra = unwrap(await p.confirm({ ...common, message: '如有 Oplus 附加数据，另存为 .extra.bin？', initialValue: false, active: '是', inactive: '否' }));
      options.dryRun = unwrap(await p.confirm({ ...common, message: '仅预演，查看提取计划？', initialValue: false, active: '是', inactive: '否' }));
    }
    return { command, input, options };
  } catch (e) {
    if (e instanceof Cancelled) { p.cancel('已取消', common); process.exitCode = 130; return undefined; }
    throw e;
  }
}
