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
//   GET  /api/admin/customers    【オーナー管理画面】顧客マスタ検索（要ログインセッション・オーナー権限）
//   GET  /api/admin/reservations 【オーナー管理画面】予約データ検索（要ログインセッション・オーナー権限）
//   GET  /api/admin/dashboard    【オーナー管理画面】ダッシュボード集計（要ログインセッション・オーナー権限）
//   POST /api/auth/login         スタッフPINログイン（4桁PIN、GAS版の電話番号下4桁運用を踏襲）
//   POST /api/auth/logout        ログアウト（セッション破棄）
//   GET  /api/auth/me            現在のログイン状態確認
//   POST /webhook/line            LINE Messaging API Webhook受信（routes/lineWebhook.js）
//
// これは商用のVPS＋MySQL本番システムではなく、
// 「予約エンジンのコアロジックがNode.jsで正しく動くこと」を実証するプロトタイプです。
// ============================================================================

const express = require('express');
const path = require('path');
const session = require('express-session');
const db = require('./lib/db');
const engine = require('./lib/reservationEngine');
const { initDatabase } = require('./db/init');
const { verifyPin } = require('./lib/auth');
const { registerLineWebhook } = require('./routes/lineWebhook');
const { notifyReservationConfirmed } = require('./lib/reservationNotify');

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

// ----------------------------------------------------------------------------
// ★LINE Webhook（/webhook/line）は、生のリクエストボディ（Buffer）でないと
//   署名検証ができないため、express.json() より前にマウントする必要がある。
//   routes/lineWebhook.js 内で express.raw() をこのパスにだけ適用している。
//   （app.use(express.json())は全ルート共通でボディをパース済みJSONに変換して
//    しまい、元のバイト列が失われるため、この順序を崩すと署名検証が壊れる）
// ----------------------------------------------------------------------------
registerLineWebhook(app);

app.use(express.json());

// ----------------------------------------------------------------------------
// セッション設定
//   SESSION_SECRET環境変数が無い場合、開発用の固定値を使い起動時に警告する
//   （ADMIN_PASSWORDの警告パターンを踏襲）。
//   【本番移行メモ】デフォルトのMemoryStoreは「単一プロセス・プロトタイプ」には
//   十分だが、本番のVPS＋MySQL構成ではプロセス再起動でセッションが消える／
//   複数プロセス間で共有できない問題があるため、connect-mysql2等の
//   永続化されたセッションストアに差し替えること。
// ----------------------------------------------------------------------------
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-session-secret';
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET 環境変数が未設定のため、開発用の固定値を使用しています。本番運用前に必ず環境変数で設定してください。');
}
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000 // 8時間
  }
  // store: 未指定＝デフォルトのMemoryStore（本番では差し替え必須。上記コメント参照）
}));

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

    // ★LINE通知はあくまで付加機能。ここでの失敗（未設定・API障害等）が
    //   予約登録の成功レスポンスを妨げてはならないため、awaitせずfire-and-forgetし、
    //   例外は.catchで握りつぶしてログにのみ残す（詳細は lib/reservationNotify.js 参照）。
    try {
      if (data.customerId) {
        const customer = db.prepare(
          'SELECT * FROM customers WHERE store_id = ? AND customer_id = ?'
        ).get(storeId, data.customerId);
        const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
        notifyReservationConfirmed(store, customer, {
          staffName: data.staffName,
          menu: data.menu,
          date: data.date,
          time: data.time
        }).catch((notifyErr) => {
          console.error('LINE通知処理でエラー（予約自体は成功しているため無視）:', notifyErr);
        });
      }
    } catch (notifySyncErr) {
      console.error('LINE通知の呼び出し準備でエラー（予約自体は成功しているため無視）:', notifySyncErr);
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

// ============================================================================
// 認証 API（/api/auth/*）とオーナー用管理画面 API（/api/admin/*）
//
// 【ログイン方式について】
//   GAS版の実運用に合わせ、スタッフは「電話番号の下4桁」を4桁PINとして
//   ログインする（店舗＋PINで staff テーブルを照合）。
//   PINは lib/auth.js の scrypt ハッシュ関数で照合する（平文比較はしない）。
//   ログイン成功時は req.session.staff にセッション情報を保存し、
//   以降の /api/admin/* リクエストはこのセッションの storeId でスコープする
//   （クライアントから任意の ?store= を渡しても無視し、セッションの店舗を使う。
//   複数店舗展開時に、あるオーナーが他店のデータを覗けてしまう事故を防ぐため）。
//
//   このプロトタイプ段階では is_owner=1 のスタッフのみ管理画面に入れる。
//   一般スタッフのログイン自体は将来のスタッフ向け画面のための足場として
//   用意してあるが、現状は明示的にブロックする。
// ============================================================================

// ----------------------------------------------------------------------------
// POST /api/auth/login : { store, pin } でログインし、成功時はセッションを発行する
// ----------------------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  try {
    const { store, pin } = req.body || {};
    if (!store || !pin) {
      return res.status(400).json({ success: false, message: 'store と pin は必須です' });
    }
    const storeId = resolveStoreId(store);
    const candidates = db.prepare(
      'SELECT * FROM staff WHERE store_id = ? AND is_active = 1 AND pin_hash IS NOT NULL'
    ).all(storeId);

    const matched = candidates.find((s) => verifyPin(pin, s.pin_salt, s.pin_hash));

    if (!matched) {
      return res.status(401).json({ success: false, message: 'PINが正しくありません' });
    }

    if (!matched.is_owner) {
      // ★あえて生成失敗と区別したメッセージを返す：将来の一般スタッフ向け機能が
      //   実装されたときにこの分岐を外すだけで済むように、扉は開けたまま明示ブロックする。
      return res.status(403).json({
        success: false,
        message: '現在はオーナー権限のみログインできます（プロトタイプ版）'
      });
    }

    req.session.staff = {
      id: matched.id,
      storeId: matched.store_id,
      name: matched.name,
      isOwner: !!matched.is_owner
    };

    res.json({ success: true, staffName: matched.name, storeId: matched.store_id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/auth/logout : セッション破棄
// ----------------------------------------------------------------------------
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// ----------------------------------------------------------------------------
// GET /api/auth/me : 現在のログイン状態を返す
// ----------------------------------------------------------------------------
app.get('/api/auth/me', (req, res) => {
  if (!req.session || !req.session.staff) {
    return res.status(401).json({ success: false, message: 'ログインしていません' });
  }
  res.json({ success: true, staff: req.session.staff });
});

// ----------------------------------------------------------------------------
// requireOwnerSession : /api/admin/* をセッション＋オーナー権限で保護するミドルウェア
// ----------------------------------------------------------------------------
function requireOwnerSession(req, res, next) {
  if (!req.session || !req.session.staff || !req.session.staff.isOwner) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ----------------------------------------------------------------------------
// ★旧実装（廃止・置き換え済み）：requireAdminPassword
//   共有パスワード1個をヘッダーで送るだけの簡易認証。/api/admin/* は現在
//   requireOwnerSession（セッションベース）に置き換わっており、この関数は
//   どのルートからも呼ばれていない。他コードから参照されている可能性を考慮し
//   削除はせず残してあるが、新規に使うべきではない。
// ----------------------------------------------------------------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'demo1234';
if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD 環境変数が未設定のため、デフォルトパスワード "demo1234" を使用しています（この変数自体は/api/admin/*では現在未使用です）。');
}

function requireAdminPassword(req, res, next) {
  const supplied = req.get('X-Admin-Password');
  if (supplied !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ----------------------------------------------------------------------------
// GET /api/admin/customers?store=&q=&limit=&offset=
//   顧客マスタの一覧・検索（氏名／フリガナ／電話番号の部分一致）
// ----------------------------------------------------------------------------
app.get('/api/admin/customers', requireOwnerSession, (req, res) => {
  try {
    // ★セッションの店舗に固定。?storeが渡されても無視する（他店データ閲覧防止）。
    const storeId = req.session.staff.storeId;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const q = (req.query.q || '').trim();

    let where = 'store_id = ?';
    const params = [storeId];
    if (q) {
      where += ' AND (realname LIKE ? OR kana LIKE ? OR phone LIKE ?)';
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const total = db.prepare(`SELECT COUNT(*) AS c FROM customers WHERE ${where}`).get(...params).c;
    const rows = db.prepare(`
      SELECT * FROM customers WHERE ${where}
      ORDER BY realname ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ total, limit, offset, customers: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/admin/reservations?store=&from=&to=&staffName=&q=&limit=&offset=
//   予約データの一覧・検索（日付範囲＋担当者＋氏名部分一致）。新しい日付順。
// ----------------------------------------------------------------------------
app.get('/api/admin/reservations', requireOwnerSession, (req, res) => {
  try {
    // ★セッションの店舗に固定。?storeが渡されても無視する（他店データ閲覧防止）。
    const storeId = req.session.staff.storeId;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    let where = 'store_id = ?';
    const params = [storeId];
    if (req.query.from) { where += ' AND reservation_date >= ?'; params.push(req.query.from); }
    if (req.query.to)   { where += ' AND reservation_date <= ?'; params.push(req.query.to); }
    if (req.query.staffName) { where += ' AND staff_name = ?'; params.push(req.query.staffName); }
    if (req.query.q) {
      where += ' AND (realname LIKE ? OR kana LIKE ?)';
      const like = `%${req.query.q}%`;
      params.push(like, like);
    }

    const total = db.prepare(`SELECT COUNT(*) AS c FROM reservations WHERE ${where}`).get(...params).c;
    const rows = db.prepare(`
      SELECT * FROM reservations WHERE ${where}
      ORDER BY reservation_date DESC, reservation_time DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ total, limit, offset, reservations: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/admin/dashboard?store=
//   オーナー向けダッシュボード用のサマリー数値をまとめて返す。
// ----------------------------------------------------------------------------
app.get('/api/admin/dashboard', requireOwnerSession, (req, res) => {
  try {
    // ★セッションの店舗に固定。?storeが渡されても無視する（他店データ閲覧防止）。
    const storeId = req.session.staff.storeId;

    const fmt = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayStr = fmt(today);

    // 今週：月曜始まりで today を含む週
    const dow = (today.getDay() + 6) % 7; // 0=月曜
    const weekStart = new Date(today); weekStart.setDate(today.getDate() - dow);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);

    const countActive = (whereExtra, params) => db.prepare(`
      SELECT COUNT(*) AS c FROM reservations
      WHERE store_id = ? AND realname != 'キャンセル' ${whereExtra}
    `).get(storeId, ...params).c;

    const todayCount = countActive('AND reservation_date = ?', [todayStr]);
    const weekCount = countActive('AND reservation_date >= ? AND reservation_date <= ?', [fmt(weekStart), fmt(weekEnd)]);

    const upcoming7Days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today); d.setDate(today.getDate() + i);
      const dateStr = fmt(d);
      const c = countActive('AND reservation_date = ?', [dateStr]);
      upcoming7Days.push({ date: dateStr, count: c });
    }

    const totalCustomers = db.prepare('SELECT COUNT(*) AS c FROM customers WHERE store_id = ?').get(storeId).c;
    const totalReservations = db.prepare(`
      SELECT COUNT(*) AS c FROM reservations WHERE store_id = ? AND realname != 'キャンセル'
    `).get(storeId).c;

    res.json({
      today: todayStr,
      todayCount,
      weekCount,
      upcoming7Days,
      totalCustomers,
      totalReservations
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 予約管理プロトタイプ サーバー起動: http://localhost:${PORT}`);
});
