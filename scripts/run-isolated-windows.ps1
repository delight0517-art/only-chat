param(
  [Parameter(Mandatory = $true)]
  [string]$AppPath
)

$ErrorActionPreference = 'Stop'
$ResolvedAppPath = (Resolve-Path -LiteralPath $AppPath).Path
$ProfilePath = Join-Path $env:TEMP ("OnlyChat-QA-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $ProfilePath | Out-Null
$PreviousProfile = $env:ONLY_CHAT_ISOLATED_PROFILE

try {
  $env:ONLY_CHAT_ISOLATED_PROFILE = $ProfilePath
  $Process = Start-Process -FilePath $ResolvedAppPath -Wait -PassThru
  if ($Process.ExitCode -ne 0) { throw "Only Chat exited with code $($Process.ExitCode)." }
} finally {
  if ($null -eq $PreviousProfile) { Remove-Item Env:ONLY_CHAT_ISOLATED_PROFILE -ErrorAction SilentlyContinue }
  else { $env:ONLY_CHAT_ISOLATED_PROFILE = $PreviousProfile }
  if (Test-Path -LiteralPath $ProfilePath) { Remove-Item -LiteralPath $ProfilePath -Recurse -Force }
}
