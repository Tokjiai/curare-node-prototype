// ============================================================================
// server.js
// サロン予約管理システム プロトタイプ用 Expressサーバー
//
// エンドポイント：
//   GET  /api/store              店舗・スタッフ・ゾーン情報の取得（フロント初期表示用）
//   GET  /api/availability       空き状況取得（GAS版 getZoneStatus_ ベース）
//   GET  /api/timeslots          ゾーン内の具体的な予約可能時刻一覧（GAS版 getTimeSlotsByZone ベース）
//   POST /api/reservations       予約作成
//   GET  /api/reservations       予約一覧取得
//
// これは商用のVPS＋MySQL本番システムではなく、
// 「予約エンジンのコアロジックがNode.jsで正しく動くこと」を実証するプロトタイプです。
// ============================================================================

const express = require('express');
const path = require('path');
const db = require('./lib/db');
const engine = require('./lib/reservationEngine');
const { initDatabase } = require('./db/init');

// Render無料プランのディスクは再起動で消える（エフェメラル）ため、
// 起動のたびにスキーマ作成とシードデータ投入をやり直す。
// プロトタイプなのでデータの永続性は割り切っている。
// ★SKIP_SEED=1 を指定した場合は再投入しない（バックアップ復元テストなど、
//   既存データをそのまま使いたい場合に使用）。
if (process.env.SKIP_SEED === '1') {
  const fs = require('fs');
  const schemaSql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql); // テーブルが無い場合のみ作成（IF NOT EXISTSなのでデータは消えない）
  console.log('⏭️  SKIP_SEED=1 のためシードデータの再投入をスキップしました（既存データを保持）');
} else {
  initDatabase();
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULT_STORE_ID = 1;

// storeパラメータ（slug）からstore_idを解決する。省略時はデフォルト店舗。
function resolveStoreId(storeSlugOrId) {
  if (!storeSlugOrId) return DEFAULT_STORE_ID;
  const byId = db.prepare('SELECT id FROM stores WHERE id = ?').get(Number(storeSlugOrId));
  if (byId) return byId.id;
  const bySlug = db.prepare('SELECT id FROM stores WHERE slug = ?').get(storeSlugOrId);
  return bySlug ? bySlug.id : DEFAULT_STORE_ID;
}

// ----------------------------------------------------------------------------
// GET /api/store : 店舗情報・スタッフ一覧・ゾーン設定をまとめて返す
// ----------------------------------------------------------------------------
app.get('/api/store', (req, res) => {
  const storeId = resolveStoreId(req.query.store);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  const staffList = engine.getCustomerStaffList_(storeId);
  const zones = engine.getZonesConfig_(storeId);
  res.json({ store, staffList, zones });
});

// ----------------------------------------------------------------------------
// GET /api/availability?store=...&date=...&staffId=...
//   指定日・指定スタッフ（省略で指名なし）の全ゾーンの空き状況を返す。
//   GAS版 getZoneStatus_ をそのまま呼び出しているだけ（ロジックの追加・変更なし）。
// ----------------------------------------------------------------------------
app.get('/api/availability', (req, res) => {
  try {
    const storeId = resolveStoreId(req.query.store);
    const dateStr = req.query.date;
    if (!dateStr) return res.status(400).json({ error: 'date パラメータは必須です（YYYY-MM-DD）' });

    // staffId: 'nopref' または省略なら指名なし（staffName=null）
    let staffName = null;
    if (req.query.staffId && req.query.staffId !== 'nopref') {
      const staffList = engine.getCustomerStaffList_(storeId);
      const found = staffList.find((s) => s.id === req.query.staffId || s.realName === req.query.staffId);
      staffName = found ? found.realName : req.query.staffId;
    }

    const zones = engine.getZonesConfig_(storeId);
    const result = zones.map((zone) => ({
      key: zone.key,
      label: zone.label,
      start: zone.start,
      end: zone.end,
      status: engine.getZoneStatus_(storeId, staffName, dateStr, zone)
    }));

    res.json({ date: dateStr, staffId: req.query.staffId || 'nopref', zones: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/timeslots?store=...&date=...&staffId=...&zone=...
//   ゾーンを選んだあとの具体的な予約可能時刻一覧を返す（GAS版 getTimeSlotsByZone ベース）
// ----------------------------------------------------------------------------
app.get('/api/timeslots', (req, res) => {
  try {
    const storeId = resolveStoreId(req.query.store);
    const dateStr = req.query.date;
    const zoneKey = req.query.zone;
    const staffId = req.query.staffId || 'nopref';
    if (!dateStr || !zoneKey) return res.status(400).json({ error: 'date と zone パラメータは必須です' });
    const slots = engine.getTimeSlotsByZone(storeId, staffId, dateStr, zoneKey);
    res.json({ date: dateStr, zone: zoneKey, staffId, slots });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/reservations?store=...
//   予約一覧取得（キャンセルされたものを除く、日付昇順）
// ----------------------------------------------------------------------------
app.get('/api/reservations', (req, res) => {
  const storeId = resolveStoreId(req.query.store);
  const rows = db.prepare(`
    SELECT * FROM reservations
    WHERE store_id = ? AND realname != 'キャンセル'
    ORDER BY reservation_date ASC, reservation_time ASC
  `).all(storeId);
  res.json({ reservations: rows });
});

// ----------------------------------------------------------------------------
// POST /api/reservations
//   予約作成。GAS版 addReservationUnified_body_ の主要ロジック
//   （同一顧客の予約上限チェック→登録）を移植。LINE通知・カレンダー同期は対象外。
// ----------------------------------------------------------------------------
app.post('/api/reservations', (req, res) => {
  try {
    const data = req.body || {};
    const storeId = resolveStoreId(data.store);

    if (!data.realname || !data.staffName || !data.date || !data.time || !data.menu) {
      return res.status(400).json({ error: 'realname / staffName / date / time / menu は必須です' });
    }

    // ★GAS版 addReservationUnified_body_ を踏襲：確定予約の上限チェック
    const limitCheck = engine.checkCustomerReservationLimit(storeId, data.realname, null);
    if (limitCheck.exceeded && !data.ownerOverride) {
      return res.status(200).json({
        success: false,
        isLimitWarning: true,
        message: `${data.realname}様の確定予約が${limitCheck.count}件あります（上限${limitCheck.limit}件）。このまま登録しますか？`,
        count: limitCheck.count,
        limit: limitCheck.limit
      });
    }

    const insert = db.prepare(`
      INSERT INTO reservations
        (store_id, realname, kana, line_name, user_id, staff_name, menu, reservation_date, reservation_time, note, editor, line_sent, done, customer_id, status)
      VALUES
        (@store_id, @realname, @kana, @line_name, @user_id, @staff_name, @menu, @reservation_date, @reservation_time, @note, @editor, 0, 0, @customer_id, '確定')
    `);

    // ★2026-09-18追加：二重予約防止の実地テストで発覚した穴を修正。
    //   INSERT自体をUNIQUE制約違反キャッチ付きで実行することで、同時に複数の
    //   登録リクエストが来ても、DBレベルで1件しか通らないことを保証する。
    let info;
    try {
      info = insert.run({
        store_id: storeId,
        realname: data.realname,
        kana: data.kana || '',
        line_name: data.lineName || '',
        user_id: data.userId || '',
        staff_name: data.staffName,
        menu: data.menu,
        reservation_date: data.date,
        reservation_time: data.time,
        note: data.note || '',
        editor: data.editor || 'お客様フォーム',
        customer_id: data.customerId || ''
      });
    } catch (constraintErr) {
      if (String(constraintErr.message).includes('UNIQUE constraint failed')) {
        return res.status(409).json({
          success: false,
          isDoubleBooking: true,
          message: '申し訳ございません、ちょうど他の方の予約でこの枠が埋まりました。別の時間帯をお選びください。'
        });
      }
      throw constraintErr;
    }

    res.json({ success: true, message: '✅ 予約を登録しました', reservationId: info.lastInsertRowid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// DELETE /api/reservations/:id : GAS版のキャンセル運用（realname列に'キャンセル'を入れる方式）を踏襲
// ----------------------------------------------------------------------------
app.delete('/api/reservations/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    db.prepare(`UPDATE reservations SET realname = 'キャンセル', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 予約管理プロトタイプ サーバー起動: http://localhost:${PORT}`);
});
