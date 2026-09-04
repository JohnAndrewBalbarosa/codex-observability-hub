param(
  [string]$CodexHome = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'),
  [ValidateSet('None', 'Minimal', 'Full')]
  [string]$GlobalInstructions = 'None',
  [switch]$ForceInstructions,
  [switch]$SkipStart
)

$ErrorActionPreference = 'Stop'
$toolRoot = Split-Path -Parent $PSScriptRoot

foreach ($command in @('node', 'npm', 'python', 'docker')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "Required command is missing: $command"
  }
}

$envPath = Join-Path $toolRoot '.env'
if (-not (Test-Path -LiteralPath $envPath)) {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  $password = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
  $envContents = @(
    "OBS_POSTGRES_PASSWORD=$password"
    "OBS_DATABASE_URL=postgresql://observability:$password@127.0.0.1:55432/observability"
  ) -join [Environment]::NewLine
  [IO.File]::WriteAllText($envPath, "$envContents$([Environment]::NewLine)", (New-Object Text.UTF8Encoding($false)))
  Write-Output 'Generated a private local database credential in .env.'
}

npm ci --prefix $toolRoot --no-audit --no-fund
python (Join-Path $PSScriptRoot 'install_hooks.py') --codex-home $CodexHome --tool-root $toolRoot

if ($GlobalInstructions -ne 'None') {
  $target = Join-Path $CodexHome 'AGENTS.md'
  $sourceName = if ($GlobalInstructions -eq 'Minimal') { 'AGENTS.minimal.md' } else { 'AGENTS.md' }
  $source = Join-Path $toolRoot "templates\$sourceName"
  if ((Test-Path -LiteralPath $target) -and -not $ForceInstructions) {
    throw "AGENTS.md already exists at $target. Re-run with -ForceInstructions only after reviewing the template."
  }
  if (Test-Path -LiteralPath $target) {
    Copy-Item -LiteralPath $target -Destination "$target.backup" -Force
  }
  Copy-Item -LiteralPath $source -Destination $target -Force
}

if (-not $SkipStart) {
  & (Join-Path $toolRoot 'start.ps1')
}

Write-Output "Installed Codex hooks in $CodexHome. Restart Codex to load them."
