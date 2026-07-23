"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

global.__SLJP_TEST_MODE = true;
let injectedStyle = "";
global.document = {
    getElementById: () => null,
    createElement: (tag) => tag === "textarea"
        ? { _value: "", set innerHTML(value) { this._value = value; }, get value() { return this._value; } }
        : { id: "", textContent: "" },
    head: { appendChild: (element) => { injectedStyle = element.textContent; } }
};

const local = new Map();
global.Spicetify = {
    Player: {
        data: null,
        getDuration: () => 0,
        getProgress: () => 0,
        addEventListener: () => {}
    },
    React: {
        createElement: (...args) => ({ args }),
        useState: (value) => [value, () => {}],
        useEffect: () => {},
        useRef: (value) => ({ current: value })
    },
    Panel: {
        registerPanel: () => ({ id: 5, toggle: async () => {}, onStateChange: () => {}, isActive: false }),
        setPanel: async () => {}
    },
    Topbar: { Button: class Button {} },
    PopupModal: { display: () => {}, hide: () => {} },
    LocalStorage: {
        get: (key) => local.get(key) || null,
        set: (key, value) => local.set(key, value)
    }
};

require(path.join(__dirname, "..", "spotifyLyricsJP.js"));
const api = global.__SLJP_TEST_API;
const track = { title: "Example Song - Remastered", artist: "Example Artist", album: "Example Album", durationSeconds: 200 };

assert.match(injectedStyle, /--sljp-sakura-main:\s*#fbe7ef/, "桜色テーマを注入する");
assert.match(injectedStyle, /--background-base:\s*var\(--sljp-sakura-main\)/, "Spotify本体の背景色にも桜色を適用する");
assert.doesNotMatch(injectedStyle, /rgba\(30,\s*215,\s*96/, "再生中の行へSpotifyグリーンを残さない");
assert.equal(api.normalizeTitle("Example Song - Remastered"), "examplesong");
assert.equal(api.isCandidateSafe({
    trackName: "Example Song", artistName: "Other Artist", albumName: "Other Album", duration: 400
}, track), false, "大きく再生時間が違う候補を拒否する");

const lines = api.parseLyrics({ syncedLyrics: "[00:01.50]Hello\n[00:03.250]World", plainLyrics: "" });
assert.deepEqual(lines.map((line) => line.timeMs), [1500, 3250]);

function response(payload, status = 200) {
    return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload)
    });
}

global.fetch = async (url) => {
    const value = String(url);
    if (value.includes("lrclib.net/api/get")) {
        return response({
            id: 1, trackName: "Example Song", artistName: "Example Artist",
            albumName: "Example Album", duration: 200,
            syncedLyrics: "", plainLyrics: "Plain fallback"
        });
    }
    if (value.includes("lrclib.net/api/search")) return response([]);
    if (value.includes("wilooper-lyrica")) {
        return response({
            status: "success",
            data: {
                source: "youtube_music", title: "Example Song", artist: "Example Artist",
                metadata: { album: "Example Album", duration: "3:20" },
                timed_lyrics: [{ start_time: 1000, text: "Timed line" }]
            }
        });
    }
    throw new Error(`Unexpected URL: ${value}`);
};

(async () => {
    const entry = await api.getNormalLyrics(track);
    assert.equal(entry.source, "Lyrica/YouTube Music", "通常歌詞より他ソースの同期歌詞を優先する");
    assert.match(entry.syncedLyrics, /Timed line/);
    console.log("Spotify Lyrics JP extension tests passed.");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
