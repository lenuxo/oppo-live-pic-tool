import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtures, testWithFixtures } from './fixtures.js';
const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { encoding: 'utf8', timeout: 15000 });
function response(run: ReturnType<typeof cli>) {
  assert.equal(run.error, undefined);
  assert.ok(!run.stdout.includes('\x1b'));
  const data = JSON.parse(run.stdout);
  for (const field of ['schemaVersion', 'protocol', 'tool', 'requestId', 'command', 'status', 'summary', 'results', 'error']) assert.ok(field in data, field);
  assert.equal(data.protocol, 'oppo-live.agent');
  assert.ok(Array.isArray(data.results));
  assert.equal(data.summary.total, data.summary.processed + data.summary.pending);
  return data;
}
async function workspace(t: { after: (f: () => Promise<void>) => void }) { const dir = await mkdtemp(join(tmpdir(), 'oppo-agent-')); t.after(() => rm(dir, { force: true, recursive: true })); return dir; }

test('能力发现、全局 flag 前后位置、请求标识和无动画', () => {
  for (const args of [['capabilities', '--agent', '--request-id', 'req-001'], ['--agent', '--request-id=req-001', 'capabilities']]) {
    const run = cli(args), data = response(run); assert.equal(run.status, 0); assert.equal(data.status, 'success'); assert.equal(data.requestId, 'req-001');
    assert.equal(data.capabilities.optionSchema['--jobs'].type, 'integer');
    assert.equal(data.capabilities.optionSchema['--video-compat'].default, 'original');
    assert.deepEqual(data.capabilities.optionSchema['--video-compat'].values, ['original', 'apple']);
    assert.equal(data.capabilities.defaults.vendorPolicy, 'any-validated-layout');
    assert.equal(data.capabilities.optionSchema['--allow-unknown-vendor'].deprecated, true);
    assert.ok(data.capabilities.formats.supported.includes('JPEG MicroVideoOffset'));
    assert.ok(!data.capabilities.reasonCodes.includes('UNKNOWN_VENDOR'));
    assert.ok(data.capabilities.responseSchema.requiredFields.includes('error'));
    assert.equal(data.capabilities.transport.interactive, false); assert.equal(data.capabilities.defaults.overwrite, false);
  }
});

testWithFixtures('真实样本 inspect 统一结果；普通图片有稳定原因码', () => {
  const run = cli(['inspect', fixtures, '--agent']), data = response(run);
  assert.equal(run.status, 0); assert.equal(data.summary.inspected, 3);
  assert.equal(data.results.filter((r: { code: string }) => r.code === 'MOTION_PHOTO').length, 2);
  assert.equal(data.results.find((r: { code: string }) => r.code === 'ORDINARY_PHOTO').outputsCommitted, false);
  assert.ok(!run.stdout.includes('fingerprint')); assert.equal(data.error, null);
});

test('所有参数/路径错误、帮助与版本只输出一个统一 JSON 对象', () => {
  for (const args of [['inspect', '--agent'], ['inspect', fixtures, '--report', '--agent'], ['inspect', fixtures, '--agent', '--jobs', '0'], ['--agent', 'unknown'], ['--agent'], ['extract', fixtures, '--agent', '--on-conflict', 'overwrite'], ['inspect', '/does-not-exist/oppo.jpg', '--agent']]) {
    const run = cli([...args, '--request-id', 'error-request']), data = response(run);
    assert.ok(run.status === 1 || run.status === 2); assert.equal(data.status, 'failed'); assert.equal(data.requestId, 'error-request'); assert.ok(data.error.code);
  }
  for (const flag of ['--help', '--version']) {
    const run = cli(['--agent', flag]), data = response(run); assert.equal(run.status, 0); assert.equal(data.status, 'success'); assert.ok(data.information);
  }
});

testWithFixtures('提取/预演/部分失败和报告保存保留相同响应契约', async t => {
  const dir = await workspace(t), out = join(dir, 'out'), report = join(dir, 'agent.json');
  const dry = cli(['extract', fixtures, '--agent', '--dry-run', '--out', out]); const preview = response(dry);
  assert.equal(preview.summary.planned, 2); assert.deepEqual(await readdir(dir), []);
  const run = cli(['extract', fixtures, '--agent', '--out', out, '--report', report, '--request-id', 'extract-1']); const data = response(run);
  assert.equal(run.status, 0); assert.equal(data.summary.extracted, 2); assert.equal(data.summary.skipped, 1);
  assert.equal(data.results.find((r: { code: string }) => r.code === 'ORDINARY_PHOTO').status, 'skipped');
  assert.equal(data.results.find((r: { code: string }) => r.code === 'EXTRACTED').outputsCommitted, true);
  assert.deepEqual(JSON.parse((await readFile(report)).toString()), data);
  const repeated = cli(['extract', fixtures, '--agent', '--out', out]), partial = response(repeated);
  assert.equal(repeated.status, 1); assert.equal(partial.status, 'partial'); assert.equal(partial.summary.failed, 2);
  assert.equal(partial.results.filter((r: { code: string }) => r.code === 'OUTPUT_CONFLICT').length, 2);
  const reportFailure = cli(['extract', fixtures, '--agent', '--out', join(dir, 'other'), '--report', join(dir, 'other', 'l1.jpg', 'bad.json')]);
  const failed = response(reportFailure); assert.equal(reportFailure.status, 1); assert.equal(failed.status, 'partial'); assert.equal(failed.error.code, 'REPORT_WRITE_ERROR'); assert.equal(failed.summary.extracted, 2);
});

test('全部文件失败与未知格式有稳定状态', async t => {
  const dir = await workspace(t), bad = join(dir, 'broken.jpg'), unsupported = join(dir, 'unknown.heic');
  await writeFile(bad, Buffer.from([255, 216, 255, 217]));
  const data = response(cli(['inspect', bad, '--agent'])); assert.equal(data.status, 'failed'); assert.equal(data.summary.failed, 1);
  await writeFile(unsupported, 'not a jpeg');
  const skipped = response(cli(['extract', unsupported, '--agent', '--out', join(dir, 'out')]));
  assert.equal(skipped.status, 'success'); assert.equal(skipped.results[0].code, 'UNSUPPORTED_FORMAT');
});

testWithFixtures('SIGINT 取消仍返回已完成结果和未完成清单', () => {
  const source = `
    import { Reader } from './src/io/reader.ts';
    const original = Reader.open.bind(Reader);
    Reader.open = async (...args) => {
      const r = await original(...args);
      if (args[0].endsWith('l2.jpg')) {
        const read = r.read.bind(r);
        r.read = async (...range) => { await new Promise(resolve => setTimeout(resolve, 40)); return read(...range); };
        setTimeout(() => process.kill(process.pid, 'SIGINT'), 5);
      }
      return r;
    };
    process.argv = [process.execPath, 'src/cli.ts', 'inspect', ${JSON.stringify(fixtures)}, '--agent', '--jobs', '1', '--request-id', 'cancel-request'];
    await import('./src/cli.ts');
  `;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15000 });
  const data = response(run); assert.equal(run.status, 130); assert.equal(data.status, 'cancelled'); assert.equal(data.requestId, 'cancel-request');
  assert.equal(data.summary.processed, 1); assert.equal(data.summary.pending, 2); assert.equal(data.error.code, 'CANCELLED');
});

testWithFixtures('提取取消保留已提交结果；清理失败返回结构化残留路径', async t => {
  const dir = await workspace(t);
  for (const denyCleanup of [false, true]) {
    const out = join(dir, denyCleanup ? 'cleanup-failure' : 'clean-cancel');
    const source = `
      import { Reader } from './src/io/reader.ts';
      import { promises as fs } from 'node:fs';
      let seen = 0, blocked = false;
      const unlink = fs.unlink.bind(fs);
      fs.unlink = async path => { if (${denyCleanup} && blocked && String(path).endsWith('.tmp')) throw Object.assign(new Error('test cleanup denied'), { code: 'EACCES' }); return unlink(path); };
      const original = Reader.open.bind(Reader);
      Reader.open = async (...args) => {
        const r = await original(...args);
        if (args[0].endsWith('l2.jpg') && ++seen === 2) {
          blocked = true;
          const read = r.read.bind(r);
          r.read = async (...range) => { await new Promise(resolve => setTimeout(resolve, 40)); return read(...range); };
          setTimeout(() => process.kill(process.pid, 'SIGINT'), 5);
        }
        return r;
      };
      process.argv = [process.execPath, 'src/cli.ts', 'extract', ${JSON.stringify(fixtures)}, '--out', ${JSON.stringify(out)}, '--agent', '--jobs', '1'];
      await import('./src/cli.ts');
    `;
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15000 });
    const data = response(run); assert.equal(run.status, 130); assert.equal(data.status, 'cancelled'); assert.equal(data.summary.extracted, 1);
    assert.equal(data.results.find((r: { code: string }) => r.code === 'EXTRACTED').outputsCommitted, true);
    const files = await readdir(out); assert.ok(files.includes('l1.jpg')); assert.ok(files.includes('l1.mp4')); assert.ok(!files.includes('l2.mp4'));
    if (denyCleanup) {
      assert.equal(data.error.code, 'CLEANUP_FAILED'); assert.ok(data.error.cleanupIssues.length);
      assert.ok(data.results.find((r: { code: string }) => r.code === 'CLEANUP_FAILED').cleanupIssues.length);
    } else { assert.equal(data.error.code, 'CANCELLED'); assert.deepEqual(files.sort(), ['l1.jpg', 'l1.mp4']); }
  }
});
