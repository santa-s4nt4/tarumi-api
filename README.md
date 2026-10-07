# 樽見鉄道 距離・時間API

スマホのGPSを `POST /api/position` へ送ると、指定方向の走行記録と照合し、駅・トンネル入口/出口・根尾川横断地点までの距離(m)と予測時間(秒)を返します。Cloudflare Workersで計算し、参照データはD1から読みます。

## ローカルで試す

```sh
npm ci
npm run data:local
npm run dev
```

別ターミナルで：

```sh
curl http://localhost:8787/api/position \
  -H 'Content-Type: application/json' \
  -d '{"latitude":35.514371,"longitude":136.653235,"direction":"front"}'
```

- `latitude`, `longitude`: 必須、数値。
- `direction`: 必須。`front`=往路、`back`=復路。GPS1点から方向を推測しません。
- `recordedAt`: 任意。GPS取得時刻をタイムゾーン付きISO日時で指定。viewerでの補正用に `prediction.basedAt` へ返します。省略時はnull。古いGPSを送るとその古い位置に対する予測になります。

上記の実データ例では、木知原の停車開始まで約492.3m・46秒、川の符号付き横距離は約-115.3mです（データ更新で変わります）。

## 返却値

| フィールド | 内容 |
| --- | --- |
| `position.latitude/longitude` | GPSを走行軌跡に合わせた座標 |
| `position.distanceAlongRouteMeters` | 選択した走行記録の始点からの距離。往路・復路で原点が異なる |
| `position.matchOffsetMeters` | 入力GPSと対応する走行軌跡のずれ |
| `position.referenceTimeSeconds` | 元のGPSファイル内の `t` に対応する時刻 |
| `position.inTunnel / tunnelId` | 登録トンネル区間内か。GPS軌跡への投影に基づく推定 |
| `upcoming` | 前方の全イベント。距離順で、各要素に `distanceMeters`, `etaSeconds`, `type`, `target`, `id`, `name`, `location` |
| `next.station / tunnel / river` | 各種類の直近イベント。前方にない場合null |
| `river.distanceMeters` | 線路に直交する線と川の交点までの横方向距離 |
| `river.signedDistanceMeters` | 上記距離に東＋・西−を付けた値。往路・復路で符号規則は変わらない |
| `river.intersection / origin` | 川との交点と、走行軌跡上の計算原点 |
| `river.status` | `ok`, `no_intersection`, `direction_unavailable`, `east_west_undefined` |
| `prediction` | 予測方式・基準時刻・制約 |
| `coverage` | 走行記録の始点・終点・距離・時刻範囲 |
| `excludedFeatures` | 記録範囲・距離条件により採用できなかった地点ID |
| `datasetVersion` | データのハッシュ。参照データのキャッシュは最大60秒 |
| `attribution` | 提供データの帰属情報 |

### 川の2種類の距離

- `next.river.distanceMeters / etaSeconds`: GPS走行軌跡と川の中心線が交差する地点まで、**軌跡に沿って**進む距離・時間。鉄橋入口ではありません。
- `river.signedDistanceMeters`: **現在位置から横方向**に川までの距離。走って到着する対象ではないので `river.etaSeconds` はnullです。

線路の向きは対応位置の前後20m（合計約40m）の軌跡から求めます。その直交線を両側に延ばし、川の座標列の線分と交差させ、最も近い交点を採用します。川の端を無限に延長しません。交点がなければ距離はnullです。交点が真北・真南で東西を決められない場合、絶対距離は返して符号付き距離はnullにします。

### 計算と制約

- 線路の代用として、GPSを時刻順につないだ線を使います。距離は北緯35.57度を基準にした局所平面座標での近似です。GPSの誤差・補間・停車中の揺れも含まれ、測量値ではありません。
- 時間は、対応する現在地点とイベント地点の**同じ方向の記録時刻の差**。座標点の間は補間します。元データの `speed` は座標の変位からkm/hであることを確認し、表示に使います。
- 駅付近100m以内でGPS由来速度が0.8m/s以下の状態が10秒以上続く区間を検出し、最初の停車開始を `arrival` とします。停車中は0秒を保持し、区間を出たら次の駅へ進みます。停止が検出できない場合だけ `station_point` にフォールバックします。GPS由来の推定到着であり、正式な到着時刻ではありません。
- `position.speedKmh` / `speedMetersPerSecond` は元GPSの `speed` を対応する2点間で補間した記録上の速度です。`speedSource: gps_record_speed`。スマホ自身の現在速度ではありません。
- トンネルは入口/出口をそれぞれ投影し、進行方向に並べ替えます。トンネル内では前方の出口が `next.tunnel` になります。
- 川の交差はGPS線と提供の川の線の幾何的な交点です。揺れによる近接交差を30m以内でまとめます。実際の鉄橋の数・位置とは別で、データに基づく候補です。
- 往路GPSは木知原の手前〜樽見、復路GPSは樽見〜織部付近です。大垣〜本巣などへの予測はできません。反対方向の時刻を流用しません。
- 地点の軌跡からのずれが100m超、または軌跡端にしか対応せず端から30m超なら除外します。端付近の地点は端へ近似される場合があります。
- リクエストのGPSが軌跡から100m超ならHTTP 422。通過済みイベントを前方として返しません。現在地ちょうどのイベントは0mとして含めます。
- トンネルでGPSが消えた場合の位置推定や5秒間の補間はviewer側で行います。速度差による予測補正・方向自動判定は未実装です。

## 元データとD1への取り込み

| ファイル | 用途 |
| --- | --- |
| `data/gps-front.json` | 往路 `records[].lat/lon/t`。tは秒 |
| `data/gps-back.json` | 復路の同形式 |
| `data/stations.json` | 駅の座標・名称 |
| `data/tarumi_tunnels.csv` | トンネルの両端座標 |
| `data/neo_river_points.csv` | sequence順に連結する根尾川の座標列 |

```sh
npm run data:build   # 加工して generated/routes.sql を作成。クラウドには触らない
npm run data:local   # 再生成してローカルD1へ登録
npm run data:remote  # 再生成してクラウドD1へ登録
```

登録先は専用テーブル `route_dataset_chunks`。既存のデモテーブルは変更しません。同じ方向の参照データを置換するので、繰り返し実行可能です。大きなSQL文を避けるためJSONを分割保存しています。取り込みはイベント稼働前に行ってください。部分的な取り込み・未登録は503になる場合があります。

`data:build` は含めた駅・トンネル・交差数と除外IDを表示します。提供CSVの形式（引用符なし）に対応し、形式が変わった場合はエラーで止まります。

## Cloudflare・GitHubへの公開

既存のD1を使う場合、`wrangler.jsonc` の `database_id` が対象DBのIDであることを確認します。
`database_name` はCloudflareの表示名に合わせてください。バインディング名 **DB** は変更しません。

初めての場合はCloudflareの **Storage & databases → D1 SQL Database** でDBを作り、Database IDを設定します。

```sh
npx wrangler login
npm run data:remote
npm run deploy
```

公開URLに対して `/api/position` を呼べます。

GitHub自動デプロイの場合は、コード・元データをリポジトリへpushし、Cloudflareの **Workers & Pages** からGitHubを接続します。

| 設定 | 値 |
| --- | --- |
| Worker名 | `tarumi-api` |
| Branch | `main` |
| Root directory | リポジトリのルート |
| Build command | 空欄 |
| Deploy command | `npm run deploy` |

以降はpushでコードが更新されます。**D1のデータはpushだけでは更新されません**。データ変更時は `npm run data:remote` も実行してください。APIトークンはGitに入れません。

## 検証・旧デモ

```sh
npm test
npm run check
```

`npm test` は投影・時間補間・東西符号・複数交点・交点なし・重複GPS・トンネル内判定を検証します。
旧 `GET /api/demo` を使う場合だけ `npm run db:local`（クラウドでは `npm run db:remote`）でダミーテーブルを初期化してください。

400: 不正な座標/方向/日時/JSON、404: URLなし、405: 未対応メソッド、422: 記録ルート外、503: D1参照データなし・読み込み失敗。
APIは公開・読み取り専用でGPSをDB保存しません。CORSは全オリジンに許可しています。

公式資料：[D1の接続](https://developers.cloudflare.com/d1/get-started/)・[Workers Git連携](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)・[D1のサイズ制限](https://developers.cloudflare.com/d1/platform/limits/)
