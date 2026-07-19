#requires -Version 5.1
$ErrorActionPreference = 'Stop'

$mainScript = Join-Path $PSScriptRoot 'SpotifyLyricsJP-Store.ps1'
$dataDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'SpotifyLyricsJPStore'
$launcherLog = Join-Path $dataDirectory 'Startup.log'

function Write-LauncherLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -LiteralPath $launcherLog -Value "[$stamp] $Message" -Encoding UTF8
}

try {
    New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
    Write-LauncherLog 'Launcher 1.4.1 started.'

    if (-not (Test-Path -LiteralPath $mainScript -PathType Leaf)) {
        throw "Main script was not found: $mainScript"
    }

    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        $mainScript,
        [ref]$tokens,
        [ref]$parseErrors
    )
    if (@($parseErrors).Count -gt 0) {
        foreach ($parseError in $parseErrors) {
            $line = $parseError.Extent.StartLineNumber
            Write-LauncherLog "Parse error at line $line`: $($parseError.Message)"
        }
        throw "PowerShell could not read the main script. Parse errors: $(@($parseErrors).Count)"
    }

    Write-Host ''
    Write-Host 'Spotify Lyrics JP 1.4.1' -ForegroundColor Cyan
    Write-Host 'この黒い画面は、動作確認が終わるまで開いたままで正常です。' -ForegroundColor Gray
    Write-Host ''
    Write-LauncherLog 'Main script syntax check passed.'
    & $mainScript
    Write-LauncherLog 'Main script exited normally.'
} catch {
    $details = ($_ | Out-String).Trim()
    try { Write-LauncherLog "Startup failed: $details" } catch {}

    Write-Host ''
    Write-Host '起動エラーが発生しました。' -ForegroundColor Red
    Write-Host $details -ForegroundColor Red
    Write-Host ''
    Write-Host "ログ: $launcherLog" -ForegroundColor Yellow
    try { Start-Process notepad.exe -ArgumentList @($launcherLog) } catch {}
    [void](Read-Host 'この画面の写真を撮ってから、Enterを押してください')
    exit 1
}
