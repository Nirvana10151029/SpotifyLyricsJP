#requires -Version 5.1
<#
  Spotify Lyrics JP (Store edition companion)
  Reads the active Spotify Windows media session, gets public lyrics from LRCLIB
  or Lyrics.ovh, and translates them to Japanese using free translation,
  Gemini, DeepL or GPT.
#>

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:AppName = 'Spotify Lyrics JP'
$script:Version = '1.4.1'
$script:DataDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'SpotifyLyricsJPStore'
$script:LogPath = Join-Path $script:DataDirectory 'SpotifyLyricsJPStore.log'
$script:SettingsPath = Join-Path $script:DataDirectory 'settings.json'
$script:TrackCache = @{}
$script:ForceAlternateKeys = @{}
$script:Manager = $null
$script:CurrentTrack = $null
$script:CurrentLyrics = $null
$script:DisplayedKey = ''
$script:LoadingKey = ''
$script:LineRanges = New-Object System.Collections.ArrayList
$script:ActiveLine = -1
$script:ManualScrollUntil = [datetime]::MinValue
$script:LastNoSessionNotice = [datetime]::MinValue
$script:LastErrorText = ''
$script:StatusLabel = $null
$script:TrackLabel = $null
$script:LyricsBox = $null
$script:OriginalCheck = $null
$script:AutoScrollCheck = $null
$script:TranslationModeCombo = $null
$script:TranslationMode = 'free'
$script:GeminiApiKey = ''
$script:DeepLApiKey = ''
$script:OpenAiApiKey = ''
$script:TranslationFallbackUsed = $false
$script:ChangingTranslationMode = $false
$script:MainForm = $null
$script:PollTimer = $null
$script:AsTaskGenericMethod = $null

try {
    New-Item -ItemType Directory -Path $script:DataDirectory -Force | Out-Null
} catch {
    # Logging is optional; the app can still run from a read-only location.
}

function Write-AppLog {
    param([string]$Message)
    try {
        $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        Add-Content -LiteralPath $script:LogPath -Value "[$stamp] $Message" -Encoding UTF8
    } catch {
        # Do not interrupt the player companion because logging failed.
    }
}

function Get-ErrorMessage {
    param([System.Management.Automation.ErrorRecord]$ErrorRecord)
    if ($ErrorRecord.Exception.InnerException) {
        return $ErrorRecord.Exception.InnerException.Message
    }
    return $ErrorRecord.Exception.Message
}

function Await-WinRT {
    param(
        [Parameter(Mandatory = $true)][object]$Operation,
        [Parameter(Mandatory = $true)][type]$ResultType
    )

    if (-not $script:AsTaskGenericMethod) {
        $script:AsTaskGenericMethod = @(
            [System.WindowsRuntimeSystemExtensions].GetMethods() |
                Where-Object {
                    $_.Name -eq 'AsTask' -and
                    $_.IsGenericMethodDefinition -and
                    $_.GetParameters().Count -eq 1 -and
                    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
                }
        )[0]
    }
    if (-not $script:AsTaskGenericMethod) {
        throw 'Windows Runtime の非同期変換メソッドを取得できませんでした。'
    }

    $asTask = $script:AsTaskGenericMethod.MakeGenericMethod($ResultType)
    $task = $asTask.Invoke($null, @($Operation))
    return $task.GetAwaiter().GetResult()
}

function ConvertTo-QueryValue {
    param([AllowNull()][string]$Value)
    return [uri]::EscapeDataString([string]$Value)
}

function Get-TrackKey {
    param([string]$Title, [string]$Artist)
    $cleanTitle = (($Title -replace '\s+', ' ').Trim().ToLowerInvariant())
    $cleanArtist = (($Artist -replace '\s+', ' ').Trim().ToLowerInvariant())
    return ($cleanTitle + [char]31 + $cleanArtist)
}

function Normalize-LyricsSearchText {
    param([AllowNull()][string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
    $value = $Text.ToLowerInvariant()
    $value = $value -replace '\([^)]*\)', ''
    $value = $value -replace '\[[^\]]*\]', ''
    $value = $value -replace '[^\p{L}\p{Nd}]', ''
    return $value
}

function Normalize-LyricsTitle {
    param([AllowNull()][string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
    $value = $Text
    # Treat release labels as the same composition while leaving meaningful
    # title words intact. Duration and album checks distinguish the versions.
    $value = $value -replace '\s*[-–—]\s*(?:\d{4}\s+)?(?:remaster(?:ed)?|radio edit|single version|album version|deluxe edition|live(?:\s+at|\s+from)?).*$', ''
    return Normalize-LyricsSearchText $value
}

function Get-ObjectPropertyValue {
    param(
        [AllowNull()]$InputObject,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Protect-AppSecret {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
        $plainBytes,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    return [Convert]::ToBase64String($protectedBytes)
}

function Unprotect-AppSecret {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    $protectedBytes = [Convert]::FromBase64String($Value)
    $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protectedBytes,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    return [System.Text.Encoding]::UTF8.GetString($plainBytes)
}

function Load-AppSettings {
    if (-not (Test-Path -LiteralPath $script:SettingsPath)) { return }
    try {
        $settings = Get-Content -LiteralPath $script:SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $mode = [string](Get-ObjectPropertyValue -InputObject $settings -Name 'translationMode')
        if ($mode -eq 'ai' -or $mode -eq 'gemini') { $script:TranslationMode = 'gemini' }
        elseif ($mode -eq 'deepl') { $script:TranslationMode = 'deepl' }
        elseif ($mode -eq 'openai') { $script:TranslationMode = 'openai' }
        $encryptedKey = [string](Get-ObjectPropertyValue -InputObject $settings -Name 'geminiApiKey')
        if (-not [string]::IsNullOrWhiteSpace($encryptedKey)) {
            $script:GeminiApiKey = Unprotect-AppSecret $encryptedKey
        }
        $encryptedDeepLKey = [string](Get-ObjectPropertyValue -InputObject $settings -Name 'deepLApiKey')
        if (-not [string]::IsNullOrWhiteSpace($encryptedDeepLKey)) {
            $script:DeepLApiKey = Unprotect-AppSecret $encryptedDeepLKey
        }
        $encryptedOpenAiKey = [string](Get-ObjectPropertyValue -InputObject $settings -Name 'openAiApiKey')
        if (-not [string]::IsNullOrWhiteSpace($encryptedOpenAiKey)) {
            $script:OpenAiApiKey = Unprotect-AppSecret $encryptedOpenAiKey
        }
        $missingSelectedKey = (($script:TranslationMode -eq 'gemini' -and [string]::IsNullOrWhiteSpace($script:GeminiApiKey)) -or ($script:TranslationMode -eq 'deepl' -and [string]::IsNullOrWhiteSpace($script:DeepLApiKey)) -or ($script:TranslationMode -eq 'openai' -and [string]::IsNullOrWhiteSpace($script:OpenAiApiKey)))
        if ($missingSelectedKey) {
            $script:TranslationMode = 'free'
        }
    } catch {
        $script:TranslationMode = 'free'
        $script:GeminiApiKey = ''
        $script:DeepLApiKey = ''
        $script:OpenAiApiKey = ''
        Write-AppLog "Settings load failed: $(Get-ErrorMessage $_)"
    }
}

function Save-AppSettings {
    try {
        $settings = [ordered]@{
            translationMode = $script:TranslationMode
            geminiApiKey = Protect-AppSecret $script:GeminiApiKey
            deepLApiKey = Protect-AppSecret $script:DeepLApiKey
            openAiApiKey = Protect-AppSecret $script:OpenAiApiKey
        }
        $settings | ConvertTo-Json | Set-Content -LiteralPath $script:SettingsPath -Encoding UTF8
    } catch {
        Write-AppLog "Settings save failed: $(Get-ErrorMessage $_)"
    }
}

function New-LyricsEntryResult {
    param(
        [AllowNull()][string]$SyncedLyrics,
        [AllowNull()][string]$PlainLyrics,
        [Parameter(Mandatory = $true)][string]$Source
    )
    return [pscustomobject]@{
        syncedLyrics = [string]$SyncedLyrics
        plainLyrics = [string]$PlainLyrics
        Source = $Source
    }
}

function Invoke-Utf8TextRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [hashtable]$Headers = @{},
        [int]$TimeoutSec = 20
    )

    $request = [System.Net.WebRequest]::Create($Uri)
    $request.Method = 'GET'
    $request.Accept = 'application/json'
    $request.UserAgent = 'SpotifyLyricsJPStore/1.4.1'
    $request.Timeout = [math]::Max(1000, $TimeoutSec * 1000)
    $request.ReadWriteTimeout = [math]::Max(1000, $TimeoutSec * 1000)
    $request.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
    foreach ($name in $Headers.Keys) {
        $request.Headers[$name] = [string]$Headers[$name]
    }

    $response = $null
    $stream = $null
    $reader = $null
    try {
        $response = $request.GetResponse()
        $stream = $response.GetResponseStream()
        $utf8 = [System.Text.UTF8Encoding]::new($false)
        $reader = [System.IO.StreamReader]::new($stream, $utf8, $true)
        return $reader.ReadToEnd()
    } finally {
        if ($reader) { $reader.Dispose() }
        elseif ($stream) { $stream.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Invoke-Utf8JsonPostRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$JsonBody,
        [hashtable]$Headers = @{},
        [int]$TimeoutSec = 45
    )

    $request = [System.Net.WebRequest]::Create($Uri)
    $request.Method = 'POST'
    $request.Accept = 'application/json'
    $request.ContentType = 'application/json; charset=utf-8'
    $request.UserAgent = 'SpotifyLyricsJPStore/1.4.1'
    $request.Timeout = [math]::Max(1000, $TimeoutSec * 1000)
    $request.ReadWriteTimeout = [math]::Max(1000, $TimeoutSec * 1000)
    $request.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
    foreach ($name in $Headers.Keys) {
        $request.Headers[$name] = [string]$Headers[$name]
    }

    $bodyBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($JsonBody)
    $request.ContentLength = $bodyBytes.Length
    $requestStream = $null
    $response = $null
    $stream = $null
    $reader = $null
    try {
        $requestStream = $request.GetRequestStream()
        $requestStream.Write($bodyBytes, 0, $bodyBytes.Length)
        $requestStream.Dispose()
        $requestStream = $null
        $response = $request.GetResponse()
        $stream = $response.GetResponseStream()
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.UTF8Encoding]::new($false), $true)
        return $reader.ReadToEnd()
    } finally {
        if ($requestStream) { $requestStream.Dispose() }
        if ($reader) { $reader.Dispose() }
        elseif ($stream) { $stream.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Invoke-JsonRequest {
    param([Parameter(Mandatory = $true)][string]$Uri)

    $headers = @{ 'Lrclib-Client' = 'SpotifyLyricsJPStore/1.4.1 (Windows companion)' }
    $jsonText = Invoke-Utf8TextRequest -Uri $Uri -Headers $headers -TimeoutSec 15
    return ($jsonText | ConvertFrom-Json)
}

function Get-LyricsCandidateScore {
    param(
        [Parameter(Mandatory = $true)]$Candidate,
        [string]$Title,
        [string]$Artist,
        [string]$Album,
        [double]$DurationSeconds
    )

    $wantedTitle = Normalize-LyricsTitle $Title
    $wantedArtist = Normalize-LyricsSearchText $Artist
    $wantedAlbum = Normalize-LyricsSearchText $Album
    $candidateTitle = Normalize-LyricsTitle ([string]$Candidate.trackName)
    $candidateArtist = Normalize-LyricsSearchText ([string]$Candidate.artistName)
    $candidateAlbum = Normalize-LyricsSearchText ([string]$Candidate.albumName)
    $score = 0

    if ($candidateTitle -eq $wantedTitle) { $score += 300 }
    elseif ($candidateTitle.Contains($wantedTitle) -or $wantedTitle.Contains($candidateTitle)) { $score += 60 }

    if ($wantedArtist -and $candidateArtist -eq $wantedArtist) { $score += 220 }
    elseif ($wantedArtist -and ($candidateArtist.Contains($wantedArtist) -or $wantedArtist.Contains($candidateArtist))) { $score += 70 }

    if ($wantedAlbum -and $candidateAlbum -eq $wantedAlbum) { $score += 120 }
    elseif ($wantedAlbum -and ($candidateAlbum.Contains($wantedAlbum) -or $wantedAlbum.Contains($candidateAlbum))) { $score += 45 }

    $candidateDuration = [double](Get-ObjectPropertyValue -InputObject $Candidate -Name 'duration')
    if ($DurationSeconds -gt 0 -and $candidateDuration -gt 0) {
        $difference = [math]::Abs($DurationSeconds - $candidateDuration)
        if ($difference -le 3) { $score += 260 }
        elseif ($difference -le 10) { $score += 190 }
        elseif ($difference -le 20) { $score += 110 }
        elseif ($difference -le 45) { $score += 25 }
        else { $score -= 350 }
    }

    if (-not [string]::IsNullOrWhiteSpace([string]$Candidate.syncedLyrics)) { $score += 20 }
    elseif (-not [string]::IsNullOrWhiteSpace([string]$Candidate.plainLyrics)) { $score += 10 }
    return $score
}

function Select-BestLrclibCandidate {
    param(
        [Parameter(Mandatory = $true)][object[]]$Candidates,
        [string]$Title,
        [string]$Artist,
        [string]$Album,
        [double]$DurationSeconds
    )

    if ($Candidates.Count -eq 0) { return $null }
    $scoredCandidates = @(
        foreach ($candidate in $Candidates) {
            [pscustomobject]@{
                Candidate = $candidate
                Score = Get-LyricsCandidateScore -Candidate $candidate -Title $Title -Artist $Artist -Album $Album -DurationSeconds $DurationSeconds
            }
        }
    )
    $best = @($scoredCandidates | Sort-Object -Property Score -Descending | Select-Object -First 1)
    if ($best.Count -eq 0) { return $null }

    $selected = $best[0].Candidate
    $wantedTitle = Normalize-LyricsTitle $Title
    $candidateTitle = Normalize-LyricsTitle ([string]$selected.trackName)
    if (-not $wantedTitle -or $candidateTitle -ne $wantedTitle) { return $null }

    $wantedArtist = Normalize-LyricsSearchText $Artist
    $candidateArtist = Normalize-LyricsSearchText ([string]$selected.artistName)
    $artistMatches = ($wantedArtist -and $candidateArtist -and (
        $candidateArtist -eq $wantedArtist -or
        $candidateArtist.Contains($wantedArtist) -or
        $wantedArtist.Contains($candidateArtist)
    ))

    $wantedAlbum = Normalize-LyricsSearchText $Album
    $candidateAlbum = Normalize-LyricsSearchText ([string]$selected.albumName)
    $albumMatches = ($wantedAlbum -and $candidateAlbum -and (
        $candidateAlbum -eq $wantedAlbum -or
        $candidateAlbum.Contains($wantedAlbum) -or
        $wantedAlbum.Contains($candidateAlbum)
    ))

    $durationClose = $false
    $candidateDuration = [double](Get-ObjectPropertyValue -InputObject $selected -Name 'duration')
    if ($DurationSeconds -gt 0 -and $candidateDuration -gt 0) {
        $difference = [math]::Abs($DurationSeconds - $candidateDuration)
        if ($difference -gt 45) {
            Write-AppLog "Rejected LRCLIB candidate because duration differs by $([math]::Round($difference)) seconds: $($selected.artistName) - $($selected.trackName)"
            return $null
        }
        $durationClose = $difference -le 20
    }

    # When Spotify localizes an artist name, exact artist comparison is not
    # possible. In that case require a close duration or matching album.
    if (-not $artistMatches -and -not $albumMatches -and -not $durationClose) {
        Write-AppLog "Rejected ambiguous LRCLIB candidate: $($selected.artistName) - $($selected.trackName)"
        return $null
    }
    return $selected
}

function Invoke-LyricsOvhLookup {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$Artist
    )

    if ([string]::IsNullOrWhiteSpace($Title) -or [string]::IsNullOrWhiteSpace($Artist)) { return $null }
    $uri = 'https://api.lyrics.ovh/v1/' + (ConvertTo-QueryValue $Artist) + '/' + (ConvertTo-QueryValue $Title)
    try {
        $payload = (Invoke-Utf8TextRequest -Uri $uri -TimeoutSec 12) | ConvertFrom-Json
        $lyrics = [string](Get-ObjectPropertyValue -InputObject $payload -Name 'lyrics')
        if (-not [string]::IsNullOrWhiteSpace($lyrics)) {
            return New-LyricsEntryResult -PlainLyrics $lyrics -Source 'Lyrics.ovh'
        }
    } catch {
        Write-AppLog "Lyrics.ovh lookup failed for '$Artist - $Title': $(Get-ErrorMessage $_)"
    }
    return $null
}

function Find-LyricsSuggestionCandidate {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$Artist,
        [string]$Album,
        [double]$DurationSeconds
    )

    # Spotify sometimes localizes artist names (for example Eminem -> エミネム).
    # Lyrics.ovh's Deezer-backed suggestion endpoint can recover the canonical
    # artist and also provides duration/album data for safe matching.
    try {
        $suggestUri = 'https://api.lyrics.ovh/suggest/' + (ConvertTo-QueryValue $Title)
        $suggestPayload = (Invoke-Utf8TextRequest -Uri $suggestUri -TimeoutSec 12) | ConvertFrom-Json
        $suggestions = @(Get-ObjectPropertyValue -InputObject $suggestPayload -Name 'data')
        $wantedTitle = Normalize-LyricsTitle $Title
        $wantedAlbum = Normalize-LyricsSearchText $Album
        $ranked = @(
            foreach ($candidate in $suggestions) {
                if ($null -eq $candidate) { continue }
                $candidateTitle = [string](Get-ObjectPropertyValue -InputObject $candidate -Name 'title_short')
                if ([string]::IsNullOrWhiteSpace($candidateTitle)) {
                    $candidateTitle = [string](Get-ObjectPropertyValue -InputObject $candidate -Name 'title')
                }
                $artistObject = Get-ObjectPropertyValue -InputObject $candidate -Name 'artist'
                $candidateArtist = [string](Get-ObjectPropertyValue -InputObject $artistObject -Name 'name')
                if ([string]::IsNullOrWhiteSpace($candidateTitle) -or [string]::IsNullOrWhiteSpace($candidateArtist)) { continue }

                $normalizedTitle = Normalize-LyricsTitle $candidateTitle
                $albumObject = Get-ObjectPropertyValue -InputObject $candidate -Name 'album'
                $candidateAlbum = [string](Get-ObjectPropertyValue -InputObject $albumObject -Name 'title')
                $candidateDuration = [double](Get-ObjectPropertyValue -InputObject $candidate -Name 'duration')
                $score = 0
                if ($normalizedTitle -eq $wantedTitle) { $score += 300 }
                elseif ($normalizedTitle.Contains($wantedTitle) -or $wantedTitle.Contains($normalizedTitle)) { $score += 60 }
                if ((Normalize-LyricsSearchText $candidateArtist) -eq (Normalize-LyricsSearchText $Artist)) { $score += 220 }
                if ($wantedAlbum -and (Normalize-LyricsSearchText $candidateAlbum) -eq $wantedAlbum) { $score += 120 }
                if ($DurationSeconds -gt 0 -and $candidateDuration -gt 0) {
                    $difference = [math]::Abs($DurationSeconds - $candidateDuration)
                    if ($difference -le 3) { $score += 260 }
                    elseif ($difference -le 10) { $score += 190 }
                    elseif ($difference -le 20) { $score += 110 }
                    elseif ($difference -le 45) { $score += 25 }
                    else { $score -= 350 }
                }
                [pscustomobject]@{
                    Title = $candidateTitle
                    Artist = $candidateArtist
                    Album = $candidateAlbum
                    Duration = $candidateDuration
                    Score = $score
                }
            }
        )
        $best = @($ranked | Sort-Object -Property Score -Descending | Select-Object -First 1)
        if ($best.Count -gt 0 -and (Normalize-LyricsTitle $best[0].Title) -eq $wantedTitle) {
            $bestArtistMatches = (Normalize-LyricsSearchText $best[0].Artist) -eq (Normalize-LyricsSearchText $Artist)
            $bestAlbumMatches = $wantedAlbum -and (Normalize-LyricsSearchText $best[0].Album) -eq $wantedAlbum
            $bestDurationClose = $false
            if ($DurationSeconds -gt 0 -and $best[0].Duration -gt 0) {
                $bestDurationClose = ([math]::Abs($DurationSeconds - $best[0].Duration) -le 20)
            }
            if (-not $bestArtistMatches -and -not $bestAlbumMatches -and -not $bestDurationClose) {
                return $null
            }
            return $best[0]
        }
    } catch {
        Write-AppLog "Lyrics.ovh suggestion lookup failed: $(Get-ErrorMessage $_)"
    }
    return $null
}

function Get-LyricsOvhEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$Artist,
        [string]$Album,
        [double]$DurationSeconds
    )

    # Skip the direct lookup for localized artist names; the canonical
    # suggestion is both faster and safer in that case.
    if (-not (Test-JapaneseText $Artist)) {
        $direct = Invoke-LyricsOvhLookup -Title $Title -Artist $Artist
        if ($direct) { return $direct }
    }

    $best = Find-LyricsSuggestionCandidate -Title $Title -Artist $Artist -Album $Album -DurationSeconds $DurationSeconds
    if ($best) {
        return Invoke-LyricsOvhLookup -Title $best.Title -Artist $best.Artist
    }
    return $null
}

function ConvertTo-DurationSeconds {
    param([AllowNull()]$Value)
    if ($null -eq $Value) { return 0.0 }
    $text = ([string]$Value).Trim()
    if ($text -match '^(\d+):(\d{1,2})$') {
        return ([double]$matches[1] * 60 + [double]$matches[2])
    }
    if ($text -match '^\d+(?:\.\d+)?$') {
        return [double]::Parse($text, [System.Globalization.CultureInfo]::InvariantCulture)
    }
    return 0.0
}

function Invoke-LyricaLookup {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$Artist,
        [string]$Album,
        [double]$DurationSeconds
    )

    if ([string]::IsNullOrWhiteSpace($Title) -or [string]::IsNullOrWhiteSpace($Artist)) { return $null }
    $uri = 'https://wilooper-lyrica.hf.space/lyrics/?artist=' + (ConvertTo-QueryValue $Artist) +
        '&song=' + (ConvertTo-QueryValue $Title) +
        '&timestamps=true&metadata=true&pass=true&sequence=3%2C4%2C5%2C6%2C7&country=JP'
    try {
        $payload = (Invoke-Utf8TextRequest -Uri $uri -TimeoutSec 25) | ConvertFrom-Json
        if ([string](Get-ObjectPropertyValue -InputObject $payload -Name 'status') -ne 'success') { return $null }
        $data = Get-ObjectPropertyValue -InputObject $payload -Name 'data'
        if (-not $data) { return $null }
        $rawSource = [string](Get-ObjectPropertyValue -InputObject $data -Name 'source')
        if ($rawSource -match '(?i)^lrclib$') {
            Write-AppLog 'Rejected Lyrica response because it came from LRCLIB.'
            return $null
        }
        $timedLyrics = @(Get-ObjectPropertyValue -InputObject $data -Name 'timed_lyrics')
        if ($timedLyrics.Count -eq 0) { return $null }

        $resultTitle = [string](Get-ObjectPropertyValue -InputObject $data -Name 'title')
        $resultArtist = [string](Get-ObjectPropertyValue -InputObject $data -Name 'artist')
        if ((Normalize-LyricsTitle $resultTitle) -ne (Normalize-LyricsTitle $Title)) {
            Write-AppLog "Rejected Lyrica result with different title: $resultArtist - $resultTitle"
            return $null
        }

        $metadata = Get-ObjectPropertyValue -InputObject $data -Name 'metadata'
        $resultAlbum = [string](Get-ObjectPropertyValue -InputObject $metadata -Name 'album')
        $resultDuration = ConvertTo-DurationSeconds (Get-ObjectPropertyValue -InputObject $metadata -Name 'duration')
        $artistMatches = (Normalize-LyricsSearchText $resultArtist) -eq (Normalize-LyricsSearchText $Artist)
        $albumMatches = (Normalize-LyricsSearchText $Album) -and
            (Normalize-LyricsSearchText $resultAlbum) -eq (Normalize-LyricsSearchText $Album)
        $durationClose = $false
        if ($DurationSeconds -gt 0 -and $resultDuration -gt 0) {
            $difference = [math]::Abs($DurationSeconds - $resultDuration)
            if ($difference -gt 45) {
                Write-AppLog "Rejected Lyrica result because duration differs by $([math]::Round($difference)) seconds: $resultArtist - $resultTitle"
                return $null
            }
            $durationClose = $difference -le 20
        }
        if (-not $artistMatches -and -not $albumMatches -and -not $durationClose) {
            Write-AppLog "Rejected ambiguous Lyrica result: $resultArtist - $resultTitle"
            return $null
        }

        $lrcLines = @(
            foreach ($line in $timedLyrics) {
                if ($null -eq $line) { continue }
                $lineText = [string](Get-ObjectPropertyValue -InputObject $line -Name 'text')
                $startMs = [int64](Get-ObjectPropertyValue -InputObject $line -Name 'start_time')
                if ([string]::IsNullOrWhiteSpace($lineText) -or $startMs -lt 0) { continue }
                $minutes = [math]::Floor($startMs / 60000)
                $seconds = [math]::Floor(($startMs % 60000) / 1000)
                $milliseconds = $startMs % 1000
                '[{0:00}:{1:00}.{2:000}]{3}' -f $minutes, $seconds, $milliseconds, $lineText.Trim()
            }
        )
        if ($lrcLines.Count -eq 0) { return $null }

        $sourceName = switch ($rawSource.ToLowerInvariant()) {
            'youtube_music' { 'YouTube Music' }
            'netease' { 'NetEase' }
            'megalobiz' { 'Megalobiz' }
            'musixmatch' { 'Musixmatch' }
            'simpmusic' { 'SimpMusic' }
            default { if ($rawSource) { $rawSource } else { 'Lyrica' } }
        }
        return New-LyricsEntryResult -SyncedLyrics ($lrcLines -join "`n") -Source "Lyrica/$sourceName"
    } catch {
        Write-AppLog "Lyrica lookup failed for '$Artist - $Title': $(Get-ErrorMessage $_)"
        return $null
    }
}

function Get-LyricaEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$Artist,
        [string]$Album,
        [double]$DurationSeconds
    )

    if (-not (Test-JapaneseText $Artist)) {
        $direct = Invoke-LyricaLookup -Title $Title -Artist $Artist -Album $Album -DurationSeconds $DurationSeconds
        if ($direct) { return $direct }
    }

    $best = Find-LyricsSuggestionCandidate -Title $Title -Artist $Artist -Album $Album -DurationSeconds $DurationSeconds
    if ($best) {
        return Invoke-LyricaLookup -Title $best.Title -Artist $best.Artist -Album $best.Album -DurationSeconds $DurationSeconds
    }
    return $null
}

function Get-LyricsEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$Artist,
        [string]$Album,
        [double]$DurationSeconds,
        [switch]$PreferAlternate
    )

    if ($PreferAlternate) {
        Write-AppLog "Manual alternate-source lookup: $Artist - $Title"
        $alternateEntry = Get-LyricaEntry -Title $Title -Artist $Artist -Album $Album -DurationSeconds $DurationSeconds
        if ($alternateEntry) { return $alternateEntry }
        return Get-LyricsOvhEntry -Title $Title -Artist $Artist -Album $Album -DurationSeconds $DurationSeconds
    }

    $trackQuery = ConvertTo-QueryValue $Title
    $artistQuery = ConvertTo-QueryValue $Artist
    $albumQuery = ConvertTo-QueryValue $Album
    $durationQuery = [math]::Round([math]::Max(0, $DurationSeconds))
    $base = "https://lrclib.net/api/get?track_name=$trackQuery&artist_name=$artistQuery"
    if ($Album) { $base += "&album_name=$albumQuery" }
    if ($durationQuery -gt 0) { $base += "&duration=$durationQuery" }

    # Do not immediately settle for untimed lyrics. Keep them as a fallback
    # while looking through LRCLIB and the other providers for synchronized
    # lyrics. This also lets a timed alternate replace an exact plain result.
    $plainFallback = $null

    try {
        $entry = Invoke-JsonRequest $base
        if ($entry -and ($entry.syncedLyrics -or $entry.plainLyrics)) {
            $candidate = Select-BestLrclibCandidate -Candidates @($entry) -Title $Title -Artist $Artist -Album $Album -DurationSeconds $DurationSeconds
            if ($candidate) {
                $result = New-LyricsEntryResult -SyncedLyrics ([string]$candidate.syncedLyrics) -PlainLyrics ([string]$candidate.plainLyrics) -Source 'LRCLIB'
                if (-not [string]::IsNullOrWhiteSpace([string]$result.syncedLyrics)) { return $result }
                $plainFallback = $result
            }
        }
    } catch {
        Write-AppLog "LRCLIB exact lookup failed: $(Get-ErrorMessage $_)"
    }

    $searchUris = @(
        "https://lrclib.net/api/search?track_name=$trackQuery&artist_name=$artistQuery",
        "https://lrclib.net/api/search?track_name=$trackQuery"
    )
    foreach ($searchUri in $searchUris) {
        try {
            $candidates = @(Invoke-JsonRequest $searchUri)
            $syncedCandidates = @($candidates | Where-Object {
                -not [string]::IsNullOrWhiteSpace([string](Get-ObjectPropertyValue -InputObject $_ -Name 'syncedLyrics'))
            })
            if ($syncedCandidates.Count -gt 0) {
                $syncedCandidate = Select-BestLrclibCandidate -Candidates $syncedCandidates -Title $Title -Artist $Artist -Album $Album -DurationSeconds $DurationSeconds
                if ($syncedCandidate) {
                    return New-LyricsEntryResult -SyncedLyrics ([string]$syncedCandidate.syncedLyrics) -PlainLyrics ([string]$syncedCandidate.plainLyrics) -Source 'LRCLIB'
                }
            }
            if (-not $plainFallback) {
                $plainCandidate = Select-BestLrclibCandidate -Candidates $candidates -Title $Title -Artist $Artist -Album $Album -DurationSeconds $DurationSeconds
                if ($plainCandidate -and -not [string]::IsNullOrWhiteSpace([string]$plainCandidate.plainLyrics)) {
                    $plainFallback = New-LyricsEntryResult -PlainLyrics ([string]$plainCandidate.plainLyrics) -Source 'LRCLIB'
                }
            }
        } catch {
            Write-AppLog "LRCLIB search failed: $(Get-ErrorMessage $_)"
        }
    }

    Write-AppLog "LRCLIB had no matching synchronized lyrics. Trying non-LRCLIB synchronized sources: $Artist - $Title"
    $lyricaEntry = Get-LyricaEntry -Title $Title -Artist $Artist -Album $Album -DurationSeconds $DurationSeconds
    if ($lyricaEntry) { return $lyricaEntry }
    if ($plainFallback) {
        Write-AppLog "No synchronized source matched. Using LRCLIB plain lyrics: $Artist - $Title"
        return $plainFallback
    }
    Write-AppLog "No synchronized fallback found. Trying Lyrics.ovh plain lyrics: $Artist - $Title"
    return Get-LyricsOvhEntry -Title $Title -Artist $Artist -Album $Album -DurationSeconds $DurationSeconds
}

function ConvertFrom-LrcText {
    param([AllowNull()][string]$SyncedLyrics, [AllowNull()][string]$PlainLyrics)

    $result = New-Object System.Collections.ArrayList
    $order = 0
    if (-not [string]::IsNullOrWhiteSpace($SyncedLyrics)) {
        foreach ($rawLine in ($SyncedLyrics -split "`r?`n")) {
            $markers = [regex]::Matches($rawLine, '\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]')
            if ($markers.Count -eq 0) { continue }
            $textStart = $markers[$markers.Count - 1].Index + $markers[$markers.Count - 1].Length
            $lineText = $rawLine.Substring($textStart).Trim()
            if ([string]::IsNullOrWhiteSpace($lineText)) { continue }

            foreach ($marker in $markers) {
                $minutes = [int]$marker.Groups[1].Value
                $seconds = [int]$marker.Groups[2].Value
                $fractionText = $marker.Groups[3].Value
                $milliseconds = 0
                if ($fractionText) {
                    if ($fractionText.Length -eq 1) { $milliseconds = [int]$fractionText * 100 }
                    elseif ($fractionText.Length -eq 2) { $milliseconds = [int]$fractionText * 10 }
                    else { $milliseconds = [int]$fractionText.Substring(0, 3) }
                }
                [void]$result.Add([pscustomobject]@{
                    TimeMs = (($minutes * 60 + $seconds) * 1000 + $milliseconds)
                    Order = $order
                    Original = $lineText
                    Translation = ''
                })
                $order++
            }
        }
        if ($result.Count -gt 0) {
            return @($result | Sort-Object TimeMs, Order)
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($PlainLyrics)) {
        foreach ($rawLine in ($PlainLyrics -split "`r?`n")) {
            $lineText = $rawLine.Trim()
            if ([string]::IsNullOrWhiteSpace($lineText)) { continue }
            [void]$result.Add([pscustomobject]@{
                TimeMs = -1
                Order = $order
                Original = $lineText
                Translation = ''
            })
            $order++
        }
    }
    return @($result)
}

function Invoke-GoogleTranslation {
    param([Parameter(Mandatory = $true)][string]$Text)

    $uri = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ja&dt=t&q=' + (ConvertTo-QueryValue $Text)
    $payload = (Invoke-Utf8TextRequest -Uri $uri -TimeoutSec 20) | ConvertFrom-Json
    $parts = foreach ($segment in @($payload[0])) {
        # Windows PowerShell 5.1 can unwrap a one-element JSON array into a
        # scalar.  Wrapping each segment again keeps Count/index access safe.
        $segmentValues = @($segment)
        if ($segmentValues.Count -gt 0 -and $null -ne $segmentValues[0]) {
            [string]$segmentValues[0]
        }
    }
    return (($parts -join '').Trim())
}

function Invoke-MyMemoryTranslation {
    param([Parameter(Mandatory = $true)][string]$Text)

    $uri = 'https://api.mymemory.translated.net/get?q=' + (ConvertTo-QueryValue $Text) + '&langpair=en|ja'
    $payload = (Invoke-Utf8TextRequest -Uri $uri -TimeoutSec 20) | ConvertFrom-Json
    if ($payload.responseData -and $payload.responseData.translatedText) {
        return [System.Net.WebUtility]::HtmlDecode([string]$payload.responseData.translatedText).Trim()
    }
    return ''
}

function Test-JapaneseText {
    param([AllowNull()][string]$Text)
    return $Text -match '[\p{IsHiragana}\p{IsKatakana}\p{IsCJKUnifiedIdeographs}]'
}

function Invoke-GeminiTranslationBatch {
    param([Parameter(Mandatory = $true)][object[]]$Batch)

    if ([string]::IsNullOrWhiteSpace($script:GeminiApiKey)) {
        throw 'Gemini APIキーが設定されていません。'
    }

    $inputLines = @()
    for ($i = 0; $i -lt $Batch.Count; $i++) {
        $inputLines += [ordered]@{ id = $i; text = [string]$Batch[$i].Original }
    }
    $trackTitle = if ($script:CurrentTrack) { [string]$script:CurrentTrack.Title } else { '' }
    $trackArtist = if ($script:CurrentTrack) { [string]$script:CurrentTrack.Artist } else { '' }
    $inputJson = $inputLines | ConvertTo-Json -Depth 5 -Compress
    $prompt = @"
あなたはプロの歌詞翻訳者です。次の歌詞を、曲全体の流れ、比喩、口語、感情を踏まえた自然な日本語に翻訳してください。
曲名: $trackTitle
アーティスト: $trackArtist

厳守事項:
- 入力1行につき出力1件とし、行を結合・分割・省略しない
- idを変更しない
- 不自然な直訳や、不要な「私」「あなた」の繰り返しを避ける
- 固有名詞、反復、掛け声は文脈に合う形で保つ
- 解説や注釈を付けず、指定されたJSONだけを返す

入力:
$inputJson
"@

    $requestBody = [ordered]@{
        contents = @(
            [ordered]@{
                role = 'user'
                parts = @([ordered]@{ text = $prompt })
            }
        )
        generationConfig = [ordered]@{
            temperature = 0.35
            responseMimeType = 'application/json'
            responseSchema = [ordered]@{
                type = 'ARRAY'
                items = [ordered]@{
                    type = 'OBJECT'
                    properties = [ordered]@{
                        id = [ordered]@{ type = 'INTEGER' }
                        ja = [ordered]@{ type = 'STRING' }
                    }
                    required = @('id', 'ja')
                }
            }
        }
    }
    $jsonBody = $requestBody | ConvertTo-Json -Depth 12 -Compress
    $headers = @{ 'x-goog-api-key' = $script:GeminiApiKey }
    $lastError = $null

    foreach ($model in @('gemini-2.5-flash', 'gemini-flash-latest')) {
        try {
            $uri = 'https://generativelanguage.googleapis.com/v1beta/models/' + $model + ':generateContent'
            $responseText = Invoke-Utf8JsonPostRequest -Uri $uri -JsonBody $jsonBody -Headers $headers -TimeoutSec 45
            $response = $responseText | ConvertFrom-Json
            $candidates = @(Get-ObjectPropertyValue -InputObject $response -Name 'candidates')
            if ($candidates.Count -eq 0 -or $null -eq $candidates[0]) {
                throw 'Geminiから翻訳候補が返りませんでした。'
            }
            $content = Get-ObjectPropertyValue -InputObject $candidates[0] -Name 'content'
            $parts = @(Get-ObjectPropertyValue -InputObject $content -Name 'parts')
            $jsonTranslation = (($parts | ForEach-Object {
                [string](Get-ObjectPropertyValue -InputObject $_ -Name 'text')
            }) -join '').Trim()
            if ([string]::IsNullOrWhiteSpace($jsonTranslation)) {
                throw 'Geminiの翻訳結果が空でした。'
            }
            $translatedItems = @($jsonTranslation | ConvertFrom-Json)
            $translatedById = @{}
            foreach ($item in $translatedItems) {
                $idValue = Get-ObjectPropertyValue -InputObject $item -Name 'id'
                $jaValue = [string](Get-ObjectPropertyValue -InputObject $item -Name 'ja')
                if ($null -ne $idValue -and -not [string]::IsNullOrWhiteSpace($jaValue)) {
                    $translatedById[[int]$idValue] = $jaValue.Trim()
                }
            }
            if ($translatedById.Count -ne $Batch.Count) {
                throw "Geminiの翻訳行数が一致しません（$($translatedById.Count)/$($Batch.Count)）。"
            }
            for ($i = 0; $i -lt $Batch.Count; $i++) {
                if (-not $translatedById.ContainsKey($i)) {
                    throw "Geminiの翻訳に行 $i がありません。"
                }
                $Batch[$i].Translation = [string]$translatedById[$i]
            }
            return
        } catch {
            $lastError = $_
            $modelError = Get-ErrorMessage $_
            Write-AppLog "Gemini translation with $model failed: $modelError"
            # Try the moving alias only when the pinned model is unavailable.
            # Authentication, quota and network errors would fail identically
            # and retrying them only makes the UI wait longer.
            if ($modelError -notmatch '(?i)404|not found|見つかりません') { break }
        }
    }
    if ($lastError) { throw $lastError }
    throw 'Gemini翻訳を実行できませんでした。'
}

function Invoke-DeepLTranslationBatch {
    param([Parameter(Mandatory = $true)][object[]]$Batch)

    if ([string]::IsNullOrWhiteSpace($script:DeepLApiKey)) {
        throw 'DeepL APIキーが設定されていません。'
    }
    $sourceLines = @($Batch | ForEach-Object { [string]$_.Original })
    $trackTitle = if ($script:CurrentTrack) { [string]$script:CurrentTrack.Title } else { '' }
    $trackArtist = if ($script:CurrentTrack) { [string]$script:CurrentTrack.Artist } else { '' }
    $context = "これは「$trackTitle」（$trackArtist）の歌詞です。比喩、口語、感情、前後関係を踏まえて自然な日本語にしてください。`n歌詞全体の抜粋:`n" + ($sourceLines -join "`n")
    $requestBody = [ordered]@{
        text = $sourceLines
        target_lang = 'JA'
        context = $context
        split_sentences = '0'
        preserve_formatting = $true
    }
    $endpoint = if ($script:DeepLApiKey.EndsWith(':fx')) {
        'https://api-free.deepl.com/v2/translate'
    } else {
        'https://api.deepl.com/v2/translate'
    }
    $headers = @{ Authorization = 'DeepL-Auth-Key ' + $script:DeepLApiKey }
    $jsonBody = $requestBody | ConvertTo-Json -Depth 8 -Compress
    $response = (Invoke-Utf8JsonPostRequest -Uri $endpoint -JsonBody $jsonBody -Headers $headers -TimeoutSec 45) | ConvertFrom-Json
    $translations = @(Get-ObjectPropertyValue -InputObject $response -Name 'translations')
    if ($translations.Count -ne $Batch.Count) {
        throw "DeepLの翻訳行数が一致しません（$($translations.Count)/$($Batch.Count)）。"
    }
    for ($i = 0; $i -lt $Batch.Count; $i++) {
        $translatedText = [string](Get-ObjectPropertyValue -InputObject $translations[$i] -Name 'text')
        if ([string]::IsNullOrWhiteSpace($translatedText)) {
            throw "DeepLの翻訳に行 $i がありません。"
        }
        $Batch[$i].Translation = $translatedText.Trim()
    }
}

function Invoke-OpenAiTranslationBatch {
    param([Parameter(Mandatory = $true)][object[]]$Batch)

    if ([string]::IsNullOrWhiteSpace($script:OpenAiApiKey)) {
        throw 'OpenAI APIキーが設定されていません。'
    }
    $inputLines = @()
    for ($i = 0; $i -lt $Batch.Count; $i++) {
        $inputLines += [ordered]@{ id = $i; text = [string]$Batch[$i].Original }
    }
    $trackTitle = if ($script:CurrentTrack) { [string]$script:CurrentTrack.Title } else { '' }
    $trackArtist = if ($script:CurrentTrack) { [string]$script:CurrentTrack.Artist } else { '' }
    $inputJson = $inputLines | ConvertTo-Json -Depth 5 -Compress
    $instructions = @"
あなたはプロの日本語歌詞翻訳者です。歌詞全体の物語、前後関係、比喩、スラング、話者の感情を読み取り、歌として自然に伝わる日本語へ翻訳してください。
直訳調を避け、原文にない意味を作らず、不要な「私」「あなた」の反復を抑えてください。
入力1行につき出力1件とし、行を結合・分割・省略せず、idを必ず維持してください。
"@
    $userInput = "曲名: $trackTitle`nアーティスト: $trackArtist`n翻訳対象:`n$inputJson"
    $schema = [ordered]@{
        type = 'object'
        properties = [ordered]@{
            translations = [ordered]@{
                type = 'array'
                items = [ordered]@{
                    type = 'object'
                    properties = [ordered]@{
                        id = [ordered]@{ type = 'integer' }
                        ja = [ordered]@{ type = 'string' }
                    }
                    required = @('id', 'ja')
                    additionalProperties = $false
                }
            }
        }
        required = @('translations')
        additionalProperties = $false
    }
    $requestBody = [ordered]@{
        model = 'gpt-5.6-terra'
        store = $false
        reasoning = [ordered]@{ effort = 'none' }
        instructions = $instructions
        input = $userInput
        max_output_tokens = 6000
        text = [ordered]@{
            format = [ordered]@{
                type = 'json_schema'
                name = 'lyrics_translation'
                strict = $true
                schema = $schema
            }
        }
    }
    $headers = @{ Authorization = 'Bearer ' + $script:OpenAiApiKey }
    $jsonBody = $requestBody | ConvertTo-Json -Depth 15 -Compress
    $response = (Invoke-Utf8JsonPostRequest -Uri 'https://api.openai.com/v1/responses' -JsonBody $jsonBody -Headers $headers -TimeoutSec 60) | ConvertFrom-Json
    $outputTextParts = @()
    foreach ($outputItem in @(Get-ObjectPropertyValue -InputObject $response -Name 'output')) {
        if ([string](Get-ObjectPropertyValue -InputObject $outputItem -Name 'type') -ne 'message') { continue }
        foreach ($contentItem in @(Get-ObjectPropertyValue -InputObject $outputItem -Name 'content')) {
            if ([string](Get-ObjectPropertyValue -InputObject $contentItem -Name 'type') -eq 'output_text') {
                $outputTextParts += [string](Get-ObjectPropertyValue -InputObject $contentItem -Name 'text')
            }
        }
    }
    $outputJson = ($outputTextParts -join '').Trim()
    if ([string]::IsNullOrWhiteSpace($outputJson)) {
        throw 'GPTの翻訳結果が空でした。'
    }
    $parsedOutput = $outputJson | ConvertFrom-Json
    $translatedItems = @(Get-ObjectPropertyValue -InputObject $parsedOutput -Name 'translations')
    $translatedById = @{}
    foreach ($item in $translatedItems) {
        $idValue = Get-ObjectPropertyValue -InputObject $item -Name 'id'
        $jaValue = [string](Get-ObjectPropertyValue -InputObject $item -Name 'ja')
        if ($null -ne $idValue -and -not [string]::IsNullOrWhiteSpace($jaValue)) {
            $translatedById[[int]$idValue] = $jaValue.Trim()
        }
    }
    if ($translatedById.Count -ne $Batch.Count) {
        throw "GPTの翻訳行数が一致しません（$($translatedById.Count)/$($Batch.Count)）。"
    }
    for ($i = 0; $i -lt $Batch.Count; $i++) {
        if (-not $translatedById.ContainsKey($i)) {
            throw "GPTの翻訳に行 $i がありません。"
        }
        $Batch[$i].Translation = [string]$translatedById[$i]
    }
}

function Set-TranslationBatch {
    param([Parameter(Mandatory = $true)][object[]]$Batch)

    if ($Batch.Count -eq 0) { return }
    if ($script:TranslationMode -ne 'free' -and -not $script:TranslationFallbackUsed) {
        try {
            switch ($script:TranslationMode) {
                'gemini' { Invoke-GeminiTranslationBatch -Batch $Batch }
                'deepl' { Invoke-DeepLTranslationBatch -Batch $Batch }
                'openai' { Invoke-OpenAiTranslationBatch -Batch $Batch }
                default { throw '選択された翻訳サービスが不明です。' }
            }
            return
        } catch {
            $script:TranslationFallbackUsed = $true
            Write-AppLog "$($script:TranslationMode) translation failed; using free translation: $(Get-ErrorMessage $_)"
        }
    }
    $delimiter = "`n<<<SLJP_8B25A2D1>>>`n"
    $source = (($Batch | ForEach-Object { $_.Original }) -join $delimiter)
    $translated = ''
    try {
        $translated = Invoke-GoogleTranslation $source
    } catch {
        Write-AppLog "Google translation failed: $(Get-ErrorMessage $_)"
    }

    $pieces = @()
    if ($translated) {
        $pieces = @($translated -split '\s*<<<SLJP_8B25A2D1>>>\s*')
    }
    if ($pieces.Count -eq $Batch.Count) {
        for ($i = 0; $i -lt $Batch.Count; $i++) {
            $Batch[$i].Translation = $pieces[$i].Trim()
        }
        return
    }

    for ($i = 0; $i -lt $Batch.Count; $i++) {
        try {
            $single = Invoke-GoogleTranslation $Batch[$i].Original
            if (-not $single) { $single = Invoke-MyMemoryTranslation $Batch[$i].Original }
            $Batch[$i].Translation = $single
        } catch {
            try {
                $Batch[$i].Translation = Invoke-MyMemoryTranslation $Batch[$i].Original
            } catch {
                $Batch[$i].Translation = ''
                Write-AppLog "Translation fallback failed: $(Get-ErrorMessage $_)"
            }
        }
    }
}

function Add-JapaneseTranslations {
    param([Parameter(Mandatory = $true)][object[]]$Lines)

    $batch = @()
    $length = 0
    $usesContextTranslation = $script:TranslationMode -ne 'free'
    $maxBatchLines = if ($usesContextTranslation) { 24 } else { 8 }
    $maxBatchCharacters = if ($usesContextTranslation) { 4000 } else { 900 }
    foreach ($line in $Lines) {
        if (Test-JapaneseText $line.Original) {
            $line.Translation = $line.Original
            continue
        }
        $nextLength = $length + $line.Original.Length
        if ($batch.Count -gt 0 -and ($batch.Count -ge $maxBatchLines -or $nextLength -gt $maxBatchCharacters)) {
            Set-TranslationBatch -Batch $batch
            $batch = @()
            $length = 0
        }
        $batch += $line
        $length += $line.Original.Length
    }
    if ($batch.Count -gt 0) {
        Set-TranslationBatch -Batch $batch
    }
}

function Get-TranslationEngineText {
    $engine = switch ($script:TranslationMode) {
        'gemini' { 'Gemini AI自然訳' }
        'deepl' { 'DeepL翻訳' }
        'openai' { 'GPT自然訳' }
        default { '無料翻訳' }
    }
    if ($script:TranslationFallbackUsed -and $script:TranslationMode -ne 'free') {
        return "$engine（一部無料訳）"
    }
    return $engine
}

function Get-SpotifySession {
    if (-not $script:Manager) {
        $script:Manager = Await-WinRT ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    }
    $sessions = @($script:Manager.GetSessions())
    $spotifySession = $sessions |
        Where-Object { $_.SourceAppUserModelId -match '(?i)spotify' } |
        Select-Object -First 1
    if (-not $spotifySession) {
        $current = $script:Manager.GetCurrentSession()
        if ($current -and $current.SourceAppUserModelId -match '(?i)spotify') {
            $spotifySession = $current
        }
    }
    return $spotifySession
}

function Get-CurrentSpotifyTrack {
    $session = Get-SpotifySession
    if (-not $session) { return $null }

    $properties = Await-WinRT ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if (-not $properties -or [string]::IsNullOrWhiteSpace([string]$properties.Title)) { return $null }
    $timeline = $session.GetTimelineProperties()
    $positionMs = 0
    $durationSeconds = 0
    if ($timeline) {
        $positionMs = [math]::Max(0, [int64]$timeline.Position.TotalMilliseconds)
        $durationSeconds = [math]::Max(0, $timeline.EndTime.TotalSeconds)
    }
    return [pscustomobject]@{
        Session = $session
        Title = ([string]$properties.Title).Trim()
        Artist = ([string]$properties.Artist).Trim()
        Album = ([string]$properties.AlbumTitle).Trim()
        PositionMs = $positionMs
        DurationSeconds = $durationSeconds
    }
}

function Set-Status {
    param([string]$Text, [switch]$Error)
    if (-not $script:StatusLabel) { return }
    $script:StatusLabel.Text = $Text
    if ($Error) { $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(255, 150, 150) }
    else { $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(170, 185, 205) }
}

function Append-LyricsText {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][System.Drawing.Color]$Color,
        [Parameter(Mandatory = $true)][System.Drawing.Font]$Font
    )
    $box = $script:LyricsBox
    $box.SelectionStart = $box.TextLength
    $box.SelectionLength = 0
    $box.SelectionColor = $Color
    $box.SelectionBackColor = $box.BackColor
    $box.SelectionFont = $Font
    $box.AppendText($Text)
}

function Render-Lyrics {
    $box = $script:LyricsBox
    $box.SuspendLayout()
    $box.Clear()
    $script:LineRanges.Clear()
    $script:ActiveLine = -1

    if (-not $script:CurrentLyrics -or @($script:CurrentLyrics.Lines).Count -eq 0) {
        $emptyMessage = "歌詞が見つかりませんでした。`n`nこの曲は自動で再試行しません。公開歌詞が追加されたと思ったときに「再取得」を押してください。"
        if ($script:CurrentLyrics -and -not [string]::IsNullOrWhiteSpace([string]$script:CurrentLyrics.ErrorMessage)) {
            $emptyMessage = "歌詞の取得に失敗しました。`n`n自動再試行は停止しました。通信状態を確認し、少し待ってから「再取得」を押してください。"
        }
        Append-LyricsText -Text $emptyMessage -Color ([System.Drawing.Color]::FromArgb(205, 215, 230)) -Font $script:FontTranslation
        $box.ResumeLayout()
        return
    }

    foreach ($line in $script:CurrentLyrics.Lines) {
        $start = $box.TextLength
        if ($script:OriginalCheck.Checked) {
            Append-LyricsText -Text ($line.Original + "`n") -Color ([System.Drawing.Color]::FromArgb(165, 180, 200)) -Font $script:FontOriginal
        }
        $translated = [string]$line.Translation
        if ([string]::IsNullOrWhiteSpace($translated)) { $translated = '（和訳を取得できませんでした）' }
        Append-LyricsText -Text ($translated + "`n`n") -Color ([System.Drawing.Color]::FromArgb(247, 249, 255)) -Font $script:FontTranslation
        $length = $box.TextLength - $start
        [void]$script:LineRanges.Add([pscustomobject]@{
            TimeMs = [int64]$line.TimeMs
            Start = $start
            Length = $length
        })
    }
    $box.SelectionStart = 0
    $box.SelectionLength = 0
    $box.ResumeLayout()
}

function Highlight-CurrentLine {
    param([int64]$PositionMs)
    if (-not $script:CurrentLyrics -or -not $script:CurrentLyrics.HasTimestamps -or $script:LineRanges.Count -eq 0) { return }

    $newIndex = -1
    for ($i = 0; $i -lt $script:LineRanges.Count; $i++) {
        if ($script:LineRanges[$i].TimeMs -le $PositionMs) { $newIndex = $i }
        else { break }
    }
    if ($newIndex -eq $script:ActiveLine) { return }

    $box = $script:LyricsBox
    if ($script:ActiveLine -ge 0 -and $script:ActiveLine -lt $script:LineRanges.Count) {
        $previous = $script:LineRanges[$script:ActiveLine]
        $box.SelectionStart = $previous.Start
        $box.SelectionLength = $previous.Length
        $box.SelectionBackColor = $box.BackColor
    }
    $script:ActiveLine = $newIndex
    if ($newIndex -ge 0) {
        $current = $script:LineRanges[$newIndex]
        $box.SelectionStart = $current.Start
        $box.SelectionLength = $current.Length
        $box.SelectionBackColor = [System.Drawing.Color]::FromArgb(44, 34, 90, 150)
        if ($script:AutoScrollCheck.Checked -and (Get-Date) -gt $script:ManualScrollUntil) {
            $box.ScrollToCaret()
        }
    }
    $box.SelectionLength = 0
}

function Load-TrackLyrics {
    param([Parameter(Mandatory = $true)]$Track, [Parameter(Mandatory = $true)][string]$Key)

    $script:LoadingKey = $Key
    $script:TrackLabel.Text = "$($Track.Title)  —  $($Track.Artist)"
    Set-Status '歌詞を検索して、和訳しています…'
    [System.Windows.Forms.Application]::DoEvents()

    try {
        if ($script:TrackCache.ContainsKey($Key)) {
            $lyrics = $script:TrackCache[$Key]
        } else {
            $script:TranslationFallbackUsed = $false
            $preferAlternate = $script:ForceAlternateKeys.ContainsKey($Key)
            $entry = Get-LyricsEntry -Title $Track.Title -Artist $Track.Artist -Album $Track.Album -DurationSeconds $Track.DurationSeconds -PreferAlternate:$preferAlternate
            if ($entry) {
                $lines = @(ConvertFrom-LrcText -SyncedLyrics ([string]$entry.syncedLyrics) -PlainLyrics ([string]$entry.plainLyrics))
            } else {
                $lines = @()
            }
            if ($lines.Count -gt 0) {
                Add-JapaneseTranslations -Lines $lines
            }
            $lyrics = [pscustomobject]@{
                Lines = $lines
                # @() is required here: an empty pipeline is $null in
                # Windows PowerShell 5.1 and $null.Count fails in StrictMode.
                HasTimestamps = (@($lines | Where-Object { $_.TimeMs -ge 0 }).Count -gt 0)
                Source = if ($entry) { [string]$entry.Source } else { '' }
                TranslationEngine = Get-TranslationEngineText
                ErrorMessage = ''
            }
            $script:TrackCache[$Key] = $lyrics
        }

        $script:CurrentLyrics = $lyrics
        $script:DisplayedKey = $Key
        Render-Lyrics
        if (@($lyrics.Lines).Count -gt 0) {
            $engine = [string](Get-ObjectPropertyValue -InputObject $lyrics -Name 'TranslationEngine')
            if ([string]::IsNullOrWhiteSpace($engine)) { $engine = Get-TranslationEngineText }
            if ($lyrics.HasTimestamps) { Set-Status "同期歌詞: $($lyrics.Source)　/　和訳: $engine" }
            else { Set-Status "歌詞: $($lyrics.Source)（同期情報なし）　/　和訳: $engine" }
        } else {
            Set-Status 'この曲の公開歌詞は見つかりませんでした。' -Error
        }
    } catch {
        $message = Get-ErrorMessage $_
        Write-AppLog "Track load failed: $message"
        # Mark this track as handled even on failure.  Otherwise the 850 ms
        # polling timer immediately calls this function again forever.
        $script:CurrentLyrics = [pscustomobject]@{
            Lines = @()
            HasTimestamps = $false
            Source = ''
            ErrorMessage = $message
        }
        $script:DisplayedKey = $Key
        Render-Lyrics
        Set-Status "歌詞の取得に失敗しました（自動再試行を停止）: $message" -Error
    } finally {
        $script:LoadingKey = ''
    }
}

function Update-FromSpotify {
    try {
        $track = Get-CurrentSpotifyTrack
        if (-not $track) {
            if (((Get-Date) - $script:LastNoSessionNotice).TotalSeconds -gt 5) {
                $script:TrackLabel.Text = 'Spotifyで曲を再生してください'
                Set-Status 'Store版Spotifyの再生情報を待っています。'
                $script:LastNoSessionNotice = Get-Date
            }
            return
        }

        $script:CurrentTrack = $track
        $key = Get-TrackKey -Title $track.Title -Artist $track.Artist
        if ($key -ne $script:DisplayedKey -and $key -ne $script:LoadingKey) {
            Load-TrackLyrics -Track $track -Key $key
        }
        Highlight-CurrentLine -PositionMs $track.PositionMs
    } catch {
        $message = Get-ErrorMessage $_
        if ($message -ne $script:LastErrorText) {
            Write-AppLog "Spotify session update failed: $message"
            Set-Status "Spotifyの再生情報を読めません: $message" -Error
            $script:LastErrorText = $message
        }
    }
}

function Get-TranslationApiKey {
    param([Parameter(Mandatory = $true)][string]$Mode)
    switch ($Mode) {
        'gemini' { return $script:GeminiApiKey }
        'deepl' { return $script:DeepLApiKey }
        'openai' { return $script:OpenAiApiKey }
        default { return '' }
    }
}

function Set-TranslationApiKey {
    param(
        [Parameter(Mandatory = $true)][string]$Mode,
        [Parameter(Mandatory = $true)][string]$Value
    )
    switch ($Mode) {
        'gemini' { $script:GeminiApiKey = $Value }
        'deepl' { $script:DeepLApiKey = $Value }
        'openai' { $script:OpenAiApiKey = $Value }
        default { throw 'APIキーを設定できない翻訳方式です。' }
    }
}

function Get-TranslationModeIndex {
    switch ($script:TranslationMode) {
        'gemini' { return 1 }
        'deepl' { return 2 }
        'openai' { return 3 }
        default { return 0 }
    }
}

function Get-TranslationModeFromIndex {
    param([int]$Index)
    switch ($Index) {
        1 { return 'gemini' }
        2 { return 'deepl' }
        3 { return 'openai' }
        default { return 'free' }
    }
}

function Show-TranslationApiKeyDialog {
    param(
        [Parameter(Mandatory = $true)][System.Windows.Forms.Form]$Owner,
        [Parameter(Mandatory = $true)][string]$Mode
    )

    $providerName = ''
    $descriptionText = ''
    $linkText = ''
    $linkUrl = ''
    switch ($Mode) {
        'gemini' {
            $providerName = 'Gemini'
            $descriptionText = 'Google AI Studioで作成したGemini APIキーを入力してください。'
            $linkText = 'Google AI StudioでAPIキーを作る'
            $linkUrl = 'https://aistudio.google.com/app/apikey'
        }
        'deepl' {
            $providerName = 'DeepL'
            $descriptionText = 'DeepL API FreeまたはProの認証キーを入力してください。'
            $linkText = 'DeepL APIの登録・キー確認を開く'
            $linkUrl = 'https://www.deepl.com/ja/your-account/keys'
        }
        'openai' {
            $providerName = 'GPT（OpenAI）'
            $descriptionText = 'OpenAI Platformで作成したAPIキーを入力してください。ChatGPT Plusとは別のAPI利用枠が必要です。'
            $linkText = 'OpenAI PlatformでAPIキーを作る'
            $linkUrl = 'https://platform.openai.com/api-keys'
        }
        default { throw 'APIキーを設定できない翻訳方式です。' }
    }

    $dialog = New-Object System.Windows.Forms.Form
    $dialog.Text = "$providerName 翻訳の設定"
    $dialog.StartPosition = 'CenterParent'
    $dialog.FormBorderStyle = 'FixedDialog'
    $dialog.MinimizeBox = $false
    $dialog.MaximizeBox = $false
    $dialog.ShowInTaskbar = $false
    $dialog.ClientSize = New-Object System.Drawing.Size(450, 194)
    $dialog.BackColor = [System.Drawing.Color]::FromArgb(25, 31, 43)
    $dialog.ForeColor = [System.Drawing.Color]::White

    $description = New-Object System.Windows.Forms.Label
    $description.Location = New-Object System.Drawing.Point(18, 15)
    $description.Size = New-Object System.Drawing.Size(414, 57)
    $description.Text = "$descriptionText`nキーはWindowsのユーザー単位暗号化でこのPC内に保存します。"
    $dialog.Controls.Add($description)

    $keyBox = New-Object System.Windows.Forms.TextBox
    $keyBox.Location = New-Object System.Drawing.Point(18, 79)
    $keyBox.Size = New-Object System.Drawing.Size(414, 24)
    $keyBox.UseSystemPasswordChar = $true
    $keyBox.Text = Get-TranslationApiKey -Mode $Mode
    $dialog.Controls.Add($keyBox)

    $link = New-Object System.Windows.Forms.LinkLabel
    $link.Location = New-Object System.Drawing.Point(18, 115)
    $link.Size = New-Object System.Drawing.Size(220, 23)
    $link.Text = $linkText
    $link.Tag = $linkUrl
    $link.LinkColor = [System.Drawing.Color]::FromArgb(120, 185, 255)
    $link.ActiveLinkColor = [System.Drawing.Color]::White
    $link.Add_LinkClicked({
        param($sender, $eventArgs)
        try { Start-Process ([string]$sender.Tag) } catch { }
    })
    $dialog.Controls.Add($link)

    $okButton = New-Object System.Windows.Forms.Button
    $okButton.Text = '保存'
    $okButton.Location = New-Object System.Drawing.Point(262, 148)
    $okButton.Size = New-Object System.Drawing.Size(80, 30)
    $okButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $dialog.Controls.Add($okButton)

    $cancelButton = New-Object System.Windows.Forms.Button
    $cancelButton.Text = 'キャンセル'
    $cancelButton.Location = New-Object System.Drawing.Point(352, 148)
    $cancelButton.Size = New-Object System.Drawing.Size(80, 30)
    $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $dialog.Controls.Add($cancelButton)

    $dialog.AcceptButton = $okButton
    $dialog.CancelButton = $cancelButton
    $result = $dialog.ShowDialog($Owner)
    $key = $null
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
        $key = $keyBox.Text.Trim()
        if ([string]::IsNullOrWhiteSpace($key)) {
            [void][System.Windows.Forms.MessageBox]::Show(
                $Owner,
                'APIキーが空です。無料翻訳のまま利用するか、APIキーを入力してください。',
                "$providerName 翻訳",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information
            )
            $key = $null
        }
    }
    $dialog.Dispose()
    return $key
}

function Reload-Translations {
    $script:TrackCache = @{}
    $script:DisplayedKey = ''
    if ($script:CurrentTrack) { Update-FromSpotify }
}

function Initialize-Window {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]

    $script:FontTrack = [System.Drawing.Font]::new('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
    $script:FontOriginal = [System.Drawing.Font]::new('Segoe UI', 10.5, [System.Drawing.FontStyle]::Regular)
    $script:FontTranslation = [System.Drawing.Font]::new('Yu Gothic UI', 14, [System.Drawing.FontStyle]::Regular)
    $script:FontStatus = [System.Drawing.Font]::new('Segoe UI', 9, [System.Drawing.FontStyle]::Regular)

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "$script:AppName — Store版"
    $form.StartPosition = 'CenterScreen'
    $form.MinimumSize = New-Object System.Drawing.Size(480, 500)
    $form.Size = New-Object System.Drawing.Size(620, 760)
    $form.BackColor = [System.Drawing.Color]::FromArgb(18, 22, 31)
    $form.ForeColor = [System.Drawing.Color]::FromArgb(247, 249, 255)
    $form.TopMost = $true
    $script:MainForm = $form

    $header = New-Object System.Windows.Forms.Panel
    $header.Dock = 'Top'
    $header.Height = 138
    $header.Padding = New-Object System.Windows.Forms.Padding(16, 14, 16, 6)
    $header.BackColor = [System.Drawing.Color]::FromArgb(25, 31, 43)

    $script:TrackLabel = New-Object System.Windows.Forms.Label
    $script:TrackLabel.Dock = 'Top'
    $script:TrackLabel.Height = 29
    $script:TrackLabel.AutoEllipsis = $true
    $script:TrackLabel.Font = $script:FontTrack
    $script:TrackLabel.Text = 'Spotifyで曲を再生してください'
    $header.Controls.Add($script:TrackLabel)

    $toolbar = New-Object System.Windows.Forms.FlowLayoutPanel
    $toolbar.Dock = 'Bottom'
    $toolbar.Height = 77
    $toolbar.WrapContents = $true
    $toolbar.AutoScroll = $true
    $toolbar.Padding = New-Object System.Windows.Forms.Padding(0, 7, 0, 0)

    $refreshButton = New-Object System.Windows.Forms.Button
    $refreshButton.Text = '再取得'
    $refreshButton.AutoSize = $true
    $refreshButton.FlatStyle = 'Flat'
    $refreshButton.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(78, 105, 140)
    $refreshButton.BackColor = [System.Drawing.Color]::FromArgb(37, 50, 71)
    $refreshButton.ForeColor = [System.Drawing.Color]::White
    $refreshButton.Margin = New-Object System.Windows.Forms.Padding(0, 0, 10, 0)
    $toolbar.Controls.Add($refreshButton)

    $alternateButton = New-Object System.Windows.Forms.Button
    $alternateButton.Text = '別ソース'
    $alternateButton.AutoSize = $true
    $alternateButton.FlatStyle = 'Flat'
    $alternateButton.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(78, 105, 140)
    $alternateButton.BackColor = [System.Drawing.Color]::FromArgb(37, 50, 71)
    $alternateButton.ForeColor = [System.Drawing.Color]::White
    $alternateButton.Margin = New-Object System.Windows.Forms.Padding(0, 0, 10, 0)
    $toolbar.Controls.Add($alternateButton)

    $script:TranslationModeCombo = New-Object System.Windows.Forms.ComboBox
    $script:TranslationModeCombo.DropDownStyle = 'DropDownList'
    $script:TranslationModeCombo.Width = 142
    $script:TranslationModeCombo.Items.Add('無料翻訳') | Out-Null
    $script:TranslationModeCombo.Items.Add('Gemini自然訳') | Out-Null
    $script:TranslationModeCombo.Items.Add('DeepL翻訳') | Out-Null
    $script:TranslationModeCombo.Items.Add('GPT自然訳') | Out-Null
    $script:TranslationModeCombo.SelectedIndex = Get-TranslationModeIndex
    $script:TranslationModeCombo.Margin = New-Object System.Windows.Forms.Padding(0, 1, 8, 0)
    $toolbar.Controls.Add($script:TranslationModeCombo)

    $aiSettingsButton = New-Object System.Windows.Forms.Button
    $aiSettingsButton.Text = 'API設定'
    $aiSettingsButton.AutoSize = $true
    $aiSettingsButton.FlatStyle = 'Flat'
    $aiSettingsButton.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(78, 105, 140)
    $aiSettingsButton.BackColor = [System.Drawing.Color]::FromArgb(37, 50, 71)
    $aiSettingsButton.ForeColor = [System.Drawing.Color]::White
    $aiSettingsButton.Margin = New-Object System.Windows.Forms.Padding(0, 0, 12, 0)
    $toolbar.Controls.Add($aiSettingsButton)

    $script:OriginalCheck = New-Object System.Windows.Forms.CheckBox
    $script:OriginalCheck.Text = '原文を表示'
    $script:OriginalCheck.Checked = $true
    $script:OriginalCheck.AutoSize = $true
    $script:OriginalCheck.ForeColor = [System.Drawing.Color]::FromArgb(225, 232, 245)
    $script:OriginalCheck.Margin = New-Object System.Windows.Forms.Padding(0, 4, 14, 0)
    $toolbar.Controls.Add($script:OriginalCheck)

    $script:AutoScrollCheck = New-Object System.Windows.Forms.CheckBox
    $script:AutoScrollCheck.Text = '自動スクロール'
    $script:AutoScrollCheck.Checked = $true
    $script:AutoScrollCheck.AutoSize = $true
    $script:AutoScrollCheck.ForeColor = [System.Drawing.Color]::FromArgb(225, 232, 245)
    $script:AutoScrollCheck.Margin = New-Object System.Windows.Forms.Padding(0, 4, 14, 0)
    $toolbar.Controls.Add($script:AutoScrollCheck)

    $topMostCheck = New-Object System.Windows.Forms.CheckBox
    $topMostCheck.Text = '常に手前'
    $topMostCheck.Checked = $true
    $topMostCheck.AutoSize = $true
    $topMostCheck.ForeColor = [System.Drawing.Color]::FromArgb(225, 232, 245)
    $topMostCheck.Margin = New-Object System.Windows.Forms.Padding(0, 4, 0, 0)
    $toolbar.Controls.Add($topMostCheck)
    $header.Controls.Add($toolbar)

    $script:StatusLabel = New-Object System.Windows.Forms.Label
    $script:StatusLabel.Dock = 'Bottom'
    $script:StatusLabel.Height = 28
    $script:StatusLabel.Padding = New-Object System.Windows.Forms.Padding(16, 6, 16, 0)
    $script:StatusLabel.Font = $script:FontStatus
    $script:StatusLabel.BackColor = [System.Drawing.Color]::FromArgb(18, 22, 31)
    $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(170, 185, 205)
    $script:StatusLabel.Text = 'Spotifyの再生情報を待っています。'

    $script:LyricsBox = New-Object System.Windows.Forms.RichTextBox
    $script:LyricsBox.Dock = 'Fill'
    $script:LyricsBox.ReadOnly = $true
    $script:LyricsBox.BorderStyle = 'None'
    $script:LyricsBox.BackColor = [System.Drawing.Color]::FromArgb(18, 22, 31)
    $script:LyricsBox.ForeColor = [System.Drawing.Color]::White
    $script:LyricsBox.Padding = New-Object System.Windows.Forms.Padding(16, 14, 16, 14)
    $script:LyricsBox.WordWrap = $true
    $script:LyricsBox.ScrollBars = 'Vertical'
    $script:LyricsBox.DetectUrls = $false
    $script:LyricsBox.ShortcutsEnabled = $true

    $form.Controls.Add($script:LyricsBox)
    $form.Controls.Add($script:StatusLabel)
    $form.Controls.Add($header)

    $refreshButton.Add_Click({
        if ($script:CurrentTrack) {
            $key = Get-TrackKey -Title $script:CurrentTrack.Title -Artist $script:CurrentTrack.Artist
            [void]$script:TrackCache.Remove($key)
            [void]$script:ForceAlternateKeys.Remove($key)
            $script:DisplayedKey = ''
            Update-FromSpotify
        }
    })
    $alternateButton.Add_Click({
        if ($script:CurrentTrack) {
            $key = Get-TrackKey -Title $script:CurrentTrack.Title -Artist $script:CurrentTrack.Artist
            $script:ForceAlternateKeys[$key] = $true
            [void]$script:TrackCache.Remove($key)
            $script:DisplayedKey = ''
            Update-FromSpotify
        }
    })
    $script:TranslationModeCombo.Add_SelectedIndexChanged({
        if ($script:ChangingTranslationMode) { return }
        $script:ChangingTranslationMode = $true
        $oldMode = $script:TranslationMode
        try {
            $newMode = Get-TranslationModeFromIndex -Index $script:TranslationModeCombo.SelectedIndex
            $currentKey = Get-TranslationApiKey -Mode $newMode
            if ($newMode -ne 'free' -and [string]::IsNullOrWhiteSpace($currentKey)) {
                $newKey = Show-TranslationApiKeyDialog -Owner $script:MainForm -Mode $newMode
                if ([string]::IsNullOrWhiteSpace($newKey)) {
                    $script:TranslationModeCombo.SelectedIndex = Get-TranslationModeIndex
                    return
                }
                Set-TranslationApiKey -Mode $newMode -Value $newKey
            }
            if ($script:TranslationMode -ne $newMode) {
                $script:TranslationMode = $newMode
                Save-AppSettings
                Reload-Translations
            } else {
                Save-AppSettings
            }
        } catch {
            $message = Get-ErrorMessage $_
            Write-AppLog "Translation mode change failed: $message"
            $script:TranslationMode = $oldMode
            if ($script:TranslationModeCombo) {
                $script:TranslationModeCombo.SelectedIndex = Get-TranslationModeIndex
            }
            Save-AppSettings
            Set-Status "翻訳設定を変更できませんでした: $message" -Error
        } finally {
            $script:ChangingTranslationMode = $false
        }
    })
    $aiSettingsButton.Add_Click({
        try {
            $mode = $script:TranslationMode
            if ($mode -eq 'free') {
                [void][System.Windows.Forms.MessageBox]::Show(
                    $script:MainForm,
                    '先に翻訳欄から Gemini、DeepL、またはGPTを選んでください。',
                    'API設定',
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Information
                )
                return
            }
            $newKey = Show-TranslationApiKeyDialog -Owner $script:MainForm -Mode $mode
            if (-not [string]::IsNullOrWhiteSpace($newKey)) {
                Set-TranslationApiKey -Mode $mode -Value $newKey
                Save-AppSettings
                Reload-Translations
            }
        } catch {
            $message = Get-ErrorMessage $_
            Write-AppLog "API settings dialog failed: $message"
            Set-Status "API設定を開けませんでした: $message" -Error
        }
    })
    $script:OriginalCheck.Add_CheckedChanged({ Render-Lyrics })
    $topMostCheck.Add_CheckedChanged({
        param($sender, $eventArgs)
        if ($script:MainForm) { $script:MainForm.TopMost = [bool]$sender.Checked }
    })
    $script:LyricsBox.Add_MouseWheel({ $script:ManualScrollUntil = (Get-Date).AddSeconds(7) })
    $script:LyricsBox.Add_KeyDown({ $script:ManualScrollUntil = (Get-Date).AddSeconds(7) })

    $script:PollTimer = New-Object System.Windows.Forms.Timer
    $script:PollTimer.Interval = 850
    $script:PollTimer.Add_Tick({ Update-FromSpotify })
    $form.Add_Shown({
        try {
            $script:Manager = Await-WinRT ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
            Set-Status 'Spotifyの再生情報を探しています。'
        } catch {
            $message = Get-ErrorMessage $_
            Write-AppLog "GSMTC initialization failed: $message"
            Set-Status "Windowsの再生情報APIを開始できません: $message" -Error
        }
        $script:PollTimer.Start()
        Update-FromSpotify
    })
    $form.Add_FormClosed({
        if ($script:PollTimer) { $script:PollTimer.Stop(); $script:PollTimer.Dispose() }
        foreach ($font in @($script:FontTrack, $script:FontOriginal, $script:FontTranslation, $script:FontStatus)) {
            if ($font) { $font.Dispose() }
        }
        $script:MainForm = $null
    })
    return $form
}

try {
    Write-AppLog "Starting version $script:Version."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Load-AppSettings
    $window = Initialize-Window
    Write-AppLog 'Window initialized.'
    [void][System.Windows.Forms.Application]::Run($window)
} catch {
    $message = Get-ErrorMessage $_
    Write-AppLog "Fatal error: $message"
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show(
            "Spotify Lyrics JP を開始できませんでした。`n`n$message`n`n詳細ログ: $script:LogPath",
            'Spotify Lyrics JP',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )
    } catch {
        Write-Error "Spotify Lyrics JP failed to start: $message"
    }
    throw
}
