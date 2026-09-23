// ============================================================================
// lib/maintenance.js
// ★2026-09-23追加：日次メンテナンス処理（GAS版コード.gs dailyProcessAll_の一部移植）の
//   本体部分を server.js の POST /api/admin/maintenance/run-daily から切り出したもの。
//
// 【切り出した理由】lib/scheduler.js（常設スケジューラ）が、HTTPリクエスト（req/res）
//   無しでこの処理を直接呼び出せるようにするため。オーナー管理画面の手動実行ボタンと
//   常設スケジューラの自動実行の両方から、同じ関数を呼ぶことでロジックの重複・
//   将来的な実装の乖離を防ぐ。
//
//   ①実行済み（施術完了）フラグの自動更新②来店回数の再集計③古いキャンセル予約の削除
//   ④シフトの自動展開⑤古いシフトの削除。詳細はREADME_PROTOTYPE.md章50-2参照。
// ============================================================================

function fmtDate(d) {
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function runDailyMaintenance(db, engine, storeId) {
  const todayStr = fmtDate(new Date());

  // ① 実行済み（施術完了）フラグの自動更新
  const executedResult = db.prepare(`
    UPDATE reservations SET done = 1, updated_at = CURRENT_TIMESTAMP
    WHERE store_id = ? AND realname != 'キャンセル' AND done = 0 AND reservation_date < ?
  `).run(storeId, todayStr);
  const executedUpdated = executedResult.changes;

  // ② 来店回数の再集計（customer_idごとに完了予約件数を数え、現在値より大きい場合のみ更新）
  const counts = db.prepare(`
    SELECT customer_id, COUNT(*) AS c FROM reservations
    WHERE store_id = ? AND realname != 'キャンセル' AND done = 1 AND customer_id IS NOT NULL AND customer_id != ''
    GROUP BY customer_id
  `).all(storeId);
  let visitsUpdated = 0;
  const updateVisit = db.prepare(`
    UPDATE customers SET total_visits = ?, updated_at = CURRENT_TIMESTAMP
    WHERE store_id = ? AND customer_id = ? AND total_visits < ?
  `);
  counts.forEach((row) => {
    const result = updateVisit.run(row.c, storeId, row.customer_id, row.c);
    if (result.changes > 0) visitsUpdated++;
  });

  // ③ 古いキャンセル予約の削除（CANCEL_DELETE_DAYSより前のキャンセル予約を物理削除）
  const cancelDeleteDays = Number(engine.getRuleValue_(storeId, 'CANCEL_DELETE_DAYS')) || 60;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - cancelDeleteDays);
  const cutoffStr = fmtDate(cutoffDate);
  const deletedResult = db.prepare(`
    DELETE FROM reservations WHERE store_id = ? AND realname = 'キャンセル' AND reservation_date < ?
  `).run(storeId, cutoffStr);
  const cancelledDeleted = deletedResult.changes;

  // ④ シフトの自動展開（[今日, 今日+SHIFT_EXPAND_DAYS] の期間全体をshift_masterへ
  //   一括展開。「祝」パターンはevents側の予約制限ありの日付を優先。詳細はserver.jsの
  //   旧コメント（README §50-2・§51-7）参照）
  const shiftExpandDays = Number(engine.getRuleValue_(storeId, 'SHIFT_EXPAND_DAYS')) || 49;
  const rangeStart = new Date();
  const rangeDates = [];
  for (let i = 0; i <= shiftExpandDays; i++) {
    const d = new Date(rangeStart);
    d.setDate(d.getDate() + i);
    rangeDates.push({ str: fmtDate(d), dow: d.getDay() });
  }
  const targetDateStr = rangeDates.length ? rangeDates[rangeDates.length - 1].str : todayStr;
  const templatesByDow = db.prepare(`
    SELECT staff_name, day_of_week, start_time, end_time FROM shift_templates
    WHERE store_id = ? AND is_active = 1
  `).all(storeId);
  const templateMap = new Map();
  templatesByDow.forEach((t) => {
    if (!templateMap.has(t.day_of_week)) templateMap.set(t.day_of_week, []);
    templateMap.get(t.day_of_week).push(t);
  });
  const holidayRows = db.prepare(`
    SELECT event_date FROM events WHERE store_id = ? AND is_active = 1 AND restrict_booking = 1
  `).all(storeId);
  const holidaySet = new Set(holidayRows.map((r) => r.event_date));
  const insertShiftFromTemplate = db.prepare(`
    INSERT INTO shift_master (store_id, staff_name, shift_date, start_time, end_time, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  const staffHasAnyShiftOnDate = db.prepare(`
    SELECT 1 FROM shift_master WHERE store_id = ? AND staff_name = ? AND shift_date = ?
  `);
  let shiftsExpanded = 0;
  let daysBackfilled = 0;
  rangeDates.forEach(({ str: dateStr, dow }) => {
    const effectiveDow = holidaySet.has(dateStr) ? 7 : dow;
    const tpls = templateMap.get(effectiveDow) || [];
    let addedThisDay = 0;
    tpls.forEach((t) => {
      if (staffHasAnyShiftOnDate.get(storeId, t.staff_name, dateStr)) return;
      insertShiftFromTemplate.run(storeId, t.staff_name, dateStr, t.start_time, t.end_time);
      shiftsExpanded++;
      addedThisDay++;
    });
    if (addedThisDay > 0) daysBackfilled++;
  });

  // ⑤ 古いシフトの削除（7日より前のshift_master行を物理削除）
  const shiftCutoff = new Date();
  shiftCutoff.setDate(shiftCutoff.getDate() - 7);
  const shiftCutoffStr = fmtDate(shiftCutoff);
  const shiftDeletedResult = db.prepare(`
    DELETE FROM shift_master WHERE store_id = ? AND shift_date < ?
  `).run(storeId, shiftCutoffStr);
  const oldShiftsDeleted = shiftDeletedResult.changes;

  return {
    success: true,
    today: todayStr,
    executedUpdated,
    visitsUpdated,
    customersChecked: counts.length,
    cancelledDeleted,
    cancelDeleteDays,
    shiftsExpanded,
    daysBackfilled,
    shiftExpandDays,
    shiftExpandTargetDate: targetDateStr,
    oldShiftsDeleted
  };
}

module.exports = { runDailyMaintenance };
