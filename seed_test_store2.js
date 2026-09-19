// ============================================================================
// scripts/seed_test_store2.js
// ⑥統合テスト用フィクスチャ：2店舗目（岩田町店・テスト用）を追加投入する。
//
// 【位置づけ】
//   店舗を追加登録する管理UIはまだ無い（将来実装予定）。ここでは「store_idで
//   本当にデータが分離されているか」をテストするためだけに、DBへ直接2店舗目を
//   1件差し込む。integration_test.js の実行前に1回だけ流す想定。
//   db/init.js の initDatabase() は起動のたびに全店舗を削除して作り直すため、
//   このスクリプトは「SKIP_SEED=1で起動する直前」に実行すること。
// ============================================================================

const db = require('../lib/db');
const { createPinHash } = require('../lib/auth');

function seedStore2() {
  const existing = db.prepare('SELECT id FROM stores WHERE slug = ?').get('iwatamachi-test');
  if (existing) {
    console.log('ℹ️  テスト用2店舗目は既に存在します（store_id=' + existing.id + '）。何もしません。');
    return existing.id;
  }

  const info = db.prepare('INSERT INTO stores (slug, name, plan) VALUES (?, ?, ?)')
    .run('iwatamachi-test', '岩田町店（統合テスト用）', 'trial');
  const storeId = info.lastInsertRowid;

  const pin = '4321';
  const { hash, salt } = createPinHash(pin);
  db.prepare(`
    INSERT INTO staff (store_id, name, nickname, role, opt_support, night_restrict, show_in_booking, is_active, pin_hash, pin_salt, is_owner)
    VALUES (?, '岩田町オーナー', 'いわたまち', 'オーナー', 0, 0, 1, 1, ?, ?, 1)
  `).run(storeId, hash, salt);

  // 岩田町店側にも1名だけ顧客を入れておく（store1の顧客と混ざって見えないかの確認用）
  db.prepare(`
    INSERT INTO customers (store_id, customer_id, realname, kana, phone, total_visits, memo)
    VALUES (?, 'IW001', '岩田 花子', 'イワタ ハナコ', '090-9999-0000', 1, '統合テスト用ダミー顧客')
  `).run(storeId);

  console.log(`✅ テスト用2店舗目を投入しました：store_id=${storeId}, slug=iwatamachi-test, オーナーPIN=${pin}`);
  return storeId;
}

if (require.main === module) {
  seedStore2();
}

module.exports = { seedStore2 };
