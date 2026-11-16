# Starts the JARVIS backend locally and opens the Windows app connected to it (development mode).
# For everyday use, deploy the backend to the cloud (see README) and install JARVIS-Setup.exe instead.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
$root = Get-Location

Write-Host "Starting the JARVIS backend on http://localhost:3000 ..." -ForegroundColor Magenta
$backend = Start-Process -FilePath "npm" -ArgumentList "start" -WorkingDirectory $root -PassThru -WindowStyle Minimized

for ($i = 0; $i -lt 60; $i++) {
  try { if ((Invoke-WebRequest -UseBasicParsing http://localhost:3000/api/health/ping -TimeoutSec 2).StatusCode -eq 200) { break } } catch {}
  Start-Sleep -Milliseconds 500
}
Write-Host "Backend is up. Opening the JARVIS app (it lives in the tray when closed)..." -ForegroundColor Green
$env:JARVIS_SERVER_URL = "http://localhost:3000"
Push-Location desktop
try { npm start } finally { Pop-Location; if (-not $backend.HasExited) { Stop-Process -Id $backend.Id -Force } }
