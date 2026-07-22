"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

if (process.env.SLJP_FAKE_INDEXEDDB === "1") {
    global.indexedDB = require("fake-indexeddb").indexedDB;
}

global.__SLJP_TEST_MODE = true;
global.document = {
    getElementById: () => null,
    createElement: (tag) => tag === "textarea"
        ? { _value: "", set innerHTML(value) { this._value = value; }, get value() { return this._value; } }
        : { id: "", textContent: "" },
    head: { appendChild: () => {} }
};

const local = new Map();
local.set("spotify-lyrics-jp:settings", JSON.stringify({
    translationMode: "claude",
    claudeApiKey: "test-claude-key"
}));

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

let claudeCalls = 0;
let lastRequest = null;
global.fetch = async (url, options) => {
    claudeCalls++;
    lastRequest = { url: String(url), options, body: JSON.parse(options.body) };
    const content = lastRequest.body.messages[0].content;
    const input = JSON.parse(content.slice(content.lastIndexOf("入力:\n") + "入力:\n".length));
    const payload = {
        stop_reason: "end_turn",
        content: [{
            type: "text",
            text: JSON.stringify({ translations: input.map(({ id, text }) => ({ id, ja: `訳:${text}` })) })
        }]
    };
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload)
    };
};

require(path.join(__dirname, "..", "spotifyLyricsJP.js"));
const api = global.__SLJP_TEST_API;
const track = { key: "spotify:track:test", title: "Example Song", artist: "Example Artist" };

(async () => {
    assert.equal(api.claudeModel, "claude-haiku-4-5-20251001");
    assert.equal(api.translationCacheLimit, 10000);
    assert.equal(api.missingKeyForMode("claude"), false);

    const lines = Array.from({ length: 30 }, (_, index) => ({
        timeMs: index * 1000,
        order: index,
        original: `Line ${index}`,
        translation: ""
    }));
    const translated = await api.translateLines(lines, track);
    assert.equal(claudeCalls, 1, "通常の1曲はClaude APIを1回だけ呼ぶ");
    assert.equal(translated.lines.length, lines.length);
    assert.equal(translated.lines[29].translation, "訳:Line 29");

    const japanese = await api.translateLines([
        { timeMs: 0, order: 0, original: "日本語の歌詞", translation: "" },
        { timeMs: 1000, order: 1, original: "そのまま表示", translation: "" }
    ], track);
    assert.equal(claudeCalls, 1, "日本語だけの歌詞ではClaude APIを呼ばない");
    assert.equal(japanese.cacheable, false, "日本語だけの歌詞は翻訳キャッシュを消費しない");
    assert.equal(japanese.lines[0].translation, "日本語の歌詞");

    assert.equal(lastRequest.url, "https://api.anthropic.com/v1/messages");
    assert.equal(lastRequest.options.headers["x-api-key"], "test-claude-key");
    assert.equal(lastRequest.options.headers["anthropic-dangerous-direct-browser-access"], "true");
    assert.equal(lastRequest.body.model, "claude-haiku-4-5-20251001");
    assert.equal(lastRequest.body.output_config.format.type, "json_schema");

    const cacheKey = api.getTranslationCacheKey(track, "claude", lines);
    await api.cacheTranslation(cacheKey, translated);
    const cached = await api.getCachedTranslation(cacheKey, lines);
    assert.equal(cached.lines[0].translation, "訳:Line 0");
    assert.match(cached.engine, /キャッシュ/);
    if (global.indexedDB) {
        const db = await new Promise((resolve, reject) => {
            const request = global.indexedDB.open("spotify-lyrics-jp-cache", 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const record = await new Promise((resolve, reject) => {
            const request = db.transaction("translations", "readonly").objectStore("translations").get(cacheKey);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        assert.equal(record.translations[0], "訳:Line 0", "IndexedDBへ翻訳を保存する");
        db.close();
    } else {
        assert.ok(local.get("spotify-lyrics-jp:translation-cache:v1"), "IndexedDB非対応時は小容量キャッシュへ保存する");
    }

    console.log("Spotify Lyrics JP Claude tests passed.");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
