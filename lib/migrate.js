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
  { table: 'customers', column: 'keep_member_requested', ddl: 'keep_member_requested INTEGER NOT NULL DEFAULT 0' }
];

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
  { rule_id: 'UPCOMING_RESERVATION_DAYS', memo: 'スタッフダッシュボードの「直近の予約」に表示する日数', defaultValue: '15' }
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

function runMigrations(db) {
  let addedCount = 0;
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    if (!tableExists(db, table)) continue; // schema.sql側でこれから作られるので対象外
    const cols = existingColumns(db, table);
    if (cols.has(column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    addedCount++;
    console.log(`🛠️  マイグレーション: ${table}.${column} 列が無かったため追加しました`);
  }
  if (addedCount > 0) {
    console.log(`🛠️  マイグレーション完了：${addedCount}件の列を追加しました（既存データは保持されています）`);
  }
  ensureDefaultRules(db);
  backfillInfoConfirmed(db);
}

module.exports = { runMigrations };
