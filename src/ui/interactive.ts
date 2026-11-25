import * as p from '@clack/prompts';
import { lstat } from 'node:fs/promises';
import type { RunOptions } from '../cli-options.js';
import { readQuickVideoMode, saveQuickVideoMode, type VideoMode } from '../quick-preference.js';
class Cancelled extends Error {}
export async function interactive(): Promise<{ command: 'inspect' | 'extract' | 'quick'; input: string; options: RunOptions } | undefined> {
  const common = { output: process.stderr };
  const unwrap = <T>(value: T): Exclude<T, symbol> => { if (p.isCancel(value)) throw new Cancelled(); return value as Exclude<T, symbol>; };
  p.intro('OPPO Live · 实况照片整理', common);
  try {
    const command = unwrap(await p.select({ ...common, message: '选择操作', options: [{ value: 'quick' as const, label: '快速提取视频', hint: '视频保存到原图旁，已有视频跳过' }, { value: 'extract' as const, label: '拆分实况照片', hint: '保留原图，输出 JPG + MP4' }, { value: 'inspect' as const, label: '检查照片', hint: '只分析，不写文件' }] }));
    const input = unwrap(await p.text({ ...common, message: '输入文件或目录路径', defaultValue: command === 'quick' ? '.' : undefined, placeholder: command === 'quick' ? '.' : './photos', validate: value => !value?.trim() && command !== 'quick' ? '请输入路径' : undefined })).trim() || '.';
    const stat = await lstat(input);
    const recursive = stat.isDirectory() ? unwrap(await p.confirm({ ...common, message: '扫描子目录？', initialValue: command !== 'quick', active: '是', inactive: '否' })) : false;
    const options: RunOptions = { recursive, jobs: 4, out: './oppo-live-output', onConflict: 'error' };
    if (command === 'quick') options.onConflict = 'skip';
    if (command === 'extract') {
      options.out = unwrap(await p.text({ ...common, message: '输出目录', defaultValue: './oppo-live-output', placeholder: './oppo-live-output' }));
      options.onConflict = unwrap(await p.select({ ...common, message: '输出文件已存在时', options: [{ value: 'error' as const, label: '报告冲突', hint: '继续处理其他照片' }, { value: 'skip' as const, label: '跳过' }, { value: 'rename' as const, label: '自动添加编号' }] }));
    }
    if (command === 'extract' || command === 'quick') {
      const current: VideoMode = command === 'quick' ? await readQuickVideoMode() : 'original';
      options.videoCompat = unwrap(await p.select({ ...common, initialValue: current, message: '视频输出方式', options: [{ value: 'original' as const, label: '保留原始视频', hint: '逐字节提取' }, { value: 'apple' as const, label: '改善 Apple 兼容性', hint: '安全调整 HEVC 封装，不转码' }] }));
      if (command === 'quick' && options.videoCompat !== current && unwrap(await p.confirm({ ...common, message: '记住这个选择，作为 quick 的默认视频模式？', initialValue: false }))) {
        await saveQuickVideoMode(options.videoCompat);
      }
    }
    if (command === 'extract') {
      options.saveExtra = unwrap(await p.confirm({ ...common, message: '如有 Oplus 附加数据，另存为 .extra.bin？', initialValue: false, active: '是', inactive: '否' }));
      options.dryRun = unwrap(await p.confirm({ ...common, message: '仅预演，查看提取计划？', initialValue: false, active: '是', inactive: '否' }));
    }
    return { command, input, options };
  } catch (e) {
    if (e instanceof Cancelled) { p.cancel('已取消', common); process.exitCode = 130; return undefined; }
    throw e;
  }
}
