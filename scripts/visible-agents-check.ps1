<#
.SYNOPSIS
  Real check of the visible agents (feat/visible-agents) on Windows. Run it yourself in PowerShell, from
  Windows Terminal for the --split panes.

.DESCRIPTION
  Nothing touches your real ClickUp or your projects: a local fake ClickUp (scripts\fake-clickup.mjs) and a
  throwaway project in %TEMP% (with spaces in the path).
  1. Builds the kit and creates the throwaway project (init, commit).
  2. Checks that coder / reviewer / tester are selectable agents (agy mainAgent, OpenCode mode all), and that
     agy starts "--agent coder" (one short model call).
  3. Opens "follow --split" (Windows Terminal panes, one per role), then runs a tiny task through the pipeline
     with the runner you choose: coder -> reviewer -> tester, each its own agent.
  4. Checks the logs per role and round, the pipeline log, and "follow" (combined view) on the finished run.
  With -Runner antigravity, "tossana-agents antigravity permissions" shows the agy rules it needs and asks first.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\visible-agents-check.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\visible-agents-check.ps1 -Runner claude-code
#>
param(
  [ValidateSet('antigravity', 'claude-code', 'opencode', 'codex')]
  [string]$Runner = 'antigravity',
  [int]$Port = 47811
)

$ErrorActionPreference = 'Continue'
$kit = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $kit 'packages\cli\dist\index.js'
$proj = Join-Path $env:TEMP 'tossana visible agents\My Project'
$bin = Join-Path $env:TEMP 'tossana visible agents\bin'
$results = New-Object System.Collections.ArrayList

function Check([string]$name, [bool]$ok, [string]$detail = '') {
  [void]$results.Add([pscustomobject]@{ Check = $name; Result = $(if ($ok) { 'PASS' } else { 'FAIL' }); Detail = $detail })
  if ($ok) { Write-Host "PASS  $name" -ForegroundColor Green } else { Write-Host "FAIL  $name  $detail" -ForegroundColor Red }
}
function Section([string]$name) { Write-Host ''; Write-Host "=== $name" -ForegroundColor Cyan }

Section 'Build'
Push-Location $kit
pnpm install --frozen-lockfile | Out-Null
pnpm build | Out-Null
Pop-Location
Check 'kit built' (Test-Path $cli)

Section 'Fake ClickUp and throwaway project'
$server = Start-Process node -ArgumentList @("`"$kit\scripts\fake-clickup.mjs`"", $Port) -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $env:TEMP 'tossana-fake-clickup.log')
$env:TOSSANA_CLICKUP_API_URL = "http://127.0.0.1:$Port/api"
# The agents call "tossana-agents": a shim to this build, for this window only.
Remove-Item -Recurse -Force (Split-Path $proj) -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $proj, $bin | Out-Null
Set-Content (Join-Path $bin 'tossana-agents.cmd') "@node `"$cli`" %*" -Encoding ASCII
$env:Path = "$bin;$env:Path"

Push-Location $proj
try {
  git init -q -b main
  git config user.name 'Visible Agents Check'
  git config user.email 'check@example.com'
  Set-Content agent.config.json (@{
      version = 1
      project = @{ name = 'Probe'; type = 'node-backend'; skill = 'backend-master' }
      clickup = @{ listId = 'L1' }
      tools   = @('antigravity', 'opencode', 'claude-code', 'codex')
      pipeline = @{ maxRounds = 2; timeoutMinutes = 15 }
    } | ConvertTo-Json -Depth 5) -Encoding UTF8
  Set-Content .env "CLICKUP_API_TOKEN=pk_1_FAKEFAKEFAKE`nCLICKUP_OWNER_USER_ID=777`n" -Encoding ASCII
  Set-Content .gitignore ".env`nnode_modules/`n" -Encoding ASCII
  tossana-agents init --yes --no-doctor | Out-Null
  Check 'init (fake ClickUp)' ($LASTEXITCODE -eq 0)
  git add -A; git commit -qm 'kit' | Out-Null

  Section 'Selectable agents'
  foreach ($role in 'coder', 'reviewer', 'tester') {
    $ag = Get-Content ".agents\agents\$role\agent.md" -Raw
    $oc = Get-Content ".opencode\agents\$role.md" -Raw
    Check "$role is an agy main agent and an OpenCode 'all' agent" (($ag -match '(?m)^mainAgent: true') -and ($oc -match '(?m)^mode: all'))
  }
  if (Get-Command agy -ErrorAction SilentlyContinue) {
    $out = agy -p 'Reply with the single word pong.' --agent coder --add-dir $proj --print-timeout 2m --output-format stream-json 2>&1 | Out-String
    Check 'agy starts --agent coder (stream-json)' (($out -match '"agent":"coder"') -and ($out -match 'pong')) ($out.Trim() -split "`n" | Select-Object -Last 1)
  } else { Write-Host 'agy not installed: skipped' -ForegroundColor Yellow }

  if ($Runner -eq 'antigravity') {
    Section 'agy permissions (shows the rules and asks)'
    tossana-agents antigravity permissions
  }

  Section 'follow --split (Windows Terminal: one pane per role)'
  tossana-agents follow T1 --split
  Check 'follow --split' ($LASTEXITCODE -eq 0) $(if ($env:WT_SESSION) { 'panes should be open' } else { 'not in Windows Terminal: commands printed' })

  Section "run --task T1 --runner $Runner (coder -> reviewer -> tester)"
  tossana-agents run --task T1 --runner $Runner --no-context
  Check 'run exit code 0' ($LASTEXITCODE -eq 0)

  Section 'Logs and follow'
  $logs = Join-Path $proj '.agents\logs\T1'
  foreach ($f in '1-coder.log', '1-reviewer.log', '1-tester.log', 'pipeline.log') {
    Check "log $f" (Test-Path (Join-Path $logs $f))
  }
  $pipeline = Get-Content (Join-Path $logs 'pipeline.log') -Raw -ErrorAction SilentlyContinue
  Check 'pipeline.log ends with FINISHED' ($pipeline -match '=== FINISHED') (($pipeline -split "`n" | Where-Object { $_ } | Select-Object -Last 1))
  $follow = tossana-agents follow T1 | Out-String
  Check 'follow shows the kit and the roles, and ends' (($follow -match '\[kit\]') -and ($follow -match '\[r1 coder\]') -and ($LASTEXITCODE -eq 0))
  $comments = Get-Content (Join-Path $env:TEMP 'tossana-fake-clickup.log') | Where-Object { $_ -match '^\s+(comment|status)' }
  Write-Host ''
  Write-Host 'ClickUp (fake) saw:' -ForegroundColor Cyan
  $comments | ForEach-Object { Write-Host "  $_" }
} finally {
  Pop-Location
  Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
}

Write-Host ''
$results | Format-Table -AutoSize
Write-Host "Project kept for a look: $proj"
Write-Host 'Send me this table and the "ClickUp (fake) saw" lines.'
