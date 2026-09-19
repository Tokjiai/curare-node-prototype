// ============================================================================
// lib/customerMerge.js
// 顧客マスタの重複統合（マージ）機能。GAS版のcustomer_merge_functions.gs
// （mergeCustomerRows_・getMergeCandidates・manualMergeCustomers 相当）を移植。
//
// GAS版は「LINE Webhook・お客様予約フォーム・スタッフ手入力」など複数の入口で
// 顧客が新規作成されるたびに自動で重複を検知していたが、このNode試作版では
// 顧客の作成経路がCSV取込（顧客IDはGAS側で発行済み）のみのため、
// 「作成時に自動検知する」のではなく「電話番号が一致する現行データをいつでも
// スキャンできる」方式に置き換えている。統合・見送りの結果は同じ形で記録する。
// ============================================================================

'use strict';

// 電話番号を数字だけに正規化する（ハイフン・全角等を無視して比較するため）
function normalizePhoneDigits(tel) {
  if (!tel) return '';
  return String(tel).replace(/[^\d]/g, '');
}

// ----------------------------------------------------------------------------
// findMergeCandidates(db, storeId)
//   店舗内のアクティブな顧客を電話番号でグルーピングし、同一電話番号なのに
//   顧客IDが異なる組み合わせを重複候補として返す（見送り済みの組み合わせは除外）。
// ----------------------------------------------------------------------------
function findMergeCandidates(db, storeId) {
  const rows = db.prepare(
    'SELECT customer_id, realname, kana, phone, line_name, user_id, total_visits, memo FROM customers WHERE store_id = ? AND is_deleted = 0'
  ).all(storeId);

  const byPhone = new Map();
  for (const row of rows) {
    const digits = normalizePhoneDigits(row.phone);
    if (!digits) continue;
    if (!byPhone.has(digits)) byPhone.set(digits, []);
    byPhone.get(digits).push(row);
  }

  const dismissed = new Set(
    db.prepare('SELECT customer_id_a, customer_id_b FROM customer_merge_dismissals WHERE store_id = ?').all(storeId)
      .map((d) => `${d.customer_id_a}::${d.customer_id_b}`)
  );

  const candidates = [];
  for (const [digits, group] of byPhone.entries()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [x, y] = [group[i], group[j]].sort((a, b) => (a.customer_id < b.customer_id ? -1 : 1));
        const key = `${x.customer_id}::${y.customer_id}`;
        if (dismissed.has(key)) continue;
        candidates.push({
          reason: '電話番号一致',
          phone: digits,
          customerA: x,
          customerB: y
        });
      }
    }
  }
  return candidates;
}

// ----------------------------------------------------------------------------
// mergeCustomerRecords(db, storeId, keepCustomerId, mergeCustomerId, staffName)
//   keep側の空欄だけをmerge側の値で補完し（既存の値は上書きしない）、
//   merge側は論理削除（is_deleted=1）する。GAS版のmergeCustomerRows_相当。
// ----------------------------------------------------------------------------
function mergeCustomerRecords(db, storeId, keepCustomerId, mergeCustomerId, staffName) {
  const getRow = db.prepare('SELECT * FROM customers WHERE store_id = ? AND customer_id = ? AND is_deleted = 0');
  const keep = getRow.get(storeId, keepCustomerId);
  const merge = getRow.get(storeId, mergeCustomerId);

  if (!keep || !merge) {
    return { success: false, message: '対象の顧客データが見つかりません（' + (!keep ? keepCustomerId : mergeCustomerId) + '）' };
  }

  const fill = {};
  if (!keep.kana && merge.kana) fill.kana = merge.kana;
  if (!keep.phone && merge.phone) fill.phone = merge.phone;
  if (!keep.line_name && merge.line_name) fill.line_name = merge.line_name;
  if (!keep.user_id && merge.user_id) fill.user_id = merge.user_id;
  if (!keep.realname && merge.realname) fill.realname = merge.realname;
  if (!keep.memo && merge.memo) fill.memo = merge.memo;
  if (!keep.first_visit_date && merge.first_visit_date) fill.first_visit_date = merge.first_visit_date;
  // 来店回数は両方の合算にする（統合前提が「同一人物の重複登録」であるため）
  const mergedVisits = (keep.total_visits || 0) + (merge.total_visits || 0);

  const setClauses = Object.keys(fill).map((col) => `${col} = @${col}`);
  setClauses.push('total_visits = @total_visits', 'updated_at = CURRENT_TIMESTAMP');

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE customers SET ${setClauses.join(', ')}
      WHERE store_id = @store_id AND customer_id = @customer_id
    `).run({ ...fill, total_visits: mergedVisits, store_id: storeId, customer_id: keepCustomerId });

    db.prepare(`
      UPDATE customers SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE store_id = ? AND customer_id = ?
    `).run(storeId, mergeCustomerId);
  });
  txn();

  console.log(`✅ 顧客統合完了: ${mergeCustomerId} → ${keepCustomerId}（実行: ${staffName || '不明'}）`);
  return {
    success: true,
    message: `統合しました（${mergeCustomerId} の情報を ${keepCustomerId} に統合し、${mergeCustomerId} は削除済みにしました）`
  };
}

module.exports = { normalizePhoneDigits, findMergeCandidates, mergeCustomerRecords };
