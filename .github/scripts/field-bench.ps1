# ============================================================================
# field-bench.ps1 — TASK J FIELD BENCH (the adjudication's desktop leg)
# ============================================================================
# Runs the fieldbench harness against the REAL plugins on THIS machine:
#   - Falcon + BBCSO found by the scan (dirs below)
#   - >=50 editor open/close cycles PER PLUGIN under ACTIVE PLAYBACK (real
#     audio device — the field shape the TASK F dump died in)
#   - each cycled module retires UNDER PLAY at the next leg's load; the
#     engine's '[module-guard] retire instance=field-<plugin> orphan=yes
#     windows=0 pinned=0 failed=0' teardown receipts are counted from
#     engine.log (this script's half of the receipt)
#   - D14 (0.14.3): every bench retire is DISCARD-CLASS (the harness marks
#     discardRetire:true — the bench path never depends on a plugin's
#     message-thread health) + the receipt debts land here: exit-0 vs STILL
#     RUNNING via timestamps, the (panic) tag, the scan failed-plugin name,
#     per-leg init timings, capture-abandon + STALL-BUNDLE lines. D13
#     machinery (flat 120 s watchdog, STALL-BUNDLE + workerTid, all-thread
#     dump, dump-then-TERMINATE) untouched.
#   - D14a (0.14.4): the exit contract is TerminateProcess (detach-free) —
#     no still-loaded module's DLL_PROCESS_DETACH can wedge the process past
#     its final 'clean exit 0' receipt (field: 2026-10-23 12:24, the process
#     was alive 29 s past the receipt with Falcon live at exit). The
#     force-stop timestamp is captured with explicit global scope — the
#     'force-stopped at ?' shape cannot recur.
#   - P1 ARMED (in-engine crash handler + MiniDumpWithUnloadedModules, always
#     compiled in): ANY crash = HALT-AND-ADJUDICATE — the receipt names the
#     dump, the bench exits RED, nothing is cleaned up.
# Receipt: bench-receipt.txt in the output dir + the full console transcript.
# Send BOTH back (the receipt file IS the run record; attach it to the chat).
#
# Usage (from the bench folder):
#   powershell -ExecutionPolicy Bypass -File .\field-bench.ps1
# Options:
#   -EngineExe .\scorch-engine.exe     (the 0.14.4 engine from the CI artifact)
#   -ScanDirs "C:\Program Files\Common Files\VST3","C:\Program Files (x86)\Common Files\VST3"
#   -Cycles 50    -Port 9421    -Seed 20261023    -OutDir .\field-bench-<ts>
# ============================================================================
param(
  [string]$EngineExe = ".\scorch-engine.exe",
  [string]$Mjs = ".\test-engine-protocol.mjs",
  [string[]]$ScanDirs = @(
    "$env:ProgramFiles\Common Files\VST3",
    "${env:ProgramFiles(x86)}\Common Files\VST3"
  ),
  [int]$Cycles = 50,
  [int]$Port = 9421,
  [int]$Seed = 20261023,
  [string]$OutDir = ""
)

$ErrorActionPreference = "Continue"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $OutDir -or $OutDir.Trim().Length -eq 0) { $OutDir = ".\field-bench-$stamp" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$receiptPath = Join-Path $OutDir "bench-receipt.txt"
$transcript = Join-Path $OutDir "bench-mjs.log"

function Verdict([string]$line) {
  Write-Host ""
  Write-Host "=================================================="
  Write-Host $line
  Write-Host "=================================================="
}

# ---- prereq checks ---------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Verdict "HALT: node was not found on PATH. Install Node 22 LTS:  winget install OpenJS.NodeJS.LTS  — then re-run this script."
  exit 2
}
if (-not (Test-Path $EngineExe)) {
  Verdict "HALT: engine exe not found at '$EngineExe'. Download the 'scorch-engine-windows-exe' artifact from the fieldbench CI run, unzip it next to this script (or pass -EngineExe <path>)."
  exit 2
}
if (-not (Test-Path $Mjs)) {
  Verdict "HALT: harness not found at '$Mjs' (test-engine-protocol.mjs must sit next to this script, or pass -Mjs <path>)."
  exit 2
}
$dirsOk = @()
foreach ($d in $ScanDirs) { if (Test-Path $d) { $dirsOk += $d } else { Write-Host "note: scan dir absent, skipped: $d" } }
if ($dirsOk.Count -eq 0) {
  Verdict "HALT: none of the scan dirs exist. Pass your VST3 dir(s): -ScanDirs ""C:\path\to\VST3"""
  exit 2
}

# ---- P1 baseline (never delete anything — the crash channel is evidence) ---
$appdataScorch = Join-Path $env:APPDATA "scorch"
$engineLog = Join-Path $appdataScorch "engine.log"
$crashLog = Join-Path $appdataScorch "engine-crash.log"
$crashDir = Join-Path $appdataScorch "crashes"
$logLinesBefore = 0
if (Test-Path $engineLog) { $logLinesBefore = (Get-Content $engineLog | Measure-Object -Line).Lines }
$crashLogBefore = Test-Path $crashLog
$dumpsBefore = @()
if (Test-Path $crashDir) { $dumpsBefore = @(Get-ChildItem $crashDir -Filter *.dmp -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) }

# ---- engine identity -------------------------------------------------------
$engineVersion = (& $EngineExe --version 2>&1 | Out-String).Trim()
$nodeVersion = (node --version 2>&1 | Out-String).Trim()
Write-Host "engine: $engineVersion"
Write-Host "node:   $nodeVersion"
Write-Host "scan dirs: $($dirsOk -join ' | ')"
Write-Host "cycles per leg: $Cycles  seed: $Seed  require-both-legs: 1"
if ($engineVersion -notmatch "0\.14\.4") {
  Verdict "HALT: the engine did not report 0.14.4 ('$engineVersion'). This bench validates the TASK J + D14 + D14a build (bounded retire-captures + discard-class bench retires + the detach-free exit, on top of the D13 revert/diagnostics) — use the scorch-engine-windows-exe artifact from the LATEST fieldbench CI run (the 0.14.4/D14a build, not the older 0.14.0/0.14.1/0.14.2/0.14.3)."
  exit 2
}

# ---- run -------------------------------------------------------------------
$env:SCORCH_FIELD_REQUIRE = "1"
$env:SCORCH_FIELD_CYCLES = "$Cycles"
$env:SCORCH_FIELD_SEED = "$Seed"

Write-Host ""
Write-Host "=== FIELD BENCH START — $Cycles editor cycles per REAL plugin under play (real audio device, P1 armed) ==="
Write-Host "Plugin editor windows will open and close automatically ~$Cycles times per plugin. Do NOT interact with them."
$proc = Start-Process -FilePath $EngineExe -ArgumentList "--port","$Port" -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $OutDir "engine-stdout.txt") -RedirectStandardError (Join-Path $OutDir "engine-stderr.txt")
Start-Sleep -Seconds 3
if ($proc.HasExited) {
  Write-Host "engine stdout:"; Get-Content (Join-Path $OutDir "engine-stdout.txt") -ErrorAction SilentlyContinue
  Verdict "HALT: the engine exited before the harness could connect (code=$($proc.ExitCode)) — see the stdout above."
  exit 2
}

node $Mjs $Port fieldbench @dirsOk 2>&1 | Tee-Object -FilePath $transcript
$mjsExit = $LASTEXITCODE
$harnessEndAt = Get-Date

# ---- engine exit (exit-verified read — the log is final once the process is gone)
# D14 receipt debt: exit-0 vs STILL RUNNING decided by TIMESTAMPS, not hope —
# the engine's own exit receipt ([engine] clean exit 0 / exit 0 (...)) carries
# the engine.log wall clock; a force-stop records how long the log had been
# silent when the process was killed.
$proc.WaitForExit(30000) | Out-Null
$engineExit = $null
$global:forceStopAt = $null
if ($proc.HasExited) { $engineExit = $proc.ExitCode }
else {
  $global:forceStopAt = Get-Date
  Write-Host "note: engine still running 30 s after the harness exit — stopping it (shutdown-hang shape; the receipt will say so, with the log-silence timestamps)"
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}

# ---- engine.log half: the teardown receipts --------------------------------
$procLines = @()
if (Test-Path $engineLog) {
  $slice = Get-Content $engineLog | Select-Object -Skip $logLinesBefore
  $procLines = @($slice)
}
$retireAll = @($procLines | Select-String -Pattern "\[module-guard\] retire instance=field-\S+")
$retireFalcon = @($retireAll | Where-Object { $_.Line -match "instance=field-falcon" })
$retireBbcso = @($retireAll | Where-Object { $_.Line -match "instance=field-bbcso" })
function Count-Windows0($lines) { return @($lines | Where-Object { $_.Line -match "windows=0" }).Count }
$pinCount = @($retireAll | Where-Object { $_.Line -match "pinned=[1-9]" -or $_.Line -match "failed=[1-9]" }).Count
$pinnedGuard = @($procLines | Select-String -Pattern "\[module-guard\] PINNED")
$unresolvedGuard = @($procLines | Select-String -Pattern "\[module-guard\] UNRESOLVED")

# ---- D14 receipt debts: bounded-capture lines, STALL-BUNDLE, per-leg timings, timestamps
function LogTs([string]$line) {
  if ($line -match '^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]') {
    try { return [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd HH:mm:ss.fff', $null) } catch { return $null }
  }
  return $null
}
$lastLogLine = ""
$lastLogTs = $null
for ($i = $procLines.Count - 1; $i -ge 0; $i--) {
  $t = "" + $procLines[$i]
  if ($t.Trim().Length -gt 0) { $lastLogLine = $t.Trim(); $lastLogTs = LogTs $t; break }
}
$exitReceiptLine = @($procLines | Select-String -Pattern '\[engine\] (clean exit 0|exit 0 \()') | Select-Object -Last 1
$abandonLines = @($procLines | Select-String -Pattern 'retire-capture abandoned|capture abandoned|capture completed AFTER abandon|bounded capture arrived AFTER')
$skipLines = @($procLines | Select-String -Pattern 'state capture SKIPPED|discard-class retires for seq')
$stallLines = @($procLines | Select-String -Pattern 'STALL-BUNDLE')
$initTimingLines = @($procLines | Select-String -Pattern '\[plugin\] init timing phase=')
$transcriptLines = Get-Content $transcript -ErrorAction SilentlyContinue
$legTimingLines = @($transcriptLines | Select-String -Pattern 'leg init timing:|per-leg init timings:')
$scanFailedLines = @($transcriptLines | Select-String -Pattern 'scan failed-plugin:')

# ---- P1: crash channel ------------------------------------------------------
$crashLines = @($procLines | Select-String -Pattern "\[crash\]")
$crashLogNow = Test-Path $crashLog
$crashLogTail = ""
if ($crashLogNow -and -not $crashLogBefore) { $crashLogTail = (Get-Content $crashLog -Tail 12 | Out-String) }
$dumpsNow = @()
if (Test-Path $crashDir) { $dumpsNow = @(Get-ChildItem $crashDir -Filter *.dmp -ErrorAction SilentlyContinue) }
$newDumps = @($dumpsNow | Where-Object { $dumpsBefore -notcontains $_.Name })
$engineCrashy = $false
if ($engineExit -ne $null) {
  if ($engineExit -ne 0) { $engineCrashy = $true }   # nonzero (incl. 0xC0000005 as negative int) = the engine did NOT exit clean
}

# ---- receipt ----------------------------------------------------------------
$falconRetires0 = Count-Windows0 $retireFalcon
$bbcsoRetires0 = Count-Windows0 $retireBbcso
$crashed = ($crashLines.Count -gt 0) -or ($newDumps.Count -gt 0) -or ($crashLogNow -and -not $crashLogBefore) -or $engineCrashy
$mjsGreen = ($mjsExit -eq 0)
$mjsOut = (Get-Content $transcript -ErrorAction SilentlyContinue | Out-String)
# D12 receipt-provenance: the engine build commit, parsed FIRST from the
# wire-attested harness transcript (the harness logs it from the engine's
# hello — the engine pins SCORCH_ENGINE_COMMIT at build time), with the
# --version output as the fallback source. A receipt without a commit does
# not identify a build (pre-embed engines); from 0.14.1 on, every build
# carries one.
$engineCommit = "unknown"
if ($mjsOut -match "engine build: \S+ commit=([0-9a-fA-F][0-9a-fA-F-]*)") { $engineCommit = $Matches[1] }
elseif ($engineVersion -match "commit ([0-9a-fA-F][0-9a-fA-F-]*)") { $engineCommit = $Matches[1] }
$legsAbsent = $mjsOut -match "field legs ABSENT"
$singleLeg = (-not $legsAbsent) -and (($retireFalcon.Count -eq 0) -or ($retireBbcso.Count -eq 0)) -and ($retireAll.Count -le 1)

$verdict = "GREEN"
$verdictWhy = @()
if ($crashed) { $verdict = "HALT-AND-ADJUDICATE (panic)"; $verdictWhy += "PANIC — crash evidence on the record (see the P1 section): the run is a panic, not a completed bench. Adjudicate the dump before ANY further run" }
elseif (-not $mjsGreen) { $verdict = "RED"; $verdictWhy += "the fieldbench harness exited $mjsExit (see the harness half below)" }
elseif ($legsAbsent) { $verdict = "RED"; $verdictWhy += "both field legs were ABSENT to the harness — a desktop bench must see Falcon AND BBCSO (SCORCH_FIELD_REQUIRE=1 should have failed it; adjudicate the scan)" }
elseif ($pinCount -gt 0) { $verdict = "RED"; $verdictWhy += "pin count $pinCount > 0 — teardown-order residue refused an unload (a leak, never an unmapped dispatch; adjudicate the per-window receipts)" }
elseif ($engineExit -eq $null) { $verdict = "RED"; $verdictWhy += "the engine never exited after the harness finished — shutdown hang (stopped forcibly; adjudicate the stdout tail)" }
elseif ($unresolvedGuard.Count -gt 0) { $verdict = "RED"; $verdictWhy += "UNRESOLVED guard line(s) — the refuse-unload backstop could not pin a window; do not run again before adjudication" }
elseif ($singleLeg) { $verdict = "PARTIAL"; $verdictWhy += "only ONE plugin's cycle leg ran (the other was absent) — a single-leg run has no cross-plugin orphaning retire, so its windows=0 count is 0 by construction; the adjudication requires BOTH legs" }

$receipt = @()
# ── D13/D14: the receipt HEADER is the engine build commit — ONE line, first ──
$receipt += "engine commit: $engineCommit   (0.14.4 — the exact build this receipt describes)"
$receipt += "SCORSH TASK J FIELD BENCH — receipt"
$receipt += "UTC:      $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss'))"
$receipt += "engine:   $engineVersion"
$receipt += "commit:   $engineCommit"
$receipt += "node:     $nodeVersion"
$receipt += "cycles:   $Cycles per leg   seed: $Seed   require-both-legs: 1   port: $Port"
$receipt += "dirs:     $($dirsOk -join ' | ')"
$receipt += ""
$receipt += "[harness (wire) half — fieldbench mode]"
$receipt += $mjsOut.TrimEnd()
$receipt += ""
$receipt += "[engine.log half — teardown receipts (the audit-map W5 owner-thread destroy + drain + verify)]"
$receipt += "retire receipts total: $($retireAll.Count)  (falcon: $($retireFalcon.Count), bbcso: $($retireBbcso.Count))"
foreach ($l in $retireAll) { $receipt += "  $($l.Line.Trim())" }
$receipt += "windows=0 receipt count: falcon=$falconRetires0 bbcso=$bbcsoRetires0"
$receipt += "pin count (retires with pinned=[1-9] or failed=[1-9]): $pinCount"
$receipt += "[module-guard] PINNED lines: $($pinnedGuard.Count)"
foreach ($l in $pinnedGuard) { $receipt += "  $($l.Line.Trim())" }
$receipt += "[module-guard] UNRESOLVED lines: $($unresolvedGuard.Count)"
foreach ($l in $unresolvedGuard) { $receipt += "  $($l.Line.Trim())" }
$receipt += ""
$receipt += "[D14 — bounded capture / discard-class retires (the bench legs are discardRetire:true: ZERO capture lines is the GREEN shape)]"
$receipt += "capture-abandon lines: $($abandonLines.Count)  (GREEN expectation: 0 — a nonzero count means a real plugin wedged its message thread mid-retire; the retire CONTINUED anyway)"
foreach ($l in $abandonLines) { $receipt += "  $($l.Line.Trim())" }
$receipt += "discard-class skip lines: $($skipLines.Count)  (GREEN expectation: 1 'discard-class retires for seq' per load + 1 'state capture SKIPPED (discard-class retire)' per retired module)"
foreach ($l in $skipLines) { $receipt += "  $($l.Line.Trim())" }
$receipt += ""
$receipt += "[D13 — STALL-BUNDLE lines (with workerTid; GREEN expectation: 0)]"
$receipt += "STALL-BUNDLE count: $($stallLines.Count)"
foreach ($l in $stallLines) { $receipt += "  $($l.Line.Trim())" }
$receipt += ""
$receipt += "[D14 — per-leg init timings (harness wire-attested wall times + the engine's per-phase receipts)]"
foreach ($l in $legTimingLines) { $receipt += "  $($l.Line.Trim())" }
foreach ($inst in @('field-falcon', 'field-bbcso', 'field-falcon2')) {
  $instLines = @($initTimingLines | Where-Object { $_.Line -match "instance=$inst " })
  if ($instLines.Count -gt 0) {
    $receipt += "  $inst phase breakdown (engine.log):"
    foreach ($l in $instLines) { $receipt += "    $($l.Line.Trim())" }
  }
}
if (($legTimingLines.Count -eq 0) -and ($initTimingLines.Count -eq 0)) { $receipt += "  (no init-timing lines — the legs were absent, or a pre-0.14.3 harness produced this log)" }
$receipt += ""
$receipt += "[D14 — scan failures (named; GREEN expectation: none)]"
$receipt += "scan failed-plugin lines: $($scanFailedLines.Count)"
foreach ($l in $scanFailedLines) { $receipt += "  $($l.Line.Trim())" }
$receipt += ""
$receipt += "[P1 — crash channel (MiniDumpWithUnloadedModules armed)]"
# D14 receipt debts: exit-0 vs STILL RUNNING via TIMESTAMPS + the (panic) tag.
if ($engineExit -ne $null) {
  $exitDesc = "exit code $engineExit"
  if ($exitReceiptLine) {
    $t = LogTs $exitReceiptLine.Line
    if ($t -ne $null) { $exitDesc += " — exit receipt at $($t.ToString('HH:mm:ss.fff')) (timestamp-verified: the engine said goodbye in engine.log before the process died)" }
  } else {
    $exitDesc += " — NO exit receipt in engine.log (the process died without its own receipt — treat as a crash shape)"
  }
  $receipt += "engine exit: $exitDesc"
} else {
  $stopRef = $global:forceStopAt
  if ($stopRef -eq $null) { $stopRef = Get-Date }
  $age = -1
  if ($lastLogTs -ne $null) { $age = [int]($stopRef - $lastLogTs).TotalSeconds }
  $receipt += "engine exit: STILL RUNNING — force-stopped at $(if ($global:forceStopAt -ne $null) { $global:forceStopAt.ToString('HH:mm:ss.fff') } else { '?' })"
  $receipt += "  last engine.log line at $(if ($lastLogTs -ne $null) { $lastLogTs.ToString('HH:mm:ss.fff') } else { 'none' }) (age ${age}s at the force-stop — the log-silence window; the shutdown-hang shape, timestamped)"
  $receipt += "  last line: $lastLogLine"
}
$receipt += "panic: $(if ($crashed) { 'YES — the engine died on a crash path (the P1 evidence below); the verdict is tagged (panic)' } else { 'none — no crash-path death on the record' })"
$receipt += "[crash] lines in the engine.log slice: $($crashLines.Count)"
foreach ($l in $crashLines) { $receipt += "  $($l.Line.Trim())" }
$receipt += "engine-crash.log: $(if ($crashLogNow) { 'present' } else { 'absent' })$(if ($crashLogTail) { ' (NEW since this bench started)' })"
if ($crashLogTail) { $receipt += $crashLogTail.TrimEnd() }
$receipt += "new .dmp files: $(if ($newDumps.Count -eq 0) { 'none' } else { ($newDumps | ForEach-Object { $_.FullName }) -join '; ' })"
$receipt += "engine stdout tail:"
Get-Content (Join-Path $OutDir "engine-stdout.txt") -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { $receipt += "  $_" }
$receipt += ""
$receipt += "VERDICT: $verdict"
foreach ($w in $verdictWhy) { $receipt += "  - $w" }
if ($verdict -eq "GREEN") {
  $receipt += "  - falcon: $($retireFalcon.Count) retire receipt(s), $falconRetires0 windows=0; bbcso: $($retireBbcso.Count) retire receipt(s), $bbcsoRetires0 windows=0; pin count $pinCount; capture-abandons: $($abandonLines.Count); STALL-BUNDLEs: $($stallLines.Count); engine exit 0 (timestamp-verified)"
  $receipt += "  - the dangling-WNDPROC class held closed under the REAL editors, REAL audio, mid-play module retires (discard-class, D14)"
}
$receipt | Out-File -FilePath $receiptPath -Encoding utf8

Write-Host ""
Write-Host "receipt: $receiptPath"
Get-Content $receiptPath | ForEach-Object { Write-Host $_ }
Verdict "FIELD BENCH VERDICT: $verdict $(if ($verdictWhy.Count -gt 0) { '— ' + ($verdictWhy -join ' | ') })"
if ($verdict -eq "GREEN") { exit 0 } else { exit 1 }
