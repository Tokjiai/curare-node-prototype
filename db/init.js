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
const { runMigrations } = require('../lib/migrate');

function initDatabase() {
  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schemaSql);
  // ★2026-09-19追加：CREATE TABLE IF NOT EXISTSは「テーブルが既にある場合」には
  //   新しい列を追加してくれないため、後から追加された列を補うマイグレーションを
  //   必ず実行しておく（詳細はlib/migrate.jsのコメント参照）。
  runMigrations(db);
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
    DELETE FROM booking_notices;
    DELETE FROM staff;
    DELETE FROM stores;
  `);

  const insertStore = db.prepare('INSERT INTO stores (id, slug, name, phone) VALUES (?, ?, ?, ?)');
  insertStore.run(1, 'kurare-kotobuki', 'クラーレ寿', '097-000-0000');
  const storeId = 1;

  // --- 受付ルール・注意書き（★2026-09-20追加：デモ用の初期値） -------------
  //   GAS版rule2シートのNOTICE行に相当。実際の文言はオーナーが店舗設定画面から
  //   いつでも追加・編集できる（ここではデモ用サンプルを投入しているだけ）。
  const insertNotice = db.prepare(`
    INSERT INTO booking_notices (store_id, target, text, is_active) VALUES (?, ?, ?, 1)
  `);
  insertNotice.run(storeId, '全員', '当日キャンセルの場合はお早めにお電話にてご連絡ください。');
  insertNotice.run(storeId, '初回', '初めてご来店の方は、ご予約時間の10分前を目安にお越しください。');
  // ★2026-09-23追加：GAS版getRule2Notices_のリピーター向け出し分けを、お客様予約フォーム
  //   で実際にテストできるようにするための注意書きサンプル
  insertNotice.run(storeId, 'リピーター', 'いつもご利用ありがとうございます。メンバー特典メニューもぜひご覧ください。');

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
  insertRule.run(storeId, 'CANCEL_DELETE_DAYS', 'キャンセル済み予約を自動削除するまでの日数', '60');
  insertRule.run(storeId, 'SHIFT_EXPAND_DAYS', 'シフトを何日先まで自動展開するか', '49');
  insertRule.run(storeId, 'UPCOMING_RESERVATION_DAYS', 'スタッフダッシュボードの「直近の予約」に表示する日数', '15');

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
  // ★2026-09-20追加：オプションメニュー（メインメニューとは別枠で複数追加できる項目）の
  //   サンプルを投入。お客様予約フォーム側でチェックボックス表示・合計金額計算の
  //   デモができるようにするため
  insertMenu.run(storeId, '施術系オプション', 'かっさオプション', 15, 1650, '全員', 5);
  insertMenu.run(storeId, 'オプション', 'ハンドパック', 10, 1000, '全員', 6);
  // ★2026-09-23追加：GAS版getCustomerMenuList_のtgt列（'初回'／'キープメンバー'）による
  //   出し分けを、お客様予約フォームで実際にテストできるようにするためのサンプルメニュー
  insertMenu.run(storeId, 'メインメニュー', '初回限定フェイシャル体験(60分)', 60, 3900, '初回', 7);
  insertMenu.run(storeId, 'メインメニュー', 'メンバーコース(90分)', 90, 7000, 'キープメンバー', 8);

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

  // --- シフト初期値（曜日パターン）：寿子は月〜土フル出勤、花子は火〜土の昼〜夕方 ---
  const insertShiftTemplate = db.prepare(`
    INSERT INTO shift_templates (store_id, staff_name, day_of_week, start_time, end_time, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  for (let dow = 1; dow <= 6; dow++) { // 1=月〜6=土
    insertShiftTemplate.run(storeId, '寿子', dow, '09:30', '22:30');
    if (dow !== 1) insertShiftTemplate.run(storeId, '花子', dow, '09:30', '18:00'); // 月休み
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
      (store_id, customer_id, realname, kana, phone, line_name, user_id, birthday, first_visit_date, last_visit_date, total_visits, memo, info_confirmed)
    VALUES
      (@store_id, @customer_id, @realname, @kana, @phone, @line_name, @user_id, @birthday, @first_visit_date, @last_visit_date, @total_visits, @memo, 1)
  `);
  // ★2026-09-23追加：既存の来店実績があり氏名・電話番号も揃っている顧客なので、お客様
  //   予約フォームの新規登録画面（48-10）は不要＝info_confirmed（登録確定フラグ）を1にする
  insertCustomer.run({ store_id: storeId, customer_id: 'C0001', realname: '田中 美穂', kana: 'タナカ ミホ', phone: '090-1111-2222', line_name: 'みほ', user_id: 'U0001', birthday: '1990-04-12', first_visit_date: fmt(addDays(-200)), last_visit_date: fmt(addDays(-10)), total_visits: 12, memo: '敏感肌。強い圧NG。' });
  insertCustomer.run({ store_id: storeId, customer_id: 'C0002', realname: '佐藤 由紀', kana: 'サトウ ユキ', phone: '090-2222-3333', line_name: 'ゆき', user_id: 'U0002', birthday: '1985-11-02', first_visit_date: fmt(addDays(-150)), last_visit_date: fmt(addDays(-30)), total_visits: 6, memo: '' });
  insertCustomer.run({ store_id: storeId, customer_id: 'C0003', realname: '鈴木 花', kana: 'スズキ ハナ', phone: '090-3333-4444', line_name: 'はな', user_id: 'U0003', birthday: '1993-07-20', first_visit_date: fmt(addDays(-90)), last_visit_date: fmt(addDays(-5)), total_visits: 4, memo: '夜間の予約が多い' });
  insertCustomer.run({ store_id: storeId, customer_id: 'C0004', realname: '高橋 恵子', kana: 'タカハシ ケイコ', phone: '090-4444-5555', line_name: '', user_id: '', birthday: '1978-01-30', first_visit_date: fmt(addDays(-400)), last_visit_date: fmt(addDays(-60)), total_visits: 20, memo: '常連。予約は電話が多い。' });
  insertCustomer.run({ store_id: storeId, customer_id: 'C0005', realname: '山本 かな', kana: 'ヤマモト カナ', phone: '090-5555-6666', line_name: 'かなぴ', user_id: 'U0005', birthday: '2000-09-08', first_visit_date: fmt(addDays(-20)), last_visit_date: fmt(addDays(-20)), total_visits: 1, memo: '新規のお客様' });

  // ★2026-09-23追加：お客様予約フォームのキープメンバー／初めての方／既存お客様（キープ以外）
  //   3区分の出し分け機能を、社長が実際にブラウザで直接テストできるようにするための専用データ。
  //   通常の顧客マスタ更新（キープ判定・最終来店スタッフの自動更新等）はまだ別機能側の対応
  //   予定のため、is_keep_member／staff_name（前回担当）はここで直接シードする。
  const insertCustomerFull = db.prepare(`
    INSERT INTO customers
      (store_id, customer_id, realname, kana, phone, line_name, user_id, birthday, first_visit_date, last_visit_date, total_visits, memo, is_keep_member, staff_name, booking_blocked, status, address, info_confirmed, keep_member_requested)
    VALUES
      (@store_id, @customer_id, @realname, @kana, @phone, @line_name, @user_id, @birthday, @first_visit_date, @last_visit_date, @total_visits, @memo, @is_keep_member, @staff_name, @booking_blocked, @status, @address, @info_confirmed, @keep_member_requested)
  `);
  // C0006：キープメンバー（来店実績あり・前回担当＝花子）→ お客様フォームで花子を指名すると
  //   即「確定」・pinkテーマ・メンバー限定メニューが見える想定。登録済みなのでinfo_confirmed=1
  insertCustomerFull.run({ store_id: storeId, customer_id: 'C0006', realname: '中村 さゆり', kana: 'ナカムラ サユリ', phone: '090-6666-7777', line_name: 'さゆり', user_id: 'U0006', birthday: '1988-03-15', first_visit_date: fmt(addDays(-300)), last_visit_date: fmt(addDays(-15)), total_visits: 15, memo: 'キープメンバー（テスト用）', is_keep_member: 1, staff_name: '花子', booking_blocked: 0, status: 'active', address: '大分県大分市中央町1-2-3', info_confirmed: 1, keep_member_requested: 0 });
  // ★2026-09-23修正：以前は「初めての方」なのに氏名・電話番号が最初から顧客マスタに
  //   入っている不自然なデータだった（社長よりご指摘）。GAS版の実際の仕組み
  //   （webhook_handler.js registerOrUpdateCustomerFromLine_body_）では、LINE友だち追加時点
  //   では顧客IDとLINE表示名だけが発行され、本名・電話番号はまだ空欄（statusも'inactive'）
  //   のまま。本名が確定するのは、お客様がご自身でフォームに入力する（今回未実装の
  //   registerNewCustomer相当。README章48-8参照）か、来店後にスタッフが手動編集した時点。
  //   このテストデータもその状態を正しく再現した（realname/kana/phoneは空、line_nameのみ設定）。
  // C0007：初めての方（LINE友だち追加のみ・来店実績0・本名未確定）→ greenテーマ・
  //   初回おすすめメニューにバッジが付く想定。お名前欄はロックされず自分で入力できる。
  //   info_confirmed=0（住所・氏名未入力）なので、お客様予約フォームで新規登録画面（48-10）が出る
  insertCustomerFull.run({ store_id: storeId, customer_id: 'C0007', realname: '', kana: '', phone: '', line_name: 'あやか', user_id: 'U0007', birthday: '', first_visit_date: '', last_visit_date: '', total_visits: 0, memo: '初めての方（LINE友だち追加のみ・本名未確定、テスト用）', is_keep_member: 0, staff_name: '', booking_blocked: 0, status: 'inactive', address: '', info_confirmed: 0, keep_member_requested: 0 });
  // C0008：既存のお客様（来店実績あり）だがキープメンバーではない → greenテーマ・
  //   担当者を指名しても「仮予約」扱いになる想定。登録済み（info_confirmed=1）かつ、
  //   「キープメンバーへの変更希望」を既に申告済み（keep_member_requested=1）というデモケース
  //   ＝オーナー管理画面「顧客管理」で申告バッジ／承認待ちの表示を確認できるようにする
  insertCustomerFull.run({ store_id: storeId, customer_id: 'C0008', realname: '渡辺 みゆき', kana: 'ワタナベ ミユキ', phone: '090-8888-9999', line_name: 'みゆき', user_id: 'U0008', birthday: '1995-06-25', first_visit_date: fmt(addDays(-60)), last_visit_date: fmt(addDays(-25)), total_visits: 3, memo: '既存のお客様・キープ以外（テスト用）', is_keep_member: 0, staff_name: '', booking_blocked: 0, status: 'active', address: '大分県大分市府内町4-5-6', info_confirmed: 1, keep_member_requested: 1 });

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
