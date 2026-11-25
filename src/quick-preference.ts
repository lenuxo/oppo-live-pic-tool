import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { temporaryPath } from './io/writer.js';
import { PhotoError } from './core/types.js';

export type VideoMode = 'original' | 'apple';

function preferencePath() {
  const configHome = process.env.XDG_CONFIG_HOME;
  const root = configHome && isAbsolute(configHome) ? configHome
    : process.platform === 'win32' && process.env.APPDATA ? process.env.APPDATA : join(homedir(), '.config');
  return join(root, 'oppo-live', 'quick-video-compat');
}

export async function readQuickVideoMode(): Promise<VideoMode> {
  const path = preferencePath();
  let value: string;
  try { value = (await readFile(path, 'utf8')).trim(); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'original'; throw e; }
  if (value === 'original' || value === 'apple') return value;
  throw new PhotoError('INVALID_PREFERENCE', `视频偏好无效，请在 ${path} 中填写 original 或 apple`);
}

export async function saveQuickVideoMode(mode: VideoMode) {
  const path = preferencePath();
  await mkdir(dirname(path), { recursive: true });
  const temp = temporaryPath(path);
  const file = await open(temp, 'wx', 0o600);
  try {
    try { await file.writeFile(mode + '\n'); } finally { await file.close(); }
    await rename(temp, path);
  } catch (e) { await rm(temp, { force: true }); throw e; }
}
