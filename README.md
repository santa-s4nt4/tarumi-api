# 樽見鉄道 API — D1接続デモ

Cloudflare Workersがリクエストを受け、D1に保存したダミーデータをJSONで返す最小構成です。
実際の路線照合・トンネル判定・到着予測はまだ行いません。GPSはレスポンスに返すだけで保存しません。

```text
GitHub（コード） → Cloudflare Workers（API） → Cloudflare D1（データ）
                            ↑ GPS送信 / JSON取得
                          スマホなど
```

GitHubとD1が直接同期するわけではありません。GitHubからWorkersをデプロイし、WorkersにD1を接続します。

## 1. まず手元で試す（Cloudflareアカウント不要）

Node.jsの現行LTS版とnpmを用意し、このフォルダで実行します。

```sh
npm ci
npm run db:local
npm run dev
```

`http://localhost:8787/api/demo` をブラウザで開くと、ローカルD1から取得したデータが表示されます。
この時点ではインターネット上には公開されません。終了はターミナルで Ctrl+C。

GPSを送る場合は、別のターミナルで次を実行します。

```sh
curl http://localhost:8787/api/position \
  -H 'Content-Type: application/json' \
  -d '{"latitude":35.65,"longitude":136.61}'
```

レスポンス例（座標・名称・秒数はすべてデモ用）：

```json
{
  "demo": true,
  "source": "d1",
  "message": "D1から取得した固定のダミーデータです。GPSによる位置判定・時間予測は未実装です。",
  "input": { "latitude": 35.65, "longitude": 136.61 },
  "position": null,
  "upcoming": [
    { "id": "tunnel-demo", "type": "tunnel", "name": "ダミートンネル", "etaSeconds": 25 },
    { "id": "river-demo", "type": "river", "name": "ダミー川", "etaSeconds": 70 },
    { "id": "station-demo", "type": "station", "name": "ダミー駅", "etaSeconds": 160 }
  ]
}
```

`GET /api/demo` は同じ内容で `input: null` を返します。
不正なGPS・JSONは400、存在しないURLは404、未対応メソッドは405、DB未初期化は503です。
APIは読み取り専用・認証なしです。公開用ダミーデータのみを入れてください。

## 2. CloudflareにD1を作る

1. Cloudflareアカウントを作成してダッシュボードにログイン。
2. **Storage & databases → D1 SQL Database → Create database** を開く（画面名が違う場合はD1を検索）。
3. データベース名を **tarumi-demo** にして作成。
4. 作成された **Database ID** をコピー。
5. `wrangler.jsonc` の `database_id` のゼロのUUIDをコピーしたIDに置き換える。
   `binding` は **DB** のままにします。これがコードの `env.DB` と対応します。

Database IDは接続先の識別子で、パスワードではありません。APIトークンなどの認証情報はGitに入れないでください。

次にローカルのターミナルでログインし、クラウド側のD1へテーブルとダミーデータを登録します。

```sh
npx wrangler login
npm run db:remote
```

ブラウザが開いたら、D1を作ったCloudflareアカウントで許可します。
マイグレーション確認が表示されたら、対象が `tarumi-demo` であることを確認して適用します。
`--local` と `--remote` は別のDBです。ローカルのデータは自動でクラウドへコピーされません。
適用済みのマイグレーションは再実行されないため、このコマンドを繰り返しても重複登録されません。

## 3. GitHubへコードを置く

GitHubで空のリポジトリ `tarumi-api` を作成します（READMEの自動作成はオフ、Privateでも可）。
このフォルダで、`YOUR_ACCOUNT` を自分のGitHubアカウント名に置き換えて実行します。

```sh
git init -b main
git add .
git commit -m "Add Workers and D1 demo API"
git remote add origin https://github.com/YOUR_ACCOUNT/tarumi-api.git
git push -u origin main
```

GitHubへのログインを求められた場合はGitHub CLIなどで認証してください。
すでにGit管理されている場合は `git init`、登録済みなら `git remote add` は不要です。

## 4. GitHubからWorkersへ自動デプロイ

Cloudflareの **Workers & Pages → Create application → GitHubからインポート** を選びます。
GitHubを接続し、先ほどのリポジトリへのアクセスを許可してください。
選ぶのは **Workers** です（Pagesではありません）。

| 設定 | 値 |
| --- | --- |
| Worker名 / Project name | `tarumi-api`（wrangler.jsoncと一致させる） |
| Repository | `tarumi-api` |
| Production branch | `main` |
| Root directory | リポジトリのルート |
| Build command | 空欄 |
| Deploy command | `npm run deploy` |

依存関係はpackage.json / package-lock.jsonからインストールされます。
`wrangler.jsonc` の設定により、Workerへ **DB → tarumi-demo** のD1バインディングが作成されます。
デプロイ後、Workerの **Bindings** タブでこの接続を確認できます。

既存WorkerにGitを接続する場合は **Settings → Build** から設定できます。
自動生成されたビルド用トークンでD1権限エラーになる場合は、そのトークンに対象アカウントの
**Account → D1 → Edit** 権限を追加して再試行してください。トークン自体をコードに貼る必要はありません。

DBの初期化は手順2で済ませます。`npm run deploy` はDBマイグレーションを実行しません。
SQLを追加した場合は、別の番号のマイグレーションを作り `npm run db:remote` で適用します。

## 5. 公開APIを呼ぶ

デプロイ画面に表示されたURLに `/api/demo` を付けてブラウザで開きます。

```text
https://tarumi-api.<自分のサブドメイン>.workers.dev/api/demo
```

GPS送信の場合は、最初のcurlの `http://localhost:8787` を公開URLへ置き換えます。
以降は `main` へpushするとWorkersが自動更新されます。D1のデータはコードのpushでは更新されません。

## ファイル

- `src/index.js`: APIの処理
- `migrations/0001_demo.sql`: テーブルとダミーデータ
- `wrangler.jsonc`: WorkersとD1の接続設定
- `package-lock.json`: 使用するツールのバージョン固定

## 公式ドキュメント

- D1作成・バインディング: https://developers.cloudflare.com/d1/get-started/
- Git連携・ビルド設定: https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- マイグレーション: https://developers.cloudflare.com/d1/reference/migrations/
