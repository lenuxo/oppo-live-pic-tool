import { VERSION } from '../src/version.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { inspectFile, planExtraction, executeExtraction } from '../src/index.js';
import { Reader } from '../src/io/reader.js';
import { parseJpeg } from '../src/formats/jpeg.js';
import { parseXmp } from '../src/formats/xmp.js';
import { patchMpf } from '../src/formats/mpf.js';
import { scanFiles } from '../src/io/scanner.js';
import { spawnSync } from 'node:child_process';
import { fixtures, testWithFixtures } from './fixtures.js';
const standard = Buffer.from('http://ns.adobe.com/xap/1.0/\0');
function box(type: string, content: Buffer) { const h = Buffer.alloc(8); h.writeUInt32BE(content.length + 8); h.write(type, 4, 'ascii'); return Buffer.concat([h, content]); }
function video() {
  const h = Buffer.alloc(24); h.write('vide', 8);
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', box('trak', box('mdia', box('hdlr', h)))), box('mdat', Buffer.from('test video payload'))]);
}
function jpeg(xml = '') {
  let app = Buffer.alloc(0);
  if (xml) { const body = Buffer.concat([standard, Buffer.from(xml)]); const header = Buffer.from([255, 225, 0, 0]); header.writeUInt16BE(body.length + 2, 2); app = Buffer.concat([header, body]); }
  return Buffer.concat([Buffer.from([255, 216]), app, Buffer.from([255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 42, 255, 0, 99, 255, 217])]);
}
function metadata(length: number, prefix = 'i') {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><r:Description xmlns:c="http://ns.google.com/photos/1.0/camera/" xmlns:d="http://ns.google.com/photos/1.0/container/" xmlns:${prefix}="http://ns.google.com/photos/1.0/container/item/" xmlns:dc="http://purl.org/dc/elements/1.1/" c:MotionPhoto="1" dc:title="A &amp; B"><d:Directory><r:Seq><r:li><d:Item ${prefix}:Mime="image/jpeg" ${prefix}:Semantic="Primary"/></r:li><r:li><d:Item ${prefix}:Mime="video/mp4" ${prefix}:Semantic="MotionPhoto" ${prefix}:Length="${length}"/></r:li></r:Seq></d:Directory></r:Description></r:RDF></x:xmpmeta>`;
}
async function workspace(t: { after: (f: () => Promise<void>) => void }) { const dir = await mkdtemp(join(tmpdir(), 'oppo-live-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

testWithFixtures('真实样本：l1/l2 是实况，s1 是普通静态 HDR 图片', async () => {
  const l1 = await inspectFile(join(fixtures, 'l1.jpg'));
  const l2 = await inspectFile(join(fixtures, 'l2.jpg'));
  const s1 = await inspectFile(join(fixtures, 's1.jpg'));
  assert.equal(l1.motion.status, 'valid'); assert.equal(l1.vendor.value, 'oppo');
  assert.equal(l1.motion.video?.length, 4649170);
  assert.equal(l2.motion.status, 'valid'); assert.equal(l2.vendor.value, 'unknown'); assert.equal(l2.profile, 'oplus-v2');
  assert.equal(s1.motion.status, 'absent');
});

testWithFixtures('真实样本拆分：视频字节不变，EXIF 不变，增益图不变，MPF 修正，实况标记清理', async t => {
  const out = await workspace(t);
  for (const name of ['l1', 'l2']) {
    const input = join(fixtures, `${name}.jpg`), original = await readFile(input);
    const inspection = await inspectFile(input);
    const plan = await planExtraction(inspection, { out, base: fixtures, conflict: 'error' });
    assert.ok('inspection' in plan);
    const result = await executeExtraction(plan); assert.equal(result.status, 'extracted');
    assert.deepEqual(await readFile(result.video!), original.subarray(inspection.motion.video!.offset, inspection.motion.video!.offset + inspection.motion.video!.length));
    const r1 = await Reader.open(input), r2 = await Reader.open(result.image!);
    try {
      const a = await parseJpeg(r1), b = await parseJpeg(r2);
      const exif = (j: typeof a) => j.segments.filter(s => s.data.subarray(0, 6).equals(Buffer.from('Exif\0\0'))).map(s => s.data);
      assert.deepEqual(exif(a), exif(b));
      const xmp = parseXmp(b.segments); assert.equal(xmp.hasMotion, false);
      assert.ok(!(await readFile(result.image!)).includes(Buffer.from('OpCamera:VideoLength')));
      let end = b.end;
      if (name === 'l1') {
        assert.deepEqual(await r1.read(a.end, inspection.layout!.imageEnd - a.end), await r2.read(b.end, r2.size - b.end));
        end = (await parseJpeg(r2, b.end)).end;
        assert.equal(xmp.items.length, 2); assert.equal(xmp.items[1]?.Semantic, 'GainMap');
      }
      assert.equal(end, r2.size);
      // Revalidates MP Index offsets against the final image, including metadata shrinkage.
      assert.doesNotThrow(() => patchMpf(b.segments, b.end, r2.size, []));
    } finally { await r1.close(); await r2.close(); }
    assert.equal((await inspectFile(result.image!)).motion.status, 'absent');
    assert.deepEqual(await readFile(input), original);
  }
});

testWithFixtures('预演不创建输出；冲突默认报错；skip/rename 成对处理', async t => {
  const dir = await workspace(t), out = join(dir, 'out');
  const i = await inspectFile(join(fixtures, 'l2.jpg'));
  const options = { out, base: fixtures, conflict: 'error' as const };
  const dry = await planExtraction(i, { ...options, dryRun: true }); assert.ok('inspection' in dry);
  assert.equal((await executeExtraction(dry)).status, 'planned'); assert.deepEqual(await readdir(dir), []);
  await mkdir(out); await writeFile(join(out, 'l2.mp4'), 'existing');
  const conflict = await planExtraction(i, options); assert.ok('status' in conflict); assert.equal(conflict.status, 'failed');
  const skipped = await planExtraction(i, { ...options, conflict: 'skip' }); assert.ok('status' in skipped); assert.equal(skipped.status, 'skipped');
  const renamed = await planExtraction(i, { ...options, conflict: 'rename' }); assert.ok('inspection' in renamed);
  assert.equal(renamed.image, join(out, 'l2-1.jpg')); assert.equal(renamed.video, join(out, 'l2-1.mp4'));
  assert.equal((await executeExtraction(renamed)).status, 'extracted'); assert.equal((await readFile(join(out, 'l2.mp4'))).toString(), 'existing');
});

testWithFixtures('同批同名输出保留成对编号，包括 dry-run', async t => {
  const out = await workspace(t), i = await inspectFile(join(fixtures, 'l2.jpg')), reserved = new Set<string>();
  const options = { out, base: fixtures, conflict: 'rename' as const, dryRun: true };
  const a = await planExtraction(i, options, reserved), b = await planExtraction(i, options, reserved);
  assert.ok('inspection' in a && 'inspection' in b); assert.notEqual(a.image, b.image);
});

test('未知厂商默认可提取；XML 前缀变化、转义文本正常处理', async t => {
  const dir = await workspace(t), input = join(dir, 'live.jpg'), v = video();
  await writeFile(input, Buffer.concat([jpeg(metadata(v.length, 'Different')), v]));
  const i = await inspectFile(input); assert.equal(i.motion.status, 'valid');
  const options = { out: join(dir, 'out'), base: dir, conflict: 'error' as const };
  const plan = await planExtraction(i, options); assert.ok('inspection' in plan);
  const r = await executeExtraction(plan); assert.equal(r.status, 'extracted');
  assert.ok((await readFile(r.image!)).includes(Buffer.from('dc:title="A &amp; B"')));
});

test('ftyp 伪阳性不认定为 MP4；恢复搜索跨块边界且包含 box 长度', async t => {
  const dir = await workspace(t), fake = join(dir, 'fake.jpg');
  await writeFile(fake, Buffer.concat([jpeg(), Buffer.from('garbageftypisom')]));
  assert.equal((await inspectFile(fake, { recover: true })).motion.status, 'absent');
  const input = join(dir, 'recover.jpg'), v = video(), j = jpeg();
  await writeFile(input, Buffer.concat([j, Buffer.alloc(65530), v]));
  assert.equal((await inspectFile(input)).motion.status, 'absent');
  const i = await inspectFile(input, { recover: true }); assert.equal(i.motion.status, 'valid');
  assert.equal(i.motion.method, 'recovery-scan'); assert.equal(i.motion.video?.offset, j.length + 65530);
});

test('错误 XMP 长度默认失败，显式 recover 可恢复；截断视频失败', async t => {
  const dir = await workspace(t), input = join(dir, 'wrong.jpg'), v = video();
  await writeFile(input, Buffer.concat([jpeg(metadata(v.length + 1)), v]));
  assert.equal((await inspectFile(input)).motion.status, 'invalid');
  assert.equal((await inspectFile(input, { recover: true })).motion.status, 'valid');
  await writeFile(input, Buffer.concat([jpeg(metadata(v.length)), v.subarray(0, -1)]));
  assert.equal((await inspectFile(input)).motion.status, 'invalid');
});

test('源文件变化拒绝写入；提交冲突回滚已发布图片', async t => {
  const dir = await workspace(t), input = join(dir, 'live.jpg'), v = video();
  await writeFile(input, Buffer.concat([jpeg(metadata(v.length)), v]));
  const options = { out: join(dir, 'out'), base: dir, conflict: 'error' as const, allowUnknownVendor: true };
  const a = await planExtraction(await inspectFile(input), options); assert.ok('inspection' in a);
  await writeFile(input, Buffer.concat([jpeg(metadata(v.length)), v, Buffer.from('changed')]));
  const changed = await executeExtraction(a); assert.equal(changed.status, 'failed'); assert.equal(changed.code, 'SOURCE_CHANGED');
  await writeFile(input, Buffer.concat([jpeg(metadata(v.length)), v]));
  const b = await planExtraction(await inspectFile(input), options); assert.ok('inspection' in b);
  await mkdir(options.out); await writeFile(b.video, 'existing');
  assert.equal((await executeExtraction(b)).status, 'failed');
  assert.deepEqual(await readdir(options.out), ['live.mp4']);
  assert.equal((await readFile(b.video)).toString(), 'existing');
});

test('扫描排除输出目录，不跟随符号链接，递归保持层级', async t => {
  const dir = await workspace(t); await mkdir(join(dir, 'nested')); await mkdir(join(dir, 'out'));
  await writeFile(join(dir, 'one.JPG'), 'x'); await writeFile(join(dir, 'nested', 'two.jpg'), 'x'); await writeFile(join(dir, 'out', 'old.jpg'), 'x');
  await symlink(join(dir, 'nested'), join(dir, 'linked'));
  assert.equal((await scanFiles(dir, { exclude: join(dir, 'out') })).files.length, 1);
  assert.equal((await scanFiles(dir, { recursive: true, exclude: join(dir, 'out') })).files.length, 2);
});

testWithFixtures('取消提取不留下临时文件', async t => {
  const dir = await workspace(t), controller = new AbortController();
  const p = await planExtraction(await inspectFile(join(fixtures, 'l2.jpg')), { out: dir, base: fixtures, conflict: 'error', signal: controller.signal });
  assert.ok('inspection' in p); controller.abort();
  await assert.rejects(() => executeExtraction(p)); assert.deepEqual(await readdir(dir), []);
});

testWithFixtures('CLI：真实目录 JSON 报告、dry-run、参数错误、帮助', async t => {
  const out = await workspace(t);
  const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { encoding: 'utf8' });
  const inspect = cli(['inspect', fixtures, '--json']); assert.equal(inspect.status, 0, inspect.stderr);
  const data = JSON.parse(inspect.stdout); assert.equal(data.results.filter((r: { motion: { status: string } }) => r.motion.status === 'valid').length, 2);
  assert.ok(!inspect.stdout.includes('fingerprint')); assert.ok(!inspect.stdout.includes('\x1b'));
  const dry = cli(['extract', fixtures, '--out', out, '--dry-run', '--json']); assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).summary.planned, 2); assert.deepEqual(await readdir(out), []);
  const extract = cli(['extract', fixtures, '--out', out, '--json']); assert.equal(extract.status, 0, extract.stderr);
  assert.deepEqual(JSON.parse(extract.stdout).summary, { extracted: 2, planned: 0, skipped: 1, failed: 0 });
  const invalid = cli(['inspect', fixtures, '--jobs', '0', '--json']);
  assert.equal(invalid.status, 2); assert.equal(JSON.parse(invalid.stdout).error.code, 'commander.invalidArgument');
  assert.equal(cli(['--help']).status, 0);
});

testWithFixtures('正在写入时取消，清理已创建的临时文件', async t => {
  const out = await workspace(t), controller = new AbortController();
  const plan = await planExtraction(await inspectFile(join(fixtures, 'l1.jpg')), { out, base: fixtures, conflict: 'error', signal: controller.signal });
  assert.ok('inspection' in plan);
  const originalRead = Reader.prototype.read;
  let reads = 0;
  t.mock.method(Reader.prototype, 'read', async function (this: Reader, offset: number, length: number) {
    const bytes = await originalRead.call(this, offset, length);
    if (++reads === 2) controller.abort(new Error('test cancellation'));
    return bytes;
  });
  await assert.rejects(() => executeExtraction(plan));
  assert.ok(controller.signal.aborted);
  assert.deepEqual(await readdir(out), []);
});

testWithFixtures('另存附加数据：真实 l1 尾部逐字节一致，三份输出共享冲突编号', async t => {
  const out = await workspace(t), inspection = await inspectFile(join(fixtures, 'l1.jpg'));
  assert.equal(inspection.motion.extra?.length, 2106537);
  await writeFile(join(out, 'l1.extra.bin'), 'existing');
  const plan = await planExtraction(inspection, { out, base: fixtures, conflict: 'rename', saveExtra: true });
  assert.ok('inspection' in plan); assert.equal(plan.extra, join(out, 'l1-1.extra.bin'));
  assert.equal(plan.image, join(out, 'l1-1.jpg')); assert.equal(plan.video, join(out, 'l1-1.mp4'));
  const result = await executeExtraction(plan); assert.equal(result.status, 'extracted');
  const original = await readFile(inspection.input), extra = inspection.motion.extra!;
  assert.deepEqual(await readFile(result.extra!), original.subarray(extra.offset, extra.offset + extra.length));
  assert.equal((await readFile(join(out, 'l1.extra.bin'))).toString(), 'existing');
});

testWithFixtures('外置盘回退：硬链接不可用时独占复制，仍不覆盖已有文件', async t => {
  const fs = (await import('node:fs')).promises;
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); });
  const out = await workspace(t), inspection = await inspectFile(join(fixtures, 'l2.jpg'));
  const plan = await planExtraction(inspection, { out, base: fixtures, conflict: 'error' }); assert.ok('inspection' in plan);
  const result = await executeExtraction(plan); assert.equal(result.status, 'extracted'); assert.ok(result.warnings?.length);
  const original = await readFile(inspection.input), range = inspection.motion.video!;
  assert.deepEqual(await readFile(result.video!), original.subarray(range.offset, range.offset + range.length));
  const options = { out: join(out, 'race'), base: fixtures, conflict: 'error' as const };
  const race = await planExtraction(inspection, options); assert.ok('inspection' in race);
  await mkdir(options.out); await writeFile(race.video, 'existing');
  assert.equal((await executeExtraction(race)).status, 'failed');
  assert.deepEqual(await readdir(options.out), ['l2.mp4']);
  assert.equal((await readFile(race.video)).toString(), 'existing');
});

testWithFixtures('复制回退取消：删除已经部分提交的输出', async t => {
  const fs = (await import('node:fs')).promises;
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('unsupported'), { code: 'EPERM' }); });
  const out = await workspace(t), controller = new AbortController();
  const plan = await planExtraction(await inspectFile(join(fixtures, 'l2.jpg')), { out, base: fixtures, conflict: 'error', signal: controller.signal }); assert.ok('inspection' in plan);
  const originalCreate = (await import('../src/io/writer.js')).OutputTransaction.prototype.create;
  const { OutputTransaction } = await import('../src/io/writer.js');
  t.mock.method(OutputTransaction.prototype, 'create', async function (this: InstanceType<typeof OutputTransaction>, path: string, kind?: 'temporary' | 'output') {
    const handle = await originalCreate.call(this, path, kind);
    if (kind === 'output') controller.abort();
    return handle;
  });
  await assert.rejects(() => executeExtraction(plan)); assert.deepEqual(await readdir(out), []);
});

testWithFixtures('临时清理失败不会掩盖结果，继续清理其他文件，报告残留路径', async t => {
  const fs = (await import('node:fs')).promises, originalUnlink = fs.unlink;
  let rejected = false;
  t.mock.method(fs, 'unlink', async path => {
    if (!rejected && String(path).endsWith('.tmp')) { rejected = true; throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' }); }
    return originalUnlink(path);
  });
  const out = await workspace(t), plan = await planExtraction(await inspectFile(join(fixtures, 'l2.jpg')), { out, base: fixtures, conflict: 'error' }); assert.ok('inspection' in plan);
  const result = await executeExtraction(plan);
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'CLEANUP_FAILED'); assert.equal(result.outputsCommitted, true);
  assert.equal(result.cleanupIssues?.length, 1);
  assert.equal((await readdir(out)).filter(n => n.endsWith('.tmp')).length, 1);
  assert.ok((await readdir(out)).includes('l2.jpg')); assert.ok((await readdir(out)).includes('l2.mp4'));
});

test('清理不删除被其他文件替换的输出路径', async t => {
  const { OutputTransaction } = await import('../src/io/writer.js');
  const out = await workspace(t), temp = join(out, 'temp'), dest = join(out, 'dest');
  const tx = new OutputTransaction(); const handle = await tx.create(temp); await handle.writeFile('ours'); await handle.close();
  await tx.publish(temp, dest);
  await rm(dest); await writeFile(dest, 'replacement');
  const issues = await tx.cleanup(true); assert.equal(issues.length, 1);
  assert.equal((await readFile(dest)).toString(), 'replacement');
});

testWithFixtures('无扩展名单文件正确生成输出，路径仍位于指定目录', async t => {
  const dir = await workspace(t), input = join(dir, 'photo');
  await writeFile(input, await readFile(join(fixtures, 'l2.jpg')));
  const plan = await planExtraction(await inspectFile(input), { out: join(dir, 'out'), base: dir, conflict: 'error' }); assert.ok('inspection' in plan);
  assert.equal(plan.image, join(dir, 'out', 'photo.jpg')); assert.equal(plan.video, join(dir, 'out', 'photo.mp4'));
  assert.equal((await executeExtraction(plan)).status, 'extracted');
});

test('伪 JPEG 缺少 SOF 或扫描组件不匹配时拒绝', async t => {
  const dir = await workspace(t), input = join(dir, 'bad.jpg');
  await writeFile(input, Buffer.from([255, 216, 255, 218, 0, 2, 42, 255, 217]));
  assert.equal((await inspectFile(input)).motion.status, 'invalid');
  const broken = jpeg(); broken[20] = 2;
  await writeFile(input, broken); assert.equal((await inspectFile(input)).motion.status, 'invalid');
});

test('XMP 元素形式 Oplus 字段与属性形式一致；静态 MotionPhoto=0 不误报', async t => {
  const dir = await workspace(t), input = join(dir, 'elements.jpg'), v = video();
  const xml = metadata(v.length).replace('c:MotionPhoto="1"', 'xmlns:o="http://ns.oplus.com/photos/1.0/camera/"').replace('<d:Directory>', '<c:MotionPhoto>1</c:MotionPhoto><o:OLivePhotoVersion>2</o:OLivePhotoVersion><o:VideoLength>' + v.length + '</o:VideoLength><o:MotionPhotoOwner>VESDK</o:MotionPhotoOwner><d:Directory>');
  await writeFile(input, Buffer.concat([jpeg(xml), v]));
  const i = await inspectFile(input); assert.equal(i.motion.status, 'valid'); assert.equal(i.profile, 'oplus-v2');
  const plan = await planExtraction(i, { out: join(dir, 'out'), base: dir, conflict: 'error' }); assert.ok('inspection' in plan);
  assert.equal((await executeExtraction(plan)).status, 'extracted');
  const cleaned = (await readFile(plan.image)).toString('utf8'); assert.ok(!cleaned.includes('<o:VideoLength>'));
  await writeFile(input, jpeg('<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:c="http://ns.google.com/photos/1.0/camera/" c:MotionPhoto="0"/>'));
  assert.equal((await inspectFile(input)).motion.status, 'absent');
});

testWithFixtures('真实 HDR 输出的 RDF 目录不包含空视频条目', async t => {
  const out = await workspace(t), plan = await planExtraction(await inspectFile(join(fixtures, 'l1.jpg')), { out, base: fixtures, conflict: 'error' }); assert.ok('inspection' in plan);
  assert.equal((await executeExtraction(plan)).status, 'extracted');
  const r = await Reader.open(plan.image);
  try {
    const j = await parseJpeg(r), segment = j.segments.find(s => s.data.subarray(0, standard.length).equals(standard)); assert.ok(segment);
    const xml = segment.data.subarray(standard.length).toString('utf8');
    assert.equal((xml.match(/<rdf:li\b/g) ?? []).length, 2); assert.ok(!xml.includes('video/mp4'));
  } finally { await r.close(); }
});

testWithFixtures('报告保存与 CLI：版本化 JSON、附加数据、dry-run 不写报告、已有报告不覆盖', async t => {
  const dir = await workspace(t), report = join(dir, 'report.json'), out = join(dir, 'out');
  const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { encoding: 'utf8' });
  const dry = cli(['extract', fixtures, '--out', out, '--save-extra', '--report', report, '--dry-run', '--json']); assert.equal(dry.status, 0, dry.stderr);
  const preview = JSON.parse(dry.stdout); assert.equal(preview.reportFile.status, 'planned'); assert.deepEqual(await readdir(dir), []);
  assert.ok(preview.results.find((r: { extra?: string }) => r.extra));
  const run = cli(['extract', fixtures, '--out', out, '--save-extra', '--report', report, '--json']); assert.equal(run.status, 0, run.stderr);
  const data = JSON.parse(run.stdout); assert.equal(data.schemaVersion, 1); assert.equal(data.tool.version, VERSION);
  assert.deepEqual(JSON.parse((await readFile(report)).toString()), data); assert.equal(data.summary.extracted, 2);
  assert.ok((await readdir(out)).includes('l1.extra.bin'));
  const second = cli(['inspect', fixtures, '--report', report, '--json']); assert.equal(second.status, 1); assert.equal(JSON.parse(second.stdout).error.code, 'REPORT_CONFLICT');
  assert.deepEqual(JSON.parse((await readFile(report)).toString()), data);
  const secondOut = join(dir, 'second');
  const failed = cli(['extract', fixtures, '--out', secondOut, '--report', join(secondOut, 'l1.jpg', 'report.json'), '--json']);
  assert.equal(failed.status, 1);
  const failureReport = JSON.parse(failed.stdout);
  assert.equal(failureReport.summary.extracted, 2);
  assert.equal(failureReport.error.code, 'REPORT_WRITE_ERROR');
  assert.equal(failureReport.reportFile.status, 'failed');
  assert.ok((await readdir(secondOut)).includes('l2.mp4'));
});

testWithFixtures('复制回退中途写入失败，回滚全部新文件且保留原错误', async t => {
  const fs = (await import('node:fs')).promises;
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOSYS' }); });
  const { OutputTransaction } = await import('../src/io/writer.js');
  const originalCreate = OutputTransaction.prototype.create;
  t.mock.method(OutputTransaction.prototype, 'create', async function (this: InstanceType<typeof OutputTransaction>, path: string, kind?: 'temporary' | 'output') {
    const handle = await originalCreate.call(this, path, kind);
    if (kind === 'output' && path.endsWith('.mp4')) {
      let writes = 0; const originalWrite = handle.write.bind(handle);
      t.mock.method(handle, 'write', async (...args: Parameters<typeof handle.write>) => {
        if (++writes === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return originalWrite(...args);
      });
    }
    return handle;
  });
  const out = await workspace(t), plan = await planExtraction(await inspectFile(join(fixtures, 'l2.jpg')), { out, base: fixtures, conflict: 'error' }); assert.ok('inspection' in plan);
  const result = await executeExtraction(plan); assert.equal(result.status, 'failed'); assert.equal(result.code, 'ENOSPC');
  assert.deepEqual(await readdir(out), []);
});

testWithFixtures('单文件规划错误作为批量结果报告，不中止整批任务', async t => {
  const dir = await workspace(t), source = join(dir, 'source'), out = join(dir, 'out');
  await mkdir(join(source, 'nested'), { recursive: true }); await mkdir(out);
  await writeFile(join(source, 'l1.jpg'), await readFile(join(fixtures, 'l1.jpg')));
  await writeFile(join(source, 's1.jpg'), await readFile(join(fixtures, 's1.jpg')));
  await writeFile(join(source, 'nested', 'l2.jpg'), await readFile(join(fixtures, 'l2.jpg')));
  await writeFile(join(out, 'nested'), 'not a directory');
  const cli = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'extract', source, '-r', '--out', out, '--json'], { encoding: 'utf8' });
  const report = JSON.parse(cli.stdout); assert.equal(cli.status, 1);
  assert.deepEqual(report.summary, { extracted: 1, planned: 0, skipped: 1, failed: 1 });
  assert.equal(report.results.find((r: { status: string }) => r.status === 'failed').code, 'ENOTDIR');
  assert.ok((await readdir(out)).includes('l1.mp4'));
});

testWithFixtures('长文件名使用短临时名称，不因追加随机后缀而超出单文件名长度', async t => {
  const dir = await workspace(t), input = join(dir, `${'x'.repeat(240)}.jpg`);
  await writeFile(input, await readFile(join(fixtures, 'l2.jpg')));
  const plan = await planExtraction(await inspectFile(input), { out: join(dir, 'out'), base: dir, conflict: 'error' }); assert.ok('inspection' in plan);
  assert.equal((await executeExtraction(plan)).status, 'extracted');
  assert.equal((await readdir(join(dir, 'out'))).length, 2);
});

test('旧版 MicroVideoOffset：属性/元素写法、填充、无损提取与 AI 响应', async t => {
  const dir = await workspace(t), v = video();
  for (const elements of [false, true]) {
    const fields = elements ? `<c:MicroVideo>1</c:MicroVideo><c:MicroVideoOffset>${v.length}</c:MicroVideoOffset>` : '';
    const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:c="http://ns.google.com/photos/1.0/camera/" ${elements ? '' : `c:MicroVideo="1" c:MicroVideoOffset="${v.length}"`}>${fields}</x:xmpmeta>`;
    const input = join(dir, `legacy-${elements}.jpg`), image = jpeg(xml);
    await writeFile(input, Buffer.concat([image, Buffer.alloc(17), v]));
    const i = await inspectFile(input);
    assert.equal(i.motion.status, 'valid'); assert.equal(i.motion.method, 'microvideo-offset');
    assert.equal(i.motion.video?.offset, image.length + 17);
    const plan = await planExtraction(i, { out: join(dir, 'out'), base: dir, conflict: 'error' }); assert.ok('inspection' in plan);
    const result = await executeExtraction(plan); assert.equal(result.status, 'extracted');
    assert.deepEqual(await readFile(result.video!), v);
    const still = await inspectFile(result.image!); assert.equal(still.motion.status, 'absent');
    assert.ok(!(await readFile(result.image!)).includes(Buffer.from('MicroVideo')));
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'extract', input, '--agent', '--dry-run', '--out', join(dir, 'preview')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr); const response = JSON.parse(run.stdout);
    assert.equal(response.results[0].code, 'PLANNED'); assert.equal(response.summary.planned, 1);
    assert.equal(response.results[0].inspection.motion.method, 'microvideo-offset');
  }
});

test('主图填充正确定位视频，静态输出不含填充；标准目录优先于旧版偏移', async t => {
  const dir = await workspace(t), v = video(), input = join(dir, 'padded.jpg');
  const xml = metadata(v.length).replace('c:MotionPhoto="1"', 'c:MotionPhoto="1" c:MicroVideo="1" c:MicroVideoOffset="not-a-number"').replace('i:Semantic="Primary"', 'i:Semantic="Primary" i:Padding="23"');
  const image = jpeg(xml);
  await writeFile(input, Buffer.concat([image, Buffer.alloc(23, 0x67), v]));
  const i = await inspectFile(input); assert.equal(i.motion.status, 'valid'); assert.equal(i.motion.method, 'xmp-directory');
  assert.equal(i.motion.video?.offset, image.length + 23);
  // Origin evidence is informational, including a known non-OPPO origin.
  i.vendor = { value: 'other', evidence: ['EXIF Make: another vendor'] };
  const plan = await planExtraction(i, { out: join(dir, 'out'), base: dir, conflict: 'error' }); assert.ok('inspection' in plan);
  const result = await executeExtraction(plan); assert.equal(result.status, 'extracted');
  assert.deepEqual(await readFile(result.video!), v);
  const r = await Reader.open(result.image!);
  try { assert.equal((await parseJpeg(r)).end, r.size); } finally { await r.close(); }
  assert.equal((await inspectFile(result.image!)).motion.status, 'absent');
  assert.ok(!(await readFile(result.image!)).includes(Buffer.from('Padding')));
});

test('旧版偏移拒绝越界/无效值/伪视频；静态开关和显式恢复', async t => {
  const dir = await workspace(t), input = join(dir, 'bad-offset.jpg'), v = video();
  const xml = (offset: string, flag = '1') => `<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:c="http://ns.google.com/photos/1.0/camera/" c:MicroVideo="${flag}" c:MicroVideoOffset="${offset}"/>`;
  for (const offset of ['0', '-1', '1.5', '9007199254740992', '999999', String(v.length + 1)]) {
    await writeFile(input, Buffer.concat([jpeg(xml(offset)), v]));
    assert.equal((await inspectFile(input)).motion.status, 'invalid', offset);
  }
  const fake = Buffer.from('garbageftypisom');
  await writeFile(input, Buffer.concat([jpeg(xml(String(fake.length))), fake]));
  assert.equal((await inspectFile(input)).motion.status, 'invalid');
  await writeFile(input, Buffer.concat([jpeg(xml(String(v.length), '0')), v]));
  assert.equal((await inspectFile(input)).motion.status, 'absent');
  await writeFile(input, Buffer.concat([jpeg(xml('999999')), v]));
  assert.equal((await inspectFile(input, { recover: true })).motion.method, 'recovery-scan');
  await writeFile(input, Buffer.concat([jpeg(xml(String(v.length))), v.subarray(0, -1)]));
  assert.equal((await inspectFile(input)).motion.status, 'invalid');
});

test('容器填充拒绝越界及次级填充；旧版偏移重复冲突不猜测', async t => {
  const dir = await workspace(t), input = join(dir, 'invalid-padding.jpg'), v = video();
  for (const xml of [
    metadata(v.length).replace('i:Semantic="Primary"', 'i:Semantic="Primary" i:Padding="999999"'),
    metadata(v.length).replace('i:Semantic="MotionPhoto"', 'i:Semantic="MotionPhoto" i:Padding="1"'),
    `<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:c="http://ns.google.com/photos/1.0/camera/" c:MicroVideo="1" c:MicroVideoOffset="${v.length}"><c:MicroVideoOffset>1</c:MicroVideoOffset></x:xmpmeta>`,
  ]) {
    await writeFile(input, Buffer.concat([jpeg(xml), v]));
    assert.notEqual((await inspectFile(input)).motion.status, 'valid');
  }
});
