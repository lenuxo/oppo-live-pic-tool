# OPPO Live

English | [简体中文](README.zh-CN.md)

A Node.js CLI for inspecting OPPO/Oplus JPEG motion photos and splitting them into a still JPG and the original MP4 without re-encoding. Built with Commander and Clack, it provides guided interaction, progress display, batch processing, and JSON reports. Current version: 0.3.0. See the [iteration plan](ITERATION.md) for planned improvements.

## Getting started

Requires Node.js 22 or later. Source code is available on [GitHub](https://github.com/lenuxo/oppo-live-pic-tool).

```bash
npm install
npm run build

# Start the interactive guide in a terminal
npm run dev

# Inspect a directory
npm run dev -- inspect ./photos

# Extract without modifying originals or overwriting files
npm run dev -- extract ./photos --out ./output
```

After building, run `node dist/cli.js` directly. The installed package exposes the `oppo-live` command. The package has not yet been published to npm; package name availability must be checked before publishing.

## Commands

```bash
oppo-live inspect ./photos --recursive
oppo-live inspect ./photos --recursive --json
oppo-live extract ./photos --recursive --out ./output
oppo-live extract ./photos --out ./output --dry-run
oppo-live extract ./photos --out ./output --on-conflict rename
oppo-live extract ./photos --out ./output --save-extra --report ./report.json
```

| Option | Description |
| --- | --- |
| `-r, --recursive` | Scan subdirectories without following symbolic links |
| `-o, --out <dir>` | Output directory; defaults to `./oppo-live-output`; extract only |
| `--on-conflict error\|skip\|rename` | Defaults to error; rename uses the same suffix for JPG, MP4, and optional extra data |
| `--dry-run` | Preview without creating directories or writing files; extract only |
| `--recover` | Search in chunks and validate a trailing MP4 when metadata is missing or cannot locate it |
| `--allow-unknown-vendor` | Allow motion photos without OPPO/Oplus origin evidence; extract only |
| `--jobs <n>` | Concurrency from 1 to 32; defaults to 4 |
| `--save-extra` | Copy data following the Oplus primary video into a matching `.extra.bin` file; extract only |
| `--report <file>` | Save a versioned JSON report; existing reports are never overwritten; dry-run does not write reports |
| `--json` | Write the complete JSON result to stdout without interaction or animation |
| `--no-color` | Disable colors; `NO_COLOR` is also supported |

Commands run directly when arguments are provided. Running without arguments in an interactive terminal starts the guide. Redirected output, CI, and non-interactive terminals use plain text. Progress and diagnostics go to stderr.

Directory scanning preserves relative paths: `photos/trip/IMG.jpg` becomes `output/trip/IMG.jpg` and `output/trip/IMG.mp4`. The output directory is automatically excluded. Individual files are identified by content; directory scans filter common image extensions.

Ordinary photos, photos from other vendors, and unsupported layouts are skipped. Corrupt inputs and output conflicts are reported as failures while other files continue processing. Exit codes: 0 for completion, 1 for file processing failures, 2 for invalid arguments, and 130 for cancellation. Cancellation preserves completed file pairs and cleans up outputs from active tasks.

## Supported formats

Supports standard XMP container directories containing a primary JPEG, an optional GainMap JPEG, and a MotionPhoto MP4, as well as the Oplus v2 `VideoLength` field. XML attributes are recognized by namespace rather than fixed prefixes. JPEG marker traversal supports baseline and progressive JPEGs.

When an Oplus container includes data after its primary MP4, extraction uses `VideoLength` to locate the structurally validated primary video. Extra data is omitted by default; `--save-extra` saves it byte-for-byte as `.extra.bin`. Reports include the ranges of the primary video and extra data. The original file is preserved. The meaning of proprietary extra data is not yet established.

Oplus v2 format compatibility and camera vendor identification are reported separately. A compatible file can be extracted without claiming that its camera vendor has been confirmed as OPPO.

Still images are not re-encoded. JPEG compressed data, EXIF, and gain maps are retained. Google/Oplus motion fields and video directory entries are removed, HDR directory entries are preserved, and MP Index offsets are adjusted for metadata length changes. MP4 bytes are copied unchanged, preserving original audio, video, and timestamps.

### Limitations

- HEIC/AVIF, extended XMP, multiple standard XMP packets, nonzero container padding, and unknown multimedia layouts are not supported.
- MP Index support is limited to a primary image or a primary image with one gain map. Incomplete MPF/XMP metadata is not repaired by guessing.
- MP4 validation checks box ranges, moov, mdat, and a video track. It does not fully parse sample tables or decode video at runtime.
- `--recover` is an explicit recovery feature and may miss variants with proprietary trailing data. An `ftyp` string alone is insufficient to identify a valid video.
- There is no atomic transaction across files. Extraction uses temporary files, hard-link commits without overwriting, and rollback on errors. A crash or power loss may leave temporary files or a single committed output; these are not automatically deleted.
- When hard links are unsupported, extraction falls back to exclusive creation and chunked copying. Other programs may see incomplete output during copying. Cancellation or failure attempts rollback. Output permissions default to 0600. Filesystem timestamps are not copied; EXIF capture information is retained.

## AI and automation

Machine mode works through ordinary process invocation and requires no MCP server:

```bash
oppo-live capabilities --agent
oppo-live inspect ./photos --recursive --agent --request-id inspect-001
oppo-live extract ./photos --out ./output --dry-run --agent
oppo-live extract ./photos --out ./output --agent --report ./agent-report.json
```

`--agent` disables interaction, colors, and animation. stdout contains exactly one JSON object. The same top-level contract applies to success, invalid arguments, path errors, processing failures, report write failures, help/version queries, and catchable SIGINT/SIGTERM cancellation. If combined with `--json`, the agent contract takes precedence. Existing `--json` behavior retains its original report format.

Fixed fields are `schemaVersion: 1`, `protocol: "oppo-live.agent"`, `tool`, `requestId` (null when omitted), `command`, `status`, `summary`, `results`, and `error` (null on success). Top-level status is `success / partial / failed / cancelled`. `summary.processed + summary.pending = summary.total`; inspection counts are recorded separately as `inspected`. Capability queries and errors before processing have no file results and zero counts.

Each result includes stable `status`, `code`, and `outputsCommitted` fields. AI callers should use these fields rather than parsing the display-oriented `message`. Ordinary photos use `ORDINARY_PHOTO`, unsupported formats use `UNSUPPORTED_FORMAT`, and nonmatching or unknown vendors use `NON_OPPO_VENDOR / UNKNOWN_VENDOR`. Normal skips do not fail a batch. A batch where every processed file fails has status `failed`; a mix of failures and successful or skipped files has status `partial`.

Cancellation preserves completed results and lists unfinished files as `PENDING`. Do not assume those files have been inspected or extracted. Cleanup failures include residual paths in `cleanupIssues`; inspect them before retrying. Uncatchable termination such as SIGKILL cannot guarantee a response.

Exit codes remain 0 for completion, 1 for partial or total processing failure, 2 for invalid invocation arguments, and 130 for cancellation. AI callers should attempt to parse stdout even after a nonzero exit code. In agent mode, `--report` saves the same machine response. Dry-run does not write reports, and existing reports are never overwritten.

`capabilities` describes commands, options, defaults, supported formats, file-writing behavior, and error-handling guidance. `--request-id` is echoed unchanged in success and error responses. This version does not accept stdin JSON or JSONL. Invoke the process with an argv array instead of constructing shell command strings.

## Reports and error handling

`--json` and `--report` share a structure containing `schemaVersion: 1`, tool version, generation time, command, summary, and per-file results. Extraction reports also include origin evidence, primary video and extra-data ranges, and warnings. Internal patch buffers and file fingerprints are excluded.

Reports are committed without overwriting. An existing report causes an error before processing begins. If report writing fails during execution, photo processing results are retained, and a complete JSON object is still emitted with `error` and `reportFile.status: "failed"`; the exit code is 1. Dry-run creates neither reports nor output directories. Shell redirection can save its JSON output.

Cleanup attempts every file created by the current operation. If cleanup fails, per-file results include `CLEANUP_FAILED` and residual paths in `cleanupIssues`. `outputsCommitted: true` explicitly indicates when photo outputs have already been committed. Paths replaced by other files are not deleted. Cancellation also reports residual paths when cleanup fails.

Reports are not resume manifests. Subsequent runs follow the explicit conflict policy rather than assuming an existing file was processed correctly.

## Development

```bash
npm run check
npm test
npm run build
npm pack --dry-run
```

Private image fixtures are excluded from Git and the npm package. Tests that require them are skipped when fixtures are unavailable. See the [fixture setup guide](test/test-img/README.md).

## Programmatic API

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

Core modules do not depend on terminal UI. `src/formats` handles JPEG/XMP/MPF/MP4, `src/core` handles inspection and extraction, `src/io` handles range reads and scanning, and `src/ui` manages interaction and reports. Scanning uses fixed-size buffers, and extraction copies data in 64 KiB chunks without loading entire photos or videos into memory.

The npm package contains compiled output and documentation, excluding private image fixtures. Review the package name, version, licensing, and public contents before publishing. No npm release has been published yet.
