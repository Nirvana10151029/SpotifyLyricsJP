# Spotify Lyrics JP v2.0.10 — Spotify内蔵版

Spotify公式サイトからインストールしたWindows版Spotifyへ、日本語訳付きの同期歌詞パネルを追加します。歌詞はSpotifyの右側に表示されるため、別ウィンドウを並べる必要はありません。

[Spotify Lyrics JP v2.0.10をダウンロード](https://github.com/Nirvana10151029/SpotifyLyricsJP/raw/refs/heads/main/SpotifyLyricsJP-Spicetify-2.0.10.zip)

## 導入方法

1. Microsoft Store版Spotifyを使っている場合はアンインストールします。
2. [Spotify公式サイト](https://www.spotify.com/jp/download/windows/)からWindows版をインストールし、一度ログインして終了します。
3. このZIPを右クリックして「すべて展開」します。
4. 展開したフォルダの `START-INSTALL.bat` をダブルクリックします。
5. 自動で開いたSpotifyの右側に「歌詞JP」が表示されれば完了です。

Spicetifyが未導入の場合は、Windows標準のwingetを使って自動導入します。閉じた歌詞パネルは、Spotify上部の音符ボタンから再表示できます。

## 主な機能

- 曲が変わるとSpotify内の歌詞パネルを自動更新
- 同期歌詞に合わせて現在行をハイライトし、自動スクロール
- LRCLIBの通常歌詞しか見つからなくても検索を続け、別候補や他サービスに同期歌詞があれば自動で入れ替え
- LRCLIB、YouTube Music、NetEase、Megalobiz、Musixmatch、SimpMusic、Lyrics.ovhを検索
- Remaster・Live・feat.などの装飾を除いた曲名や、複数アーティストの検索候補も自動生成
- LRCLIBとLyricaを並列検索し、安全に一致した同期歌詞を優先
- 曲名・アーティスト・アルバム・再生時間を照合し、同名の別楽曲や違うバージョンを除外
- 歌詞が違う場合は「別ソース」で別サービスへ切り替え
- 失敗した曲を無限に再検索せず、「再取得」を押したときだけ再試行
- 無料翻訳、Gemini自然訳、DeepL翻訳、GPT自然訳を画面から切り替え
- 原文表示・自動スクロールを切り替え

## 翻訳の設定

`無料翻訳` は設定なしで利用できます。

Gemini・DeepL・GPTを使う場合は、歌詞パネルの `API設定` を押し、利用するサービスのAPIキーを入力してください。

- Gemini：[Google AI Studio](https://aistudio.google.com/app/apikey)
- DeepL：[DeepL API](https://www.deepl.com/ja/your-account/keys)
- GPT：[OpenAI Platform](https://platform.openai.com/api-keys)

GPT自然訳はOpenAI Responses APIとGPT-5.6 Solを使用します。ChatGPT PlusとOpenAI APIの料金は別です。選択したAI翻訳が失敗した場合は、その曲の残りを無料翻訳へ自動で切り替えます。

## APIキーとプライバシー

- APIキーはこのPCのSpotify用ローカルストレージに保存されます。
- Spicetify版ではWindowsの暗号化機能を直接利用できないため、キーは暗号化されません。共用PCではAI翻訳を使わないか、利用後にキーを空欄で保存してください。
- 曲名・アーティスト・アルバム・再生時間は歌詞検索サービスへ送信されます。
- 歌詞本文は選択した翻訳サービスへ送信されます。
- SpotifyのCookie、ログイン情報、認証トークンを外部の歌詞・翻訳サービスへ送信する処理はありません。

## うまく動かないとき

- Spotify更新後に消えた場合：Spotifyを終了して `START-INSTALL.bat` をもう一度実行します。
- セットアップが成功表示なのに「歌詞JP」が出ない場合：v2.0.10の `START-INSTALL.bat` を実行します。必要な拡張機能を再適用します。
- Spotify側の更新で右パネルAPIが使えない場合：自動で互換パネルへ切り替わり、右下の緑色の「歌詞JP」ボタンから開閉できます。
- 互換パネルはSpotify本来の右側パネルを検出し、その左隣へ自動配置します。アーティスト画像・アルバム情報・Canvas表示を隠しません。
- パネルを閉じた場合：Spotify上部の音符ボタンを押します。
- 歌詞取得に失敗した場合：通信状態を確認し、少し待ってから `再取得` を押します。
- 歌詞が違う場合：`別ソース` を押します。
- 完全に取り外す場合：`START-UNINSTALL.bat` を実行します。

## 必要環境

- Windows 10/11
- Spotify公式サイトからインストールしたWindows版Spotify
- インターネット接続
- [Spicetify](https://spicetify.app/)（未導入ならインストーラーがwingetで導入）

## 注意

Spotify、Spicetify、各歌詞・翻訳サービスの非公式ツールです。各サービスの仕様変更やSpotify更新により、一時的に動作しなくなる場合があります。歌詞の権利は各権利者に帰属し、この配布物に歌詞そのものは収録していません。

Microsoft Store版を使い続ける場合は、別ウィンドウ型の[旧版v1.4.1](https://github.com/Nirvana10151029/SpotifyLyricsJP/raw/refs/heads/main/SpotifyLyricsJP-1.4.1.zip)も残しています。

## ライセンス

MIT License。詳しくは [LICENSE.txt](LICENSE.txt) を参照してください。
