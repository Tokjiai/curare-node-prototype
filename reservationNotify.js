// ============================================================================
// lib/reservationNotify.js
// 予約確定時のLINE通知メッセージ組み立て＋送信。
//
// 【重要】予約登録そのものの信頼性を最優先する。
//   LINE通知はあくまで付加機能であり、LINE側の障害・未設定・APIエラーが
//   予約登録処理そのものを失敗させてはならない（呼び出し側でtry/catchし、
//   ここで投げた例外や返り値のエラーで予約のレスポンスを止めないこと）。
// ============================================================================

const { pushMessage } = require('./lineClient');

// ----------------------------------------------------------------------------
// notifyReservationConfirmed(store, customer, reservation)
//   store: stores テーブルの1行（line_customer_channel_token を使用）
//   customer: customers テーブルの1行 or null/undefined（見つからない／LINE未連携の場合）
//   reservation: { staffName, menu, date, time }
//
//   customerがLINE未連携（user_idが空）の場合は、送信せずログのみ出して終了する
//   （全員がLINEを使っているわけではないため、これは異常系ではなく正常な分岐）。
// ----------------------------------------------------------------------------
async function notifyReservationConfirmed(store, customer, reservation) {
  if (!customer || !customer.user_id) {
    console.log(`ℹ️  顧客がLINE未連携のため通知をスキップしました（customerId=${customer ? customer.customer_id : '(不明)'}）`);
    return { skipped: true, reason: 'no_line_user_id' };
  }

  const message = buildConfirmationMessage(customer, reservation);
  const channelAccessToken = store ? store.line_customer_channel_token : null;

  return pushMessage(channelAccessToken, customer.user_id, message);
}

// ----------------------------------------------------------------------------
// buildConfirmationMessage(customer, reservation)
//   GAS版・server.js既存の日本語メッセージ（例：'✅ 予約を登録しました'）と
//   トーンを合わせた予約確定通知文を組み立てる。
// ----------------------------------------------------------------------------
function buildConfirmationMessage(customer, reservation) {
  const name = customer.realname || 'お客様';
  return (
    `✅ ${name}様、ご予約が確定しました。\n` +
    `【日時】${reservation.date} ${reservation.time}\n` +
    `【担当】${reservation.staffName}\n` +
    `【メニュー】${reservation.menu}\n` +
    `当日のご来店をお待ちしております。`
  );
}

module.exports = { notifyReservationConfirmed, buildConfirmationMessage };
