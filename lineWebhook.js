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
const { verifyLineSignature } = require('../lib/lineClient');
const { verifyPin } = require('../lib/auth');

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
  if (!/^\d{4}$/.test(text)) return;
  if (storeId == null) return;

  const candidates = db.prepare(
    'SELECT * FROM staff WHERE store_id = ? AND is_active = 1 AND pin_hash IS NOT NULL'
  ).all(storeId);

  const matched = candidates.find((s) => verifyPin(text, s.pin_salt, s.pin_hash));
  if (!matched) return; // 一致なし：無反応（総当たり対策・GAS版仕様踏襲）

  if (matched.line_user_id) {
    console.log(`ℹ️  スタッフ「${matched.name}」はLINE userId登録済みのため、更新をスキップしました（既に登録済みです）`);
    return;
  }

  db.prepare('UPDATE staff SET line_user_id = ? WHERE id = ?').run(lineUserId, matched.id);
  console.log(`✅ スタッフ「${matched.name}」のLINE userIdを自動登録しました（userId=${lineUserId}）`);
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
// registerLineWebhook(app)
//   server.js から呼び出す。express.raw() をこのパスにだけ適用してから
//   グローバルの express.json() より前にマウントする必要がある。
// ----------------------------------------------------------------------------
function registerLineWebhook(app) {
  app.post(
    '/webhook/line',
    express.raw({ type: 'application/json' }), // このルートだけ生バイト列で受け取る（署名検証のため）
    (req, res) => {
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
          return res.status(401).send('invalid signature');
        }
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch (e) {
        console.error('❌ LINE WebhookボディのJSONパースに失敗しました:', e.message);
        return res.status(200).send('OK'); // パース失敗でもLINEには200を返す（再送ループ防止）
      }

      const storeId = resolveStoreIdForWebhook(LINE_CHANNEL_SECRET || null);
      const events = Array.isArray(payload.events) ? payload.events : [];

      events.forEach((event) => {
        try {
          summarizeEvent(event);

          if (
            event.type === 'message' &&
            event.message &&
            event.message.type === 'text' &&
            event.source &&
            event.source.userId
          ) {
            handleStaffPinRegistration(storeId, event.source.userId, event.message.text.trim());
          }
        } catch (eventErr) {
          // 1件のイベント処理で例外が起きても、他のイベント処理やLINEへの200応答に
          // 影響させない。
          console.error('LINE Webhookイベント処理中にエラー（このイベントのみスキップ）:', eventErr);
        }
      });

      res.status(200).send('OK');
    }
  );
}

module.exports = { registerLineWebhook, resolveStoreIdForWebhook, handleStaffPinRegistration };
