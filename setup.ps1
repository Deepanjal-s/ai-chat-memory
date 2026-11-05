<#
  Conversation Memory - one-step installer for Windows.

  Run by double-clicking setup.cmd (or: powershell -ExecutionPolicy Bypass -File setup.ps1).
  It will:
    1. check that Node.js 22+ is installed,
    2. ask for a sign-in password, a data folder (outside OneDrive) and an optional Gemini API key,
    3. install dependencies and build the app,
    4. write the configuration file (.env.local),
    5. start the app automatically when you sign in to Windows, and add a desktop shortcut,
    6. start it now and open it in your browser.
  Nothing is sent anywhere during installation except downloading the app's packages from npm.
#>
param(
  [switch]$NoAutostart,   # do not add the app to Windows sign-in
  [switch]$NoShortcut,    # do not add a desktop shortcut
  [switch]$NoStart,       # do not start the app at the end
  [switch]$DryRun,        # show what would happen, change nothing
  # Unattended install (for IT): answers that are otherwise asked interactively.
  [string]$DataDir,
  [string]$Password,
  [string]$GeminiKey,
  [string]$WatchDir
)
$ErrorActionPreference = 'Stop'
$App = $PSScriptRoot
Set-Location $App

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "`n$text" -ForegroundColor Red; if (-not $Password) { Read-Host 'Press Enter to close' }; exit 1 }
function Run($what, [scriptblock]$action) {
  if ($DryRun) { Write-Host "    [dry run] $what" -ForegroundColor DarkGray } else { & $action }
}
function PlainText([Security.SecureString]$s) {
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}

Write-Host 'Conversation Memory - setup' -ForegroundColor Green

# 1. Node.js -------------------------------------------------------------------------------
Step 'Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js is not installed. Install the LTS version from https://nodejs.org (version 22 or newer), then run setup again.' }
$major = [int]((node -v).Trim().TrimStart('v').Split('.')[0])
if ($major -lt 22) { Fail "Node.js $major is too old. Install version 22 or newer from https://nodejs.org, then run setup again." }
Write-Host "    Node.js $(node -v) found"

# 2. Questions -----------------------------------------------------------------------------
$envFile = Join-Path $App '.env.local'
$reuse = $false
$unattended = [bool]$Password
if ((Test-Path $envFile) -and -not $unattended) {
  $answer = Read-Host 'A configuration already exists. Keep it and only update/rebuild the app? (Y/n)'
  $reuse = ($answer -eq '' -or $answer -match '^[Yy]')
}

if (-not $reuse) {
  Step 'Data folder'
  $defaultData = 'C:\ConversationMemory\data'
  $dataDir = if ($unattended) { $DataDir } else { Read-Host "Where should conversations be stored? Press Enter for $defaultData" }
  if (-not $dataDir) { $dataDir = $defaultData }
  if ($dataDir -match 'OneDrive|Dropbox|Google Drive' -and -not $unattended) {
    Write-Host '    Warning: this folder is synced to the cloud. Confidential conversations would be uploaded there.' -ForegroundColor Yellow
    if ((Read-Host '    Use it anyway? (y/N)') -notmatch '^[Yy]') { Fail 'Setup stopped. Run it again and choose a folder outside OneDrive.' }
  }

  Step 'Sign-in password'
  if ($unattended) {
    if ($Password.Length -lt 10) { Fail 'The password must be at least 10 characters.' }
    $p1 = $Password
  }
  while (-not $unattended) {
    $p1 = PlainText (Read-Host 'Choose a password (at least 10 characters)' -AsSecureString)
    $p2 = PlainText (Read-Host 'Type it again' -AsSecureString)
    if ($p1.Length -lt 10) { Write-Host '    Too short.' -ForegroundColor Yellow; continue }
    if ($p1 -ne $p2) { Write-Host '    The two passwords differ.' -ForegroundColor Yellow; continue }
    break
  }

  Step 'AI (optional)'
  Write-Host '    With a Google Gemini API key the app writes answers and finds decisions more accurately.'
  Write-Host '    Conversation excerpts are then sent to Google. On the FREE tier Google may use them to improve'
  Write-Host '    its products - enable billing on the Google project before using confidential conversations.'
  $gemini = if ($unattended) { $GeminiKey } else { PlainText (Read-Host 'Gemini API key (press Enter to skip and keep everything on this PC)' -AsSecureString) }

  $watch = if ($WatchDir) { $WatchDir } else { Join-Path $env:USERPROFILE 'Downloads' }
}

# 3. Install and build -----------------------------------------------------------------------
Step 'Installing packages (a few minutes the first time)'
Run 'npm ci' { npm ci --no-audit --no-fund; if ($LASTEXITCODE) { Fail 'Installing packages failed. Check the internet connection and try again.' } }

if (-not $reuse) {
  Step 'Writing configuration'
  Run "create $dataDir and .env.local" {
    New-Item -ItemType Directory -Force $dataDir | Out-Null
    $hashLine = (npx --yes tsx scripts/hash-password.ts $p1) | Select-String '^APP_PASSWORD_HASH='
    if (-not $hashLine) { Fail 'Could not create the password hash.' }
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    $provider = if ($gemini) { 'gemini' } else { 'none' }
    @(
      '# Created by setup.ps1. Keep this file private: it controls access to the app.',
      "DATA_DIR=$dataDir",
      'DATABASE_URL=',
      "$hashLine",
      "SESSION_SECRET=$secret",
      'SESSION_TTL_HOURS=12',
      'WATCH_ENABLED=true',
      "WATCH_DIR=$watch",
      "AI_PROVIDER=$provider",
      "GEMINI_API_KEY=$gemini",
      'EMBEDDING_PROVIDER=none'
    ) | Set-Content -Encoding utf8 $envFile
    # Only the current Windows user may read the configuration.
    icacls $envFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  }
}

Step 'Building the app'
Run 'npm run build' { npm run build; if ($LASTEXITCODE) { Fail 'Building the app failed. See the messages above.' } }

# 4. Start with Windows + shortcut ----------------------------------------------------------
$startCmd = Join-Path $App 'start-memory.cmd'
$hidden = Join-Path $App 'start-hidden.vbs'
if (-not $NoAutostart) {
  Step 'Starting automatically when you sign in to Windows'
  Run 'add to Startup folder' {
    $startup = [Environment]::GetFolderPath('Startup')
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut((Join-Path $startup 'Conversation Memory.lnk'))
    $lnk.TargetPath = 'wscript.exe'
    $lnk.Arguments = "`"$hidden`""
    $lnk.WorkingDirectory = $App
    $lnk.Save()
  }
}
if (-not $NoShortcut) {
  Step 'Adding a desktop shortcut'
  Run 'create desktop shortcut' {
    $desktop = [Environment]::GetFolderPath('Desktop')
    "[InternetShortcut]`r`nURL=http://localhost:3000/`r`n" | Set-Content -Encoding ascii (Join-Path $desktop 'Conversation Memory.url')
  }
}

# 5. Start now ---------------------------------------------------------------------------
if (-not $NoStart) {
  Step 'Starting Conversation Memory'
  Run 'start app and open browser' {
    Start-Process wscript.exe -ArgumentList "`"$hidden`"" -WorkingDirectory $App
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Seconds 1
      try { Invoke-WebRequest -UseBasicParsing http://localhost:3000/login -TimeoutSec 2 | Out-Null; break } catch {}
    }
    Start-Process 'http://localhost:3000/'
  }
}

Write-Host "`nDone. Open Conversation Memory from the desktop shortcut and sign in with your password." -ForegroundColor Green
Write-Host 'Next: in ChatGPT, Settings -> Data controls -> Export data. When the email arrives, download the ZIP;'
Write-Host 'it is imported automatically from your Downloads folder. See GUIDE.md for everything else.'
if (-not $DryRun -and -not $unattended) { Read-Host "`nPress Enter to close" }
