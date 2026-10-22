# TASK J FIELD BENCH — the desktop-runner leg (real Falcon + BBCSO)

Canon: this file is the bench contract. The harness mode is `fieldbench` in
`.github/scripts/test-engine-protocol.mjs`; the desktop runner script is
`.github/scripts/field-bench.ps1`. The engine build under test is **0.14.2**
(TASK J root fix + D13: the 0.14.1 init rework REVERTED to the 0.14.0
semantics — flat 120 s wall-clock watchdog, state-capture at the exact
0.14.0 placement — plus real diagnostics: 10 s init heartbeats, an
ALL-THREAD `init-stall-*.dmp` at every watchdog declaration, and
dump-then-TERMINATE on any AV-class exception); the bench exercises the
exact load/open/close/retire paths the app uses. The build **self-reports
its commit** (CMake pins `SCORCH_ENGINE_COMMIT` from `git rev-parse` at
configure time; `-dirty` on a dirty tree, `unknown` on a non-git configure)
in the `--version` output, the hello payload, and the `[engine] start`
receipt — a receipt that names only a version does not identify a build;
every receipt from 0.14.1 on names the commit too, and the receipt's FIRST
LINE is the commit.

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
  console transcript). Attach both back to the chat. The receipt's FIRST
  LINE is the engine build commit (D13 receipt header — one line, first).
- **engine build identity**: the receipt's header + `engine:`/`commit:`
  lines — the version AND the self-reported build commit (wire-attested via
  the harness transcript's `engine build: 0.14.2 commit=…` line; the
  `--version` string is the fallback). A receipt without a commit describes
  a pre-embed build and does not pin the bytes.
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
  plugin. Re-run: same command. Builds on the record: engine 0.14.0 (bytes @
  `7f345e6`); harness @ `ff172ab` (fix) + `7e9f2c5` (canon).
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
  0.14.1). Builds on the record: engine 0.14.0 bytes @ `7f345e6` (the exe was
  built from the branch tree at `7e9f2c5` — engine files identical);
  harness @ `7e9f2c5`. The fixes landed as 0.14.1: `05aa460` (D12 directives)
  + `de225cc` (harness/docs) + `5146223` (D13 — the pre-commit
  destroy-ordering hole the branch CI re-fired and the dump adjudicated).
- **Receipt provenance — the commit pin (this build on).** The receipt could
  not tell two 0.14.x builds apart (run 190901's record named a version, not
  bytes). The 0.14.1 build now self-reports its commit (`SCORCH_ENGINE_COMMIT`
  — CMake pins it at configure; see the canon above) and the receipt records
  it three ways: the `engine:`/`commit:` lines (parsed from the wire-attested
  hello), the harness transcript line (`engine build: 0.14.1 commit=…`), and
  the `[engine] start v0.14.1 commit …` engine.log receipt.
  `SCORCH_FB_EXPECT_COMMIT` (normally untouched) hard-asserts it. From this
  build on, every field receipt self-pins its engine commit — a re-run
  receipt must name the commit of the artifact CI delivered, and a mismatch
  between the exe pulled and the run recorded is visible on its face.
- **2026-10-22 (dump 211647) — RED, adjudicated ENGINE: the 0.14.1 init
  rework REVERTED (D13, engine 0.14.2).** The crash: null-read inside
  Falcon.vst3+0x984386 ON THE WINDOW-MESSAGE THREAD (our pump → user32
  dispatch → Falcon WNDPROC region); Falcon was still LOADED and its init
  never completed; the unloaded-module list held only nvdlistx.dll (NVIDIA,
  benign) — NOT the dangling-WNDPROC class; a LIVE, HALF-WIRED plugin met
  the pump. Bisect verdict (code-read + the twice-clean 0.14.0 field runs):
  the 0.14.1 progress-aware stall (60 s zero-movement) was the firing pin —
  a GB-scale first load spends minutes inside ONE engine→plugin call (no
  phase transitions, no breadcrumb returns), so its zero-movement clock
  crossed 60 s while the load was HEALTHY; the watchdog declared it failed
  and armed the abandon/discard machinery; the MM state-capture gate is
  reverted with it. REVERTED to the exact 0.14.0 semantics: the FLAT wall
  clock (`SCORCH_INIT_TERMINAL_TIMEOUT_MS`, default 120 s; the Falcon leg
  passed clean twice under it) and unconditional state-capture placement.
  KEPT: the shutdown abandonment (exit-path only — never declares, never
  touches plugin state — not in the dump-211647 chain) and all additive
  receipts (per-phase timings, breadcrumbs, heartbeats). NEW diagnostics
  (mandatory): 10 s init heartbeats (phase + elapsed + zero-movement + last
  call), an ALL-THREAD `init-stall-*.dmp` at EVERY watchdog declaration (the
  worker's REAL stack — the D12 no-suspend policy is superseded), and
  dump-then-TERMINATE on any AV-class first-chance exception (the process
  never survives its own crash dump; the M1 audio-probe AV keeps its
  thread-local carve-out). Invariant, non-negotiable, restated in
  window-module-lifecycle.md §7: a plugin window receives dispatched
  messages ONLY while its engine wrapper object is fully constructed and
  attached; any abandon/abort path destroys the window on its owner thread
  and drains messages BEFORE touching the wrapper. Contract unchanged:
  >=50 clean cycles per plugin. Re-run: same command (engine artifact: the
  NEW scorch-engine-windows-exe 0.14.2).

## Hosted-CI counterpart

Desktop Test D11 runs the same mode on a hosted runner where both legs are
absent — the machine must receipt `field legs ABSENT`, pass with 0 field
cycles, and shut the engine down clean. That proves the harness surface; the
desktop run proves the field.
