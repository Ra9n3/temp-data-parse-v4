# Assumptions

This environment is a React + Vite + Tailwind web app, not a native Tauri/JUCE shell. Scorch is delivered here as a fully working **web preview of M0–M3** (schema, arranger UI, generation engine, JSON/MIDI export). Native milestones are mocked or omitted as follows.

## Bars and time

- Song sections use **1-indexed bars** (`startBar: 1` is the first bar).
- All musical time in the schema is **ticks at 960 PPQ**. Seconds exist only in the playback/audio layer.
- `referenceAudio.path` is the file name (browser cannot persist a filesystem path). An empty path means no file is loaded. The decoded buffer is session-only.
- Project length is the maximum of section ends, chord ends, and note ends, snapped up to a whole bar (minimum 16 bars if empty).

## Generation

- Locked tracks are those with `track.locked === true` (Compose All passes them as `lockedTrackIds`).
- Muted tracks are still generated.
- Aux percussion is left empty unless a future rule needs it. Module 8 is that future rule for timpani/snare/cymbals: deterministic transition gestures (timpani roll, cymbal swell) are written by the macro-arranger (`src/generation/arrangement.ts`) before build→chorus boundaries; Module 12 will generalize percussion typing.
- Unknown section names use the `default` arrangement profile. Names like "Verse 1" match the `verse` profile.
- Humanize timing is capped under 15 ms equivalent and clamped to the original bar.
- Preview playback uses a lightweight Web Audio synth (not VST). Family maps to oscillator type so Compose All + Play is audible.

## UI

- Structure / Chords / Audio tracks show a disabled VST control (or Load audio on the reference lane) because they are not instrument hosts.
- VST browser is driven by a **mock plugin service** plus a dev-only state switch (Scanning / Empty / Not scanned / Loaded).
- Record is visible and disabled.
- Per-track MIDI export downloads a zip (browser has no folder picker).
- Piano roll: click empty grid to add a note, click a note to delete.

## Out of scope in this build (M4–M6 native)

- Tauri window, sidecar, Windows installer
- JUCE 8 engine, VST3 scan/host, ASIO/WASAPI, freeze/render
- Smart Suspend, plugin editor windows, engine heartbeat/reconnect
- `.scorch` native file association / autosave recovery file on disk (JSON import/export stands in)
