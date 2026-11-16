# JARVIS — Windows 11 developer setup.
# Run from the repository folder in PowerShell:   powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")

Write-Host "`n== JARVIS setup ==" -ForegroundColor Magenta

# 1. Node.js 22+
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js is not installed. Installing Node.js LTS with winget..." -ForegroundColor Yellow
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}
$major = [int]((node -v).TrimStart("v").Split(".")[0])
if ($major -lt 22) { throw "Node.js 22 or newer is required (found $(node -v)). Install the LTS from https://nodejs.org" }
Write-Host "Node $(node -v) OK"

# 2. Dependencies
Write-Host "Installing backend dependencies..."
npm ci
Write-Host "Installing desktop app dependencies (downloads Electron, ~100 MB)..."
Push-Location desktop; npm ci; Pop-Location

# 3. .env with generated secrets
if (-not (Test-Path .env)) {
  $rand = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 32; $rand.GetBytes($bytes); $enc = [Convert]::ToBase64String($bytes)
  $tok = -join ((48..57) + (65..90) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
  (Get-Content .env.example) `
    -replace '^JARVIS_SETUP_TOKEN=.*', "JARVIS_SETUP_TOKEN=$tok" `
    -replace '^JARVIS_ENCRYPTION_KEY=.*', "JARVIS_ENCRYPTION_KEY=$enc" `
    -replace '^PUBLIC_URL=.*', "PUBLIC_URL=http://localhost:3000" | Set-Content .env
  Write-Host "Created .env — your setup code is: $tok" -ForegroundColor Green
} else { Write-Host ".env already exists (left unchanged)" }

Write-Host "`nNext:" -ForegroundColor Magenta
Write-Host "  1. Open .env in Notepad and paste ANTHROPIC_API_KEY (and OPENAI_API_KEY for voice input)."
Write-Host "  2. Run:  powershell -ExecutionPolicy Bypass -File scripts\windows\start-dev.ps1"
