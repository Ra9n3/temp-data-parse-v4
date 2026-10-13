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
- Humanize timing is capped under 15 ms equivalent and clamped to the original bar. Module 10 upholds the cap as the shared budget for ALL humanize timing terms (role offsets, velocity-dependent late arrival, short-articulation refinement): the per-note SUM is clamped to ±15 ms and startTick stays ≥ 0 and inside the authored bar.
- Module 10 conductor map: the tempo curve at section boundaries is a pure computed function of the project (`buildConductorTempoEvents`) — NOT persisted on the project (`tempoMap` stays a single entry; patch()/persistence untouched). The exporter writes a baseline tempo at tick 0 when the map is non-empty so pre-boundary playback cannot fall back to a DAW default 120 BPM; playback uses tempo-map tick conversion only when the computed map has >1 event, else the exact constant-BPM path.
- Module 10 fermata micro-pauses are DEFERRED to the native engine: a proper pause shifts events; a tempo-dip fake is audible-wrong.
- Module 10 ownership (no double-processing): repetition jitter stays with the AMG engine (M4 salt 0xb0b5) — Module 10 is verify-only there; ostinato metrical accents stay with the cell engine (0x6066) — the M10 metrical pass returns neutral for role OSTINATO; unison anti-flange detune composes additively AFTER the M10 intonation budget as shipped; the ONLY M10 randomness is the existing per-note humanization stream (no salt, `seed + midiChannel + startTick + pitch`), which the ±2 cent eso-jitter consumes.
- Empirical note: on the current fixtures the velocity profile is anti-correlated with lead/inner classes (leads soft, inners loud), so the velocity-dependent late-arrival term saturates the ±15 ms cap in both classes and the raw median ordering of sits-behind offsets coincides; role weights remain verified per note against the pure function (m10-check).
- Post-bake stages (chorus divider, MonophonyGuard) are timing-sensitive by design (module-8 placement): humanized timing shifts can move a note across one of their decision windows, which may change a handoff sliver by ±1 note in humanized runs (proven 0 at all-neutral settings).
- Module 11 woodwind chairs are VIRTUAL: the data layer maps chairs onto the existing 21 section tracks; the project never gains per-chair tracks, and real per-chair patch switching is native-engine territory (aux notes carry at sounding pitch on the section track with `Note.auxInstrumentId`, which preview playback ignores — same family wave).
- Module 11 deferrals, all documented: PIT_MULTI_REED (no saxophones in the DB), contrabassoon (Bassoon 3's aux slot omitted), mid-track CC7 automation for weak oboes (CC7 stays the static per-track balance fader), chair-level disposition schemes (Juxtaposition/Enclosure gain nothing audible over section tracks today — M6's role-level router stays), per-chair rest/transposition nuance (native engine).
- Aux switching is deterministic: idle = chair whose section track holds no notes in the window; ties resolve to the lowest ensemble chair index. The switch gate (elapsed ≥ 4.0 s or ≥ 2 measures since the chair's last primary note) governs every conversion; the ±1 tick of +5 ms stabilization is the only new timing offset and sits inside the ±15 ms humanize discipline.
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
