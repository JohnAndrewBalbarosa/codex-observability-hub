$ErrorActionPreference = 'Stop'
$toolRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $toolRoot '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
  throw 'Missing .env. Run scripts/setup.ps1 first.'
}
foreach ($line in Get-Content -LiteralPath $envFile) {
  if ($line -match '^([A-Z][A-Z0-9_]*)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
  }
}
try {
  $existingHealth = Invoke-WebRequest -Uri 'http://127.0.0.1:4319/health' -UseBasicParsing -TimeoutSec 2
  if ($existingHealth.StatusCode -eq 200) { Write-Output 'Observability hub is already running.'; exit 0 }
} catch {}
docker compose -f (Join-Path $toolRoot 'docker-compose.yml') up -d
Start-Sleep -Seconds 3
$databaseHealth = docker inspect --format '{{.State.Health.Status}}' codex-observability-postgres 2>$null
if ($databaseHealth -ne 'healthy') {
  throw "PostgreSQL failed the single bounded readiness check: $databaseHealth"
}
$logDir = Join-Path $toolRoot 'var\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', (Join-Path $toolRoot 'run-server.ps1')
) -WorkingDirectory $toolRoot -WindowStyle Hidden -PassThru
Write-Output "Observability hub started. PID=$($process.Id)"
