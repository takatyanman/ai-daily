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

Push時にHTML本文・一覧・feed.xmlを生成します。過去記事は日付ファイルが残る間保持し、RSSは新しい30件です。AIのAPIキーや本文生成処理はこの公開リポジトリにはありません。

関心メモは予約タスク側で保持し、「更新して」と明示されたときだけ変更します。会話の個人情報や非公開の業務情報を記事に転載しません。

## 公開範囲

GitHub Pagesもリポジトリのファイル・履歴も公開です。検索除外のrobots.txt/metaは付けますが、非公開サイトや認証によるアクセス制限ではありません。公開用ファイルへ関心メモ・タスク指示・秘密情報を入れないでください。

## ローカル検証

```sh
node scripts/build.test.mjs
node scripts/build.mjs
python3 scripts/check_feed.py dist
```

実サイトとして動かす場合は SITE_BASE_URL に検証済みのHTTPSサイトURLを指定します。GitHub ActionsではPagesの出力から設定します。新しい依存パッケージのインストールは不要です。

## 料金の確認先

- GitHub Pagesの提供対象: https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- Actions課金: https://docs.github.com/en/billing/concepts/product-billing/github-actions
- ChatGPTの予約タスク: https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt

自動実行の作成だけでは毎朝の公開成功は証明されません。GitHub書込の承認待ち、モデル利用上限、配信エラーなどの動作確認が必要です。
