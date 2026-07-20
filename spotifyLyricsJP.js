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

    const VERSION = "2.0.6";
    const STORAGE_KEY = "spotify-lyrics-jp:settings";
    const CACHE_LIMIT = 30;
    const REQUEST_TIMEOUT_MS = 25000;
    const TRANSLATION_TIMEOUT_MS = 65000;
    const PROVIDERS = ["LRCLIB", "Lyrica", "Lyrics.ovh"];
    const React = Spicetify.React;
    const h = React.createElement;

    const DEFAULT_SETTINGS = Object.freeze({
        translationMode: "free",
        geminiApiKey: "",
        deepLApiKey: "",
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
        const item = data?.item || data?.track;
        if (!item) return null;
        const metadata = item.metadata || {};
        const artists = Array.isArray(item.artists)
            ? item.artists.map((artist) => artist?.name).filter(Boolean).join(", ")
            : "";
        const title = firstNonEmpty(item.name, metadata.title, metadata.track_name);
        const artist = firstNonEmpty(artists, metadata.artist_name, metadata.artist);
        const album = firstNonEmpty(item.album?.name, metadata.album_title, metadata.album_name);
        const uri = firstNonEmpty(item.uri, metadata.uri);
        const durationMs = Number(Spicetify.Player.getDuration?.()) ||
            Number(data?.duration) || Number(item.duration?.milliseconds) ||
            Number(item.duration_ms) || Number(metadata.duration) || 0;
        if (!title || !artist) return null;
        return {
            title,
            artist,
            album,
            uri,
            durationSeconds: durationMs > 0 ? durationMs / 1000 : 0,
            key: uri || `${title.toLowerCase()}\u001f${artist.toLowerCase()}`
        };
    }

    function normalizeSearchText(text) {
        return String(text || "")
            .toLowerCase()
            .replace(/\([^)]*\)/g, "")
            .replace(/\[[^\]]*\]/g, "")
            .replace(/[^\p{L}\p{N}]/gu, "");
    }

    function normalizeTitle(text) {
        const withoutEdition = String(text || "").replace(
            /\s*[-–—]\s*(?:\d{4}\s+)?(?:remaster(?:ed)?|radio edit|single version|album version|deluxe edition|live(?:\s+at|\s+from)?).*$/i,
            ""
        );
        return normalizeSearchText(withoutEdition);
    }

    function isJapanese(text) {
        return /[\u3040-\u30ff\u3400-\u9fff]/u.test(String(text || ""));
    }

    function durationClose(a, b, tolerance) {
        return a > 0 && b > 0 && Math.abs(a - b) <= tolerance;
    }

    function getCandidateScore(candidate, track) {
        const wantedTitle = normalizeTitle(track.title);
        const wantedArtist = normalizeSearchText(track.artist);
        const wantedAlbum = normalizeSearchText(track.album);
        const candidateTitle = normalizeTitle(candidate.trackName);
        const candidateArtist = normalizeSearchText(candidate.artistName);
        const candidateAlbum = normalizeSearchText(candidate.albumName);
        const candidateDuration = Number(candidate.duration) || 0;
        let score = 0;

        if (candidateTitle === wantedTitle) score += 300;
        else if (candidateTitle.includes(wantedTitle) || wantedTitle.includes(candidateTitle)) score += 60;
        if (wantedArtist && candidateArtist === wantedArtist) score += 220;
        else if (wantedArtist && (candidateArtist.includes(wantedArtist) || wantedArtist.includes(candidateArtist))) score += 70;
        if (wantedAlbum && candidateAlbum === wantedAlbum) score += 120;
        else if (wantedAlbum && (candidateAlbum.includes(wantedAlbum) || wantedAlbum.includes(candidateAlbum))) score += 45;

        if (track.durationSeconds > 0 && candidateDuration > 0) {
            const difference = Math.abs(track.durationSeconds - candidateDuration);
            if (difference <= 3) score += 260;
            else if (difference <= 10) score += 190;
            else if (difference <= 20) score += 110;
            else if (difference <= 45) score += 25;
            else score -= 350;
        }
        if (String(candidate.syncedLyrics || "").trim()) score += 20;
        else if (String(candidate.plainLyrics || "").trim()) score += 10;
        return score;
    }

    function isCandidateSafe(candidate, track) {
        if (!candidate || normalizeTitle(candidate.trackName) !== normalizeTitle(track.title)) return false;
        const wantedArtist = normalizeSearchText(track.artist);
        const candidateArtist = normalizeSearchText(candidate.artistName);
        const wantedAlbum = normalizeSearchText(track.album);
        const candidateAlbum = normalizeSearchText(candidate.albumName);
        const artistMatches = Boolean(wantedArtist && candidateArtist && (
            candidateArtist === wantedArtist || candidateArtist.includes(wantedArtist) || wantedArtist.includes(candidateArtist)
        ));
        const albumMatches = Boolean(wantedAlbum && candidateAlbum && (
            candidateAlbum === wantedAlbum || candidateAlbum.includes(wantedAlbum) || wantedAlbum.includes(candidateAlbum)
        ));
        const candidateDuration = Number(candidate.duration) || 0;
        if (track.durationSeconds > 0 && candidateDuration > 0 &&
            Math.abs(track.durationSeconds - candidateDuration) > 45) return false;
        return artistMatches || albumMatches || durationClose(track.durationSeconds, candidateDuration, 20);
    }

    function selectBestCandidate(candidates, track, requireSynced) {
        return candidates
            .filter((candidate) => candidate && (!requireSynced || String(candidate.syncedLyrics || "").trim()))
            .filter((candidate) => isCandidateSafe(candidate, track))
            .sort((a, b) => getCandidateScore(b, track) - getCandidateScore(a, track))[0] || null;
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
        const params = new URLSearchParams({ track_name: track.title, artist_name: track.artist });
        if (track.album) params.set("album_name", track.album);
        if (track.durationSeconds > 0) params.set("duration", String(Math.round(track.durationSeconds)));
        const candidates = [];

        try {
            const exact = await fetchJson(`https://lrclib.net/api/get?${params.toString()}`);
            if (exact && (exact.syncedLyrics || exact.plainLyrics)) candidates.push(exact);
        } catch (error) {
            console.info("[SpotifyLyricsJP] LRCLIB exact lookup failed", error.message);
        }

        const searchUrls = [
            `https://lrclib.net/api/search?${new URLSearchParams({ track_name: track.title, artist_name: track.artist })}`,
            `https://lrclib.net/api/search?${new URLSearchParams({ track_name: track.title })}`
        ];
        const searches = await Promise.allSettled(searchUrls.map((url) => fetchJson(url)));
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
            const payload = await fetchJson(`https://api.lyrics.ovh/suggest/${encodeURIComponent(track.title)}`);
            const suggestions = Array.isArray(payload?.data) ? payload.data : [];
            const ranked = suggestions.map((item) => {
                const candidate = {
                    trackName: item.title_short || item.title || "",
                    artistName: item.artist?.name || "",
                    albumName: item.album?.title || "",
                    duration: Number(item.duration) || 0,
                    item
                };
                return { candidate, score: getCandidateScore(candidate, track) };
            }).filter(({ candidate }) => isCandidateSafe(candidate, track))
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
            sequence: "3,4,5,6,7",
            country: "JP"
        });
        const payload = await fetchJson(`https://wilooper-lyrica.hf.space/lyrics/?${params.toString()}`, {}, 30000);
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
        if (!isJapanese(track.artist)) {
            try {
                const direct = await invokeLyrica(track, track.title, track.artist, track.album);
                if (direct) return direct;
            } catch (error) {
                console.info("[SpotifyLyricsJP] Lyrica direct lookup failed", error.message);
            }
        }
        const canonical = await findCanonicalTrack(track);
        if (!canonical) return null;
        try {
            return await invokeLyrica(track, canonical.trackName, canonical.artistName, canonical.albumName);
        } catch (error) {
            console.info("[SpotifyLyricsJP] Lyrica canonical lookup failed", error.message);
            return null;
        }
    }

    async function invokeLyricsOvh(title, artist) {
        const payload = await fetchJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
        const lyrics = String(payload?.lyrics || "").trim();
        return lyrics ? { syncedLyrics: "", plainLyrics: lyrics, source: "Lyrics.ovh" } : null;
    }

    async function getLyricsOvhEntry(track) {
        if (!isJapanese(track.artist)) {
            try {
                const direct = await invokeLyricsOvh(track.title, track.artist);
                if (direct) return direct;
            } catch (error) {
                console.info("[SpotifyLyricsJP] Lyrics.ovh direct lookup failed", error.message);
            }
        }
        const canonical = await findCanonicalTrack(track);
        if (!canonical) return null;
        try { return await invokeLyricsOvh(canonical.trackName, canonical.artistName); }
        catch (error) {
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
        const lrclib = await getLrclibEntry(track);
        if (lrclib?.syncedLyrics) return lrclib;
        const lyrica = await getLyricaEntry(track);
        if (lyrica?.syncedLyrics) return lyrica;
        if (lrclib) return lrclib;
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
                if (entry && normalizedLyrics(entry) && normalizedLyrics(entry) !== currentText) return entry;
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
        if (mode === "openai") return await translateOpenAI(batch, track);
        return await translateFree(batch);
    }

    async function translateLines(lines, track) {
        const result = lines.map((line) => ({ ...line }));
        const mode = settings.translationMode;
        const contextMode = mode !== "free";
        const maxLines = contextMode ? 24 : 8;
        const maxCharacters = contextMode ? 4000 : 900;
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
            length += line.original.length;
        }
        await flush();
        const labels = { free: "無料翻訳", gemini: "Gemini自然訳", deepl: "DeepL翻訳", openai: "GPT自然訳" };
        return { lines: result, engine: `${labels[mode] || labels.free}${fallbackUsed ? "（一部無料訳）" : ""}` };
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
                setState({ track, entry: null, lines: [], source: "", loading: false, status: "この曲の公開歌詞は見つかりませんでした。自動再試行はしません。", error: "" });
                return;
            }
            const rawLines = parseLyrics(entry);
            if (!rawLines.length) throw new Error("歌詞データに表示できる行がありませんでした。");
            const translated = await translateLines(rawLines, track);
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
            const translated = await translateLines(parseLyrics(entry), track);
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
            h("label", null, "OpenAI APIキー", h("input", { type: "password", value: draft.openAiApiKey, onChange: update("openAiApiKey"), style: inputStyle(), autoComplete: "off" })),
            h("p", { style: { margin: 0, fontSize: 12, color: "var(--spice-subtext)" } }, "ChatGPT PlusとOpenAI APIの利用料金は別です。"),
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
                    h("option", { value: "openai" }, "GPT自然訳")
                ),
                h("button", { onClick: showSettingsDialog }, "API設定"),
                h("label", { className: "sljp-check" }, h("input", { type: "checkbox", checked: snapshot.settings.showOriginal, onChange: (event) => toggleSetting("showOriginal", event.target.checked) }), "原文"),
                h("label", { className: "sljp-check" }, h("input", { type: "checkbox", checked: snapshot.settings.autoScroll, onChange: (event) => toggleSetting("autoScroll", event.target.checked) }), "自動スクロール")
            ),
            h("div", { className: "sljp-lines", ref: scrollAreaRef },
                snapshot.loading && h("div", { className: "sljp-empty" }, "検索・翻訳中…"),
                !snapshot.loading && !snapshot.lines.length && h("div", { className: "sljp-empty" }, snapshot.error ? "「再取得」で再試行できます。" : "曲を再生すると歌詞を表示します。"),
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
            .sljp-root { height: 100%; min-height: 0; display: flex; flex-direction: column; color: var(--spice-text); background: var(--spice-main); }
            .sljp-track { padding: 12px 14px 7px; font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .sljp-toolbar { display: flex; flex-wrap: wrap; gap: 7px; padding: 7px 12px 11px; border-bottom: 1px solid rgba(255,255,255,.08); }
            .sljp-toolbar button, .sljp-toolbar select, .sljp-primary { border: 0; border-radius: 999px; padding: 7px 11px; color: var(--spice-text); background: var(--spice-button-disabled); font: inherit; cursor: pointer; }
            .sljp-toolbar button:hover, .sljp-toolbar select:hover, .sljp-primary:hover { filter: brightness(1.18); }
            .sljp-toolbar button:disabled { opacity: .45; cursor: default; }
            .sljp-primary { background: var(--spice-button); color: var(--spice-button-active); font-weight: 700; border-radius: 6px; }
            .sljp-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--spice-subtext); }
            .sljp-lines { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 8px 35vh; scroll-behavior: smooth; }
            .sljp-line { border-radius: 8px; padding: 10px 9px; margin: 2px 0; transition: background .18s ease, transform .18s ease; }
            .sljp-line.active { background: rgba(30, 215, 96, .16); transform: translateX(2px); }
            .sljp-original { color: var(--spice-subtext); font-size: 12px; line-height: 1.45; margin-bottom: 3px; }
            .sljp-translation { color: var(--spice-text); font-size: 16px; font-weight: 600; line-height: 1.55; }
            .sljp-line.active .sljp-translation { color: var(--spice-text); }
            .sljp-empty { padding: 28px 12px; color: var(--spice-subtext); line-height: 1.7; }
            .sljp-status { padding: 8px 12px; border-top: 1px solid rgba(255,255,255,.08); color: var(--spice-subtext); font-size: 11px; line-height: 1.35; }
            .sljp-status.error { color: #ff8a8a; }
            .sljp-fallback-panel { position: fixed; z-index: 999998; top: 64px; right: 360px; bottom: 96px; width: min(400px, calc(100vw - 24px)); overflow: hidden; border: 1px solid rgba(255,255,255,.13); border-radius: 12px; box-shadow: 0 16px 55px rgba(0,0,0,.6); background: var(--spice-main); }
            .sljp-fallback-toggle { position: fixed; z-index: 999999; right: 380px; bottom: 108px; border: 0; border-radius: 999px; padding: 10px 15px; background: #1ed760; color: #000; font-weight: 800; cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
            .sljp-fallback-header { display: flex; align-items: center; gap: 8px; }
            .sljp-fallback-header .sljp-track { flex: 1; min-width: 0; }
            .sljp-fallback-close { margin-right: 10px; border: 0; border-radius: 50%; width: 30px; height: 30px; color: var(--spice-text); background: var(--spice-button-disabled); cursor: pointer; }
            .sljp-dom-modal { position: fixed; z-index: 1000000; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(0,0,0,.68); }
            .sljp-dom-modal-card { width: min(460px, calc(100vw - 40px)); display: grid; gap: 13px; padding: 22px; border-radius: 12px; color: var(--spice-text); background: var(--spice-card); box-shadow: 0 20px 70px rgba(0,0,0,.65); }
            .sljp-dom-modal-card h2, .sljp-dom-modal-card p { margin: 0; }
            .sljp-dom-modal-card p { color: var(--spice-subtext); line-height: 1.5; }
            .sljp-dom-modal-card label { display: grid; gap: 5px; }
            .sljp-dom-modal-card input { box-sizing: border-box; width: 100%; border: 1px solid var(--spice-button-disabled); border-radius: 6px; padding: 9px 10px; color: var(--spice-text); background: var(--spice-main); outline: none; }
            .sljp-dom-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
            .sljp-dom-modal-actions button { border: 0; border-radius: 999px; padding: 8px 12px; color: var(--spice-text); background: var(--spice-button-disabled); cursor: pointer; }
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
            for (const [value, text] of [["free", "無料翻訳"], ["gemini", "Gemini自然訳"], ["deepl", "DeepL翻訳"], ["openai", "GPT自然訳"]]) {
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
                empty.textContent = snapshot.error ? "「再取得」で再試行できます。" : "曲を再生すると歌詞を表示します。";
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
            isCandidateSafe,
            selectBestCandidate,
            parseLyrics,
            getNormalLyrics,
            setTestState: (patch) => setState(patch),
            getTestState: () => state
        });
    }

    setTimeout(() => {
        loadTrack();
        if (nativePanel) Spicetify.Panel.setPanel(panel.id).catch(() => {});
    }, 500);

    console.info(`[SpotifyLyricsJP] v${VERSION} loaded`);
})();
