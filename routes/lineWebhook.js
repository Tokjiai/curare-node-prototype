// ============================================================================
// routes/lineWebhook.js
// LINE Messaging API のWebhook受信エンドポイント（POST /webhook/line）。
//
// server.js が肥大化しないよう、LINE関連のルーティングはこのモジュールに分離している。
// server.js からは registerLineWebhook(app) を呼ぶだけでマウントされる。
//
// 【スキャフォールディングとしての位置づけ】
//   - Webhookの受信・署名検証・イベントのパース＆ログ出力：実際に動く実装。
//   - スタッフPINの自動登録（4桁PINをテキストで送ると line_user_id を自動登録）：
//     実際に動く実装（GAS版の運用を踏襲した唯一の実ビジネスロジック）。
//   - それ以外（予約確定・変更・リマインドの返信、リッチメニュー等）は今回未実装。
//     予約確定通知の送信自体は lib/reservationNotify.js から別途呼ばれる
//     （Webhookの受信とは別方向＝お店からお客様への通知なので、このファイルの範囲外）。
//
// 【raw body（生のリクエストボディ）が必要な理由】
//   署名検証は「受信した生のバイト列」に対するHMACでないと一致しない。
//   server.js は他のAPI用に app.use(express.json()) をグローバルに使っているが、
//   これはボディをパース済みオブジェクトに変換してしまい、元のバイト列を捨ててしまう。
//   そのため、このルートだけ express.raw() で生バイト列を受け取り、
//   グローバルの express.json() より前にマウントする必要がある
//   （server.js側でのマウント順序に注意。詳しくはserver.jsのコメント参照）。
// ============================================================================

const express = require('express');
const db = require('../lib/db');
const { verifyLineSignature, replyMessage, getLineDisplayName } = require('../lib/lineClient');
const { verifyPin } = require('../lib/auth');
const { findOrCreateCustomerFromLine } = require('../lib/customerMerge');
const { hasFeature } = require('../lib/plans');
const { getMessageTemplate, renderMessageBody } = require('../lib/messageTemplates');

// ★2026-09-21追加：予約フォームへのリンクを組み立てる際のベースURL。
//   GAS版はScriptPropertiesの'CUSTOMER_FORM_URL'から読んでいたが、Node版は
//   デプロイ先ドメインを環境変数で渡す方式にする（Renderの実URLを想定）。
//   未設定の場合はボタン付きメッセージを送らず、テキストのみの案内にフォールバックする。
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

// ★2026-09-21追加：LINE_CUSTOMER_CHANNEL_TOKEN 環境変数（安全策）
//   Renderの無料プランはディスクがエフェメラル（再デプロイのたびに中身が消える
//   場合がある）という前提のため、stores.line_customer_channel_token（DBに保存する
//   値、店舗設定「LINE連携設定」パネルから入力）だけに頼ると、再デプロイのたびに
//   接続設定が消えてしまうリスクがある。LINE_CHANNEL_SECRETと同じく環境変数は
//   redeployしても確実に維持されるため、DB側の値が未設定の場合のフォールバック先
//   として使えるようにした（優先順位：DB値 > 環境変数）。
//   store.line_customer_channel_token を直接参照している箇所は無く、必ず
//   getCustomerChannelToken(store) 経由で取得する。
const LINE_CUSTOMER_CHANNEL_TOKEN_FALLBACK = process.env.LINE_CUSTOMER_CHANNEL_TOKEN || '';

function getCustomerChannelToken(store) {
  if (store && store.line_customer_channel_token) return store.line_customer_channel_token;
  return LINE_CUSTOMER_CHANNEL_TOKEN_FALLBACK || null;
}

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';

if (!process.env.LINE_CHANNEL_SECRET) {
  // ADMIN_PASSWORD / SESSION_SECRET と同じ「未設定時は起動時に警告」パターンを踏襲。
  console.warn(
    '⚠️  LINE_CHANNEL_SECRET 環境変数が未設定のため、/webhook/line への署名検証は' +
    'スキップされます（開発用）。本番運用前に必ずLINE公式アカウントのチャネルシークレットを設定してください。'
  );
}

// ----------------------------------------------------------------------------
// resolveStoreIdForWebhook(secretUsed)
//   Webhookの署名検証に使ったチャネルシークレットから、対象の店舗を解決する。
//   （実運用では「LINEチャネル1つ＝店舗1つ」を想定しており、複数店舗展開時は
//    店舗ごとに異なるチャネルシークレットを stores.line_staff_channel_secret に
//    設定することで、この関数がそのまま店舗を判別できるようになる設計）
//
//   このプロトタイプ段階では、まだどの店舗にも line_staff_channel_secret が
//   設定されていない可能性が高いため、一致する店舗が無ければ最初の店舗に
//   フォールバックする（スキャフォールディングとして動作確認できることを優先）。
// ----------------------------------------------------------------------------
function resolveStoreIdForWebhook(secretUsed) {
  if (secretUsed) {
    const matched = db.prepare('SELECT id FROM stores WHERE line_staff_channel_secret = ?').get(secretUsed);
    if (matched) return matched.id;
  }
  const fallback = db.prepare('SELECT id FROM stores ORDER BY id ASC LIMIT 1').get();
  return fallback ? fallback.id : null;
}

// ----------------------------------------------------------------------------
// handleStaffPinRegistration(storeId, lineUserId, text)
//   テキストがちょうど4桁の数字の場合、そのPINで staff テーブルを照合する。
//   一致するスタッフが見つかり、かつそのスタッフの line_user_id が未設定なら、
//   このイベントの送信元 userId を自動登録する（GAS版の運用ドキュメントに基づく仕様）。
//
//   ・一致するスタッフが無い場合：何もしない（返信もしない。ブルートフォースで
//     PINを総当たりされても「一致しない」ことが外部から分からないようにするため）。
//   - 既に line_user_id が設定済みの場合：上書きしない（誤操作でのなりすまし登録を防ぐ）。
// ----------------------------------------------------------------------------
function handleStaffPinRegistration(storeId, lineUserId, text) {
  // ★2026-09-24追加：webhook_log の「処理結果」欄に残すため、結果を短い文字列で返す（対象外はnull）
  if (!/^\d{4}$/.test(text)) return null;
  if (storeId == null) return null;

  const candidates = db.prepare(
    // ★2026-09-24追加：サロン端末（共有ログイン）は個人のLINEと紐づけない
    'SELECT * FROM staff WHERE store_id = ? AND is_active = 1 AND is_shared_terminal = 0 AND pin_hash IS NOT NULL'
  ).all(storeId);

  const matched = candidates.find((s) => verifyPin(text, s.pin_salt, s.pin_hash));
  if (!matched) return 'PIN不一致（無反応）'; // 一致なし：無反応（総当たり対策・GAS版仕様踏襲）

  if (matched.line_user_id) {
    console.log(`ℹ️  スタッフ「${matched.name}」はLINE userId登録済みのため、更新をスキップしました（既に登録済みです）`);
    return `スタッフPIN一致（${matched.name}・登録済みのためスキップ）`;
  }

  db.prepare('UPDATE staff SET line_user_id = ? WHERE id = ?').run(lineUserId, matched.id);
  console.log(`✅ スタッフ「${matched.name}」のLINE userIdを自動登録しました（userId=${lineUserId}）`);
  return `スタッフ「${matched.name}」のLINE userIdを登録`;
}

// ----------------------------------------------------------------------------
// ★2026-09-21追加：以下3つはGAS版webhook_handler.gsのhandleFollow_ /
//   handleStickerMessage_ / handleTextMessage_ の移植。これまでNode版は
//   「スタッフの4桁PIN自動登録」しか実装しておらず、README/コメントにも
//   明記の通りスキャフォールディングにとどまっていたが、GAS版のソースを
//   直接調査したところ、customer_form.htmlの前段としてお客様との最初の
//   接点になるこの3つの振る舞いが実際の運用で使われていると判明したため、
//   実際に動く形で移植した。
//
//   【GAS版からの簡略化】GAS版はLINE公式アカウントを「A（お客様向け）」
//   「B（スタッフ向け）」の2アカウント運用に分けており、destinationで
//   振り分けていた。Node版はまだアカウントの区別を持つ設計になっていない
//   （store.line_customer_channel_tokenは送信用トークンとして既に使われて
//   いるが、Webhook受信側を複数チャネルシークレットで振り分ける仕組みは
//   まだ無い）。そのため今回は、既存のスタッフPIN登録処理と同じ経路で、
//   テキストメッセージが来るたびに「4桁PIN」「予約キーワード」の両方を
//   試みる形にとどめている（実際のLINE公式アカウントを2本立てで接続する
//   段階になったら、destinationベースの振り分けを追加する必要がある）。
// ----------------------------------------------------------------------------

// handleFollow(storeId, lineUserId, replyToken)
//   友だち追加：顧客マスタへ自動登録し、プラン（LINE連携プラン）が有効な店舗のみ
//   あいさつメッセージを返信する（GAS版のLINE_NOTIFY_OPTION_CONTRACT判定に相当。
//   Node版は既存のhasFeature(plan,'lineNotify')の仕組みをそのまま流用する）。
async function handleFollow(storeId, lineUserId, replyToken) {
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  if (!store) return;
  const token = getCustomerChannelToken(store);

  const displayName = await getLineDisplayName(token, lineUserId);
  const result = findOrCreateCustomerFromLine(db, storeId, lineUserId, displayName);
  console.log(`👤 LINE友だち登録: userId=${lineUserId} customerId=${result.customerId} isNew=${result.isNew}`);
  const custResult = `顧客マスタ${result.isNew ? '新規登録' : '既存'}（${result.customerId}）`;

  if (!hasFeature(store.plan, 'lineNotify')) {
    console.log('ℹ️ 店舗のプランはLINE通知対象外のため、あいさつメッセージの送信をスキップしました');
    return custResult + '・あいさつ送信なし（プラン対象外）';
  }

  let template = { body: 'ご登録ありがとうございます！', closing: '' };
  try {
    template = getMessageTemplate(db, storeId, 'welcome');
  } catch (e) {
    console.error('あいさつメッセージのテンプレート取得でエラー（デフォルト文言にフォールバック）:', e.message);
  }
  const body = renderMessageBody(template.body, { NICKNAME: displayName || 'お客様' });
  const text = template.closing ? `${body}\n\n${template.closing}` : body;
  await replyMessage(token, replyToken, text, null);
  return custResult + '・あいさつ返信';
}

// handleSticker(storeId, replyToken)
//   スタンプ受信時の定型返信（GAS版handleStickerMessage_相当）
async function handleSticker(storeId, replyToken) {
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  const token = getCustomerChannelToken(store);
  const text = 'スタンプありがとうございます😊\nご予約の方法は下のメニューの「予約」ボタンを押してください。';
  await replyMessage(token, replyToken, text, null);
  return 'スタンプへの定型返信';
}

// handleReservationKeyword(storeId, lineUserId, text, replyToken)
//   テキストが「エステ予約したい」と完全一致した場合、予約フォームへのリンクを
//   返信する（GAS版handleTextMessage_相当）。PUBLIC_BASE_URL未設定の場合は
//   ボタンなしのテキストのみにフォールバックする。
async function handleReservationKeyword(storeId, lineUserId, text, replyToken) {
  if (text !== 'エステ予約したい') return null;
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  if (!store) return;
  const token = getCustomerChannelToken(store);

  const customer = db.prepare('SELECT customer_id FROM customers WHERE store_id = ? AND user_id = ?').get(storeId, lineUserId);
  let reserveUrl = null;
  if (PUBLIC_BASE_URL) {
    reserveUrl = `${PUBLIC_BASE_URL}/index.html?store=${encodeURIComponent(store.slug)}`;
    if (customer) reserveUrl += `&cid=${encodeURIComponent(customer.customer_id)}`;
  } else {
    console.warn('⚠️ PUBLIC_BASE_URL未設定のため、予約リンクのボタンは付けずテキストのみ返信します');
  }
  await replyMessage(token, replyToken, 'ご予約はこちらからどうぞ👇', reserveUrl);
  return '予約キーワードに予約フォームのリンクを返信';
}

// ----------------------------------------------------------------------------
// summarizeEvent(event)
//   スキャフォールディングとして「Webhookイベントが正しく受信・パースできている」
//   ことを目視確認できるよう、構造化した1行ログを出す。
// ----------------------------------------------------------------------------
function summarizeEvent(event) {
  const type = event.type || '(unknown)';
  const userId = (event.source && event.source.userId) || '(unknown)';
  let extra = '';
  if (event.type === 'message' && event.message) {
    if (event.message.type === 'text') {
      extra = ` text="${event.message.text}"`;
    } else {
      extra = ` messageType=${event.message.type}`;
    }
  }
  console.log(`📩 LINE Webhookイベント受信: type=${type} userId=${userId}${extra}`);
}

// ----------------------------------------------------------------------------
// ★2026-09-24追加：LINE webhookの受信ログ（webhook_logテーブル、GAS版webhook_logシート相当）
//   管理者がDB一覧ビューアで「webhookから収集されるデータ」を細部まで確認できるよう、
//   1イベント1行で種別・destination・userId・本文・処理結果・生データを記録する。
//   ・スタッフがLINE userId登録のために送る4桁PINは、本文・生データとも「****」にマスクする
//     （PINを平文でDBに残さないため）
//   ・ログの書き込みに失敗しても、LINEへの200応答やイベント処理には影響させない
//   ・90日より古い行は日次メンテナンス（lib/maintenance.js）で自動削除する
// ----------------------------------------------------------------------------
const PIN_MASK = '****（4桁PIN・マスク済み）';
function maskPinText_(text) {
  return /^\s*\d{4}\s*$/.test(String(text)) ? PIN_MASK : text;
}
function webhookEventBody_(event) {
  if (event.type === 'message' && event.message) {
    const m = event.message;
    if (m.type === 'text') return maskPinText_(m.text);
    if (m.type === 'sticker') return `packageId=${m.packageId || ''} stickerId=${m.stickerId || ''}`;
    return `(${m.type})`;
  }
  if (event.type === 'postback' && event.postback) return event.postback.data || '';
  return '';
}
function writeWebhookLog_(entry) {
  try {
    db.prepare(`
      INSERT INTO webhook_log (store_id, event_type, message_type, destination, source_type, user_id, body, result, raw_json)
      VALUES (@store_id, @event_type, @message_type, @destination, @source_type, @user_id, @body, @result, @raw_json)
    `).run(Object.assign({
      store_id: null, event_type: null, message_type: null, destination: null,
      source_type: null, user_id: null, body: null, result: null, raw_json: null
    }, entry));
  } catch (e) {
    console.error('webhook_logへの記録に失敗しました（処理は続行）:', e.message);
  }
}
function logWebhookEvent_(storeId, destination, event, result) {
  const masked = JSON.parse(JSON.stringify(event));
  if (masked.message && masked.message.type === 'text') masked.message.text = maskPinText_(masked.message.text);
  writeWebhookLog_({
    store_id: storeId,
    event_type: event.type || '(unknown)',
    message_type: (event.message && event.message.type) || null,
    destination: destination || null,
    source_type: (event.source && event.source.type) || null,
    user_id: (event.source && event.source.userId) || null,
    body: webhookEventBody_(event),
    result,
    raw_json: JSON.stringify(masked)
  });
}

// ----------------------------------------------------------------------------
// registerLineWebhook(app)
//   server.js から呼び出す。express.raw() をこのパスにだけ適用してから
//   グローバルの express.json() より前にマウントする必要がある。
// ----------------------------------------------------------------------------
function registerLineWebhook(app) {
  app.post(
    '/webhook/line',
    express.raw({ type: 'application/json' }), // このルートだけ生バイト列で受け取る（署名検証のため）
    async (req, res) => {
      // LINEは高速な200応答を要求する（応答が遅い／200以外だと再送・異常判定される）。
      // そのため、内部処理で何が起きても最終的には必ず200を返す設計にする
      // （ただし「署名検証に失敗した」＝なりすましの疑いがある場合は例外的に拒否する）。
      const rawBody = req.body; // express.raw() により Buffer
      const signature = req.get('x-line-signature');

      let verified = false;
      if (!LINE_CHANNEL_SECRET) {
        // ★未設定時は検証をスキップするが、「検証済み」であるかのように振る舞っては
        //   絶対にならない。毎リクエストごとに明示的な警告ログを出す。
        console.warn('⚠️ LINE_CHANNEL_SECRET未設定のため署名検証をスキップしました（開発用）');
      } else {
        verified = verifyLineSignature(rawBody, signature, LINE_CHANNEL_SECRET);
        if (!verified) {
          console.error('❌ LINE Webhook署名検証に失敗しました。不正なリクエストの可能性があるため拒否します。');
          // ★2026-09-24追加：なりすましの疑いがある受信も管理者が確認できるよう記録する（本文は残さない）
          writeWebhookLog_({ store_id: resolveStoreIdForWebhook(null), event_type: '(request)', result: '署名検証NGのため拒否（401）' });
          return res.status(401).send('invalid signature');
        }
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch (e) {
        console.error('❌ LINE WebhookボディのJSONパースに失敗しました:', e.message);
        writeWebhookLog_({ store_id: resolveStoreIdForWebhook(null), event_type: '(request)', result: 'JSONパース失敗: ' + e.message });
        return res.status(200).send('OK'); // パース失敗でもLINEには200を返す（再送ループ防止）
      }

      const storeId = resolveStoreIdForWebhook(LINE_CHANNEL_SECRET || null);
      const events = Array.isArray(payload.events) ? payload.events : [];

      // ★2026-09-21更新：follow/sticker/キーワード返信を追加したことでLINE APIの
      //   呼び出し（プロフィール取得・リプライ送信）を伴うようになったため、
      //   for...ofでawaitしながら順に処理する（forEachはasyncコールバックを
      //   待たないため、テスト等で「Webhook応答が返った時点でDB更新が完了している」
      //   ことを保証できなくなってしまう）。1件のイベント処理で例外が起きても、
      //   他のイベント処理やLINEへの200応答には影響させない。
      const destination = payload.destination || null;
      for (const event of events) {
        let result = '対象外（処理なし）';
        try {
          summarizeEvent(event);
          const userId = event.source && event.source.userId;

          if (event.type === 'follow' && userId && event.replyToken) {
            result = (await handleFollow(storeId, userId, event.replyToken)) || result;
          } else if (event.type === 'message' && event.message && event.message.type === 'sticker' && event.replyToken) {
            result = (await handleSticker(storeId, event.replyToken)) || result;
          } else if (event.type === 'message' && event.message && event.message.type === 'text' && userId) {
            const text = event.message.text.trim();
            const parts = [handleStaffPinRegistration(storeId, userId, text)];
            if (event.replyToken) {
              parts.push(await handleReservationKeyword(storeId, userId, text, event.replyToken));
            }
            result = parts.filter(Boolean).join('／') || result;
          }
        } catch (eventErr) {
          console.error('LINE Webhookイベント処理中にエラー（このイベントのみスキップ）:', eventErr);
          result = 'エラー: ' + eventErr.message;
        }
        logWebhookEvent_(storeId, destination, event, result);
      }

      res.status(200).send('OK');
    }
  );
}

module.exports = { registerLineWebhook, resolveStoreIdForWebhook, handleStaffPinRegistration, getCustomerChannelToken };
