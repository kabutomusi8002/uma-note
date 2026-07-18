# UMA NOTE

スマートフォン中心で使う、競馬予想・実購入・収支・振り返り管理PWAです。

予想段階の「買いたい券面」と、実際に購入した券面を分け、発走前の判断をロックして履歴として残します。結果確定後は実購入だけを基準に払戻・収支・回収率を計算します。

> このアプリに自動投票、投票サイトへのログイン、決済、購入指示送信はありません。予想・記録・分析専用です。

## 技術構成

- Next.js App Router / React / TypeScript
- Supabase Auth / PostgreSQL / Row Level Security
- CSSによるスマートフォン優先レスポンシブUI
- Web App Manifest / Service Worker / PWAアイコン
- Vitest / ESLint / TypeScript
- vinext + Cloudflare Worker互換ビルド（クラウド公開可能）

## 実装済み機能

|領域|内容|
|---|---|
|レース|開催日、競馬場、レース番号、発走時刻、レース名|
|予想|印、選出馬、展開、馬場、危険人気、穴馬、買い／見送り／未定|
|買い目|単勝、馬連、ワイド、3連複、3連単|
|買い方|通常、BOX、フォーメーション。重複を除外して点数を展開|
|金額|点数、1点金額、合計投資額を自動計算|
|ロック|発走前の明示ロック、発走時刻後のDB強制ロック、変更履歴|
|券面分離|予想案 `proposal` と実購入 `actual` を別管理|
|結果|着順、100円あたり払戻、暫定／公式確定、実投資、払戻、収支、回収率|
|収支区分|`live`（実収支）、`demo`、`test`を分離。デモ／テストは累計・レース別収支・反省傾向から除外|
|反省|展開、馬場、軸、相手、買い目、資金、判断、その他に分類|
|交換|バージョン付き `---RACE---` 形式の複数レース入出力|
|ルール|予想ルールの版管理、使用版のスナップショット|
|保存・同期|端末へ自動保存。メールリンク認証中はレース／ルールをSupabaseへ自動保存し、手動同期も可能|
|PWA|ホーム画面追加、スタンドアロン表示、アプリシェルと静的資産のオフラインキャッシュ|

## 画面構成

- ホーム：収支サマリーとレースカード
- 予想：レース情報、印、展開、馬場、人気評価、最終判定、ロック履歴
- 買い目：予想案と実購入を切り替えて登録
- 結果・払戻：着順と公式払戻から収支を自動計算
- 反省：分類タグ、振り返り、次回アクション
- 分析：累計収支、レース別収支、反省カテゴリ傾向
- ルール：新しい版の作成、有効版の切り替え
- 設定：Supabase認証・同期、PWA状態、インポート／エクスポート

詳しい設計は [画面設計](docs/screen-design.md)、[開発手順](docs/development-plan.md)、[データベース設計](docs/database-design.md) を参照してください。

## ローカル起動

### 必要環境

- Node.js 22.13以上
- npm 10以上（Node.jsに同梱）
- 任意：Supabase CLI（ローカルDBまたはCLIでマイグレーションする場合）

### 1. 依存関係をインストール

```bash
npm install
```

### 2. 環境変数を用意

```bash
cp .env.example .env.local
```

Windows PowerShellの場合：

```powershell
Copy-Item .env.example .env.local
```

Supabaseをまだ接続しない場合は `.env.local` なしでも起動できます。レースとルールはブラウザの端末領域へ自動保存されるため、再読み込み後も続けられます。Supabaseを設定してログインすると、編集したレースとルール版をクラウドへも自動保存します。未編集のサンプルデータは自動送信されません。初期サンプルは `demo`、動作確認用レースは画面から `test` に設定でき、どちらも実収支集計へ含まれません。

### 3. 開発サーバーを起動

```bash
npm run dev
```

表示されたLocal URLをスマートフォンまたはブラウザで開きます。

## Supabase接続

### 1. プロジェクトを作成

Supabaseで新しいプロジェクトを作成し、Project SettingsのAPI欄から以下を取得します。

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-or-publishable-key>
NEXT_PUBLIC_SITE_URL=https://<your-production-domain>
```

`NEXT_PUBLIC_SITE_URL`は公開時のOG画像URL用です。ローカルだけなら省略できます。

`SUPABASE_SERVICE_ROLE_KEY` はブラウザ用ではありません。必要な場合もサーバーまたは管理作業だけに使い、`NEXT_PUBLIC_*` を付けないでください。

### 2. PostgreSQLスキーマを適用

Supabase CLIを使う場合：

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push
```

ローカルSupabaseを使う場合：

```bash
supabase start
supabase db reset
```

SQL Editorを使う場合は、次の順に実行します。

1. `supabase/migrations/0001_initial_schema.sql`
2. `supabase/migrations/0002_race_data_scope.sql`
3. `supabase/seed.sql`

マイグレーションには、テーブル、制約、インデックス、変更履歴トリガー、発走時刻ロック、集計ビュー、JSON保存RPC、RLSポリシーが含まれます。

### 3. メールリンク認証を設定

Supabase AuthenticationのURL Configurationで、以下を登録します。

- Site URL：公開先URL。開発時だけなら表示されたLocal URL
- Redirect URLs：Local URLと本番URLを両方追加

アプリの「設定」→「クラウド同期」でメールアドレスを入力します。受信したリンクから戻ると、保存済みデータを自動読込し、その後の変更を約700msの間隔で自動保存します。「クラウドから読込」と「Supabaseへ同期」は、明示的に再読込／全件同期したい場合に使えます。

### セキュリティ

- アプリデータは `auth.uid()` 単位のRLSで分離
- 統合RPCは `security invoker` でRLSを迂回しない
- 予想変更履歴は利用者が更新・削除できない
- ロック後または発走時刻後の予想変更はDBでも拒否
- 予想案と実購入は `bet_slips.kind` で分離
- 暫定結果は公式結果へ自動昇格せず、「結果を確定」した場合だけ累計収支へ反映
- `races.data_scope = 'live'` のレースだけを収支ビューへ含め、デモ／テストの払戻を実績から除外

## `---RACE---` 形式

UTF-8の行指向 `RACE/1` 形式です。複数レースを1ファイルへ連結できます。

```text
---RACE---
FORMAT_VERSION: 1
ID: race-example
DATA_SCOPE: test
DATE: 2026-07-19
COURSE: 函館
RACE_NUMBER: 11
START_TIME: 15:25
...
---END RACE---
```

自由記述や入れ子データは、改行・区切り文字で壊れないようJSON値として表現します。未知の版、必須項目欠落、不正な券種や金額は保存前に拒否します。完全な仕様は `lib/race-format.ts` の `RACE_FORMAT_SPECIFICATION` にあります。

## 品質確認

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

テストは次を含みます。

- 全5券種の通常／BOX／フォーメーション展開
- 順不同券種の正規化と重複除外
- 点数、投資額、払戻倍率、収支、回収率
- 実収支／デモ／テスト区分と集計除外、旧端末データのデモ移行
- 不正な馬番、点数、金額、払戻の検証
- `---RACE---` の往復変換、複数ブロック、壊れた入力
- UIモデルとSupabase RPC JSON間の変換
- DBロック回避、馬名保持、暫定結果、ルール版IDの回帰テスト

## 本番ビルドと公開

```bash
npm run build
npm start
```

このプロジェクトはCloudflare Worker互換のESM出力を生成し、Supabaseを外部PostgreSQLとして利用します。公開環境には `.env.local` を置かず、ホスティング側の環境変数／Secret設定へSupabaseの公開URLと公開キーを登録してください。

Cloudflare Workersへ公開する場合は、初回だけ `npx wrangler login` で認証し、CloudflareのAccount IDを `CLOUDFLARE_ACCOUNT_ID` に設定してから実行します。CIではログインの代わりに `CLOUDFLARE_API_TOKEN` をSecretとして設定してください。

```bash
npx vinext deploy
```

`vinext deploy` は本番ビルドとWorkersへのデプロイをまとめて実行します。Supabaseを使う公開版では、実行前に `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SITE_URL` をビルド環境へ設定してください。

PWAのService Workerは本番ビルドでだけ登録します。初回オンライン表示後はアプリシェルとビルド済み資産をキャッシュし、端末に自動保存した入力をオフラインでも開けます。通信断中の変更は端末に残るため、再接続後に手動同期するか、対象を再編集してクラウド保存を再試行してください。Service Worker変更時はキャッシュ版を更新します。

## ディレクトリ

```text
app/                       画面、PWA manifest、Service Worker登録
lib/                       型、計算、RACE形式、Supabaseアダプタ
public/                    PWAアイコン、Service Worker
supabase/migrations/       PostgreSQLマイグレーション
supabase/seed.sql          競馬場・反省カテゴリの共有マスター
tests/                     ドメイン・入出力・アダプタテスト
docs/                      DB、画面、開発手順の設計資料
.openai/hosting.json       クラウドホスティング設定
```

## 意図的に実装していないもの

- JRA、地方競馬、外部投票サービスへの自動投票
- 投票サイトの認証情報保存
- オッズや出馬表の自動取得
- 払戻の外部サイトからの自動取得
- 複数人共有、共同編集、公開予想SNS

外部データ取得を追加する場合も、利用規約とライセンスを確認し、予想記録と投票処理は分離してください。
