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
├── db/
│   ├── schema.sql          # テーブル定義（MySQL移行を見据えた標準SQL）
│   └── init.js             # スキーマ作成＋ダミーデータ投入スクリプト
├── lib/
│   ├── db.js                # better-sqlite3接続
│   └── reservationEngine.js # ★GAS版予約エンジンの移植本体
└── public/
    ├── index.html           # 簡易フロントエンド（1ページ）
    └── app.js               # フロント側のfetch API呼び出し
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

## 5. 本番（VPS＋MySQL）移行時に注意すべき点

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
