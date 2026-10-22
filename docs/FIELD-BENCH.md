# TASK J FIELD BENCH — the desktop-runner leg (real Falcon + BBCSO)

Canon: this file is the bench contract. The harness mode is `fieldbench` in
`.github/scripts/test-engine-protocol.mjs`; the desktop runner script is
`.github/scripts/field-bench.ps1`. Engine bytes are frozen (0.14.0, the
TASK J root fix); the bench exercises the exact load/open/close/retire paths
the app uses.

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
2. **The bench folder** (self-contained): `scorch-engine.exe` (the 0.14.0
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
0.14.0 → starts the engine **with the REAL audio device** (the field shape)
→ runs the fieldbench machine: scan → play tick 0 → Falcon leg (50 editor
open/close cycles, seeded jitter 200–600 ms close / 0–160 ms reopen) → mid-play
BBCSO load (Falcon's module retires UNDER PLAY) → BBCSO leg (50 cycles) →
final Falcon re-load (BBCSO's module retires) → stop → clean shutdown →
counts the teardown receipts from engine.log → writes `bench-receipt.txt` →
prints the VERDICT.

Duration: ~5–15 minutes (3 real plugin loads dominate). **Do not interact
with the plugin editor windows while the bench runs** — they open and close
automatically ~50 times per plugin.

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

## Hosted-CI counterpart

Desktop Test D11 runs the same mode on a hosted runner where both legs are
absent — the machine must receipt `field legs ABSENT`, pass with 0 field
cycles, and shut the engine down clean. That proves the harness surface; the
desktop run proves the field.
