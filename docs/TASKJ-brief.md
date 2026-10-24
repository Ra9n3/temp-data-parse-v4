# TASK J — eliminate the dangling-WNDPROC crash class (editor-open-under-play)

Canon: commit this brief to docs/TASKJ-brief.md as step zero. The repo copy is the single source of truth from now on.

Background (TASK F verdict, dump 20261021-075340): user32 message dispatch called a WNDPROC whose code region was already unloaded (0xc0000005, EXEC-DEP; [crash_rsp]=user32.dll+0x17846 dispatch frame). Race-dependent: attempt 2 passed; 3–5 crashed. Prime suspect: in-process scan/probe module unload racing an open window. P1 + MiniDumpWithUnloadedModules armed — if a wild crash fires: HALT, adjudicate the dump, then continue.

Step 0 — canon: commit this brief to docs/TASKJ-brief.md at task-j-engine-branch. Phase-2 stall fix (a084f50→d3b4c2b) already landed — acknowledged, that was step zero of the repro track. ✓

Step 1 — Audit (deliverable: docs/window-module-lifecycle.md): written map of every in-process LoadLibrary/FreeLibrary (scan, probe, retire paths — scanner is prime suspect) × every window engine or plugin code creates (editors, message-only HWNDs) × for each pair: who owns the WNDPROC, can the window outlive the module holding its code, current teardown order.

Step 2 — Root fix (teardown ordering, per your confirmed reconstruction): everywhere: destroy windows → drain/pump pending messages → then unload the module. Where ownership is shared: refcount/lock. The guard exists only as a fail-loud debug backstop (log + refuse unload), never the load-bearing mechanism.

Step 3 — Repro: use the un-stalled D10 to make the race fire pre-fix (raise iterations, vary timing/seed). Pre-fix repro + post-fix silence = gold standard. If it won't reproduce, the audit map + teardown reasoning is the evidence — write it down.

Step 4 — Acceptance: 50+ clean stress iterations per runner bench (fixtures + test synth on hosted runners; Falcon/BBCSO on the desktop runner). Core D-checks green on the branch. D10 returns to gating on main only after the fix lands. Engine changes only on the branch; the tag never moves. Small commits, each naming the audit-map item it touches.
