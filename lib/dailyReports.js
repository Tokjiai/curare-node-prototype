// ============================================================================
// lib/dailyReports.js
// ★2026-09-23追加：GAS版 reservation_form_functions.js の日次LINEレポート4関数
//   （sendDayBeforeReminders / sendMorningReportToOwner / sendEveningReportToOwner /
//   sendStaffTomorrowSchedule_）の移植。
//
// 【位置づけ】GAS版は時間主導トリガー（毎日決まった時刻に自動実行）で動いていたが、
//   このプロトタイプはRenderの無料枠で動いており常駐スケジューラ（node-cron等）を
//   まだ用意していないため、既存の日次メンテナンス（POST /api/admin/maintenance/run-daily）
//   と同じ方針で、オーナー管理画面から手動実行できるボタンとして再現する
//   （本番運用では別途スケジューラの整備が必要。README明記）。
//
// 【送信先の考え方】
//   GAS版はConfig値OWNER_LINE_USER_ID（店舗設定に保存した1つのLINE userId）を
//   オーナー宛の送信先としていたが、Node版はstaff.is_ownerフラグを既に「誰が
//   オーナーか」の判定に使っているため、そちらに統一する（is_owner=1かつ
//   line_user_id設定済みのスタッフ全員に送る。通常は1名）。
//
//   スタッフ向け（翌日予約通知）はGAS版と同じくstaff.line_user_idを使う
//   （スタッフLINE ID自動登録機能＝routes/lineWebhook.jsのhandleStaffPinRegistration
//   で登録された値）。
//
//   送信トークンはstores.line_staff_channel_token（2026-09-23追加、プッシュ送信専用。
//   line_staff_channel_secretはWebhook署名検証専用で流用不可）を使う。未設定の場合は
//   lib/lineClient.jsのpushMessage()が自動的に「シミュレーションのみ」動作になる
//   （実送信は行わずコンソールログのみ）。お客様向けチャネル同様、プラン
//   （hasFeature(plan,'lineNotify')）がfalseの店舗も常にシミュレーション扱いにする。
// ============================================================================

const { pushMessage } = require('./lineClient');
const { hasFeature } = require('./plans');
const { getMessageTemplate, renderMessageBody } = require('./messageTemplates');

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayStr() { return fmtDate(new Date()); }
function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return fmtDate(d);
}

function getStaffChannelToken(db, storeId) {
  const store = db.prepare('SELECT plan, line_staff_channel_token FROM stores WHERE id = ?').get(storeId);
  if (!store) return null;
  if (!hasFeature(store.plan, 'lineNotify')) return null; // ★プラン非対応は常にシミュレーション扱い
  return store.line_staff_channel_token || null;
}

function getOwnerLineTargets(db, storeId) {
  return db.prepare(`
    SELECT id, name, line_user_id FROM staff
    WHERE store_id = ? AND is_owner = 1 AND is_active = 1 AND line_user_id IS NOT NULL AND line_user_id != ''
  `).all(storeId);
}

// ----------------------------------------------------------------------------
// sendMorningReportToOwner(db, storeId)：GAS版sendMorningReportToOwner相当
//   本日の予約状況（時刻・氏名・担当・メニュー・確定/仮予約・リマインド送付済み
//   フラグ）をオーナー宛に一覧で送る。
// ----------------------------------------------------------------------------
function buildMorningReportText(db, storeId, dateStr) {
  const rows = db.prepare(`
    SELECT reservation_time, realname, staff_name, menu, status, reminder_sent, user_id
    FROM reservations
    WHERE store_id = ? AND realname != 'キャンセル' AND reservation_date = ?
    ORDER BY reservation_time ASC
  `).all(storeId, dateStr);

  let message = `【本日の予約状況】${dateStr}\n━━━━━━━━━━━━\n`;
  if (rows.length === 0) {
    message += '本日の予約はありません。\n';
  } else {
    rows.forEach((r) => {
      const reminderMark = r.user_id ? (r.reminder_sent ? '🔔送信済' : '⚪未送信') : '➖LINE無';
      const statusMark = r.status === '仮予約' ? '⚠️仮予約' : '✅確定';
      message += `${r.reservation_time} ${r.realname}様\n`;
      message += `  担当：${r.staff_name} / ${r.menu || ''}\n`;
      message += `  ${statusMark} / リマインド：${reminderMark}\n`;
    });
  }
  message += `━━━━━━━━━━━━\n合計：${rows.length}件`;
  return { message, count: rows.length };
}

async function sendMorningReportToOwner(db, storeId) {
  const dateStr = todayStr();
  const { message, count } = buildMorningReportText(db, storeId, dateStr);
  const token = getStaffChannelToken(db, storeId);
  const targets = getOwnerLineTargets(db, storeId);
  if (targets.length === 0) {
    return { success: true, date: dateStr, reservationCount: count, sentTo: 0, results: [], message: 'オーナー宛LINE userIdが未登録のため送信対象がいません（スタッフ管理画面でLINE連携状況を確認してください）' };
  }
  const results = [];
  for (const t of targets) {
    const r = await pushMessage(token, t.line_user_id, message);
    results.push({ staffName: t.name, ...r });
  }
  return { success: true, date: dateStr, reservationCount: count, sentTo: targets.length, results };
}

// ----------------------------------------------------------------------------
// sendEveningReportToOwner(db, storeId)：GAS版sendEveningReportToOwner相当
//   ①本日確定した予約・要確認リクエスト（お客様予約フォーム経由の仮予約）②未確定の
//   仮予約一覧③スタッフ翌日予約通知（GAS版の「相乗り」呼び出しをそのまま踏襲）、
//   の3種類を送る。GAS版と同じく、①②③のいずれかが失敗しても他は続行する
//   （GAS版は関数内でtry/catchを3つに分けていた設計を踏襲）。
// ----------------------------------------------------------------------------
function buildEveningReportText(db, storeId, dateStr) {
  const rows = db.prepare(`
    SELECT realname, staff_name, menu, reservation_date, reservation_time, status, editor, user_id, created_at
    FROM reservations
    WHERE store_id = ? AND realname != 'キャンセル'
  `).all(storeId);

  const newConfirmed = [];
  const newRequests = [];
  rows.forEach((r) => {
    const isFromCustomerForm = r.editor === 'お客様フォーム';
    // ★GAS版はhist1（変更履歴）の先頭日時で「本日変更されたか」を判定していたが、
    //   Node版にはhist1相当の列が無いため、created_at（作成日時）の日付部分で代用する
    //   （このプロトタイプは変更履歴を別途保持していないため、「本日新規作成」＝
    //   「本日確定」に近似。GAS版ほど厳密に「本日中に確定操作された」までは検出できない）。
    const createdDatePart = String(r.created_at || '').slice(0, 10);
    if (isFromCustomerForm && r.status === '仮予約') {
      newRequests.push(r);
      return;
    }
    if (createdDatePart === dateStr && r.status !== '仮予約') {
      newConfirmed.push(r);
    }
  });

  let message = `【本日の新規予約・リクエスト】${dateStr}\n━━━━━━━━━━━━\n`;
  message += `📋 本日確定した予約：${newConfirmed.length}件\n`;
  newConfirmed.forEach((r) => {
    message += `・${r.reservation_date} ${r.reservation_time} ${r.realname}様\n`;
    message += `  担当：${r.staff_name} / ${r.menu || ''}\n`;
  });
  message += `\n⚠️ 要確認リクエスト：${newRequests.length}件\n`;
  newRequests.forEach((r) => {
    message += `・${r.reservation_date} ${r.reservation_time} ${r.realname}様\n`;
    message += `  担当：${r.staff_name} / ${r.menu || ''}\n`;
    message += `  ${r.user_id ? '📱LINE有' : '❌LINE無'}\n`;
  });
  message += '━━━━━━━━━━━━';
  return { message, newConfirmedCount: newConfirmed.length, newRequestsCount: newRequests.length };
}

function getPendingProvisionalReservations(db, storeId) {
  return db.prepare(`
    SELECT realname, staff_name, menu, reservation_date, reservation_time
    FROM reservations
    WHERE store_id = ? AND realname != 'キャンセル' AND status = '仮予約'
    ORDER BY reservation_date ASC, reservation_time ASC
  `).all(storeId);
}

function buildPendingProvisionalText(list) {
  let message = `⏳ 未確定の仮予約：${list.length}件\n━━━━━━━━━━━━\n`;
  list.forEach((r) => {
    message += `・${r.reservation_date} ${r.reservation_time} ${r.realname}様\n`;
    message += `  担当：${r.staff_name} ／ ${r.menu || ''}\n`;
  });
  message += '━━━━━━━━━━━━';
  return message;
}

async function sendEveningReportToOwner(db, storeId) {
  const dateStr = todayStr();
  const token = getStaffChannelToken(db, storeId);
  const targets = getOwnerLineTargets(db, storeId);
  const out = { success: true, date: dateStr, mainReport: null, pendingReport: null, staffSchedule: null };

  // ①本日確定した予約・要確認リクエスト
  try {
    const { message, newConfirmedCount, newRequestsCount } = buildEveningReportText(db, storeId, dateStr);
    const results = [];
    for (const t of targets) results.push({ staffName: t.name, ...(await pushMessage(token, t.line_user_id, message)) });
    out.mainReport = { success: true, newConfirmedCount, newRequestsCount, sentTo: targets.length, results };
  } catch (e) {
    out.mainReport = { success: false, error: e.message };
  }

  // ②未確定の仮予約（1件以上ある場合のみ送信。GAS版と同じ）
  try {
    const pendingList = getPendingProvisionalReservations(db, storeId);
    if (pendingList.length > 0) {
      const message = buildPendingProvisionalText(pendingList);
      const results = [];
      for (const t of targets) results.push({ staffName: t.name, ...(await pushMessage(token, t.line_user_id, message)) });
      out.pendingReport = { success: true, pendingCount: pendingList.length, sentTo: targets.length, results };
    } else {
      out.pendingReport = { success: true, pendingCount: 0, sentTo: 0, results: [] };
    }
  } catch (e) {
    out.pendingReport = { success: false, error: e.message };
  }

  // ③スタッフ翌日予約通知（GAS版の「相乗り」呼び出し）
  try {
    out.staffSchedule = await sendStaffTomorrowSchedule(db, storeId);
  } catch (e) {
    out.staffSchedule = { success: false, error: e.message };
  }

  return out;
}

// ----------------------------------------------------------------------------
// sendDayBeforeReminders(db, storeId)：GAS版sendDayBeforeReminders相当
//   明日の予約のうち、LINE連携済み・確定済み（仮予約は対象外）・未送付のものへ
//   「remind」テンプレートでリマインドを送り、reminder_sentを1に更新する。
// ----------------------------------------------------------------------------
async function sendDayBeforeReminders(db, storeId) {
  const dateStr = tomorrowStr();
  const store = db.prepare('SELECT plan, line_customer_channel_token FROM stores WHERE id = ?').get(storeId);
  const token = store && hasFeature(store.plan, 'lineNotify') ? store.line_customer_channel_token : null;

  const targets = db.prepare(`
    SELECT id, realname, staff_name, menu, reservation_time, user_id
    FROM reservations
    WHERE store_id = ? AND realname != 'キャンセル' AND reservation_date = ?
      AND reminder_sent = 0 AND status != '仮予約' AND user_id IS NOT NULL AND user_id != ''
  `).all(storeId, dateStr);

  let template = { body: '明日{TIME}にご予約をお待ちしております（{MENU}／担当：{STAFF}）', closing: '' };
  try { template = getMessageTemplate(db, storeId, 'remind'); } catch (e) { /* デフォルト文言にフォールバック */ }

  const markSent = db.prepare('UPDATE reservations SET reminder_sent = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  const results = [];
  let sentCount = 0;
  for (const r of targets) {
    const body = renderMessageBody(template.body, { TIME: r.reservation_time, MENU: r.menu || '', STAFF: r.staff_name });
    const text = template.closing ? `${body}\n\n${template.closing}` : body;
    try {
      const res = await pushMessage(token, r.user_id, text);
      markSent.run(r.id);
      sentCount++;
      results.push({ reservationId: r.id, realname: r.realname, ...res });
    } catch (e) {
      results.push({ reservationId: r.id, realname: r.realname, ok: false, error: e.message });
    }
  }
  return { success: true, date: dateStr, targetCount: targets.length, sentCount, results };
}

// ----------------------------------------------------------------------------
// sendStaffTomorrowSchedule(db, storeId)：GAS版sendStaffTomorrowSchedule_相当
//   明日の予約（担当未定を除く）をスタッフごとにまとめ、staff.line_user_id宛に
//   一覧を送る。
// ----------------------------------------------------------------------------
async function sendStaffTomorrowSchedule(db, storeId) {
  const dateStr = tomorrowStr();
  const token = getStaffChannelToken(db, storeId);

  const rows = db.prepare(`
    SELECT staff_name, realname, menu, reservation_time
    FROM reservations
    WHERE store_id = ? AND realname != 'キャンセル' AND reservation_date = ? AND staff_name != '' AND staff_name != '未定'
    ORDER BY staff_name ASC, reservation_time ASC
  `).all(storeId, dateStr);

  const byStaff = new Map();
  rows.forEach((r) => {
    if (!byStaff.has(r.staff_name)) byStaff.set(r.staff_name, []);
    byStaff.get(r.staff_name).push(r);
  });

  const staffLineIds = new Map(
    db.prepare(`SELECT name, line_user_id FROM staff WHERE store_id = ? AND is_active = 1 AND line_user_id IS NOT NULL AND line_user_id != ''`)
      .all(storeId)
      .map((s) => [s.name, s.line_user_id])
  );

  const results = [];
  let notifiedCount = 0;
  for (const [staffName, list] of byStaff.entries()) {
    let message = `【明日のご予約】${dateStr}\n━━━━━━━━━━━━\n`;
    list.forEach((r) => { message += `${r.reservation_time} ${r.realname}様 ／ ${r.menu || ''}\n`; });
    message += `━━━━━━━━━━━━\n合計：${list.length}件`;
    const lineUserId = staffLineIds.get(staffName);
    if (!lineUserId) {
      results.push({ staffName, reservationCount: list.length, skipped: true, reason: 'no_line_user_id' });
      continue;
    }
    const res = await pushMessage(token, lineUserId, message);
    results.push({ staffName, reservationCount: list.length, ...res });
    notifiedCount++;
  }

  return { success: true, date: dateStr, staffCount: byStaff.size, notifiedCount, results };
}

module.exports = {
  buildMorningReportText,
  buildEveningReportText,
  getPendingProvisionalReservations,
  sendMorningReportToOwner,
  sendEveningReportToOwner,
  sendDayBeforeReminders,
  sendStaffTomorrowSchedule,
  getOwnerLineTargets
};
