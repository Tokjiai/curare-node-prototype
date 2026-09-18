# サロン予約管理システム Node.jsプロトタイプ

## これは何か

現在GAS（Google Apps Script）＋Googleスプレッドシート＋LINEで動いている
サロン予約管理システムのうち、**予約エンジンのコア判定ロジック**（空き状況判定：
TEL / ー / 店休 / 満 / 残1 / 空き）を、**Node.js（Express）＋ SQLite** で
忠実に移植し、実際に動くことを確認したプロトタイプです。

> **⚠️ これは本番運用システムではありません。**
> 実際の店舗運営（LINE連携・顧客管理・スタッフダッシュボード等）は今回の対象外です。
> 本番は別途、**レンタルサーバー（VPS）＋ Node.js ＋ MySQL** で構築する計画です。
> このプロトタイプの目的は「予約エンジンのコアロジックが、GASを離れてNode.js側でも
> 正しく動くこと」を証明する点にあります。

---

## 1. GAS版との対応関係

| GAS版（ファイル / 関数） | Node版（ファイル） | 内容 |
|---|---|---|
| `reservation_form_functions.js` の `getZoneStatus_` | `lib/reservationEngine.js` の `getZoneStatus_` | ★予約エンジンの心臓部。ロジックは一切変更せず、データ取得部分だけをSQLiteクエリに置換 |
| 同ファイルの `toMin_` `getBlockedEventSlots_` `getShiftSlots15Min_` `getCustomerStaffList_` `getNightBookedStartTimes_` `generateFixedSlots_` `getFullyBookedSlots_` `getBookedSlots90Min_` `getAvailableStaffCountAtTime_` `generateBlockedSlots_` `generateBlockedSlotsBefore_` `expandRangeToSlots_` `isSameDate_` `getZonesConfig_` `getDefaultZones_` `getTimeSlotsByZone` `checkCustomerReservationLimit` | `lib/reservationEngine.js` の同名関数 | すべて忠実に移植（関数名も踏襲） |
| `コード.js` の `getRuleValue_` | `lib/reservationEngine.js` の `getRuleValue_` | rule1シート → `rules` テーブルに変更 |
| `reservation_form_functions.js` の `addReservationUnified_body_`（一部） | `server.js` の `POST /api/reservations` | 予約上限チェック＋登録のロジックのみ移植。LINE通知・カレンダー同期は対象外 |
| 「マスタ」シート | `staff` テーブル | スタッフ情報 |
| 「シフトマスタ」シート | `shift_master` テーブル | 出退勤シフト |
| 「予約データ」シート | `reservations` テーブル | 予約本体（列の並びは `COL_Y_*` 定数の順序を踏襲） |
| 「events」シート | `events` テーブル | 臨時休業・イベントによる枠ブロック |
| 「rule1」シート | `rules` テーブル | BOOKING_LIMIT_DAYS / BED_LIMIT / MAX_RESERVATIONS_PER_CUSTOMER 等の設定値 |
| 「zones」シート（未設定時はコード内デフォルト） | `zones` テーブル | 午前／午後／夜の3ゾーン設定 |
| `customer_form.html` の配色・レイアウト | `public/index.html` | ピンク系の配色・カード型UIを踏襲した簡易フロント |

### 今回あえて対象外にしたもの
- LINE通知（予約確定メッセージ送信、リマインダー等）
- Googleカレンダー連携（`COL_Y_SYNC` の同期処理）
- 顧客マスタとの統合（顧客ID・LINE友だち情報の紐付け）
- スタッフ向けダッシュボード・オーナー向け管理画面
- キャンセル待ち・仮予約フローの詳細

これらは「予約エンジンのコアロジック実証」というプロトタイプの目的から外れるため割愛しています。

---

## 2. ディレクトリ構成

```
node-prototype/
├── package.json          # 依存関係・起動スクリプト
├── server.js              # Expressサーバー本体（APIエンドポイント）
├── render.yaml             # Render Blueprint設定（無料Webサービス）
├── import_csv.js           # GASスプレッドシートCSVエクスポートの取込スクリプト（顧客マスタ・予約データ）
├── db/
│   ├── schema.sql          # テーブル定義（MySQL移行を見据えた標準SQL）
│   └── init.js             # スキーマ作成＋ダミーデータ投入スクリプト
├── lib/
│   ├── db.js                # better-sqlite3接続
│   ├── auth.js               # PINハッシュ化・検証ロジック（server.js / db/init.js 共有）
│   └── reservationEngine.js # ★GAS版予約エンジンの移植本体
└── public/
    ├── index.html           # 簡易フロントエンド（1ページ）
    ├── app.js               # フロント側のfetch API呼び出し
    └── admin/                # オーナー用管理画面（ログイン・ダッシュボード・顧客マスタ・予約データ閲覧）
        ├── login.html
        ├── index.html
        ├── customers.html
        └── reservations.html
```

---

## 3. ローカルでの動かし方

```bash
cd node-prototype
npm install
npm start
# → 🚀 予約管理プロトタイプ サーバー起動: http://localhost:3000
```

ブラウザで `http://localhost:3000` を開くと、
担当スタッフ・日付・時間帯・時刻を選んで予約できる簡易画面が表示されます。

サーバー起動時に毎回、`db/init.js` がSQLiteのテーブルを作り直し、
「クラーレ寿」を模したダミーデータ（店舗1つ・スタッフ3名・14日分のシフト・
既存予約数件・臨時休業日1件）を自動投入します。シードだけ再投入したい場合は
`npm run seed` でも実行できます。

### 動作確認済みのAPI（実際に `curl` で確認した結果）

このプロトタイプは実際にサーバーを起動し、以下のAPIをcurlで叩いて
GAS版と同じ判定結果が返ることを確認済みです（実行日：2026-09-17）。

```bash
# 当日（diffDays<=0）→ 「ー」
curl "http://localhost:3000/api/availability?store=1&date=2026-09-17&staffId=nopref"
# → 全ゾーン "ー"

# 2日後（diffDays<=2）→ 「TEL」
curl "http://localhost:3000/api/availability?store=1&date=2026-09-19&staffId=nopref"
# → 全ゾーン "TEL"

# 4日後・花子指名（既存予約2件で午前満枠）→ 「満」「空き」
curl "http://localhost:3000/api/availability?store=1&date=2026-09-21&staffId=はなちゃん"
# → am:"満" pm:"空き" ev:"満"

# 5日後・夜間固定枠（寿子19:30に予約あり、21:00のみ空き）→ 「残1」
curl "http://localhost:3000/api/availability?store=1&date=2026-09-22&staffId=nopref"
# → am:"残1" pm:"空き" ev:"残1"

# 7日後・臨時休業日 → 「店休」
curl "http://localhost:3000/api/availability?store=1&date=2026-09-24&staffId=nopref"
# → 全ゾーン "店休"

# 予約上限（MAX_RESERVATIONS_PER_CUSTOMER=3）超過確認
# 同一顧客で3件登録後、4件目を送るとisLimitWarning:trueが返ることを確認
```

いずれも期待どおりの判定結果が返ることを確認しています。
（TEL/ー/店休/満/残1/空きの6パターンすべて再現できています）

---

## 4. Renderへのデプロイ手順（ユーザーご自身で行う部分）

このエージェントの実行環境からは実際のGitHub連携・Renderへのデプロイ操作は
行えないため、**準備まで**を整えてあります。以下の手順をコピペで進めてください。

### 手順1：GitHubリポジトリを作る

```bash
cd node-prototype
git init
git add .
git commit -m "予約エンジン Node.jsプロトタイプ 初回コミット"
```

GitHub上で新規リポジトリ（例：`salon-booking-prototype`）を作成し、
表示される案内に従ってpushしてください。

```bash
git remote add origin https://github.com/<あなたのユーザー名>/salon-booking-prototype.git
git branch -M main
git push -u origin main
```

### 手順2：Renderでサービスを作る

1. https://dashboard.render.com/ にログイン（GitHubアカウントでログイン可能）
2. 画面右上の **New +** → **Blueprint** を選択
3. 先ほどpushしたリポジトリを選択
4. リポジトリ内の `render.yaml` が自動検出され、
   「salon-booking-prototype」という名前のWebサービス（Freeプラン）が
   作成されることを確認
5. **Apply** をクリックしてデプロイを開始

### 手順3：デプロイ完了後の確認

- ビルドログで `npm install` → `npm start` が成功していることを確認
- 発行されたURL（例：`https://salon-booking-prototype.onrender.com`）に
  アクセスし、予約画面が表示されればOK

### 補足：無料プランの制約について

- Render無料プランのディスクは**エフェメラル**（再デプロイ・再起動のたびに消える）ため、
  本アプリはサーバー起動時に毎回SQLiteを初期化＋シードデータを再投入する設計にしてあります。
  → デプロイ後にAPIで登録したデータも、次回の再起動（無料プランは一定時間アクセスがないと
  スリープし、次のアクセスで再起動されます）で消える点はご承知おきください。
  プロトタイプとしての動作確認が目的なので、この割り切りで問題ありません。
- 無料プランはアクセスが一定時間ないとスリープするため、初回アクセス時は
  起動に数十秒かかることがあります。

---

## 5. 顧客マスタ・CSV取込・オーナー管理画面（追加機能）

このプロトタイプにはその後、以下の3つを追加しています。

### 5-1. 顧客マスタ（customers テーブル）

GASの「顧客マスタ」シートに相当するテーブルを `db/schema.sql` に追加しました。
`store_id` でスコープされ、`(store_id, customer_id)` に一意制約とインデックス、
`(store_id, realname)` にもインデックスを張っています。

主なカラム：`customer_id`（シート発行の顧客ID）, `realname`, `kana`, `phone`,
`line_name`, `user_id`（LINE userId）, `birthday`, `first_visit_date`,
`last_visit_date`, `total_visits`, `memo`。

`npm run seed`（＝`node db/init.js`）実行時にダミー顧客5名が自動投入されます。

### 5-2. CSV取込スクリプト（import_csv.js）

GASスプレッドシートをCSVエクスポートしたものを定期的に取り込むためのスクリプトです。
**GASが引き続き本番として稼働している間、並行運用でこのスクリプトを定期実行する**
ことを想定しています。実行するたびに同じ行は上書き更新されるだけなので、
**何度実行しても重複登録されません（冪等）**。

```bash
# 顧客マスタの取込
node import_csv.js customers ./顧客マスタ.csv --store=1

# 予約データの取込
node import_csv.js reservations ./予約データ.csv --store=1
```

- `--store=<slugまたはstore_id>` は省略可（省略時は store_id=1）。
- 顧客マスタは `store_id + customer_id` の一致で upsert。
- 予約データは `store_id + 担当 + 予約日 + 予約時刻` の一致で upsert
  （キャンセル済み予約は一意制約の対象外のため上書きされません）。
- 実行結果として「読み込み行数／新規登録／更新／スキップ（理由付き）」を表示します。

**列マッピングについて（★重要）**：実際のスプレッドシート側の列見出しや列順が
将来少し変わっても、直す場所を1箇所に集約するため、`import_csv.js` 冒頭の
`CUSTOMER_COLUMN_MAP` / `RESERVATION_COLUMN_MAP` というオブジェクトだけが
「CSVの列見出し（日本語）→ DBカラム名」の対応関係を持っています。
シート側の見出し表記が変わった場合は、この2つのオブジェクトのキー（左辺）を
直すだけで済み、パース処理・upsert処理のコードには手を入れる必要がありません。

顧客マスタCSVのヘッダー行の例（`CUSTOMER_COLUMN_MAP` のキーと一致させる）：

```
顧客ID,氏名,フリガナ,電話番号,LINE名,LINE userId,生年月日,初回来店日,最終来店日,来店回数,メモ
C0001,山田 花子,ヤマダ ハナコ,090-1234-5678,はなちゃん,U1234567890,1992-05-10,2025-01-10,2026-09-01,8,常連
```

予約データCSVのヘッダー行の例（`RESERVATION_COLUMN_MAP` のキーと一致させる）：

```
氏名,フリガナ,LINE名,LINE userId,担当,メニュー,予約日,予約時刻,備考,登録者,顧客ID,ステータス
山田 花子,ヤマダ ハナコ,はなちゃん,U1234567890,花子,フェイシャル(60分),2026-09-30,10:00,,寿子,C0001,確定
```

CSVパーサーは外部ライブラリを使わず自前実装（RFC4180相当のダブルクォート
エスケープに対応、UTF-8日本語もそのまま扱えます）なので、**依存パッケージの
追加はありません**。

### 5-3. オーナー用管理画面（/admin/*）

3つのAPIエンドポイントと、3つの管理画面ページを追加しました。

**APIエンドポイント（すべてログインセッション＋オーナー権限が必要）**

| メソッド・パス | 内容 |
|---|---|
| `GET /api/admin/customers?q=&limit=&offset=` | 顧客マスタの検索（氏名／フリガナ／電話番号の部分一致）、ページング対応 |
| `GET /api/admin/reservations?from=&to=&staffName=&q=&limit=&offset=` | 予約データの検索（日付範囲・担当・氏名部分一致）、新しい日付順、ページング対応 |
| `GET /api/admin/dashboard` | 本日/今週の予約件数、直近7日間の日別件数、総顧客数、累計予約件数（キャンセル除く） |

いずれも店舗は**ログイン中のセッションの店舗に固定**され、`?store=` を渡しても
無視されます（複数店舗展開時に他店のデータを覗けてしまう事故を防ぐため）。

**管理画面ページ（`public/admin/` 配下、単一HTMLファイルでCSS/JSともにインライン）**

| ページ | 内容 |
|---|---|
| `public/admin/login.html` | ログイン画面（店舗＋4桁PIN） |
| `public/admin/index.html` | ダッシュボード（本日/今週の件数、直近7日間の予約数リスト） |
| `public/admin/customers.html` | 顧客マスタ閲覧（検索ボックス＋一覧テーブル） |
| `public/admin/reservations.html` | 予約データ閲覧（日付範囲・担当フィルタ＋一覧テーブル） |

各ページはロード時に `GET /api/auth/me` を呼び、401ならログイン画面へリダイレクトします。
ナビゲーションに「ログアウト」リンクがあり、クリックで `POST /api/auth/logout` を呼んでからログイン画面へ戻ります。

---

## 6. ログイン機構（PINベース・セッション認証）

以前の「共有パスワード＋`X-Admin-Password`ヘッダー」方式は廃止し、
**GAS版の実運用と同じ「スタッフの電話番号下4桁PIN」によるログイン**に置き換えました。

### 6-1. ログインフロー

1. `public/admin/login.html` で店舗（slugまたはID）と4桁PINを入力
2. `POST /api/auth/login`（body: `{ store, pin }`）にリクエスト
   - サーバーは対象店舗の `staff` テーブルから候補を取得し、各候補の `pin_salt` で
     入力PINをハッシュ化して `pin_hash` と定数時間比較（`crypto.timingSafeEqual`）
   - 一致かつ `is_owner=1` のスタッフのみログイン成功
   - 一致したが `is_owner=0`（一般スタッフ）の場合は
     `{success:false, message:'現在はオーナー権限のみログインできます（プロトタイプ版）'}`
     を返す（＝将来一般スタッフ向け機能を実装する際にここを外すだけで済むように、
     「扉は開けたまま」明示的にブロックしている）
   - 一致しない場合は汎用的な `401 {success:false, message:'PINが正しくありません'}`
     （店舗が違うのかPINが違うのか等、攻撃の手がかりになる情報は返さない）
3. 成功時は `req.session.staff = {id, storeId, name, isOwner}` をセッションに保存し、
   `Set-Cookie` でセッションCookie（`httpOnly`）を返す
4. 以降、管理画面の各ページ・APIはこのセッションCookieで認証される
   （`credentials`指定は不要。ブラウザのfetchはデフォルトで同一オリジンCookieを送信する）

### 6-2. 開発用オーナーPINの確認方法

サーバー起動時（`node db/init.js` 実行時含む）のコンソールログに、
以下のような行が出力されます。これでログインできます。

```
🔑 [開発用] オーナーPIN: 5678 (store=1, staff=寿子) ※本番ではこの行は出力しないこと
```

現在のシード値は、寿子（オーナー）の電話番号下4桁 `5678`（store=1）です。
花子・美咲は一般スタッフとしてPIN付きで登録されていますが、
現段階では `is_owner=0` のためログインは拒否されます（403相当のメッセージ）。

### 6-3. `stores.plan` 列について（プレースホルダー）

`stores` テーブルに `plan VARCHAR(20) NOT NULL DEFAULT 'trial'` を追加しました。
将来の料金プラン（ワンコイン＝`onecoin` / ベース＝`base` / LINE連携＝`line`）に
対応するための置き場所で、**現時点ではどの機能もこの値を見て制御していません**。
将来「このプランならこの機能を使える／使えない」という判定を追加する際の
土台として、スキーマだけ先に用意してあります。

### 6-4. 本番化する際の注意（★重要）

このログイン機構は「実運用に耐えるコア設計」を意識して作っていますが、
以下は明示的にプロトタイプの範囲内であり、本番投入前に必ず対応してください。

- **セッションストアの差し替え**：現在は `express-session` のデフォルト
  `MemoryStore`（プロセス内メモリ）を使用しています。単一インスタンスの
  プロトタイプでは動作しますが、本番はプロセス再起動でセッションが消える／
  複数インスタンス間でセッションを共有できないため、`connect-mysql2` 等の
  永続化されたセッションストアに置き換える必要があります。
- **`SESSION_SECRET` の環境変数設定必須**：未設定時は開発用の固定値
  （`dev-only-insecure-session-secret`）を使い、起動時に警告を出力します。
  本番では必ず十分にランダムな値を環境変数で設定してください。
- **ログイン試行のレート制限**：4桁PINは総当たりが容易な情報量（1万通り）
  のため、現状は試行回数の制限を一切行っていません。本番では
  IPアドレス単位・店舗単位でのレート制限、一定回数失敗した場合の
  ロックアウト等を追加してください。
- **HTTPS必須化**：現在のCookie設定は `httpOnly: true` のみで
  `secure: true` を付けていません（ローカル開発でHTTPのまま動作確認するため）。
  本番はHTTPS環境になるため、`secure: true` を有効にし、Cookieが平文HTTP経由で
  漏れないようにしてください。
- 上記に加え、[6-2](#6-2-開発用オーナーpinの確認方法)のコンソールPIN出力は
  開発用の利便性のためのものです。本番ビルドではこの出力を無効化するか、
  ログ収集基盤に残らないようにする配慮が必要です。

---

## 7. 本番（VPS＋MySQL）移行時に注意すべき点

- **DB接続層の差し替え**：`lib/db.js` を `mysql2` 等に置き換え、
  `lib/reservationEngine.js` 内の `db.prepare(...).get()/.all()` の呼び出し方を
  MySQLクライアントのAPIに合わせて調整してください（SQL文自体は
  `schema.sql` を標準的な記法にしてあるので大きな変更は不要な想定です）。
- **AUTO_INCREMENT構文の違い**：SQLiteの `INTEGER PRIMARY KEY AUTOINCREMENT` は
  MySQLでは `INT PRIMARY KEY AUTO_INCREMENT` に読み替えてください（`schema.sql` に
  コメントで明記しています）。
- **日付・時刻の型**：今回は移植の忠実性を優先し、GAS版同様に文字列
  （`'YYYY-MM-DD'` / `'HH:MM'`）で保持・比較しています。本番でMySQLの
  `DATE`/`TIME`型・タイムゾーンを正しく使う設計に見直すことを推奨します。
- **同時実行制御**：GAS版は `withStoreLock_`（スプレッドシートロック）で
  予約登録の排他制御をしていました。本番のMySQLではトランザクション＋
  行ロック（`SELECT ... FOR UPDATE`）等での排他制御の実装が必要です。
- **未移植の機能**：LINE通知・カレンダー同期・顧客マスタ統合・各種
  ダッシュボードは、本番構築時にあらためて設計・実装が必要です。
