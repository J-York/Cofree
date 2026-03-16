# Cofree - AI Programming Assistant

Tauri 2.0 desktop app: React 19 + TypeScript frontend, Rust backend. See `README.md` for full overview.

## Cursor Cloud specific instructions

### Services overview

| Service | Command | Notes |
|---------|---------|-------|
| Frontend (Vite) | `pnpm dev` | Port 1420. Works standalone in browser for UI work. |
| Full desktop app | `pnpm tauri:dev` | Requires display; launches Vite + Tauri native window. |

### Key commands

See `package.json` scripts section. Quick reference:
- **Lint/typecheck**: `pnpm build` runs `tsc && vite build`; `tsc` alone for type-checking.
- **Tests**: `pnpm test` (Vitest, jsdom env, no external services needed).
- **Frontend dev**: `pnpm dev` (Vite on port 1420).
- **Rust check**: `cd src-tauri && cargo check`.

### Non-obvious caveats

- **Rust toolchain version**: Dependencies (e.g. `time` crate) require Rust >= 1.85 for edition 2024 support. Run `rustup default stable` to ensure latest stable is active; the pre-installed version (1.83) is too old.
- **esbuild build scripts**: pnpm 10+ blocks build scripts by default. The `pnpm.onlyBuiltDependencies` field in `package.json` allowlists `esbuild`. If you see `Ignored build scripts: esbuild` warnings, `pnpm install` will handle it after this field is present.
- **Tauri APIs in browser**: Running `pnpm dev` and opening `http://localhost:1420` in a browser works for UI development, but console errors about `__TAURI__` APIs (e.g. `transformCallback`) are expected since Tauri IPC is unavailable outside the desktop shell. The UI still renders.
- **Tauri system deps on Linux**: `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `libsoup-3.0-dev`, `libjavascriptcoregtk-4.1-dev`, `patchelf` are required for Rust/Tauri compilation.
- **Pre-existing test failures**: 2 tests in `planningService.test.ts` (approval-flow fingerprint blocking) are known to fail in the current codebase.
