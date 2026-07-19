#requires -Version 5.1
$ErrorActionPreference = 'Continue'

function Write-Result {
    param([string]$Name, [bool]$Passed, [string]$Detail)
    $color = if ($Passed) { 'Green' } else { 'Yellow' }
    $mark = if ($Passed) { 'OK' } else { '確認' }
    Write-Host "[$mark] $Name - $Detail" -ForegroundColor $color
}

function Await-WinRT {
    param(
        [Parameter(Mandatory = $true)][object]$Operation,
        [Parameter(Mandatory = $true)][type]$ResultType
    )

    $asTaskGeneric = @(
        [System.WindowsRuntimeSystemExtensions].GetMethods() |
            Where-Object {
                $_.Name -eq 'AsTask' -and
                $_.IsGenericMethodDefinition -and
                $_.GetParameters().Count -eq 1 -and
                $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
            }
    )[0]
    if (-not $asTaskGeneric) {
        throw 'Windows Runtime の非同期変換メソッドを取得できませんでした。'
    }
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $task = $asTask.Invoke($null, @($Operation))
    return $task.GetAwaiter().GetResult()
}

Write-Host ''
Write-Host 'Spotify Lyrics JP — 診断' -ForegroundColor Cyan
Write-Host '--------------------------------' -ForegroundColor DarkGray

$isWindows = $env:OS -eq 'Windows_NT'
$windowsDetail = if ($isWindows) { [Environment]::OSVersion.VersionString } else { 'Windowsではありません' }
Write-Result 'Windows' $isWindows $windowsDetail

$build = [Environment]::OSVersion.Version.Build
Write-Result 'Windows バージョン' ($build -ge 17763) "build $build（Windows 10 1809以降が必要）"

$psOkay = $PSVersionTable.PSVersion.Major -ge 5
Write-Result 'PowerShell' $psOkay $PSVersionTable.PSVersion.ToString()

try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Write-Result '画面表示コンポーネント' $true '利用できます'
} catch {
    Write-Result '画面表示コンポーネント' $false $_.Exception.Message
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $operation = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
    $manager = Await-WinRT $operation ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $sessions = @($manager.GetSessions())
    $spotify = $sessions | Where-Object { $_.SourceAppUserModelId -match '(?i)spotify' } | Select-Object -First 1
    if ($spotify) {
        Write-Result 'Spotify 再生セッション' $true $spotify.SourceAppUserModelId
    } else {
        Write-Result 'Spotify 再生セッション' $false 'Spotifyで任意の曲を再生してからもう一度実行してください'
    }
} catch {
    Write-Result 'Windows 再生情報API' $false $_.Exception.Message
}

try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'https://lrclib.net/api/search?track_name=hello&artist_name=adele' -TimeoutSec 12
    Write-Result 'LRCLIBへの接続' ($response.StatusCode -eq 200) "HTTP $($response.StatusCode)"
} catch {
    Write-Result 'LRCLIBへの接続' $false $_.Exception.Message
}

try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'https://api.lyrics.ovh/v1/Adele/Hello' -TimeoutSec 12
    Write-Result 'Lyrics.ovhへの接続' ($response.StatusCode -eq 200) "HTTP $($response.StatusCode)"
} catch {
    Write-Result 'Lyrics.ovhへの接続' $false $_.Exception.Message
}

try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'https://wilooper-lyrica.hf.space/' -TimeoutSec 15
    Write-Result 'Lyrica同期歌詞への接続' ($response.StatusCode -eq 200) "HTTP $($response.StatusCode)"
} catch {
    Write-Result 'Lyrica同期歌詞への接続' $false $_.Exception.Message
}

Write-Host ''
Write-Host '「確認」があれば、その行を含めてスクリーンショットを送ってください。' -ForegroundColor Gray
