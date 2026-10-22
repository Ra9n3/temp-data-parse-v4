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
#   - P1 ARMED (in-engine crash handler + MiniDumpWithUnloadedModules, always
#     compiled in): ANY crash = HALT-AND-ADJUDICATE — the receipt names the
#     dump, the bench exits RED, nothing is cleaned up.
# Receipt: bench-receipt.txt in the output dir + the full console transcript.
# Send BOTH back (the receipt file IS the run record; attach it to the chat).
#
# Usage (from the bench folder):
#   powershell -ExecutionPolicy Bypass -File .\field-bench.ps1
# Options:
#   -EngineExe .\scorch-engine.exe     (the 0.14.2 engine from the CI artifact)
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
if ($engineVersion -notmatch "0\.14\.2") {
  Verdict "HALT: the engine did not report 0.14.2 ('$engineVersion'). This bench validates the TASK J + D13 branch build (the 0.14.1 init rework REVERTED to the 0.14.0 semantics + dump-then-TERMINATE crash forensics) — use the scorch-engine-windows-exe artifact from the LATEST fieldbench CI run (the D13 build, not the older 0.14.0/0.14.1)."
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

# ---- engine exit (exit-verified read — the log is final once the process is gone)
$proc.WaitForExit(30000) | Out-Null
$engineExit = $null
if ($proc.HasExited) { $engineExit = $proc.ExitCode }
else {
  Write-Host "note: engine still running 30 s after the harness exit — stopping it (shutdown-hang shape; the receipt will say so)"
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
if ($crashed) { $verdict = "HALT-AND-ADJUDICATE"; $verdictWhy += "crash evidence on the record (see the P1 section) — adjudicate the dump before ANY further run" }
elseif (-not $mjsGreen) { $verdict = "RED"; $verdictWhy += "the fieldbench harness exited $mjsExit (see the harness half below)" }
elseif ($legsAbsent) { $verdict = "RED"; $verdictWhy += "both field legs were ABSENT to the harness — a desktop bench must see Falcon AND BBCSO (SCORCH_FIELD_REQUIRE=1 should have failed it; adjudicate the scan)" }
elseif ($pinCount -gt 0) { $verdict = "RED"; $verdictWhy += "pin count $pinCount > 0 — teardown-order residue refused an unload (a leak, never an unmapped dispatch; adjudicate the per-window receipts)" }
elseif ($engineExit -eq $null) { $verdict = "RED"; $verdictWhy += "the engine never exited after the harness finished — shutdown hang (stopped forcibly; adjudicate the stdout tail)" }
elseif ($unresolvedGuard.Count -gt 0) { $verdict = "RED"; $verdictWhy += "UNRESOLVED guard line(s) — the refuse-unload backstop could not pin a window; do not run again before adjudication" }
elseif ($singleLeg) { $verdict = "PARTIAL"; $verdictWhy += "only ONE plugin's cycle leg ran (the other was absent) — a single-leg run has no cross-plugin orphaning retire, so its windows=0 count is 0 by construction; the adjudication requires BOTH legs" }

$receipt = @()
# ── D13: the receipt HEADER is the engine build commit — ONE line, first ──
$receipt += "engine commit: $engineCommit   (0.14.2 — the exact build this receipt describes)"
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
$receipt += "[P1 — crash channel (MiniDumpWithUnloadedModules armed)]"
$receipt += "engine exit code: $(if ($engineExit -ne $null) { $engineExit } else { 'STILL RUNNING (stopped; shutdown-hang shape)' })"
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
  $receipt += "  - falcon: $($retireFalcon.Count) retire receipt(s), $falconRetires0 windows=0; bbcso: $($retireBbcso.Count) retire receipt(s), $bbcsoRetires0 windows=0; pin count $pinCount; engine exit 0"
  $receipt += "  - the dangling-WNDPROC class held closed under the REAL editors, REAL audio, mid-play module retires"
}
$receipt | Out-File -FilePath $receiptPath -Encoding utf8

Write-Host ""
Write-Host "receipt: $receiptPath"
Get-Content $receiptPath | ForEach-Object { Write-Host $_ }
Verdict "FIELD BENCH VERDICT: $verdict $(if ($verdictWhy.Count -gt 0) { '— ' + ($verdictWhy -join ' | ') })"
if ($verdict -eq "GREEN") { exit 0 } else { exit 1 }
