// ============================================================================
// lib/reservationEngine.js
//
// GASプロジェクトの reservation_form_functions.js / コード.js にあった
// 予約エンジンのコアロジックを、Node.js（Express + better-sqlite3）に移植したもの。
//
// ★★★ 移植方針 ★★★
// ビジネスロジック（if文の条件分岐・判定順序）は元のGASコードと一切変えていません。
// 変えたのは「データの取得元」だけです：
//   GAS版: SpreadsheetApp.getSheetByName(...).getRange(...).getDisplayValues()
//   → Node版: better-sqlite3 でのSELECTクエリ
//
// 関数名の末尾の "_" はGAS側の private関数の命名規則をそのまま踏襲しています
// （GASでは「_」で終わる関数名は「他ファイルから直接呼ばない内部関数」という慣習）。
//
// 移植元: reservation_form_functions.js の
//   getZoneStatus_ / toMin_ / getBlockedEventSlots_ / getShiftSlots15Min_ /
//   getCustomerStaffList_ / getNightBookedStartTimes_ / generateFixedSlots_ /
//   getBookedSlots90Min_ / getFullyBookedSlots_ / getAvailableStaffCountAtTime_ /
//   generateBlockedSlots_ / generateBlockedSlotsBefore_ / expandRangeToSlots_ /
//   isSameDate_ / getDefaultZones_ / getZonesConfig_ / getTimeSlotsByZone
// および コード.js の getRuleValue_
// ============================================================================

const db = require('./db');

// ----------------------------------------------------------------------------
// toMin_ : 'HH:MM' 形式の時刻文字列を「0時からの経過分」に変換する
//   （GAS版 reservation_form_functions.js の toMin_ をそのまま移植）
// ----------------------------------------------------------------------------
function toMin_(timeStr) {
  const p = String(timeStr).split(':');
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}

// ----------------------------------------------------------------------------
// isSameDate_ : 日付文字列の比較。GAS版は '/' 区切りと '-' 区切りが混在する
//   スプレッドシートの表示値を吸収するために '/' を '-' に正規化して比較していた。
//   Node版でもDBに 'YYYY-MM-DD' で統一して保存する前提だが、
//   ロジックの忠実移植として同じ正規化比較をそのまま残す。
// ----------------------------------------------------------------------------
function isSameDate_(a, b) {
  return String(a).replace(/\//g, '-').trim() === String(b).replace(/\//g, '-').trim();
}

// ----------------------------------------------------------------------------
// expandRangeToSlots_ : シフトの出勤開始〜終了時刻から、
//   「施術90分を開始できる15分刻みの開始時刻一覧」を生成する
//   （終了60分前までではなく、終了時刻から90分を引いた時刻までが最後の開始可能枠）
//   （GAS版をそのまま移植）
// ----------------------------------------------------------------------------
function expandRangeToSlots_(startStr, endStr) {
  const toMin = (t) => { const p = String(t).split(':'); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10); };
  const toStr = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const startMin = toMin(startStr);
  const lastSlot = toMin(endStr) - 90;
  const slots = [];
  for (let m = startMin; m <= lastSlot; m += 15) slots.push(toStr(m));
  return slots;
}

// ----------------------------------------------------------------------------
// generateBlockedSlots_ : ある開始時刻から施術が占有する90分間（15分刻みでslotCount個）
//   の時刻一覧を「開始時刻から後ろ向き」に生成する（GAS版そのまま）
// ----------------------------------------------------------------------------
function generateBlockedSlots_(startTime, slotCount) {
  const parts = String(startTime).split(':');
  let hour = parseInt(parts[0], 10), minute = parseInt(parts[1], 10);
  const slots = [];
  for (let i = 0; i < slotCount; i++) {
    slots.push(String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'));
    minute += 15;
    if (minute >= 60) { minute = 0; hour += 1; }
  }
  return slots;
}

// ----------------------------------------------------------------------------
// generateBlockedSlotsBefore_ : ある開始時刻より「前」の時刻をslotCount個生成する
//   （直前の予約の施術時間が、この枠の開始にかぶって空いていないケースを検出するため）
//   （GAS版そのまま）
// ----------------------------------------------------------------------------
function generateBlockedSlotsBefore_(startTime, slotCount) {
  const parts = String(startTime).split(':');
  let hour = parseInt(parts[0], 10), minute = parseInt(parts[1], 10);
  const slots = [];
  for (let i = 0; i < slotCount; i++) {
    minute -= 15;
    if (minute < 0) { minute = 45; hour -= 1; }
    if (hour < 0) break;
    slots.unshift(String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'));
  }
  return slots;
}

// ----------------------------------------------------------------------------
// generateFixedSlots_ : 固定枠開始・間隔・終了から固定時刻の配列を生成する
//   例: fixedStart='19:30', interval=90, end='22:30' → ['19:30','21:00']
//   施術90分ぶんが end 内に収まる開始時刻のみ採用する（GAS版そのまま）
// ----------------------------------------------------------------------------
function generateFixedSlots_(fixedStart, intervalMin, end) {
  const result = [];
  if (!fixedStart || !intervalMin || intervalMin <= 0) return result;
  const startMin = toMin_(fixedStart);
  const endMin = toMin_(end);
  const SERVICE_MINUTES = 90; // 予約1件が占有する時間
  for (let m = startMin; m + SERVICE_MINUTES <= endMin; m += intervalMin) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    result.push(String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0'));
  }
  return result;
}

// ----------------------------------------------------------------------------
// getRuleValue_ : rule1シート相当の rules テーブルから設定値を取得する
//   （GAS版 コード.js の getRuleValue_ を移植。データ取得元だけSQLiteに変更）
// ----------------------------------------------------------------------------
function getRuleValue_(storeId, ruleId) {
  const row = db.prepare(
    'SELECT value FROM rules WHERE store_id = ? AND rule_id = ?'
  ).get(storeId, ruleId);
  return row ? row.value : null;
}

// ----------------------------------------------------------------------------
// getDefaultZones_ : zonesシートが無い場合に使うデフォルトのゾーン設定
//   （GAS版そのまま。午前／午後／夜の3ゾーン、夜のみ固定90分間隔）
// ----------------------------------------------------------------------------
function getDefaultZones_() {
  return [
    { key: 'am', label: '午前', start: '9:30', end: '12:45', fixedTarget: false, fixedStart: '', fixedInterval: 0 },
    { key: 'pm', label: '午後', start: '13:00', end: '15:45', fixedTarget: false, fixedStart: '', fixedInterval: 0 },
    { key: 'ev', label: '夜', start: '17:00', end: '22:30', fixedTarget: true, fixedStart: '19:30', fixedInterval: 90 }
  ];
}

// ----------------------------------------------------------------------------
// getZonesConfig_ : zones テーブルからゾーン設定を取得する。無ければデフォルトを返す
//   （GAS版 getZonesConfig_ を移植。DisplayValuesの文字列判定 → DBのboolean判定に変更）
// ----------------------------------------------------------------------------
function getZonesConfig_(storeId) {
  try {
    const rows = db.prepare(
      'SELECT * FROM zones WHERE store_id = ? AND is_active = 1 ORDER BY id'
    ).all(storeId);
    if (!rows || rows.length === 0) return getDefaultZones_();
    return rows.map((row) => ({
      key: row.zone_key,
      label: row.label,
      start: row.start_time,
      end: row.end_time,
      fixedTarget: !!row.fixed_target,
      fixedStart: row.fixed_start || '',
      fixedInterval: Number(row.fixed_interval_min) || 0
    }));
  } catch (e) {
    console.log('⚠️ getZonesConfig_ エラー: ' + e.message + '（デフォルト使用）');
    return getDefaultZones_();
  }
}

// ----------------------------------------------------------------------------
// getCustomerStaffList_ : スタッフマスタから「予約対象として表示するスタッフ一覧」を取得
//   （GAS版 getCustomerStaffList_ を移植。
//    元の条件「見習い/サロン端末は除外・row[8]=TRUEのみ・active」を踏襲）
// ----------------------------------------------------------------------------
function getCustomerStaffList_(storeId) {
  const rows = db.prepare(
    'SELECT * FROM staff WHERE store_id = ?'
  ).all(storeId);
  const list = [];
  rows.forEach((row) => {
    const name = row.name, role = row.role, nick = row.nickname;
    const active = !!row.is_active;
    if (!name || role === '見習い' || name === 'サロン端末' || !active) return;
    if (!row.show_in_booking) return;
    list.push({
      id: nick || name,
      name: nick || name,
      realName: name,
      role: role,
      note: role === 'オーナー' ? 'オーナー' : '',
      optSupport: !!row.opt_support,
      nightRestrict: !!row.night_restrict
    });
  });
  return list;
}

// ----------------------------------------------------------------------------
// getShiftSlots15Min_ : 指定スタッフ・指定日の出勤シフトから、
//   「施術を開始できる15分刻みの時刻一覧」を返す
//   （GAS版 getShiftSlots15Min_ を移植。シートの直接読み込み→SQLクエリに変更）
// ----------------------------------------------------------------------------
function getShiftSlots15Min_(storeId, staffName, dateStr) {
  const rows = db.prepare(
    'SELECT staff_name, shift_date, start_time, end_time, is_active FROM shift_master WHERE store_id = ?'
  ).all(storeId);
  const slots = [];
  rows.forEach((row) => {
    if (!row.staff_name || !row.shift_date || !row.start_time || !row.end_time) return;
    if (!isSameDate_(row.shift_date, dateStr)) return;
    if (staffName !== '未定' && row.staff_name !== staffName) return;
    if (!row.is_active) return;
    expandRangeToSlots_(row.start_time, row.end_time).forEach((t) => {
      if (!slots.includes(t)) slots.push(t);
    });
  });
  slots.sort();
  return slots;
}

// ----------------------------------------------------------------------------
// getBookedSlots90Min_ : 指定スタッフ・指定日の「予約によって埋まっている時刻」を返す
//   （前5枠＋当該時刻から6枠 = 施術90分ぶんをブロックする。GAS版そのまま）
// ----------------------------------------------------------------------------
function getBookedSlots90Min_(storeId, staffName, dateStr, excludeId) {
  const rows = db.prepare(
    'SELECT id, realname, staff_name, reservation_date, reservation_time FROM reservations WHERE store_id = ?'
  ).all(storeId);
  const bookedSlots = [];
  rows.forEach((row) => {
    if (excludeId && row.id === excludeId) return;
    if (row.realname === 'キャンセル') return;
    if (!isSameDate_(row.reservation_date, dateStr)) return;
    if (staffName !== '未定' && row.staff_name !== staffName) return;
    const rowTime = row.reservation_time;
    if (rowTime) {
      bookedSlots.push(...generateBlockedSlotsBefore_(rowTime, 5));
      bookedSlots.push(...generateBlockedSlots_(rowTime, 6));
    }
  });
  return Array.from(new Set(bookedSlots));
}

// ----------------------------------------------------------------------------
// getNightBookedStartTimes_ : 夜間固定枠（90分間隔）で「実際に予約が入っている開始時刻」を返す
//   （GAS版そのまま。generateBlockedSlots_のような展開はせず、生の開始時刻のみ）
// ----------------------------------------------------------------------------
function getNightBookedStartTimes_(storeId, staffName, dateStr) {
  const rows = db.prepare(
    'SELECT realname, staff_name, reservation_date, reservation_time FROM reservations WHERE store_id = ?'
  ).all(storeId);
  const times = [];
  rows.forEach((row) => {
    if (row.realname === 'キャンセル') return;
    if (!isSameDate_(row.reservation_date, dateStr)) return;
    if (staffName && row.staff_name !== staffName) return;
    const t = row.reservation_time;
    if (t && !times.includes(t)) times.push(t);
  });
  return times;
}

// ----------------------------------------------------------------------------
// getBlockedEventSlots_ : 店休日・イベントによってブロックされる時刻一覧を返す
//   （GAS版 getBlockedEventSlots_ を移植）
// ----------------------------------------------------------------------------
function getBlockedEventSlots_(storeId, dateStr) {
  const rows = db.prepare(
    'SELECT * FROM events WHERE store_id = ?'
  ).all(storeId);
  const blocked = [];
  rows.forEach((row) => {
    const dateVal = String(row.event_date || '').trim();
    const active = !!row.is_active;
    const startStr = String(row.start_time || '').trim();
    const endStr = String(row.end_time || '').trim();
    const restrict = !!row.restrict_booking;
    const blockStartRaw = String(row.block_start_time || '').trim();
    const blockEndRaw = String(row.block_end_time || '').trim();
    if (!active) return;
    if (!restrict) return;
    if (!isSameDate_(dateVal, dateStr)) return;
    if (!startStr || !endStr) return;
    const blockStartMin = blockStartRaw ? toMin_(blockStartRaw) : Math.max(0, toMin_(startStr) - 90);
    const blockEndMin = blockEndRaw ? toMin_(blockEndRaw) : Math.min(1440, toMin_(endStr) + 60);
    for (let m = blockStartMin; m <= blockEndMin; m += 15) {
      const h = Math.floor(m / 60);
      const min = m % 60;
      const t = String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
      if (!blocked.includes(t)) blocked.push(t);
    }
  });
  return blocked;
}

// ----------------------------------------------------------------------------
// getFullyBookedSlots_ : ベッド数（BED_LIMIT）を超えて埋まっている時刻一覧を返す
//   （GAS版 getFullyBookedSlots_ を移植）
// ----------------------------------------------------------------------------
function getFullyBookedSlots_(storeId, dateStr, excludeId) {
  const bedLimit = Number(getRuleValue_(storeId, 'BED_LIMIT')) || 2;
  const rows = db.prepare(
    'SELECT id, realname, reservation_date, reservation_time FROM reservations WHERE store_id = ?'
  ).all(storeId);
  const slotCount = {};
  rows.forEach((row) => {
    if (excludeId && row.id === excludeId) return;
    if (row.realname === 'キャンセル') return;
    if (!isSameDate_(row.reservation_date, dateStr)) return;
    const rowTime = row.reservation_time;
    if (!rowTime) return;
    generateBlockedSlots_(rowTime, 6).forEach((t) => {
      slotCount[t] = (slotCount[t] || 0) + 1;
    });
  });
  const eventBlocked = getBlockedEventSlots_(storeId, dateStr);
  eventBlocked.forEach((t) => {
    slotCount[t] = (slotCount[t] || 0) + bedLimit;
  });
  const blockedStarts = new Set();
  Object.keys(slotCount).forEach((occupiedSlot) => {
    if (slotCount[occupiedSlot] >= bedLimit) {
      generateBlockedSlotsBefore_(occupiedSlot, 5).forEach((s) => blockedStarts.add(s));
      blockedStarts.add(occupiedSlot);
    }
  });
  return Array.from(blockedStarts);
}

// ----------------------------------------------------------------------------
// getAvailableStaffCountAtTime_ : 指名なし予約用。
//   ある日時に「出勤していて、かつ予約が入っていない」スタッフの人数を数える
//   （GAS版そのまま）
// ----------------------------------------------------------------------------
function getAvailableStaffCountAtTime_(storeId, dateStr, t) {
  const staffList = getCustomerStaffList_(storeId);
  let count = 0;
  staffList.forEach((s) => {
    const shiftSlots = getShiftSlots15Min_(storeId, s.realName, dateStr);
    if (!shiftSlots.includes(t)) return;
    const booked = getBookedSlots90Min_(storeId, s.realName, dateStr, null);
    if (booked.includes(t)) return;
    count++;
  });
  return count;
}

// ----------------------------------------------------------------------------
// getZoneStatus_ : ★予約エンジンの心臓部★
//   指定スタッフ（指名なしなら null）・指定日・指定ゾーンの空き状況を判定して返す。
//   戻り値は次のいずれか： 'ー'（受付対象外）/ 'TEL'（要電話）/ '店休'（休業）/
//                          '満'（満枠）/ '残1'（残り1枠）/ '空き'（余裕あり）
//   （GAS版 reservation_form_functions.js の getZoneStatus_ を一字一句忠実に移植。
//    weekDataキャッシュ機構はGAS版のカレンダー一覧表示高速化用の最適化であり、
//    プロトタイプでは省略し、常に都度DBを読みに行く単純な版のみ実装している。
//    → weekData引数を省略しても判定ロジック自体はGAS版と完全に同一。）
// ----------------------------------------------------------------------------
function getZoneStatus_(storeId, staffName, dateStr, zone) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  const diffDays = Math.round((target - today) / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return 'ー';
  if (diffDays <= 2) return 'TEL';
  const bookingLimit = Number(getRuleValue_(storeId, 'BOOKING_LIMIT_DAYS')) || 49;
  if (diffDays > bookingLimit) return 'ー';

  const eventBlocked = getBlockedEventSlots_(storeId, dateStr);
  const zoneStartMin = toMin_(zone.start);
  const zoneEndMin = toMin_(zone.end);
  const allZoneSlots = [];
  for (let m = zoneStartMin; m <= zoneEndMin; m += 15) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    allZoneSlots.push(String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0'));
  }
  const allBlocked = allZoneSlots.every((t) => eventBlocked.includes(t));
  if (allBlocked) return '店休';

  let slots = [];
  let staffCount = 0;
  if (staffName) {
    slots = getShiftSlots15Min_(storeId, staffName, dateStr);
    staffCount = slots.length > 0 ? 1 : 0;
  } else {
    const staffList = getCustomerStaffList_(storeId);
    staffList.forEach((s) => {
      const sSlots = getShiftSlots15Min_(storeId, s.realName, dateStr);
      const inZone = sSlots.filter((t) => {
        const m = toMin_(t); return m >= zoneStartMin && m <= zoneEndMin;
      });
      if (inZone.length > 0) {
        staffCount++;
        inZone.forEach((t) => { if (!slots.includes(t)) slots.push(t); });
      }
    });
  }
  const zoneSlots = slots.filter((t) => {
    const m = toMin_(t); return m >= zoneStartMin && m <= zoneEndMin;
  });
  if (zoneSlots.length === 0) return '満';

  if (zone.fixedTarget) {
    const staffList = getCustomerStaffList_(storeId);
    const hasNightRestrict = staffName
      ? staffList.some((s) => s.realName === staffName && s.nightRestrict)
      : staffList.some((s) => s.nightRestrict);
    if (hasNightRestrict) {
      const nightStaffNames = staffList.filter((s) => s.nightRestrict).map((s) => s.realName);
      const bookedTimes = [];
      nightStaffNames.forEach((name) => {
        getNightBookedStartTimes_(storeId, name, dateStr).forEach((t) => {
          if (!bookedTimes.includes(t)) bookedTimes.push(t);
        });
      });
      const fixedSlots = generateFixedSlots_(zone.fixedStart, zone.fixedInterval, zone.end)
        .filter((t) => !eventBlocked.includes(t));
      const available = fixedSlots.filter((t) => !bookedTimes.includes(t));
      if (available.length === 0) return '満';
      if (available.length === 1) return '残1';
      return '空き';
    }
  }

  const fullyBooked = getFullyBookedSlots_(storeId, dateStr, null);
  const bookedByStaff = staffName ? getBookedSlots90Min_(storeId, staffName, dateStr, null) : [];
  let available = 0;
  zoneSlots.forEach((t) => {
    if (!t.endsWith(':00') && !t.endsWith(':30')) return;
    if (fullyBooked.includes(t)) return;
    if (bookedByStaff.includes(t)) return;
    if (eventBlocked.includes(t)) return;
    if (!staffName && getAvailableStaffCountAtTime_(storeId, dateStr, t) === 0) return;
    available++;
  });
  if (available === 0) return '満';

  if (!staffName && staffCount === 1) return '残1';

  if (available === 1) return '残1';
  return '空き';
}

// ----------------------------------------------------------------------------
// getTimeSlotsByZone : 指定ゾーン内で実際に予約可能な時刻一覧を返す（お客様画面の時刻選択用）
//   （GAS版 getTimeSlotsByZone を移植。3日前締め切りルールもそのまま踏襲）
// ----------------------------------------------------------------------------
function getTimeSlotsByZone(storeId, staffId, dateStr, zoneKey) {
  const staffList = getCustomerStaffList_(storeId);
  const staffName = staffId === 'nopref'
    ? null
    : ((staffList.find((s) => s.id === staffId) || {}).realName || staffId);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const minDate = new Date(today); minDate.setDate(today.getDate() + 3);
  if (new Date(dateStr + 'T00:00:00') < minDate) return [];

  const zone = getZonesConfig_(storeId).find((z) => z.key === zoneKey);
  if (!zone) return [];

  let slots = [];
  if (staffName) {
    slots = getShiftSlots15Min_(storeId, staffName, dateStr);
  } else {
    staffList.forEach((s) => {
      getShiftSlots15Min_(storeId, s.realName, dateStr).forEach((t) => {
        if (!slots.includes(t)) slots.push(t);
      });
    });
    slots.sort();
  }
  const zoneStart = toMin_(zone.start);
  const zoneEnd = toMin_(zone.end);
  let zoneSlots = slots.filter((t) => {
    const m = toMin_(t); return m >= zoneStart && m <= zoneEnd;
  });
  const eventBlocked = getBlockedEventSlots_(storeId, dateStr);
  zoneSlots = zoneSlots.filter((t) => !eventBlocked.includes(t));
  if (zoneSlots.length === 0) return [];

  const hasNightRestrict = staffId === 'nopref'
    ? staffList.some((s) => s.nightRestrict)
    : staffList.some((s) => s.id === staffId && s.nightRestrict);
  if (zone.fixedTarget && hasNightRestrict) {
    const nightFixedSlots = generateFixedSlots_(zone.fixedStart, zone.fixedInterval, zone.end);
    zoneSlots = zoneSlots.filter((t) => nightFixedSlots.includes(t));
    const nightStaffNames = staffList.filter((s) => s.nightRestrict).map((s) => s.realName);
    const bookedTimes = [];
    nightStaffNames.forEach((name) => {
      getNightBookedStartTimes_(storeId, name, dateStr).forEach((t) => {
        if (!bookedTimes.includes(t)) bookedTimes.push(t);
      });
    });
    return zoneSlots.map((t) => ({ time: t, disabled: bookedTimes.includes(t) }));
  }

  zoneSlots = zoneSlots.filter((t) => t.endsWith(':00') || t.endsWith(':30'));
  const fullyBooked = getFullyBookedSlots_(storeId, dateStr, null);
  const bookedByStaff = staffName ? getBookedSlots90Min_(storeId, staffName, dateStr, null) : [];
  return zoneSlots.map((t) => {
    if (bookedByStaff.includes(t)) return { time: t, disabled: true };
    if (fullyBooked.includes(t)) return { time: t, disabled: true };
    if (!staffName && getAvailableStaffCountAtTime_(storeId, dateStr, t) === 0) return { time: t, disabled: true };
    return { time: t, disabled: false };
  });
}

// ----------------------------------------------------------------------------
// checkCustomerReservationLimit : 同一顧客の確定予約が上限件数を超えていないか判定する
//   （GAS版 checkCustomerReservationLimit を移植）
// ----------------------------------------------------------------------------
function checkCustomerReservationLimit(storeId, realname, excludeId) {
  const maxCount = Number(getRuleValue_(storeId, 'MAX_RESERVATIONS_PER_CUSTOMER')) || 3;
  const rows = db.prepare(
    'SELECT id, realname, status, reservation_date FROM reservations WHERE store_id = ?'
  ).all(storeId);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let count = 0;
  rows.forEach((row) => {
    if (excludeId && row.id === excludeId) return;
    if (row.realname === 'キャンセル') return;
    if (row.status === '仮予約') return;
    const reservDate = new Date(String(row.reservation_date).replace(/\//g, '-') + 'T00:00:00');
    if (reservDate < today) return;
    if (row.realname === realname) count++;
  });
  return { count: count, limit: maxCount, exceeded: count >= maxCount };
}

// ----------------------------------------------------------------------------
// generateAllDaySlots_ : 09:00〜22:30の全時間帯（15分刻み、22時台のみ0分・30分）を返す
//   （GAS版 generateAllDaySlots_ そのまま。オーナー向けの「全時間帯表示」に使う）
// ----------------------------------------------------------------------------
function generateAllDaySlots_() {
  const slots = [];
  for (let h = 9; h <= 22; h++) {
    const minutes = (h === 22) ? [0, 30] : [0, 15, 30, 45];
    minutes.forEach((m) => {
      slots.push(String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'));
    });
  }
  return slots;
}

// ----------------------------------------------------------------------------
// ★2026-09-23追加：getAvailableSlots_ : スタッフ／オーナー向けの予約登録・編集画面
//   から「🔍空き時間を確認する」で呼び出す（GAS版reservation_form_functions.gs
//   getAvailableSlots相当）。一般スタッフには実際に空いている枠だけを返し（埋まって
//   いる理由付き）、オーナーには全時間帯を返して警告ラベル付きで選ばせる（README
//   §51-7で見送っていたもの）。
// ----------------------------------------------------------------------------
function getAvailableSlots_(storeId, staffName, dateStr, excludeId, isOwner) {
  const eventBlocked = getBlockedEventSlots_(storeId, dateStr);
  const fullyBooked = getFullyBookedSlots_(storeId, dateStr, excludeId);
  const rawSlots = getShiftSlots15Min_(storeId, staffName, dateStr);

  if (isOwner) {
    const allSlots = generateAllDaySlots_();
    const bookedAll = getBookedSlots90Min_(storeId, staffName, dateStr, excludeId);
    return allSlots.map((time) => {
      if (bookedAll.includes(time)) {
        return { time, disabled: false, warn: true, warnLabel: '予約済み' };
      }
      if (eventBlocked.includes(time)) {
        return { time, disabled: false, warn: true, warnLabel: 'イベント' };
      }
      if (fullyBooked.includes(time)) {
        return { time, disabled: false, warn: true, warnLabel: '満床' };
      }
      if (!rawSlots.includes(time)) {
        return { time, disabled: false, warn: true, warnLabel: 'シフト外' };
      }
      return { time, disabled: false };
    });
  }

  const OWNER_ONLY_SLOTS = ['09:00', '09:15'];
  const slots = rawSlots.filter((t) => !OWNER_ONLY_SLOTS.includes(t));
  if (!slots || slots.length === 0) {
    return [{ time: '', disabled: true, reason: 'この日はお休みです' }];
  }

  let bookedByStaff = [];
  if (staffName && staffName !== '未定') {
    bookedByStaff = getBookedSlots90Min_(storeId, staffName, dateStr, excludeId);
  } else {
    getCustomerStaffList_(storeId).forEach((s) => {
      getBookedSlots90Min_(storeId, s.realName, dateStr, excludeId).forEach((t) => {
        if (!bookedByStaff.includes(t)) bookedByStaff.push(t);
      });
    });
  }

  return slots.map((t) => {
    if (bookedByStaff.includes(t)) {
      return { time: t, disabled: true, reason: '担当スタッフが予約済み' };
    }
    if (eventBlocked.includes(t)) {
      return { time: t, disabled: true, reason: 'イベントのため予約制限中' };
    }
    if (fullyBooked.includes(t)) {
      return { time: t, disabled: true, reason: '満床' };
    }
    return { time: t, disabled: false };
  });
}

module.exports = {
  toMin_,
  isSameDate_,
  expandRangeToSlots_,
  generateBlockedSlots_,
  generateBlockedSlotsBefore_,
  generateFixedSlots_,
  generateAllDaySlots_,
  getRuleValue_,
  getDefaultZones_,
  getZonesConfig_,
  getCustomerStaffList_,
  getShiftSlots15Min_,
  getBookedSlots90Min_,
  getNightBookedStartTimes_,
  getBlockedEventSlots_,
  getFullyBookedSlots_,
  getAvailableStaffCountAtTime_,
  getZoneStatus_,
  getTimeSlotsByZone,
  checkCustomerReservationLimit,
  getAvailableSlots_
};
