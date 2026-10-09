# Repository guidelines

- Use Node.js 22 or newer, TypeScript, and ESM. Keep the parser/extraction core independent of Commander and Clack.
- Preserve input files, JPEG compressed data, EXIF and supported HDR gain maps. Do not silently transcode or overwrite existing files.
- Keep `--agent` stdout a single JSON response, including errors and cancellation. Preserve the existing `--json` contract; update capabilities and protocol tests when changing machine behavior.
- Keep memory bounded for media reads/copies. Track files created by each operation and report cleanup failures with residual paths.
- Private real-photo fixtures belong in `test/test-img` and must not be committed or packaged. Tests needing them must skip when fixtures are absent. Keep synthetic tests runnable in a fresh clone.
- Run `npm run check`, `npm test`, and `npm run build` before committing changes. For package changes, also run `npm pack --dry-run` and inspect its contents.
- Keep `package.json`, the lockfile, and `src/version.ts` versions consistent. Commit the lockfile, source and documentation; exclude dependencies, build outputs, extracted media and secrets.
- For library/framework/SDK/API/CLI usage documentation, use Context7: resolve with `npx ctx7@latest library`, then fetch with `npx ctx7@latest docs`. Run outside the default sandbox; never include credentials in queries. This is not required for ordinary code review, refactoring or business logic.
- Do not publish to npm or force-push Git history without explicit user authorization.
