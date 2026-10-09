<#
.SYNOPSIS
  Phase 2 check against REAL ClickUp, with your own token. Run it yourself in PowerShell.

.DESCRIPTION
  1. Builds the kit.
  2. Copies EKMONG_MOBILE to a temp folder (without node_modules and WITHOUT your .env).
     The original folder is only read, never changed.
  3. Runs "init" interactively in the copy: it asks for your token (masked) and lets you pick the list.
  4. Runs doctor, the read-only clickup commands, run --dry-run and "opencode agent list".
  5. Optional (-WriteTest): posts one comment and changes the status of a THROWAWAY task, and checks that
     "status done" is refused with exit code 2.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\phase2-real-clickup-check.ps1 -TaskId 86abc123
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\phase2-real-clickup-check.ps1 -TaskId 86abc123 -WriteTest
#>
param(
  [string]$Source = 'D:\Ek-Mobile',
  [string]$TaskId = '',
  [switch]$WriteTest
)

$ErrorActionPreference = 'Continue'
$kit = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $kit 'packages\cli\dist\index.js'
$copy = Join-Path $env:TEMP 'tossana kit real check'
$results = New-Object System.Collections.ArrayList

function Step([string]$name, [scriptblock]$block, [int[]]$okCodes = @(0)) {
  Write-Host ''
  Write-Host "=== $name" -ForegroundColor Cyan
  & $block
  $code = $LASTEXITCODE
  $ok = $okCodes -contains $code
  [void]$results.Add([pscustomobject]@{ Step = $name; Exit = $code; Result = $(if ($ok) { 'PASS' } else { 'FAIL' }) })
  if ($ok) { Write-Host "PASS ($name, exit $code)" -ForegroundColor Green }
  else { Write-Host "FAIL ($name, exit $code)" -ForegroundColor Red }
}

Write-Host "Kit:    $kit"
Write-Host "Source: $Source (read only)"
Write-Host "Copy:   $copy"

Step 'build the kit' { Push-Location $kit; pnpm build | Out-Null; Pop-Location }

Step 'copy the project (no node_modules, no .env)' {
  if (Test-Path $copy) { Remove-Item -Recurse -Force $copy }
  robocopy $Source $copy /E /XD node_modules .expo android ios /XF .env /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -lt 8) { $global:LASTEXITCODE = 0 }
}

Write-Host ''
Write-Host 'Next: init will ask for your ClickUp token (input is hidden) and the list. Answer the questions.' -ForegroundColor Yellow
Step 'init (interactive)' { node $cli --cwd $copy init }
Step 'init again changes nothing' {
  $out = node $cli --cwd $copy init --yes --no-doctor | Out-String
  Write-Host $out
  if ($out -notmatch 'already up to date' -or $out -match 'replaced|created|Wrote') { $global:LASTEXITCODE = 1 }
}
Step 'doctor' { node $cli --cwd $copy doctor }
Step 'clickup spaces' { node $cli --cwd $copy clickup spaces }
Step 'clickup lists' { node $cli --cwd $copy clickup lists }
Step 'clickup statuses' { node $cli --cwd $copy clickup statuses }
Step 'clickup list --status todo --mine' { node $cli --cwd $copy clickup list --status todo --mine }

if ($TaskId) {
  Step "clickup get $TaskId" { node $cli --cwd $copy clickup get $TaskId }
  Step "clickup comments $TaskId" { node $cli --cwd $copy clickup comments $TaskId }
  Step "run --task $TaskId --dry-run" { node $cli --cwd $copy run --task $TaskId --dry-run }
  Step 'status done is refused (exit 2, no API call)' { node $cli --cwd $copy clickup status $TaskId done } @(2)

  if ($WriteTest) {
    Write-Host ''
    Write-Host "WRITE TEST on task $TaskId (use a throwaway task!)" -ForegroundColor Yellow
    $tmp = Join-Path $copy '.agents\tmp'
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $text = "[AGENT: orchestrator] [RESULT: STARTED] [ROUND: 1]`nSummary: Kit check: quotes `"like this`", 100%, `$HOME, it's fine.`nIssues:`n- none`nNext: human"
    [IO.File]::WriteAllText((Join-Path $tmp "$TaskId-check.md"), $text, (New-Object System.Text.UTF8Encoding($false)))
    Step 'comment --file (check the quotes in ClickUp)' { node $cli --cwd $copy clickup comment $TaskId --file ".agents/tmp/$TaskId-check.md" }
    Step 'status coding' { node $cli --cwd $copy clickup status $TaskId coding }
    Step 'status todo (back)' { node $cli --cwd $copy clickup status $TaskId todo }
  }
}

Step 'opencode agent list (agents parse)' {
  Push-Location $copy
  $out = opencode agent list 2>&1 | Out-String
  Pop-Location
  $found = @('orchestrator (primary)', 'coder (subagent)', 'reviewer (subagent)', 'tester (subagent)') | Where-Object { $out.Contains($_) }
  Write-Host "found: $($found -join ', ')"
  if ($found.Count -ne 4) { $global:LASTEXITCODE = 1 } else { $global:LASTEXITCODE = 0 }
}

Write-Host ''
Write-Host '=== Summary' -ForegroundColor Cyan
$results | Format-Table -AutoSize
Write-Host "The copy is kept for you to inspect: $copy"
Write-Host 'It contains your token in .env: delete the folder when you are done.'
