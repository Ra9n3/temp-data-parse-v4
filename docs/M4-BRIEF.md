# M4 — the real output stage (the limiter): brief, approved answers, riders

Receipt-culture note (R-D): this file is the milestone brief plus the approved
design answers, committed INTO the repo at PR time — chat is not a receipt
store. Every milestone brief lands here from M4 on. Provenance flag: the
brief's original chat text was not re-derivable after the lost session; the
answers below were given against the on-record lines (ASSUMPTIONS §"The
temporary output guard": "Per-bus gains + a soft limiter are the named NEXT
milestone"; main.cpp M2 block, same named-next; the `m3-routing-v1` tag
message: "NEXT: the real output stage (limiter) — master-side last node.
Parked: latency."), and the user approved them verbatim with four riders.

## Scope

M3 PR2 already delivered the brief's per-bus gains (as the per-
{instanceId, outChannelPair} strips). M4 is the limiter only, plus retiring
the M2 output guard's "temporary" status.

## Approved answers

**D3 — placement: post-graph, pre-device, in the audio callback — not a graph
node.** The limiter sits at the exact anchor where the M2 guard already
measures: the summed device buffer after `graph->processBlock`, before the
device write. Three reasons over inserting a master node into the graph: zero
topology change means zero interaction with the render-sequence-accounting
fragility class ASSUMPTIONS already documents and zero churn through the R3
layout guard; post-graph cannot be wired around — any future wiring, bus
shape, or strip table change still funnels through the one device write,
whereas a graph limiter is only as final as its wiring; the latency system
stays untouched — a graph node risks republish interaction with the parked
3i/3j machinery, while zero-added-latency post-graph processing cannot. The
M2 clip counter re-anchors to post-limiter, which converts the existing
"clip counter zero" manual gate into the limiter's own regression tripwire by
construction: nonzero counter after M4 = limiter defect. Same anchor, new
duty — observability becomes prevention.

**D4 — strategy: hand-rolled soft-knee brickwall in main.cpp glue, fixed
defaults, zero added latency.** Same pattern the approved M3 D1 set for the
strip mixer: engine glue, vendored core byte-untouched, no juce_dsp
dependency. A linked max(L,R) envelope follower (stereo-linked to preserve
imaging), effectively instant attack, ~80 ms release, soft knee beginning at
-6 dBFS, hard ceiling at 1.0. The knee placement is chosen for CI
determinism: the existing assertion amplitudes (.198, .394) sit below knee
start, so gain is EXACTLY 1.0 on every healthy signal — the R2 amplitude-split
assertions remain byte-exact, which is the mathematical transparency proof,
not an approximation. Below-knee samples get literally two operations
(envelope update, one multiply); the envelope decays multiplicatively; no
allocation on the audio thread. Defaults are fixed constants, not
protocol-configurable — no new wire messages, protocol stays 1, the frontend
never sees a knob in M4. If a user-facing threshold is ever wanted, that is a
future additive `mix`-style extension. `--plugin-gain` stays accepted-but-
inert, receipt-named as today.

**D5 — receipts + CI: re-anchor the counter, add a twelfth mode, keep the
eleven untouched.** Receipts: a one-shot `[audio] limiter: armed (ceiling 1.0,
knee -6 dB, release 80 ms, zero added latency)` at first play; the existing
1 Hz janitor `[audio] render peak=` receipt gains a `gr=` field; a
rate-limited `[audio] limiter gr +` advance receipt mirroring the
`[audio] clip counter +` shape; `[stop]` gains cumulative `grMax` while
keeping `clipsTotal` — now measuring post-limiter, where zero is the
invariant. CI: the fixture gains a hot-signal knob and a new "limiter" mode
asserts peaks <= 1.0 + epsilon, gr receipts present, `clipsTotal == 0`, clean
stop, exit 0. One receipt-named `SCORCH_LIMITER_OFF` kill-switch case (CI-only)
runs the same hot signal with the limiter out and asserts the clip counter
ADVANCES — that is what proves the re-anchored zero is not vacuous. Then the
real regression proof: all eleven existing modes re-run green UNCHANGED,
because every amplitude assertion in them doubles as a limiter-transparency
check. desktop.yml carries the twelfth mode on windows-latest. Version 0.12.0,
protocol 1, vendored diff vs 769f161 = 0 lines.

## Riders (approved with the answers; each landed)

- **R-A — DENORMAL FLOOR.** The user's correction, adopted verbatim:
  multiplicative decay is the classic denormal GENERATOR under sustained
  digital silence (the envelope keeps shrinking until it enters the denormal
  range — an x86 CPU stall). The explicit floor
  `env = max(env * decay, 1e-9)` fires EVERY sample before any use, and the
  code receipt names it as the PRIMARY defense, with JUCE's
  ScopedNoDenormals (FTZ/DAZ) as belt-and-braces.
- **R-B — HOT VECTOR.** The CI hot-signal peak is ~1.211 — the user's real
  measured failure becomes the regression vector (`SCORCH_TESTVST_HOT_AMP`
  = 3.0736 over the standard t1 sine). The fixture self-reports its post-hot
  peak and CI asserts it is MEANINGFULLY above the ceiling (window
  [1.15, 1.27], i.e. +1.66 dB over, not borderline), so the GR assertion
  proves real reduction.
- **R-C — IN-KNEE DOCUMENTATION.** ASSUMPTIONS states that material peaking
  between -6 dBFS and the ceiling gets gentle INTENDED reduction (a -3 dBFS
  peak renders ~-3.375 dBFS) — the knee working, not a defect — so a future
  "why did my -3 dB peak move" question has a receipt to answer it.
- **R-D — BRIEF-TO-REPO.** This file. Going forward, every milestone brief
  lands in the repo at PR time — chat is not a receipt store.

## Integration note (the multi window)

The multi mode's summed ~1.18 peak is the FROZEN pre-M4 graph-semantics
assertion (three sources exceed the single-instance cap). Under an armed
limiter it would map into the knee and break a true assertion — so the multi
CI run goes out with `SCORCH_LIMITER_OFF=1` (receipt-named by the engine's
armed receipt, named in the workflow): its raw window and its clip-counter
advances (which Test E asserts) stay literally true, zero edits to the eleven
modes, and the limiter is proven on its own D8 runs (armed + bypass).
