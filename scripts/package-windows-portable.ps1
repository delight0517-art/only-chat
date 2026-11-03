param([string]$ReleaseDir = (Join-Path $PSScriptRoot '..\dist\OnlyChat_Windows_1.0.1_x64_2026-10-27'))
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ReleaseDir = if ([System.IO.Path]::IsPathRooted($ReleaseDir)) { [System.IO.Path]::GetFullPath($ReleaseDir) } else { [System.IO.Path]::GetFullPath((Join-Path $Root $ReleaseDir)) }
$AppDir = Join-Path $ReleaseDir 'win-unpacked'
$PortableDir = Join-Path $ReleaseDir 'Only Chat Portable'
$ZipPath = Join-Path $ReleaseDir 'Only Chat Portable x64.zip'
if (-not (Test-Path (Join-Path $AppDir 'Only Chat.exe'))) { throw 'Build the Windows x64 app before packaging the portable ZIP.' }
if (Test-Path $ZipPath) { throw "Output already exists; move it yourself before rebuilding: $ZipPath" }
if (Test-Path $PortableDir) { throw "Output already exists; move it yourself before rebuilding: $PortableDir" }
Move-Item -LiteralPath $AppDir -Destination $PortableDir
Compress-Archive -Path $PortableDir -DestinationPath $ZipPath -CompressionLevel Optimal
Write-Host "Portable Windows app folder archived: $ZipPath"
