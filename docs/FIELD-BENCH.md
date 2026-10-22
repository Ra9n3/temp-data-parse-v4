# TASK J FIELD BENCH — the desktop-runner leg (real Falcon + BBCSO)

Canon: this file is the bench contract. The harness mode is `fieldbench` in
`.github/scripts/test-engine-protocol.mjs`; the desktop runner script is
`.github/scripts/field-bench.ps1`. The engine build under test is **0.14.1**
(TASK J root fix + D12: progress-aware init watchdog, gated state-capture,
shutdown abandonment of a wedged init worker); the bench exercises the exact
load/open/close/retire paths the app uses.

## Why this bench exists

TASK J adjudication (directive 2, 2026-10-22): code-complete, ACCEPTED pending
field bench. The hosted CI leg (fixtures + test synth) is green — run
39691120338: 120/120 editor cycles under active playback, 23 module-orphaning
swaps, 60x `orphan=yes windows=0 pinned=0 failed=0` teardown-verification
receipts, zero PINNED/UNRESOLVED/[crash], clean exit 0. The remaining leg is
THE FIELD BENCH: real Falcon + real BBCSO on the desktop runner,
editor-open-under-play, **>=50 clean cycles per plugin**, P1 armed,
halt-and-adjudicate on any crash. On green → merge.

## Receipt contract (what the adjudication requires, per plugin)

- **run record**: the `bench-receipt.txt` file the script writes (+ the
  console transcript). Attach both back to the chat.
- **cycle counts**: `falcon=N/50`, `bbcso=N/50` (wire editorOpened/editorClosed
  receipts; the harness fails on any open/close bookkeeping divergence).
- **windows=0 receipt count**: the number of
  `[module-guard] retire instance=field-falcon|field-bbcso orphan=yes windows=0
  pinned=0 failed=0` teardown-verification receipts in the engine.log slice —
  each cycled module retires UNDER PLAY at the next leg's load, and the final
  vehicle re-load retires the last cycled module (nothing frees at exit).
- **pin count**: retires with `pinned=[1-9]` or `failed=[1-9]` — expected 0.

## Prerequisites (once)

1. **Node 22 LTS**: `winget install OpenJS.NodeJS.LTS` (check: `node --version`).
2. **The bench folder** (self-contained): `scorch-engine.exe` (the 0.14.1
   branch build — the `scorch-engine-windows-exe` artifact of the fieldbench
   CI run), `test-engine-protocol.mjs`, `field-bench.ps1` (the three files in
   one folder; the zip provided in chat is exactly this).
3. Falcon + BBCSO installed in the standard VST3 dirs (the script scans
   `C:\Program Files\Common Files\VST3` and the x86 one; override with
   `-ScanDirs`).

## Run (one command)

```powershell
powershell -ExecutionPolicy Bypass -File .\field-bench.ps1
```

What it does: checks prereqs → records the P1 baseline (engine.log offset,
existing dumps — nothing is ever deleted) → verifies the engine reports
0.14.1 → starts the engine **with the REAL audio device** (the field shape)
→ runs the fieldbench machine: scan → play tick 0 → Falcon leg (50 editor
open/close cycles, seeded jitter 200–600 ms close / 0–160 ms reopen) → mid-play
BBCSO load (Falcon's module retires UNDER PLAY) → BBCSO leg (50 cycles) →
final Falcon re-load (BBCSO's module retires) → stop → clean shutdown →
counts the teardown receipts from engine.log → writes `bench-receipt.txt` →
prints the VERDICT.

Duration: ~5–15 minutes (3 real plugin loads dominate). **Do not interact
with the plugin editor windows while the bench runs** — they open and close
automatically ~50 times per plugin.

Stall windows (the 2026-10-22 RED adjudication — harness wait-limit, NOT
product): while a load receipt is outstanding the no-progress window is
**300 s** (a GB-scale library's first load streams from disk for minutes —
the first RED died at 60 s mid-BBCSO-load); once `plugin_state loaded`
arrives the cycling phase keeps its **60 s** no-progress window. On ANY bail
the harness sends shutdown BEFORE disconnecting, so the engine's clean-exit
receipt exists on every path.

## Verdicts

- **GREEN** — mjs exit 0, engine exit 0, zero `[crash]` receipts, per-plugin
  windows=0 retire receipts on the record, pin count 0. Send the receipt
  back; the merge proceeds.
- **PARTIAL** — only one plugin's leg ran (the other was absent from the
  scan). A single-leg run has no cross-plugin orphaning retire by
  construction. Fix the scan dirs and re-run; the adjudication requires both.
- **RED** — harness failed (dead leg, bookkeeping divergence, editor
  unavailable), pin count > 0 (teardown-order residue — a leak, never an
  unmapped dispatch), or a shutdown hang. Evidence is in the receipt.
  Send it back; do not re-run before adjudication.
- **HALT-AND-ADJUDICATE** — crash evidence: `[crash]` lines, a NEW
  `engine-crash.log`, new `.dmp` files in `%APPDATA%\scorch\crashes\`, or a
  nonzero engine exit. P1 held: the dump lists the unloaded modules — its
  name is the culprit. Send the receipt + the dump path back. Nothing is
  cleaned up; the bench exits RED.

## Knobs (normally untouched)

`-Cycles 50` (>=50 required) · `-Seed 20261023` (deterministic jitter — vary
it on a re-run to cross the deferred-free window at different phases) ·
`-Port 9421` · `-ScanDirs` · `-EngineExe` · `-OutDir`.

Env knobs (harness side, normally untouched): `SCORCH_FB_LOAD_STALL_MS`
(default 300000 — the load window), `SCORCH_FB_CYCLE_STALL_MS` (default
60000 — the cycling window), plus `SCORCH_FIELD_CYCLES` /
`SCORCH_FIELD_SEED` / `SCORCH_FIELD_REQUIRE` (set by this script).

## Field receipts (desktop runs)

- **2026-10-22 — RED, adjudicated HARNESS (not product).** Falcon leg
  **PASSED: 50/50 cycles, 0 errors, no crash, no pins** on the real Falcon —
  the TASK J real-world evidence: the crash repro stayed clean on the real
  plugin under the exact field shape (editor-open-under-play, mid-play
  retires). BBCSO leg stalled in LOAD: the flat 60 s no-progress guard fired
  while `loadInFlight=field-bbcso` (~70 s age) — a GB-scale library's first
  load outlives 60 s by design. Fixes (harness-only, engine bytes frozen at
  0.14.0): the 300 s load window (above) + shutdown-before-disconnect on
  every bail (the RED's engine had no "shutdown received" line and lingered
  until the ps1's force-kill). Contract unchanged: >=50 clean cycles per
  plugin. Re-run: same command.
- **2026-10-22 (run 190901) — RED, adjudicated ENGINE (D12).** The harness
  fix held (no wait-limit misfire). Falcon leg **50/50 clean again**. BBCSO:
  the ENGINE's own init watchdog declared the load failed at 120 s wall
  clock (terminal-timeout — worker in phase state-capture, the outgoing
  Falcon's `getStateInformation` on the diff-remove path); then shutdown was
  sent + the connection closed, but the engine was STILL ALIVE 30 s later
  and got force-stopped (the unbounded `plugin_init_thread.join()` at exit).
  Three engine defects named and fixed in **0.14.1**: (1) the watchdog is
  progress-aware — 60 s zero-movement stall (SCORCH_INIT_PROGRESS_STALL_MS;
  the old SCORCH_INIT_TERMINAL_TIMEOUT_MS knob aliases it for CI), 600 s
  hard cap (SCORCH_INIT_HARD_CAP_MS), a 10 s heartbeat (phase +
  zero-movement + last engine→plugin call), and a STALL-BUNDLE diagnostic
  line at declaration (slow first load vs deadlock); (2) state-capture
  audited — the MM `captureState` path is gated off an in-flight init, the
  worker capture sites target committed instances by construction, and the
  thread map is documented in docs/window-module-lifecycle.md §7; (3)
  shutdown abandons a wedged init worker — bounded 10 s wait, detach, skip
  editor/device teardown, exit 0 with all terminal/exit receipts emitted.
  Per-leg init phase timings now land as `[plugin] init timing phase=...
  ms=...` receipts. Contract unchanged: >=50 clean cycles per plugin.
  Re-run: same command (engine artifact: the NEW scorch-engine-windows-exe
  0.14.1).

## Hosted-CI counterpart

Desktop Test D11 runs the same mode on a hosted runner where both legs are
absent — the machine must receipt `field legs ABSENT`, pass with 0 field
cycles, and shut the engine down clean. That proves the harness surface; the
desktop run proves the field.
