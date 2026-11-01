# ピッチノート（フォルダなし版）

少年サッカーの試合動画を解析し、AI音声で実況するWebアプリです。
すべてのファイルを同じ場所に置く構成なので、スマホからでもそのままGitHubにアップロードできます。

## ファイル一覧（すべて同じ階層）

| ファイル | 役割 |
|---|---|
| index.html | 画面 |
| style.css | デザイン |
| main.js | 画面の制御 |
| config.js | 調整用の設定値 |
| detector.js | YOLO 推論 |
| tracker.js | 追跡（ByteTrack 方式） |
| teams.js | ユニフォーム色でチーム分け |
| pitch.js | 座標変換 |
| analysis.js | 走行距離・パス・シュートなどの算出 |
| commentary.js | 実況文と読み上げ |
| draw.js | 描画 |
| _headers | Cloudflare 用の設定 |
| export_model.py | モデル書き出し用（PCで実行） |
| yolov8n.onnx | AIモデル（自分で用意して追加） |

## 1. AIモデルを用意する

Python が使えるPCで次を実行すると、同じ場所に `yolov8n.onnx`（約12MB）ができます。

```
pip install ultralytics onnx onnxsim
python export_model.py
```

できた `yolov8n.onnx` も、ほかのファイルと同じくリポジトリのトップにアップロードしてください。

## 2. GitHub にアップロード

リポジトリを作成 →「Add file」→「Upload files」で、全ファイルを選んでアップロード。
リポジトリのトップに index.html などが並んでいれば正しい状態です。

## 3. Cloudflare Pages につなぐ

Workers & Pages → 作成 → Pages → Git に接続 → リポジトリを選択。

| 項目 | 設定 |
|---|---|
| フレームワーク プリセット | なし |
| ビルドコマンド | 空欄 |
| ビルド出力ディレクトリ | 空欄（エラーになる場合は `/`） |

## 使い方・精度向上・制限事項

1. 動画を選ぶ（最初は1〜2分の範囲がおすすめ）
2. ピッチ全体が映った場面で一時停止し、左奥 → 右奥 → 右手前 → 左手前 の順に角をタップ
3. 「解析を開始」
4. 「最初から再生」で実況付き再生

- 推奨ブラウザは PC の Chrome / Edge（GPUで高速）。スマホでも動きますが時間がかかります
- ボールが見つからない場合は config.js の `tilesX` を 3 に、遅い場合は `tilesX: 1`、`sampleFps: 6` に
- IDは追跡番号で背番号ではありません
- YouTube の動画は YouTube Studio から元ファイルをダウンロードして読み込んでください
- 検出には Ultralytics YOLOv8（AGPL-3.0）を使用しています。公開・配布の際はライセンス条件を確認してください
