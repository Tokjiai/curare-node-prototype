-- ============================================================================
-- schema.sql
-- サロン予約管理システム プロトタイプ用 DBスキーマ
--
-- 元になっている情報源：GASスプレッドシートの各シート
--   - マスタ         → staff テーブル
--   - シフトマスタ   → shift_master テーブル
--   - 予約データ     → reservations テーブル
--   - events         → events テーブル（店休日・イベント休業枠）
--   - rule1          → rules テーブル（BOOKING_LIMIT_DAYS 等の設定値）
--   - zones（省略時はコード内デフォルト値）→ zones テーブル
--
-- 【重要】これはSQLite（better-sqlite3）で動かす前提のDDLですが、
-- 将来 MySQL（本番VPS）へ移行しやすいように、方言依存の記法は避け、
-- 標準的なSQL型・制約の範囲に収めています。
--   - AUTO_INCREMENT の代わりに SQLite の INTEGER PRIMARY KEY AUTOINCREMENT を使用
--     → MySQL移行時は `INT PRIMARY KEY AUTO_INCREMENT` に読み替えてください。
--   - BOOLEAN は SQLite では内部的に 0/1 の INTEGER として扱われます。
--     → MySQLでも TINYINT(1) として問題なく動作します。
--   - 日付・時刻は文字列（'YYYY-MM-DD' / 'HH:MM'）で保持しています。
--     GAS版が「文字列としての日付比較」をしていたロジックをそのまま移植するためです。
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- stores：店舗マスタ（将来的な複数店舗展開を見据えて用意。プロトタイプでは1店舗のみ使用）
-- ----------------------------------------------------------------------------
-- ★2026-09-18追加：plan列（課金プランのプレースホルダー）
--   将来の料金プラン（ワンコイン/ベース/LINE連携）に合わせて 'onecoin' / 'base' / 'line'
--   のスラッグを想定。現時点ではどの機能もこの値でゲート（制限）されておらず、
--   単なる保存領域。将来「このプランでは機能Xを使えない」といった判定を
--   実装する際の土台として、今のうちにカラムだけ用意しておく。
-- ★2026-09-18追加：LINE連携用の店舗ごとのチャネル資格情報（プレースホルダー）
--   line_customer_channel_token / line_staff_channel_secret は「環境変数」ではなく
--   あえてDBのこのテーブルの列として持たせている。将来、複数のサロンがそれぞれ
--   自分のLINE公式アカウント（お客様向け／スタッフ向け）を持つマルチテナント運用に
--   なったとき、店舗ごとに異なるトークン・シークレットをリクエスト時に読み出せる
--   必要があるためで、単一プロセスの環境変数では店舗をまたいで使い分けられない。
--   一方、server.js が使う LINE_CHANNEL_SECRET 環境変数は、このプロトタイプ自体の
--   Webhookエンドポイント（/webhook/line）自体の署名検証用であり、この2つは役割が違う
--   （どちらも現段階ではnullable・デフォルト値なしのプレースホルダーで、
--    設定用の管理画面UIはまだ無いため、値を入れる場合はSQL/インポートで直接投入する）。
CREATE TABLE IF NOT EXISTS stores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          VARCHAR(50)  NOT NULL UNIQUE,   -- URLやAPIパラメータで使う店舗識別子（例：'kurare-kotobuki'）
  name          VARCHAR(100) NOT NULL,          -- 店舗名（表示用）
  plan          VARCHAR(20) NOT NULL DEFAULT 'trial', -- 'trial' / 'onecoin' / 'base' / 'line'（プレースホルダー、未使用）
  line_customer_channel_token  VARCHAR(255),    -- お客様向けLINE公式アカウントのチャネルアクセストークン（未設定＝プッシュ通知はシミュレーションのみ）
  line_staff_channel_secret    VARCHAR(255),    -- スタッフ／オーナー向けLINE公式アカウントのチャネルシークレット（Webhook署名検証・店舗判別に使用）
  line_staff_channel_token     VARCHAR(255),    -- ★2026-09-23追加：スタッフ／オーナー向けLINE公式アカウントのチャネルアクセストークン
                                                 --   （プッシュ送信用。line_staff_channel_secretはWebhook署名検証専用で送信はできないため別カラムが必要。
                                                 --   未設定＝朝/夕方レポート等スタッフ向けプッシュ通知はシミュレーションのみ）
  phone                        VARCHAR(20),     -- ★2026-09-20追加：店舗の電話番号（お客様予約フォームに表示。rule2「基本情報」カード相当、この画面からは編集不可）
  booking_period_info_days     INTEGER NOT NULL DEFAULT 14, -- ★2026-09-20追加：予約受付期間の「お知らせ用」表示日数（rule1のBOOKING_LIMIT_DAYSとは別枠の、お客様への案内表示専用の値）
  is_active                    BOOLEAN NOT NULL DEFAULT 1, -- ★2026-09-25追加：稼働状況（複数店舗プラットフォーム管理画面の一覧表示用。0でも既存データ・ログインは動き続ける、単なる目印）
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- staff：スタッフマスタ（GASの「マスタ」シートに相当）
--   GAS版 getCustomerStaffList_ が読んでいた列：
--     row[0]=name, row[1]=role, row[3]=nickname, row[5]=optSupport,
--     row[8]=予約表示フラグ, row[9]=nightRestrict, row[14]=active
-- ----------------------------------------------------------------------------
-- ★2026-09-18追加：ログイン機構（pin_hash / pin_salt / is_owner）
--   実際のGAS版運用では「スタッフの電話番号下4桁」をPINとしてログインに使っている。
--   PINは絶対に平文で保存しない：行ごとのランダムsalt（pin_salt）を使い、
--   Node標準cryptoのscryptでハッシュ化した値のみをpin_hashに保存する
--   （ハッシュ計算ロジックは lib/auth.js に集約。server.js / db/init.js 両方から利用）。
--   is_ownerは「オーナー権限か、一般スタッフか」を区別するフラグ。
--   このプロトタイプ段階では、オーナー（is_owner=1）のみが管理画面
--   （/api/admin/*）にログインできる。一般スタッフのログイン自体は将来の
--   拡張（スタッフ別の予約操作画面など）のための土台として先に用意してある。
CREATE TABLE IF NOT EXISTS staff (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id         INTEGER NOT NULL REFERENCES stores(id),
  name             VARCHAR(50) NOT NULL,        -- 本名（予約データ上の担当者名と一致させる）
  nickname         VARCHAR(50),                 -- 表示用ニックネーム（お客様画面に出す名前）
  role             VARCHAR(20) NOT NULL DEFAULT 'スタッフ', -- 'オーナー' / 'スタッフ' / '見習い' など
  opt_support      BOOLEAN NOT NULL DEFAULT 0,   -- オプションメニュー対応可否
  night_restrict   BOOLEAN NOT NULL DEFAULT 0,   -- 夜間ゾーンで固定枠（90分間隔）対象のスタッフか
  show_in_booking  BOOLEAN NOT NULL DEFAULT 1,   -- 予約対象スタッフとして表示するか（GAS row[8]相当）
  is_active        BOOLEAN NOT NULL DEFAULT 1,   -- 在籍中フラグ（GAS row[14]相当）
  pin_hash         VARCHAR(255),                 -- ログイン用PIN（電話番号下4桁想定）のscryptハッシュ値（hex）
  pin_salt         VARCHAR(64),                  -- pin_hash計算時に使ったランダムsalt（行ごとに異なる）
  is_owner         BOOLEAN NOT NULL DEFAULT 0,    -- オーナー権限か（1=オーナー、現状は管理画面はオーナーのみアクセス可）
  line_user_id     VARCHAR(64),                  -- ★2026-09-18追加：スタッフ本人のLINE userId。
                                                   --   GAS版運用の踏襲：スタッフ向けLINE公式アカウントに
                                                   --   自分の4桁PINをテキストで送ると、routes/lineWebhook.js が
                                                   --   staffマスタと照合し、未設定ならここに自動登録する。
                                                   --   既に値がある場合は上書きしない（なりすまし登録防止）。
  color            VARCHAR(20),                  -- ★2026-09-23追加：カレンダー表示色（GAS版マスタC列相当。
                                                   --   'BLUE'/'RED'等の色キー。オーナーがスタッフ管理画面で選ぶ）
  is_shared_terminal BOOLEAN NOT NULL DEFAULT 0,  -- ★2026-09-24追加：「サロン端末」共有ログイン用アカウントか
                                                   --   （GAS版の全店共通staffId 'ST099' 相当）。1の行は is_owner=1 として
                                                   --   カレンダー上の予約編集はオーナーと同じ全権限を持つが、
                                                   --   オーナー設定・スタッフ管理・顧客/予約の編集画面には入れない。
                                                   --   予約対象スタッフ・シフト表・凡例・LINE通知の対象からは除外する。
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- shift_master：スタッフの出勤シフト（GASの「シフトマスタ」シートに相当）
--   GAS版 getShiftSlots15Min_ / buildWeekStaffCache_ が読む列：
--     row[0]=staffName, row[1]=date, row[2]=startTime, row[3]=endTime, row[8]=active
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shift_master (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  staff_name    VARCHAR(50) NOT NULL,   -- staff.name と一致（本名）
  shift_date    DATE NOT NULL,          -- 'YYYY-MM-DD'
  start_time    VARCHAR(5) NOT NULL,    -- 'HH:MM'（出勤開始）
  end_time      VARCHAR(5) NOT NULL,    -- 'HH:MM'（出勤終了）
  is_active     BOOLEAN NOT NULL DEFAULT 1,  -- この行を有効なシフトとして扱うか
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- shift_templates：シフトの曜日パターン（GASの「シフト初期値」シートに相当）
--   2026-09-22追加：GAS版expandShiftByRule_の移植に伴い新規追加。ここに登録した
--   「スタッフ×曜日×時刻」の週次パターンをもとに、日次メンテナンスが
--   SHIFT_EXPAND_DAYS日先の1日分をshift_masterへ自動展開する。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shift_templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  staff_name    VARCHAR(50) NOT NULL,      -- staff.name と一致（本名）
  day_of_week   INTEGER NOT NULL,          -- 0=日,1=月,2=火,3=水,4=木,5=金,6=土（JSのDate.getDay()に合わせる）
  start_time    VARCHAR(5) NOT NULL,       -- 'HH:MM'
  end_time      VARCHAR(5) NOT NULL,       -- 'HH:MM'
  is_active     BOOLEAN NOT NULL DEFAULT 1,-- OFFにすると展開対象から外れる（行は残したまま一時停止できる）
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- reservations：予約データ（GASの「予約データ」シートに相当）
--   列の対応関係は GAS版 コード.js の COL_Y_* 定数を踏襲：
--     COL_Y_REALNAME=1, COL_Y_KANA=2, COL_Y_LINENAME=3, COL_Y_USERID=4,
--     COL_Y_STAFF=5, COL_Y_MENU=6, COL_Y_DATE=7, COL_Y_TIME=8, COL_Y_NOTE=9,
--     COL_Y_EDITOR=10, COL_Y_SENT=11, COL_Y_DONE=12, COL_Y_STATUS=25
--   「キャンセル」は realname 列に文字列 'キャンセル' を入れる運用をそのまま踏襲。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  realname      VARCHAR(50) NOT NULL,   -- お客様氏名（'キャンセル'が入るとキャンセル扱い＝GAS踏襲の特殊値）
  kana          VARCHAR(50),
  line_name     VARCHAR(50),
  user_id       VARCHAR(100),           -- LINE userId（プロトタイプでは未使用でも良い）
  staff_name    VARCHAR(50) NOT NULL,   -- 担当スタッフの本名（'未定'も可）
  menu          VARCHAR(100),
  reservation_date  DATE NOT NULL,      -- 'YYYY-MM-DD'
  reservation_time  VARCHAR(5) NOT NULL,-- 'HH:MM'（施術開始時刻）
  note          TEXT,
  editor        VARCHAR(50),            -- 登録・編集したスタッフ名
  line_sent     BOOLEAN NOT NULL DEFAULT 0,
  reminder_sent BOOLEAN NOT NULL DEFAULT 0,  -- ★2026-09-23追加：前日リマインダー送付済みフラグ（GAS版COL_Y_REMINDER相当）
  done          BOOLEAN NOT NULL DEFAULT 0,
  customer_id   VARCHAR(50),            -- 顧客ID（参考列。GAS版 COL_Y_CID 相当）
  status        VARCHAR(20) NOT NULL DEFAULT '確定',  -- '確定' / '仮予約' など
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- events：店休日・イベント（臨時休業や研修などで枠をブロックする設定。GASの「events」シート相当）
--   GAS版 getBlockedEventSlots_ が読む列：
--     row[1]=date, row[3]=active, row[4]=startTime, row[5]=endTime,
--     row[7]=restrict, row[8]=blockStart(任意), row[9]=blockEnd(任意)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  title         VARCHAR(100),
  event_date    DATE NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT 1,
  start_time    VARCHAR(5) NOT NULL,   -- イベント自体の開始時刻
  end_time      VARCHAR(5) NOT NULL,   -- イベント自体の終了時刻
  restrict_booking  BOOLEAN NOT NULL DEFAULT 0, -- TRUEなら予約枠をブロックする対象イベント
  block_start_time  VARCHAR(5),        -- 明示的なブロック開始（未指定なら start_time-90分）
  block_end_time    VARCHAR(5),        -- 明示的なブロック終了（未指定なら end_time+60分）
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- rules：ルール設定値（GASの「rule1」シート相当）
--   GAS版 getRuleValue_ は A列=ruleId, C列=value の構造で読んでいたため、
--   同じ3カラム構造（rule_id, memo, value）をそのまま踏襲する。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  rule_id       VARCHAR(50) NOT NULL,   -- 例：'BOOKING_LIMIT_DAYS', 'BED_LIMIT', 'MAX_RESERVATIONS_PER_CUSTOMER'
  memo          VARCHAR(200),           -- 備考（B列相当、未使用でも可）
  value         VARCHAR(50) NOT NULL,   -- 実際の設定値（数値も文字列として保持し、利用側でNumber変換）
  UNIQUE(store_id, rule_id)
);

-- ----------------------------------------------------------------------------
-- zones：時間帯ゾーン設定（GASの「zones」シート相当。未設定時はコード内デフォルトを使用）
--   午前(am) / 午後(pm) / 夜(ev) の3ゾーンが標準。夜ゾーンのみ fixed_target=1 で
--   90分間隔の固定枠（19:30, 21:00...）判定が入る。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zones (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id          INTEGER NOT NULL REFERENCES stores(id),
  zone_key          VARCHAR(20) NOT NULL,   -- 'am' / 'pm' / 'ev'
  label             VARCHAR(20) NOT NULL,   -- '午前' / '午後' / '夜'
  start_time        VARCHAR(5) NOT NULL,
  end_time          VARCHAR(5) NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT 1,
  fixed_target      BOOLEAN NOT NULL DEFAULT 0,  -- TRUEなら夜間固定枠ロジック対象ゾーン
  fixed_start        VARCHAR(5),                 -- 固定枠の最初の開始時刻（例：'19:30'）
  fixed_interval_min INTEGER DEFAULT 0,           -- 固定枠の間隔（分）（例：90）
  UNIQUE(store_id, zone_key)
);

-- ----------------------------------------------------------------------------
-- customers：顧客マスタ（GASの「顧客マスタ」シート相当）
--   列の実際のマッピングは import_csv.js の COLUMN MAPPING に集約してある。
--   （実運用のスプレッドシート側の列順・表記ゆれが変わっても、ここではなく
--    import_csv.js 側のマッピング定義だけを直せばよいようにしてある）
--   customer_id はGASスプレッドシート発行の顧客ID（外部/レガシーID）。
--   store_id + customer_id の組で一意（1店舗内で重複しない前提）。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id           INTEGER NOT NULL REFERENCES stores(id),
  customer_id        VARCHAR(50) NOT NULL,   -- 顧客マスタシート発行の顧客ID（例：'C0001'）
  realname           VARCHAR(50) NOT NULL,   -- お客様氏名
  kana               VARCHAR(50),
  phone              VARCHAR(20),
  line_name          VARCHAR(50),
  user_id            VARCHAR(100),           -- 顧客本人のLINE userId（既存列を流用。★2026-09-18：
                                              --   LINE連携機能追加にあたり新規列を足さず、この列を
                                              --   lib/reservationNotify.js からの通知先として利用する）
  birthday           DATE,                   -- 'YYYY-MM-DD'
  first_visit_date   DATE,
  last_visit_date    DATE,
  total_visits       INTEGER NOT NULL DEFAULT 0,
  memo               TEXT,
  is_deleted         INTEGER NOT NULL DEFAULT 0,  -- ★2026-09-19追加：顧客統合機能。統合されて消える側は
                                                    --   物理削除せずここを1にする（GAS版のdelFlag相当）。
                                                    --   ★同日追加：詳細編集画面からの手動削除・復元にも
                                                    --   この列をそのまま流用する（GAS版owner_ui.htmlの
                                                    --   「顧客管理」画面の削除・復元ボタン相当）
  deleted_at         DATETIME,
  status             VARCHAR(10) NOT NULL DEFAULT 'active',  -- ★2026-09-19追加：'active'|'inactive'
                                                    --   （GAS版COL_K_STATUS相当。予約フォームのスタッフ
                                                    --   選択肢などから隠したいがデータは残したい顧客用。
                                                    --   is_deletedとは別概念）
  staff_name         VARCHAR(50),                 -- ★2026-09-19追加：担当スタッフ（GAS版H列相当）
  is_keep_member     INTEGER NOT NULL DEFAULT 0,  -- ★2026-09-19追加：キープメンバー（GAS版I列相当）
  opt_support        INTEGER NOT NULL DEFAULT 0,  -- ★2026-09-19追加：オプション対応可否（GAS版G列相当）
  booking_blocked    INTEGER NOT NULL DEFAULT 0,  -- ★2026-09-19追加：この顧客からの予約をブロックする
  notify_enabled     INTEGER NOT NULL DEFAULT 1,  -- ★2026-09-19追加：LINE通知の対象にするか
  updated_by         VARCHAR(50),                 -- ★2026-09-19追加：最終更新者（スタッフ名）
  address            VARCHAR(255),                -- ★2026-09-23追加：ご住所（GAS版registerNewCustomer/
                                                    --   findOrCreateCustomer_のaddr相当。以前はaddr列が
                                                    --   無くmemoに含める運用だったが、お客様予約フォーム
                                                    --   の新規登録（48-10）で正式な入力項目になったため
                                                    --   独立列にした）
  info_confirmed     INTEGER NOT NULL DEFAULT 0,   -- ★2026-09-23追加：GAS版顧客マスタ15列目「情報確定
                                                    --   フラグ」相当。お客様予約フォームの新規登録
                                                    --   （氏名・フリガナ・電話番号・住所の入力）が完了
                                                    --   した顧客は1。LINE友だち追加のみ・スタッフ未入力の
                                                    --   顧客は0のままで、公開予約フォームで登録画面が
                                                    --   再度案内される
  keep_member_requested INTEGER NOT NULL DEFAULT 0, -- ★2026-09-23追加：お客様予約フォームからの
                                                    --   「キープメンバー希望」申告（GAS版には無いNode版
                                                    --   独自機能・社長のご依頼で追加）。実際の付与判断は
                                                    --   引き続きオーナーが行う（顧客管理画面で申告フラグ
                                                    --   を見てキープメンバーに切り替える）
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(store_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_customers_store_cid      ON customers(store_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_customers_store_realname  ON customers(store_id, realname);
CREATE INDEX IF NOT EXISTS idx_customers_store_phone     ON customers(store_id, phone);

-- ============================================================================
-- ★2026-09-19追加：顧客マスタの重複統合（マージ）機能
--   GAS版のcustomer_merge_functions.gsに相当。電話番号が一致するのに顧客IDが
--   異なる（＝重複登録の疑いがある）組み合わせを検知し、統合または「別人」として
--   見送るかをオーナーが判断する。見送り済みの組み合わせは再度候補として出さない。
-- ============================================================================
CREATE TABLE IF NOT EXISTS customer_merge_dismissals (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id           INTEGER NOT NULL REFERENCES stores(id),
  customer_id_a      VARCHAR(50) NOT NULL,  -- ★正規化のため常に customer_id_a < customer_id_b の順で保存
  customer_id_b      VARCHAR(50) NOT NULL,
  dismissed_by       VARCHAR(50),
  dismissed_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(store_id, customer_id_a, customer_id_b)
);

-- ============================================================================
-- ★2026-09-19追加：メニューマスタ（GAS版owner_ui.htmlの「メニューマスタ」パネル・
--   SHEET_MENU相当）。それまでお客様予約フォームのメニュー選択肢は
--   public/index.htmlに直接ハードコードされた4件の固定文字列だったが、
--   オーナー管理画面から料金・所要時間込みで追加/編集/非表示にできるようにする。
--   GAS版は親メニュー＋内訳（parent/child）の階層構造を持つが、このプロトタイプでは
--   フラットな一覧のみに簡略化している（親子内訳は将来の拡張候補）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS menu_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id       INTEGER NOT NULL REFERENCES stores(id),
  category       VARCHAR(30) NOT NULL,   -- 'メインメニュー' / '施術系オプション' / 'オプション'
  name           VARCHAR(100) NOT NULL,
  duration_min   INTEGER NOT NULL DEFAULT 0,
  price          INTEGER NOT NULL DEFAULT 0,
  target         VARCHAR(20) NOT NULL DEFAULT '全員',  -- '全員' / '初回' / 'キープメンバー' / 'ビジター'
  is_active      INTEGER NOT NULL DEFAULT 1,
  display_order  INTEGER NOT NULL DEFAULT 0,
  is_initial     INTEGER NOT NULL DEFAULT 0,     -- ★2026-09-24追加：店舗の初期データとして投入されたメニューか。
                                                 --   GAS版owner_ui.htmlと同じく、初期メニューの名称・カテゴリは
                                                 --   管理者ログイン時のみ変更でき、オーナーは所要時間・料金・対象・
                                                 --   有効/無効だけ変更できる（オーナー自身が追加した行は全項目可）
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_menu_items_store ON menu_items(store_id, display_order);

-- ============================================================================
-- ★2026-09-20追加：メッセージ設定（GAS版owner_ui.htmlの「メッセージ設定」パネル・
--   スプレッドシートの「messages」シート相当）。LINE通知テンプレート（本文＋締めの文）
--   を店舗ごとに保存する。未登録キーは lib/messageTemplates.js の
--   DEFAULT_MESSAGE_TEMPLATES にフォールバックする（GAS版と同じ方式）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS message_templates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id       INTEGER NOT NULL REFERENCES stores(id),
  msg_key        VARCHAR(30) NOT NULL,  -- welcome / confirm_add / confirm_keep / confirm_provisional / confirm_finalize / change / cancel / remind
  body           TEXT NOT NULL DEFAULT '',
  closing        TEXT NOT NULL DEFAULT '',
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(store_id, msg_key)
);

-- ============================================================================
-- ★2026-09-20追加：受付ルール・注意書き（GAS版owner_ui.htmlの「受付ルール・注意書き」
--   パネル＝rule2シートの「カード②お客様向け注意書き」相当）。お客様予約フォームの
--   最終ページに表示する注意事項を、対象（全員／初回／リピーター）ごとに管理する。
--   GAS版にある「定型文（オーナーは文言編集不可）」「管理者専用の生データ編集欄
--   （カード③）」は、Node版の予約フォームがまだ新規/リピーター判定を持たないため
--   今回は簡略化し対象外とした（詳細はREADME_PROTOTYPE.md参照）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS booking_notices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id       INTEGER NOT NULL REFERENCES stores(id),
  target         VARCHAR(20) NOT NULL DEFAULT '全員',  -- '全員' / '初回' / 'リピーター'
  text           TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_booking_notices_store ON booking_notices(store_id);

-- インデックス（検索性能用。日付・店舗・スタッフでの絞り込みが多いため）
CREATE INDEX IF NOT EXISTS idx_reservations_store_date ON reservations(store_id, reservation_date);
CREATE INDEX IF NOT EXISTS idx_reservations_staff_date  ON reservations(store_id, staff_name, reservation_date);

-- ★2026-09-18追加：二重予約防止の安全弁
--   同じ店舗・同じ担当者・同じ日付・同じ開始時刻の「有効な」予約（realname≠'キャンセル'）は
--   1件しか存在できないようDB自体に強制させる。GAS版はCacheServiceによる自前mutex
--   （withStoreLock_）でこれを防いでいたが、本物のDBの一意制約の方が確実。
--   同時に複数の登録リクエストが来た場合、2件目以降はこの制約違反でエラーになり、
--   アプリ側で「ちょうど埋まりました」という案内に変換する。
CREATE UNIQUE INDEX IF NOT EXISTS idx_no_double_booking
  ON reservations(store_id, staff_name, reservation_date, reservation_time)
  WHERE realname != 'キャンセル';
CREATE INDEX IF NOT EXISTS idx_shift_store_date          ON shift_master(store_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_shift_staff_date           ON shift_master(store_id, staff_name, shift_date);
CREATE INDEX IF NOT EXISTS idx_shift_template_store_dow   ON shift_templates(store_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_events_store_date          ON events(store_id, event_date);

-- ============================================================================
-- ★2026-09-18追加：LINE連携（Messaging API）はこのラウンドでは「骨組み」段階。
--   - Webhook受信（署名検証・イベントのパース＆ログ出力）：実際に動く実装。
--   - スタッフPIN自動登録（4桁PINテキスト送信 → staff.line_user_id 自動登録）：実際に動く実装。
--   - お客様への予約確定プッシュ通知（lib/reservationNotify.js）：
--     stores.line_customer_channel_token が未設定の間は「送信したつもりでログに出す」
--     シミュレーション動作。実チャネルのトークンをDBに設定すれば実送信に切り替わる。
--   詳しくは README_PROTOTYPE.md の「LINE連携（Messaging API）」セクションを参照。
-- ============================================================================

-- ============================================================================
-- ★2026-09-24追加：DB一覧ビューアの編集ログ（監査ログ）
--   管理者ログイン時だけ使えるDB一覧ビューアの編集機能で、どのテーブルの、どの行の、
--   どのカラムを、いつ、誰が、旧値→新値でどう変えたかを1カラム1行で記録する。
--   ログ自体の編集・削除APIは用意しない（改ざん防止）。DB一覧ビューアの1タブで閲覧する。
-- ============================================================================
CREATE TABLE IF NOT EXISTS db_edit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id     INTEGER NOT NULL REFERENCES stores(id),
  table_name   VARCHAR(50) NOT NULL,
  row_id       INTEGER NOT NULL,
  column_name  VARCHAR(50) NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  edited_by    VARCHAR(50) NOT NULL,   -- 管理者は相野様お一人のため「管理者」で固定
  edited_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_db_edit_log_store ON db_edit_log(store_id, edited_at);

-- ============================================================================
-- ★2026-09-24追加：LINE webhookの受信ログ（GAS版webhook_logシート相当）
--   受信したイベントの種別・送信先チャネル（destination）・userId・本文・処理結果を
--   1イベント1行で記録する。管理者ログイン時だけDB一覧ビューアで閲覧できる（閲覧専用）。
--   お客様のメッセージ本文を含むため、日次メンテナンスで90日より古い行を自動削除する。
--   スタッフが送る4桁PIN（LINE userId自動登録用）は平文で残さないよう、本文・生データとも
--   マスクしてから保存する（routes/lineWebhook.js参照）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS webhook_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      INTEGER REFERENCES stores(id),
  received_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  event_type    VARCHAR(30),            -- follow / unfollow / message / postback ... （署名NG等は '(request)'）
  message_type  VARCHAR(30),            -- text / sticker / image ...（message以外は空）
  destination   VARCHAR(64),            -- 受信したLINEチャネル（ボットのuserId）
  source_type   VARCHAR(20),            -- user / group / room
  user_id       VARCHAR(64),
  body          TEXT,                   -- テキスト本文・スタンプID・postbackデータ等（4桁PINはマスク）
  result        VARCHAR(200),           -- 処理結果（例：顧客マスタ登録／PIN登録／キーワード応答／対象外）
  raw_json      TEXT                    -- イベントの生データ（JSON。4桁PINはマスク）
);
CREATE INDEX IF NOT EXISTS idx_webhook_log_store ON webhook_log(store_id, received_at);
