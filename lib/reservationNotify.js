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
const { hasFeature } = require('./plans');
const { getMessageTemplate, renderMessageBody } = require('./messageTemplates');
const db = require('./db');

// ----------------------------------------------------------------------------
// notifyReservationConfirmed(store, customer, reservation, messageKey)
//   store: stores テーブルの1行（line_customer_channel_token を使用）
//   customer: customers テーブルの1行 or null/undefined（見つからない／LINE未連携の場合）
//   reservation: { staffName, menu, date, time }
//   messageKey: 省略時は'confirm_add'（GAS版のMESSAGE_KEYSのいずれか。例：仮予約確定操作
//     ＝'confirm_finalize'）。★2026-09-20追加：仮予約の確定操作から呼べるように一般化した。
//
//   customerがLINE未連携（user_idが空）の場合は、送信せずログのみ出して終了する
//   （全員がLINEを使っているわけではないため、これは異常系ではなく正常な分岐）。
// ----------------------------------------------------------------------------
async function notifyReservationConfirmed(store, customer, reservation, messageKey) {
  if (!customer || !customer.user_id) {
    console.log(`ℹ️  顧客がLINE未連携のため通知をスキップしました（customerId=${customer ? customer.customer_id : '(不明)'}）`);
    return { skipped: true, reason: 'no_line_user_id' };
  }

  const message = buildConfirmationMessage(customer, reservation, store ? store.id : null, messageKey || 'confirm_add');

  // ★2026-09-18(続き)追加：⑤課金基盤のプラン判定。
  //   店舗のプランが 'line'（②LINE連携プラン）でない場合は、たとえチャネル
  //   トークンが設定されていても実送信せず、常にシミュレーション扱いにする
  //  （pushMessageにトークンとしてnullを渡すと、lib/lineClient.js側の既存の
  //   「未設定時はシミュレーションログを出すだけ」の分岐がそのまま使える）。
  //   これにより「プランを切り替えると挙動が変わる」ことをデモで見せられる。
  const planSlug = store ? store.plan : 'trial';
  const channelAccessToken = hasFeature(planSlug, 'lineNotify')
    ? (store ? store.line_customer_channel_token : null)
    : null;
  if (!hasFeature(planSlug, 'lineNotify')) {
    console.log(`ℹ️  店舗のプラン（${planSlug}）はLINE通知の実送信対象外のため、シミュレーション扱いにしました`);
  }

  return pushMessage(channelAccessToken, customer.user_id, message);
}

// ----------------------------------------------------------------------------
// buildConfirmationMessage(customer, reservation, storeId, messageKey)
//   ★2026-09-20更新：店舗設定「メッセージ設定」で編集したテンプレート（lib/messageTemplates.js）
//   から本文を組み立てるようにした。GAS版のrenderMessageBody_と同じ置換方式。
//   storeIdが無い場合や取得に失敗した場合は、テンプレート未取得時のデフォルト文言
//   （DEFAULT_MESSAGE_TEMPLATES.confirm_add）にフォールバックする。
//
//   ★2026-09-20更新：messageKeyを外から指定できるようにした。GAS版は
//   キープメンバー予約/仮予約受付/仮予約確定操作で confirm_add / confirm_keep /
//   confirm_provisional / confirm_finalize の4パターンに出し分けていたが、
//   このプロトタイプでこの出し分けが実際に使われるのは「①手動追加＝confirm_add」と
//   「④仮予約確定操作＝confirm_finalize」の2経路のみ（②③はキープメンバー/新規客の
//   判定がまだ無いため今後の拡張候補）。
// ----------------------------------------------------------------------------
function buildConfirmationMessage(customer, reservation, storeId, messageKey) {
  const key = messageKey || 'confirm_add';
  let template = { body: '予約が確定しました！\n📅 {DATE} {TIME}\n💆 {MENU}\n担当：{STAFF}', closing: '' };
  if (storeId) {
    try {
      template = getMessageTemplate(db, storeId, key);
    } catch (e) {
      console.error('メッセージテンプレート取得でエラー（デフォルト文言にフォールバック）:', e);
    }
  }
  const vars = { DATE: reservation.date, TIME: reservation.time, MENU: reservation.menu, STAFF: reservation.staffName };
  const body = renderMessageBody(template.body, vars);
  return template.closing ? `${body}\n\n${template.closing}` : body;
}

module.exports = { notifyReservationConfirmed, buildConfirmationMessage };
