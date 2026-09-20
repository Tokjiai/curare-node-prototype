// ============================================================================
// lib/messageTemplates.js
// ★2026-09-20追加：メッセージ設定（GAS版owner_ui.htmlの「メッセージ設定」パネル・
//   admin_ui_functions.gsのMESSAGE_KEYS / MESSAGE_LABELS / DEFAULT_MESSAGE_TEMPLATES_ /
//   getMessageSettings / saveMessageSettings に相当）。
//
//   LINE通知テンプレート（本文＋締めの文）を店舗ごとに編集できるようにする。
//   GAS版はスプレッドシートの「messages」シートに保存し、未登録キーはデフォルト文言に
//   フォールバックしていた。Node版ではDBの message_templates テーブルに保存し、
//   同じフォールバック方式を踏襲する。
// ============================================================================

const MESSAGE_KEYS = [
  'welcome',
  'confirm_add',
  'confirm_keep',
  'confirm_provisional',
  'confirm_finalize',
  'change',
  'cancel',
  'remind'
];

const MESSAGE_LABELS = {
  welcome: 'あいさつ（友だち追加時）',
  confirm_add: '予約確認①（スタッフが手動で予約追加）',
  confirm_keep: '予約確認②（キープメンバーの予約・即確定）',
  confirm_provisional: '予約確認③（仮予約受付・キープメンバー以外）',
  confirm_finalize: '予約確認④（スタッフが仮予約を確定操作）',
  change: '予約変更',
  cancel: 'キャンセル',
  remind: '前日リマインド'
};

// GAS版 DEFAULT_MESSAGE_TEMPLATES_ をそのまま移植
const DEFAULT_MESSAGE_TEMPLATES = {
  confirm_add: {
    body: '予約が確定しました！\n📅 {DATE} {TIME}\n💆 {MENU}\n担当：{STAFF}',
    closing: ''
  },
  confirm_keep: {
    body: '【予約確定】\n📅 {DATE} {TIME}〜\n💆 {MENU}\n担当：{STAFF}',
    closing: ''
  },
  confirm_provisional: {
    body: '【仮予約受付】\nご予約ありがとうございます。\n📅 {DATE} {TIME}〜\n💆 {MENU}\n担当：{STAFF}',
    closing: ''
  },
  confirm_finalize: {
    body: '【予約確定】\nお待たせいたしました。ご予約が確定しました。\n📅 {DATE} {TIME}\n💆 {MENU}\n担当：{STAFF}',
    closing: ''
  },
  change: {
    body: '予約が変更されました\n📅 {DATE} {TIME}\n💆 {MENU}\n担当：{STAFF}',
    closing: ''
  },
  cancel: {
    body: 'ご予約をキャンセルしました\n📅 {DATE} {TIME}\n💆 {MENU}',
    closing: ''
  },
  remind: {
    body: '【明日のご予約リマインド】\n明日 {TIME}〜 エステのご予約があります。\n💆 {MENU}\n担当：{STAFF}',
    closing: ''
  },
  welcome: {
    body: '{NICKNAME}さん\n\nはじめまして！友だち追加ありがとうございます😊\n（ここに店舗名やひとことをご自由に記入してください）\n\nこれからご予約の確認やリマインドなどをこちらのLINEでお送りします。\n何かご不明な点があれば、このトークで気軽にご連絡くださいね。\n\n（届いているか確認のため、よろしければスタンプを一つ送ってみてください🙌）',
    closing: ''
  }
};

// ----------------------------------------------------------------------------
// getMessageSettings(db, storeId)
//   GAS版 getMessageSettings(staffId, storeId) に相当（権限チェックはserver.js側の
//   requireOwnerSessionミドルウェアで行うためここでは行わない）。
// ----------------------------------------------------------------------------
function getMessageSettings(db, storeId) {
  const rows = db.prepare('SELECT msg_key, body, closing FROM message_templates WHERE store_id = ?').all(storeId);
  const saved = {};
  rows.forEach((r) => { saved[r.msg_key] = r; });

  const items = MESSAGE_KEYS.map((key) => {
    const fallback = DEFAULT_MESSAGE_TEMPLATES[key];
    const row = saved[key];
    return {
      key,
      label: MESSAGE_LABELS[key],
      body: (row && row.body) ? row.body : fallback.body,
      closing: (row && row.closing) ? row.closing : fallback.closing
    };
  });

  return { items };
}

// ----------------------------------------------------------------------------
// saveMessageSettings(db, storeId, items)
//   GAS版 saveMessageSettings(staffId, items, storeId) に相当。バリデーションも移植。
//   items: [{ key, body, closing }, ...]
// ----------------------------------------------------------------------------
function saveMessageSettings(db, storeId, items) {
  const byKey = {};
  (items || []).forEach((it) => { byKey[it.key] = it; });

  MESSAGE_KEYS.forEach((key) => {
    const it = byKey[key];
    if (!it) return;
    if (!it.body || !String(it.body).trim()) {
      throw new Error(MESSAGE_LABELS[key] + 'の本文を入力してください');
    }
    if (it.body.length > 500) {
      throw new Error(MESSAGE_LABELS[key] + 'の本文は500文字以内で入力してください');
    }
    if (it.closing && it.closing.length > 300) {
      throw new Error(MESSAGE_LABELS[key] + 'の締めの文は300文字以内で入力してください');
    }
  });

  const upsert = db.prepare(`
    INSERT INTO message_templates (store_id, msg_key, body, closing, updated_at)
    VALUES (@store_id, @msg_key, @body, @closing, CURRENT_TIMESTAMP)
    ON CONFLICT(store_id, msg_key) DO UPDATE SET
      body = excluded.body, closing = excluded.closing, updated_at = CURRENT_TIMESTAMP
  `);

  const txn = db.transaction((rows) => {
    rows.forEach((row) => upsert.run(row));
  });

  const rows = MESSAGE_KEYS
    .filter((key) => byKey[key])
    .map((key) => ({
      store_id: storeId,
      msg_key: key,
      body: byKey[key].body.trim(),
      closing: (byKey[key].closing || '').trim()
    }));

  txn(rows);
  return { success: true };
}

// ----------------------------------------------------------------------------
// getMessageTemplate(db, storeId, key)
//   実際の送信処理（lib/reservationNotify.js等）から呼び出す単一テンプレート取得。
//   GAS版 getMessageTemplate_(ss, key) に相当。
// ----------------------------------------------------------------------------
function getMessageTemplate(db, storeId, key) {
  const fallback = DEFAULT_MESSAGE_TEMPLATES[key] || { body: '', closing: '' };
  const row = db.prepare('SELECT body, closing FROM message_templates WHERE store_id = ? AND msg_key = ?').get(storeId, key);
  if (!row) return fallback;
  return {
    body: row.body || fallback.body,
    closing: row.closing || ''
  };
}

// ----------------------------------------------------------------------------
// renderMessageBody(template, vars)
//   GAS版 renderMessageBody_(template, vars) に相当。{KEY} プレースホルダーを置換。
// ----------------------------------------------------------------------------
function renderMessageBody(template, vars) {
  let text = String(template || '');
  Object.keys(vars || {}).forEach((k) => {
    text = text.split('{' + k + '}').join(vars[k] != null ? String(vars[k]) : '');
  });
  return text;
}

module.exports = {
  MESSAGE_KEYS,
  MESSAGE_LABELS,
  DEFAULT_MESSAGE_TEMPLATES,
  getMessageSettings,
  saveMessageSettings,
  getMessageTemplate,
  renderMessageBody
};
