# 毎朝3本のAI作成記事とRSS

外部AI APIを使用せず、ChatGPTの定期タスクで作った記事データをGitHubへ保存し、無料のGitHub Pagesから本文とRSSを配信するための静的サイトです。

初回3記事と配信プログラムを作成・検証済みです。このリポジトリへのPushでPagesへ公開します。実際の公開状態はActionsのデプロイ結果で確認してください。記事を自動生成する定期タスクは別途設定が必要です。

- 本文一覧: https://takatyanman.github.io/ai-daily/
- RSS: https://takatyanman.github.io/ai-daily/feed.xml

## 公開先の準備

1. GitHubで記事公開専用のPublicリポジトリ（例: ai-daily）を作成し、READMEを初期化します。
2. Settings → Pages → Source を GitHub Actions にします。
3. ChatGPTのGitHub連携がこのリポジトリを読み書きできることを確認します。
4. 配信ファイルを登録すると、Pagesのワークフローが正しい公開URLでRSSとHTMLを生成します。

公開URLは、Pagesのデプロイ成功と本文・RSSの読み戻し後に案内します。GitHub Pagesと公開リポジトリの標準Actionsは無料対象です。Plus側のAI処理は利用上限・クレジット設定に従い、追加課金の設定が確認できるまで定期実行は有効化しません。

## 更新するデータ

各日 content/YYYY-MM-DD.json に次を保存します。各日は必ず3記事です。

- date: 日本時間の日付
- articles: id・title・category・summary・body・publishedAt・kind・sourcesを持つ3件
- id: YYYY-MM-DD-1、YYYY-MM-DD-2、YYYY-MM-DD-3。再試行でも同じIDを使用します。
- kind: ニュースまたは解説。一般的な説明を最新ニュースとして扱いません。
- sources: 1〜8件のtitleとHTTPS URL

図解付きの記事はreadingも持ちます。hook（120字以下）、takeaways（3件・各90字以下）、sections（小見出し2〜6件と本文段落の0始まりstart）、diagram、action（200字以下）を指定します。本文はbodyを正とし、見出しは本文を複製せずに挿入します。

diagramはflowまたはcompare、title（60字以下）、items（2〜4件のicon・label・text）、caption（180字以下）です。labelは16字以下、textは60字以下。アイコンはchat、check、arrow、shoe、shirt、book、headphones、run、clock、home、bolt、train、battery、documentから選びます。詳しい検証条件はscripts/build.mjsを参照してください。

図解は固定のSVG部品と記事内の短いラベルから生成します。外部の画像生成APIは使いません。RSSの最新30件には、同じ記事のイラストを640×360のPNGに変換したサムネイルを付けます。過去のreadingがない記事も引き続き表示できます。

Push時にHTML本文・一覧・feed.xmlを生成します。過去記事は日付ファイルが残る間保持し、RSSは新しい30件です。AIのAPIキーや本文生成処理はこの公開リポジトリにはありません。

関心メモは予約タスク側で保持し、「更新して」と明示されたときだけ変更します。会話の個人情報や非公開の業務情報を記事に転載しません。

## 公開範囲

GitHub Pagesもリポジトリのファイル・履歴も公開です。検索除外のrobots.txt/metaは付けますが、非公開サイトや認証によるアクセス制限ではありません。公開用ファイルへ関心メモ・タスク指示・秘密情報を入れないでください。

## 記事の音声再生

最新14日分は、各日の3記事を1本のMP3にまとめて配信します。記事ページの「音声で聴く」から開いている記事の位置で再生し、その日の残りの記事へ自動で進みます。再生速度は0.8〜3倍、記事移動と再生位置の変更に対応します。HTMLの音声再生とMedia Sessionを使い、画面ロック中も再生を続けられる構成です。端末・ブラウザ・省電力設定・通信状況による停止は実機で確認してください。ページを閉じると再生は終了します。

音声が次の記事へ進むと、本文・見出し・図・出典もその記事へ切り替わります。音声要素とファイルを維持したまま表示を変更するため、記事の切り替えで再生をやり直しません。合成した音声の実際のPCMフレームから段落ごとの時刻を計測し、再生中の見出し・段落を強調します。「本文を自動で追う」をオフにすれば自由に読み進められ、「再生位置へ」で戻れます。本文・音声の版や段落の文字列が一致しない場合は、対応しない段落の強調を行いません。

再生を始めると、スマホの縦画面では上に現在の記事の図、下に読み上げ中の本文を表示します。図と本文は別々にスクロールでき、一時停止中も図を見られます。「全体を表示」で図を見渡し、「図を拡大」で読みやすい幅に戻せます。図が複数ある場合は読み上げ位置に応じて切り替わり、手動でも選べます。出典や利用条件は「図の説明・出典」で確認できます。「記事を読む」で音声を続けたまま通常表示へ戻り、「図と本文」から再び開けます。横画面や広い画面では図と本文を左右に配置します。

音声は公開記事だけからOpen JTalkで生成します。外部の音声API、APIキー、有料素材は使いません。音声モデルはNitechの `nitech_jp_atr503_m001`（Nagoya Institute of Technology・Tokyo Institute of Technology、[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)）です。[音声モデルの出典と利用条件](https://changelogs.ubuntu.com/changelogs/pool/multiverse/h/hts-voice-nitech-jp-atr503-m001/hts-voice-nitech-jp-atr503-m001_1.05-8/copyright)を画面とMP3にも記載します。固有名詞や数字の発音が不自然になる場合があります。

公開ビルドでは、公開済みの日付のMP3・日別メタデータ・読み上げ位置情報をそのまま引き継ぎ、新しい未公開日付だけ音声を生成します。既存音声の取得や整合性確認に失敗した場合は、過去分を再生成せず公開を停止します。記事や音声の改善は新規記事に適用します。音声をリポジトリへは保存せず、音声出力は64MiB以内に制限し、Pages成果物の保存期間は1日です。日付が対象外、本文と音声が不一致、取得に失敗した場合は、開いている記事だけの端末読み上げへ切り替えられます。この代替モードでは画面ロック時に停止する場合があります。

## ローカル検証

```sh
npm ci --ignore-scripts --no-audit --no-fund
node scripts/build.test.mjs
node scripts/build.mjs
node scripts/rasterize.mjs
python3 scripts/audio_test.py
python3 scripts/audio.py dist --reuse-published https://takatyanman.github.io/ai-daily/audio/index.json
python3 scripts/check_feed.py dist
```

実サイトとして動かす場合は SITE_BASE_URL に検証済みのHTTPSサイトURLを指定します。GitHub ActionsではPagesの出力から設定します。PNG変換にはバージョンを固定したオープンソースのresvgを使用します。ブラウザや外部画像サービスは不要です。

音声の生成・実音声テストにはUbuntuの `open-jtalk`、`open-jtalk-mecab-naist-jdic`、`hts-voice-nitech-jp-atr503-m001`、`ffmpeg` が必要です。辞書と音声モデルの場所は `OPEN_JTALK_DIC`、`OPEN_JTALK_VOICE`、実行ファイルは `OPEN_JTALK_BIN` で指定できます。音声生成は静的サイトのビルド後に実行してください。

## 料金の確認先

- GitHub Pagesの提供対象: https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- Actions課金: https://docs.github.com/en/billing/concepts/product-billing/github-actions
- ChatGPTの予約タスク: https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt

自動実行の作成だけでは毎朝の公開成功は証明されません。GitHub書込の承認待ち、モデル利用上限、配信エラーなどの動作確認が必要です。
