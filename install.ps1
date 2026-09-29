# Install Yon on Windows (x64 or ARM64) from GitHub Releases.
#
#   Invoke-WebRequest https://yon.meo.in.th/pwsh -OutFile "$env:TEMP\yon-install.ps1"
#   notepad "$env:TEMP\yon-install.ps1"        (read it first)
#   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\yon-install.ps1"
#
# Options (environment variables, set before running):
#   $env:YON_VERSION = "0.2.3"   install this version instead of the latest
#   $env:YON_SILENT  = "1"       install without the installer's window
#
# What it does: downloads the installer from the release, checks its SHA-256
# against the release's SHA256SUMS.txt, then runs it (per user, no admin).
# WHY: this trusts GitHub (the repo and its releases) exactly as much as the
# installer download does; the checksum catches broken or swapped downloads,
# not a compromised repo. Updates later come from inside the app, which checks
# the update's signature against the key built into Yon.
#
# Everything runs inside a function, so a download cut off halfway runs nothing
# and errors never close your PowerShell window.
# Keep this file ASCII: Windows PowerShell 5.1 reads a file without a BOM as
# ANSI and garbles other characters.
function Install-Yon {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue" # 5.1 downloads crawl with the progress bar on
  $repo = "VacTuzX-dot/Yon"
  $tmp = $null
  try {
    # Windows PowerShell 5.1 may not offer TLS 1.2 by default.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    if ($env:YON_VERSION) {
      if ($env:YON_VERSION -notmatch '^\d+\.\d+\.\d+$') { throw "YON_VERSION must look like 0.2.3" }
      $base = "https://github.com/$repo/releases/download/v$($env:YON_VERSION)"
    } else {
      $base = "https://github.com/$repo/releases/latest/download"
    }

    # The machine's architecture, not this process's (a 32-bit or emulated
    # PowerShell reports a different one).
    $os = $null
    try { $os = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } catch { }
    if (-not $os) { $os = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE } }
    switch -Regex ($os) {
      '^(X64|AMD64)$' { $arch = "x64" }
      '^(Arm64|ARM64)$' { $arch = "arm64" }
      default { throw "Yon needs 64-bit Windows (x64 or ARM64); this machine is $os." }
    }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("yon-install-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp | Out-Null

    Write-Host "Checking the release..." -ForegroundColor White
    $sums = Join-Path $tmp "SHA256SUMS.txt"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS.txt" -OutFile $sums
    $pattern = "^([0-9a-fA-F]{64})  (Yon_\d+\.\d+\.\d+_$arch-setup\.exe)\s*$"
    $lines = @(Get-Content -Path $sums | Where-Object { $_ -match $pattern })
    if ($lines.Count -ne 1) { throw "the release has no single Windows installer for $arch." }
    $null = $lines[0] -match $pattern
    $sum = $Matches[1].ToLower()
    $name = $Matches[2]

    Write-Host "Downloading $name..." -ForegroundColor White
    $exe = Join-Path $tmp $name
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $exe
    if ((Get-FileHash -Algorithm SHA256 -Path $exe).Hash.ToLower() -ne $sum) {
      throw "the download doesn't match SHA256SUMS.txt. Nothing was installed."
    }

    Write-Host "Installing..." -ForegroundColor White
    $installer = @{ FilePath = $exe; Wait = $true; PassThru = $true }
    if ($env:YON_SILENT) { $installer.ArgumentList = "/S" }
    $run = Start-Process @installer
    if ($run.ExitCode -ne 0) { throw "the installer stopped with code $($run.ExitCode)." }
    Write-Host "Installed $name." -ForegroundColor Green
  } catch {
    Write-Host "Yon install: $($_.Exception.Message)" -ForegroundColor Red
  } finally {
    if ($tmp -and (Test-Path $tmp)) { Remove-Item -Recurse -Force $tmp }
  }
}

Install-Yon
