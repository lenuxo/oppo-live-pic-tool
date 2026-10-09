# OPPO Live

[English](README.md) | 简体中文

Node.js CLI：检查兼容的 JPEG 实况照片（包括 OPPO/Oplus），无损拆分为静态 JPG 和原始 MP4。使用 Commander + Clack，提供交互引导、进度显示、批量处理和 JSON 报告。当前版本 0.4.0；[迭代计划](ITERATION.md) 记录本轮审查与后续范围。

## 安装

需要 Node.js 22 或更新版本。项目已发布到 [npm](https://www.npmjs.com/package/oppo-live-pic-tool)。

```bash
npm install -g oppo-live-pic-tool
oppo-live inspect ./photos
oppo-live extract ./photos --out ./output

# 无需全局安装，直接运行
npx oppo-live-pic-tool inspect ./photos
```

## 源码运行

需要 Node.js 22 或更新版本。源码托管于 [GitHub](https://github.com/lenuxo/oppo-live-pic-tool)。

```bash
npm install
npm run build

# 交互式引导（在终端中运行）
npm run dev

# 检查图片目录
npm run dev -- inspect ./photos

# 拆分；默认保留原文件、禁止覆盖
npm run dev -- extract ./photos --out ./output
```

编译后可直接运行 `node dist/cli.js`。安装 npm 包后，命令名为 `oppo-live`。

## 命令

```bash
oppo-live inspect ./photos --recursive
oppo-live inspect ./photos --recursive --json
oppo-live extract ./photos --recursive --out ./output
oppo-live extract ./photos --out ./output --dry-run
oppo-live extract ./photos --out ./output --on-conflict rename
oppo-live extract ./photos --out ./output --save-extra --report ./report.json
```

| 参数 | 说明 |
| --- | --- |
| `-r, --recursive` | 扫描子目录；不跟随符号链接 |
| `-o, --out <dir>` | 输出目录，默认 `./oppo-live-output`，仅 extract |
| `--on-conflict error\|skip\|rename` | 默认 error；rename 为 JPG/MP4/可选附加数据使用相同编号 |
| `--dry-run` | 预演，不创建目录或写入文件，仅 extract |
| `--recover` | 元数据定位失败或缺失时，分块搜索并验证尾部 MP4 |
| `--allow-unknown-vendor` | 旧版兼容参数；有效实况已默认允许提取，不限制厂商 |
| `--jobs <n>` | 并发 1–32，默认 4 |
| `--save-extra` | 将 Oplus 主视频后的附加内容逐字节另存为同名 `.extra.bin`，仅 extract |
| `--report <file>` | 保存版本化 JSON 报告；已有报告不覆盖；dry-run 不写报告 |
| `--json` | stdout 输出完整 JSON；不显示交互或动画 |
| `--no-color` | 禁用颜色，也支持 `NO_COLOR` |

参数完整时直接执行；无参数且处于交互终端时启动引导。重定向、CI 和非交互终端使用普通文本。进度及诊断写入 stderr。

扫描目录保留相对层级：`photos/trip/IMG.jpg` → `output/trip/IMG.jpg` + `output/trip/IMG.mp4`。自动排除输出目录。单文件输入按文件内容识别，目录扫描按常见图片扩展名筛选。

普通照片和暂不支持的布局会跳过；通过结构验证的实况默认允许提取，不限制厂商；损坏输入及输出冲突会报告失败，继续处理其他文件。退出码：0 完成，1 文件处理失败，2 参数错误，130 取消。取消时已完成的文件对保留，正在处理的任务会清理临时输出。

检查结束后，输出简洁统计概览和文件结果面板，展示是否实况、视频格式和大小，检查失败时显示原因。需要机器可读结果时使用 `--json` 或 `--agent`。

## 格式支持

支持标准 XMP 容器目录中的主 JPEG、可选 GainMap JPEG、MotionPhoto MP4，以及 Oplus v2 的 `VideoLength` 字段。按 XML 命名空间识别属性，不依赖固定前缀。支持普通 JPEG 和渐进 JPEG 的标记遍历。

Oplus 容器在主 MP4 后可能包含附加数据。工具按 `VideoLength` 提取经过结构验证的主 MP4，默认不导出附加数据；使用 `--save-extra` 可逐字节另存为 `.extra.bin`。报告包含主视频和附加内容的范围，原文件完整保留。这些私有附加内容的业务含义尚未确定。

支持旧版 JPEG MicroVideo 的 `MicroVideo="1"` 和 `MicroVideoOffset`（从文件尾倒数定位）。视频范围必须位于 JPEG 之后，并通过 MP4 结构验证。标准容器目录优先于旧版偏移。无增益图时支持主 JPEG 与 MP4 之间的主图填充，提取静态图时移除填充。

Oplus v2 格式兼容性与拍摄厂商分开报告：兼容文件可以提取，但不会据此宣称已确认由 OPPO 手机拍摄。

静态图不重新编码：保留 JPEG 压缩数据、EXIF 和增益图；清理 Google/Oplus 实况字段及视频目录条目，保留 HDR 目录，按元数据长度变化修正 MP Index。MP4 逐字节复制，保留原始音视频和时间戳。

### 当前限制

- HEIC/AVIF、扩展 XMP、多标准 XMP 数据包、带填充的增益图布局及次级条目填充、未知多媒体布局暂不支持。
- 仅支持单主图或主图 + 单增益图 MP Index；不完整的 MPF/XMP 不猜测修复。
- MP4 验证检查 box 范围、moov、mdat 和视频轨道，不完整解析样本表，也不进行运行时解码验证。
- `--recover` 是显式恢复功能，可能找不到带私有尾部的变体；不会单凭 `ftyp` 字符串认定视频有效。
- 无跨文件原子事务：使用临时文件、无覆盖的硬链接提交和异常回滚。进程崩溃或断电仍可能留下临时文件/单个已提交文件；不自动删除这些文件。
- 优先通过硬链接无覆盖提交；当文件系统返回不支持硬链接的错误时，使用独占创建 + 分块复制回退。回退期间其他程序可能看到尚未复制完的输出文件，取消或失败会尝试回滚。输出文件默认权限为 0600；不复制源文件的文件系统时间戳，照片 EXIF 拍摄信息保留。


## AI / 自动化调用

机器模式通过普通进程调用，无需 MCP：

```bash
oppo-live capabilities --agent
oppo-live inspect ./photos --recursive --agent --request-id inspect-001
oppo-live extract ./photos --out ./output --dry-run --agent
oppo-live extract ./photos --out ./output --agent --report ./agent-report.json
```

`--agent` 禁止交互、颜色和动画，stdout 仅包含一个 JSON 对象。无论成功、参数错误、路径错误、处理失败、报告写入失败、帮助/版本查询或可捕获的 SIGINT/SIGTERM 取消，都使用同一顶层契约。与 `--json` 同时传入时优先使用机器契约；旧 `--json` 保持原有报告格式。

固定字段：`schemaVersion: 1`、`protocol: "oppo-live.agent"`、`tool`、`requestId`（未指定为 null）、`command`、`status`、`summary`、`results`、`error`（成功为 null）。顶层状态为 `success / partial / failed / cancelled`。`summary.processed + summary.pending = summary.total`；检查数量单独记录为 `inspected`。能力查询和调用前错误没有文件结果，计数为 0。

每个结果提供稳定的 `status`、`code` 和 `outputsCommitted`；AI 应依赖这些字段判断，不解析展示用的 `message`。普通照片为 `ORDINARY_PHOTO`，未知格式为 `UNSUPPORTED_FORMAT`；来源证据仅供参考，不阻止提取。普通跳过不使整批失败；全部处理失败为 `failed`，成功或跳过与失败混合为 `partial`。

取消时保留已完成结果，并以 `PENDING` 列出未完成文件；尚未完成检查或提取的文件不要假定已经处理。清理失败时提供 `cleanupIssues` 路径，应检查残留输出再重试。无法捕获的强制终止（如 SIGKILL）不保证有响应。

退出码仍为 0 完成、1 部分或全部处理失败、2 调用参数错误、130 取消。AI 即使收到非零退出码，也应尝试解析 stdout。`--report` 在机器模式下保存相同的机器响应；dry-run 不写报告。报告已有文件时不会覆盖。

`capabilities` 描述命令、参数、默认值、格式支持范围、写文件行为与错误处理建议。`--request-id` 在成功或错误响应中原样返回。第一版不支持 stdin JSON 或 JSONL；请使用 argv 参数数组调用，避免拼接 shell 命令。

## 报告与异常处理

`--json` 和 `--report` 使用相同结构：`schemaVersion: 1`、工具版本、生成时间、命令、汇总和逐文件结果。提取报告还包含来源证据、主视频/附加数据范围和警告，不包含内部补丁 Buffer 或文件指纹。

报告保存采用无覆盖提交。已有报告会在开始处理前报错；执行期间发生报告写入失败时，照片处理结果保留，JSON 报告仍作为一个完整对象输出，并包含 `error` 与 `reportFile.status: "failed"`，退出码为 1。dry-run 不创建报告或输出目录，可用 shell 重定向保存 JSON。

清理会继续尝试所有本次创建的文件。若有文件无法清理，逐文件结果包含 `CLEANUP_FAILED`、`cleanupIssues` 残留路径；若照片已经提交，`outputsCommitted: true` 会明确说明。不会删除已被其他文件替换的路径。取消时如清理失败，会直接提示残留路径。

报告不是断点续跑清单；再次执行仍遵循显式冲突策略，不凭文件存在判断此前是否正确处理。

## 开发

```bash
npm run check
npm test
npm run build
npm pack --dry-run
```

私有测试图片不记录到 Git，也不包含在 npm 包中。缺少图片时，依赖这些图片的测试自动跳过。配置方式见 [样本配置说明](test/test-img/README.md)。

## 程序接口

```ts
import { inspectFile, planExtraction, executeExtraction } from 'oppo-live-pic-tool';

const inspection = await inspectFile('/photos/IMG.jpg');
const plan = await planExtraction(inspection, {
  out: '/output',
  base: '/photos',
  conflict: 'error',
});

if ('inspection' in plan) {
  const result = await executeExtraction(plan);
  console.log(result);
} else {
  console.log(plan); // skipped / failed
}
```

核心模块不依赖终端 UI。`src/formats` 处理 JPEG/XMP/MPF/MP4，`src/core` 处理检查和提取，`src/io` 处理范围读取和扫描，`src/ui` 管理交互与报告。扫描采用固定大小缓存，提取按 64 KiB 分块，不整体载入照片或视频。

npm 包只包含编译产物与说明文件，不包含测试原图。
