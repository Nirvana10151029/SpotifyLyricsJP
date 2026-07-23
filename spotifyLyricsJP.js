(function spotifyLyricsJPBootstrap() {
    "use strict";

    const requiredApis = ["Player", "React"];
    const missingApis = !globalThis.Spicetify
        ? ["Spicetify"]
        : requiredApis.filter((name) => !Spicetify[name]);
    if (missingApis.length) {
        const attempts = Number(globalThis.__SLJP_BOOTSTRAP_ATTEMPTS || 0) + 1;
        globalThis.__SLJP_BOOTSTRAP_ATTEMPTS = attempts;
        if (attempts >= 150) {
            const message = `Spotify Lyrics JPを開始できません（不足: ${missingApis.join(", ")}）。START-INSTALL.batをもう一度実行してください。`;
            console.error(`[SpotifyLyricsJP] ${message}`);
            try { globalThis.Spicetify?.showNotification?.(message, true, 10000); } catch {}
            return;
        }
        setTimeout(spotifyLyricsJPBootstrap, 200);
        return;
    }
    delete globalThis.__SLJP_BOOTSTRAP_ATTEMPTS;

    const VERSION = "2.0.13";
    const STORAGE_KEY = "spotify-lyrics-jp:settings";
    const TRANSLATION_CACHE_KEY = "spotify-lyrics-jp:translation-cache:v1";
    const TRANSLATION_DB_NAME = "spotify-lyrics-jp-cache";
    const TRANSLATION_DB_STORE = "translations";
    const CACHE_LIMIT = 40;
    const TRANSLATION_CACHE_LIMIT = 10000;
    const FALLBACK_TRANSLATION_CACHE_LIMIT = 500;
    const REQUEST_TIMEOUT_MS = 16000;
    const TRANSLATION_TIMEOUT_MS = 65000;
    const LYRICA_TIMEOUT_MS = 8000;
    const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
    const PROVIDERS = ["LRCLIB", "Lyrica", "Lyrics.ovh"];
    /** Minimum combined score to accept a candidate (prevents wrong-song matches). */
    const MIN_SAFE_SCORE = 380;
    const React = Spicetify.React;
    const h = React.createElement;

    const DEFAULT_SETTINGS = Object.freeze({
        translationMode: "free",
        geminiApiKey: "",
        deepLApiKey: "",
        claudeApiKey: "",
        openAiApiKey: "",
        showOriginal: true,
        autoScroll: true
    });

    function loadSettings() {
        try {
            const stored = Spicetify.LocalStorage.get(STORAGE_KEY);
            const parsed = stored ? JSON.parse(stored) : {};
            return { ...DEFAULT_SETTINGS, ...parsed };
        } catch (error) {
            console.warn("[SpotifyLyricsJP] Settings load failed", error);
            return { ...DEFAULT_SETTINGS };
        }
    }

    let settings = loadSettings();

    function saveSettings(nextSettings) {
        settings = { ...DEFAULT_SETTINGS, ...nextSettings };
        Spicetify.LocalStorage.set(STORAGE_KEY, JSON.stringify(settings));
        setState({ settings: { ...settings } });
    }

    let state = {
        version: VERSION,
        settings: { ...settings },
        track: null,
        entry: null,
        lines: [],
        source: "",
        translationEngine: "",
        activeIndex: -1,
        loading: false,
        status: "Spotifyで曲を再生してください。",
        error: ""
    };
    const subscribers = new Set();

    function setState(patch) {
        state = { ...state, ...patch };
        for (const subscriber of subscribers) {
            try { subscriber(state); } catch (error) { console.error(error); }
        }
    }

    function subscribe(callback) {
        subscribers.add(callback);
        return () => subscribers.delete(callback);
    }

    function useLyricsState() {
        const [snapshot, setSnapshot] = React.useState(state);
        React.useEffect(() => subscribe(setSnapshot), []);
        return snapshot;
    }

    function firstNonEmpty(...values) {
        for (const value of values) {
            if (typeof value === "string" && value.trim()) return value.trim();
        }
        return "";
    }

    function getCurrentTrack() {
        const data = Spicetify.Player.data;
        const item = data?.item || data?.track || data?.entry || null;
        if (!item) return null;
        const metadata = item.metadata || {};
        const artistsFromArray = Array.isArray(item.artists)
            ? item.artists.map((artist) => artist?.name || artist?.uri?.split(":").pop()).filter(Boolean).join(", ")
            : "";
        const artistsFromMeta = firstNonEmpty(metadata.artist_name, metadata.artist, metadata.album_artist_name);
        const title = firstNonEmpty(item.name, metadata.title, metadata.track_name, metadata.song_name);
        const artist = firstNonEmpty(artistsFromArray, artistsFromMeta, "Unknown Artist");
        const album = firstNonEmpty(item.album?.name, metadata.album_title, metadata.album_name, metadata.album);
        const uri = firstNonEmpty(item.uri, metadata.uri, data?.context?.uri);
        const durationMs = Number(Spicetify.Player.getDuration?.()) ||
            Number(data?.duration) || Number(item.duration?.milliseconds) ||
            Number(item.duration_ms) || Number(metadata.duration) || Number(metadata.duration_ms) || 0;
        if (!title) return null;
        return {
            title,
            artist: artist || "Unknown Artist",
            album,
            uri,
            durationSeconds: durationMs > 0 ? durationMs / 1000 : 0,
            key: uri || `${title.toLowerCase()}\u001f${(artist || "").toLowerCase()}`
        };
    }

    function toHalfWidth(text) {
        return String(text || "").replace(/[\uFF01-\uFF5E]/g, (ch) =>
            String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
        ).replace(/\u3000/g, " ");
    }

    function stripDecorations(text) {
        return toHalfWidth(String(text || ""))
            .replace(/（[^）]*）/g, " ")
            .replace(/\([^)]*\)/g, " ")
            .replace(/\[[^\]]*\]/g, " ")
            .replace(/【[^】]*】/g, " ")
            .replace(/「[^」]*」/g, " ")
            .replace(/『[^』]*』/g, " ");
    }

    const TITLE_NOISE_RE = /\s*[-–—~〜／/|]\s*(?:\d{4}\s+)?(?:remaster(?:ed)?|radio\s*edit|single\s*version|album\s*version|deluxe(?:\s*edition)?|expanded(?:\s*edition)?|anniversary(?:\s*edition)?|bonus\s*track|instrumental|off\s*vocal(?:\s*ver(?:sion)?)?|karaoke|tv\s*size(?:\s*ver(?:sion)?)?|movie\s*ver(?:sion)?|film\s*ver(?:sion)?|live(?:\s+at|\s+from|\s+in)?|acoustic(?:\s*ver(?:sion)?)?|demo|cover|remix|mix|edit|version|ver\.?|from\s+.+|original\s*soundtrack|ost)\b.*$/i;

    const FEAT_RE = /\s*(?:feat\.?|ft\.?|featuring|with|prod\.?|produced\s+by)\s+.+$/i;

    function cleanTitleForSearch(text) {
        let t = stripDecorations(text);
        t = t.replace(TITLE_NOISE_RE, "");
        t = t.replace(FEAT_RE, "");
        t = t.replace(/\s{2,}/g, " ").trim();
        return t;
    }

    function normalizeSearchText(text) {
        return cleanTitleForSearch(text)
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]/gu, "");
    }

    function normalizeTitle(text) {
        return normalizeSearchText(text);
    }

    function splitArtists(artistText) {
        const raw = stripDecorations(artistText);
        return raw
            .split(/\s*(?:,|&|\/|×|ｘ|x| and |・|、|＆|\||;)\s*/i)
            .map((part) => part.replace(FEAT_RE, "").trim())
            .filter((part) => part && part.length > 1)
            .map((part) => normalizeSearchText(part))
            .filter(Boolean);
    }

    function isJapanese(text) {
        return /[\u3040-\u30ff\u3400-\u9fff]/u.test(String(text || ""));
    }

    function durationClose(a, b, tolerance) {
        return a > 0 && b > 0 && Math.abs(a - b) <= tolerance;
    }

    function titleSimilarity(a, b) {
        if (!a || !b) return 0;
        if (a === b) return 1;
        if (a.includes(b) || b.includes(a)) {
            const shorter = Math.min(a.length, b.length);
            const longer = Math.max(a.length, b.length);
            return shorter / longer;
        }
        // simple token overlap for JP/EN mixed titles
        const ta = new Set(a.match(/[\p{L}\p{N}]{2,}/gu) || []);
        const tb = new Set(b.match(/[\p{L}\p{N}]{2,}/gu) || []);
        if (!ta.size || !tb.size) return 0;
        let inter = 0;
        for (const t of ta) if (tb.has(t)) inter++;
        return (2 * inter) / (ta.size + tb.size);
    }

    function artistOverlapScore(wantedArtists, candidateArtistRaw) {
        const candParts = splitArtists(candidateArtistRaw);
        const candJoined = normalizeSearchText(candidateArtistRaw);
        if (!wantedArtists.length || (!candParts.length && !candJoined)) return { score: 0, matched: false };

        let best = 0;
        let any = false;
        for (const w of wantedArtists) {
            if (!w) continue;
            if (candJoined === w || candParts.includes(w)) {
                best = Math.max(best, 1);
                any = true;
                continue;
            }
            for (const c of candParts) {
                if (c === w) { best = Math.max(best, 1); any = true; }
                else if (c.includes(w) || w.includes(c)) {
                    const ratio = Math.min(c.length, w.length) / Math.max(c.length, w.length);
                    if (ratio >= 0.55) { best = Math.max(best, 0.72 * ratio); any = true; }
                }
            }
            if (candJoined.includes(w) || w.includes(candJoined)) {
                const ratio = Math.min(candJoined.length, w.length) / Math.max(candJoined.length, w.length);
                if (ratio >= 0.5) { best = Math.max(best, 0.65 * ratio); any = true; }
            }
        }
        return { score: best, matched: any };
    }

    function getCandidateScore(candidate, track) {
        const wantedTitle = normalizeTitle(track.title);
        const wantedTitleAlt = normalizeTitle(cleanTitleForSearch(track.title));
        const wantedArtists = splitArtists(track.artist);
        const wantedAlbum = normalizeSearchText(track.album);
        const candidateTitle = normalizeTitle(candidate.trackName);
        const candidateTitleAlt = normalizeTitle(cleanTitleForSearch(candidate.trackName || ""));
        const candidateAlbum = normalizeSearchText(candidate.albumName);
        const candidateDuration = Number(candidate.duration) || 0;

        let score = 0;

        const sim1 = titleSimilarity(wantedTitle, candidateTitle);
        const sim2 = titleSimilarity(wantedTitleAlt, candidateTitleAlt);
        const sim3 = titleSimilarity(wantedTitle, candidateTitleAlt);
        const titleSim = Math.max(sim1, sim2, sim3);

        if (titleSim >= 0.98) score += 320;
        else if (titleSim >= 0.85) score += 240;
        else if (titleSim >= 0.7) score += 140;
        else if (titleSim >= 0.55) score += 60;
        else if (titleSim >= 0.4) score += 15;
        else score -= 200;

        // exact cleaned equality bonus
        if (wantedTitle && (wantedTitle === candidateTitle || wantedTitleAlt === candidateTitleAlt)) score += 40;

        const art = artistOverlapScore(wantedArtists, candidate.artistName || "");
        if (art.score >= 0.99) score += 240;
        else if (art.score >= 0.7) score += 170;
        else if (art.score >= 0.5) score += 90;
        else if (art.matched) score += 35;
        else score -= 80;

        if (wantedAlbum && candidateAlbum) {
            if (wantedAlbum === candidateAlbum) score += 110;
            else if (candidateAlbum.includes(wantedAlbum) || wantedAlbum.includes(candidateAlbum)) score += 40;
        }

        if (track.durationSeconds > 0 && candidateDuration > 0) {
            const difference = Math.abs(track.durationSeconds - candidateDuration);
            if (difference <= 2) score += 280;
            else if (difference <= 5) score += 230;
            else if (difference <= 12) score += 170;
            else if (difference <= 22) score += 90;
            else if (difference <= 40) score += 20;
            else score -= 420;
        } else if (track.durationSeconds > 0 && !candidateDuration) {
            score -= 15; // unknown duration is weaker than a good match
        }

        const hasSynced = Boolean(String(candidate.syncedLyrics || "").trim());
        const hasPlain = Boolean(String(candidate.plainLyrics || "").trim());
        if (hasSynced) score += 35;
        else if (hasPlain) score += 12;

        // Penalize extremely short "lyrics" that are often wrong/instrumental stubs
        const lyricLen = String(candidate.syncedLyrics || candidate.plainLyrics || "").trim().length;
        if (lyricLen > 0 && lyricLen < 40) score -= 60;
        if (/instrumental|off\s*vocal|karaoke|karaoke\s*ver/i.test(String(candidate.trackName || ""))) score -= 120;

        return score;
    }

    function isCandidateSafe(candidate, track) {
        if (!candidate) return false;
        const wantedTitle = normalizeTitle(track.title);
        const wantedTitleAlt = normalizeTitle(cleanTitleForSearch(track.title));
        const candidateTitle = normalizeTitle(candidate.trackName);
        const candidateTitleAlt = normalizeTitle(cleanTitleForSearch(candidate.trackName || ""));
        const titleSim = Math.max(
            titleSimilarity(wantedTitle, candidateTitle),
            titleSimilarity(wantedTitleAlt, candidateTitleAlt),
            titleSimilarity(wantedTitle, candidateTitleAlt),
            titleSimilarity(wantedTitleAlt, candidateTitle)
        );

        // Hard reject clearly different titles
        if (titleSim < 0.45) return false;
        // Short titles (e.g. "A", "Run") need stronger evidence
        const shortTitle = Math.min(wantedTitle.length, candidateTitle.length) <= 4;
        if (shortTitle && titleSim < 0.9) return false;

        const wantedArtists = splitArtists(track.artist);
        const art = artistOverlapScore(wantedArtists, candidate.artistName || "");
        const wantedAlbum = normalizeSearchText(track.album);
        const candidateAlbum = normalizeSearchText(candidate.albumName);
        const albumMatches = Boolean(wantedAlbum && candidateAlbum && (
            candidateAlbum === wantedAlbum || candidateAlbum.includes(wantedAlbum) || wantedAlbum.includes(candidateAlbum)
        ));
        const candidateDuration = Number(candidate.duration) || 0;

        if (track.durationSeconds > 0 && candidateDuration > 0 &&
            Math.abs(track.durationSeconds - candidateDuration) > 40) return false;

        const durationOk = durationClose(track.durationSeconds, candidateDuration, 18);
        const strongTitle = titleSim >= 0.85;
        const okTitle = titleSim >= 0.62;

        // Accept only if enough independent signals agree
        if (strongTitle && (art.matched || albumMatches || durationOk)) return true;
        if (okTitle && art.score >= 0.7) return true;
        if (okTitle && art.matched && durationOk) return true;
        if (okTitle && albumMatches && durationOk) return true;
        if (titleSim >= 0.98 && durationOk) return true;
        return false;
    }

    function selectBestCandidate(candidates, track, requireSynced) {
        const ranked = (candidates || [])
            .filter((candidate) => candidate && (!requireSynced || String(candidate.syncedLyrics || "").trim()))
            .filter((candidate) => isCandidateSafe(candidate, track))
            .map((candidate) => ({ candidate, score: getCandidateScore(candidate, track) }))
            .filter(({ score }) => score >= MIN_SAFE_SCORE)
            .sort((a, b) => b.score - a.score);
        return ranked[0]?.candidate || null;
    }

    function buildSearchVariants(track) {
        const title = String(track.title || "").trim();
        const cleaned = cleanTitleForSearch(title);
        const artist = String(track.artist || "").trim();
        const primaryArtist = (artist.split(/\s*(?:,|&|\/|×| and |・|、|＆)\s*/i)[0] || artist).trim();
        const variants = [];
        const push = (t, a) => {
            t = String(t || "").trim();
            a = String(a || "").trim();
            if (!t) return;
            const key = `${t}\u0000${a}`;
            if (variants.some((v) => v.key === key)) return;
            variants.push({ title: t, artist: a, key });
        };
        push(title, artist);
        push(cleaned, artist);
        push(title, primaryArtist);
        push(cleaned, primaryArtist);
        if (cleaned !== title) push(cleaned, "");
        // Remove featuring from artist side for some JP/EN credits
        const artistNoFeat = artist.replace(FEAT_RE, "").trim();
        if (artistNoFeat && artistNoFeat !== artist) {
            push(title, artistNoFeat);
            push(cleaned, artistNoFeat);
        }
        return variants;
    }

    async function fetchJson(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
                headers: { Accept: "application/json", ...(options.headers || {}) }
            });
            const text = await response.text();
            let payload = null;
            if (text) {
                try { payload = JSON.parse(text); }
                catch { payload = text; }
            }
            if (!response.ok) {
                const apiMessage = payload?.error?.message || payload?.message || payload?.error || "";
                throw new Error(`HTTP ${response.status}${apiMessage ? `: ${apiMessage}` : ""}`);
            }
            return payload;
        } finally {
            clearTimeout(timeout);
        }
    }

    function entryFromLrclib(candidate) {
        return {
            syncedLyrics: String(candidate?.syncedLyrics || ""),
            plainLyrics: String(candidate?.plainLyrics || ""),
            source: "LRCLIB"
        };
    }

    async function getLrclibEntry(track) {
        const candidates = [];
        const variants = buildSearchVariants(track);

        // Exact get with duration when possible (highest precision)
        for (const v of variants.slice(0, 3)) {
            const params = new URLSearchParams({ track_name: v.title, artist_name: v.artist || track.artist });
            if (track.album) params.set("album_name", track.album);
            if (track.durationSeconds > 0) params.set("duration", String(Math.round(track.durationSeconds)));
            try {
                const exact = await fetchJson(`https://lrclib.net/api/get?${params.toString()}`);
                if (exact && (exact.syncedLyrics || exact.plainLyrics)) candidates.push(exact);
            } catch (error) {
                console.info("[SpotifyLyricsJP] LRCLIB exact lookup failed", error.message);
            }
        }

        // Broad search variants
        const searchUrls = [];
        for (const v of variants) {
            if (v.artist) {
                searchUrls.push(`https://lrclib.net/api/search?${new URLSearchParams({ track_name: v.title, artist_name: v.artist })}`);
            }
            searchUrls.push(`https://lrclib.net/api/search?${new URLSearchParams({ track_name: v.title })}`);
            // q= combined query helps some Japanese titles
            const q = v.artist ? `${v.title} ${v.artist}` : v.title;
            searchUrls.push(`https://lrclib.net/api/search?${new URLSearchParams({ q })}`);
        }
        // de-dupe urls
        const uniqueUrls = [...new Set(searchUrls)].slice(0, 8);
        const searches = await Promise.allSettled(uniqueUrls.map((url) => fetchJson(url)));
        for (const search of searches) {
            if (search.status === "fulfilled" && Array.isArray(search.value)) candidates.push(...search.value);
        }
        const unique = [...new Map(candidates.map((candidate) => [
            String(candidate.id || `${candidate.trackName}|${candidate.artistName}|${candidate.duration}|${candidate.syncedLyrics || ""}`),
            candidate
        ])).values()];
        const synced = selectBestCandidate(unique, track, true);
        if (synced) return entryFromLrclib(synced);
        const plain = selectBestCandidate(unique, track, false);
        return plain && String(plain.plainLyrics || "").trim() ? entryFromLrclib(plain) : null;
    }

    async function findCanonicalTrack(track) {
        try {
            const queries = [...new Set([
                track.title,
                cleanTitleForSearch(track.title),
                `${cleanTitleForSearch(track.title)} ${splitArtists(track.artist)[0] || track.artist}`
            ].filter(Boolean))];
            const all = [];
            for (const q of queries.slice(0, 3)) {
                try {
                    const payload = await fetchJson(`https://api.lyrics.ovh/suggest/${encodeURIComponent(q)}`);
                    const suggestions = Array.isArray(payload?.data) ? payload.data : [];
                    all.push(...suggestions);
                } catch (error) {
                    console.info("[SpotifyLyricsJP] Canonical suggest failed", error.message);
                }
            }
            const ranked = all.map((item) => {
                const candidate = {
                    trackName: item.title_short || item.title || "",
                    artistName: item.artist?.name || "",
                    albumName: item.album?.title || "",
                    duration: Number(item.duration) || 0,
                    item
                };
                return { candidate, score: getCandidateScore(candidate, track) };
            }).filter(({ candidate, score }) => isCandidateSafe(candidate, track) && score >= MIN_SAFE_SCORE - 50)
                .sort((a, b) => b.score - a.score);
            return ranked[0]?.candidate || null;
        } catch (error) {
            console.info("[SpotifyLyricsJP] Canonical-track lookup failed", error.message);
            return null;
        }
    }

    function convertLyricaLines(timedLyrics) {
        const lrcLines = [];
        for (const line of Array.isArray(timedLyrics) ? timedLyrics : []) {
            const text = String(line?.text || "").trim();
            const startMs = Number(line?.start_time);
            if (!text || !Number.isFinite(startMs) || startMs < 0) continue;
            const minutes = Math.floor(startMs / 60000);
            const seconds = Math.floor((startMs % 60000) / 1000);
            const milliseconds = Math.floor(startMs % 1000);
            lrcLines.push(`[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}]${text}`);
        }
        return lrcLines.join("\n");
    }

    async function invokeLyrica(track, queryTitle, queryArtist, queryAlbum) {
        const params = new URLSearchParams({
            artist: queryArtist,
            song: queryTitle,
            timestamps: "true",
            metadata: "true",
            pass: "true",
            // Prefer NetEase / YT Music / Musixmatch etc. which cover JP well
            sequence: "3,4,5,6,7,1,2",
            country: "JP"
        });
        const payload = await fetchJson(`https://wilooper-lyrica.hf.space/lyrics/?${params.toString()}`, {}, LYRICA_TIMEOUT_MS);
        if (payload?.status !== "success" || !payload.data) return null;
        const data = payload.data;
        const rawSource = String(data.source || "");
        if (/^lrclib$/i.test(rawSource)) return null;
        const durationText = String(data.metadata?.duration || "");
        let duration = Number(durationText) || 0;
        const durationMatch = durationText.match(/^(\d+):(\d{1,2})$/);
        if (durationMatch) duration = Number(durationMatch[1]) * 60 + Number(durationMatch[2]);
        const candidate = {
            trackName: data.title || queryTitle,
            artistName: data.artist || queryArtist,
            albumName: data.metadata?.album || queryAlbum || "",
            duration
        };
        if (!isCandidateSafe(candidate, track)) return null;
        const syncedLyrics = convertLyricaLines(data.timed_lyrics);
        if (!syncedLyrics) return null;
        const sourceMap = {
            youtube_music: "YouTube Music",
            netease: "NetEase",
            megalobiz: "Megalobiz",
            musixmatch: "Musixmatch",
            simpmusic: "SimpMusic"
        };
        return { syncedLyrics, plainLyrics: "", source: `Lyrica/${sourceMap[rawSource.toLowerCase()] || rawSource || "Other"}` };
    }

    async function getLyricaEntry(track) {
        const variants = buildSearchVariants(track).slice(0, 2);
        // Parallel short attempts (HF Space is often slow when cold)
        const results = await Promise.all(variants.map((v) =>
            invokeLyrica(track, v.title, v.artist || track.artist, track.album)
                .catch((error) => {
                    console.info("[SpotifyLyricsJP] Lyrica direct lookup failed", error.message);
                    return null;
                })
        ));
        for (const direct of results) {
            if (direct) return direct;
        }
        return null;
    }

    async function invokeLyricsOvh(title, artist) {
        const payload = await fetchJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
        const lyrics = String(payload?.lyrics || "").trim();
        return lyrics ? { syncedLyrics: "", plainLyrics: lyrics, source: "Lyrics.ovh" } : null;
    }

    async function getLyricsOvhEntry(track) {
        const variants = buildSearchVariants(track);
        for (const v of variants.slice(0, 4)) {
            if (!v.artist) continue;
            try {
                const direct = await invokeLyricsOvh(v.title, v.artist);
                if (direct) {
                    // Lyrics.ovh has no metadata — attach synthetic candidate fields for scoring safety in callers
                    direct.trackName = v.title;
                    direct.artistName = v.artist;
                    direct.duration = track.durationSeconds || 0;
                    // Still verify via score when possible
                    const score = getCandidateScore({
                        trackName: v.title,
                        artistName: v.artist,
                        albumName: track.album || "",
                        duration: track.durationSeconds || 0,
                        plainLyrics: direct.plainLyrics
                    }, track);
                    if (score >= MIN_SAFE_SCORE - 40) return direct;
                }
            } catch (error) {
                console.info("[SpotifyLyricsJP] Lyrics.ovh direct lookup failed", error.message);
            }
        }
        const canonical = await findCanonicalTrack(track);
        if (!canonical) return null;
        try {
            const entry = await invokeLyricsOvh(canonical.trackName, canonical.artistName);
            if (!entry) return null;
            const score = getCandidateScore({
                trackName: canonical.trackName,
                artistName: canonical.artistName,
                albumName: canonical.albumName || "",
                duration: canonical.duration || 0,
                plainLyrics: entry.plainLyrics
            }, track);
            return score >= MIN_SAFE_SCORE - 40 ? entry : null;
        } catch (error) {
            console.info("[SpotifyLyricsJP] Lyrics.ovh canonical lookup failed", error.message);
            return null;
        }
    }

    function providerName(source) {
        if (String(source).startsWith("Lyrica")) return "Lyrica";
        if (source === "Lyrics.ovh") return "Lyrics.ovh";
        return "LRCLIB";
    }

    const providerLookup = {
        "LRCLIB": getLrclibEntry,
        "Lyrica": getLyricaEntry,
        "Lyrics.ovh": getLyricsOvhEntry
    };

    async function getNormalLyrics(track) {
        // Race LRCLIB + Lyrica for speed; pick the best safe synced result.
        // Lyrics.ovh is plain-only fallback.
        const tasks = [
            getLrclibEntry(track).then((entry) => ({ entry, provider: "LRCLIB" })).catch((error) => {
                console.info("[SpotifyLyricsJP] LRCLIB failed", error.message);
                return { entry: null, provider: "LRCLIB" };
            }),
            getLyricaEntry(track).then((entry) => ({ entry, provider: "Lyrica" })).catch((error) => {
                console.info("[SpotifyLyricsJP] Lyrica failed", error.message);
                return { entry: null, provider: "Lyrica" };
            })
        ];
        const results = await Promise.all(tasks);
        const synced = results
            .map((r) => r.entry)
            .filter((e) => e && String(e.syncedLyrics || "").trim());
        if (synced.length) {
            // Prefer higher quality: both already passed provider-side safety; prefer non-empty denser synced
            synced.sort((a, b) => String(b.syncedLyrics).length - String(a.syncedLyrics).length);
            // Prefer LRCLIB slightly when lengths are close (usually cleaner LRC)
            const best = synced[0];
            const lrclibSynced = results.find((r) => r.provider === "LRCLIB" && r.entry?.syncedLyrics)?.entry;
            if (lrclibSynced && Math.abs(String(lrclibSynced.syncedLyrics).length - String(best.syncedLyrics).length) < 80) {
                return lrclibSynced;
            }
            return best;
        }
        const plainLrclib = results.find((r) => r.provider === "LRCLIB" && r.entry)?.entry;
        if (plainLrclib) return plainLrclib;
        return await getLyricsOvhEntry(track);
    }

    function normalizedLyrics(entry) {
        return normalizeSearchText(entry?.syncedLyrics || entry?.plainLyrics || "");
    }

    async function getAlternateLyrics(track, currentEntry) {
        const currentProvider = providerName(currentEntry?.source);
        const start = PROVIDERS.indexOf(currentProvider);
        const order = [];
        for (let offset = 1; offset < PROVIDERS.length; offset++) {
            order.push(PROVIDERS[(start + offset) % PROVIDERS.length]);
        }
        const currentText = normalizedLyrics(currentEntry);
        for (const provider of order) {
            try {
                const entry = await providerLookup[provider](track);
                if (!entry) continue;
                const nextText = normalizedLyrics(entry);
                if (!nextText || nextText === currentText) continue;
                // Avoid near-duplicates (same song, minor whitespace)
                if (currentText && nextText.length > 40) {
                    const ratio = Math.min(currentText.length, nextText.length) / Math.max(currentText.length, nextText.length);
                    if (ratio > 0.92 && currentText.slice(0, 80) === nextText.slice(0, 80)) continue;
                }
                return entry;
            } catch (error) {
                console.info(`[SpotifyLyricsJP] Alternate ${provider} lookup failed`, error.message);
            }
        }
        return null;
    }

    function parseLyrics(entry) {
        const lines = [];
        let order = 0;
        const synced = String(entry?.syncedLyrics || "");
        for (const rawLine of synced.split(/\r?\n/)) {
            const markers = [...rawLine.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
            if (!markers.length) continue;
            const last = markers[markers.length - 1];
            const text = rawLine.slice((last.index || 0) + last[0].length).trim();
            if (!text) continue;
            for (const marker of markers) {
                const fraction = marker[3] || "";
                const milliseconds = fraction.length === 1 ? Number(fraction) * 100 :
                    fraction.length === 2 ? Number(fraction) * 10 : Number(fraction.slice(0, 3) || 0);
                lines.push({
                    timeMs: (Number(marker[1]) * 60 + Number(marker[2])) * 1000 + milliseconds,
                    order: order++, original: text, translation: ""
                });
            }
        }
        if (lines.length) return lines.sort((a, b) => a.timeMs - b.timeMs || a.order - b.order);
        for (const rawLine of String(entry?.plainLyrics || "").split(/\r?\n/)) {
            const text = rawLine.trim();
            if (text) lines.push({ timeMs: -1, order: order++, original: text, translation: "" });
        }
        return lines;
    }

    function decodeHtml(text) {
        const area = document.createElement("textarea");
        area.innerHTML = String(text || "");
        return area.value;
    }

    async function googleTranslate(text) {
        const params = new URLSearchParams({ client: "gtx", sl: "auto", tl: "ja", dt: "t", q: text });
        const payload = await fetchJson(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {}, 20000);
        return (Array.isArray(payload?.[0]) ? payload[0] : [])
            .map((segment) => Array.isArray(segment) ? String(segment[0] || "") : "")
            .join("").trim();
    }

    async function myMemoryTranslate(text) {
        const params = new URLSearchParams({ q: text, langpair: "en|ja" });
        const payload = await fetchJson(`https://api.mymemory.translated.net/get?${params.toString()}`, {}, 20000);
        return decodeHtml(payload?.responseData?.translatedText || "").trim();
    }

    function translationPrompt(track, inputJson) {
        return `あなたはプロの歌詞翻訳者です。曲全体の流れ、比喩、口語、スラング、感情を踏まえて自然な日本語に翻訳してください。\n曲名: ${track.title}\nアーティスト: ${track.artist}\n\n厳守事項:\n- 入力1行につき出力1件。行を結合・分割・省略しない\n- idを変更しない\n- 原文にない意味を作らない\n- 不要な「私」「あなた」の反復を避ける\n- 解説や注釈を付けず、指定されたJSONだけを返す\n\n入力:\n${inputJson}`;
    }

    function validateTranslations(items, count, serviceName) {
        const byId = new Map();
        for (const item of Array.isArray(items) ? items : []) {
            const id = Number(item?.id);
            const ja = String(item?.ja || "").trim();
            if (Number.isInteger(id) && ja) byId.set(id, ja);
        }
        if (byId.size !== count) throw new Error(`${serviceName}の翻訳行数が一致しません（${byId.size}/${count}）。`);
        return Array.from({ length: count }, (_, index) => {
            if (!byId.has(index)) throw new Error(`${serviceName}の翻訳に行 ${index} がありません。`);
            return byId.get(index);
        });
    }

    async function translateGemini(batch, track) {
        if (!settings.geminiApiKey) throw new Error("Gemini APIキーが設定されていません。");
        const input = batch.map((line, id) => ({ id, text: line.original }));
        const body = {
            contents: [{ role: "user", parts: [{ text: translationPrompt(track, JSON.stringify(input)) }] }],
            generationConfig: {
                temperature: 0.35,
                responseMimeType: "application/json",
                responseSchema: {
                    type: "ARRAY",
                    items: {
                        type: "OBJECT",
                        properties: { id: { type: "INTEGER" }, ja: { type: "STRING" } },
                        required: ["id", "ja"]
                    }
                }
            }
        };
        let lastError = null;
        for (const model of ["gemini-2.5-flash", "gemini-flash-latest"]) {
            try {
                const response = await fetchJson(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "x-goog-api-key": settings.geminiApiKey },
                        body: JSON.stringify(body)
                    }, TRANSLATION_TIMEOUT_MS
                );
                const jsonText = (response?.candidates?.[0]?.content?.parts || []).map((part) => part?.text || "").join("").trim();
                if (!jsonText) throw new Error("Geminiの翻訳結果が空でした。");
                return validateTranslations(JSON.parse(jsonText), batch.length, "Gemini");
            } catch (error) {
                lastError = error;
                if (!/404|not found|見つかりません/i.test(error.message)) break;
            }
        }
        throw lastError || new Error("Gemini翻訳を実行できませんでした。");
    }

    async function translateDeepL(batch, track) {
        if (!settings.deepLApiKey) throw new Error("DeepL APIキーが設定されていません。");
        const sourceLines = batch.map((line) => line.original);
        const endpoint = settings.deepLApiKey.endsWith(":fx")
            ? "https://api-free.deepl.com/v2/translate"
            : "https://api.deepl.com/v2/translate";
        const body = {
            text: sourceLines,
            target_lang: "JA",
            context: `これは「${track.title}」（${track.artist}）の歌詞です。比喩、口語、感情、前後関係を踏まえて自然な日本語にしてください。\n歌詞全体の抜粋:\n${sourceLines.join("\n")}`,
            split_sentences: "0",
            preserve_formatting: true
        };
        const response = await fetchJson(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `DeepL-Auth-Key ${settings.deepLApiKey}` },
            body: JSON.stringify(body)
        }, TRANSLATION_TIMEOUT_MS);
        const translations = Array.isArray(response?.translations) ? response.translations : [];
        if (translations.length !== batch.length) throw new Error(`DeepLの翻訳行数が一致しません（${translations.length}/${batch.length}）。`);
        return translations.map((item, index) => {
            const text = String(item?.text || "").trim();
            if (!text) throw new Error(`DeepLの翻訳に行 ${index} がありません。`);
            return text;
        });
    }

    async function translateClaude(batch, track) {
        if (!settings.claudeApiKey) throw new Error("Claude APIキーが設定されていません。");
        const input = batch.map((line, id) => ({ id, text: line.original }));
        const schema = {
            type: "object",
            properties: {
                translations: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: { id: { type: "integer" }, ja: { type: "string" } },
                        required: ["id", "ja"], additionalProperties: false
                    }
                }
            },
            required: ["translations"], additionalProperties: false
        };
        const body = {
            model: CLAUDE_MODEL,
            max_tokens: Math.min(12000, Math.max(2048, batch.length * 140)),
            temperature: 0.2,
            system: "あなたはプロの日本語歌詞翻訳者です。歌詞全体の物語、前後関係、比喩、スラング、感情を読み取り、原文にない意味を足さず自然な日本語へ翻訳してください。各行のidを必ず維持してください。",
            messages: [{ role: "user", content: translationPrompt(track, JSON.stringify(input)) }],
            output_config: { format: { type: "json_schema", schema } }
        };
        const response = await fetchJson("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": settings.claudeApiKey,
                "anthropic-version": "2023-06-01",
                "anthropic-dangerous-direct-browser-access": "true"
            },
            body: JSON.stringify(body)
        }, TRANSLATION_TIMEOUT_MS);
        if (response?.stop_reason === "refusal") throw new Error("Claudeがこの歌詞の翻訳を拒否しました。");
        if (response?.stop_reason === "max_tokens") throw new Error("Claudeの翻訳結果が長すぎて途中で終了しました。");
        const outputText = (response?.content || [])
            .filter((item) => item?.type === "text")
            .map((item) => item.text || "")
            .join("")
            .trim();
        if (!outputText) throw new Error("Claudeの翻訳結果が空でした。");
        const parsed = JSON.parse(outputText);
        return validateTranslations(parsed?.translations, batch.length, "Claude");
    }

    async function translateOpenAI(batch, track) {
        if (!settings.openAiApiKey) throw new Error("OpenAI APIキーが設定されていません。");
        const input = batch.map((line, id) => ({ id, text: line.original }));
        const schema = {
            type: "object",
            properties: {
                translations: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: { id: { type: "integer" }, ja: { type: "string" } },
                        required: ["id", "ja"], additionalProperties: false
                    }
                }
            },
            required: ["translations"], additionalProperties: false
        };
        const body = {
            model: "gpt-5.6-sol",
            store: false,
            reasoning: { effort: "none" },
            instructions: "あなたはプロの日本語歌詞翻訳者です。物語、前後関係、比喩、スラング、感情を読み取り、原文にない意味を足さず自然な日本語へ翻訳してください。入力1行につき出力1件とし、行を結合・分割・省略せずidを維持してください。",
            input: `曲名: ${track.title}\nアーティスト: ${track.artist}\n翻訳対象:\n${JSON.stringify(input)}`,
            max_output_tokens: 6000,
            text: { format: { type: "json_schema", name: "lyrics_translation", strict: true, schema } }
        };
        const response = await fetchJson("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.openAiApiKey}` },
            body: JSON.stringify(body)
        }, TRANSLATION_TIMEOUT_MS);
        let outputText = typeof response?.output_text === "string" ? response.output_text : "";
        if (!outputText) {
            outputText = (response?.output || []).flatMap((item) => item?.type === "message" ? (item.content || []) : [])
                .filter((item) => item?.type === "output_text").map((item) => item.text || "").join("");
        }
        if (!outputText.trim()) throw new Error("GPTの翻訳結果が空でした。");
        return validateTranslations(JSON.parse(outputText), batch.length, "GPT");
    }

    async function translateFree(batch) {
        const delimiter = "\n<<<SLJP_8B25A2D1>>>\n";
        try {
            const translated = await googleTranslate(batch.map((line) => line.original).join(delimiter));
            const pieces = translated.split(/\s*<<<SLJP_8B25A2D1>>>\s*/);
            if (pieces.length === batch.length) return pieces.map((piece) => piece.trim());
        } catch (error) {
            console.info("[SpotifyLyricsJP] Grouped free translation failed", error.message);
        }
        const results = [];
        for (const line of batch) {
            try {
                results.push((await googleTranslate(line.original)) || (await myMemoryTranslate(line.original)));
            } catch {
                try { results.push(await myMemoryTranslate(line.original)); }
                catch { results.push(""); }
            }
        }
        return results;
    }

    async function translateBatch(batch, track, mode) {
        if (mode === "gemini") return await translateGemini(batch, track);
        if (mode === "deepl") return await translateDeepL(batch, track);
        if (mode === "claude") return await translateClaude(batch, track);
        if (mode === "openai") return await translateOpenAI(batch, track);
        return await translateFree(batch);
    }

    async function translateLines(lines, track) {
        const result = lines.map((line) => ({ ...line }));
        const mode = settings.translationMode;
        const contextMode = mode !== "free";
        const maxLines = mode === "claude" ? 100 : (contextMode ? 24 : 8);
        const maxCharacters = mode === "claude" ? 12000 : (contextMode ? 4000 : 900);
        let translatedLineCount = 0;
        let fallbackUsed = false;
        let batch = [];
        let length = 0;

        async function flush() {
            if (!batch.length) return;
            let translations;
            try {
                translations = await translateBatch(batch.map(({ line }) => line), track, fallbackUsed ? "free" : mode);
            } catch (error) {
                console.warn(`[SpotifyLyricsJP] ${mode} translation failed; using free translation`, error);
                fallbackUsed = true;
                translations = await translateFree(batch.map(({ line }) => line));
            }
            batch.forEach(({ index }, offset) => { result[index].translation = String(translations[offset] || "").trim(); });
            batch = [];
            length = 0;
        }

        for (let index = 0; index < result.length; index++) {
            const line = result[index];
            if (isJapanese(line.original)) {
                line.translation = line.original;
                continue;
            }
            if (batch.length && (batch.length >= maxLines || length + line.original.length > maxCharacters)) await flush();
            batch.push({ index, line });
            translatedLineCount++;
            length += line.original.length;
        }
        await flush();
        const labels = { free: "無料翻訳", gemini: "Gemini自然訳", deepl: "DeepL翻訳", claude: "Claude Haiku自然訳", openai: "GPT自然訳" };
        return {
            lines: result,
            engine: `${labels[mode] || labels.free}${fallbackUsed ? "（一部無料訳）" : ""}`,
            cacheable: translatedLineCount > 0 && (mode === "free" || !fallbackUsed),
            translatedLineCount
        };
    }

    function hashText(text) {
        let hash = 2166136261;
        for (let index = 0; index < text.length; index++) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function translationModeSignature(mode) {
        return mode === "claude" ? `${mode}:${CLAUDE_MODEL}` : mode;
    }

    function getTranslationCacheKey(track, mode, lines) {
        const lyricsIdentity = lines.map((line) => `${line.timeMs}\u001f${line.original}`).join("\u001e");
        return `${translationModeSignature(mode)}\u001f${track.key}\u001f${hashText(lyricsIdentity)}`;
    }

    function loadFallbackTranslationCache() {
        try {
            const stored = Spicetify.LocalStorage.get(TRANSLATION_CACHE_KEY);
            const parsed = stored ? JSON.parse(stored) : [];
            if (!Array.isArray(parsed)) return new Map();
            return new Map(parsed.filter((item) => Array.isArray(item) && typeof item[0] === "string" && item[1]));
        } catch (error) {
            console.warn("[SpotifyLyricsJP] Translation cache load failed", error);
            return new Map();
        }
    }

    const fallbackTranslationCache = loadFallbackTranslationCache();

    function persistFallbackTranslationCache() {
        try {
            Spicetify.LocalStorage.set(TRANSLATION_CACHE_KEY, JSON.stringify([...fallbackTranslationCache]));
        } catch (error) {
            console.warn("[SpotifyLyricsJP] Translation cache save failed; reducing cache", error);
            while (fallbackTranslationCache.size > Math.floor(FALLBACK_TRANSLATION_CACHE_LIMIT / 2)) {
                fallbackTranslationCache.delete(fallbackTranslationCache.keys().next().value);
            }
            try { Spicetify.LocalStorage.set(TRANSLATION_CACHE_KEY, JSON.stringify([...fallbackTranslationCache])); }
            catch (retryError) { console.warn("[SpotifyLyricsJP] Reduced translation cache save failed", retryError); }
        }
    }

    function migrateFallbackCache(db) {
        if (!fallbackTranslationCache.size) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(TRANSLATION_DB_STORE, "readwrite");
            const store = transaction.objectStore(TRANSLATION_DB_STORE);
            for (const [key, cached] of fallbackTranslationCache) {
                store.put({ key, ...cached, savedAt: Number(cached.savedAt) || Date.now() });
            }
            transaction.oncomplete = () => {
                fallbackTranslationCache.clear();
                try {
                    if (typeof Spicetify.LocalStorage.remove === "function") Spicetify.LocalStorage.remove(TRANSLATION_CACHE_KEY);
                    else Spicetify.LocalStorage.set(TRANSLATION_CACHE_KEY, "[]");
                } catch {}
                resolve();
            };
            transaction.onerror = () => reject(transaction.error || new Error("旧キャッシュの移行に失敗しました。"));
            transaction.onabort = () => reject(transaction.error || new Error("旧キャッシュの移行が中断されました。"));
        });
    }

    let translationDbPromise = null;

    function openTranslationCacheDb() {
        if (!globalThis.indexedDB?.open) return Promise.resolve(null);
        if (translationDbPromise) return translationDbPromise;
        translationDbPromise = new Promise((resolve) => {
            const request = globalThis.indexedDB.open(TRANSLATION_DB_NAME, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                const store = db.objectStoreNames.contains(TRANSLATION_DB_STORE)
                    ? request.transaction.objectStore(TRANSLATION_DB_STORE)
                    : db.createObjectStore(TRANSLATION_DB_STORE, { keyPath: "key" });
                if (!store.indexNames.contains("savedAt")) store.createIndex("savedAt", "savedAt");
            };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => db.close();
                migrateFallbackCache(db)
                    .then(() => resolve(db))
                    .catch((error) => {
                        console.warn("[SpotifyLyricsJP] Legacy cache migration failed", error);
                        resolve(db);
                    });
            };
            request.onerror = () => {
                console.warn("[SpotifyLyricsJP] IndexedDB cache unavailable", request.error);
                resolve(null);
            };
            request.onblocked = () => {
                console.warn("[SpotifyLyricsJP] IndexedDB cache open blocked");
                resolve(null);
            };
        });
        return translationDbPromise;
    }

    function readIndexedCache(db, key) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(TRANSLATION_DB_STORE, "readonly");
            const request = transaction.objectStore(TRANSLATION_DB_STORE).get(key);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error("翻訳キャッシュを読み込めませんでした。"));
        });
    }

    function writeIndexedCache(db, record) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(TRANSLATION_DB_STORE, "readwrite");
            transaction.objectStore(TRANSLATION_DB_STORE).put(record);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error("翻訳キャッシュを保存できませんでした。"));
            transaction.onabort = () => reject(transaction.error || new Error("翻訳キャッシュの保存が中断されました。"));
        });
    }

    function trimIndexedCache(db) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(TRANSLATION_DB_STORE, "readwrite");
            const store = transaction.objectStore(TRANSLATION_DB_STORE);
            const countRequest = store.count();
            countRequest.onsuccess = () => {
                let removeCount = Math.max(0, Number(countRequest.result) - TRANSLATION_CACHE_LIMIT);
                if (!removeCount) return;
                const cursorRequest = store.index("savedAt").openCursor();
                cursorRequest.onsuccess = () => {
                    const cursor = cursorRequest.result;
                    if (!cursor || removeCount <= 0) return;
                    cursor.delete();
                    removeCount--;
                    cursor.continue();
                };
            };
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error("翻訳キャッシュを整理できませんでした。"));
            transaction.onabort = () => reject(transaction.error || new Error("翻訳キャッシュの整理が中断されました。"));
        });
    }

    function materializeCachedTranslation(cached, lines) {
        if (!cached || !Array.isArray(cached.translations) || cached.translations.length !== lines.length) return null;
        if (cached.translations.some((text) => typeof text !== "string" || !text.trim())) return null;
        return {
            lines: lines.map((line, index) => ({ ...line, translation: cached.translations[index] })),
            engine: `${cached.engine}（キャッシュ）`,
            cacheable: true
        };
    }

    async function getCachedTranslation(key, lines) {
        const db = await openTranslationCacheDb();
        if (db) {
            try { return materializeCachedTranslation(await readIndexedCache(db, key), lines); }
            catch (error) { console.warn("[SpotifyLyricsJP] IndexedDB cache read failed", error); }
        }
        const cached = fallbackTranslationCache.get(key);
        if (cached) {
            fallbackTranslationCache.delete(key);
            fallbackTranslationCache.set(key, cached);
        }
        return materializeCachedTranslation(cached, lines);
    }

    function cacheTranslationFallback(key, record) {
        fallbackTranslationCache.delete(key);
        fallbackTranslationCache.set(key, record);
        while (fallbackTranslationCache.size > FALLBACK_TRANSLATION_CACHE_LIMIT) {
            fallbackTranslationCache.delete(fallbackTranslationCache.keys().next().value);
        }
        persistFallbackTranslationCache();
    }

    async function cacheTranslation(key, translated) {
        const record = {
            key,
            translations: translated.lines.map((line) => line.translation || line.original),
            engine: translated.engine,
            savedAt: Date.now()
        };
        const db = await openTranslationCacheDb();
        if (db) {
            try {
                await writeIndexedCache(db, record);
                await trimIndexedCache(db);
                return;
            } catch (error) {
                console.warn("[SpotifyLyricsJP] IndexedDB cache write failed; using fallback", error);
            }
        }
        cacheTranslationFallback(key, record);
    }

    const trackCache = new Map();
    let requestSerial = 0;

    function cacheSet(key, value) {
        trackCache.delete(key);
        trackCache.set(key, value);
        while (trackCache.size > CACHE_LIMIT) trackCache.delete(trackCache.keys().next().value);
    }

    function missingKeyForMode(mode) {
        if (mode === "gemini") return !settings.geminiApiKey;
        if (mode === "deepl") return !settings.deepLApiKey;
        if (mode === "claude") return !settings.claudeApiKey;
        if (mode === "openai") return !settings.openAiApiKey;
        return false;
    }

    function statusFor(entry, engine) {
        const synchronized = Boolean(entry?.syncedLyrics);
        return `${synchronized ? "同期歌詞" : "通常歌詞"}: ${entry?.source || "不明"}${synchronized ? "" : "（同期情報なし）"} / 和訳: ${engine}`;
    }

    async function loadTrack(options = {}) {
        const track = getCurrentTrack();
        const serial = ++requestSerial;
        if (!track) {
            setState({ track: null, entry: null, lines: [], source: "", activeIndex: -1, loading: false, status: "Spotifyで曲を再生してください。", error: "" });
            return;
        }
        const trackChanged = state.track?.key !== track.key;
        setState({
            track,
            entry: trackChanged ? null : state.entry,
            lines: trackChanged ? [] : state.lines,
            source: trackChanged ? "" : state.source,
            activeIndex: -1,
            loading: true,
            error: "",
            status: options.alternate ? "別の歌詞ソースを検索しています…" : "歌詞を検索して、和訳しています…"
        });
        try {
            let entry = null;
            if (options.alternate) {
                entry = await getAlternateLyrics(track, state.entry);
                if (!entry) throw new Error("利用できる別の歌詞ソースは見つかりませんでした。");
            } else if (!options.force && trackCache.has(track.key)) {
                entry = trackCache.get(track.key).entry;
            } else {
                entry = await getNormalLyrics(track);
            }
            if (serial !== requestSerial) return;
            if (!entry) {
                setState({ track, entry: null, lines: [], source: "", loading: false, status: "この曲の公開歌詞は見つかりませんでした。自動再試行はしません。", error: "lyrics-not-found" });
                return;
            }
            const rawLines = parseLyrics(entry);
            if (!rawLines.length) throw new Error("歌詞データに表示できる行がありませんでした。");
            const translationCacheKey = getTranslationCacheKey(track, settings.translationMode, rawLines);
            let translated = await getCachedTranslation(translationCacheKey, rawLines);
            if (!translated) {
                translated = await translateLines(rawLines, track);
                if (translated.cacheable) await cacheTranslation(translationCacheKey, translated);
            }
            if (serial !== requestSerial) return;
            if (!options.alternate) cacheSet(track.key, { entry });
            setState({
                track, entry, lines: translated.lines, source: entry.source,
                translationEngine: translated.engine, activeIndex: -1, loading: false,
                status: statusFor(entry, translated.engine), error: ""
            });
            updateHighlight(Spicetify.Player.getProgress?.() || 0);
        } catch (error) {
            if (serial !== requestSerial) return;
            const message = error?.name === "AbortError" ? "通信がタイムアウトしました。" : String(error?.message || error);
            setState({ loading: false, status: `取得に失敗しました（自動再試行を停止）: ${message}`, error: message });
        }
    }

    async function retranslateCurrent() {
        const serial = ++requestSerial;
        const track = state.track || getCurrentTrack();
        const entry = state.entry;
        if (!track || !entry) return await loadTrack();
        if (missingKeyForMode(settings.translationMode)) {
            setState({ status: "選択した翻訳サービスのAPIキーを設定してください。", error: "APIキーが未設定です。" });
            showSettingsDialog();
            return;
        }
        setState({ loading: true, status: "翻訳方式を切り替えています…", error: "" });
        try {
            const rawLines = parseLyrics(entry);
            const translationCacheKey = getTranslationCacheKey(track, settings.translationMode, rawLines);
            let translated = await getCachedTranslation(translationCacheKey, rawLines);
            if (!translated) {
                translated = await translateLines(rawLines, track);
                if (translated.cacheable) await cacheTranslation(translationCacheKey, translated);
            }
            if (serial !== requestSerial) return;
            setState({ lines: translated.lines, translationEngine: translated.engine, loading: false, status: statusFor(entry, translated.engine), error: "", activeIndex: -1 });
            updateHighlight(Spicetify.Player.getProgress?.() || 0);
        } catch (error) {
            if (serial !== requestSerial) return;
            setState({ loading: false, error: String(error.message || error), status: `翻訳に失敗しました: ${error.message || error}` });
        }
    }

    function updateHighlight(positionMs) {
        if (!state.entry?.syncedLyrics || !state.lines.length) return;
        let nextIndex = -1;
        for (let index = 0; index < state.lines.length; index++) {
            if (state.lines[index].timeMs <= Number(positionMs || 0)) nextIndex = index;
            else break;
        }
        if (nextIndex !== state.activeIndex) setState({ activeIndex: nextIndex });
    }

    function inputStyle() {
        return {
            width: "100%", boxSizing: "border-box", border: "1px solid var(--spice-button-disabled)",
            borderRadius: 6, padding: "9px 10px", marginTop: 5, color: "var(--spice-text)",
            background: "var(--spice-card)", outline: "none"
        };
    }

    function SettingsDialog() {
        const [draft, setDraft] = React.useState({ ...settings });
        const update = (key) => (event) => setDraft({ ...draft, [key]: event.target.value });
        const save = () => {
            saveSettings(draft);
            Spicetify.PopupModal.hide();
            if (missingKeyForMode(draft.translationMode)) {
                setState({ status: "選択した翻訳サービスのAPIキーを設定してください。", error: "APIキーが未設定です。" });
            } else {
                retranslateCurrent();
            }
        };
        return h("div", { style: { width: 430, maxWidth: "80vw", display: "grid", gap: 13 } },
            h("p", { style: { margin: 0, color: "var(--spice-subtext)" } }, "無料翻訳はAPIキー不要です。キーはこのPCのSpotify用ローカル領域に保存されます（暗号化はされません）。"),
            h("label", null, "Gemini APIキー", h("input", { type: "password", value: draft.geminiApiKey, onChange: update("geminiApiKey"), style: inputStyle(), autoComplete: "off" })),
            h("label", null, "DeepL APIキー", h("input", { type: "password", value: draft.deepLApiKey, onChange: update("deepLApiKey"), style: inputStyle(), autoComplete: "off" })),
            h("label", null, "Claude APIキー", h("input", { type: "password", value: draft.claudeApiKey, onChange: update("claudeApiKey"), style: inputStyle(), autoComplete: "off" })),
            h("label", null, "OpenAI APIキー", h("input", { type: "password", value: draft.openAiApiKey, onChange: update("openAiApiKey"), style: inputStyle(), autoComplete: "off" })),
            h("p", { style: { margin: 0, fontSize: 12, color: "var(--spice-subtext)" } }, "Claude Haiku 4.5を使用します。Claude/ChatGPTの月額プランと各APIの利用料金は別です。"),
            h("button", { className: "sljp-primary", onClick: save }, "保存して現在の曲を翻訳")
        );
    }

    function showSettingsDialog() {
        if (Spicetify.PopupModal?.display) {
            Spicetify.PopupModal.display({ title: "Spotify Lyrics JP — API設定", content: h(SettingsDialog), isLarge: true });
            return;
        }
        showDomSettingsDialog();
    }

    function showDomSettingsDialog() {
        document.getElementById("sljp-dom-modal")?.remove();
        const overlay = document.createElement("div");
        overlay.id = "sljp-dom-modal";
        overlay.className = "sljp-dom-modal";
        const card = document.createElement("div");
        card.className = "sljp-dom-modal-card";

        const title = document.createElement("h2");
        title.textContent = "Spotify Lyrics JP — API設定";
        card.appendChild(title);

        const note = document.createElement("p");
        note.textContent = "無料翻訳はAPIキー不要です。キーはこのPCのSpotify用ローカル領域に保存されます（暗号化はされません）。";
        card.appendChild(note);

        const draft = { ...settings };
        for (const [key, labelText] of [
            ["geminiApiKey", "Gemini APIキー"],
            ["deepLApiKey", "DeepL APIキー"],
            ["claudeApiKey", "Claude APIキー"],
            ["openAiApiKey", "OpenAI APIキー"]
        ]) {
            const label = document.createElement("label");
            label.textContent = labelText;
            const input = document.createElement("input");
            input.type = "password";
            input.value = draft[key];
            input.autocomplete = "off";
            input.addEventListener("input", () => { draft[key] = input.value; });
            label.appendChild(input);
            card.appendChild(label);
        }

        const actions = document.createElement("div");
        actions.className = "sljp-dom-modal-actions";
        const cancel = document.createElement("button");
        cancel.textContent = "閉じる";
        cancel.addEventListener("click", () => overlay.remove());
        const save = document.createElement("button");
        save.className = "sljp-primary";
        save.textContent = "保存して現在の曲を翻訳";
        save.addEventListener("click", () => {
            saveSettings(draft);
            overlay.remove();
            if (missingKeyForMode(draft.translationMode)) {
                setState({ status: "選択した翻訳サービスのAPIキーを設定してください。", error: "APIキーが未設定です。" });
            } else {
                retranslateCurrent();
            }
        });
        actions.append(cancel, save);
        card.appendChild(actions);
        overlay.appendChild(card);
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) overlay.remove();
        });
        document.body.appendChild(overlay);
    }

    function changeMode(event) {
        const translationMode = event.target.value;
        saveSettings({ ...settings, translationMode });
        if (missingKeyForMode(translationMode)) {
            showSettingsDialog();
            setState({ status: "APIキーを入力して保存してください。" });
        } else {
            retranslateCurrent();
        }
    }

    function toggleSetting(key, value) {
        saveSettings({ ...settings, [key]: value });
    }

    function scrollActiveLine(scrollArea, element, behavior = "smooth") {
        if (!scrollArea || !element) return;
        const areaRect = scrollArea.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const top = scrollArea.scrollTop + (elementRect.top - areaRect.top) -
            (scrollArea.clientHeight - elementRect.height) / 2;
        scrollArea.scrollTo({ top: Math.max(0, top), behavior });
    }

    function LyricsPanel() {
        const snapshot = useLyricsState();
        const scrollAreaRef = React.useRef(null);
        React.useEffect(() => {
            if (!snapshot.settings.autoScroll || snapshot.activeIndex < 0) return;
            const element = scrollAreaRef.current?.querySelector(`[data-line-index="${snapshot.activeIndex}"]`);
            scrollActiveLine(scrollAreaRef.current, element);
        }, [snapshot.activeIndex, snapshot.settings.autoScroll]);

        const trackTitle = snapshot.track ? `${snapshot.track.title} — ${snapshot.track.artist}` : "Spotify Lyrics JP";
        return h("div", { className: "sljp-root" },
            h("div", { className: "sljp-track", title: trackTitle }, trackTitle),
            h("div", { className: "sljp-toolbar" },
                h("button", { onClick: () => loadTrack({ force: true }), disabled: snapshot.loading }, "再取得"),
                h("button", { onClick: () => loadTrack({ alternate: true }), disabled: snapshot.loading || !snapshot.entry }, "別ソース"),
                h("select", { value: snapshot.settings.translationMode, onChange: changeMode, disabled: snapshot.loading },
                    h("option", { value: "free" }, "無料翻訳"),
                    h("option", { value: "gemini" }, "Gemini自然訳"),
                    h("option", { value: "deepl" }, "DeepL翻訳"),
                    h("option", { value: "claude" }, "Claude Haiku自然訳"),
                    h("option", { value: "openai" }, "GPT自然訳")
                ),
                h("button", { onClick: showSettingsDialog }, "API設定"),
                h("label", { className: "sljp-check" }, h("input", { type: "checkbox", checked: snapshot.settings.showOriginal, onChange: (event) => toggleSetting("showOriginal", event.target.checked) }), "原文"),
                h("label", { className: "sljp-check" }, h("input", { type: "checkbox", checked: snapshot.settings.autoScroll, onChange: (event) => toggleSetting("autoScroll", event.target.checked) }), "自動スクロール")
            ),
            h("div", { className: "sljp-lines", ref: scrollAreaRef },
                snapshot.loading && h("div", { className: "sljp-empty" }, "検索・翻訳中…"),
                !snapshot.loading && !snapshot.lines.length && h("div", { className: "sljp-empty" },
                    snapshot.error ? "「再取得」で再試行できます。" :
                    (snapshot.track ? (snapshot.status || "この曲の公開歌詞は見つかりませんでした。「再取得」を試してください。") : "曲を再生すると歌詞を表示します。")
                ),
                !snapshot.loading && snapshot.lines.map((line, index) => {
                    const sameText = line.original === line.translation;
                    return h("div", {
                        key: `${line.timeMs}-${line.order}-${index}`,
                        "data-line-index": index,
                        className: `sljp-line${index === snapshot.activeIndex ? " active" : ""}`
                    },
                    snapshot.settings.showOriginal && !sameText && h("div", { className: "sljp-original" }, line.original),
                    h("div", { className: "sljp-translation" }, line.translation || line.original || "（和訳を取得できませんでした）"));
                })
            ),
            h("div", { className: `sljp-status${snapshot.error ? " error" : ""}` }, snapshot.status)
        );
    }

    function injectStyles() {
        if (document.getElementById("spotify-lyrics-jp-style")) return;
        const style = document.createElement("style");
        style.id = "spotify-lyrics-jp-style";
        style.textContent = `
            :root {
                --sljp-sakura-main: #fbe7ef;
                --sljp-sakura-sidebar: #f7dce6;
                --sljp-sakura-player: #f4d2df;
                --sljp-sakura-card: #fff5f8;
                --sljp-sakura-soft: #edc9d6;
                --sljp-sakura-active: #efb8cc;
                --sljp-sakura-accent: #df789d;
                --sljp-sakura-accent-strong: #c94f7d;
                --sljp-sakura-text: #432833;
                --sljp-sakura-subtext: #765461;
                --sljp-sakura-border: rgba(123, 75, 92, .18);
                --sljp-sakura-shadow: rgba(114, 56, 79, .22);

                --spice-main: var(--sljp-sakura-main) !important;
                --spice-main-elevated: var(--sljp-sakura-card) !important;
                --spice-highlight: var(--sljp-sakura-sidebar) !important;
                --spice-highlight-elevated: #f9e5ec !important;
                --spice-sidebar: var(--sljp-sakura-sidebar) !important;
                --spice-player: var(--sljp-sakura-player) !important;
                --spice-card: var(--sljp-sakura-card) !important;
                --spice-shadow: var(--sljp-sakura-shadow) !important;
                --spice-selected-row: var(--sljp-sakura-active) !important;
                --spice-button: var(--sljp-sakura-accent) !important;
                --spice-button-active: #ffffff !important;
                --spice-button-disabled: var(--sljp-sakura-soft) !important;
                --spice-tab-active: var(--sljp-sakura-accent-strong) !important;
                --spice-notification: var(--sljp-sakura-card) !important;
                --spice-notification-error: #c74270 !important;
                --spice-misc: #8e6775 !important;
                --spice-text: var(--sljp-sakura-text) !important;
                --spice-subtext: var(--sljp-sakura-subtext) !important;
                --spice-rgb-main: 251, 231, 239 !important;
                --spice-rgb-main-elevated: 255, 245, 248 !important;
                --spice-rgb-highlight: 247, 220, 230 !important;
                --spice-rgb-highlight-elevated: 249, 229, 236 !important;
                --spice-rgb-sidebar: 247, 220, 230 !important;
                --spice-rgb-player: 244, 210, 223 !important;
                --spice-rgb-card: 255, 245, 248 !important;
                --spice-rgb-selected-row: 239, 184, 204 !important;
                --spice-rgb-button: 223, 120, 157 !important;
                --spice-rgb-button-disabled: 237, 201, 214 !important;
                --spice-rgb-text: 67, 40, 51 !important;
                --spice-rgb-subtext: 118, 84, 97 !important;

                --background-base: var(--sljp-sakura-main) !important;
                --background-highlight: var(--sljp-sakura-sidebar) !important;
                --background-press: #f1cad8 !important;
                --background-elevated-base: var(--sljp-sakura-card) !important;
                --background-elevated-highlight: #f9e5ec !important;
                --background-elevated-press: #f2d4df !important;
                --background-tinted-base: rgba(136, 77, 99, .10) !important;
                --background-tinted-highlight: rgba(136, 77, 99, .16) !important;
                --background-tinted-press: rgba(136, 77, 99, .22) !important;
                --text-base: var(--sljp-sakura-text) !important;
                --text-subdued: var(--sljp-sakura-subtext) !important;
                --text-bright-accent: #b83e6c !important;
                --essential-base: var(--sljp-sakura-text) !important;
                --essential-subdued: var(--sljp-sakura-subtext) !important;
                --decorative-base: var(--sljp-sakura-accent) !important;
                --decorative-subdued: #f0bdcf !important;
            }
            body, .Root__top-container { background: var(--sljp-sakura-main) !important; color: var(--sljp-sakura-text); }
            .sljp-root { height: 100%; min-height: 0; display: flex; flex-direction: column; color: var(--sljp-sakura-text); background: var(--sljp-sakura-main); }
            .sljp-track { padding: 12px 14px 7px; font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .sljp-toolbar { display: flex; flex-wrap: wrap; gap: 7px; padding: 7px 12px 11px; border-bottom: 1px solid var(--sljp-sakura-border); }
            .sljp-toolbar button, .sljp-toolbar select, .sljp-primary { border: 0; border-radius: 999px; padding: 7px 11px; color: var(--sljp-sakura-text); background: var(--sljp-sakura-soft); font: inherit; cursor: pointer; }
            .sljp-toolbar button:hover, .sljp-toolbar select:hover, .sljp-primary:hover { filter: saturate(1.08) brightness(.98); }
            .sljp-toolbar button:disabled { opacity: .45; cursor: default; }
            .sljp-primary { background: var(--sljp-sakura-accent); color: #ffffff; font-weight: 700; border-radius: 6px; }
            .sljp-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--sljp-sakura-subtext); }
            .sljp-lines { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 8px 35vh; scroll-behavior: smooth; }
            .sljp-line { border-radius: 8px; padding: 10px 9px; margin: 2px 0; transition: background .18s ease, transform .18s ease; }
            .sljp-line.active { background: var(--sljp-sakura-active); transform: translateX(2px); }
            .sljp-original { color: var(--sljp-sakura-subtext); font-size: 12px; line-height: 1.45; margin-bottom: 3px; }
            .sljp-translation { color: var(--sljp-sakura-text); font-size: 16px; font-weight: 600; line-height: 1.55; }
            .sljp-line.active .sljp-translation { color: #352028; }
            .sljp-empty { padding: 28px 12px; color: var(--sljp-sakura-subtext); line-height: 1.7; }
            .sljp-status { padding: 8px 12px; border-top: 1px solid var(--sljp-sakura-border); color: var(--sljp-sakura-subtext); font-size: 11px; line-height: 1.35; }
            .sljp-status.error { color: #b92f61; }
            .sljp-fallback-panel { position: fixed; z-index: 999998; top: 64px; right: 360px; bottom: 96px; width: min(400px, calc(100vw - 24px)); overflow: hidden; border: 1px solid var(--sljp-sakura-border); border-radius: 12px; box-shadow: 0 16px 55px var(--sljp-sakura-shadow); background: var(--sljp-sakura-main); }
            .sljp-fallback-toggle { position: fixed; z-index: 999999; right: 380px; bottom: 108px; border: 0; border-radius: 999px; padding: 10px 15px; background: var(--sljp-sakura-accent); color: #ffffff; font-weight: 800; cursor: pointer; box-shadow: 0 8px 24px var(--sljp-sakura-shadow); }
            .sljp-fallback-header { display: flex; align-items: center; gap: 8px; }
            .sljp-fallback-header .sljp-track { flex: 1; min-width: 0; }
            .sljp-fallback-close { margin-right: 10px; border: 0; border-radius: 50%; width: 30px; height: 30px; color: var(--sljp-sakura-text); background: var(--sljp-sakura-soft); cursor: pointer; }
            .sljp-dom-modal { position: fixed; z-index: 1000000; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(67, 40, 51, .38); }
            .sljp-dom-modal-card { width: min(460px, calc(100vw - 40px)); display: grid; gap: 13px; padding: 22px; border-radius: 12px; color: var(--sljp-sakura-text); background: var(--sljp-sakura-card); box-shadow: 0 20px 70px var(--sljp-sakura-shadow); }
            .sljp-dom-modal-card h2, .sljp-dom-modal-card p { margin: 0; }
            .sljp-dom-modal-card p { color: var(--sljp-sakura-subtext); line-height: 1.5; }
            .sljp-dom-modal-card label { display: grid; gap: 5px; }
            .sljp-dom-modal-card input { box-sizing: border-box; width: 100%; border: 1px solid var(--sljp-sakura-soft); border-radius: 6px; padding: 9px 10px; color: var(--sljp-sakura-text); background: var(--sljp-sakura-main); outline: none; }
            .sljp-dom-modal-card input:focus { border-color: var(--sljp-sakura-accent); box-shadow: 0 0 0 2px rgba(223, 120, 157, .18); }
            .sljp-dom-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
            .sljp-dom-modal-actions button { border: 0; border-radius: 999px; padding: 8px 12px; color: var(--sljp-sakura-text); background: var(--sljp-sakura-soft); cursor: pointer; }
        `;
        document.head.appendChild(style);
    }

    function domButton(text, onClick) {
        const button = document.createElement("button");
        button.textContent = text;
        button.addEventListener("click", onClick);
        return button;
    }

    function findSpotifyRightSidebar(drawer) {
        const selectors = [
            ".Root__right-sidebar",
            '[class*="Root__right-sidebar"]',
            '[data-testid="right-sidebar"]',
            '[class*="right-sidebar"]',
            '[class*="rightSidebar"]'
        ];
        for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (!element || element === drawer || drawer.contains(element)) continue;
            const rect = element.getBoundingClientRect();
            if (rect.width >= 220 && rect.height >= 350 && rect.right >= window.innerWidth - 80) return element;
        }
        const candidates = [...document.querySelectorAll('aside, [class*="nowPlayingView"], [data-testid*="now-playing"]')];
        return candidates.find((element) => {
            if (element === drawer || drawer.contains(element)) return false;
            const rect = element.getBoundingClientRect();
            return rect.width >= 220 && rect.height >= 350 && rect.right >= window.innerWidth - 80;
        }) || null;
    }

    function positionFallbackPanel(drawer, toggle) {
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const sidebar = findSpotifyRightSidebar(drawer);
        const sidebarRect = sidebar?.getBoundingClientRect();
        const sidebarLeft = sidebarRect?.left > viewportWidth * 0.5
            ? sidebarRect.left
            : viewportWidth - Math.min(360, viewportWidth * 0.24);
        const availableRightEdge = sidebarLeft - 10;
        const minimumWidth = 310;

        if (viewportWidth >= 900 && availableRightEdge >= minimumWidth + 16) {
            const width = Math.min(400, availableRightEdge - 16);
            const left = Math.max(8, availableRightEdge - width);
            drawer.style.left = `${left}px`;
            drawer.style.right = "auto";
            drawer.style.width = `${width}px`;
            toggle.style.left = `${Math.max(12, availableRightEdge - 92)}px`;
            toggle.style.right = "auto";
        } else {
            drawer.style.left = "auto";
            drawer.style.right = "8px";
            drawer.style.width = "min(400px, calc(100vw - 24px))";
            toggle.style.left = "auto";
            toggle.style.right = "20px";
        }
    }

    function mountFallbackPanel() {
        document.getElementById("sljp-fallback-panel")?.remove();
        document.getElementById("sljp-fallback-toggle")?.remove();

        const drawer = document.createElement("section");
        drawer.id = "sljp-fallback-panel";
        drawer.className = "sljp-fallback-panel";
        const toggle = domButton("歌詞JP", () => {
            drawer.style.display = drawer.style.display === "none" ? "block" : "none";
        });
        toggle.id = "sljp-fallback-toggle";
        toggle.className = "sljp-fallback-toggle";
        document.body.append(drawer, toggle);
        positionFallbackPanel(drawer, toggle);
        window.addEventListener("resize", () => positionFallbackPanel(drawer, toggle));
        setInterval(() => positionFallbackPanel(drawer, toggle), 2000);

        let lastSnapshot = null;
        const render = (snapshot) => {
            const onlyPlaybackPositionChanged = lastSnapshot &&
                snapshot.lines === lastSnapshot.lines &&
                snapshot.track === lastSnapshot.track &&
                snapshot.entry === lastSnapshot.entry &&
                snapshot.settings === lastSnapshot.settings &&
                snapshot.loading === lastSnapshot.loading &&
                snapshot.status === lastSnapshot.status &&
                snapshot.error === lastSnapshot.error;

            if (onlyPlaybackPositionChanged) {
                drawer.querySelector(".sljp-line.active")?.classList.remove("active");
                const active = snapshot.activeIndex >= 0
                    ? drawer.querySelector(`[data-line-index="${snapshot.activeIndex}"]`)
                    : null;
                active?.classList.add("active");
                if (snapshot.settings.autoScroll) {
                    scrollActiveLine(drawer.querySelector(".sljp-lines"), active);
                }
                lastSnapshot = snapshot;
                return;
            }

            const root = document.createElement("div");
            root.className = "sljp-root";

            const header = document.createElement("div");
            header.className = "sljp-fallback-header";
            const track = document.createElement("div");
            track.className = "sljp-track";
            track.textContent = snapshot.track ? `${snapshot.track.title} — ${snapshot.track.artist}` : "Spotify Lyrics JP";
            track.title = track.textContent;
            const close = domButton("×", () => { drawer.style.display = "none"; });
            close.className = "sljp-fallback-close";
            header.append(track, close);
            root.appendChild(header);

            const toolbar = document.createElement("div");
            toolbar.className = "sljp-toolbar";
            const reload = domButton("再取得", () => loadTrack({ force: true }));
            reload.disabled = snapshot.loading;
            const alternate = domButton("別ソース", () => loadTrack({ alternate: true }));
            alternate.disabled = snapshot.loading || !snapshot.entry;
            const mode = document.createElement("select");
            for (const [value, text] of [["free", "無料翻訳"], ["gemini", "Gemini自然訳"], ["deepl", "DeepL翻訳"], ["claude", "Claude Haiku自然訳"], ["openai", "GPT自然訳"]]) {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = text;
                mode.appendChild(option);
            }
            mode.value = snapshot.settings.translationMode;
            mode.disabled = snapshot.loading;
            mode.addEventListener("change", changeMode);
            toolbar.append(reload, alternate, mode, domButton("API設定", showSettingsDialog));

            for (const [key, text] of [["showOriginal", "原文"], ["autoScroll", "自動スクロール"]]) {
                const label = document.createElement("label");
                label.className = "sljp-check";
                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.checked = snapshot.settings[key];
                checkbox.addEventListener("change", () => toggleSetting(key, checkbox.checked));
                label.append(checkbox, document.createTextNode(text));
                toolbar.appendChild(label);
            }
            root.appendChild(toolbar);

            const lines = document.createElement("div");
            lines.className = "sljp-lines";
            if (snapshot.loading) {
                const empty = document.createElement("div");
                empty.className = "sljp-empty";
                empty.textContent = "検索・翻訳中…";
                lines.appendChild(empty);
            } else if (!snapshot.lines.length) {
                const empty = document.createElement("div");
                empty.className = "sljp-empty";
                empty.textContent = snapshot.error ? "「再取得」で再試行できます。" :
                    (snapshot.track ? (snapshot.status || "この曲の公開歌詞は見つかりませんでした。「再取得」を試してください。") : "曲を再生すると歌詞を表示します。");
                lines.appendChild(empty);
            } else {
                snapshot.lines.forEach((line, index) => {
                    const item = document.createElement("div");
                    item.className = `sljp-line${index === snapshot.activeIndex ? " active" : ""}`;
                    item.dataset.lineIndex = String(index);
                    if (snapshot.settings.showOriginal && line.original !== line.translation) {
                        const original = document.createElement("div");
                        original.className = "sljp-original";
                        original.textContent = line.original;
                        item.appendChild(original);
                    }
                    const translation = document.createElement("div");
                    translation.className = "sljp-translation";
                    translation.textContent = line.translation || line.original || "（和訳を取得できませんでした）";
                    item.appendChild(translation);
                    lines.appendChild(item);
                });
            }
            root.appendChild(lines);

            const status = document.createElement("div");
            status.className = `sljp-status${snapshot.error ? " error" : ""}`;
            status.textContent = snapshot.status;
            root.appendChild(status);

            drawer.replaceChildren(root);
            if (snapshot.settings.autoScroll && snapshot.activeIndex >= 0) {
                scrollActiveLine(lines, lines.querySelector(`[data-line-index="${snapshot.activeIndex}"]`), "auto");
            }
            lastSnapshot = snapshot;
        };
        subscribe(render);
        render(state);
        return { toggle: () => { toggle.click(); } };
    }

    injectStyles();

    let panel;
    let nativePanel = false;
    if (Spicetify.Panel?.registerPanel && Spicetify.Topbar?.Button) {
        panel = Spicetify.Panel.registerPanel({
            label: "歌詞JP",
            children: h(LyricsPanel)
        });
        const icon = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 3v11.3A4 4 0 1 0 11 18V7h8V3H9Zm-2 17a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/></svg>`;
        new Spicetify.Topbar.Button("歌詞JP", icon, () => panel.toggle());
        nativePanel = true;
    } else {
        panel = mountFallbackPanel();
        console.warn("[SpotifyLyricsJP] Panel APIがないため互換パネルを使用します");
    }

    Spicetify.Player.addEventListener("songchange", () => {
        setTimeout(() => loadTrack(), 250);
    });
    Spicetify.Player.addEventListener("onplay", () => {
        // Recover when a song was already playing before the extension finished loading
        if (!state.track || !state.lines.length) setTimeout(() => loadTrack(), 300);
    });
    Spicetify.Player.addEventListener("onprogress", (event) => {
        updateHighlight(typeof event?.data === "number" ? event.data : (Spicetify.Player.getProgress?.() || 0));
    });

    globalThis.SpotifyLyricsJP = Object.freeze({
        version: VERSION,
        reload: () => loadTrack({ force: true }),
        alternate: () => loadTrack({ alternate: true }),
        openSettings: showSettingsDialog
    });
    if (globalThis.__SLJP_TEST_MODE) {
        globalThis.__SLJP_TEST_API = Object.freeze({
            normalizeTitle,
            normalizeSearchText,
            cleanTitleForSearch,
            splitArtists,
            titleSimilarity,
            getCandidateScore,
            isCandidateSafe,
            selectBestCandidate,
            buildSearchVariants,
            parseLyrics,
            getNormalLyrics,
            translateClaude,
            translateLines,
            getTranslationCacheKey,
            getCachedTranslation,
            cacheTranslation,
            saveSettings,
            missingKeyForMode,
            claudeModel: CLAUDE_MODEL,
            translationCacheLimit: TRANSLATION_CACHE_LIMIT,
            setTestState: (patch) => setState(patch),
            getTestState: () => state
        });
    }

    // Retry a few times on startup — Player.data is often empty at first paint
    let bootAttempts = 0;
    const bootLoad = () => {
        loadTrack();
        bootAttempts++;
        if (bootAttempts < 4 && !getCurrentTrack()) {
            setTimeout(bootLoad, 800 * bootAttempts);
        }
    };
    setTimeout(() => {
        bootLoad();
        if (nativePanel) Spicetify.Panel.setPanel(panel.id).catch(() => {});
    }, 400);

    console.info(`[SpotifyLyricsJP] v${VERSION} loaded`);
})();
