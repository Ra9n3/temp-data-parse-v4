# Scorch

Orchestral MIDI generator with a DAW-style arranger. Not a DAW: no audio recording, mixing, or mastering. Set key, mode, BPM and meter, place chords and sections, click **Compose All**, export JSON or MIDI, finish in Fender Studio (or any DAW).

This repository snapshot is the **web preview** (React + Vite + Tailwind) covering the data model, arranger UI, rule-based generator, and export. The intended native shell is Tauri + a JUCE 8 preview engine (not built in this environment).

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

Not executed here. When scaffolding Tauri + JUCE:

1. Install **Node.js LTS**, **Rust stable**, **Visual Studio 2022** (Desktop development with C++).
2. `npm create tauri-app` (React + TypeScript) and copy `src/shared`, `src/generation`, `src/export`.
3. JUCE 8 CMake project producing `scorch-engine.exe`, started as a Tauri sidecar, WebSocket on `127.0.0.1` only. See `docs/ASSUMPTIONS.md`.

## Default tracks

Structure, Chords, Reference Audio, Violins I–II, Violas, Cellos/Basses, French Horns, Trumpets, Trombones, Tuba, Flutes, Oboes, Clarinets, Bassoons, Timpani, Snare, Cymbals, Aux, Piano, Harp.

## Tests

In-app: **Dev → Run acceptance tests**. There is no separate `npm test` script in this snapshot (`package.json` is owned by the host toolchain).
