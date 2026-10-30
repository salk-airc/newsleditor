<#
  Removes what install.ps1 put on this computer. Run as administrator:
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-KeepData] [-KeepTunnel]

  Removes the startup task, C:\Program Files\newsleditor (Node.js and the app)
  and C:\ProgramData\newsleditor (settings, log and THE NEWSLETTER'S DATA,
  unless -KeepData), and the cloudflared tunnel service with cloudflared
  itself (unless -KeepTunnel: another service on this computer may use it).
#>

[CmdletBinding()]
param([switch]$KeepData, [switch]$KeepTunnel)

$ErrorActionPreference = "Stop"
$Root = Join-Path $env:ProgramFiles "newsleditor"
$DataRoot = Join-Path $env:ProgramData "newsleditor"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Run this as administrator." -ForegroundColor Red; exit 1
}

if (Get-ScheduledTask -TaskName newsleditor -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName newsleditor
  Unregister-ScheduledTask -TaskName newsleditor -Confirm:$false
  Write-Host "Removed the startup task."
}
$node = Join-Path $Root "node\node.exe"
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $node } | Stop-Process -Force
Start-Sleep -Seconds 2

if (-not $KeepTunnel) {
  $cf = @("${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($cf -and (Get-Service -Name cloudflared -ErrorAction SilentlyContinue)) { & $cf service uninstall | Out-Null; Write-Host "Removed the tunnel service." }
  $product = Get-CimInstance Win32_Product -Filter "Name LIKE 'cloudflared%'" -ErrorAction SilentlyContinue
  if ($product) { Invoke-CimMethod -InputObject $product -MethodName Uninstall | Out-Null; Write-Host "Removed cloudflared." }
}

if (Test-Path $Root) { Remove-Item -Recurse -Force $Root; Write-Host "Removed $Root." }
if ($KeepData) {
  Write-Host "Kept $DataRoot (settings and the newsletter's data)."
} elseif (Test-Path $DataRoot) {
  Remove-Item -Recurse -Force $DataRoot; Write-Host "Removed $DataRoot."
}
Write-Host "newsleditor is uninstalled."
