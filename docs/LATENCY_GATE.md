# Runtime-Latency Tracking — the By-Ear Gate & Receipt Grammar (Stage 3j)

The reusable artifact for the manual gate that closes the runtime-latency
work. CI (desktop.yml Test D3) proves the machinery against the test synth;
this document captures what a REAL library session must show in
`engine.log`, so the by-ear check is greppable, repeatable, and does not
live in anyone's memory. The receipt grammar below is the contract: if a
line changes shape, this document and the D3 assertions change with it.

## Why this exists

`InstanceSet::slotLatency` (the F4 dispatch-early shift) used to be written
exactly twice per instance — load prepare and device (re)start — and never
re-read. A VST3 plugin that changes its reported latency at runtime (a
convolver loading its IR is the classic shape; a sampler re-buffering a
patch is the other) kept the WRONG shift until a reload, and a prepare-time
0 stayed 0 forever. Stage 3i replaced the one-shot snapshot with
detect-then-mini-republish: three producers feed ONE immutable-republish
job; the audio thread's only visible change is that a later buffer loads a
corrected set (the same mechanism the score/mix publishes already prove),
accepting ONE buffer of timing discontinuity per correction, logged.

## The three producers

1. **The notified fast path** — the engine registers a
   `juce::AudioProcessorListener` on every hosted instance; the callback is
   ONE atomic flag store (realtime-safe by construction). The plugin-init
   worker drains flags every 100 ms and acts WITHOUT debounce: the plugin
   confirmed the change. JUCE detail that shapes everything else (Stage 3j
   discovery): `AudioProcessor::setLatencySamples` ITSELF calls
   `updateHostDisplay(latencyChanged)` internally, and the VST3 wrapper
   routes every latency-member write through `setLatencySamples` (the
   kLatencyChanged handler AND its prepare path). For JUCE-hosted VST3,
   every real-world latency change therefore arrives on this path.
2. **The safety-net walk** — a 2000 ms timer on the message thread polls
   every live instance; a diff must be seen IDENTICAL on two consecutive
   polls (the debounce) before acting. This is the net for wrapper paths
   that bypass notification in other JUCE versions, and it is also what
   LANDS a candidate the one-per-second rate limit deferred.
3. **`audioDeviceAboutToStart`** — the re-prepare loop refreshes the mirror
   and enqueues the same job for any diff (device restart is just another
   producer).

## Receipt grammar (every line, what emits it, what it means)

| Receipt | Emitter | Meaning |
| --- | --- | --- |
| `[latency] saw instance=<id> current=<V> published=<P> samples — safety-net poll armed` | walk, first sighting of a diff with NO pending record | the debounce is armed; one poll (2 s) later it confirms. Steady-state JUCE VST3 hosting cannot produce this (every member write auto-notifies, so walk entries arrive with a pending record the rate limit left behind) — it fires in the listener pre-attach window or a wrapper-bypass path only. Deliberately NOT CI-asserted. |
| `[latency] debounce confirmed instance=<id> value=<V> samples (2 identical safety-net polls)` | walk, second identical poll | the debounce machinery ran and is landing the candidate — the greppable middle of the convolver gate. CI-asserted (deterministic via the rapid pair). |
| `[latency] republish deferred — rate limit (one per instance per second) instance=<id> pending=<V> samples` | enqueue path | the one-per-second cap bit; the candidate stays pending and converges later. Named once per suppressed episode. CI-asserted — this IS the rate-limit reachability proof. |
| `[latency] republish instance=<id> old=<N> new=<M> samples (stage 3i) — one buffer of timing discontinuity accepted` | republish job, after the CAS commit | the correction landed; exactly one buffer of timing discontinuity. CI-asserted (counts, bounds, commanded pairs). |
| `[latency] publish: swapped set corrected=<k> elapsed=<ms>ms` | republish job | the set-level summary (k instances corrected in one swap — multi-instance windows merge into one publish). |
| `[latency] publish: no effective change after rebuild — skipped` | republish job | every candidate had already converged when rebuilt from a fresh load — benign. |
| `[latency] publish: gave up after 8 CAS retries (the set kept changing) — the safety net will re-detect` | republish job | the set kept changing under us; the walk re-detects. Should not appear in a healthy session. |
| `[plugin] reuse while playing — no re-instantiate \| seq <n> instance=<id> latencySamples=<L> channels=[…]` | mid-play same-set reload | the mirror value the reload inherited. The FINAL one in a session with a no-command probe load is the resurrection proof: it must carry the CORRECTED value, never the pre-correction one (the one-write discipline — the mirror is refreshed BEFORE the set swap, so a load racing the watchdog inherits the correction). CI-asserted. |

## Expected engine.log sequences

**(a) A notified change** (the plugin called `setLatencySamples`, which
auto-notifies — the flagged fast path acts without debounce):

```
[latency] republish instance=<id> old=<N> new=<M> samples (stage 3i) — one buffer of timing discontinuity accepted
[latency] publish: swapped set corrected=1 elapsed=<ms>ms
```

**(b) The rapid pair — the deterministic gate sequence** (a plugin notifies
twice within the one-per-second window; the second candidate is deferred and
the safety-net walk lands it). This is the convolver gate's greppable shape
in the user's terms — saw X → debounce confirmed → republished N→M, with
the saw replaced by the suppression that made the walk the lander:

```
[latency] republish instance=<id> old=0 new=1024 samples (stage 3i) — one buffer of timing discontinuity accepted
[latency] republish deferred — rate limit (one per instance per second) instance=<id> pending=2048 samples
[latency] debounce confirmed instance=<id> value=2048 samples (2 identical safety-net polls)
[latency] republish instance=<id> old=1024 new=2048 samples (stage 3i) — one buffer of timing discontinuity accepted
[latency] publish: swapped set corrected=1 elapsed=<ms>ms
```

**(c) A true steady-state convolver** (if a future JUCE wrapper ever lets a
member write bypass notification): the walk arms and confirms —

```
[latency] saw instance=<id> current=<M> published=<N> samples — safety-net poll armed
[latency] debounce confirmed instance=<id> value=<M> samples (2 identical safety-net polls)
[latency] republish instance=<id> old=<N> new=<M> samples (stage 3i) — one buffer of timing discontinuity accepted
```

**(d) Rapid oscillation** (the fixture's 40-toggle flicker; the rate limit
holds and the final state converges):

```
[latency] republish deferred — rate limit (one per instance per second) instance=<id> pending=<V> samples   (named once per episode)
[latency] republish instance=<id> old=… new=… samples (stage 3i) — …                                       (at most ONE per second)
[latency] republish instance=<id> old=<last> new=1024 samples (stage 3i) — …                               (the settled landing)
```

**(e) The resurrection probe** (a no-command reload after a mid-play
correction — the corrected value must survive):

```
[plugin] reuse while playing — no re-instantiate | seq <n> instance=<id> latencySamples=1024 channels=["1"]
```

## Reference: the full locally captured sequence (Stage 3j validation run)

```
[2026-10-17 19:19:36.313] [latency] republish instance=inst-lat old=128 new=1024 samples (stage 3i) — one buffer of timing discontinuity accepted
[2026-10-17 19:19:40.816] [latency] republish instance=inst-lat old=1024 new=0 samples (stage 3i) — one buffer of timing discontinuity accepted
[2026-10-17 19:19:45.420] [latency] republish instance=inst-lat old=0 new=1024 samples (stage 3i) — one buffer of timing discontinuity accepted
[2026-10-17 19:19:45.820] [latency] republish deferred — rate limit (one per instance per second) instance=inst-lat pending=2048 samples
[2026-10-17 19:19:47.204] [latency] debounce confirmed instance=inst-lat value=2048 samples (2 identical safety-net polls)
[2026-10-17 19:19:47.221] [latency] republish instance=inst-lat old=1024 new=2048 samples (stage 3i) — one buffer of timing discontinuity accepted
[2026-10-17 19:19:52.825] [latency] republish instance=inst-lat old=2048 new=1024 samples (stage 3i) — one buffer of timing discontinuity accepted
[2026-10-17 19:19:53.025] [latency] republish deferred — rate limit (one per instance per second) instance=inst-lat pending=0 samples
[2026-10-17 19:19:54.326] [latency] republish instance=inst-lat old=1024 new=0 samples (stage 3i) — one buffer of timing discontinuity accepted
[2026-10-17 19:19:54.627] [latency] republish deferred — rate limit (one per instance per second) instance=inst-lat pending=1024 samples
[2026-10-17 19:19:55.204] [latency] debounce confirmed instance=inst-lat value=1024 samples (2 identical safety-net polls)
[2026-10-17 19:19:57.229] [latency] republish instance=inst-lat old=0 new=1024 samples (stage 3i) — one buffer of timing discontinuity accepted
```

Reading it: the notified corrections (36s, 40s), the rapid pair (45.4s
republish → 45.8s deferred → 47.2s confirmed → 47.2s landed), the flicker's
rate-limited oscillation converging (52.8s → 57.2s), and every landing
carrying the one-buffer discontinuity note. The wire side of the same run:
reuse-receipt latencyMs chain [14.51, 14.51, 34.83, 11.61, 58.05, 34.83] ms
— every correction survived a mid-play load, and the FINAL reuse receipt
(the no-command probe) carried the watchdog-corrected 1024.

## The manual by-ear gate (real Windows, real library)

1. Install the shipped build; host a plugin whose latency changes at
   runtime — a convolution reverb loading its IR mid-session is the classic
   shape (load the convolver, START the transport, THEN load/sweep the IR).
2. Play a musically familiar passage with material routed through the
   plugin; trigger the latency change mid-play.
3. Grep `engine.log` for `[latency]` — expect sequence (a) (notified) or
   (c)/(b) shapes; note `old`/`new` and that exactly ONE
   `republish … — one buffer of timing discontinuity accepted` appears per
   change, with NO editor receipts and NO retire receipts naming the
   instance (the correction path must never retire or re-instantiate).
4. Listen: ONE buffer of timing smear/discontinuity at the correction
   moment is accepted by design; the transport must keep rolling (ticks
   never regress), and the F4-compensated attacks must land back ON the
   grid after at most one buffer. A second discontinuity, a stalled
   transport, or drifting attacks = a defect, not a tradeoff.
5. Repeat the IR load twice quickly — expect the rate limit to name a
   deferral and the final state to converge (the last `republish` for the
   instance carries the plugin's final reported latency).

## CI mapping (desktop.yml Test D3 — what each assertion proves)

| Assertion | Proves |
| --- | --- |
| `>= 8` fixture `[testvst] latency` lines, cc/silent/settle modes present | the fixture took every commanded change |
| republish count `>= 5` and `<= 15` | every correction landed; the one-per-second cap bounds the oscillation |
| pairs `old=128 new=1024`, `old=1024 new=0`, `old=0 new=1024`, `old=1024 new=2048` | the commanded corrections (incl. the rapid pair's two landings) |
| `>= 1` `[latency] republish deferred — rate limit` | THE RATE LIMIT ACTUALLY FIRES — the reachability proof; if this cannot be made to trigger, the cap is unreachable and the fix is unproven |
| `>= 1` `[latency] debounce confirmed` | the safety-net walk named the landing of the deferred candidate (the greppable middle; deterministic via the rapid pair) |
| a final `new=1024` republish | the flicker's settled landing (final-state convergence) |
| `>= 4` publish summaries | the set-level commits rode the mini-republish |
| exactly 1 load-path publish, exactly 5 reuse receipts | no re-instantiate: every correction rode the republish |
| the FINAL reuse receipt carries `latencySamples=1024` | THE RESURRECTION PROOF IN THE LOG: the no-command reload inherited the watchdog-corrected value, never the pre-correction one |
| mjs wire chain `[14.51, 14.51, 34.83, 11.61, 58.05, 34.83]` + transport continuity | the same story on the wire; ticks advance through every correction window |
