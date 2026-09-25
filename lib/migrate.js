// ============================================================================
// lib/migrate.js
//
// 【背景】schema.sqlの CREATE TABLE IF NOT EXISTS は、テーブルが「まだ無い」場合にしか
// 効かない。このプロトタイプは開発中に何度もテーブル定義へ列を追加してきたが、
// 既にテーブルが存在するDBファイル（例：SKIP_SEED=1で運用データを保持している本番、
// またはローカルに残っている古いdata/app.db）に対しては、新しい列が自動的には
// 追加されない。その結果、コード側は新しい列を前提にSELECT/INSERT/UPDATEするのに、
// 実際のテーブルにその列が無く「no such column」で500エラーになる、という
// 事故が起きうる（実際に発生した）。
//
// このファイルは、起動のたびに「schema.sql が最新で期待している列」と
// 「実際のテーブルの列」を比較し、足りない列があれば ALTER TABLE ADD COLUMN で
// 追加する、簡易・冪等（何度実行しても安全）なマイグレーションを行う。
// db/init.js（通常起動時）・server.js のSKIP_SEED=1分岐の両方から呼び出すことで、
// どちらの起動経路でも欠けている列が確実に補われるようにしている。
//
// 【本番移行メモ】MySQL移行時は、こういった場当たり的なALTER TABLE ADD COLUMNではなく、
// きちんとしたマイグレーションツール（knex/db-migrate等）に置き換えること。
// ============================================================================

// 過去に後から追加された列の一覧。
// { table, column, ddl } の ddl は "ALTER TABLE <table> ADD COLUMN " の後に続く部分。
const ADDED_COLUMNS = [
  // stores（2026-09-18追加）
  { table: 'stores', column: 'plan', ddl: "plan VARCHAR(20) NOT NULL DEFAULT 'trial'" },
  { table: 'stores', column: 'line_customer_channel_token', ddl: 'line_customer_channel_token VARCHAR(255)' },
  { table: 'stores', column: 'line_staff_channel_secret', ddl: 'line_staff_channel_secret VARCHAR(255)' },

  // staff（2026-09-18追加）
  { table: 'staff', column: 'pin_hash', ddl: 'pin_hash VARCHAR(255)' },
  { table: 'staff', column: 'pin_salt', ddl: 'pin_salt VARCHAR(64)' },
  { table: 'staff', column: 'is_owner', ddl: 'is_owner BOOLEAN NOT NULL DEFAULT 0' },
  { table: 'staff', column: 'line_user_id', ddl: 'line_user_id VARCHAR(64)' },

  // customers（2026-09-19追加）
  { table: 'customers', column: 'is_deleted', ddl: 'is_deleted INTEGER NOT NULL DEFAULT 0' },
  { table: 'customers', column: 'deleted_at', ddl: 'deleted_at DATETIME' },
  { table: 'customers', column: 'status', ddl: "status VARCHAR(10) NOT NULL DEFAULT 'active'" },
  { table: 'customers', column: 'staff_name', ddl: 'staff_name VARCHAR(50)' },
  { table: 'customers', column: 'is_keep_member', ddl: 'is_keep_member INTEGER NOT NULL DEFAULT 0' },
  { table: 'customers', column: 'opt_support', ddl: 'opt_support INTEGER NOT NULL DEFAULT 0' },
  { table: 'customers', column: 'booking_blocked', ddl: 'booking_blocked INTEGER NOT NULL DEFAULT 0' },
  { table: 'customers', column: 'notify_enabled', ddl: 'notify_enabled INTEGER NOT NULL DEFAULT 1' },
  { table: 'customers', column: 'updated_by', ddl: 'updated_by VARCHAR(50)' },
  // ★SQLiteのALTER TABLE ADD COLUMNは、DEFAULTに定数以外（CURRENT_TIMESTAMP等の式）を
  //   指定できない制約があるため、ここではNULL許容・デフォルト無しで追加する
  //   （既存行はNULLのままになるが、以後のUPDATE時に明示的にCURRENT_TIMESTAMPを
  //   セットしているため実用上問題ない）
  { table: 'customers', column: 'updated_at', ddl: 'updated_at DATETIME' },

  // stores（2026-09-20追加：受付ルール・注意書き＝rule2の「基本情報」カード相当）
  { table: 'stores', column: 'phone', ddl: 'phone VARCHAR(20)' },
  { table: 'stores', column: 'booking_period_info_days', ddl: 'booking_period_info_days INTEGER NOT NULL DEFAULT 14' },

  // customers（2026-09-23追加：お客様予約フォームの新規登録機能・キープメンバー希望申告）
  { table: 'customers', column: 'address', ddl: 'address VARCHAR(255)' },
  { table: 'customers', column: 'info_confirmed', ddl: 'info_confirmed INTEGER NOT NULL DEFAULT 0' },
  { table: 'customers', column: 'keep_member_requested', ddl: 'keep_member_requested INTEGER NOT NULL DEFAULT 0' },

  // staff（2026-09-23追加：スタッフ毎のカレンダー表示色。GAS版マスタC列相当）
  { table: 'staff', column: 'color', ddl: 'color VARCHAR(20)' },
  // staff（2026-09-24追加：「サロン端末」共有ログイン（GAS版ST099相当）の区別フラグ）
  { table: 'staff', column: 'is_shared_terminal', ddl: 'is_shared_terminal BOOLEAN NOT NULL DEFAULT 0' },
  // menu_items（2026-09-24追加：初期メニューの目印。名称・カテゴリの変更は管理者のみ）
  { table: 'menu_items', column: 'is_initial', ddl: 'is_initial INTEGER NOT NULL DEFAULT 0' },

  // stores（2026-09-23追加：オーナー・スタッフ向けLINE公式アカウントのプッシュ送信用トークン。
  //   line_staff_channel_secretはWebhook署名検証専用のため、朝/夕方レポート等の
  //   プッシュ送信には別途このトークンが必要）
  { table: 'stores', column: 'line_staff_channel_token', ddl: 'line_staff_channel_token VARCHAR(255)' },

  // reservations（2026-09-23追加：前日リマインダー送付済みフラグ。GAS版COL_Y_REMINDER相当）
  { table: 'reservations', column: 'reminder_sent', ddl: 'reminder_sent BOOLEAN NOT NULL DEFAULT 0' },

  // stores（2026-09-25追加：管理者専用「複数店舗プラットフォーム管理画面」フェーズBの店舗一覧に出す稼働状況）
  { table: 'stores', column: 'is_active', ddl: 'is_active BOOLEAN NOT NULL DEFAULT 1' }
];

// ★2026-09-23追加：スタッフの表示色キー（GAS版calendar_page.htmlのCOLOR_MAPと同じ13色）。
//   server.jsのカレンダー配色表と同じ並び順にしてあり、色が未設定のスタッフへ
//   「これまで自動割り当てで表示されていた色」をそのまま保存するのに使う。
const STAFF_COLOR_KEYS = ['BLUE', 'RED', 'GREEN', 'ORANGE', 'GRAPE', 'CYAN', 'YELLOW', 'BASIL', 'MAUVE', 'PALE_BLUE', 'PALE_RED', 'PALE_GREEN', 'GRAPHITE'];

// ★2026-09-23追加：color列を新設した時点で色が空のスタッフに、それまでの自動割り当て
//   （在籍中スタッフをstaff.id順に並べ、パレットを順番に割り当てる方式）と同じ色を
//   保存する。これにより、色の保存方式を切り替えても見た目が変わらない。
//   退職済み（is_active=0）のスタッフも、過去の予約が灰色にならないよう、在籍中の
//   スタッフの後ろに続けて割り当てる。
function backfillStaffColors(db) {
  if (!tableExists(db, 'staff')) return;
  if (!existingColumns(db, 'staff').has('color')) return;
  const stores = db.prepare('SELECT DISTINCT store_id FROM staff').all();
  const update = db.prepare('UPDATE staff SET color = ? WHERE id = ?');
  let filled = 0;
  stores.forEach(({ store_id: storeId }) => {
    const active = db.prepare('SELECT id, color FROM staff WHERE store_id = ? AND is_active = 1 ORDER BY id').all(storeId);
    const inactive = db.prepare('SELECT id, color FROM staff WHERE store_id = ? AND is_active = 0 ORDER BY id').all(storeId);
    [...active, ...inactive].forEach((row, i) => {
      if (row.color) return;
      update.run(STAFF_COLOR_KEYS[i % STAFF_COLOR_KEYS.length], row.id);
      filled++;
    });
  });
  if (filled > 0) {
    console.log(`🛠️  マイグレーション: スタッフ${filled}名の表示色を補完しました（これまでの自動割り当てと同じ色）`);
  }
}

function tableExists(db, table) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
  return !!row;
}

function existingColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

// ★2026-09-22追加：db/init.js の insertRule.run(...) は「初回のDB作成時」にしか
// 実行されない。既にrulesテーブルを持つ既存のDB（例：SKIP_SEED=1で運用データを
// 保持しているRender本番）には、後から追加した新しいルール行（例：
// CANCEL_DELETE_DAYS）が自動的には入らない。ここで「まだ無ければ挿入する」形の
// 冪等な補完を行い、上のADDED_COLUMNSと同様に、どちらの起動経路でも確実に
// デフォルト値が揃うようにする。
// { rule_id, memo, defaultValue } の一覧。
const DEFAULT_RULES = [
  // rules（2026-09-22追加：GAS版コード.gs deleteCancelledReservationsの移植に伴う）
  { rule_id: 'CANCEL_DELETE_DAYS', memo: 'キャンセル済み予約を自動削除するまでの日数', defaultValue: '60' },
  // rules（2026-09-22追加：GAS版コード.gs expandShiftByRule_の移植に伴う）
  { rule_id: 'SHIFT_EXPAND_DAYS', memo: 'シフトを何日先まで自動展開するか', defaultValue: '49' },
  // rules（2026-09-22追加：GAS版dashboard_functions.gs getUpcomingReservationsの移植に伴う）
  { rule_id: 'UPCOMING_RESERVATION_DAYS', memo: 'スタッフダッシュボードの「直近の予約」に表示する日数', defaultValue: '15' },
  // rules（2026-09-23追加：常設スケジューラ lib/scheduler.js の実行時刻設定。詳細はdb/init.js参照）
  { rule_id: 'DAILY_MAINTENANCE_HOUR', memo: '日次メンテナンス処理を自動実行する時刻（0〜23時）', defaultValue: '5' },
  { rule_id: 'MORNING_REPORT_HOUR', memo: '朝レポートをオーナーへ自動送信する時刻（0〜23時）', defaultValue: '8' },
  { rule_id: 'EVENING_REPORT_HOUR', memo: '夕方レポート（＋スタッフ翌日予約通知）を自動送信する時刻（0〜23時）', defaultValue: '20' },
  { rule_id: 'REMINDER_HOUR', memo: '前日リマインダーをお客様へ自動送信する時刻（0〜23時、GAS版と同じ店舗別設定）', defaultValue: '18' }
];

function ensureDefaultRules(db) {
  if (!tableExists(db, 'rules') || !tableExists(db, 'stores')) return;
  const stores = db.prepare('SELECT id FROM stores').all();
  const insertRule = db.prepare('INSERT INTO rules (store_id, rule_id, memo, value) VALUES (?, ?, ?, ?)');
  const existsRule = db.prepare('SELECT 1 FROM rules WHERE store_id = ? AND rule_id = ?');
  let addedCount = 0;
  stores.forEach((store) => {
    DEFAULT_RULES.forEach((rule) => {
      if (existsRule.get(store.id, rule.rule_id)) return;
      insertRule.run(store.id, rule.rule_id, rule.memo, rule.defaultValue);
      addedCount++;
    });
  });
  if (addedCount > 0) {
    console.log(`🛠️  マイグレーション: 不足していたルール行を${addedCount}件補完しました（既存データは保持されています）`);
  }
}

// ★2026-09-23追加：新設したinfo_confirmed列（お客様予約フォームの新規登録＝氏名・
//   フリガナ・電話番号・住所の入力が完了しているかのフラグ）について、既存データ
//   （本名・電話番号が既に入っている＝以前からスタッフ手入力や来店実績のある顧客）は
//   後追いで1（確定済み）とみなす。これを行わないと、既存の全顧客が「未登録」扱いに
//   なり、公開予約フォームで不要な登録画面が毎回出てしまう。
function backfillInfoConfirmed(db) {
  if (!tableExists(db, 'customers')) return;
  const cols = existingColumns(db, 'customers');
  if (!cols.has('info_confirmed')) return; // ALTER TABLE直後、同一トランザクション内では未反映の場合に備える
  const result = db.prepare(`
    UPDATE customers SET info_confirmed = 1
    WHERE info_confirmed = 0 AND TRIM(COALESCE(realname, '')) != '' AND TRIM(COALESCE(phone, '')) != ''
  `).run();
  if (result.changes > 0) {
    console.log(`🛠️  マイグレーション: 既存顧客${result.changes}件のinfo_confirmed（登録確定フラグ）を補完しました`);
  }
}

// ★2026-09-24追加：menu_items.is_initial列を後から追加した既存DBでは、db/init.jsの
//   シードで投入していた名前のメニューを「初期メニュー」とみなして目印を付ける
//   （列を追加した直後の1回だけ呼ぶ。オーナーが後から追加したメニューは対象外のまま）
const INITIAL_MENU_NAMES = ['フェイシャル(60分)', 'フェイシャル(90分)', 'ボディ(90分)', 'ハンド(45分)', 'かっさオプション', 'ハンドパック', '初回限定フェイシャル体験(60分)', 'メンバーコース(90分)'];
function backfillInitialMenus(db) {
  const result = db.prepare(
    `UPDATE menu_items SET is_initial = 1 WHERE name IN (${INITIAL_MENU_NAMES.map(() => '?').join(', ')})`
  ).run(...INITIAL_MENU_NAMES);
  console.log(`🛠️  マイグレーション: 初期メニュー${result.changes}件にis_initialの目印を付けました`);
}

function runMigrations(db) {
  let addedCount = 0;
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    if (!tableExists(db, table)) continue; // schema.sql側でこれから作られるので対象外
    const cols = existingColumns(db, table);
    if (cols.has(column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    addedCount++;
    if (table === 'menu_items' && column === 'is_initial') backfillInitialMenus(db);
    console.log(`🛠️  マイグレーション: ${table}.${column} 列が無かったため追加しました`);
  }
  if (addedCount > 0) {
    console.log(`🛠️  マイグレーション完了：${addedCount}件の列を追加しました（既存データは保持されています）`);
  }
  ensureDefaultRules(db);
  backfillInfoConfirmed(db);
  backfillStaffColors(db);
}

module.exports = { runMigrations, STAFF_COLOR_KEYS };
