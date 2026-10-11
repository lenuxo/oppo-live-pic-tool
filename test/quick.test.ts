import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectFile, planExtraction, executeExtraction } from '../src/index.js';
import { Reader } from '../src/io/reader.js';
function box(type: string, data: Buffer) { const h = Buffer.alloc(8); h.writeUInt32BE(data.length + 8); h.write(type, 4); return Buffer.concat([h, data]); }
const handler = Buffer.alloc(24); handler.write('vide', 8);
const video = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', box('trak', box('mdia', box('hdlr', handler)))), box('mdat', Buffer.alloc(180000, 17))]);
function jpeg(live = true) {
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:c="http://ns.google.com/photos/1.0/camera/" c:MicroVideo="${live ? 1 : 0}" c:MicroVideoOffset="${video.length}"/>`;
  const body = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.from(xml)]), app = Buffer.from([255, 225, 0, 0]); app.writeUInt16BE(body.length + 2, 2);
  const image = Buffer.concat([Buffer.from([255, 216]), app, body, Buffer.from([255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 42, 255, 217])]);
  return live ? Buffer.concat([image, video]) : image;
}
const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { encoding: 'utf8', timeout: 15000 });
async function workspace(t: { after: (f: () => Promise<void>) => void }) { const dir = await mkdtemp(join(tmpdir(), 'oppo-quick-')); t.after(() => rm(dir, { force: true, recursive: true })); return dir; }

test('quick 单文件：仅同目录视频，原图字节不变；重复运行跳过，不覆盖视频', async t => {
  const dir = await workspace(t), input = join(dir, 'live.jpg'), original = jpeg(); await writeFile(input, original);
  const run = cli(['quick', input, '--agent', '--request-id', 'quick-1']); assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout); assert.equal(report.command, 'quick'); assert.equal(report.requestId, 'quick-1');
  assert.equal(report.summary.extracted, 1); assert.equal(report.results[0].code, 'EXTRACTED'); assert.equal(report.results[0].outputsCommitted, true);
  assert.equal(report.results[0].video, join(dir, 'live.mp4')); assert.ok(!('image' in report.results[0])); assert.ok(!('extra' in report.results[0]));
  assert.ok(!('videoCompatibility' in report.results[0]));
  assert.deepEqual(await readdir(dir), ['live.jpg', 'live.mp4']);
  assert.deepEqual(await readFile(input), original); assert.deepEqual(await readFile(join(dir, 'live.mp4')), video);
  await writeFile(join(dir, 'live.mp4'), 'existing');
  const repeated = cli(['quick', input, '--json']); assert.equal(repeated.status, 0);
  const skipped = JSON.parse(repeated.stdout); assert.equal(skipped.command, 'quick'); assert.equal(skipped.summary.skipped, 1); assert.equal(skipped.results[0].code, 'OUTPUT_CONFLICT');
  assert.equal((await readFile(join(dir, 'live.mp4'))).toString(), 'existing'); assert.deepEqual(await readFile(input), original);
});

test('quick 目录：默认当前层级，可递归；报告正确，仅输出原图旁的视频', async t => {
  const dir = await workspace(t); await mkdir(join(dir, 'nested'));
  await writeFile(join(dir, 'same.jpg'), jpeg()); await writeFile(join(dir, 'static.jpg'), jpeg(false)); await writeFile(join(dir, 'nested', 'same.jpg'), jpeg());
  const preview = cli(['quick', dir, '--dry-run', '--agent']); assert.equal(preview.status, 0);
  const planned = JSON.parse(preview.stdout); assert.equal(planned.summary.planned, 1); assert.equal(planned.summary.skipped, 1);
  assert.deepEqual(await readdir(dir), ['nested', 'same.jpg', 'static.jpg']);
  const reportPath = join(dir, 'quick-report.json');
  const run = cli(['quick', dir, '--recursive', '--json', '--report', reportPath]); assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout); assert.equal(report.command, 'quick'); assert.equal(report.summary.extracted, 2); assert.equal(report.summary.skipped, 1);
  assert.deepEqual(JSON.parse((await readFile(reportPath)).toString()), report);
  assert.deepEqual(await readdir(join(dir, 'nested')), ['same.jpg', 'same.mp4']);
  assert.deepEqual(await readFile(join(dir, 'same.jpg')), jpeg()); assert.deepEqual(await readFile(join(dir, 'nested', 'same.jpg')), jpeg());
  assert.ok(report.results.every((r: { image?: string }) => !r.image));
});

test('quick 冲突策略、同批同名、无扩展名、空目录及参数错误', async t => {
  const dir = await workspace(t), file = join(dir, 'photo'); await writeFile(file, jpeg());
  assert.equal(cli(['quick', file]).status, 0); assert.deepEqual(await readFile(join(dir, 'photo.mp4')), video);
  assert.equal(cli(['quick', file, '--on-conflict', 'error']).status, 1);
  assert.equal(cli(['quick', file, '--on-conflict', 'rename']).status, 0); assert.deepEqual(await readFile(join(dir, 'photo-1.mp4')), video);
  await writeFile(join(dir, 'same.jpg'), jpeg()); await writeFile(join(dir, 'same.jpeg'), jpeg());
  const run = cli(['quick', dir, '--agent']); const report = JSON.parse(run.stdout);
  assert.equal(report.summary.extracted, 1); assert.equal(report.summary.skipped, 1);
  const empty = join(dir, 'empty'); await mkdir(empty);
  assert.equal(JSON.parse(cli(['quick', empty, '--agent']).stdout).summary.total, 0);
  for (const args of [['--out', dir], ['--save-extra'], ['--video-compat', 'bad']]) {
    const invalid = cli(['quick', file, '--agent', ...args]); assert.equal(invalid.status, 2); assert.equal(JSON.parse(invalid.stdout).command, 'quick');
  }
  const compat = JSON.parse(cli(['quick', file, '--dry-run', '--on-conflict', 'rename', '--video-compat', 'apple', '--agent']).stdout);
  assert.equal(compat.results[0].videoCompatibility.status, 'unchanged');
  const sourceWithMp4Name = join(dir, 'source.mp4'); await writeFile(sourceWithMp4Name, jpeg());
  assert.equal(cli(['quick', sourceWithMp4Name]).status, 1); assert.deepEqual(await readFile(sourceWithMp4Name), jpeg());
});

test('仅视频提取：取消清理、提交竞争保护原图和其他输出', async t => {
  const dir = await workspace(t), file = join(dir, 'live.jpg'); await writeFile(file, jpeg());
  const controller = new AbortController();
  const plan = await planExtraction(await inspectFile(file), { out: dir, base: dir, videoOnly: true, conflict: 'skip', signal: controller.signal }); assert.ok('inspection' in plan); assert.equal(plan.image, undefined);
  const read = Reader.prototype.read;
  t.mock.method(Reader.prototype, 'read', async function(this: Reader, offset: number, length: number) {
    const data = await read.call(this, offset, length);
    if (length === 65536) controller.abort(new Error('cancel test'));
    return data;
  });
  await assert.rejects(executeExtraction(plan), /cancel test/); assert.deepEqual(await readdir(dir), ['live.jpg']); assert.deepEqual(await readFile(file), jpeg());
  t.mock.restoreAll();
  const raced = await planExtraction(await inspectFile(file), { out: dir, base: dir, videoOnly: true, conflict: 'error' }); assert.ok('inspection' in raced);
  await writeFile(raced.video, 'another process');
  const result = await executeExtraction(raced); assert.equal(result.status, 'failed');
  assert.equal((await readFile(raced.video)).toString(), 'another process'); assert.deepEqual(await readFile(file), jpeg());
  assert.deepEqual(await readdir(dir), ['live.jpg', 'live.mp4']);
});

test('quick 取消的机器响应正确列出未完成文件，并清理视频临时文件', async t => {
  const dir = await workspace(t), file = join(dir, 'live.jpg'); await writeFile(file, jpeg());
  const source = `
    import { Reader } from './src/io/reader.ts';
    const open = Reader.open.bind(Reader); let seen = 0;
    Reader.open = async (...args) => {
      const reader = await open(...args);
      if (args[0] === ${JSON.stringify(file)} && ++seen === 2) {
        const read = reader.read.bind(reader);
        reader.read = async (...range) => { await new Promise(resolve => setTimeout(resolve, 40)); return read(...range); };
        setTimeout(() => process.kill(process.pid, 'SIGINT'), 5);
      }
      return reader;
    };
    process.argv = [process.execPath, 'src/cli.ts', 'quick', ${JSON.stringify(file)}, '--agent'];
    await import('./src/cli.ts');
  `;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 130, run.stderr);
  const data = JSON.parse(run.stdout); assert.equal(data.command, 'quick'); assert.equal(data.status, 'cancelled');
  assert.equal(data.summary.extracted, 0); assert.equal(data.summary.pending, 1); assert.equal(data.results[0].code, 'PENDING');
  assert.deepEqual(await readdir(dir), ['live.jpg']); assert.deepEqual(await readFile(file), jpeg());
});
