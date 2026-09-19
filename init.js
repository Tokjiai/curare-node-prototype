// ============================================================================
// db/init.js
// DBファイルを作り直し、schema.sql を流し込んだうえでダミーデータ（seed）を投入する。
//
// Render無料プランのディスクはエフェメラル（再起動で消える）ため、
// server.js の起動時に毎回これを呼び出して初期化し直す設計にしている。
// ローカルで単体実行する場合は `node db/init.js` でもOK。
// ============================================================================

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const { createPinHash } = require('../lib/auth');

function initDatabase() {
  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schemaSql);
  seedData();
}

// ----------------------------------------------------------------------------
// 「クラーレ寿」を模したダミーのテストデータを投入する。
// 日付は「実行した日（today）」を基準にした相対日付にしてあるので、
// いつ実行しても getZoneStatus_ の TEL / 店休 / 満 / 空き 判定が一通り確認できる。
// ----------------------------------------------------------------------------
function seedData() {
  // 既存データを一旦クリア（再起動のたびに作り直す前提のため）
  db.exec(`
    DELETE FROM reservations;
    DELETE FROM customers;
    DELETE FROM shift_master;
    DELETE FROM events;
    DELETE FROM rules;
    DELETE FROM zones;
    DELETE FROM menu_items;
    DELETE FROM staff;
    DELETE FROM stores;
  `);

  const insertStore = db.prepare('INSERT INTO stores (id, slug, name) VALUES (?, ?, ?)');
  insertStore.run(1, 'kurare-kotobuki', 'クラーレ寿');
  const storeId = 1;

  // --- スタッフ3名（GASの「マスタ」シート相当） -----------------------------
  // ★2026-09-18追加：ログイン用PIN（電話番号下4桁を想定したダミー値）を付与。
  //   実運用では「スタッフの電話番号の下4桁」をPINとして使う運用に合わせている。
  //   寿子（オーナー）のみ is_owner=1 とし、管理画面にログインできるようにする。
  const insertStaff = db.prepare(`
    INSERT INTO staff (store_id, name, nickname, role, opt_support, night_restrict, show_in_booking, is_active, pin_hash, pin_salt, is_owner)
    VALUES (@store_id, @name, @nickname, @role, @opt_support, @night_restrict, @show_in_booking, @is_active, @pin_hash, @pin_salt, @is_owner)
  `);
  const staffSeeds = [
    { name: '寿子', nickname: 'ことこ',       role: 'オーナー', opt_support: 1, night_restrict: 1, phone: '090-1234-5678', is_owner: 1 },
    { name: '花子', nickname: 'はなちゃん',   role: 'スタッフ', opt_support: 1, night_restrict: 0, phone: '090-2345-6789', is_owner: 0 },
    { name: '美咲', nickname: 'みさき',       role: 'スタッフ', opt_support: 0, night_restrict: 1, phone: '090-3456-7890', is_owner: 0 }
  ];
  let seededOwnerPin = null;
  staffSeeds.forEach((s) => {
    const pin = s.phone.slice(-4); // 電話番号の下4桁をPINとして使う（GAS版の運用を踏襲）
    const { hash, salt } = createPinHash(pin);
    if (s.is_owner) seededOwnerPin = pin;
    insertStaff.run({
      store_id: storeId, name: s.name, nickname: s.nickname, role: s.role,
      opt_support: s.opt_support, night_restrict: s.night_restrict,
      show_in_booking: 1, is_active: 1,
      pin_hash: hash, pin_salt: salt, is_owner: s.is_owner
    });
  });

  // --- ルール設定（rule1シート相当） -----------------------------------------
  const insertRule = db.prepare('INSERT INTO rules (store_id, rule_id, memo, value) VALUES (?, ?, ?, ?)');
  insertRule.run(storeId, 'BOOKING_LIMIT_DAYS', '何日先まで予約受付可能か', '49');
  insertRule.run(storeId, 'BED_LIMIT', '同時施術可能なベッド数', '2');
  insertRule.run(storeId, 'MAX_RESERVATIONS_PER_CUSTOMER', '1顧客あたりの確定予約上限', '3');

  // --- ゾーン設定（zonesシート相当。GASのデフォルト値と同じ） -----------------
  const insertZone = db.prepare(`
    INSERT INTO zones (store_id, zone_key, label, start_time, end_time, is_active, fixed_target, fixed_start, fixed_interval_min)
    VALUES (@store_id, @zone_key, @label, @start_time, @end_time, 1, @fixed_target, @fixed_start, @fixed_interval_min)
  `);
  insertZone.run({ store_id: storeId, zone_key: 'am', label: '午前', start_time: '09:30', end_time: '12:45', fixed_target: 0, fixed_start: '', fixed_interval_min: 0 });
  insertZone.run({ store_id: storeId, zone_key: 'pm', label: '午後', start_time: '13:00', end_time: '15:45', fixed_target: 0, fixed_start: '', fixed_interval_min: 0 });
  insertZone.run({ store_id: storeId, zone_key: 'ev', label: '夜',   start_time: '17:00', end_time: '22:30', fixed_target: 1, fixed_start: '19:30', fixed_interval_min: 90 });

  // --- メニューマスタ：それまでpublic/index.htmlに直接ハードコードされていた4件を初期データとして投入 ---
  const insertMenu = db.prepare(`
    INSERT INTO menu_items (store_id, category, name, duration_min, price, target, is_active, display_order)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `);
  insertMenu.run(storeId, 'メインメニュー', 'フェイシャル(60分)', 60, 6000, '全員', 1);
  insertMenu.run(storeId, 'メインメニュー', 'フェイシャル(90分)', 90, 8500, '全員', 2);
  insertMenu.run(storeId, 'メインメニュー', 'ボディ(90分)', 90, 9000, '全員', 3);
  insertMenu.run(storeId, 'メインメニュー', 'ハンド(45分)', 45, 4500, '全員', 4);

  // --- 日付ヘルパー -----------------------------------------------------------
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const addDays = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };

  // --- シフトマスタ：今日から14日分、3名分のシフトを投入 -----------------------
  const insertShift = db.prepare(`
    INSERT INTO shift_master (store_id, staff_name, shift_date, start_time, end_time, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  const staffShiftPattern = [
    { name: '寿子', start: '09:30', end: '22:30' }, // オーナーはフル出勤（夜間対応あり）
    { name: '花子', start: '09:30', end: '18:00' }, // 昼〜夕方のみ
    { name: '美咲', start: '13:00', end: '22:30' }  // 午後から夜まで（夜間対応あり）
  ];
  for (let i = 0; i < 14; i++) {
    const dateStr = fmt(addDays(i));
    staffShiftPattern.forEach((s) => {
      // 花子は週2日休みっぽく、7日に1回休みを入れて店休日以外の分岐も試せるようにする
      if (s.name === '花子' && i % 6 === 5) return;
      insertShift.run(storeId, s.name, dateStr, s.start, s.end);
    });
  }

  // --- イベント（店休日）：7日後を「臨時休業」にして「店休」判定を確認できるようにする ---
  const insertEvent = db.prepare(`
    INSERT INTO events (store_id, title, event_date, is_active, start_time, end_time, restrict_booking, block_start_time, block_end_time)
    VALUES (?, ?, ?, 1, ?, ?, 1, ?, ?)
  `);
  const closedDateStr = fmt(addDays(7));
  insertEvent.run(storeId, '臨時休業日', closedDateStr, '09:00', '23:00', '09:00', '23:00');

  // --- 既存予約をいくつか投入 ---------------------------------------------------
  const insertReservation = db.prepare(`
    INSERT INTO reservations
      (store_id, realname, kana, line_name, user_id, staff_name, menu, reservation_date, reservation_time, note, editor, line_sent, done, customer_id, status)
    VALUES
      (@store_id, @realname, @kana, @line_name, @user_id, @staff_name, @menu, @reservation_date, @reservation_time, @note, @editor, 0, 0, @customer_id, '確定')
  `);

  // 4日後（判定対象になる最初の日）の午前枠を花子で1件埋めて「残1」等を確認しやすくする
  const day4 = fmt(addDays(4));
  insertReservation.run({
    store_id: storeId, realname: '田中 美穂', kana: 'タナカ ミホ', line_name: '', user_id: '',
    staff_name: '花子', menu: 'フェイシャル(60分)', reservation_date: day4, reservation_time: '10:00',
    note: '', editor: '寿子', customer_id: 'C0001'
  });
  // 同じ日の花子の枠をもう1件入れて、ほぼ満枠に近い状態を作る
  insertReservation.run({
    store_id: storeId, realname: '佐藤 由紀', kana: 'サトウ ユキ', line_name: '', user_id: '',
    staff_name: '花子', menu: 'フェイシャル(90分)', reservation_date: day4, reservation_time: '11:30',
    note: '', editor: '寿子', customer_id: 'C0002'
  });

  // 5日後の夜間固定枠（寿子・美咲どちらも night_restrict=1）を1枠埋めて「残1」を確認
  const day5 = fmt(addDays(5));
  insertReservation.run({
    store_id: storeId, realname: '鈴木 花', kana: 'スズキ ハナ', line_name: '', user_id: '',
    staff_name: '寿子', menu: 'ボディ(90分)', reservation_date: day5, reservation_time: '19:30',
    note: '', editor: '寿子', customer_id: 'C0003'
  });

  // --- 顧客マスタ（顧客マスタシート相当）：5名分のダミーデータ ------------------
  const insertCustomer = db.prepare(`
    INSERT INTO customers
      (store_id, customer_id, realname, kana, phone, line_name, user_id, birthday, first_visit_date, last_visit_date, total_visits, memo)
    VALUES
      (@store_id, @customer_id, @realname, @kana, @phone, @line_name, @user_id, @birthday, @first_visit_date, @last_visit_date, @total_visits, @memo)
  `);
  insertCustomer.run({ store_id: storeId, customer_id: 'C0001', realname: '田中 美穂', kana: 'タナカ ミホ', phone: '090-1111-2222', line_name: 'みほ', user_id: 'U0001', birthday: '1990-04-12', first_visit_date: fmt(addDays(-200)), last_visit_date: fmt(addDays(-10)), total_visits: 12, memo: '敏感肌。強い圧NG。' });
  insertCustomer.run({ store_id: storeId, customer_id: 'C0002', realname: '佐藤 由紀', kana: 'サトウ ユキ', phone: '090-2222-3333', line_name: 'ゆき', user_id: 'U0002', birthday: '1985-11-02', first_visit_date: fmt(addDays(-150)), last_visit_date: fmt(addDays(-30)), total_visits: 6, memo: '' });
  insertCustomer.run({ store_id: storeId, customer_id: 'C0003', realname: '鈴木 花', kana: 'スズキ ハナ', phone: '090-3333-4444', line_name: 'はな', user_id: 'U0003', birthday: '1993-07-20', first_visit_date: fmt(addDays(-90)), last_visit_date: fmt(addDays(-5)), total_visits: 4, memo: '夜間の予約が多い' });
  insertCustomer.run({ store_id: storeId, customer_id: 'C0004', realname: '高橋 恵子', kana: 'タカハシ ケイコ', phone: '090-4444-5555', line_name: '', user_id: '', birthday: '1978-01-30', first_visit_date: fmt(addDays(-400)), last_visit_date: fmt(addDays(-60)), total_visits: 20, memo: '常連。予約は電話が多い。' });
  insertCustomer.run({ store_id: storeId, customer_id: 'C0005', realname: '山本 かな', kana: 'ヤマモト カナ', phone: '090-5555-6666', line_name: 'かなぴ', user_id: 'U0005', birthday: '2000-09-08', first_visit_date: fmt(addDays(-20)), last_visit_date: fmt(addDays(-20)), total_visits: 1, memo: '新規のお客様' });

  console.log('✅ シードデータ投入完了');
  console.log('   店舗: クラーレ寿 (storeId=1)');
  console.log(`🔑 [開発用] オーナーPIN: ${seededOwnerPin} (store=${storeId}, staff=寿子) ※本番ではこの行は出力しないこと`);
  console.log('   今日: ' + fmt(today));
  console.log('   4日後(' + day4 + ')の午前: 花子に2件予約あり → 空き/残1/満の判定確認用');
  console.log('   5日後(' + day5 + ')の夜間: 寿子19:30に1件予約あり → 固定枠「残1」判定確認用');
  console.log('   7日後(' + closedDateStr + '): 臨時休業日 → 「店休」判定確認用');
}

if (require.main === module) {
  initDatabase();
  console.log('DB初期化が完了しました: ' + (process.env.DB_PATH || 'data/app.db'));
}

module.exports = { initDatabase, seedData };
