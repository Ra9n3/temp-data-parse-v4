# The WNDPROC / module-lifetime audit map (TASK I, audit-first)

Verdict being acted on (TASK F, dump `scorch-engine-20261021-075340.dmp`, run
39563546785): user32 message dispatch called a WNDPROC whose code region was
already unmapped — 0xC0000005 EXECUTE, RIP=RAX (an indirect call through the
window object's proc pointer), return address in user32 message dispatch. Not a
C++ exception. Race-dependent: the same CI shape passed attempt 2 and crashed
attempts 3–5 (TASK E logged the death as 0xC000041D — STATUS_FATAL_USER_CALLBACK,
the user32-callback wrapper's view of exactly this crash). The guard shipped by
TASK I must make the invariant below structural, and the stress harness must
reproduce the race before "fixed" is claimable.

**Invariant enforced: no module unload while a window's WNDPROC lives in that
module. Ordering: destroy windows → then unload; anything that cannot be
destroyed pins its module.**

## 1. The in-process module load/unload inventory

Every LoadLibrary/FreeLibrary the engine process can execute, by path:

| # | Site | In-process? | Loads / frees what | Freed? |
|---|------|-------------|--------------------|--------|
| 1 | Crash handler `writeDump` (`main.cpp:439`) | yes | `LoadLibraryA("dbghelp.dll")` | **Never freed** — held for process life. Hosts no windows. Safe. |
| 2 | Scan (`handle_scan`, `main.cpp:4019`) | **no** — one `--scan-worker` **child process** per .vst3 file (spawned at `main.cpp:6589`, `runScanWorker`) | the scanned plugin's module, inside the child | the child exits; the parent process never maps the scanned module. |
| 3 | Probe (`runProbeWorker`, `main.cpp:3919`) | **no** — `--probe-worker` **child process** (`main.cpp:6592`) | instantiate + capability capture inside the child | child exit. The deliberately-leaked `ScopedJuceInitialiser_GUI` (comment `main.cpp:3907–3918`) exists precisely to keep the child's teardown off the loader-lock race — it dies with the address space. |
| 4 | Hosted load (`loadHostedPlugin`, `main.cpp:4296`) | **yes** — runs on the init worker (`main.cpp:7627`) | `findAllTypesForFile` + `createPluginInstance` map the plugin DLL through JUCE's VST3 module-handle cache (`VST3ModuleHandle`; the cache comment lives at `main.cpp:3911`) | JUCE frees the module when the **last reference** drops — the D5 CI finding names it directly: "a module that gets UNLOADED and RELOADED (the Windows FreeLibrary after the last instance dies)" (`testvst/ScorchTestSynth.h:83–85`). |

Correction of the TASK I brief's prime suspect, on the code: **there is no
in-process scan or probe**. The 3f-2 describe/probe split moved both into
disposable child copies of the exe for crash isolation, and 0.9.2 stripped the
slow knobs from probe children so a probe can never overlap a create either.
What remains — and what the whole crash class reduces to — is **site 4**: the
hosted plugin DLL, loaded in-process on the init worker, freed by JUCE's
refcounted module cache when the last instance of its path retires.

Every module site 4 can free is a plugin DLL. Nothing else in the process is
ever unmapped while running: system DLLs (user32, ole32, d2d1/dwrite loaded by
JUCE's renderer stack) and the engine exe stay mapped for process life.

## 2. The window inventory — who owns which WNDPROC

Every window the engine process can contain, with the module its WNDPROC code
lives in and whether it can outlive that module:

| Window | Created by / when | WNDPROC module | Lifetime vs the module | Can it outlive the module? |
|--------|-------------------|----------------|------------------------|---------------------------|
| JUCE message window (the engine's) | engine exe's JUCE copy, MessageManager init on the pump thread (`main.cpp:6692/6704` — created ON the pump, runs `runDispatchLoop` for process life) | engine exe | process life | No — the exe never unmaps. |
| `PluginEditorWindow` (juce::DocumentWindow per editor, `main.cpp:1898`) | engine, MM pump thread, on openEditor | engine exe | open → explicit close / retire (`main.cpp:6533`) / shutdown (`main.cpp:2083`) | No — engine-owned, closed before the instance frees. Its content is the plugin editor; the window itself is exe code. |
| Host-owner chain (GWLP_HWNDPARENT, `main.cpp:1862–1893`) | engine, at editor show, pointing at the shell's main HWND | (owner is the Tauri/WinForms window — another process) | n/a | n/a — user32 drops the owner link when either side dies. |
| Plugin editor HWND (the `AudioProcessorEditor` peer, child of the DocumentWindow) | **the plugin DLL's own JUCE copy** (fixture: `juce_add_plugin` links `juce_audio_utils`/gui stack — `engine/testvst/CMakeLists.txt`), during createEditor | **the plugin DLL** | created at open; destroyed synchronously when the DocumentWindow is deleted (`setContentOwned(ed,true)` → `clearContentComponent` → editor destructor → DestroyWindow cascade) | Only via a defect — the documented ordering closes editors before retire. |
| **The plugin DLL's own JUCE infrastructure window(s)** — the second, independent MessageManager's internal message window, its timers, its async-updater targets | **the plugin DLL's JUCE copy**, lazily on first GUI-stack use. For the fixture this is during the LOAD's capability capture: "call #1 is the VST3 wrapper's hasEditor() VIEW PROBE … that runs during the LOAD's capability capture" (`testvst/ScorchTestSynth.h:94–97`), i.e. an editor-class instantiation on the init worker — **before any openEditor** | **the plugin DLL** | The plugin's JUCE copy is a separate static singleton world: its MessageManager lives until **the DLL's static teardown**, i.e. until FreeLibrary runs DllMain(PROCESS_DETACH) → CRT atexit → `MessageManager::deleteInstance` → DestroyWindow **inside the loader lock**, where window destruction is documented-unreliable and can silently fail | **YES — this is the zombie.** The window outlives the instance, the editor, and (on the failing path) the unmap itself. |
| COM/OLE stub windows (OleMainThreadWndClass et al.) | ole32, COM init | ole32 (system) | process life | No — system module, never freed. |
| Fixture-specific knobs | `crashvst.c` / `probedummy.c` | plain C children | n/a — children only, no windows in-process | No. |

### The mechanism, assembled

1. Load maps the plugin DLL in-process (`loadHostedPlugin`).
2. The capability capture's view probe touches the plugin's editor class →
   the plugin DLL's private JUCE copy boots → its MessageManager message
   window is created with a WNDPROC **inside the plugin DLL**.
3. Editor open/close cycles (the field shape: editor open under play) add and
   remove editor HWNDs, but none of that touches the plugin's infra window.
4. Retire (`retireInstanceNodeOnMessageThread`, `main.cpp:6525`) closes the
   editor, removes the node (`removeNodeByID`), and the vendored graph frees
   the instance "when the old render sequence retires (RenderSequenceExchange
   timer, at most ~500 ms later, never on the audio thread)"
   (`main.cpp:6557–6560`, `AudioHostCore.h:22–34`).
5. The instance destructor drops the module cache's last reference →
   FreeLibrary → loader-lock teardown → the plugin's JUCE copy tries to
   destroy its message window under the loader lock → **sometimes fails
   silently** → the window survives with a WNDPROC pointing into the region
   Windows is about to unmap.
6. Any later dispatch into that window — a user32 broadcast
   (WM_TIMECHANGE/WM_SETTINGCHANGE-class traffic from the runner's own
   activity), a pending queued message, a timer — calls the unmapped proc:
   0xC0000005 EXECUTE at RIP=window proc, inside user32's dispatch. The
   mapped-out hole in the TASK F dump is the freed plugin module.

This explains every observed property: race-dependent (step 5's DestroyWindow
under the loader lock usually succeeds; the dump only happens when it fails
AND a dispatch lands before process exit), fixture-driven in CI (the fixture
is JUCE-linked — the bench's real libraries, Falcon/BBCSO, are the same class
in the field), and invisible to the editor lifecycle (the zombie is not an
editor window).

## 3. The guard (TASK I contract)

One choke point, on the message thread, before the only free trigger:
`retireInstanceNodeOnMessageThread` — after `destroyEditorWindow` (windows we
own are already gone) and before `removeNodeByID` (which schedules the
deferred free).

```
guardModuleRelease(retiring instance):
  orphaned := no live or in-flight instance references the same plugin path
              AND no load is active
  if !orphaned: receipt (orphan=no), return          # the module cannot free
  sweep ALL process windows (top-level via EnumWindows, message-only via
    EnumThreadWindows for every thread of this process, children via
    EnumChildWindows recursion);
  for each window whose WNDPROC's module resolves inside the retiring
    plugin's path (bundle prefix match, case-insensitive):
      detach: SetWindowLongPtrW(GWLP_WNDPROC, DefWindowProcW)
              — the dispatch target moves into user32, which never unmaps
      on failure: pin the module
                  (GetModuleHandleExW PIN | FROM_ADDRESS on the proc) —
                  the code region can never unmap; a live zombie becomes
                  harmless by construction, the leak is the safe failure
  receipt per window + a per-retire summary line
```

Design decisions, named:

- **No nested message pump.** The sweep needs no drain: the editor tree's
  HWNDs are destroyed synchronously by `delete win` before the guard runs,
  and between the guard and the deferred free the MM thread pumps naturally
  (the RenderSequenceExchange timer fires in a later dispatch cycle). A
  nested `runDispatchLoopUntil` would interleave unrelated MM jobs inside a
  retire job — rejected as the bigger risk.
- **Cross-thread detach is safe here.** The zombie's owner thread may be the
  init worker or the pump thread; SetWindowLongPtr on GWLP_WNDPROC across
  threads of the same process applies the change. Cross-process is
  impossible (we enumerate our own PID). Failure mode is a receipt + pin,
  never a crash.
- **DefWindowProcW as the stub.** It lives in user32 (never unmaps), accepts
  every message, and requires no trampoline of our own. A detached window can
  no longer reach the plugin module from user32's dispatch path even if the
  plugin's own teardown later pokes it.
- **Pin over destroy.** DestroyWindow must run on the owning thread and we
  will not post WM_CLOSE into a plugin's window and wait (unbounded plugin
  behavior under the loader lock). Pinning converts "zombie + unmapped code"
  into "zombie + mapped code": the crash becomes structurally impossible; the
  cost is one mapped DLL for process life, receipted.
- **Orphan gate false-negative is safe.** If an in-flight load of the same
  path exists, the module will not free (the incoming instance holds a cache
  reference); skipping the sweep is correct. A later orphaning retire sweeps
  again.

Receipts (engine.log, the D-check grammar): one summary per guard run —
`[module-guard] retire module=<dll> orphan=yes|no windows=<n> detached=<d> pinned=<p>`
— plus one line per touched window
(`[module-guard] detached hwnd=0x… tid=… module=…` /
`[module-guard] PINNED hwnd=0x… module=… — live WNDPROC survived detach; module stays mapped for process life`).

## 4. The repro contract (stress, before "fixed")

`stress` harness mode (`.github/scripts/test-engine-protocol.mjs`) + a
desktop.yml step:

- Bench: the CI-hostable legs are the two fixture identities (Scorch Test
  Synth A and B — two independent plugin modules). Falcon/BBCSO are scanned
  for and included when present; on CI they are absent by construction
  ("CI cannot host commercial libraries" — `engine/testvst/CMakeLists.txt`),
  receipted as `falcon=absent bbcso=absent`, and remain the user's field-gate
  legs. The mechanism is identity-free: any JUCE-linked (or window-creating)
  plugin DLL exercises it.
- 60 editor open/close cycles (≥50 per the brief), alternating the live
  instance between A and B via mid-play diff loads, so every other cycle
  orphans a module and frees it while the transport rolls — the exact
  field shape (editor open under active playback + retire + reload), with
  deterministic iteration counts, no RNG, no wall-clock dependence.
- Assertions: every open answered by exactly one `editorOpened` and one
  `editorClosed`; no `error` receipts; the WS stays alive across all
  retires; clean stop + shutdown + exit 0; the engine.log slice carries the
  `[module-guard]` receipts.
- Pre-fix, this run is expected to reproduce the death (the unamplified D5
  shape already hit 4/5 attempts); a dump then fires the P1 halt:
  adjudicate `MiniDumpWithUnloadedModules`' module list — the unloaded module
  named there is the ghost — before any further development. Post-fix, the
  same run is the acceptance gate: 50+ clean iterations, all D-checks green.

## 5. Residuals the guard deliberately does not cover

- A plugin that crashes during ordinary message handling while its module is
  still mapped — plugin-quality defect, out of scope (the P1 dump names it).
- The publish-tail mark-after-send window (TASK G residual) — unrelated.
- The engine's own windows during shutdown (`closeAllEditorsAtShutdown` runs
  before `stopDispatchLoop`, `main.cpp:2083/8582`): the exe never unmaps, so
  ordering there is hygiene, not crash safety.
