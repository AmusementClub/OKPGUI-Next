# Stage official MediaInfo CLI binaries into src-tauri/binaries/ for Tauri externalBin.
# Verifies archive and final executable sha256; fail-closed on unknown targets.
# macOS targets are not supported on Windows hosts.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Target,

    [string]$ManifestPath = "",
    [string]$StageDir = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Die([string]$Message) {
    Write-Error "error: $Message"
    exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Resolve-Path (Join-Path $ScriptDir "..")

if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $ManifestPath = Join-Path $ScriptDir "mediainfo-manifest.json"
}
if ([string]::IsNullOrWhiteSpace($StageDir)) {
    $StageDir = Join-Path $RootDir "src-tauri\binaries"
}

if (-not (Test-Path -LiteralPath $ManifestPath)) {
    Die "manifest not found: $ManifestPath"
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$known = @($manifest.targets.PSObject.Properties | ForEach-Object { $_.Name })
if ($known -notcontains $Target) {
    Die "unknown or missing target '$Target' (not listed in manifest). Known: $($known -join ', ')"
}

$entry = $manifest.targets.$Target
if ($null -eq $entry) {
    Die "unknown or missing target '$Target' (not listed in manifest)"
}

if ($entry.platform -eq "macos") {
    Die "macOS target '$Target' cannot be staged on Windows. Run scripts/stage-mediainfo.sh on macOS instead."
}

$url = [string]$entry.archive.url
$archiveSha = [string]$entry.archive.sha256.ToLowerInvariant()
$archiveFormat = [string]$entry.archive.format
$extractedPath = [string]$entry.extracted.path
$extractedSha = [string]$entry.extracted.sha256.ToLowerInvariant()
$stagedName = [string]$entry.staged_name

if (-not $url.StartsWith("https://mediaarea.net/")) {
    Die "refusing non-official URL from manifest: $url"
}

if ($archiveFormat -ne "zip") {
    Die "unsupported archive format '$archiveFormat' for Windows staging of target $Target"
}

function Get-Sha256Hex([string]$Path) {
    $hash = Get-FileHash -LiteralPath $Path -Algorithm SHA256
    return $hash.Hash.ToLowerInvariant()
}

New-Item -ItemType Directory -Path $StageDir -Force | Out-Null

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("okpgui-mediainfo-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

try {
    $archiveFile = Join-Path $workDir "archive.zip"
    $extractDir = Join-Path $workDir "extract"
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

    Write-Host "Downloading MediaInfo $Target from official URL..."
    Invoke-WebRequest -Uri $url -OutFile $archiveFile -UseBasicParsing

    $gotArchiveSha = Get-Sha256Hex $archiveFile
    if ($gotArchiveSha -ne $archiveSha) {
        Die "archive sha256 mismatch for ${Target}: expected $archiveSha, got $gotArchiveSha"
    }
    Write-Host "Archive sha256 verified."

    Expand-Archive -LiteralPath $archiveFile -DestinationPath $extractDir -Force

    if ($extractedPath.StartsWith("/") -or $extractedPath.StartsWith("\")) {
        Die "zip extracted path must be relative, got $extractedPath"
    }

    $extractedBin = Join-Path $extractDir ($extractedPath -replace "/", [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $extractedBin -PathType Leaf)) {
        Die "extracted binary missing: $extractedBin"
    }

    $gotBinSha = Get-Sha256Hex $extractedBin
    if ($gotBinSha -ne $extractedSha) {
        Die "executable sha256 mismatch for ${Target}: expected $extractedSha, got $gotBinSha"
    }
    Write-Host "Executable sha256 verified."

    $stagedPath = Join-Path $StageDir $stagedName
    # Replace only the specific staged file for this target (no broad cleanup).
    Copy-Item -LiteralPath $extractedBin -Destination $stagedPath -Force

    $finalSha = Get-Sha256Hex $stagedPath
    if ($finalSha -ne $extractedSha) {
        Die "staged executable sha256 mismatch for ${Target}: expected $extractedSha, got $finalSha"
    }

    # Host-appropriate smoke check: prove the pinned official binary actually runs.
    # Does not rewrite manifest URL/hash on failure — fail closed instead.
    function Invoke-MediaInfoSmokeCheck {
        param(
            [string]$StagedPath,
            [string]$SmokeTarget
        )
        $isWindowsHost = $env:OS -eq 'Windows_NT'
        $canExec = $false
        switch ($SmokeTarget) {
            'x86_64-pc-windows-msvc' {
                $canExec = $isWindowsHost
            }
            'x86_64-unknown-linux-gnu' {
                # PowerShell staging is Windows-oriented; Linux must use stage-mediainfo.sh.
                Die "Linux MediaInfo target must be staged and smoke-checked via scripts/stage-mediainfo.sh on Linux"
            }
            default {
                Die "smoke check: unhandled or unsupported target on Windows host: $SmokeTarget"
            }
        }

        if (-not $canExec) {
            Write-Host "Smoke check skipped: host cannot execute $SmokeTarget."
            return
        }

        $version = & $StagedPath --Version 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Smoke check OK: $StagedPath --Version"
            return
        }
        $help = & $StagedPath --Help 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Smoke check OK: $StagedPath --Help"
            return
        }
        Die "smoke check failed: staged MediaInfo binary for $SmokeTarget did not run ($StagedPath). Manifest URL/hash left unchanged. version=$version help=$help"
    }

    Invoke-MediaInfoSmokeCheck -StagedPath $stagedPath -SmokeTarget $Target

    Write-Host "Staged $stagedPath"
    Write-Host "OK: MediaInfo $Target ready for Tauri externalBin (binaries/mediainfo)"
}
finally {
    if (Test-Path -LiteralPath $workDir) {
        Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
