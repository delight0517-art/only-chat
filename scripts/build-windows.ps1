param([string]$OutputDir = (Join-Path $PSScriptRoot '..\dist\OnlyChat_Windows_1.0.1_x64_2026-10-27\portable-folder'))
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
$DistRoot = [System.IO.Path]::GetFullPath((Join-Path $Root 'dist'))
if (-not $OutputDir.StartsWith($DistRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputDir must stay inside the versioned dist release folder.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 22.12 or newer is required. Install it from https://nodejs.org/ and rerun.'
}
$NodeVersion = (& node -p "process.versions.node").Trim()
if ([version]$NodeVersion -lt [version]'22.12') { throw "Node.js 22.12+ required; found $NodeVersion" }
if (Test-Path $OutputDir) { throw "OutputDir already exists; choose a new path or remove it yourself: $OutputDir" }
& (Join-Path $Root 'node_modules\.bin\electron-builder.cmd') --win dir --x64 "-c.directories.output=$OutputDir"
if (-not (Test-Path (Join-Path $OutputDir 'win-unpacked\Only Chat.exe'))) { throw 'Electron portable app output is missing.' }
Write-Host "Portable Windows app folder created: $(Join-Path $OutputDir 'win-unpacked')"
