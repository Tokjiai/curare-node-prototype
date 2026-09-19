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
const { verifyPin, createPinHash } = require('./lib/auth');
const { registerLineWebhook } = require('./routes/lineWebhook');
const { notifyReservationConfirmed } = require('./lib/reservationNotify');
const { getPlan, listPlans } = require('./lib/plans');

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
// ★2026-09-19追加：ログイン管理（強制ログアウト）機能のため、MemoryStoreの
//   インスタンスを明示的に保持しておく（後段の /api/admin/sessions/* から
//   store.all() / store.destroy() で全セッションを横断的に見る必要があるため）。
//   本番でconnect-mysql2等に差し替える際は、そちらのstoreも同様にall()/destroy()
//   をサポートしていることを確認すること（connect系ストアは概ね対応している）。
const sessionStore = new session.MemoryStore();
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000 // 8時間
  }
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
  // ★2026-09-19追加：メニューマスタで管理している有効なメニューを、お客様予約フォーム用に返す。
  //   以前はpublic/index.htmlに固定4件がハードコードされていたが、店舗設定画面から
  //   追加・編集した内容がここに反映されるようになった。
  const menuItems = db.prepare(`
    SELECT id, category, name, duration_min, price, target FROM menu_items
    WHERE store_id = ? AND is_active = 1 ORDER BY display_order ASC, id ASC
  `).all(storeId);
  res.json({ store, staffList, zones, menuItems });
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
// ★2026-09-19追加：予約のキャンセル・変更はオーナー管理画面からの操作に限定する
//   （旧実装はセッションチェックも店舗スコープも無い公開エンドポイントだった。
//    フロント側でも呼んでいなかったため、実害が出る前に
//    /api/admin/reservations/:id （requireOwnerSession・店舗スコープ付き）へ
//    差し替える。実装本体は requireOwnerSession 定義後のセクションにある）。
// ----------------------------------------------------------------------------

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
    // ★2026-09-19追加：顧客管理画面（削除済みも含めた一覧表示）向けに、
    //   includeDeleted=1のときだけ論理削除済みの顧客も含めて返す。
    const includeDeleted = req.query.includeDeleted === '1';

    let where = includeDeleted ? 'store_id = ?' : 'store_id = ? AND is_deleted = 0';
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
// ★2026-09-19追加：予約のキャンセル・変更（オーナー管理画面から操作する用）
//
// DELETE /api/admin/reservations/:id
//   GAS版のキャンセル運用（realname列に'キャンセル'を入れる方式）を踏襲。
//   物理削除はしない（履歴を残す・元のGAS運用と挙動を合わせるため）。
// ----------------------------------------------------------------------------
app.delete('/api/admin/reservations/:id', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const id = Number(req.params.id);

    // ★店舗スコープ確認：他店の予約IDを推測して叩かれても操作できないようにする
    const row = db.prepare('SELECT * FROM reservations WHERE id = ? AND store_id = ?').get(id, storeId);
    if (!row) {
      return res.status(404).json({ success: false, message: '対象の予約が見つかりません（他店舗のデータは操作できません）' });
    }

    db.prepare(`UPDATE reservations SET realname = 'キャンセル', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// PUT /api/admin/reservations/:id
//   予約の変更（担当・メニュー・日付・時間・備考）。GAS版には「予約変更」操作が
//   台帳の直接編集として存在していたため、それに相当する機能をオーナー管理画面に用意する。
//   日付・時間・担当を変える場合は、二重予約防止のUNIQUE制約に必ず引っかかるように
//   （予約作成時と同じ仕組みで）保護する。
// ----------------------------------------------------------------------------
app.put('/api/admin/reservations/:id', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const id = Number(req.params.id);
    const data = req.body || {};

    const existing = db.prepare('SELECT * FROM reservations WHERE id = ? AND store_id = ?').get(id, storeId);
    if (!existing) {
      return res.status(404).json({ success: false, message: '対象の予約が見つかりません（他店舗のデータは操作できません）' });
    }
    if (existing.realname === 'キャンセル') {
      return res.status(400).json({ success: false, message: 'キャンセル済みの予約は編集できません' });
    }
    if (!data.staffName || !data.date || !data.time || !data.menu) {
      return res.status(400).json({ success: false, message: 'staffName / date / time / menu は必須です' });
    }

    try {
      db.prepare(`
        UPDATE reservations
        SET staff_name = @staff_name, menu = @menu, reservation_date = @reservation_date,
            reservation_time = @reservation_time, note = @note, updated_at = CURRENT_TIMESTAMP
        WHERE id = @id AND store_id = @store_id
      `).run({
        id, store_id: storeId,
        staff_name: data.staffName, menu: data.menu,
        reservation_date: data.date, reservation_time: data.time,
        note: data.note || existing.note || ''
      });
    } catch (constraintErr) {
      if (String(constraintErr.message).includes('UNIQUE constraint failed')) {
        return res.status(409).json({
          success: false,
          isDoubleBooking: true,
          message: 'その日時・担当は既に別の予約で埋まっています。別の枠を選んでください。'
        });
      }
      throw constraintErr;
    }

    res.json({ success: true, message: '✅ 予約を変更しました' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ★2026-09-19追加：管理画面からの新規予約登録（電話予約・当日飛び込み対応）
//   GAS版の staff_reservation_form.html に相当。お客様ご自身に予約フォームを
//   操作してもらうのではなく、電話で受けた予約をスタッフが代わりに登録するための機能。
//   POST /api/reservations（お客様フォーム用・店舗はbodyのstoreパラメータで指定）とは別に、
//   セッションの店舗に固定した管理画面専用のエンドポイントとして用意する。
//   予約上限警告・二重予約防止は既存のお客様フォームと同じ仕組みを再利用する。
// ----------------------------------------------------------------------------
app.post('/api/admin/reservations', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const data = req.body || {};

    if (!data.realname || !data.staffName || !data.date || !data.time || !data.menu) {
      return res.status(400).json({ success: false, message: 'realname / staffName / date / time / menu は必須です' });
    }

    // ★予約作成時と同じ上限チェック。管理画面からの登録はオーナー自身の判断で
    //   上限を超えても登録できるよう、ownerOverrideが立っていればスキップする。
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
        (@store_id, @realname, @kana, '', '', @staff_name, @menu, @reservation_date, @reservation_time, @note, @editor, 0, 0, @customer_id, '確定')
    `);

    let info;
    try {
      info = insert.run({
        store_id: storeId,
        realname: data.realname,
        kana: data.kana || '',
        staff_name: data.staffName,
        menu: data.menu,
        reservation_date: data.date,
        reservation_time: data.time,
        note: data.note || '',
        editor: req.session.staff.name + '（管理画面）',
        customer_id: data.customerId || ''
      });
    } catch (constraintErr) {
      if (String(constraintErr.message).includes('UNIQUE constraint failed')) {
        return res.status(409).json({
          success: false,
          isDoubleBooking: true,
          message: 'その日時・担当は既に別の予約で埋まっています。別の枠を選んでください。'
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
// ★2026-09-19追加：スタッフのシフト管理（オーナー管理画面から操作する用）
//
// GET /api/admin/staff
//   店舗の全スタッフ（見習い・非表示スタッフ含む）を返す。pin_hash/pin_saltは
//   絶対に返さない（PINを設定済みかどうかはhasPinの真偽値だけ返す）。
//   /api/store のgetCustomerStaffList_は「予約フォームに出す人だけ」に絞るフィルタが
//   入っているため、オーナー向けの管理画面では別に用意している。
// ----------------------------------------------------------------------------
app.get('/api/admin/staff', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const rows = db.prepare(`
      SELECT id, name, nickname, role, opt_support, night_restrict, show_in_booking, is_active, is_owner,
             (pin_hash IS NOT NULL) AS has_pin
      FROM staff WHERE store_id = ? ORDER BY is_active DESC, name ASC
    `).all(storeId);
    res.json({ staff: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ★2026-09-19追加：スタッフマスタ管理（GAS版の「スタッフ管理」画面 admin_ui.html 相当）
//
// POST /api/admin/staff
//   スタッフを新規登録する。{ name, nickname, role, optSupport, nightRestrict,
//   showInBooking, isOwner, pin }
//   pinは4桁の数字を想定（GAS版運用＝電話番号下4桁を踏襲）。ハッシュ化して保存し、
//   平文は保存しない。
// ----------------------------------------------------------------------------
app.post('/api/admin/staff', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const data = req.body || {};
    if (!data.name || !String(data.name).trim()) {
      return res.status(400).json({ success: false, message: '氏名は必須です' });
    }
    if (!data.pin || !/^\d{4}$/.test(String(data.pin))) {
      return res.status(400).json({ success: false, message: 'PINは4桁の数字で指定してください' });
    }
    const dup = db.prepare('SELECT 1 FROM staff WHERE store_id = ? AND name = ? AND is_active = 1').get(storeId, data.name.trim());
    if (dup) {
      return res.status(400).json({ success: false, message: '同じ氏名の在籍スタッフが既に存在します' });
    }

    const { hash, salt } = createPinHash(data.pin);
    const info = db.prepare(`
      INSERT INTO staff (store_id, name, nickname, role, opt_support, night_restrict, show_in_booking, is_active, pin_hash, pin_salt, is_owner)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      storeId, data.name.trim(), data.nickname || '', data.role || 'スタッフ',
      data.optSupport ? 1 : 0, data.nightRestrict ? 1 : 0, data.showInBooking === false ? 0 : 1,
      hash, salt, data.isOwner ? 1 : 0
    );
    res.json({ success: true, staffId: info.lastInsertRowid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// PUT /api/admin/staff/:id
//   スタッフ情報を更新する。pinが指定された場合のみPINを再設定する（空欄なら変更しない）。
//   ★安全策：ログイン中の自分自身を「在籍中フラグOFF」にはできないようにする
//   （唯一のオーナーが自分自身を無効化して誰もログインできなくなる事故を防ぐ）。
// ----------------------------------------------------------------------------
app.put('/api/admin/staff/:id', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const id = Number(req.params.id);
    const data = req.body || {};

    const existing = db.prepare('SELECT * FROM staff WHERE id = ? AND store_id = ?').get(id, storeId);
    if (!existing) {
      return res.status(404).json({ success: false, message: '対象のスタッフが見つかりません（他店舗のデータは操作できません）' });
    }
    if (!data.name || !String(data.name).trim()) {
      return res.status(400).json({ success: false, message: '氏名は必須です' });
    }
    if (id === req.session.staff.id && data.isActive === false) {
      return res.status(400).json({ success: false, message: '自分自身を在籍中フラグOFFにはできません（誰もログインできなくなるため）' });
    }

    let pinClause = '';
    const params = {
      id, store_id: storeId,
      name: data.name.trim(), nickname: data.nickname || '', role: data.role || 'スタッフ',
      opt_support: data.optSupport ? 1 : 0, night_restrict: data.nightRestrict ? 1 : 0,
      show_in_booking: data.showInBooking === false ? 0 : 1,
      is_active: data.isActive === false ? 0 : 1, is_owner: data.isOwner ? 1 : 0
    };
    if (data.pin) {
      if (!/^\d{4}$/.test(String(data.pin))) {
        return res.status(400).json({ success: false, message: 'PINは4桁の数字で指定してください' });
      }
      const { hash, salt } = createPinHash(data.pin);
      pinClause = ', pin_hash = @pin_hash, pin_salt = @pin_salt';
      params.pin_hash = hash;
      params.pin_salt = salt;
    }

    db.prepare(`
      UPDATE staff
      SET name = @name, nickname = @nickname, role = @role,
          opt_support = @opt_support, night_restrict = @night_restrict, show_in_booking = @show_in_booking,
          is_active = @is_active, is_owner = @is_owner
          ${pinClause}
      WHERE id = @id AND store_id = @store_id
    `).run(params);

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// ★2026-09-19追加：顧客マスタの重複統合（マージ）機能
//   GAS版のcustomer_merge_functions.gsに相当。電話番号の一致で重複候補を検知し、
//   統合（片方に情報を集約して片方を論理削除）または「別人」として見送るかを
//   オーナーが判断できるようにする。
// ============================================================================
const { normalizePhoneDigits, findMergeCandidates, mergeCustomerRecords } = require('./lib/customerMerge');

// ----------------------------------------------------------------------------
// GET /api/admin/customers/merge-candidates
//   電話番号が一致するのに顧客IDが異なる組み合わせを検知して返す（見送り済みは除外）
// ----------------------------------------------------------------------------
app.get('/api/admin/customers/merge-candidates', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const candidates = findMergeCandidates(db, storeId);
    res.json({ candidates });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/admin/customers/merge-candidates/dismiss  { customerIdA, customerIdB }
//   「別人」として見送る。以後この組み合わせは候補一覧に出さない。
// ----------------------------------------------------------------------------
app.post('/api/admin/customers/merge-candidates/dismiss', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const { customerIdA, customerIdB } = req.body || {};
    if (!customerIdA || !customerIdB) {
      return res.status(400).json({ success: false, message: 'customerIdA・customerIdBは必須です' });
    }
    if (String(customerIdA) === String(customerIdB)) {
      return res.status(400).json({ success: false, message: '同じ顧客同士は指定できません' });
    }
    const [a, b] = [String(customerIdA), String(customerIdB)].sort();
    db.prepare(`
      INSERT INTO customer_merge_dismissals (store_id, customer_id_a, customer_id_b, dismissed_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(store_id, customer_id_a, customer_id_b) DO NOTHING
    `).run(storeId, a, b, req.session.staff.name);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/admin/customers/merge  { keepCustomerId, mergeCustomerId }
//   mergeCustomerId側の空欄を埋めた上でkeepCustomerId側に統合し、mergeCustomerId側は論理削除する。
// ----------------------------------------------------------------------------
app.post('/api/admin/customers/merge', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const { keepCustomerId, mergeCustomerId } = req.body || {};
    if (!keepCustomerId || !mergeCustomerId) {
      return res.status(400).json({ success: false, message: 'keepCustomerId・mergeCustomerIdは必須です' });
    }
    if (String(keepCustomerId) === String(mergeCustomerId)) {
      return res.status(400).json({ success: false, message: '同じ顧客同士は統合できません' });
    }
    const result = mergeCustomerRecords(db, storeId, keepCustomerId, mergeCustomerId, req.session.staff.name);
    if (!result.success) {
      return res.status(400).json(result);
    }
    // 統合済みなら、見送り済み記録もマージ候補一覧に紛れないよう一緒に片付ける
    const [a, b] = [String(keepCustomerId), String(mergeCustomerId)].sort();
    db.prepare('DELETE FROM customer_merge_dismissals WHERE store_id = ? AND customer_id_a = ? AND customer_id_b = ?').run(storeId, a, b);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ★2026-09-19追加：顧客マスタの詳細編集・削除・復元
//   GAS版owner_ui.html「顧客管理」画面の編集モーダル（saveCustomerRecord/
//   deleteCustomerRecord/restoreCustomerRecord、いずれもreservation_form_functions.gs）相当。
//   統合（マージ）機能とは別の、1件ずつの通常編集・論理削除・復元を行う。
//
// PUT /api/admin/customers/:customerId
//   { realname, kana, phone, addr(※このプロトタイプにはaddr列が無いためmemoに含める運用),
//     totalVisits, staffName, isKeepMember, optSupport, memo, status, bookingBlocked, notifyEnabled }
// DELETE /api/admin/customers/:customerId  : 論理削除（復元可能）
// POST   /api/admin/customers/:customerId/restore : 復元
// ----------------------------------------------------------------------------
function findCustomerByCid_(storeId, customerId) {
  return db.prepare('SELECT * FROM customers WHERE store_id = ? AND customer_id = ?').get(storeId, String(customerId));
}

app.put('/api/admin/customers/:customerId', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const existing = findCustomerByCid_(storeId, req.params.customerId);
    if (!existing) {
      return res.status(404).json({ success: false, message: '対象の顧客が見つかりません（他店舗のデータは操作できません）' });
    }
    const data = req.body || {};
    if (!data.realname || !String(data.realname).trim()) {
      return res.status(400).json({ success: false, message: '氏名は必須です' });
    }
    // GAS版と同様、電話番号はハイフン・全角を除去した半角数字のみに正規化して保存する
    const telDigits = String(data.phone || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[^0-9]/g, '');
    if (telDigits && !/^0\d{9,10}$/.test(telDigits)) {
      return res.status(400).json({ success: false, message: '電話番号は0から始まる10桁または11桁の数字で入力してください（ハイフン不要）' });
    }
    if (data.status && !['active', 'inactive'].includes(data.status)) {
      return res.status(400).json({ success: false, message: 'statusはactiveかinactiveのいずれかで指定してください' });
    }

    db.prepare(`
      UPDATE customers
      SET realname = @realname, kana = @kana, phone = @phone, total_visits = @total_visits,
          staff_name = @staff_name, is_keep_member = @is_keep_member, opt_support = @opt_support,
          memo = @memo, status = @status, booking_blocked = @booking_blocked, notify_enabled = @notify_enabled,
          updated_by = @updated_by, updated_at = CURRENT_TIMESTAMP
      WHERE store_id = @store_id AND customer_id = @customer_id
    `).run({
      store_id: storeId, customer_id: existing.customer_id,
      realname: data.realname.trim(), kana: data.kana || '', phone: telDigits,
      total_visits: Number(data.totalVisits) || 0, staff_name: data.staffName || '',
      is_keep_member: data.isKeepMember ? 1 : 0, opt_support: data.optSupport ? 1 : 0,
      memo: data.memo || '', status: data.status === 'inactive' ? 'inactive' : 'active',
      booking_blocked: data.bookingBlocked ? 1 : 0, notify_enabled: data.notifyEnabled === false ? 0 : 1,
      updated_by: req.session.staff.name
    });
    res.json({ success: true, message: '✅ 顧客情報を保存しました' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/admin/customers/:customerId', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const existing = findCustomerByCid_(storeId, req.params.customerId);
    if (!existing) {
      return res.status(404).json({ success: false, message: '対象の顧客が見つかりません（他店舗のデータは操作できません）' });
    }
    db.prepare(`
      UPDATE customers SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE store_id = ? AND customer_id = ?
    `).run(req.session.staff.name, storeId, existing.customer_id);
    res.json({ success: true, message: '🗑️ 顧客を削除しました（復元可能）' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/customers/:customerId/restore', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const existing = findCustomerByCid_(storeId, req.params.customerId);
    if (!existing) {
      return res.status(404).json({ success: false, message: '対象の顧客が見つかりません（他店舗のデータは操作できません）' });
    }
    db.prepare(`
      UPDATE customers SET is_deleted = 0, deleted_at = NULL, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE store_id = ? AND customer_id = ?
    `).run(req.session.staff.name, storeId, existing.customer_id);
    res.json({ success: true, message: '↩️ 顧客を復元しました' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/admin/shifts?from=&to=
//   指定期間のシフトマスタ一覧を返す（省略時は本日から14日間）。
// ----------------------------------------------------------------------------
app.get('/api/admin/shifts', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const fmt = (d) => {
      const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const from = req.query.from || fmt(today);
    const toDefault = new Date(today); toDefault.setDate(toDefault.getDate() + 13);
    const to = req.query.to || fmt(toDefault);

    const rows = db.prepare(`
      SELECT * FROM shift_master
      WHERE store_id = ? AND shift_date >= ? AND shift_date <= ? AND is_active = 1
      ORDER BY shift_date ASC, start_time ASC
    `).all(storeId, from, to);

    res.json({ from, to, shifts: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/admin/shifts
//   シフトを1件追加する。{ staffName, date, startTime, endTime }
// ----------------------------------------------------------------------------
app.post('/api/admin/shifts', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const { staffName, date, startTime, endTime } = req.body || {};
    if (!staffName || !date || !startTime || !endTime) {
      return res.status(400).json({ success: false, message: 'staffName / date / startTime / endTime は必須です' });
    }
    if (startTime >= endTime) {
      return res.status(400).json({ success: false, message: '終了時間は開始時間より後にしてください' });
    }
    const staffExists = db.prepare(
      'SELECT 1 FROM staff WHERE store_id = ? AND name = ? AND is_active = 1'
    ).get(storeId, staffName);
    if (!staffExists) {
      return res.status(400).json({ success: false, message: '在籍中のスタッフとして見つかりません' });
    }

    const info = db.prepare(`
      INSERT INTO shift_master (store_id, staff_name, shift_date, start_time, end_time, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(storeId, staffName, date, startTime, endTime);

    res.json({ success: true, shiftId: info.lastInsertRowid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// DELETE /api/admin/shifts/:id
//   シフトを1件削除する（is_active=0にする論理削除ではなく、シフトマスタ自体は
//   「出勤予定そのもの」を表すシンプルなテーブルのため、物理削除で問題ない）。
// ----------------------------------------------------------------------------
app.delete('/api/admin/shifts/:id', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const id = Number(req.params.id);
    const row = db.prepare('SELECT id FROM shift_master WHERE id = ? AND store_id = ?').get(id, storeId);
    if (!row) {
      return res.status(404).json({ success: false, message: '対象のシフトが見つかりません' });
    }
    db.prepare('DELETE FROM shift_master WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// ★2026-09-19追加：店舗設定（GAS版owner_ui.htmlの「店舗設定」パネルに相当）
//   基本ルール（rule1シート相当）・営業時間帯（zonesシート相当）・
//   休業日/特別イベント（eventsシート相当）を管理画面から確認・編集できるようにする。
//   これらはダミーの設定項目ではなく、予約受付ロジック（lib/reservationEngine.js）が
//   実際に参照している値のため、編集内容はその場で予約可否判定に反映される。
// ============================================================================

// ----------------------------------------------------------------------------
// GET /api/admin/settings/rules
// ----------------------------------------------------------------------------
app.get('/api/admin/settings/rules', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const rows = db.prepare('SELECT rule_id, memo, value FROM rules WHERE store_id = ? ORDER BY rule_id').all(storeId);
    res.json({ rules: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// PUT /api/admin/settings/rules/:ruleId  { value }
//   既存ルールの値のみ更新可能（rule_idの新規追加はこのプロトタイプでは非対応。
//   GAS版もrule1シートの行自体は固定でvalue列だけを運用で書き換えていたため踏襲）。
// ----------------------------------------------------------------------------
app.put('/api/admin/settings/rules/:ruleId', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const ruleId = req.params.ruleId;
    const value = (req.body || {}).value;
    if (value === undefined || value === null || String(value).trim() === '') {
      return res.status(400).json({ success: false, message: '値は必須です' });
    }
    if (!/^\d+$/.test(String(value).trim())) {
      return res.status(400).json({ success: false, message: '数値で指定してください' });
    }
    const existing = db.prepare('SELECT id FROM rules WHERE store_id = ? AND rule_id = ?').get(storeId, ruleId);
    if (!existing) {
      return res.status(404).json({ success: false, message: '対象のルールが見つかりません: ' + ruleId });
    }
    db.prepare('UPDATE rules SET value = ? WHERE store_id = ? AND rule_id = ?').run(String(value).trim(), storeId, ruleId);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/admin/settings/zones
// ----------------------------------------------------------------------------
app.get('/api/admin/settings/zones', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const rows = db.prepare('SELECT * FROM zones WHERE store_id = ? ORDER BY start_time').all(storeId);
    res.json({ zones: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// PUT /api/admin/settings/zones/:zoneKey
//   { startTime, endTime, isActive, fixedTarget, fixedStart, fixedIntervalMin }
// ----------------------------------------------------------------------------
app.put('/api/admin/settings/zones/:zoneKey', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const zoneKey = req.params.zoneKey;
    const data = req.body || {};

    const existing = db.prepare('SELECT * FROM zones WHERE store_id = ? AND zone_key = ?').get(storeId, zoneKey);
    if (!existing) {
      return res.status(404).json({ success: false, message: '対象の営業時間帯が見つかりません: ' + zoneKey });
    }
    if (!data.startTime || !data.endTime) {
      return res.status(400).json({ success: false, message: '開始・終了時刻は必須です' });
    }
    if (data.startTime >= data.endTime) {
      return res.status(400).json({ success: false, message: '終了時刻は開始時刻より後にしてください' });
    }

    db.prepare(`
      UPDATE zones SET
        start_time = @start_time, end_time = @end_time, is_active = @is_active,
        fixed_target = @fixed_target, fixed_start = @fixed_start, fixed_interval_min = @fixed_interval_min
      WHERE store_id = @store_id AND zone_key = @zone_key
    `).run({
      store_id: storeId, zone_key: zoneKey,
      start_time: data.startTime, end_time: data.endTime,
      is_active: data.isActive === false ? 0 : 1,
      fixed_target: data.fixedTarget ? 1 : 0,
      fixed_start: data.fixedTarget ? (data.fixedStart || existing.fixed_start || data.startTime) : null,
      fixed_interval_min: data.fixedTarget ? Number(data.fixedIntervalMin) || existing.fixed_interval_min || 90 : 0
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/admin/events?from=&to=
//   休業日・特別イベントの一覧（省略時は本日から60日間）
// ----------------------------------------------------------------------------
app.get('/api/admin/events', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const fmt = (d) => {
      const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const from = req.query.from || fmt(today);
    const toDefault = new Date(today); toDefault.setDate(toDefault.getDate() + 60);
    const to = req.query.to || fmt(toDefault);

    const rows = db.prepare(`
      SELECT * FROM events WHERE store_id = ? AND event_date >= ? AND event_date <= ?
      ORDER BY event_date ASC
    `).all(storeId, from, to);
    res.json({ events: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/admin/events
//   { title, date, startTime, endTime, restrictBooking, blockStartTime, blockEndTime }
// ----------------------------------------------------------------------------
app.post('/api/admin/events', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const data = req.body || {};
    if (!data.title || !data.date || !data.startTime || !data.endTime) {
      return res.status(400).json({ success: false, message: 'title / date / startTime / endTime は必須です' });
    }
    if (data.startTime >= data.endTime) {
      return res.status(400).json({ success: false, message: '終了時刻は開始時刻より後にしてください' });
    }
    const info = db.prepare(`
      INSERT INTO events (store_id, title, event_date, is_active, start_time, end_time, restrict_booking, block_start_time, block_end_time)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      storeId, data.title, data.date, data.startTime, data.endTime,
      data.restrictBooking ? 1 : 0,
      data.restrictBooking ? (data.blockStartTime || null) : null,
      data.restrictBooking ? (data.blockEndTime || null) : null
    );
    res.json({ success: true, eventId: info.lastInsertRowid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// DELETE /api/admin/events/:id
// ----------------------------------------------------------------------------
app.delete('/api/admin/events/:id', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const id = Number(req.params.id);
    const row = db.prepare('SELECT id FROM events WHERE id = ? AND store_id = ?').get(id, storeId);
    if (!row) {
      return res.status(404).json({ success: false, message: '対象のイベントが見つかりません' });
    }
    db.prepare('DELETE FROM events WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// ★2026-09-19追加：メニューマスタ（GAS版owner_ui.htmlの「メニューマスタ」パネルに相当）
//   GAS版は親メニュー＋内訳（parent/child）の階層構造を持つが、このプロトタイプでは
//   フラットな一覧のみに簡略化している。
// ============================================================================
const MENU_CATEGORIES = ['メインメニュー', '施術系オプション', 'オプション'];
const MENU_TARGETS = ['全員', '初回', 'キープメンバー', 'ビジター'];

// ----------------------------------------------------------------------------
// GET /api/admin/settings/menu
//   非表示（is_active=0）も含めて全件返す（管理画面側で表示切替できるように）。
// ----------------------------------------------------------------------------
app.get('/api/admin/settings/menu', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const items = db.prepare('SELECT * FROM menu_items WHERE store_id = ? ORDER BY display_order ASC, id ASC').all(storeId);
    res.json({ items, categories: MENU_CATEGORIES, targets: MENU_TARGETS });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/admin/settings/menu
//   { category, name, durationMin, price, target }
// ----------------------------------------------------------------------------
app.post('/api/admin/settings/menu', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const data = req.body || {};
    if (!data.name || !String(data.name).trim()) {
      return res.status(400).json({ success: false, message: 'メニュー名は必須です' });
    }
    if (MENU_CATEGORIES.indexOf(data.category) === -1) {
      return res.status(400).json({ success: false, message: 'カテゴリの指定が不正です' });
    }
    if (MENU_TARGETS.indexOf(data.target) === -1) {
      return res.status(400).json({ success: false, message: '対象の指定が不正です' });
    }
    const duration = Number(data.durationMin);
    const price = Number(data.price);
    if (isNaN(duration) || duration < 0) {
      return res.status(400).json({ success: false, message: '所要時間は0以上の数値で指定してください' });
    }
    if (isNaN(price) || price < 0) {
      return res.status(400).json({ success: false, message: '料金は0以上の数値で指定してください' });
    }
    const maxOrder = db.prepare('SELECT MAX(display_order) AS m FROM menu_items WHERE store_id = ?').get(storeId).m || 0;
    const info = db.prepare(`
      INSERT INTO menu_items (store_id, category, name, duration_min, price, target, is_active, display_order)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).run(storeId, data.category, data.name.trim(), duration, price, data.target, maxOrder + 1);
    res.json({ success: true, menuItemId: info.lastInsertRowid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// PUT /api/admin/settings/menu/:id
//   { category, name, durationMin, price, target, isActive }
// ----------------------------------------------------------------------------
app.put('/api/admin/settings/menu/:id', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const id = Number(req.params.id);
    const data = req.body || {};

    const existing = db.prepare('SELECT * FROM menu_items WHERE id = ? AND store_id = ?').get(id, storeId);
    if (!existing) {
      return res.status(404).json({ success: false, message: '対象のメニューが見つかりません（他店舗のデータは操作できません）' });
    }
    if (!data.name || !String(data.name).trim()) {
      return res.status(400).json({ success: false, message: 'メニュー名は必須です' });
    }
    if (MENU_CATEGORIES.indexOf(data.category) === -1) {
      return res.status(400).json({ success: false, message: 'カテゴリの指定が不正です' });
    }
    if (MENU_TARGETS.indexOf(data.target) === -1) {
      return res.status(400).json({ success: false, message: '対象の指定が不正です' });
    }
    const duration = Number(data.durationMin);
    const price = Number(data.price);
    if (isNaN(duration) || duration < 0) {
      return res.status(400).json({ success: false, message: '所要時間は0以上の数値で指定してください' });
    }
    if (isNaN(price) || price < 0) {
      return res.status(400).json({ success: false, message: '料金は0以上の数値で指定してください' });
    }

    db.prepare(`
      UPDATE menu_items SET
        category = @category, name = @name, duration_min = @duration_min, price = @price,
        target = @target, is_active = @is_active, updated_at = CURRENT_TIMESTAMP
      WHERE id = @id AND store_id = @store_id
    `).run({
      id, store_id: storeId, category: data.category, name: data.name.trim(),
      duration_min: duration, price, target: data.target,
      is_active: data.isActive === false ? 0 : 1
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// DELETE /api/admin/settings/menu/:id
//   物理削除ではなく非表示（is_active=0）にする（過去の予約データのmenu列は文字列保持のため
//   削除しても既存予約の表示に影響は無いが、GAS版の「非表示」運用に合わせて論理削除にする）。
// ----------------------------------------------------------------------------
app.delete('/api/admin/settings/menu/:id', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT id FROM menu_items WHERE id = ? AND store_id = ?').get(id, storeId);
    if (!existing) {
      return res.status(404).json({ success: false, message: '対象のメニューが見つかりません' });
    }
    db.prepare('UPDATE menu_items SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
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

// ----------------------------------------------------------------------------
// POST /api/admin/import-sample-data
//   Renderの無料プランにはShell機能がないため、sample_data/配下に同梱した
//   テストB店の実データCSVを、管理画面のボタン1つから取り込めるようにする
//   代替手段。中身はimport_csv.jsのCLIロジックと完全に同じ（コードの重複を避けるため
//   importCustomers/importReservationsをそのままrequireして呼び出す）。
//   オーナーセッション必須（一般公開エンドポイントではない）。
// ----------------------------------------------------------------------------
app.post('/api/admin/import-sample-data', requireOwnerSession, (req, res) => {
  try {
    const importer = require('./import_csv');
    const storeId = req.session.staff.storeId;
    const fs = require('fs');

    const custPath = path.join(__dirname, 'sample_data', 'customers.csv');
    const resvPath = path.join(__dirname, 'sample_data', 'reservations.csv');

    if (!fs.existsSync(custPath) || !fs.existsSync(resvPath)) {
      return res.status(404).json({ error: 'sample_data/ 配下にCSVが見つかりません' });
    }

    const custRows = importer.rowsToObjects(importer.parseCsv(fs.readFileSync(custPath, 'utf8')));
    const resvRows = importer.rowsToObjects(importer.parseCsv(fs.readFileSync(resvPath, 'utf8')));

    const customersSummary = importer.importCustomers(custRows, storeId);
    const reservationsSummary = importer.importReservations(resvRows, storeId);

    res.json({
      success: true,
      customers: {
        read: customersSummary.read,
        inserted: customersSummary.inserted,
        updated: customersSummary.updated,
        skipped: customersSummary.skipped.length
      },
      reservations: {
        read: reservationsSummary.read,
        inserted: reservationsSummary.inserted,
        updated: reservationsSummary.updated,
        skipped: reservationsSummary.skipped.length
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ⑤ 課金基盤（プラン管理）の骨組み
//
// GET  /api/admin/plan  : 現在ログイン中の店舗のプランと、選べるプラン一覧を返す
// POST /api/admin/plan  : { plan: 'trial'|'onecoin'|'base'|'line' } でプランを切り替える
//
// 【重要】これは実際の決済・申込みフローではない「デモ用スイッチ」。
//   本番では決済確認後にシステム側（またはオーナー申込み＋承認フロー）が
//   更新する想定で、オーナーが管理画面から自由に切り替えられる状態は
//   本番運用にはそのまま使えない。ここではあくまで「プランによって機能が
//   実際に変わる」ことをデモで見せるための骨組みとして用意している。
// ----------------------------------------------------------------------------
app.get('/api/admin/plan', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const store = db.prepare('SELECT plan FROM stores WHERE id = ?').get(storeId);
    const currentSlug = store ? store.plan : 'trial';
    res.json({
      currentPlan: { slug: currentSlug, ...getPlan(currentSlug) },
      allPlans: listPlans()
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/plan', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const { plan } = req.body || {};
    const validSlugs = listPlans().map((p) => p.slug);
    if (!validSlugs.includes(plan)) {
      return res.status(400).json({ error: `plan は ${validSlugs.join(' / ')} のいずれかを指定してください` });
    }
    db.prepare('UPDATE stores SET plan = ? WHERE id = ?').run(plan, storeId);
    res.json({ success: true, currentPlan: { slug: plan, ...getPlan(plan) } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ⑳ ログイン管理（強制ログアウト） - GAS版 owner_ui.html「ログイン管理」タイル相当
//
// GAS版はPropertiesServiceに手動でトークンを持つ独自セッション実装（デデュープ／
// TTL／保持数上限つき）だったが、Node版はexpress-sessionの標準的なCookieセッション
// を使っているため、同じ仕組みは不要。その代わり、express-sessionのMemoryStoreが
// 持つ全セッションを横断的に走査し、対象スタッフのセッションを破棄することで
// 「強制ログアウト」と同等のことを実現する。
//   ※MemoryStoreは単一プロセス限定（本番でconnect-mysql2等に差し替えた場合も
//     store.all()/store.destroy()があれば同じロジックで動く）。
//
// GET  /api/admin/sessions/staff-list
//   対象スタッフ選択用に在籍中スタッフの一覧を返す（氏名＋現在ログイン中か否か）。
// POST /api/admin/sessions/force-logout { staffId }
//   指定スタッフの現在有効なセッションをすべて破棄する。
// ----------------------------------------------------------------------------

// MemoryStoreの全セッションを {sid: sessionData} の配列として取得する内部ヘルパー。
// store.all()はコールバック形式（一部のstoreはPromiseも返すが、ここでは互換性優先でcallback形式に統一）。
function getAllSessionsAsync_() {
  return new Promise((resolve, reject) => {
    sessionStore.all((err, sessions) => {
      if (err) return reject(err);
      // MemoryStoreはオブジェクト（{sid: session}）で返すため配列化する
      const list = [];
      if (sessions) {
        Object.keys(sessions).forEach((sid) => {
          list.push({ sid, data: sessions[sid] });
        });
      }
      resolve(list);
    });
  });
}

app.get('/api/admin/sessions/staff-list', requireOwnerSession, async (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const staffRows = db.prepare(`
      SELECT id, name FROM staff WHERE store_id = ? AND is_active = 1 ORDER BY name ASC
    `).all(storeId);

    const sessions = await getAllSessionsAsync_();
    const loggedInStaffIds = new Set();
    sessions.forEach(({ data }) => {
      if (data && data.staff && data.staff.storeId === storeId) {
        loggedInStaffIds.add(data.staff.id);
      }
    });

    res.json({
      staff: staffRows.map((s) => ({
        id: s.id,
        name: s.name,
        isLoggedIn: loggedInStaffIds.has(s.id)
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/sessions/force-logout', requireOwnerSession, async (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const staffId = Number((req.body || {}).staffId);
    if (!staffId) {
      return res.status(400).json({ success: false, message: 'staffId は必須です' });
    }
    const target = db.prepare('SELECT id, name FROM staff WHERE id = ? AND store_id = ?').get(staffId, storeId);
    if (!target) {
      return res.status(404).json({ success: false, message: '対象のスタッフが見つかりません' });
    }

    const sessions = await getAllSessionsAsync_();
    const targets = sessions.filter(({ data }) => data && data.staff && data.staff.id === staffId && data.staff.storeId === storeId);

    await Promise.all(targets.map(({ sid }) => new Promise((resolve) => {
      sessionStore.destroy(sid, () => resolve());
    })));

    if (targets.length === 0) {
      return res.json({ success: true, message: 'このスタッフは現在ログインしていません（有効なセッションなし）' });
    }
    res.json({ success: true, message: `✅ ログアウトさせました（${targets.length}件のログイン状態を無効化）` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 予約管理プロトタイプ サーバー起動: http://localhost:${PORT}`);
});
