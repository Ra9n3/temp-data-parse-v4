# The window × module lifecycle map (TASK J step 1)

Canon: docs/TASKJ-brief.md (committed at 0829543, task-j-engine-branch). This file
is that brief's step-1 deliverable: the written map of every in-process
LoadLibrary/FreeLibrary × every window the engine or plugin code creates × for
each pair, who owns the WNDPROC, whether the window can outlive the module
holding its code, and the current teardown order. It extends the TASK I-era
audit (docs/wndproc-audit.md) to the as-built state at 0829543 — where the
TASK I module-guard (cf2ffb3) ships and is, today, the LOAD-BEARING mitigation
(exactly what TASK J step 2 demotes). Verdict being acted on (TASK F, dump
20261021-075340): user32 dispatch called a WNDPROC whose code region was
already unmapped — 0xC0000005 EXECUTE-DEP, [crash_rsp]=user32.dll+0x17846
dispatch frame; race-dependent (attempt 2 passed, 3–5 crashed).

## 1. The in-process module load/unload inventory (re-verified at 0829543)

| # | Site | In-process? | Loads / frees what | Free path |
|---|------|-------------|--------------------|-----------|
| 1 | Crash handler `writeDump` (`main.cpp:440`) | yes | `LoadLibraryA("dbghelp.dll")` | **Never freed** — held for process life. Hosts no windows. Safe. |
| 2 | Scan (`handle_scan`) | **no** — one `--scan-worker` **child process** per .vst3 file | the scanned plugin's module, inside the child | child exit; the parent never maps it. |
| 3 | Probe (`runProbeWorker`) | **no** — `--probe-worker` **child process** | instantiate + capability capture inside the child | child exit. The deliberately-leaked `ScopedJuceInitialiser_GUI` keeps the child's teardown off the loader-lock race. |
| 4 | Hosted load (`loadHostedPlugin`, runs on the **init worker**) | **yes** | `findAllTypesForFile` + `createPluginInstance` map the plugin DLL through JUCE's refcounted VST3 module-handle cache | JUCE frees the module when the **last reference** drops. TWO free paths: (a) **retire** — `retireInstanceNodeOnMessageThread` removes the node; the vendored graph's RenderSequenceExchange frees the old render sequence (holding the instance) **on the message thread** up to ~500 ms later; (b) **load-abort** — the pre-commit instance's destructor (scope-exit / exception) drops the reference **on the init worker**. |

Correction of the original TASK I brief's prime suspect, on the code: there is
**no in-process scan or probe** (3f-2 moved both into disposable child copies).
The entire crash class reduces to **site 4** — the hosted plugin DLL. Nothing
else in the process is ever unmapped while running: system DLLs and the engine
exe stay mapped for process life, and at shutdown the engine hard-exits
(`closeAllEditorsAtShutdown` → `stopDispatchLoop` → `std::_Exit(0)`,
`main.cpp:8833-8865`) with the host graph deliberately leaked — **no module is
ever FreeLibrary'd at shutdown**, so the exit path carries zero teardown-order
exposure (documented policy, `main.cpp:8856-8863`).

## 2. The window inventory × WNDPROC ownership × outlive-the-module

| ID | Window | Created by / when / thread | WNDPROC lives in | Current teardown | Can it outlive the module? |
|----|--------|---------------------------|------------------|------------------|---------------------------|
| W1 | JUCE message window (engine's own) | engine exe's JUCE copy, MM init on the pump thread (`mm_pump_thread`, `runDispatchLoop` — process life) | engine exe | process exit (`_Exit(0)`); the exe never unmaps | **No.** |
| W2 | `PluginEditorWindow` (juce::DocumentWindow per editor) | engine, MM thread, on openEditor (`main.cpp:2007`) | engine exe | `destroyEditorWindow` — `delete win`, synchronous on the MM (`main.cpp:2056`); retire head (`:6794`), close button (async MM job), shutdown close-all | **No** — engine-owned, closed before the node removal; the exe never unmaps. |
| W3 | Host-owner chain (GWLP_HWNDPARENT → the Tauri/WinForms shell window) | engine, at editor show (`applyHostWindowOwner`) | (owner is another process) | user32 drops the owner link when either side dies | n/a. |
| W4 | Plugin editor peer HWND (the `AudioProcessorEditor`'s native peers) | **the plugin DLL's code**, MM thread, during `createEditorIfNeeded` inside openEditor | **the plugin DLL** | the `delete win` cascade (`setContentOwned(ed,true)` → editor destructor → DestroyWindow cascade) — **same-thread (MM), synchronous**, completed before `destroyEditorWindow` returns | Only via a defect — the destroy is same-thread and synchronous, and retire destroys the editor before removing the node. |
| W5 | **The plugin DLL's private JUCE infrastructure window** (the second, independent MessageManager's internal window — timers, async-updater targets) | **the plugin DLL's own JUCE copy**, lazily on first GUI-stack use. AS-PROVEN BY THE TASK J ACCEPTANCE RUNS (39687874816/39691120338 classification receipts: the ghost's owner IS the thread running the retire): in this engine the ghost boots on the **MM pump thread** — the first GUI touch is the editor attach at openEditor (the W5 field shape), not the load's view probe. The TASK I-era init-worker assumption is corrected here; the load-path comment still names the view probe as A GUI-stack touch, but the MM window the retire actually finds is created at the first editor attach on the MM. | **the plugin DLL** | NOBODY destroys it deliberately. Its only destroyer is the DLL's own static teardown at FreeLibrary: DllMain(PROCESS_DETACH) → CRT atexit → `MessageManager::deleteInstance` → DestroyWindow **under the loader lock**. On the retire path that destroy is **cross-thread** (window owned by the init worker, FreeLibrary called on the MM thread) → silently fails. | **YES — this is the ghost.** Empirical: the D10 stress found `windows=1` in the retiring module on **all eleven** orphaning retires (run 39650302358 attempt 2). Today it survives the free only because the TASK I guard DETACHES its dispatch first — the load-bearing mechanism TASK J step 2 removes. |
| W6 | COM/OLE stub windows (OleMainThreadWndClass et al.) | ole32 (COM init) | ole32 (system) | process life | **No** — system module, never freed. |
| W7 | Plugin-spawned windows from a plugin's own thread (field-only shape, unseen in CI) | the plugin | the plugin DLL | none the engine controls | **Potentially yes** — a window on a thread the engine does not own cannot be destroyed by the engine. Covered by the fail-loud pin (refuse-unload), never by a silent pass. |

The dispatch context that makes W5 lethal: the engine's MM pump thread runs
`GetMessage`-style dispatch for **all windows owned by that thread**; the init
worker is a 100 ms poll loop (`main.cpp:8799`) that **never pumps Windows
messages**. Broadcast/sent traffic and queued messages for a W5 window owned
by the pump thread dispatch on the pump thread; a W5 window owned by the init
worker is dormant-while-mapped (nothing pumps there) but still a live zombie
the moment its module unmaps — any later user32 dispatch path that reaches it
(inter-thread sends during COM waits, thread-exit window cleanup) calls the
unmapped proc. The TASK F dump proves the dispatch happened.

## 3. The teardown-order map, as-built at 0829543

**Retire path** (`retireInstanceNodeOnMessageThread`, `main.cpp:6786`, MM thread):

1. `destroyEditorWindow` (W2+W4 destroyed synchronously, same thread) — ✓ correct.
2. `scorchguard::sweepForModule(..., "retire")` (`:6800`) — orphan gate, then
   every window whose WNDPROC's module file is inside the retiring plugin path
   is **DETACHED** (`SetWindowLongPtrW(GWLP_WNDPROC, DefWindowProcW)`) or, on
   detach failure, the module is **PINNED**. This is the load-bearing
   mitigation: the module frees with W5 still alive, its dispatch merely
   redirected.
3. `teardownStripsForInstanceOnMessageThread` → `removeNodeByID` (plugin node +
   selector) → `rawInstance = nullptr` (`:6809-6814`).
4. The deferred free: the vendored RenderSequenceExchange timer frees the old
   render sequence (and the instance → the module) **on the MM thread,
   ≤~500 ms later** — a later MM dispatch, guaranteed after step 3.
5. **Drain: none.** The standing design decision (wndproc-audit.md §3) rejects
   a nested pump on the MM; between steps 2 and 4 the MM pumps naturally.

**Load-abort path** (`loadHostedPlugin` scope-exit guards, `main.cpp:4573-4582`
and `:4635+`, init worker): sweep (detach/pin) → the pre-commit instance's
destructor → the module cache reference drops → free **on the init worker —
the thread that owns W5**. The DLL static teardown's DestroyWindow here is
same-thread (the reliable case), and the guard has already detached anything
it found. Ordering acceptable today; the destroy still rides DllMain rather
than explicit teardown.

**Shutdown path**: no free ever runs (leaked graph + `_Exit(0)`). W2 closed
first (bounded wait), W1/W5/W6 die with the process. No exposure.

**Shared-ownership mechanisms already in place** (the brief's refcount/lock
clause): JUCE's refcounted VST3 module-handle cache is the refcount (a module
with a live instance or an in-flight same-path load cannot free); the guard's
orphan gate (`:4410-4436` — same-path live instances via the live set,
same-path in-flight load via `g_pluginLoadActive` + `g_loadInFlightPath`) is
the lock that keeps the sweep off modules that will not free.

## 4. The root fix design (TASK J step 2 — destroy → drain → unload)

Per the brief: "everywhere: destroy windows → drain/pump pending messages →
then unload the module. Where ownership is shared: refcount/lock. The guard
exists only as a fail-loud debug backstop (log + refuse unload), never the
load-bearing mechanism."

- **R1 — owner-thread destroy at retire (the load-bearing fix, audit items W5
  + §3-retire).** The engine owns the init worker. At an orphaning retire, on
  the MM: (a) classify the retiring module's windows by owning thread;
  (b) MM-owned windows → `DestroyWindow` directly (same-thread, valid);
  (c) worker-owned windows → hand the init worker a module-teardown job:
  `DestroyWindow` on its own windows + a **bounded `PeekMessage` drain**
  (pending messages dispatch into plugin code while the module is still
  mapped — the drain discipline), then ack; the MM **waits bounded** (~100 ms
  worker cadence, ≤2 s cap) for the ack. The wait is a barrier: the deferred
  free is a LATER dispatch on this same thread, so the ordering
  destroy → drain → free is guaranteed, not probabilistic.
- **R2 — load-abort teardown (audit item §3-load-abort).** The same
  destroy+drain runs on the init worker **before** the pre-commit instance's
  destructor (same thread — direct, no handoff), so the DllMain static
  teardown finds its window already gone (its own DestroyWindow on a dead
  HWND is a harmless no-op) on every path.
- **R3 — guard demotion (audit item §3-retire step 2).** The sweep's DETACH
  branch is removed entirely. The sweep becomes the **verify backstop**:
  after R1/R2, any window still living in the module → loud log
  (per-window + summary naming the teardown-order defect) + **PIN the module**
  (`GetModuleHandleExW PIN` — the refuse-unload semantics: FreeLibrary becomes
  a refcount decrement that can never unmap) + a debug-build assert. The leak
  is the safe failure, receipted; the crash class stays structurally closed
  even when a teardown step fails (W7 lives here by design).
- **R4 — shared ownership unchanged (audit item §3, refcount/lock).** The
  orphan gate and JUCE's module refcount keep gating everything: a module
  that cannot free is never swept, never destroyed, never pinned — its live
  instances keep their windows.
- **R5 — drain discipline.** The worker-side job drains explicitly after its
  destroys. The MM does NOT nested-pump (the standing design decision holds);
  traffic queued on the MM between the destroy and the free dispatches
  naturally into still-mapped code.
- **Empirical signature after the fix:** green runs read
  `[module-guard] retire instance=… orphan=yes windows=0 …` — nothing left to
  verify; the `detached=` grammar disappears from engine.log; the D10 yml/mjs
  assert grammar updates on the branch to match (harness-only change).

## 5. The repro contract (TASK J step 3)

- **Pre-fix instrument (branch-only):** a repro-instrument commit renders the
  guard INERT (the engine reverts to the pre-TASK-I exposure — detach and pin
  disabled), so the race can fire. The tag never carries it; main never sees
  it.
- **Amplification:** D10 cycles 60→120 (orphaning swaps 11→23), the
  editor-open→close delay gains seeded jitter (timing variance across the
  deferred-free window), swap cadence jitter. Same deterministic-machine
  discipline (seeded PRNG, no wall-clock dependence), more free-window
  crossings per run.
- **Expected pre-fix:** 0xC0000005 EXECUTE at the window proc inside user32
  dispatch — the P1 trap fires, MiniDumpWithUnloadedModules names the ghost
  module in its unloaded list → HALT, adjudicate the dump, continue.
- **Gold standard:** pre-fix repro + post-fix silence (the same amplified
  stress green after R1–R5) = the mechanism demonstrated and closed.
- **If it will not reproduce:** this map (§2 W5 + §3) IS the evidence per the
  brief — the zombie window's existence is receipted 11× on the record (run
  39650302358 attempt 2), the cross-thread destroy defect is code-proven, and
  the guard's 11 detach receipts prove the window was alive at every free.
  The won't-reproduce verdict and its attempts are written down here.

### The step-3 verdict (written down per the brief — run 39679840849)

The amplified pre-fix attempt RAN and did **not** reproduce the crash:
dd0dfe9 (the pure instrument — mitigation INERT, nothing shielding the
ghost), 120 editor cycles under active playback, 23 module-orphaning diff
swaps, seeded jitter (seed 20261022, close delay 150–400 ms, open delay
0–120 ms). Result: **23× `[module-guard] retire … orphan=yes windows=2 …
detached=0 pinned=0 failed=0 … mitigation=INERT`, zero `[crash]` receipts,
clean exit 0** — the ghost's WNDPROC was LEFT ARMED through all 23 frees
(46 armed window-frees across both fixture identities), and no dispatch ever
hit the dangling proc.

**Why it does not reproduce on this bench — the dispatch-vector analysis
(this map is the evidence, per the brief):**

1. **CORRECTED BY THE LATER RUNS (39687874816/39691120338): the ghost is
   MM-PUMP-OWNED** (`thread=1808` = the thread running the retire — the MM
   pump), not init-worker-owned as this analysis first assumed from the
   instrument run's `thread=3180`. The pump thread pumps FOREVER, so the
   crash exposure is HIGHER than this analysis claimed — every queued or
   broadcast message for that window dispatches on the pump thread. The
   instrument run's survival (23 armed frees, zero dispatch into the
   dangling proc) is therefore TIMING, not dormancy: no dispatch traffic for
   that window happened to land in the free windows of that run. That is
   exactly the brief's "race-dependent" shape — and why the fix must (and
   now does) DESTROY the window before the free instead of relying on
   dispatch luck.
2. A WNDPROC executes only when its window's messages are DISPATCHED:
   - the owning thread must pump (`GetMessage`/`PeekMessage`) for queued or
     broadcast traffic — the init worker never does;
   - inter-thread `SendMessage` (broadcast-class traffic: WM_TIMECHANGE /
     WM_SETTINGCHANGE from the runner) is delivered only when the receiving
     thread next pumps — with a non-pumping owner the sender times out and
     **no dispatch occurs**;
   - message-only windows receive no broadcasts at all; this ghost is
     top-level (double-enumerated — see the dedupe receipt below), so
     broadcasts are queued for it, but they sit forever on a non-pumping
     queue;
   - thread-exit cleanup (user32 destroys a dying thread's windows, calling
     their procs) cannot fire — the init worker lives for process life.
3. **CORRECTED:** the armed zombie is NOT dormant — it sits on the pumping
   MM thread — but no dispatch for it landed during the instrument run's
   free windows. The TASK F crash (dump 20261021-075340) is that race LOST:
   the right message, the right microsecond, the freed module. The fix does
   not gamble on the race: the ghost is destroyed (owner-thread
   DestroyWindow + drain) BEFORE the free is even schedulable, and the
   phase-2 verify refuses the unload on any residue.
4. The repro verdict stands with the correction: the instrument cannot make
   the dispatch fire on demand (the traffic is runner-weather), so
   pre-fix-crash repro is not achievable deterministically on this bench —
   the audit map + the armed-free receipts ARE the evidence per the brief,
   and the post-fix runs prove the vector is closed: the window is GONE
   before every free.

**Evidence package for the fix (all on the record):** the ghost exists (11×
`windows=1` under the TASK I guard, run 39650302358 attempt 2; 23× `windows=2`
under the instrument, run 39679840849 — the count difference is the collector
double-enumerating one top-level window, receipt `hwnd=0x4007c` twice per
sweep, now deduped in `collectModuleWindows`); the free strands it while
armed (23 instrumented frees, WNDPROC left in the unloading module — the
exact TASK F exposure); the cross-thread destroy defect is code-proven
(§3); and the fix's owner-thread destroy + drain + verify closes the class
by ORDERING for every dispatch vector — dormant or not, a destroyed window
cannot dispatch.

Post-fix silence on this same amplified machine (the acceptance run) closes
the loop: 50+ clean iterations per bench, `windows=0` verification receipts,
zero `[crash]`, clean exit 0.

### The step-4 acceptance record (run 39691120338, 7f345e6 — GREEN)

Desktop run 39691120338 (engine 0.14.0, the root fix complete): **the whole
battery PASSED** (hello/scan/host/multi/latency/slowload/terminal/routing/
strips/limiter×2/editor-queue/scale — 14 suite banners), the D10 stress ran
**120/120 editor cycles under active playback** (2× the brief's 50+), 23
module-orphaning diff swaps, and the teardown-ordering receipts are the
acceptance proof:

- **25 owner-thread destroys** (`[module-teardown] destroyed hwnd=…
  (current-thread destroy — WM_DESTROY delivered inline) ok=1`) — the ghost
  is destroyed before every free;
- **20 bounded drains** (`drained 1 queued message(s) … while the module is
  still mapped`) — the drain discipline ran at every destroy;
- **60× `[module-guard] … orphan=yes windows=0 pinned=0 failed=0 … teardown
  verified: no window's WNDPROC lives in the module; the free may proceed`**
  — every free in the battery (23 stress + 37 other-mode retires) preceded
  by a verified-clear module;
- **ZERO engine-side PINNED / UNRESOLVED / [crash] receipts** (the only
  pattern hits in the run log are the echoed pwsh script source); clean
  exit 0.

The evidence arc across the four acceptance runs: 39683449963 = compile
C2664 (the wideToUtf8 overload fix); 39684643039 = battery green, 23×
pinned (the classify-then-handoff gate never handed the ghost off);
39687874816 = battery green, the per-window classification receipts proved
the ghost is CURRENT-THREAD-owned at retire (the MM pump thread) — and
unmasked the GetWindowThreadProcessId process/thread confusion that made
the destroy loop skip every window (46× windows=1 pinned=1); 39691120338 =
the one-line API fix, and the root fix works end to end. The invariant held
in EVERY run (zero [crash] across all four) — the backstop earned its keep
exactly as the brief specified, and then handed the load-bearing role back
to the ordering.

## 6. Acceptance mapping (TASK J step 4)

- 50+ clean stress iterations per runner bench: the amplified D10 runs
  120 cycles (2× the requirement) per green run — fixtures + test synth on
  the hosted bench; Falcon/BBCSO on the desktop runner when present
  (receipted absent on CI by construction).
- Core D-checks green on the branch (A/B/C/D/D2–D9/E untouched; D10's new
  grammar asserted; D6 remains the TASK H residual — adjudicated per the
  standing record, warn-only until TASK H lands it).
- Engine changes only on the branch; tag approved-45787bb-v1 does not move;
  main carries this fix only after the branch proves green.
