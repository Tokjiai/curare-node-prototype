// ============================================================================
// lib/lineClient.js
// LINE Messaging API とのやり取り（署名検証・プッシュ送信）を集約するモジュール。
//
// 【このモジュールについて】
//   これは「足場（スキャフォールディング）」として実装している。
//   実際のLINE公式アカウントのチャネルシークレット／チャネルアクセストークンを
//   まだ用意していない段階でも、環境変数を設定するだけで本番動作に切り替わる
//   ように、正しい構造で実装してある（後からロジックを書き直す必要がないように）。
//
//   - verifyLineSignature：Webhookの署名検証。Node標準cryptoのみ使用（新規npm依存なし）。
//   - pushMessage：LINEのプッシュメッセージ送信。Node 18+ のグローバルfetchを使用
//     （package.jsonの engines.node が ">=18.0.0" のため、node-fetch等の追加は不要）。
//     チャネルアクセストークンが未設定の場合は実際には送信せず、コンソールに
//     ログを出すだけの「開発用シミュレーション」動作になる。
// ============================================================================

const crypto = require('crypto');

const LINE_PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';
const LINE_REPLY_ENDPOINT = 'https://api.line.me/v2/bot/message/reply';
const LINE_PROFILE_ENDPOINT = 'https://api.line.me/v2/bot/profile/';

// ----------------------------------------------------------------------------
// verifyLineSignature(rawBody, signatureHeader, channelSecret)
//   LINEはWebhookリクエストのボディ（生のバイト列）をチャネルシークレットで
//   HMAC-SHA256した値をBase64エンコードし、x-line-signature ヘッダーに載せて送る。
//   ここではその値を再計算し、タイミング攻撃を避けるため crypto.timingSafeEqual で
//   比較する（=== による文字列比較はタイミング攻撃に弱いため使わない）。
//
//   rawBody: Buffer（express.raw()で受け取った生のリクエストボディ）
//   signatureHeader: string（x-line-signature ヘッダーの値）
//   channelSecret: string
//   戻り値: boolean
// ----------------------------------------------------------------------------
function verifyLineSignature(rawBody, signatureHeader, channelSecret) {
  if (!rawBody || !signatureHeader || !channelSecret) return false;
  try {
    const expected = crypto
      .createHmac('sha256', channelSecret)
      .update(rawBody)
      .digest(); // Buffer

    const provided = Buffer.from(signatureHeader, 'base64');

    if (expected.length !== provided.length) return false;
    return crypto.timingSafeEqual(expected, provided);
  } catch (e) {
    // Base64として不正な値が来た場合など。「検証できなかった」＝不正とみなす。
    console.error('LINE署名検証中にエラー（不正な形式として扱います）:', e.message);
    return false;
  }
}

// ----------------------------------------------------------------------------
// pushMessage(channelAccessToken, toUserId, text)
//   LINEのプッシュメッセージAPIを呼び出してテキストメッセージを送信する。
//
//   channelAccessTokenが未設定（falsy）の場合は、実際には送信せず
//   コンソールログのみ出力する「開発用シミュレーション」モードで動作する。
//   これにより、本物のLINEチャネルが無い状態でも、呼び出し側（予約確定処理等）は
//   一切コードを変更せずに動かせる。本番運用に移る際は環境変数／DBに
//   トークンを設定するだけで実送信に切り替わる。
//
//   戻り値：
//     シミュレーション時 → { simulated: true }
//     実送信成功時       → { simulated: false, ok: true, status }
//     実送信失敗時       → { simulated: false, ok: false, status, body }
// ----------------------------------------------------------------------------
async function pushMessage(channelAccessToken, toUserId, text) {
  if (!channelAccessToken) {
    console.log(`📱 [開発用/LINE未設定] 本来なら ${toUserId} 宛にLINE通知: ${text}`);
    return { simulated: true };
  }

  if (typeof fetch !== 'function') {
    // package.jsonのengines.nodeが>=18.0.0である前提だが、万一グローバルfetchが
    // 無い環境で動いた場合に無言で失敗しないよう、明示的にエラーを出す。
    console.error('❌ グローバルfetchが利用できません（Node 18+が必要です）。LINE通知を送信できませんでした。');
    return { simulated: false, ok: false, status: 0, body: 'global fetch unavailable' };
  }

  try {
    const response = await fetch(LINE_PUSH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${channelAccessToken}`
      },
      body: JSON.stringify({
        to: toUserId,
        messages: [{ type: 'text', text }]
      })
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '(本文取得失敗)');
      console.error(`❌ LINEプッシュ送信失敗 status=${response.status} body=${errorBody}`);
      return { simulated: false, ok: false, status: response.status, body: errorBody };
    }

    return { simulated: false, ok: true, status: response.status };
  } catch (e) {
    console.error('❌ LINEプッシュ送信中に例外が発生しました:', e.message);
    return { simulated: false, ok: false, status: 0, body: e.message };
  }
}

// ----------------------------------------------------------------------------
// ★2026-09-21追加：replyMessage(channelAccessToken, replyToken, text, buttonUrl)
//   GAS版webhook_handler.gsのreplyMessage_相当。Webhookイベントに付いてくる
//   replyTokenを使った返信（プッシュと違い、友だち追加直後などでも送れて、
//   1回の応答あたりの送信数コストがかからない）。
//   buttonUrlを渡すと、GAS版と同じ「本文＋『予約画面を開く』ボタン」のFlex
//   Messageを組み立てる。省略時は通常のテキストメッセージになる。
//
//   pushMessageと同じく、channelAccessTokenが未設定の場合は実送信せず
//   コンソールログのみの「開発用シミュレーション」動作にする。
// ----------------------------------------------------------------------------
async function replyMessage(channelAccessToken, replyToken, text, buttonUrl) {
  if (!channelAccessToken) {
    console.log(`📱 [開発用/LINE未設定] 本来ならreplyToken=${replyToken} 宛にLINE返信: ${text}${buttonUrl ? ' (ボタン: ' + buttonUrl + ')' : ''}`);
    return { simulated: true };
  }
  if (typeof fetch !== 'function') {
    console.error('❌ グローバルfetchが利用できません（Node 18+が必要です）。LINE返信を送信できませんでした。');
    return { simulated: false, ok: false, status: 0, body: 'global fetch unavailable' };
  }

  const message = buttonUrl
    ? {
        type: 'flex',
        altText: text,
        contents: {
          type: 'bubble',
          body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text, wrap: true, size: 'md' }] },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [{
              type: 'button', style: 'primary', color: '#C8A0B4',
              action: { type: 'uri', label: '予約画面を開く', uri: buttonUrl }
            }]
          }
        }
      }
    : { type: 'text', text };

  try {
    const response = await fetch(LINE_REPLY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channelAccessToken}` },
      body: JSON.stringify({ replyToken, messages: [message] })
    });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '(本文取得失敗)');
      console.error(`❌ LINEリプライ送信失敗 status=${response.status} body=${errorBody}`);
      return { simulated: false, ok: false, status: response.status, body: errorBody };
    }
    return { simulated: false, ok: true, status: response.status };
  } catch (e) {
    console.error('❌ LINEリプライ送信中に例外が発生しました:', e.message);
    return { simulated: false, ok: false, status: 0, body: e.message };
  }
}

// ----------------------------------------------------------------------------
// ★2026-09-21追加：getLineDisplayName(channelAccessToken, userId)
//   GAS版のgetLineDisplayName_相当。友だち追加時にお客様のLINE表示名を取得し、
//   あいさつメッセージの{NICKNAME}差し込みに使う。トークン未設定・取得失敗時は
//   空文字を返す（呼び出し側でデフォルト文言にフォールバックする設計は既存のまま）。
// ----------------------------------------------------------------------------
async function getLineDisplayName(channelAccessToken, userId) {
  if (!channelAccessToken || typeof fetch !== 'function') return '';
  try {
    const response = await fetch(LINE_PROFILE_ENDPOINT + encodeURIComponent(userId), {
      headers: { Authorization: `Bearer ${channelAccessToken}` }
    });
    if (!response.ok) return '';
    const profile = await response.json();
    return profile.displayName || '';
  } catch (e) {
    console.error('❌ LINE表示名取得エラー:', e.message);
    return '';
  }
}

module.exports = { verifyLineSignature, pushMessage, replyMessage, getLineDisplayName };
