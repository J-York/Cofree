# AGENTS.md

## Cursor Cloud specific instructions

### Product overview

Cofree is an AI-powered programming assistant desktop app built with **Tauri 2.0** (React 19 frontend + Rust backend). Single product, not a monorepo.

### Key commands

| Task | Command |
|------|---------|
| Install deps | `pnpm install` |
| Dev server (frontend only) | `pnpm dev` (port 1420) |
| Full app dev | `pnpm tauri:dev` (starts Vite + Rust backend) |
| TypeScript check | `npx tsc --noEmit` |
| Build frontend | `pnpm build` |
| Build Rust backend | `cd src-tauri && cargo build` |
| Run tests | `pnpm test` (vitest) |

### Non-obvious caveats

- **Rust toolchain**: Requires Rust >= 1.77 (Cargo.toml `rust-version`). In practice, some transitive deps (e.g. `time` crate) require a recent stable Rust (1.85+). Always use latest stable via `rustup update stable && rustup default stable`.
- **Linux system deps for Tauri**: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev patchelf` must be installed via apt.
- **pnpm build scripts**: esbuild requires build scripts to run. The `pnpm.onlyBuiltDependencies` field in `package.json` allows esbuild. If you see "Ignored build scripts: esbuild" warnings, ensure this field is present.
- **Port 1420**: Vite dev server binds to port 1420 with `strictPort: true`. If the port is occupied (e.g. from a previous run), kill the old process before restarting.
- **`pnpm tauri:dev`** auto-starts both the Vite dev server (`beforeDevCommand`) and the Rust backend. Do not start `pnpm dev` separately when using `pnpm tauri:dev`.
- **EGL warnings**: On headless/VM Linux environments, you may see `libEGL warning: DRI3 error` — these are harmless GPU acceleration warnings and do not affect functionality.
- **No ESLint configured**: The project currently has no linter beyond TypeScript's `tsc --noEmit`.
- **AI features require API key**: The app connects to LLM APIs (OpenAI/Anthropic/xAI compatible). Configure via the in-app settings panel. Default endpoint is `http://localhost:4000` (LiteLLM proxy), but cloud API endpoints work directly.
