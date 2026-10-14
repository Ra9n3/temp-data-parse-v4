# Scorch

![CI](https://github.com/Ra9n3/scorsh/actions/workflows/ci.yml/badge.svg)
![Desktop](https://github.com/Ra9n3/scorsh/actions/workflows/desktop.yml/badge.svg)

Orchestral MIDI generator with a DAW-style arranger. Not a DAW: no audio recording, mixing, or mastering. Set key, mode, BPM and meter, place chords and sections, click **Compose All**, export JSON or MIDI, finish in Fender Studio (or any DAW).

The repo builds two artifacts from one source tree: a **web preview** (React + Vite + Tailwind) and a **Tauri v2 desktop shell** that wraps the same React app in a native Windows window. The data model, arranger UI, rule-based generator, and exporters are shared — the desktop build adds a window and changes nothing else. The intended JUCE 8 preview engine is a later stage; this shell is window-only.

## Web preview (this build)

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
npm run preview
```

Open the app, click **Compose All**, then **Play**. Dev → **Run acceptance tests** exercises parser, validation, generator invariants, MIDI/JSON round-trip, and header/lane alignment.

## Desktop build (Tauri v2, Windows 10/11 x64)

The desktop shell is a thin Tauri v2 window around the unchanged React app — no JUCE, no sidecars, no IPC, no business logic in Rust. The web app ships as the bundled frontend; localStorage autosave/restore works identically in the webview (same origin rules, same key `scorch.autosave.v1`).

### Local dev

Prereqs (Windows 10/11): **Node.js 22 LTS**, **Rust stable** (rustup), **Visual Studio 2022 Build Tools** with the *Desktop development with C++* workload (provides the MSVC linker Tauri's Rust build needs). On Windows 11 you already have WebView2; on Windows 10 the installer bootstraps it automatically (see `docs/ASSUMPTIONS.md`).

```powershell
npm install
npm run tauri:dev
```

`tauri:dev` runs `vite` (port 1420, `strictPort`) and opens the native window pointing at the vite dev server — hot reload works the same as the web build.

### Production build (local)

```powershell
npm run tauri:build
```

Outputs land in `src-tauri/target/release/bundle/`:
- `msi/Scorch_0.0.0_x64_en-US.msi` — Windows Installer
- `nsis/Scorch_0.0.0_x64-setup.exe` — NSIS installer
- `scorch.exe` (in `src-tauri/target/release/`) — the raw executable

### CI

Every push touching `src/`, `src-tauri/`, `package.json`, or `vite.config.ts` triggers `.github/workflows/desktop.yml` on `windows-latest`. **Four artifacts** are uploaded with 14-day retention:

| Artifact | What it is | Tier |
|---|---|---|
| `web-pack` | `web-pack-v{N}.zip` — `manifest.json` + `dist/` contents at root | **Hot-swap** (no Rust rebuild) |
| `scorch-windows-msi` | Windows Installer (MSI) | Slow (full rebuild) |
| `scorch-windows-nsis` | NSIS setup exe | Slow (full rebuild) |
| `scorch-windows-exe` | Raw `scorch.exe` | Slow (full rebuild) |

The installers are **unsigned** — Windows SmartScreen will warn on first launch; this is expected for Stage 1–2 (signing lands in a later stage).

### Hot-swap web packs (Stage 2)

The desktop shell loads its web tier (UI + generation engine) from an **external versioned folder** next to the exe, not from the exe-embedded `dist/`. This means UI/engine updates ship as asset-pack publishes — no Rust recompile, no installer rebuild:

1. Download `web-pack-v{N}.zip` from the latest Desktop CI run.
2. Unzip into `<exe-dir>/web/{N}/` (so `web/{N}/index.html` and `web/{N}/manifest.json` exist).
3. Write the version number to `<exe-dir>/web/CURRENT` (plain text): `echo {N} > web/CURRENT`.
4. Relaunch Scorch. The shell reads `CURRENT`, serves `scorch://localhost/` from `web/{N}/`, and the new web tier is live.

If `CURRENT` is missing or the pack is invalid, the shell gracefully falls back to the `dist/` bundled in the exe — the app always boots. See `docs/ASSUMPTIONS.md` Stage 2 entry for the full tier table, fallback chain, traversal protection, and minShell handshake details.

### Keyboard

| Key | Action |
| --- | --- |
| Space | Play / stop |
| Home | Rewind |
| Delete / Backspace | Remove the currently selected chord or section (chord takes precedence if both are selected) |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+S | Export dialog |
| Ctrl+wheel | Horizontal zoom (timeline) |

## Intended native setup (Windows 10/11 x64)

JUCE 8 engine, VST3 scan/host, ASIO/WASAPI, freeze/render — not yet built. When scaffolding:

1. Install **Node.js LTS**, **Rust stable**, **Visual Studio 2022** (Desktop development with C++).
2. JUCE 8 CMake project producing `scorch-engine.exe`, started as a Tauri sidecar, WebSocket on `127.0.0.1` only. See `docs/ASSUMPTIONS.md`.

## Default tracks

Structure, Chords, Reference Audio, Violins I–II, Violas, Cellos/Basses, French Horns, Trumpets, Trombones, Tuba, Flutes, Oboes, Clarinets, Bassoons, Timpani, Snare, Cymbals, Aux, Piano, Harp.

## Tests

In-app: **Dev → Run acceptance tests**. CLI: `npm run test:cli` (40 pinned tests via the `run-cli-tests.mts` esbuild-CJS harness — see `docs/CHANGES.md` Stage 0 entry for the harness rationale).
