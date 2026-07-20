# Changelog

## 2.0.2 — 2026-07-20

- 既存のSpicetifyバックアップがある環境で `backup apply` が停止する問題を修正
- 通常の `apply`、初回用 `backup apply`、既存バックアップ復旧用 `restore backup apply` の順で自動復旧
- 拡張機能が利用するSpicetify APIを明示的に有効化

## 2.0.1 — 2026-07-20

- Windowsのコマンド画面で起動用BATが壊れて読まれる問題を修正
- Windows向けのCRLF改行・PowerShell 5.1互換UTF-8 BOMで梱包
- 起動するファイルを `START-INSTALL.bat` と `START-UNINSTALL.bat` に整理し、直接開く必要のないPowerShell本体と区別
- セットアップ画面を成功・失敗どちらの場合も閉じずに確認できるよう修正

## 2.0.0 — 2026-07-20

- Spotify公式サイト版とSpicetifyに対応し、別ウィンドウからSpotify右側の内蔵パネルへ変更
- 再生曲の自動検出、同期ハイライト、自動スクロールをSpicetify Player APIへ移植
- LRCLIBで通常歌詞しか見つからない場合も検索を続け、別候補またはLyricaの同期歌詞を自動優先
- LRCLIB、Lyrica経由のYouTube Music・NetEase・Megalobiz・Musixmatch・SimpMusic、Lyrics.ovhに対応
- 曲名・アーティスト・アルバム・再生時間の照合と、45秒以上異なる候補の除外を移植
- 「再取得」と「別ソース」をSpotify内蔵パネルへ追加
- 取得失敗後は自動再試行せず、曲変更または手動操作まで停止するよう実装
- 無料翻訳、Gemini、DeepL、GPTの切り替えとAPI設定画面を移植
- Gemini・GPTは行ID付きJSONを検証し、歌詞行の結合・省略による同期ずれを防止
- DeepL API Free/Proのエンドポイントをキーから自動判定
- GPT自然訳をGPT-5.6 SolとResponses APIの構造化出力に更新
- AI翻訳失敗時の無料翻訳フォールバックを実装
- Web版Spotify・Spicetify・拡張機能を確認して導入するWindows用インストーラーを追加
- 拡張機能だけを安全に取り外すアンインストーラーを追加
