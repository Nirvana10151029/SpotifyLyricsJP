#requires -Version 5.1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Resolve-Spicetify {
    $command = Get-Command spicetify -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'spicetify\spicetify.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\spicetify.exe'),
        (Join-Path $env:USERPROFILE 'scoop\shims\spicetify.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Invoke-Spicetify {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & $script:Spicetify @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Spicetifyの実行に失敗しました: $($Arguments -join ' ')"
    }
}

try {
    Write-Host ''
    Write-Host 'Spotify Lyrics JP v2.0.1 セットアップ' -ForegroundColor Cyan
    Write-Host '----------------------------------------' -ForegroundColor DarkGray

    $spotifyExe = Join-Path $env:APPDATA 'Spotify\Spotify.exe'
    if (-not (Test-Path -LiteralPath $spotifyExe -PathType Leaf)) {
        $storeSpotify = Get-AppxPackage -Name 'SpotifyAB.SpotifyMusic' -ErrorAction SilentlyContinue
        Write-Host ''
        if ($storeSpotify) {
            Write-Host 'Microsoft Store版Spotifyが見つかりました。' -ForegroundColor Yellow
            Write-Host 'この内蔵版はSpotify公式サイトから入れた通常版が必要です。' -ForegroundColor Yellow
        } else {
            Write-Host 'Spotify公式サイト版が見つかりません。' -ForegroundColor Yellow
        }
        Write-Host '開いたページからSpotifyをインストール後、START-INSTALL.batをもう一度実行してください。'
        Start-Process 'https://www.spotify.com/jp/download/windows/'
        throw 'Spotify公式サイト版のインストールが必要です。'
    }

    $script:Spicetify = Resolve-Spicetify
    if (-not $script:Spicetify) {
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if (-not $winget) {
            Start-Process 'https://spicetify.app/docs/getting-started'
            throw 'Spicetifyが未導入で、wingetも見つかりません。開いた公式手順からSpicetifyを入れてください。'
        }
        Write-Host ''
        Write-Host 'Spicetifyを公式wingetパッケージからインストールします…' -ForegroundColor Cyan
        & $winget.Source install --id Spicetify.Spicetify -e --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { throw 'Spicetifyのインストールに失敗しました。' }
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
        $script:Spicetify = Resolve-Spicetify
        if (-not $script:Spicetify) {
            throw 'Spicetifyをインストールしましたが、実行ファイルを確認できません。Windowsを再起動してからもう一度お試しください。'
        }
    }

    $extensionSource = Join-Path $PSScriptRoot 'spotifyLyricsJP.js'
    if (-not (Test-Path -LiteralPath $extensionSource -PathType Leaf)) {
        throw "拡張ファイルが見つかりません: $extensionSource"
    }

    Write-Host ''
    Write-Host 'Spotifyを終了して拡張機能を組み込みます…' -ForegroundColor Cyan
    Get-Process -Name Spotify -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 800

    $extensionDirectory = Join-Path $env:APPDATA 'spicetify\Extensions'
    New-Item -ItemType Directory -Path $extensionDirectory -Force | Out-Null
    Copy-Item -LiteralPath $extensionSource -Destination (Join-Path $extensionDirectory 'spotifyLyricsJP.js') -Force

    Invoke-Spicetify -Arguments @('config', 'extensions', 'spotifyLyricsJP.js')
    Invoke-Spicetify -Arguments @('backup', 'apply')

    Write-Host ''
    Write-Host 'インストール完了です。Spotifyを起動します。' -ForegroundColor Green
    Write-Host '右側に「歌詞JP」が開きます。閉じた場合は上部の音符ボタンから再表示できます。'
    Start-Process -FilePath $spotifyExe
    exit 0
} catch {
    Write-Host ''
    Write-Host 'セットアップを完了できませんでした。' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
