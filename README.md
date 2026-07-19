# Spotify Lyrics JP — Windows Store版対応

Windows Store版のSpotifyで再生中の曲を検出し、英語などの歌詞を日本語と並べて出す、小さな別ウィンドウのアプリです。同期情報のない歌詞が先に見つかった場合も検索を続け、LRCLIB内の別候補やLyricaの同期歌詞があれば自動でそちらを採用します。

Spotify本体は変更しません。SpotifyのCookie、`sp_dc`、Spotify開発者登録は不要です。無料翻訳はAPIキーなしで使えます。Gemini・DeepL・GPTを使う場合だけ、選んだサービスのAPIキーが必要です。

## 使い方

1. このフォルダを展開する。
2. Microsoft Store版Spotifyで曲を再生する。
3. `RUN.bat` をダブルクリックする。
4. 開いたウィンドウをSpotifyの横に置く。

動作確認のため黒い画面も開いたままになります。これは正常です。起動に失敗した場合はエラー画面が残り、`Startup.log` が自動的に開きます。

初回は曲の歌詞検索と和訳に少し時間がかかります。曲が変わると自動で切り替わります。

### 翻訳を切り替える

- `無料翻訳`：設定なしですぐ使えます。従来どおりの機械翻訳です。
- `Gemini自然訳`：前後の歌詞をまとめて読み、Geminiが自然な日本語にします。
- `DeepL翻訳`：訳の安定性と原文への忠実さを重視します。DeepL API Freeにも対応します。
- `GPT自然訳`：GPT-5.6 Terraで歌詞の物語・比喩・スラングを重視した自然訳を作ります。
- 初めて各方式を選ぶと、そのサービスのAPIキー入力画面が開きます。キーはWindowsのユーザー単位暗号化でPC内に保存されます。
- キーを変更するときは `API設定` を押します。
- 選んだサービスが一時的に使えない場合は、自動で無料翻訳へ切り替え、ステータス欄に `一部無料訳` と表示します。

APIキーの作成先：

- Gemini：[Google AI Studio](https://aistudio.google.com/app/apikey)
- DeepL：[DeepL API](https://www.deepl.com/ja/pro-api)
- GPT：[OpenAI Platform](https://platform.openai.com/api-keys)

ChatGPT Plusの料金にOpenAI API利用料は含まれません。GPT自然訳にはOpenAI Platform側でAPIの支払い設定・利用枠が必要です。

## できること

- Windowsのメディア再生情報から、Store版Spotifyの曲名・アーティスト・再生位置を読む
- 公開歌詞サービス LRCLIB から歌詞を取得
- LRCLIBの結果に同期情報がない場合も、LRCLIB内の別候補とLyrica経由のYouTube Music、NetEase、Megalobiz、Musixmatch、SimpMusicを自動検索
- 正しく照合できた同期歌詞があれば自動で入れ替え、どこにもない場合だけ通常歌詞を表示
- LRCLIBに通常歌詞も無い場合はLyrics.ovhを検索
- 曲名だけでなく再生時間とアルバムも照合し、同名の別楽曲を除外
- 歌詞が違う場合に「別ソース」ボタンでLRCLIB以外の同期歌詞へ切り替え
- 原文と日本語を並べて表示
- 無料翻訳・Gemini・DeepL・GPTを画面から切り替え
- タイムスタンプ付き歌詞がある曲では、現在行のハイライトと自動スクロール
- 「常に手前」「原文を表示」「自動スクロール」をその場で切替

## 必要なもの

- Windows 10 version 1809 以降、または Windows 11
- Microsoft Store版Spotify
- インターネット接続
- Gemini・DeepL・GPTを使う場合のみ、各サービスのAPIキー

## 大事な注意

- Spotify内部の歌詞を直接取り出す方式ではありません。Spotifyを改造せず、Windowsが共有する再生情報だけを使います。
- 歌詞はLRCLIB、Lyricaが参照する各サービス、またはLyrics.ovhにある曲だけ表示できます。曲によっては歌詞がない、違う版が出る、同期しない場合があります。
- 曲名・アーティスト名は歌詞検索のためLRCLIB、Lyrica、Lyrics.ovhへ送信されます。歌詞本文は選んだ翻訳方式に応じて無料翻訳サービス、Google Gemini API、DeepL API、OpenAI APIのいずれかへ送信します。アカウント情報やSpotifyのCookieは送信しません。
- 各APIキーは `%LOCALAPPDATA%\SpotifyLyricsJPStore\settings.json` にWindowsのユーザー単位暗号化で保存され、ログには記録しません。
- 自動和訳なので、DeepLやGPTでも固有名詞・比喩・スラングを誤訳することがあります。
- DeepLとOpenAIの利用枠・料金は各社の契約内容によります。

## うまく動かないとき

1. Spotifyで曲を再生した状態で `DIAGNOSE.bat` をダブルクリック。
2. `Spotify 再生セッション` が「OK」になるか確認。
3. 「確認」と出る行のスクリーンショットを送る。

起動中のエラーは次のログに出ます。

`%LOCALAPPDATA%\SpotifyLyricsJPStore\SpotifyLyricsJPStore.log`

## 仕組み

SpotifyがWindowsに公開する再生セッションから曲名と再生位置を取得します。同期歌詞はLRCLIBとLyricaを優先し、同期版がない場合はLRCLIBまたはLyrics.ovhの通常歌詞を使います。和訳は無料翻訳、Gemini、DeepL、GPTから選べます。どの方式でもStore版Spotifyのファイルを触ったり、ログイン情報を抽出したりしません。

## ライセンス

MIT License。詳しくは [LICENSE.txt](LICENSE.txt) を参照してください。
