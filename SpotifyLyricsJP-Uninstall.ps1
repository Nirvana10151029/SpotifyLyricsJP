#requires -Version 5.1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Resolve-Spicetify {
    $command = Get-Command spicetify -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA 'spicetify\spicetify.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\spicetify.exe'),
        (Join-Path $env:USERPROFILE 'scoop\shims\spicetify.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

try {
    Write-Host ''
    Write-Host 'Spotify Lyrics JPをSpotifyから取り外します…' -ForegroundColor Cyan
    $spicetify = Resolve-Spicetify
    if (-not $spicetify) { throw 'Spicetifyが見つかりません。' }

    Get-Process -Name Spotify -ErrorAction SilentlyContinue | Stop-Process -Force
    & $spicetify config extensions 'spotifyLyricsJP.js-'
    if ($LASTEXITCODE -ne 0) { throw '拡張機能の設定を削除できませんでした。' }
    & $spicetify apply
    if ($LASTEXITCODE -ne 0) { throw 'Spotifyへ変更を反映できませんでした。' }

    $extensionPath = Join-Path $env:APPDATA 'spicetify\Extensions\spotifyLyricsJP.js'
    if (Test-Path -LiteralPath $extensionPath -PathType Leaf) {
        Remove-Item -LiteralPath $extensionPath -Force
    }
    Write-Host '削除完了です。Spicetify本体とほかの拡張機能は残しています。' -ForegroundColor Green
    $spotifyExe = Join-Path $env:APPDATA 'Spotify\Spotify.exe'
    if (Test-Path -LiteralPath $spotifyExe -PathType Leaf) { Start-Process -FilePath $spotifyExe }
    exit 0
} catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
