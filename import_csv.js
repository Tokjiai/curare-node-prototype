// ============================================================================
// import_csv.js
// GASスプレッドシート（顧客マスタ／予約データ）をCSVエクスポートしたものを
// このプロトタイプのSQLite DBへ取り込む（upsert）ためのスクリプト。
//
// 使い方：
//   node import_csv.js customers    <path-to-csv> [--store=<slug or id>]
//   node import_csv.js reservations <path-to-csv> [--store=<slug or id>]
//
// 運用イメージ：
//   本番稼働中はGAS＋スプレッドシートが引き続き正（live production）。
//   定期的にスプレッドシートを「ファイル > ダウンロード > カンマ区切り(.csv)」で
//   書き出し、このスクリプトで再インポートする（何度実行してもOK＝冪等）。
//
// 【重要】列マッピングについて
//   実際のGoogleスプレッドシートの列見出し（日本語）や列順は将来ちょっとした
//   変更が入る可能性がある。その変化にこのスクリプト全体が引きずられないよう、
//   「CSVの列見出し → DBカラム名」の対応関係は、このファイル冒頭の
//   COLUMN MAPPING オブジェクトだけに集約してある。
//   シート側の見出し表記が変わった場合は、このマッピングのキー（左辺の日本語）
//   だけを直せばよい。パース処理・upsert処理には手を入れる必要がない。
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./lib/db');

// ============================================================================
// ★COLUMN MAPPING（ここだけ編集すればシート側の列見出し変更に追従できる）
//   キー   = CSVのヘッダー行に出てくる列名（実際のGoogleスプレッドシートの表記そのまま）
//   値     = 対応するDBカラム名（customers / reservations テーブルの列名）
// ============================================================================
// ★2026-09-19更新：実際のcurare-storeB-db_TEST（テストB店）スプレッドシートの
//   実表記に合わせてマッピングを更新。当初の想定見出し（氏名／LINE userId等）から
//   実物は「本名」「LINE_USER_ID」等の表記だったため、ここだけを直して追従した。
//   これがこのファイルの設計意図どおりの使い方＝マッピング欄だけの修正で済む例。
const CUSTOMER_COLUMN_MAP = {
  '顧客ID': 'customer_id',
  '本名': 'realname',
  'フリガナ': 'kana',
  '電話番号': 'phone',
  'LINE名': 'line_name',
  'LINE_USER_ID': 'user_id',
  '登録日': 'first_visit_date',
  '来店回数': 'total_visits',
  '備考': 'memo'
};

const RESERVATION_COLUMN_MAP = {
  '本名': 'realname',
  'フリガナ': 'kana',
  'LINE名': 'line_name',
  'LINE_USER_ID': 'user_id',
  '担当スタッフ': 'staff_name',
  'メニュー': 'menu',
  '予約日': 'reservation_date',
  '時間': 'reservation_time',
  '備考': 'note',
  '登録者': 'editor',
  'CID参考列': 'customer_id',
  '予約ステータス': 'status'
};

// customersテーブルで数値として扱うカラム（CSVは文字列で来るため変換する）
const CUSTOMER_NUMERIC_COLS = new Set(['total_visits']);

// ============================================================================
// 最小限のCSVパーサー（引用符・カンマ・改行を含むフィールド、UTF-8日本語に対応）
//   軽量な依存追加を避けるため自前実装。RFC4180相当のダブルクォート規則に対応：
//   - フィールドを "..." で囲める
//   - 囲み内の "" はエスケープされた " 1文字
//   - 囲み内の改行・カンマはそのままフィールドの内容として扱う
// ============================================================================
function parseCsv(text) {
  // BOM除去（Excel/スプレッドシートからのエクスポートで付くことがある）
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\r') { i++; continue; } // CRLF対応：\rは無視し\nで改行判定
    if (c === '\n') { pushRow(); i++; continue; }
    field += c; i++;
  }
  // 最後の行（末尾に改行が無い場合）
  if (field.length > 0 || row.length > 0) pushRow();

  // 完全な空行（末尾の余分な改行等）を除去
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// ヘッダー行 + データ行の配列を「ヘッダー名: 値」のオブジェクト配列に変換
function rowsToObjects(rows) {
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
    return obj;
  });
}

// CSVの1行オブジェクトを COLUMN MAPPING に従ってDBカラム名のオブジェクトに変換
// マッピングに無い列見出しは無視する（シート側に余分な列があっても安全）
function mapRow(csvRowObj, columnMap, numericCols) {
  const mapped = {};
  for (const [csvHeader, dbCol] of Object.entries(columnMap)) {
    let val = csvHeader in csvRowObj ? csvRowObj[csvHeader] : '';
    if (numericCols && numericCols.has(dbCol)) {
      const n = Number(String(val).trim());
      val = Number.isFinite(n) ? n : 0;
    } else {
      val = val == null ? '' : String(val).trim();
    }
    mapped[dbCol] = val;
  }
  return mapped;
}

// ----------------------------------------------------------------------------
// store解決（--store=<slug or id>、省略時は store_id=1）
// ----------------------------------------------------------------------------
function resolveStoreId(storeArg) {
  if (!storeArg) return 1;
  const byId = db.prepare('SELECT id FROM stores WHERE id = ?').get(Number(storeArg));
  if (byId) return byId.id;
  const bySlug = db.prepare('SELECT id FROM stores WHERE slug = ?').get(storeArg);
  if (bySlug) return bySlug.id;
  console.warn(`⚠️ store "${storeArg}" が見つからないため store_id=1 を使用します`);
  return 1;
}

// ----------------------------------------------------------------------------
// customers のupsert（store_id + customer_id で一致判定）
// ----------------------------------------------------------------------------
function importCustomers(objects, storeId) {
  const summary = { read: objects.length, inserted: 0, updated: 0, skipped: [] };

  const upsert = db.prepare(`
    INSERT INTO customers
      (store_id, customer_id, realname, kana, phone, line_name, user_id, first_visit_date, total_visits, memo, updated_at)
    VALUES
      (@store_id, @customer_id, @realname, @kana, @phone, @line_name, @user_id, @first_visit_date, @total_visits, @memo, CURRENT_TIMESTAMP)
    ON CONFLICT(store_id, customer_id) DO UPDATE SET
      realname          = excluded.realname,
      kana              = excluded.kana,
      phone             = excluded.phone,
      line_name         = excluded.line_name,
      user_id           = excluded.user_id,
      first_visit_date  = excluded.first_visit_date,
      total_visits      = excluded.total_visits,
      memo              = excluded.memo,
      updated_at        = CURRENT_TIMESTAMP
  `);

  const existsCheck = db.prepare('SELECT id FROM customers WHERE store_id = ? AND customer_id = ?');

  const txn = db.transaction((rows) => {
    for (const raw of rows) {
      const mapped = mapRow(raw, CUSTOMER_COLUMN_MAP, CUSTOMER_NUMERIC_COLS);
      if (!mapped.customer_id) {
        summary.skipped.push({ row: raw, reason: '顧客IDが空' });
        continue;
      }
      if (!mapped.realname) {
        summary.skipped.push({ row: raw, reason: '氏名が空' });
        continue;
      }
      const before = existsCheck.get(storeId, mapped.customer_id);
      upsert.run({ store_id: storeId, ...mapped });
      if (before) summary.updated++; else summary.inserted++;
    }
  });
  txn(objects);

  return summary;
}

// ----------------------------------------------------------------------------
// reservations のupsert（store_id + staff_name + reservation_date + reservation_time で一致判定）
//   ※予約データ本体の主運用はお客様フォーム/オーナー操作によるINSERTだが、
//     CSV再取込でも同じ枠は上書き更新にとどめ、重複行を作らないようにする。
// ----------------------------------------------------------------------------
function importReservations(objects, storeId) {
  const summary = { read: objects.length, inserted: 0, updated: 0, skipped: [] };

  const upsert = db.prepare(`
    INSERT INTO reservations
      (store_id, realname, kana, line_name, user_id, staff_name, menu, reservation_date, reservation_time, note, editor, customer_id, status, updated_at)
    VALUES
      (@store_id, @realname, @kana, @line_name, @user_id, @staff_name, @menu, @reservation_date, @reservation_time, @note, @editor, @customer_id, @status, CURRENT_TIMESTAMP)
    ON CONFLICT(store_id, staff_name, reservation_date, reservation_time)
    WHERE realname != 'キャンセル'
    DO UPDATE SET
      realname     = excluded.realname,
      kana         = excluded.kana,
      line_name    = excluded.line_name,
      user_id      = excluded.user_id,
      menu         = excluded.menu,
      note         = excluded.note,
      editor       = excluded.editor,
      customer_id  = excluded.customer_id,
      status       = excluded.status,
      updated_at   = CURRENT_TIMESTAMP
  `);

  const existsCheck = db.prepare(`
    SELECT id FROM reservations
    WHERE store_id = ? AND staff_name = ? AND reservation_date = ? AND reservation_time = ? AND realname != 'キャンセル'
  `);

  const txn = db.transaction((rows) => {
    for (const raw of rows) {
      const mapped = mapRow(raw, RESERVATION_COLUMN_MAP, null);
      if (!mapped.staff_name || !mapped.reservation_date || !mapped.reservation_time) {
        summary.skipped.push({ row: raw, reason: '担当/予約日/予約時刻のいずれかが空' });
        continue;
      }
      if (!mapped.status) mapped.status = '確定';
      const before = existsCheck.get(storeId, mapped.staff_name, mapped.reservation_date, mapped.reservation_time);
      try {
        upsert.run({ store_id: storeId, ...mapped });
        if (before) summary.updated++; else summary.inserted++;
      } catch (e) {
        summary.skipped.push({ row: raw, reason: 'DBエラー: ' + e.message });
      }
    }
  });
  txn(objects);

  return summary;
}

// ----------------------------------------------------------------------------
// メイン処理
// ----------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const storeFlag = args.find((a) => a.startsWith('--store='));
  const storeArg = storeFlag ? storeFlag.split('=')[1] : null;

  const [sheetName, csvPath] = positional;

  if (!sheetName || !csvPath) {
    console.error('使い方: node import_csv.js <sheetName: customers|reservations> <path-to-csv> [--store=<slug or id>]');
    process.exit(1);
  }
  if (!['customers', 'reservations'].includes(sheetName)) {
    console.error(`未対応の sheetName です: "${sheetName}"（customers または reservations を指定してください）`);
    process.exit(1);
  }
  if (!fs.existsSync(csvPath)) {
    console.error(`CSVファイルが見つかりません: ${csvPath}`);
    process.exit(1);
  }

  const storeId = resolveStoreId(storeArg);
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  const objects = rowsToObjects(rows);

  console.log(`📥 取込開始: sheet=${sheetName} file=${path.resolve(csvPath)} store_id=${storeId}`);

  const summary = sheetName === 'customers'
    ? importCustomers(objects, storeId)
    : importReservations(objects, storeId);

  console.log('----------------------------------------');
  console.log(`読み込み行数: ${summary.read}`);
  console.log(`新規登録    : ${summary.inserted}`);
  console.log(`更新        : ${summary.updated}`);
  console.log(`スキップ    : ${summary.skipped.length}`);
  if (summary.skipped.length > 0) {
    summary.skipped.forEach((s, idx) => {
      console.log(`  [${idx + 1}] 理由: ${s.reason}`);
    });
  }
  console.log('----------------------------------------');
  console.log('✅ 取込完了（再実行しても重複登録されません＝冪等）');
}

if (require.main === module) {
  main();
}

module.exports = { parseCsv, rowsToObjects, mapRow, CUSTOMER_COLUMN_MAP, RESERVATION_COLUMN_MAP };
