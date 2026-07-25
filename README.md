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
|ロック|発走前の明示ロック、発走時刻後のDB強制ロック、変更履歴、予想・予想買い目・使用ルールの独立スナップショット|
|券面分離|予想案 `proposal` と実購入 `actual` を別管理|
|結果|着順、100円あたり払戻、暫定／公式確定、実投資、払戻、収支、回収率|
|収支区分|`live`（実収支）、`demo`、`test`を分離。デモ／テストは累計・レース別収支・反省傾向から除外|
|反省|展開、馬場、軸、相手、買い目、資金、判断、その他に分類|
|交換|バージョン付き `---RACE---` 形式の複数レース入出力|
|ルール|予想ルールの版管理、使用版のスナップショット|
|保存・同期|LOCALモード、永続Outbox、再接続同期、メールリンク認証、端末間競合の比較・明示解決|
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

`.env.example` の接続値は空なので、そのまま複製してもLOCALモードになります。`.env.local` 自体を作らなくても起動できます。レース、ルール、設定は端末へ保存され、再読み込みやオフライン起動後も続けられます。Supabaseを設定してログインした場合も、編集はまず端末へ確定し、永続Outboxからクラウドへ送信します。未編集のサンプルデータは自動送信されません。初期サンプルは `demo`、動作確認用レースは `test` に設定でき、どちらも実収支集計へ含まれません。

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
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<sb_publishable_...>
NEXT_PUBLIC_SITE_URL=https://<your-production-domain>
```

`NEXT_PUBLIC_SITE_URL`は公開時のメタデータとPKCE認証コールバックURLの基準です。ローカル開発では`http://127.0.0.1:4173`、本番では公開先のHTTPS originを設定してください。

旧プロジェクトでは `NEXT_PUBLIC_SUPABASE_ANON_KEY` も使用できます。`service_role`、`sb_secret_*`、DBパスワード、接続文字列はブラウザ用ではなく、このアプリのクライアントコードから参照しません。管理作業はSupabase CLIまたはDashboardの保護された設定で行ってください。

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
3. `supabase/migrations/0003_cloud_tenancy.sql`
4. `supabase/migrations/0004_cloud_sync_protocol.sql`
5. `supabase/migrations/0005_locked_snapshot_and_local_migration.sql`
6. `supabase/migrations/0006_pre_remote_hardening.sql`
7. `supabase/migrations/0007_race_client_key_insert_fix.sql`
8. `supabase/seed.sql`

マイグレーションには、テーブル、制約、インデックス、変更履歴トリガー、発走時刻ロック、集計ビュー、JSON保存RPC、RLSポリシーが含まれます。

### 3. メールリンク認証を設定

Supabase AuthenticationのURL Configurationで、以下を登録します。

- Site URL：公開先URL。ローカル開発では`http://127.0.0.1:4173`
- Redirect URLs：`http://127.0.0.1:4173/auth/callback`
- 本番のRedirect URL：`https://<your-production-domain>/auth/callback`

アプリの「設定」→「クラウド同期」でメールアドレスを入力します。認証はPKCEのメールリンク方式です。リンクは認証を開始した同じ端末・ブラウザで開いてください。`/auth/callback`がURLの一時コードをセッションへ交換し、コードをURLから除去してホームへ戻します。期限切れまたは使用済みのリンクは再送してください。Redirect URL変更前に送信した古いリンクは再利用せず、新しいリンクを送信します。初回は端末データを即時送信せず、完全バックアップとクラウド差分のプレビュー後に移行対象を確定します。

通常編集は端末へ即時保存され、認証済みかつオンラインのときだけOutboxが送信されます。オフライン、通信失敗、トークン更新中でも変更は残り、再接続・画面復帰・手動再試行で同期を再開します。同期中にログアウトまたは別ユーザーへ切り替わった場合は進行中の要求を中断し、元ユーザーのOutboxをそのユーザー領域へ残します。別端末の更新はRLS付き`sync_change_log`のRealtime通知をきっかけに再取得しますが、通知自体を正本にはせず、version付きRPCの結果だけを採用します。migrationは、Supabase管理publicationが存在する場合だけこのchange logを自動追加します。

レースの`client_key`は作成時に一度だけ生成し、端末内レース、RACE/1バックアップ、Outbox payloadと`entityKey`へ保存します。リトライやアプリ再起動では同じ値を再利用します。旧版の未送信Outboxにキーがない場合は、保存済みOutboxの`entityKey`（なければ旧レースID）を一度だけ補完して端末DBへ再保存し、新しいランダム値は作りません。DB側も初回INSERT時点で`client_key`を必須にし、同じmutationの再送を二重登録せず、同じキーに別内容をcreateしようとした場合は競合として扱います。

初回移行画面は、バックアップ時点のレース・ルール・設定をクラウド値と比較します。レースは`live/demo/test`を保ったまま個別選択し、同名同版で内容の異なる不変ルール、設定の差、ロック済みレースは明示的な選択が終わるまで送信しません。発走後に初めて同期される未ロック予想は編集用の`client_record`として保持し、不変の発走前証跡には昇格しません。オフラインで発走前に明示ロックし、発走後に初めて同期した場合は、クライアント時刻由来であることを示す別の不変証跡へ保存します。`v0.1.1-local-clean`時代のロック済みレースは、当時固定されていた予想・予想買い目・ルールから`legacy_local_upgrade`証跡をバックアップ内に再構成してから、プレビュー付き専用移行を使用します。

### セキュリティ

- 共有マスター以外の全ユーザーデータ行に `user_id` を保持
- 全テーブルでRLSを有効化し、`user_id = (select auth.uid())` の本人だけを許可
- 集約配下の直接書き込みを禁止し、競合検査・冪等receipt付きRPCだけを許可
- 公開RPCは認証を必須とし、内部helperの実行権限は`public`/`authenticated`から剥奪
- 全集計ビューは `security_invoker = true`
- 予想変更履歴は利用者が更新・削除できない
- ロック証跡は別テーブルの不変スナップショットとして更新・削除を拒否。ロック後の通常予想は別の現在値として同期され、証跡を変更しない
- canonicalロック証跡にはロック時点の`data_scope`を固定し、scopeを含むJSON全体をSHA-256で検証。後からレース区分を変更しても証跡側は変えない
- オフライン明示ロックは発走前に再接続した場合も、旧版再構成ロックと同様にサーバー時刻の証明と混同しないsource付き別テーブルへ保存
- 予想案と実購入は `bet_slips.kind` で分離
- 暫定結果は公式結果へ自動昇格せず、「結果を確定」した場合だけ累計収支へ反映
- `races.data_scope = 'live'` のレースだけを収支ビューへ含め、デモ／テストの払戻を実績から除外
- ルール版と親ルールセットの`sync_version`を別々に比較し、どちらかの不一致も書き込まず端末版とクラウド版を比較画面へ送る
- 成功・競合のどちらもmutation receiptへ保存し、同じmutation IDの再送で二重反映や結果のすり替わりを防止
- mutation IDと安定client keyで再送・二重クリック・途中再開による重複を防止

## `---RACE---` 形式

UTF-8の行指向 `RACE/1` 形式です。複数レースを1ファイルへ連結できます。

```text
---RACE---
FORMAT_VERSION: 1
ID: "race-example"
DATA_SCOPE: "test"
DATE: "2026-07-19"
COURSE: "函館"
RACE_NUMBER: 11
START_TIME: "15:25"
...
---END RACE---
```

自由記述や入れ子データは、改行・区切り文字で壊れないようJSON値として表現します。未知の版、必須項目欠落、不正な券種や金額は保存前に拒否します。完全な仕様は `lib/race-format.ts` の `RACE_FORMAT_SPECIFICATION` にあります。

クラウド移行前の完全バックアップには `UMA_NOTE_BACKUP/1` を使用します。内部にRACE/1本文を保持し、レースに未適用のルール、使用中ルール、ユーザー設定も一緒に保存します。所有者ID、クラウドUUID、認証トークン、Outbox内部情報は書き出しません。

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
- LOCALモード、旧localStorage移行、IndexedDBとOutboxの原子的保存
- オフライン再送、mutation冪等性、二端末version競合、3-way比較
- 全ユーザーテーブルのuser_id/RLS、別ユーザー拒否、秘密情報の非公開
- バックアップ、移行プレビュー、自然キー重複、再開receipt
- DB正規形のロックスナップショットをクライアント形式へ戻す往復変換
- `v0.1.1-local-clean`の旧ロックをsource付き完全snapshotへ昇格する互換テスト
- ルール／設定だけの移行確認、Realtime再取得、競合解決と再送予約の原子的保存

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

`vinext deploy` は本番ビルドとWorkersへのデプロイをまとめて実行します。Supabaseを使う公開版では、実行前に `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`、`NEXT_PUBLIC_SITE_URL` をビルド環境へ設定してください。

PWAのService Workerは本番ビルドでだけ登録します。初回オンライン表示後はアプリシェルとビルド済み資産をキャッシュし、端末に保存した入力をオフラインでも開けます。通信断中の変更はOutboxに残り、再接続後のアプリ表示中に自動同期します。認証トークンをService Workerへ渡すバックグラウンド同期は行いません。

## ディレクトリ

```text
app/                       画面、PWA manifest、Service Worker登録
lib/                       型、計算、RACE形式、端末DB、同期エンジン、Supabaseアダプタ
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
