// ============================================================================
// lib/scheduler.js
// ★2026-09-23追加：常設スケジューラ（GAS版の時間主導トリガー相当）。
//
// 【背景】v54では日次LINEレポート4種（前日リマインダー・朝レポート・夕方レポート・
//   スタッフ翌日予約通知）と日次メンテナンス処理を「オーナー管理画面の手動ボタン」
//   としてのみ実装していたが、社長より「オーナー管理画面からの手動送信ボタンとして
//   実装ではこまります。GAS版のような日次の定期配信を常設スケジューラーを作って
//   実装してください」との明確な指摘を受け、node-cronによる本物の自動実行に置き換える。
//
// 【GAS版との対応関係】GAS版のtriggers.jsには7つのトリガー関数（コード.js側の
//   runForEachActiveStore_でラップし、店舗ごとにtry/catch）が定義されていたが、
//   実行時刻（毎日何時に動かすか）はApps Scriptプロジェクトの「トリガー」画面で
//   手動設定されており、コード上には一切残っていない（要調査済み：ScriptApp.newTrigger
//   系のインストールコードはGASソース全体に存在しない）。唯一REMINDER_HOURだけは
//   admin_ui_functions.js/owner_ui.htmlのrule1編集項目として実在する「店舗ごとに
//   設定可能な値」だったため、Node版でもそこだけは店舗別rules値として扱う。
//
//   日次メンテナンス・朝レポート・夕方レポートの3つは、GAS版に相当する設定項目が
//   見つからなかったため、このプロトタイプ独自の妥当な既定値（DAILY_MAINTENANCE_HOUR=5,
//   MORNING_REPORT_HOUR=8, EVENING_REPORT_HOUR=20）を新設し、既存のrulesテーブルの
//   仕組み（店舗ごとにオーナー管理画面から変更可能）にそのまま乗せている。
//
// 【設計】GAS版runForEachActiveStore_と同じく、全店舗（SELECT id FROM stores。
//   storesテーブルにis_active相当の列は無いため全件対象）をループし、店舗ごとに
//   try/catchで独立させる（1店舗の失敗が他店舗の処理を止めないように）。
//
//   前日リマインダーだけは店舗ごとに実行時刻が異なりうる（REMINDER_HOUR）ため、
//   1時間おきのチェックジョブを常駐させ、「現在時刻（JST）＝その店舗のREMINDER_HOUR」
//   と一致した店舗だけ実行する（同じ時刻内で二重実行されても、対象予約は
//   reminder_sent=1で除外されるため実害は無い＝冪等）。
//
// 【Renderの無料枠に関する重要な制約】★必ずREADME_PROTOTYPE.md・報告時に明記すること。
//   Renderの無料プランはアクセスが一定時間無いとサービスがスリープし、次のHTTP
//   リクエストが来るまで再起動しない。node-cronはプロセス内で動くタイマーのため、
//   スリープ中は当然発火しない。つまりこの常設スケジューラは「サービスが起きている
//   時間帯」しか機能せず、GAS版のように24時間確実に発火する保証は無い。
//   本番相当の信頼性を得るには、①外部の死活監視／定期pingサービスでスリープさせない
//   ②Renderの有料プラン（常時起動）へアップグレード③計画済みのVPS移行、のいずれかが
//   必要（README §55に詳細記載）。
// ============================================================================

const cron = require('node-cron');
const { runDailyMaintenance } = require('./maintenance');
const dailyReports = require('./dailyReports');

const TIMEZONE = 'Asia/Tokyo';

function getAllStoreIds(db) {
  return db.prepare('SELECT id FROM stores').all().map((r) => r.id);
}

function getRuleHour(engine, storeId, ruleId, defaultHour) {
  // ★getRuleValue_は該当ルールが無い場合nullを返すが、Number(null)は0になってしまい
  //   「0時」という有効な時刻と区別が付かなくなる（実際にこの取り違えでテストが落ちた）。
  //   そのため、まずraw値がnull/未設定でないかを先にチェックしてからNumber変換する。
  const raw = engine.getRuleValue_(storeId, ruleId);
  if (raw === null || raw === undefined || raw === '') return defaultHour;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 && v <= 23 ? v : defaultHour;
}

// runForEachActiveStore_相当：店舗ごとにtry/catchしながら順に実行する
async function runForEachStore(db, label, fn) {
  const storeIds = getAllStoreIds(db);
  for (const storeId of storeIds) {
    try {
      await fn(storeId);
    } catch (e) {
      console.error(`⏰ [スケジューラ] ${label}（store_id=${storeId}）でエラー:`, e.message);
    }
  }
}

// ----------------------------------------------------------------------------
// 「今この瞬間（JST）が対象時刻か」を毎時0分にチェックし、店舗のルール値と
// 一致する店舗だけ実行する方式。固定時刻ジョブ（日次メンテ・朝/夕レポート）も
// 「店舗ごとに設定変更できる」という将来の拡張性を見込んで同じ仕組みに統一している
// （DAILY_MAINTENANCE_HOUR等はrulesテーブルの値としてオーナー管理画面からも変更可能）。
// ----------------------------------------------------------------------------
function startScheduler(db, engine) {
  console.log('⏰ 常設スケジューラを起動しました（node-cron、毎時0分にチェック、タイムゾーン: Asia/Tokyo）');

  // 毎時0分：4種類すべてのチェックをまとめて行う（GAS版は別々のトリガーだったが、
  // Node版は「その時刻設定と現在時刻が一致するか」を都度判定する方式のため1つのcronで足りる）
  cron.schedule('0 * * * *', async () => {
    const now = new Date();
    const currentHour = now.getHours(); // サーバーのタイムゾーンをAsia/Tokyoに揃えて運用する前提（README明記）

    await runForEachStore(db, '日次メンテナンス', async (storeId) => {
      const hour = getRuleHour(engine, storeId, 'DAILY_MAINTENANCE_HOUR', 5);
      if (hour !== currentHour) return;
      const result = runDailyMaintenance(db, engine, storeId);
      console.log(`⏰ [スケジューラ] 日次メンテナンス実行（store_id=${storeId}）:`, JSON.stringify(result));
    });

    await runForEachStore(db, '朝レポート', async (storeId) => {
      const hour = getRuleHour(engine, storeId, 'MORNING_REPORT_HOUR', 8);
      if (hour !== currentHour) return;
      const result = await dailyReports.sendMorningReportToOwner(db, storeId);
      console.log(`⏰ [スケジューラ] 朝レポート送信（store_id=${storeId}）: sentTo=${result.sentTo}`);
    });

    await runForEachStore(db, '夕方レポート', async (storeId) => {
      const hour = getRuleHour(engine, storeId, 'EVENING_REPORT_HOUR', 20);
      if (hour !== currentHour) return;
      // ★GAS版と同じく、夕方レポートの中でスタッフ翌日予約通知も「相乗り」で送信される
      //   （dailyReports.sendEveningReportToOwner内部でsendStaffTomorrowScheduleを呼ぶ設計）
      const result = await dailyReports.sendEveningReportToOwner(db, storeId);
      console.log(`⏰ [スケジューラ] 夕方レポート送信（store_id=${storeId}）:`, JSON.stringify({
        mainSentTo: result.mainReport && result.mainReport.sentTo,
        staffNotified: result.staffSchedule && result.staffSchedule.notifiedCount
      }));
    });

    await runForEachStore(db, '前日リマインダー', async (storeId) => {
      // ★REMINDER_HOURはGAS版でも実在する店舗別設定値。店舗ごとに異なる時刻を
      //   指定できる（例：A店は18時、B店は19時、等）
      const hour = getRuleHour(engine, storeId, 'REMINDER_HOUR', 18);
      if (hour !== currentHour) return;
      const result = await dailyReports.sendDayBeforeReminders(db, storeId);
      console.log(`⏰ [スケジューラ] 前日リマインダー送信（store_id=${storeId}）: sentCount=${result.sentCount}/${result.targetCount}`);
    });
  }, { timezone: TIMEZONE });
}

module.exports = { startScheduler, runForEachStore, getRuleHour };
