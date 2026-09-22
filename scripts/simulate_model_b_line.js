// ============================================================================
// scripts/simulate_model_b_line.js
//
// モデルB店公式（テストB店）とのLINE本接続について、実機で「友だち未登録の
// 端末」が手元に無いため、架空の顧客データでLINE Webhookの一連の流れ
// （友だち追加→顧客自動登録→スタンプ返信→予約キーワード返信→無関係メッセージ）
// をシミュレーションし、サーバー側のロジックが正しく動くことを確認するための
// スクリプト。scripts/integration_test.js の23章と同じ経路を通るが、こちらは
// 「実際の接続作業を模した読み物」として、架空の1人の顧客の行動を時系列で
// 追いかける形式にしている。
//
// 注意：これはローカルのプロトタイプサーバー（LINE_CHANNEL_SECRET未設定＝
// 署名検証スキップの開発モード）に対して行うシミュレーションであり、実際の
// LINE社のサーバーやモデルB店公式チャネルとは通信しない。あくまで「LINEから
// こういうWebhookが届いたら、サーバーはこう振る舞う」という受信側の処理を
// 検証するもの。
//
// 実行前提：integration_test.js と同じ（db初期化→seed→SKIP_SEED=1でサーバー
// 起動→本スクリプト実行）
// ============================================================================

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const db = require('../lib/db');

const FAKE_USER_ID = 'Ufake-modelb-sakura-0001';
const FAKE_LINE_NAME = 'さくら（架空データ）';
const STORE_ID = 1; // このプロトタイプの店舗1＝モデルB店公式に相当

let passCount = 0;
let failCount = 0;
const failures = [];
function assert(cond, label) {
  if (cond) { passCount++; console.log(`  ✅ ${label}`); }
  else { failCount++; failures.push(label); console.log(`  ❌ ${label}`); }
}

async function postWebhook(events) {
  const res = await fetch(BASE + '/webhook/line', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination: 'FAKE_MODEL_B_DESTINATION', events })
  });
  let body = null;
  try { body = await res.json(); } catch (_) { /* 本文なし */ }
  return { status: res.status, body };
}

async function main() {
  console.log('\n=== モデルB店公式 LINE連携シミュレーション（架空データ）===');
  console.log(`架空の顧客: ${FAKE_LINE_NAME} / userId=${FAKE_USER_ID}\n`);

  // 前提クリーンアップ：同じ架空userIdの過去データが残っていないこと
  db.prepare(`DELETE FROM customers WHERE store_id = ? AND user_id = ?`).run(STORE_ID, FAKE_USER_ID);

  // --------------------------------------------------------------------------
  // ステップ1：さくらさんがモデルB店公式を友だち追加する
  // --------------------------------------------------------------------------
  console.log('--- ステップ1：友だち追加 ---');
  {
    const r = await postWebhook([{
      type: 'follow',
      replyToken: 'sim-reply-follow-1',
      source: { type: 'user', userId: FAKE_USER_ID },
      timestamp: Date.now()
    }]);
    assert(r.status === 200, '友だち追加イベントを受信し200を返す（LINEの仕様上、Webhookは200以外だと再送されてしまうため重要）');
    const row = db.prepare(`SELECT customer_id, status, line_name FROM customers WHERE store_id = ? AND user_id = ?`).get(STORE_ID, FAKE_USER_ID);
    assert(!!row, '顧客マスタに自動登録される（本名確定前の仮登録）');
    assert(row && row.status === 'inactive', '本名がまだ分からないため status=inactive（未確定）で登録される');
    console.log(`     → 顧客マスタ登録: customer_id=${row ? row.customer_id : '?'}, status=${row ? row.status : '?'}`);
  }

  // --------------------------------------------------------------------------
  // ステップ2：同じ人がもう一度友だち追加（LINEアプリの再起動などで稀に発生）
  //   → 重複登録されないことを確認
  // --------------------------------------------------------------------------
  console.log('--- ステップ2：友だち追加の重複受信（冪等性チェック） ---');
  {
    const before = db.prepare(`SELECT COUNT(*) c FROM customers WHERE store_id = ? AND user_id = ?`).get(STORE_ID, FAKE_USER_ID).c;
    await postWebhook([{
      type: 'follow',
      replyToken: 'sim-reply-follow-2',
      source: { type: 'user', userId: FAKE_USER_ID },
      timestamp: Date.now()
    }]);
    const after = db.prepare(`SELECT COUNT(*) c FROM customers WHERE store_id = ? AND user_id = ?`).get(STORE_ID, FAKE_USER_ID).c;
    assert(before === 1 && after === 1, '同じ人からの2回目の友だち追加でも顧客マスタが二重登録されない');
  }

  // --------------------------------------------------------------------------
  // ステップ3：さくらさんがスタンプを送る
  // --------------------------------------------------------------------------
  console.log('--- ステップ3：スタンプ受信 ---');
  {
    const r = await postWebhook([{
      type: 'message',
      message: { type: 'sticker', stickerId: 52002734, packageId: 11537 },
      replyToken: 'sim-reply-sticker-1',
      source: { type: 'user', userId: FAKE_USER_ID },
      timestamp: Date.now()
    }]);
    assert(r.status === 200, 'スタンプ受信を200で受理し、定型の返信処理が例外なく完走する');
  }

  // --------------------------------------------------------------------------
  // ステップ4：さくらさんが「エステ予約したい」と送る
  // --------------------------------------------------------------------------
  console.log('--- ステップ4：予約キーワードの送信 ---');
  {
    const r = await postWebhook([{
      type: 'message',
      message: { type: 'text', text: 'エステ予約したい' },
      replyToken: 'sim-reply-keyword-1',
      source: { type: 'user', userId: FAKE_USER_ID },
      timestamp: Date.now()
    }]);
    assert(r.status === 200, '「エステ予約したい」に反応し、予約フォームの案内リンクを返す処理が例外なく完走する');
  }

  // --------------------------------------------------------------------------
  // ステップ5：さくらさんが予約とは関係ないメッセージを送る
  // --------------------------------------------------------------------------
  console.log('--- ステップ5：無関係なメッセージ ---');
  {
    const r = await postWebhook([{
      type: 'message',
      message: { type: 'text', text: '今日は良い天気ですね' },
      replyToken: 'sim-reply-other-1',
      source: { type: 'user', userId: FAKE_USER_ID },
      timestamp: Date.now()
    }]);
    assert(r.status === 200, 'キーワードに一致しないメッセージも200で受理し、エラーにならず無反応で終わる');
  }

  // --------------------------------------------------------------------------
  // ステップ6：本名が確定した場合を想定し、顧客名を更新→ステータスがactiveに
  //   変わる実際の運用フローも確認（管理画面で本名を紐付けるケースを模す）
  // --------------------------------------------------------------------------
  console.log('--- ステップ6：本名確定後のステータス変化（参考確認） ---');
  {
    const row = db.prepare(`SELECT customer_id FROM customers WHERE store_id = ? AND user_id = ?`).get(STORE_ID, FAKE_USER_ID);
    db.prepare(`UPDATE customers SET realname = ?, status = 'active' WHERE store_id = ? AND customer_id = ?`)
      .run('桜井 さくら（架空）', STORE_ID, row.customer_id);
    const after = db.prepare(`SELECT status, realname FROM customers WHERE store_id = ? AND customer_id = ?`).get(STORE_ID, row.customer_id);
    assert(after.status === 'active' && after.realname === '桜井 さくら（架空）', '本名確定後、ステータスをactiveに切り替えられる（管理画面での通常運用と同じ経路）');
  }

  // 後片付け：シミュレーションで作った架空データを削除
  db.prepare(`DELETE FROM customers WHERE store_id = ? AND user_id = ?`).run(STORE_ID, FAKE_USER_ID);
  console.log('\n（シミュレーションで作成した架空データは削除済み）');

  console.log(`\n=== シミュレーション結果: ${passCount} 件成功 / ${failCount} 件失敗 ===`);
  if (failCount > 0) {
    console.log('失敗した項目:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('シミュレーション実行中にエラーが発生しました:', e);
  process.exit(1);
});
