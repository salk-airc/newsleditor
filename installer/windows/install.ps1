<#
  Installs newsleditor on a Windows computer from a setup code, or updates it.

  Double-click "Install newsleditor.cmd" (next to this file), or run:
    powershell -ExecutionPolicy Bypass -File install.ps1 [-SetupCode setup1.…] [-Source <zip>]

  1. Asks for administrator rights once (it installs a service and a startup task).
  2. Asks for the setup code, in a small window. Run again without a new code
     to update newsleditor and keep its settings.
  3. Gets Node.js (the current LTS, checked against nodejs.org's checksums)
     into the install folder, and the Microsoft Visual C++ runtime if the
     computer doesn't have it (newsleditor's native modules need it).
  4. Gets newsleditor (-Source: a zip of it; default the main branch on
     GitHub), writes its settings from the code, and builds it.
  5. If the code has a tunnel token: installs cloudflared and connects the
     tunnel as a Windows service, so the newsletter is at its address.
  6. Makes newsleditor start when the computer does (a scheduled task that
     runs as SYSTEM and restarts it if it stops), starts it, and opens it.

  Where things go:
    C:\Program Files\newsleditor\        node\ and app\ (replaced on update)
    C:\ProgramData\newsleditor\          newsleditor.env (its settings), data\
                                         (the newsletter: back this up), install.log

  The setup code ("setup1." and base64url JSON: url, env, tunnelToken) holds
  keys, so it's never written anywhere but the settings file, which only
  administrators can read.
#>

[CmdletBinding()]
param(
  [string]$SetupCode,
  [string]$Source = "https://codeload.github.com/salk-airc/newsleditor/zip/refs/heads/main",
  [switch]$NoGui
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is far faster without its progress bar
# Every download uses -UseBasicParsing: without it, Windows PowerShell 5.1 needs Internet Explorer, which current Windows doesn't have.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Join-Path $env:ProgramFiles "newsleditor"
$NodeDir = Join-Path $Root "node"
$AppDir = Join-Path $Root "app"
$DataRoot = Join-Path $env:ProgramData "newsleditor"
$Config = Join-Path $DataRoot "newsleditor.env"
$TaskName = "newsleditor"
$Port = 4321
$MinNode = [version]"22.18.0"
# The newest Node.js major to install: better-sqlite3 has to have a ready-made
# Windows build for it, or npm tries to compile it (which needs Visual Studio).
# Raise it once its releases include win32-x64 for the next major.
$MaxNodeMajor = 26

function Say($text) { Write-Host ""; Write-Host $text -ForegroundColor Cyan }
# Runs a program (npm, node, cloudflared), judged by its exit code alone. Windows
# PowerShell 5.1 turns anything a program writes to stderr into an error when
# output is redirected, and with $ErrorActionPreference = "Stop" a notice from npm
# would end the install.
function Invoke-Program([string]$exe) {
  $before = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $exe @args 2>&1 | ForEach-Object { Write-Host "$_" } } finally { $ErrorActionPreference = $before }
  return $LASTEXITCODE
}
function Fail($text) {
  Write-Host ""; Write-Host $text -ForegroundColor Red
  if (-not $NoGui) { Read-Host "Press Enter to close" | Out-Null }
  exit 1
}

# ------------------------------------------------------------------ admin --

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  # Again as administrator. The setup code is asked for after this, so it's
  # never on a command line.
  $relaunch = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-Source", "`"$Source`"")
  if ($NoGui) { $relaunch += "-NoGui" }
  try { Start-Process powershell -Verb RunAs -ArgumentList $relaunch | Out-Null } catch { Fail "newsleditor needs administrator rights to install. Run it again and choose Yes." }
  exit 0
}

New-Item -ItemType Directory -Force -Path $Root, $DataRoot, (Join-Path $DataRoot "data") | Out-Null
# The newsletter's data and settings: administrators and SYSTEM (which runs it) only.
icacls $DataRoot /inheritance:r /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null

# ------------------------------------------------------------- setup code --

function Read-SetupCodeWindow([bool]$canKeep) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $form = New-Object Windows.Forms.Form -Property @{
    Text = "Install newsleditor"; Width = 560; Height = 300; StartPosition = "CenterScreen"
    FormBorderStyle = "FixedDialog"; MaximizeBox = $false; Font = New-Object Drawing.Font("Segoe UI", 10)
  }
  $label = New-Object Windows.Forms.Label -Property @{
    Left = 16; Top = 14; Width = 510; Height = 44
    Text = if ($canKeep) { "Paste a new setup code, or leave it empty to update newsleditor and keep its settings." }
           else { "Paste the setup code you were given for this newsletter." }
  }
  $box = New-Object Windows.Forms.TextBox -Property @{ Left = 16; Top = 62; Width = 510; Height = 130; Multiline = $true; ScrollBars = "Vertical" }
  $ok = New-Object Windows.Forms.Button -Property @{ Text = "Install"; Left = 340; Top = 206; Width = 90; DialogResult = "OK" }
  $cancel = New-Object Windows.Forms.Button -Property @{ Text = "Cancel"; Left = 436; Top = 206; Width = 90; DialogResult = "Cancel" }
  $form.Controls.AddRange(@($label, $box, $ok, $cancel)); $form.AcceptButton = $ok; $form.CancelButton = $cancel
  if ($form.ShowDialog() -ne "OK") { exit 0 }
  $box.Text
}

function ConvertFrom-SetupCode([string]$text) {
  $text = ($text -replace "\s", "")
  if (-not $text.StartsWith("setup1.")) { return $null }
  $b64 = $text.Substring(7).Replace("-", "+").Replace("_", "/")
  $b64 += "=" * ((4 - $b64.Length % 4) % 4)
  try {
    $code = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) | ConvertFrom-Json
  } catch { return $null }
  if (-not $code.url -or -not $code.env) { return $null }
  $code
}

$haveConfig = Test-Path $Config
if (-not $SetupCode) {
  $SetupCode = if ($NoGui) {
    Read-Host ($(if ($haveConfig) { "Setup code (Enter to keep the current settings)" } else { "Setup code" }))
  } else { Read-SetupCodeWindow $haveConfig }
}
$code = $null
if ($SetupCode.Trim()) {
  $code = ConvertFrom-SetupCode $SetupCode
  if (-not $code) { Fail "That isn't a setup code: it should start with setup1. Copy it again from the page that gave it to you." }
} elseif (-not $haveConfig) {
  Fail "newsleditor needs a setup code to install."
}
# From here on, into the log. (Not before: a transcript records what's typed at Read-Host, which would be the code.)
Start-Transcript -Path (Join-Path $DataRoot "install.log") -Append | Out-Null

# ---------------------------------------------------------------- node.js --

function Get-NodeVersion {
  $exe = Join-Path $NodeDir "node.exe"
  if (-not (Test-Path $exe)) { return $null }
  [version]((& $exe --version).TrimStart("v"))
}

$have = Get-NodeVersion
if (-not $have -or $have -lt $MinNode -or $have.Major -gt $MaxNodeMajor) {
  Say "Getting Node.js"
  $release = (Invoke-RestMethod "https://nodejs.org/dist/index.json") |
    Where-Object {
      # LTS releases only, checked before the version is read: the list also has
      # pre-releases ("v27.0.0-alpha…"), which aren't plain version numbers.
      $_.lts -and $_.version -match '^v\d+\.\d+\.\d+$' -and $_.files -contains "win-x64-zip" -and
        [version]$_.version.TrimStart("v") -ge $MinNode -and ([version]$_.version.TrimStart("v")).Major -le $MaxNodeMajor
    } |
    Select-Object -First 1
  if (-not $release) { Fail "Couldn't find a Node.js release to install." }
  $name = "node-$($release.version)-win-x64"
  $zip = Join-Path $env:TEMP "$name.zip"
  Invoke-WebRequest "https://nodejs.org/dist/$($release.version)/$name.zip" -OutFile $zip -UseBasicParsing
  $sums = (Invoke-WebRequest "https://nodejs.org/dist/$($release.version)/SHASUMS256.txt" -UseBasicParsing).Content
  $want = ($sums -split "`n" | Where-Object { $_ -match " $name\.zip$" }) -replace "\s.*", ""
  if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $want.ToUpper()) { Fail "The Node.js download didn't match its checksum. Try again." }
  $tmp = Join-Path $env:TEMP "newsleditor-node"
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Expand-Archive $zip -DestinationPath $tmp
  Remove-Item -Recurse -Force $NodeDir -ErrorAction SilentlyContinue
  Move-Item (Join-Path $tmp $name) $NodeDir
  Remove-Item -Recurse -Force $tmp, $zip
  Write-Host "Node.js $($release.version)"
}
# The Microsoft Visual C++ runtime: newsleditor's native modules (satteri's
# markdown parser) need VCRUNTIME140.dll. Node.js carries its own copy inside,
# so a fresh Windows can run Node and still not have it. It's shared with other
# software, so uninstall.ps1 leaves it.
if (-not (Test-Path (Join-Path $env:SystemRoot "System32\vcruntime140.dll"))) {
  Say "Installing the Microsoft Visual C++ runtime"
  $vc = Join-Path $env:TEMP "vc_redist.x64.exe"
  Invoke-WebRequest "https://aka.ms/vs/17/release/vc_redist.x64.exe" -OutFile $vc -UseBasicParsing
  $sig = Get-AuthenticodeSignature $vc
  if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Subject -notlike "*O=Microsoft Corporation*") {
    Remove-Item $vc; Fail "The Visual C++ runtime download wasn't signed by Microsoft. Try again."
  }
  $p = Start-Process $vc -ArgumentList "/install /quiet /norestart" -Wait -PassThru
  Remove-Item $vc
  # 1638: a newer one is already there; 3010: installed, a restart finishes it (not needed to load it).
  if ($p.ExitCode -notin 0, 1638, 3010) { Fail "Installing the Visual C++ runtime failed (code $($p.ExitCode))." }
}

$env:Path = "$NodeDir;$env:Path"
$node = Join-Path $NodeDir "node.exe"
$npm = Join-Path $NodeDir "npm.cmd"

# ---------------------------------------------------------- newsleditor --

Say "Getting newsleditor"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName $TaskName }
# scripts\start.mjs runs the server as a second node process, which can outlive the task: stop ours.
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $node } | Stop-Process -Force
Start-Sleep -Seconds 2
$zip = Join-Path $env:TEMP "newsleditor.zip"
if (Test-Path $Source) { Copy-Item $Source $zip } else { Invoke-WebRequest $Source -OutFile $zip -UseBasicParsing }
$tmp = Join-Path $env:TEMP "newsleditor-app"
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Expand-Archive $zip -DestinationPath $tmp
# GitHub's zips hold one folder (newsleditor-main); use whatever it's called.
$inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
if (-not (Test-Path (Join-Path $inner.FullName "package.json"))) { Fail "That download isn't newsleditor." }
Remove-Item -Recurse -Force $AppDir -ErrorAction SilentlyContinue
Move-Item $inner.FullName $AppDir
Remove-Item -Recurse -Force $tmp, $zip

# Its settings: from the code when there is one, else the ones already here.
if ($code) {
  $lines = @("# newsleditor's settings, from its setup code. Written by the installer; a new code replaces them.")
  foreach ($p in $code.env.PSObject.Properties) { $lines += "$($p.Name)=$($p.Value)" }
  $lines += "DATA_DIR=$(Join-Path $DataRoot 'data')", "PORT=$Port", "HOST=localhost"
  # UTF-8 without a byte-order mark (Set-Content -Encoding UTF8 adds one in Windows PowerShell).
  [IO.File]::WriteAllLines($Config, [string[]]$lines)
}
$envFile = Join-Path $AppDir ".env"
Copy-Item $Config $envFile
# Program Files lets every user read; this copy holds keys too.
icacls $envFile /inheritance:r /grant:r "Administrators:F" "SYSTEM:F" | Out-Null
$url = ((Get-Content $Config) | Where-Object { $_ -like "SITE_URL=*" }) -replace "^SITE_URL=", ""

Say "Installing and building newsleditor (a few minutes)"
Push-Location $AppDir
try {
  $env:npm_config_update_notifier = "false"
  if ((Invoke-Program $npm ci --no-audit --no-fund --loglevel=error) -ne 0) { Fail "Installing newsleditor's packages failed (see $DataRoot\install.log)." }
  if ((Invoke-Program $node (Join-Path $AppDir "node_modules\astro\bin\astro.mjs") build) -ne 0) { Fail "Building newsleditor failed (see $DataRoot\install.log)." }
} finally { Pop-Location }

# ------------------------------------------------------------- the tunnel --

if ($code -and $code.tunnelToken) {
  Say "Connecting it to $url"
  $cf = @("${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $cf) {
    $msi = Join-Path $env:TEMP "cloudflared.msi"
    Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi" -OutFile $msi -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
    Remove-Item $msi
    $cf = @("${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $cf) { Fail "Installing cloudflared failed." }
  }
  # One tunnel service per computer: replace one from an earlier code.
  if (Get-Service -Name cloudflared -ErrorAction SilentlyContinue) { Invoke-Program $cf service uninstall | Out-Null; Start-Sleep -Seconds 2 }
  if ((Invoke-Program $cf service install $code.tunnelToken) -ne 0) { Fail "Connecting the tunnel failed (see $DataRoot\install.log)." }
}

# ------------------------------------------------------- start at boot --

Say "Making it start with the computer"
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$(Join-Path $AppDir 'scripts\start.mjs')`"" -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$up = $false
foreach ($i in 1..90) {
  try { Invoke-WebRequest "http://localhost:$Port/favicon.svg" -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true; break } catch { Start-Sleep -Seconds 2 }
}
if (-not $up) { Fail "newsleditor didn't start. Its log: $DataRoot\install.log; restart it with: Start-ScheduledTask $TaskName" }

$open = if ($url) { $url } else { "http://localhost:$Port" }
Say "Done: newsleditor is running at $open"
Write-Host "It starts by itself when this computer does. Keep the computer on: that's where the newsletter lives."
Write-Host "To update it later, run the installer again and leave the setup code empty."
Stop-Transcript | Out-Null
try { Start-Process $open } catch { }   # no desktop (a remote session): nothing to open it in
if (-not $NoGui) { Read-Host "Press Enter to close" | Out-Null }
