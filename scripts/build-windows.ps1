# scripts/build-windows.ps1
$ErrorActionPreference = "Stop"

Write-Host "==> 1. Checking Wails CLI..." -ForegroundColor Cyan
if (-not (Get-Command wails -ErrorAction SilentlyContinue)) {
    Write-Host "Wails CLI not found in PATH. Installing wails v2.17.0..."
    go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.0
}

Write-Host "==> 2. Building Frontend..." -ForegroundColor Cyan
Push-Location frontend
if (-not (Test-Path node_modules)) {
    npm install
}
npm run build
Pop-Location

Write-Host "==> 3. Building Desktop App with Wails..." -ForegroundColor Cyan
wails build

Write-Host "`n==> SUCCESS! Executable built at: build\bin\vvterm.exe" -ForegroundColor Green
