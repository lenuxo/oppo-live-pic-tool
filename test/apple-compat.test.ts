import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Reader } from '../src/io/reader.js';
import { planAppleCompatibility } from '../src/formats/apple-compat.js';
import { inspectFile, planExtraction, executeExtraction } from '../src/index.js';
import { fixtures, testWithFixtures } from './fixtures.js';
function box(type: string, ...data: Buffer[]) {
  const payload = Buffer.concat(data), header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8); header.write(type, 4);
  return Buffer.concat([header, payload]);
}
function u32(...values: number[]) { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32BE(v, i * 4)); return b; }
function nal(type: number) { return Buffer.from([type << 1, 1, 123]); }
function movie(options: { missing?: boolean; inBand?: boolean; co64?: boolean; badOffset?: boolean; truncatedNal?: boolean; fragmented?: boolean; tag?: string; malformedConfig?: boolean } = {}) {
  const config = Buffer.alloc(23); config[0] = 1; config[21] = 3; config[22] = options.missing ? 2 : 3;
  const arrays = [32, 33, 34].slice(0, config[22]).map(type => {
    const n = nal(type), h = Buffer.from([type, 0, 1, 0, n.length]);
    return Buffer.concat([h, n]);
  });
  const hvcc = Buffer.concat([config, ...arrays]);
  if (options.malformedConfig) hvcc[26] = 255;
  const visual = Buffer.alloc(78); visual.writeUInt16BE(1, 6);
  const sample = Buffer.concat([u32(options.truncatedNal ? 999 : 3), nal(options.inBand ? 32 : 1)]);
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isom'));
  const offset = options.badOffset ? 1 : ftyp.length + 8;
  const offsets = options.co64 ? Buffer.alloc(8) : u32(offset);
  if (options.co64) offsets.writeBigUInt64BE(BigInt(offset));
  const stbl = box('stbl',
    box('stsd', u32(0, 1), box(options.tag ?? 'hev1', visual, box('hvcC', hvcc))),
    box('stsz', u32(0, 0, 1, sample.length)),
    box('stsc', u32(0, 1, 1, 1, 1)),
    box(options.co64 ? 'co64' : 'stco', u32(0, 1), offsets));
  const handler = Buffer.alloc(24); handler.write('vide', 8);
  const moov = box('moov', box('trak', box('mdia', box('hdlr', handler), box('minf', stbl))));
  return Buffer.concat([ftyp, box('mdat', sample), moov, ...(options.fragmented ? [box('moof')] : [])]);
}
async function workspace(t: { after: (f: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'oppo-compat-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
test('安全调整 hev1：检查全部样本、补齐配置完整标记，仅修改封装；支持 co64 和嵌入范围', async t => {
  const dir = await workspace(t);
  for (const co64 of [false, true]) {
    const data = movie({ co64 }), input = join(dir, `test-${co64}.bin`), offset = 19;
    await writeFile(input, Buffer.concat([Buffer.alloc(offset), data, Buffer.alloc(7)]));
    const r = await Reader.open(input);
    try {
      const result = await planAppleCompatibility(r, { offset, length: data.length });
      assert.equal(result.compatibility.status, 'adjusted'); assert.equal(result.compatibility.code, 'APPLE_HVC1');
      const output = Buffer.from(data);
      for (const patch of result.patches) {
        assert.equal(patch.length, patch.bytes.length);
        patch.bytes.copy(output, patch.offset - offset);
      }
      assert.ok(output.includes(Buffer.from('hvc1'))); assert.ok(!output.includes(Buffer.from('hev1')));
      const payload = data.indexOf('mdat') + 4;
      assert.deepEqual(output.subarray(payload, payload + 7), data.subarray(payload, payload + 7));
    } finally { await r.close(); }
  }
});
test('不安全布局保留原视频：缺失参数集、样本内参数集、越界、损坏 NAL、分片', async t => {
  const dir = await workspace(t), input = join(dir, 'test.mp4');
  for (const options of [{ missing: true }, { inBand: true }, { badOffset: true }, { truncatedNal: true }, { fragmented: true }, { malformedConfig: true }]) {
    const data = movie(options); await writeFile(input, data);
    const r = await Reader.open(input);
    try {
      const result = await planAppleCompatibility(r, { offset: 0, length: data.length });
      assert.equal(result.compatibility.code, 'APPLE_COMPAT_UNAVAILABLE', JSON.stringify(options));
      assert.equal(result.compatibility.status, 'unchanged'); assert.deepEqual(result.patches, []);
    } finally { await r.close(); }
    assert.deepEqual(await readFile(input), data);
  }
});
test('已有 hvc1 和其他编码不修改；兼容检查可取消', async t => {
  const dir = await workspace(t), input = join(dir, 'test.mp4');
  for (const [tag, code] of [['hvc1', 'ALREADY_HVC1'], ['avc1', 'NOT_HEVC']]) {
    const data = movie({ tag }); await writeFile(input, data);
    const r = await Reader.open(input);
    try { const result = await planAppleCompatibility(r, { offset: 0, length: data.length }); assert.equal(result.compatibility.code, code); assert.deepEqual(result.patches, []); }
    finally { await r.close(); }
  }
  const controller = new AbortController();
  const r = await Reader.open(input, controller.signal); controller.abort(new Error('test cancel'));
  try { await assert.rejects(planAppleCompatibility(r, { offset: 0, length: r.size }), /test cancel/); } finally { await r.close(); }
});
testWithFixtures('真实样本兼容导出：默认视频字节不变，apple 仅修改配置，预演不写文件', async t => {
  const dir = await workspace(t);
  for (const name of ['l1', 'l2']) {
    const i = await inspectFile(join(fixtures, `${name}.jpg`));
    const src = await readFile(i.input), range = i.motion.video!, original = src.subarray(range.offset, range.offset + range.length);
    const options = { out: join(dir, 'out'), base: fixtures, conflict: 'rename' as const };
    const defaultPlan = await planExtraction(i, options); assert.ok('inspection' in defaultPlan);
    assert.equal(defaultPlan.videoCompatibility, undefined);
    const untouched = await executeExtraction(defaultPlan); assert.deepEqual(await readFile(untouched.video!), original);
    const dry = await planExtraction(i, { ...options, out: join(dir, 'preview'), videoCompat: 'apple', dryRun: true }); assert.ok('inspection' in dry);
    assert.equal(dry.videoCompatibility?.status, name === 'l1' ? 'unchanged' : 'planned');
    assert.equal((await executeExtraction(dry)).status, 'planned');
    assert.ok(!(await readdir(dir)).includes('preview'));
    const plan = await planExtraction(i, { ...options, videoCompat: 'apple' }); assert.ok('inspection' in plan);
    const result = await executeExtraction(plan); assert.equal(result.status, 'extracted');
    assert.equal(result.videoCompatibility?.status, name === 'l1' ? 'unchanged' : 'adjusted');
    const output = await readFile(result.video!);
    const expected = Buffer.from(original);
    for (const patch of plan.videoPatches ?? []) patch.bytes.copy(expected, patch.offset - range.offset);
    assert.deepEqual(output, expected);
    assert.deepEqual(await readFile(result.image!), await readFile(untouched.image!));
    assert.deepEqual(await readFile(i.input), src);
  }
});
testWithFixtures('AI 兼容模式返回结构化结果且不泄漏内部补丁；选项值校验', async t => {
  const dir = await workspace(t);
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { encoding: 'utf8' });
  const result = run(['extract', join(fixtures, 'l2.jpg'), '--video-compat', 'apple', '--agent', '--dry-run', '--out', dir]);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout); assert.equal(data.results[0].videoCompatibility.status, 'planned');
  assert.equal(data.results[0].videoCompatibility.code, 'APPLE_HVC1'); assert.ok(!result.stdout.includes('videoPatches'));
  const invalid = run(['extract', join(fixtures, 'l2.jpg'), '--video-compat', 'transcode', '--agent']);
  assert.equal(invalid.status, 2); assert.equal(JSON.parse(invalid.stdout).error.code, 'INVALID_ARGUMENT');
});

test('兼容调整不可用时仍成功提取原视频并返回结构化原因', async t => {
  const dir = await workspace(t), input = join(dir, 'in-band.jpg'), video = movie({ inBand: true });
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:c="http://ns.google.com/photos/1.0/camera/" c:MicroVideo="1" c:MicroVideoOffset="${video.length}"/>`;
  const body = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.from(xml)]);
  const app = Buffer.from([255, 225, 0, 0]); app.writeUInt16BE(body.length + 2, 2);
  const jpeg = Buffer.concat([Buffer.from([255, 216]), app, body, Buffer.from([255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 42, 255, 217])]);
  await writeFile(input, Buffer.concat([jpeg, video]));
  const plan = await planExtraction(await inspectFile(input), { out: join(dir, 'out'), base: dir, conflict: 'error', videoCompat: 'apple' });
  assert.ok('inspection' in plan);
  const result = await executeExtraction(plan); assert.equal(result.status, 'extracted');
  assert.equal(result.videoCompatibility?.code, 'APPLE_COMPAT_UNAVAILABLE');
  assert.equal(result.videoCompatibility?.status, 'unchanged');
  assert.match(result.videoCompatibility!.reason, /参数集/);
  assert.deepEqual(await readFile(result.video!), video);
});
