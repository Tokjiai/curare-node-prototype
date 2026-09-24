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
//   GET  /api/auth/login-staff   ログイン画面の名前タイル一覧（GAS版getStaffLoginList相当）
//   POST /api/auth/admin-login   管理者（相野様）専用ログイン（環境変数PLATFORM_ADMIN_PASSWORDと照合）
//   POST /api/auth/login         スタッフPINログイン（タイルで選んだstaffId＋4桁PIN。GAS版loginStaff_相当）
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
const { getPlan, listPlans, hasFeature } = require('./lib/plans');
const { runMigrations } = require('./lib/migrate');
const SqliteSessionStore = require('./lib/sqliteSessionStore');
const { getMessageSettings, saveMessageSettings, getMessageTemplate, renderMessageBody } = require('./lib/messageTemplates');
const dailyReports = require('./lib/dailyReports');
const { runDailyMaintenance } = require('./lib/maintenance');
const { startScheduler } = require('./lib/scheduler');

// ----------------------------------------------------------------------------
// ★2026-09-22追加：スタッフ・オーナーが手動で行う予約の新規登録／編集／キャンセルに
//   ついて、GAS版（reservation_form_functions.js addReservationUnified_body_ /
//   updateReservation_body_ / cancelReservation_body_）と同じく、LINE連携済みの
//   顧客がひも付いていればLINE通知（confirm_add / change / cancel）を送り、
//   結果を操作者への成功メッセージに「📱LINEに通知しました／⚠️LINE通知に失敗しました／
//   ℹ️LINE IDが未登録のため通知できませんでした」という形で表示する。
//   これまで（〜v42）はこの3操作でLINE通知自体を一切送っておらず、GAS版との差分だった。
//   ここではLINE通知の完了を待ってから結果テキストを組み立てるが、通知処理自体で例外が
//   出ても予約操作の成功自体は妨げない（catchして「失敗」文言にフォールバックするのみ）。
//   なお「仮予約として登録」する新規登録では、確定操作時に別途confirm_finalizeで
//   通知するため、二重通知を避けるためここでは送らない（呼び出し側でstatusを見て判断）。
//   ※社長の要望により、担当スタッフへの社内通知（GAS版notifyStaff_相当）は対象外とした。
// ----------------------------------------------------------------------------
// ★2026-09-23追加：notifyAndBuildResultText()の中身を、テキストだけでなく
//   「実際に届いた（または届いたとみなせる＝シミュレーション）扱いにしてよいか」
//   を示すsentフラグも一緒に返すよう拡張したもの。reservations.line_sent列
//   （オーナーの閲覧専用画面で📨アイコン表示に使う、45章）を実態に合わせて
//   更新するために追加した。notifyAndBuildResultTextは後方互換のため
//   このtextだけを返す薄いラッパーとして残す。
async function notifyAndGetResult(storeId, customerId, reservation, messageKey) {
  if (!customerId) {
    return { text: '\nℹ️ お客様マスタに未連携のため、LINE通知はスキップされました', sent: false };
  }
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE store_id = ? AND customer_id = ?').get(storeId, customerId);
    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
    const result = await notifyReservationConfirmed(store, customer, reservation, messageKey);
    if (result && result.skipped) {
      return { text: '\nℹ️ LINE IDが未登録のため通知できませんでした', sent: false };
    }
    if (result && result.simulated) {
      return { text: '\n📱 LINE通知を実行しました（LINE連携未設定のためシミュレーションです）', sent: true };
    }
    if (result && result.ok) {
      return { text: '\n📱 LINEに通知しました', sent: true };
    }
    return { text: '\n⚠️ LINE通知に失敗しました', sent: false };
  } catch (notifyErr) {
    console.error('LINE通知処理でエラー（予約操作自体は成功しているため無視）:', notifyErr);
    return { text: '\n⚠️ LINE通知に失敗しました', sent: false };
  }
}

async function notifyAndBuildResultText(storeId, customerId, reservation, messageKey) {
  return (await notifyAndGetResult(storeId, customerId, reservation, messageKey)).text;
}

// ★2026-09-23追加：予約行のline_sent（LINE通知送信済みフラグ、reservations-view.htmlの
//   📨アイコン表示元）を、実際の通知結果に合わせて書き込む共通ヘルパー。
//   これまでこの列はINSERT時に常に0固定で、以後どの経路でも更新されておらず、
//   「仮予約→確定」時に初めて送られる顧客通知（confirm_finalize）の結果が
//   一切反映されない不具合があった（社長のご指摘「お客様にも通知が送ったことが
//   分かるように」を受けて発見・修正）。
function markReservationLineSent(reservationId, sent) {
  if (!reservationId) return;
  db.prepare('UPDATE reservations SET line_sent = ? WHERE id = ?').run(sent ? 1 : 0, reservationId);
}

// Render無料プランのディスクは再起動で消える（エフェメラル）ため、
// 起動のたびにスキーマ作成とシードデータ投入をやり直す。
// プロトタイプなのでデータの永続性は割り切っている。
// ★SKIP_SEED=1 を指定した場合は再投入しない（バックアップ復元テストなど、
//   既存データをそのまま使いたい場合に使用）。
if (process.env.SKIP_SEED === '1') {
  const fs = require('fs');
  const schemaSql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql); // テーブルが無い場合のみ作成（IF NOT EXISTSなのでデータは消えない）
  // ★2026-09-19追加：既存のDBファイルを保持するこの経路（SKIP_SEED=1）こそ、
  //   「テーブルは既にあるが、後から追加された列が無い」事故が最も起きやすい。
  //   実際に customers テーブルへの列追加が反映されず、顧客マスタ一覧の取得が
  //   500エラーになる不具合が発生したため、ここで必ずマイグレーションを実行する。
  runMigrations(db);
  console.log('⏭️  SKIP_SEED=1 のためシードデータの再投入をスキップしました（既存データを保持・不足列のみ補完）');
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
// ★2026-09-21変更：session.MemoryStore()（プロセスメモリのみ）から
//   SqliteSessionStore（lib/sqliteSessionStore.js、data/app.db内にセッションを
//   永続化）へ変更。Renderの無料プランはスリープ後の再起動でプロセスメモリが
//   消えるため、MemoryStoreのままだとログイン中のセッションが不定期に無効化され
//   401 Unauthorizedになってしまう問題があった（実際にLINE連携設定パネルの
//   保存操作で発生と報告あり）。data/app.db自体はデプロイをまたいで永続化されて
//   いる実績があるため、同じ仕組みでセッションも永続化する。
const sessionStore = new SqliteSessionStore(db);
// ★2026-09-19追加：RenderはTLS終端を行うリバースプロキシの背後でアプリを動かすため、
//   これを明示しないとExpressは「HTTPSで来ている」ことを認識できない
//   （req.secureが常にfalseになる）。cookie.secure:'auto'と組み合わせて、
//   本番(HTTPS経由)ではSecure属性つきCookieを、ローカル開発(HTTP)では
//   Secure属性なしのCookieを、自動で正しく出し分けるために設定する。
app.set('trust proxy', 1);
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8時間
    sameSite: 'lax',
    secure: 'auto'
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
// ★2026-09-22追加／2026-09-23拡張：GAS版reservation_form_functions.gsの
//   getCustomerFormData（lines 834-880）の移植。お客様予約フォームにURLの
//   ?cid=顧客IDが付いている場合（LINEから個別リンクで開いた想定）、顧客マスタと
//   照合して①本名・フリガナを事前に特定できるようにし②「予約フォーム受付拒否」
//   フラグが立っている顧客は、入力を始める前にブロックする。
//   ★2026-09-23追加：GAS版と同じくキープメンバー／初めての方／既存お客様（キープ
//   以外）の3区分（target: 'keep'|'new'|'visitor'）を判定し、テーマ色（pink/green）と、
//   キープメンバーの場合は前回担当スタッフ名（menuStaffName＝メニュー選択の初期値用）も
//   返すようにした。cid未指定・該当顧客なしの場合はGAS版同様 target:'new', theme:'green'
//   がデフォルト（＝初めての方向けの表示）となる。
function getCustomerFormInfo_(storeId, cid) {
  if (!cid) return { found: false, customerId: '', bookingBlocked: false, target: 'new', theme: 'green', menuStaffName: '', infoConfirmed: false, address: '', keepMemberRequested: false };
  const row = db.prepare(
    'SELECT * FROM customers WHERE store_id = ? AND customer_id = ? AND is_deleted = 0'
  ).get(storeId, String(cid));
  if (!row) return { found: false, customerId: String(cid), bookingBlocked: false, target: 'new', theme: 'green', menuStaffName: '', infoConfirmed: false, address: '', keepMemberRequested: false };
  const isKeepMember = !!row.is_keep_member;
  const visitCount = row.total_visits || 0;
  const target = visitCount === 0 ? 'new' : (isKeepMember ? 'keep' : 'visitor');
  const theme = isKeepMember ? 'pink' : 'green';
  return {
    found: true,
    customerId: row.customer_id,
    realname: row.realname || '',
    kana: row.kana || '',
    lineName: row.line_name || '',
    visitCount,
    isKeepMember,
    bookingBlocked: !!row.booking_blocked,
    target,
    theme,
    menuStaffName: (isKeepMember && row.staff_name) ? row.staff_name : '',
    // ★2026-09-23追加：お客様予約フォームの新規登録画面（48-10）用。
    //   infoConfirmed=falseの場合、target!=='keep'ならフォーム側で登録画面を出す。
    infoConfirmed: !!row.info_confirmed,
    address: row.address || '',
    keepMemberRequested: !!row.keep_member_requested
  };
}

// ----------------------------------------------------------------------------
// ★2026-09-23追加：GAS版 getCustomerMenuList_（reservation_form_functions.js
//   lines 1888-1917）のtgt列マッチング判定の移植。
//   menu_items.target の値は '' / '全員'（＝常に表示）, '初回'（targetが'new'の時のみ）,
//   'キープメンバー'（'keep'の時のみ）, 'ビジター'（'visitor'の時のみ）。
// ----------------------------------------------------------------------------
function menuTargetMatches_(itemTarget, custTarget) {
  const t = itemTarget || '';
  if (t === '' || t === '全員') return true;
  if (t === '初回') return custTarget === 'new';
  if (t === 'キープメンバー') return custTarget === 'keep';
  if (t === 'ビジター') return custTarget === 'visitor';
  return true;
}

// ----------------------------------------------------------------------------
// ★2026-09-23追加：GAS版 getRule2Notices_ / isTargetMatch_（同ファイル
//   lines 1640-1667）の移植。注意書き（booking_notices）のtarget列は
//   '全員'（常に表示）, '初回'（'new'のみ）, 'リピーター'（'keep'または'visitor'）。
// ----------------------------------------------------------------------------
function noticeTargetMatches_(noticeTarget, custTarget) {
  const t = noticeTarget || '全員';
  if (t === '全員') return true;
  if (t === '初回') return custTarget === 'new';
  if (t === 'リピーター') return custTarget === 'keep' || custTarget === 'visitor';
  return true;
}

app.get('/api/store', (req, res) => {
  const storeId = resolveStoreId(req.query.store);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  const staffList = engine.getCustomerStaffList_(storeId);
  const zones = engine.getZonesConfig_(storeId);
  const customer = getCustomerFormInfo_(storeId, req.query.cid);
  const custTarget = customer.target || 'new';
  // ★2026-09-19追加／2026-09-23拡張：メニューマスタで管理している有効なメニューを、
  //   お客様予約フォーム用に返す。★2026-09-23：GAS版 getCustomerMenuList_ と同じく、
  //   顧客区分（target）に応じてtarget列でフィルタし、初回おすすめの目印
  //   （isFeatured）・メンバー限定の目印（isMemberOnly）も付与するようにした。
  const menuItemsRaw = db.prepare(`
    SELECT id, category, name, duration_min, price, target FROM menu_items
    WHERE store_id = ? AND is_active = 1 ORDER BY display_order ASC, id ASC
  `).all(storeId);
  // ★2026-09-23追加：GAS版customer_form.html（selectKeepUpgrade/buildKeepUpgradeCard）の
  //   移植に伴う変更。GAS版は「既存のお客様（キープ以外）」に対して、メンバー限定メニューを
  //   最初から除外するのではなく、見えてはいるが選択できない状態（disabled-until-upgrade）で
  //   一覧に含めておき、「キープメンバーへの変更を希望する」を選択した瞬間にその場で選択可能
  //   にする（＝同じ来店で即メンバーコースを予約できる）作りになっている。この挙動を再現する
  //   ため、target==='visitor'の場合のみメンバー限定メニューもmenuTargetMatches_の対象外で
  //   あっても含め、requiresKeepUpgrade:trueを付与してクライアント側で「変更希望」選択まで
  //   選択不可にする（'new'＝来店実績0のお客様は対象外。GAS版のisVisitor条件と同じ）。
  const menuItems = menuItemsRaw
    .filter((item) => menuTargetMatches_(item.target, custTarget) || (item.target === 'キープメンバー' && custTarget === 'visitor'))
    .map((item) => {
      const isMemberOnly = item.target === 'キープメンバー' || (item.name || '').indexOf('メンバーコース') >= 0;
      return {
        ...item,
        isFeatured: custTarget === 'new' && item.target === '初回',
        isMemberOnly,
        requiresKeepUpgrade: isMemberOnly && custTarget === 'visitor'
      };
    });
  // ★2026-09-20追加／2026-09-23拡張：受付ルール・注意書き（rule2）。
  //   ★2026-09-23：GAS版 getRule2Notices_ と同じく、顧客区分（target）に応じて
  //   '全員'／'初回'／'リピーター'の出し分けを行うようにした。
  const notices = db.prepare(`
    SELECT text, target FROM booking_notices WHERE store_id = ? AND is_active = 1 ORDER BY id ASC
  `).all(storeId)
    .filter((n) => noticeTargetMatches_(n.target, custTarget))
    .map((r) => r.text);
  res.json({ store, staffList, zones, menuItems, notices, customer });
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
// ★2026-09-23修正：セキュリティ上の問題を発見・修正。以前はこのエンドポイントに
//   認証が一切無く、お客様予約フォーム（未ログインで誰でも開けるページ）が
//   店舗全体の全予約（他のお客様の氏名・日時・メニュー）を一覧表示するために呼んで
//   いた。GAS版の customer_form.html にはそもそもこのような店舗全体の予約一覧を
//   お客様へ見せる機能は存在せず、個人情報の露出でしかなかったため、①お客様予約
//   フォーム側の表示（public/index.html・app.js）を削除し②このエンドポイント自体も
//   requireStaffSession必須（スタッフ・オーナーのみ）に変更した。
app.get('/api/reservations', requireStaffSession, (req, res) => {
  const storeId = req.session.staff.storeId;
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
app.post('/api/reservations', async (req, res) => {
  try {
    const data = req.body || {};
    const storeId = resolveStoreId(data.store);

    if (!data.realname || !data.staffName || !data.date || !data.time || !data.menu) {
      return res.status(400).json({ error: 'realname / staffName / date / time / menu は必須です' });
    }

    // ★2026-09-22追加：GAS版submitCustomerBooking_body_の移植。顧客ID付きでの送信
    //   （＝お客様予約フォームでURLの?cid=から本人特定できていた場合）は、クライアント側の
    //   入力ではなく顧客マスタの本名・フリガナ・LINE表示名を正として使う。また、画面表示だけ
    //   でなくサーバー側でも「予約フォーム受付拒否」フラグを再チェックする（クライアント側の
    //   チェックだけに頼らない、GAS版と同じ二重防御）。
    let bookingCustomer = null;
    if (data.customerId) {
      const cust = db.prepare(
        'SELECT * FROM customers WHERE store_id = ? AND customer_id = ? AND is_deleted = 0'
      ).get(storeId, data.customerId);
      if (cust) {
        if (cust.booking_blocked) {
          return res.status(200).json({ success: false, message: 'この内容では予約できません。お電話でお問い合わせください。' });
        }
        bookingCustomer = cust;
        data.realname = cust.realname || data.realname;
        data.kana = cust.kana || data.kana;
        data.lineName = cust.line_name || data.lineName;
        data.userId = cust.user_id || data.userId;
      }
    }

    // ★2026-09-23追加：GAS版 submitCustomerBooking_body_（reservation_form_functions.js
    //   lines 900-959）の移植。キープメンバーかつ担当者指名ありの場合のみ即「確定」、
    //   それ以外（初めての方／既存お客様でもキープ以外／指名なしの場合はキープメンバーでも）は
    //   「仮予約」として登録する（担当者未定の場合はキープメンバーでも仮予約扱いにする、という
    //   GAS版の2026-09-02修正をそのまま踏襲）。
    const isKeep = !!(bookingCustomer && bookingCustomer.is_keep_member);
    const staffUnassigned = !data.staffName || data.staffName === '未定';
    const yoyakuStatus = (isKeep && !staffUnassigned) ? '確定' : '仮予約';

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
        (@store_id, @realname, @kana, @line_name, @user_id, @staff_name, @menu, @reservation_date, @reservation_time, @note, @editor, 0, 0, @customer_id, @status)
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
        customer_id: data.customerId || '',
        status: yoyakuStatus
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

    // ★2026-09-23更新：GAS版 submitCustomerBooking_body_ の移植。確定（キープメンバー＋
    //   担当者指名あり）の場合は'confirm_keep'、仮予約の場合は'confirm_provisional'の
    //   テンプレートで通知する。
    //   ★2026-09-23同日再修正：以前はGAS版に倣い「お客様向けレスポンスにLINE通知の成否を
    //   含めない」設計にしていたが、社長より「LINE IDと紐づけされているお客様には
    //   メッセージが送信されるはず。お客様にも通知が送られたことが分かるように」との
    //   ご指摘を受け、方針変更。LINE連携済み（user_idあり）のお客様に限り、予約完了画面に
    //   通知結果（📱送信済み／⚠️失敗）を表示する（スタッフ・オーナー向け操作画面で既に
    //   使っている notifyAndGetResult と同じ文言パターンに合わせる）。LINE未連携の
    //   お客様には、そもそもLINEを使っていない可能性もあるため、この文言自体を表示しない。
    //   これに伴い、通知完了を待ってからレスポンスを返す（fire-and-forgetをやめる）。
    let lineNotifySuffix = '';
    if (data.customerId) {
      const customerForNotify = db.prepare(
        'SELECT * FROM customers WHERE store_id = ? AND customer_id = ?'
      ).get(storeId, data.customerId);
      if (customerForNotify && customerForNotify.user_id) {
        const notifyMessageKey = (isKeep && !staffUnassigned) ? 'confirm_keep' : 'confirm_provisional';
        const notifyResult = await notifyAndGetResult(storeId, data.customerId, {
          staffName: data.staffName,
          menu: data.menu,
          date: data.date,
          time: data.time
        }, notifyMessageKey);
        markReservationLineSent(info.lastInsertRowid, notifyResult.sent);
        lineNotifySuffix = notifyResult.sent
          ? '\n📱 ご登録のLINEに予約確認をお送りしました'
          : '\n⚠️ LINEへの通知の送信に失敗しました（恐れ入りますが内容のご確認をお願いいたします）';
      }
    }

    const baseMessage = (yoyakuStatus === '確定'
      ? '✅ 予約を確定しました'
      : '✅ 仮予約として受け付けました。店舗より確定のご連絡をいたします') + lineNotifySuffix;
    res.json({ success: true, message: baseMessage, status: yoyakuStatus, reservationId: info.lastInsertRowid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ★2026-09-23追加：POST /api/customer-registration
//   お客様予約フォームからの「新規登録」／「キープメンバーへの変更希望」送信を
//   受け付ける公開エンドポイント（GAS版 registerNewCustomer 相当）。ログイン不要
//   （store・cidをパラメータで受け取るのは他の公開/api/store等と同じ）。
//   本体のロジック（バリデーション・重複判定・登録/更新の分岐）は
//   lib/customerMerge.js の registerCustomerFromPublicForm に実装している。
//
//   POST body: { store, customerId(省略可), lastName, firstName, lastKana, firstKana,
//                phone, address, lineName, userId, keepMemberRequested(true/false/省略可) }
// ----------------------------------------------------------------------------
app.post('/api/customer-registration', (req, res) => {
  try {
    const data = req.body || {};
    const storeId = resolveStoreId(data.store);
    const result = registerCustomerFromPublicForm(db, storeId, data);
    if (!result.success) {
      return res.status(result.status || 400).json({ success: false, message: result.message });
    }
    res.json({ success: true, customerId: result.customerId });
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
//   ★2026-09-20追加：以前はis_owner=1のスタッフのみログインを許可し、一般スタッフは
//   明示的にブロックしていた（将来のスタッフ向け画面のための足場だけ用意した状態）。
//   GAS版staff_dashboard.htmlの移植（スタッフ用ダッシュボード：予約確認・シフト管理）
//   に伴い、一般スタッフのログインもここで解放する。オーナー用の/admin/*配下は
//   引き続きrequireOwnerSessionで保護されたままなので、一般スタッフがログインしても
//   オーナー専用機能へはアクセスできない（/api/staff/*という新しい別枠のAPI群を用意する）。
// ============================================================================

// ----------------------------------------------------------------------------
// ★2026-09-24追加：ログインをGAS版login_modal_partial.htmlと同じ2段階方式に変更
//   ①店舗のスタッフ名タイル一覧を出す（GET /api/auth/login-staff、GAS版getStaffLoginList相当）
//   ②タイルで本人を選び、4桁PINを入力して送信（POST /api/auth/login、GAS版loginStaff_相当）
//   以前の「店舗＋PINだけ」で店舗内の全スタッフと照合する方式は、同じ店舗にPINが
//   重複するスタッフがいると誰としてログインしたか区別できなかったため廃止した
//   （staffIdで本人を特定してからPINを照合するので、PINの重複は問題にならない）。
// ----------------------------------------------------------------------------

// 店舗の slug または ID を厳密に解決する（resolveStoreIdと違い、見つからなければnull。
//   ログイン画面で店舗の打ち間違いに気付かず、既定店舗のタイルが出てしまう事故を防ぐため）
function resolveStoreIdStrict_(storeSlugOrId) {
  if (storeSlugOrId == null || String(storeSlugOrId).trim() === '') return null;
  const key = String(storeSlugOrId).trim();
  const byId = /^\d+$/.test(key) ? db.prepare('SELECT id FROM stores WHERE id = ?').get(Number(key)) : null;
  if (byId) return byId.id;
  const bySlug = db.prepare('SELECT id FROM stores WHERE slug = ?').get(key);
  return bySlug ? bySlug.id : null;
}

// ----------------------------------------------------------------------------
// GET /api/auth/login-staff?store=slugまたはID
//   → { success, store:{id,slug,name}, staff:[{id,name,isTerminal}] }
//   ログイン画面の名前タイル用。在籍中かつPIN設定済みのスタッフのみ、登録順（id順）で
//   返し、サロン端末（共有ログイン）はGAS版のタイル並びと同じく末尾に置く。
//   未ログインで呼べるAPIのため、権限（isOwner）やPIN有無などの内部情報は返さない。
// ----------------------------------------------------------------------------
app.get('/api/auth/login-staff', (req, res) => {
  try {
    const storeId = resolveStoreIdStrict_(req.query.store);
    if (!storeId) {
      return res.status(404).json({ success: false, message: '店舗が見つかりません' });
    }
    const store = db.prepare('SELECT id, slug, name FROM stores WHERE id = ?').get(storeId);
    const rows = db.prepare(`
      SELECT id, name, is_shared_terminal FROM staff
      WHERE store_id = ? AND is_active = 1 AND pin_hash IS NOT NULL
      ORDER BY is_shared_terminal ASC, id ASC
    `).all(storeId);
    res.json({
      success: true,
      store,
      staff: rows.map((r) => ({ id: r.id, name: r.name, isTerminal: !!r.is_shared_terminal }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/auth/login : { staffId, pin, store? } でログインし、成功時はセッションを発行する
//   → { success, staffId, name, role, isOwner, isTerminal, storeId }（GAS版loginStaff_の戻り値
//   {success, staffId, name, role, isOwner, token} に合わせた形。GAS版のtokenは、Node版では
//   Cookieのセッションが同じ役割を担うため返さない）
//   store を一緒に送った場合は、そのstaffIdが本当にその店舗の人かも確認する。
// ----------------------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  try {
    const { staffId, pin, store } = req.body || {};
    if (!staffId || !pin) {
      return res.status(400).json({ success: false, message: 'スタッフを選択し、PINを入力してください' });
    }
    const matched = db.prepare(
      'SELECT * FROM staff WHERE id = ? AND is_active = 1 AND pin_hash IS NOT NULL'
    ).get(Number(staffId));
    const storeOk = !store || (matched && resolveStoreIdStrict_(store) === matched.store_id);
    if (!matched || !storeOk || !verifyPin(pin, matched.pin_salt, matched.pin_hash)) {
      return res.status(401).json({ success: false, message: 'PINが正しくありません' });
    }

    const isTerminal = !!matched.is_shared_terminal;
    req.session.staff = {
      id: matched.id,
      storeId: matched.store_id,
      name: matched.name,
      role: matched.role,
      // ★サロン端末はGAS版（ST099）と同じくisOwner扱い。カレンダー上の予約編集は
      //   オーナーと同等の全権限を持たせるのが意図した設計（社長確認済み）
      isOwner: !!matched.is_owner || isTerminal,
      isTerminal
    };

    // ★2026-09-19追加：res.json()を呼ぶ前にreq.session.save()の完了を明示的に待つ。
    //   resave:falseの設定では、レスポンスがクライアントに届くタイミングと
    //   セッションストアへの書き込み完了のタイミングの前後関係が環境によって
    //   ずれる可能性があるため、「必ずセッション保存が終わってからレスポンスを返す」
    //   ことを保証し、「ログインは成功と表示されるがセッションが認識されない」
    //   不具合の芽を摘んでおく。
    req.session.save((err) => {
      if (err) {
        console.error('セッション保存エラー:', err);
        return res.status(500).json({ success: false, message: 'セッションの保存に失敗しました' });
      }
      const st = req.session.staff;
      res.json({
        success: true, staffId: st.id, name: st.name, staffName: st.name, role: st.role,
        storeId: st.storeId, isOwner: st.isOwner, isTerminal: st.isTerminal
      });
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ============================================================================
// ★2026-09-24追加：管理者（相野様お一人・GAS版control_panel.html／platform_admin.gs相当）
//   専用ログイン（フェーズA：単一店舗の枠内で完結する管理者権限）
//
//   【認証方式】環境変数 PLATFORM_ADMIN_PASSWORD（12文字以上）と照合する。
//   ・店舗のスタッフマスタ（staffテーブルのPIN）とは完全に独立させ、特定の店舗の
//     スタッフには紐付けない。DBに保存しないので、Render無料プランの再デプロイで
//     DBが初期化されても消えず、コードやDBが漏れてもパスワードは漏れない
//   ・未設定（または12文字未満）の場合は管理者ログイン自体を無効にする。旧
//     ADMIN_PASSWORD のような既定値は持たない（既定値はGitHub上のコードから誰でも読めるため）
//   ・起動時にscryptでハッシュ化し、照合は lib/auth.js の定数時間比較で行う
//   ・連続して5回失敗したら15分間ロックする（ブルートフォース対策）。管理者は1人なので、
//     接続元ごとではなく管理者ログイン全体で数える
//   【ログイン後】既存のオーナー用管理画面にオーナーと同じ権限で入れるうえ、
//     session.staff.isAdmin が付き、管理者専用機能（初期メニューの名称・カテゴリ編集、
//     DB一覧ビューアの編集・編集ログ・LINE webhook受信ログ）が解禁される。
//   【対象店舗】フェーズAは単一店舗（クラーレ寿）で完結させるため、環境変数
//     PLATFORM_ADMIN_STORE（slugまたはID、既定は店舗ID 1）の店舗に固定する。
//     複数店舗の切り替え（フェーズB）は別途設計する。
// ============================================================================
const PLATFORM_ADMIN_MIN_LENGTH = 12;
const PLATFORM_ADMIN_MAX_FAILURES = 5;
const PLATFORM_ADMIN_LOCK_MS = 15 * 60 * 1000;
const PLATFORM_ADMIN_NAME = '管理者';
const platformAdminPassword = process.env.PLATFORM_ADMIN_PASSWORD || '';
const platformAdminHash = platformAdminPassword.length >= PLATFORM_ADMIN_MIN_LENGTH ? createPinHash(platformAdminPassword) : null;
if (!platformAdminHash) {
  console.warn(platformAdminPassword
    ? `⚠️  PLATFORM_ADMIN_PASSWORD が${PLATFORM_ADMIN_MIN_LENGTH}文字未満のため、管理者ログインを無効にしています。`
    : 'ℹ️  PLATFORM_ADMIN_PASSWORD 環境変数が未設定のため、管理者ログインは無効です（必要な場合のみ設定してください）。');
}
const platformAdminLock = { failures: 0, lockedUntil: 0 };

// POST /api/auth/admin-login : { password } → { success, isAdmin, storeId, name }
app.post('/api/auth/admin-login', (req, res) => {
  try {
    if (!platformAdminHash) {
      return res.status(503).json({ success: false, message: '管理者ログインは設定されていません（PLATFORM_ADMIN_PASSWORD 未設定）' });
    }
    const now = Date.now();
    if (platformAdminLock.lockedUntil > now) {
      const minutes = Math.ceil((platformAdminLock.lockedUntil - now) / 60000);
      return res.status(429).json({ success: false, message: `ログインに続けて失敗したため、あと約${minutes}分間ロックされています` });
    }
    const password = String((req.body && req.body.password) || '');
    if (!password || !verifyPin(password, platformAdminHash.salt, platformAdminHash.hash)) {
      platformAdminLock.failures++;
      if (platformAdminLock.failures >= PLATFORM_ADMIN_MAX_FAILURES) {
        platformAdminLock.failures = 0;
        platformAdminLock.lockedUntil = now + PLATFORM_ADMIN_LOCK_MS;
        console.warn('⚠️  管理者ログインに5回続けて失敗したため、15分間ロックしました');
      }
      return res.status(401).json({ success: false, message: 'パスワードが正しくありません' });
    }
    const storeId = resolveStoreIdStrict_(process.env.PLATFORM_ADMIN_STORE || DEFAULT_STORE_ID);
    if (!storeId) {
      return res.status(500).json({ success: false, message: 'PLATFORM_ADMIN_STORE の店舗が見つかりません' });
    }
    platformAdminLock.failures = 0;
    // ★既存の管理画面・APIはすべて session.staff を前提にしているため、同じ形で持たせる。
    //   id は特定の店舗スタッフに紐付けないため null（スタッフ管理の「自分自身」判定等に
    //   引っかからない）。isOwner:true でオーナーの全機能、isAdmin:true で管理者専用機能。
    req.session.staff = {
      id: null,
      storeId,
      name: PLATFORM_ADMIN_NAME,
      role: PLATFORM_ADMIN_NAME,
      isOwner: true,
      isTerminal: false,
      isAdmin: true
    };
    req.session.save((err) => {
      if (err) {
        console.error('セッション保存エラー:', err);
        return res.status(500).json({ success: false, message: 'セッションの保存に失敗しました' });
      }
      res.json({ success: true, isAdmin: true, isOwner: true, storeId, name: PLATFORM_ADMIN_NAME });
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// requireAdminSession : 管理者専用API（DB一覧ビューアの編集・監査ログ・webhookログ等）を守る
function requireAdminSession(req, res, next) {
  if (!req.session || !req.session.staff) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!req.session.staff.isAdmin) {
    return res.status(403).json({ error: 'admin_only', message: 'この操作は管理者ログイン時のみ利用できます' });
  }
  next();
}

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
//   ★2026-09-24追加：サロン端末（GAS版ST099相当、session.staff.isTerminal）は
//   isOwner扱いだが、/api/admin/* のうち下の TERMINAL_ALLOWED_ADMIN_APIS に挙げた
//   API（GAS版top_page.htmlで端末にも出していた「顧客マスタ閲覧」「予約データ閲覧」
//   画面が使うものと、カレンダー上のイベント（予約枠ブロック）操作）だけを許可し、
//   それ以外（店舗設定・スタッフ管理・顧客/予約の編集など）は403で拒否する。
//   「許可したものだけ通す」方式なので、今後/api/admin/*にAPIを足しても、
//   端末からは自動的に使えない（安全側に倒れる）。
// ----------------------------------------------------------------------------
const TERMINAL_ALLOWED_ADMIN_APIS = [
  // 顧客マスタ閲覧（customers-view.html）。GAS版customer_view.htmlは閲覧専用画面だが、
  //   統合（マージ）とキープメンバーの1クリック切替だけはこの画面から操作できたため、
  //   同画面を開ける端末でも同じ操作を許可する（README 57章参照）
  { method: 'GET', re: /^\/api\/admin\/customers$/ },
  { method: 'GET', re: /^\/api\/admin\/customers\/merge-candidates$/ },
  { method: 'POST', re: /^\/api\/admin\/customers\/merge-candidates\/dismiss$/ },
  { method: 'POST', re: /^\/api\/admin\/customers\/merge$/ },
  { method: 'POST', re: /^\/api\/admin\/customers\/[^/]+\/toggle-keep-member$/ },
  // 予約データ閲覧（reservations-view.html）
  { method: 'GET', re: /^\/api\/admin\/reservations$/ },
  // サロンダッシュボード（staff/calendar.html）のイベント＝予約枠ブロックの登録・編集・削除。
  //   端末はカレンダー上ではオーナーと同等の全権限を持つ設計のため
  { method: 'GET', re: /^\/api\/admin\/events$/ },
  { method: 'POST', re: /^\/api\/admin\/events$/ },
  { method: 'PUT', re: /^\/api\/admin\/events\/\d+$/ },
  { method: 'DELETE', re: /^\/api\/admin\/events\/\d+$/ }
];
function terminalMayUseAdminApi_(req) {
  const path = req.baseUrl + req.path;
  return TERMINAL_ALLOWED_ADMIN_APIS.some((a) => a.method === req.method && a.re.test(path));
}
function requireOwnerSession(req, res, next) {
  if (!req.session || !req.session.staff || !req.session.staff.isOwner) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.session.staff.isTerminal && !terminalMayUseAdminApi_(req)) {
    return res.status(403).json({ error: 'forbidden_for_shared_terminal', message: 'サロン端末ではこの操作はできません（オーナーのみ）' });
  }
  next();
}

// ----------------------------------------------------------------------------
// requireStaffSession : /api/staff/* をセッションのみで保護するミドルウェア
//   （requireOwnerSessionと違い、オーナー権限は問わない。ログインさえしていれば
//   一般スタッフでもオーナーでも自分自身のダッシュボードは見られる）
// ----------------------------------------------------------------------------
function requireStaffSession(req, res, next) {
  if (!req.session || !req.session.staff) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ----------------------------------------------------------------------------
// ★2026-09-20追加：スタッフ用ダッシュボード（GAS版staff_dashboard.htmlの移植）
//   オーナー用の/api/admin/*とは別枠で、ログイン中の本人（req.session.staff.name）
//   の予約・シフトだけをstoreId・staff_nameの両方で絞り込んで返す。
//   他のスタッフの予約・シフトは（オーナーでない限り）見えない設計。
// ----------------------------------------------------------------------------
function defaultTwoWeekRange(req) {
  const fmt = (d) => {
    const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const from = req.query.from || fmt(today);
  const toDefault = new Date(today); toDefault.setDate(toDefault.getDate() + 13);
  const to = req.query.to || fmt(toDefault);
  return { from, to };
}

// ★2026-09-23追加：スタッフダッシュボードでの予約の見え方（GAS版dashboard_functions.jsの
//   `if (!isOwner && staffName !== myName && staffName !== '未定') return;` と同じ条件）。
//   オーナー：全員分／一般スタッフ：自分の担当＋担当が「未定」の予約
function staffReservationVisibility_(sessStaff) {
  if (sessStaff.isOwner) return { sql: '1 = 1', params: [] };
  return { sql: "(staff_name = ? OR staff_name = '未定')", params: [sessStaff.name] };
}
// ★2026-09-23追加：シフト表の対象スタッフ（GAS版getAllActiveStaff_相当：在籍中で見習い以外）
//   と、その表示色（サロンダッシュボードと同じくスタッフ管理画面で選んだ色）
function shiftTargetStaff_(storeId) {
  const colors = assignStaffColors_(storeId);
  return db.prepare(`
    SELECT name FROM staff WHERE store_id = ? AND is_active = 1 AND role != '見習い' AND is_shared_terminal = 0 ORDER BY id ASC
  `).all(storeId).map((r) => ({
    name: r.name,
    colorKey: colors[r.name] || '',
    color: CALENDAR_COLOR_MAP[colors[r.name]] || '#9E9E9E'
  }));
}

// GET /api/staff/shifts?from=&to= : 一般スタッフは自分のシフトのみ、オーナーは全員分を返す
app.get('/api/staff/shifts', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const staffName = req.session.staff.name;
    const { from, to } = defaultTwoWeekRange(req);

    // ★2026-09-23変更：GAS版getWeeklyShifts（dashboard_functions.js 56-125行）と同じく、
    //   オーナーは全スタッフのシフトを見られるようにした（一般スタッフは従来どおり本人分のみ）。
    //   オーナーはスタッフダッシュボードの週表示から、各スタッフのシフトを代理で追加・変更できる。
    const isOwner = !!req.session.staff.isOwner;
    const rows = isOwner
      ? db.prepare(`
          SELECT * FROM shift_master
          WHERE store_id = ? AND shift_date >= ? AND shift_date <= ? AND is_active = 1
          ORDER BY shift_date ASC, staff_name ASC, start_time ASC
        `).all(storeId, from, to)
      : db.prepare(`
          SELECT * FROM shift_master
          WHERE store_id = ? AND staff_name = ? AND shift_date >= ? AND shift_date <= ? AND is_active = 1
          ORDER BY shift_date ASC, start_time ASC
        `).all(storeId, staffName, from, to);

    res.json({ from, to, staffName, isOwner, shifts: rows, staffList: isOwner ? shiftTargetStaff_(storeId) : [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/staff/reservations?from=&to= : 自分が担当の予約のみ返す（キャンセル含む。
//   GAS版と同様にrealname='キャンセル'のまま返し、表示側で取り消し線等を出す）
app.get('/api/staff/reservations', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const staffName = req.session.staff.name;
    const { from, to } = defaultTwoWeekRange(req);

    // ★2026-09-23変更：GAS版getWeeklyReservations（dashboard_functions.js 6-53行）と同じ見え方に
    //   揃えた。一般スタッフは「自分の担当＋担当が未定の予約」、オーナーは全員分を見られる。
    //   以前は本人担当分だけだったため、誰かが引き受けるべき「未定」の予約が一般スタッフに
    //   見えていなかった。キャンセル済みは従来どおり本人担当分だけ（取り消し線表示用）。
    const vis = staffReservationVisibility_(req.session.staff);
    const rows = db.prepare(`
      SELECT * FROM reservations
      WHERE store_id = ? AND reservation_date >= ? AND reservation_date <= ?
        AND (staff_name = ? OR (realname != 'キャンセル' AND ${vis.sql}))
      ORDER BY reservation_date ASC, reservation_time ASC
    `).all(storeId, from, to, staffName, ...vis.params);

    res.json({ from, to, staffName, reservations: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ★2026-09-20追加：月間カレンダー（GAS版staff_dashboard.htmlの
//   getMonthlyDateCounts_ / getMonthlyReservationCounts_ / getMonthlyPendingStatus_
//   に相当）。GAS版は「担当スタッフ別の月間件数＋仮予約バッジ」を1か月分まとめて
//   返し、カレンダーマス目をタップすると📋予約確認タブの該当週へジャンプする作りに
//   なっていた。
//   【簡略化】GAS版はオーナーが他スタッフの月間カレンダーを切り替えて見られたが
//  （ownerFocusStaffName引数）、Node版の/api/staff/*は既存の週次タブと同じく
//   「本人（session.staff.name）担当分のみ」に統一してある。他スタッフ・店舗全体の
//   予約状況はオーナー管理画面（/admin/reservations.html）で確認できるため、実害は
//   小さいと判断した。
//
// GET /api/staff/reservations/monthly?month=YYYY-MM
//   → { month, counts: { 'YYYY-MM-DD': { count, pending } } }
//   count: その日の自分担当の予約件数（キャンセル除く）
//   pending: その日に仮予約（status='仮予約'）が1件でもあればtrue
// ----------------------------------------------------------------------------
app.get('/api/staff/reservations/monthly', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const staffName = req.session.staff.name;
    const monthParam = String(req.query.month || '');
    const m = /^(\d{4})-(\d{2})$/.exec(monthParam);
    const now = new Date();
    const year = m ? Number(m[1]) : now.getFullYear();
    const month = m ? Number(m[2]) : now.getMonth() + 1; // 1-12
    const pad2 = (n) => String(n).padStart(2, '0');
    const monthStr = `${year}-${pad2(month)}`;
    const from = `${monthStr}-01`;
    const lastDay = new Date(year, month, 0).getDate(); // month is 1-based here → day 0 of next month
    const to = `${monthStr}-${pad2(lastDay)}`;

    // ★2026-09-23追加：オーナーは ?staff=名前 で他のスタッフの件数も見られる
    //   （GAS版getMonthlyReservationCountsのtargetStaffName引数＝月間シフト表で
    //   凡例からスタッフを選んだ「○○さんの1ヶ月」表示用）。一般スタッフは常に本人分。
    const isOwner = !!req.session.staff.isOwner;
    const targetStaff = (isOwner && req.query.staff) ? String(req.query.staff) : staffName;
    const rows = db.prepare(`
      SELECT reservation_date, status FROM reservations
      WHERE store_id = ? AND staff_name = ? AND realname != 'キャンセル'
        AND reservation_date >= ? AND reservation_date <= ?
    `).all(storeId, targetStaff, from, to);

    const counts = {};
    rows.forEach((r) => {
      if (!counts[r.reservation_date]) counts[r.reservation_date] = { count: 0, pending: false };
      counts[r.reservation_date].count++;
      if (r.status === '仮予約') counts[r.reservation_date].pending = true;
    });

    // ★2026-09-23追加：オーナーには店舗全体で仮予約がある日も返す（GAS版
    //   getMonthlyPendingStatus相当。月間シフト表の全員表示で「⚠️仮予約」を出す）
    let pendingDates = {};
    if (isOwner) {
      db.prepare(`
        SELECT DISTINCT reservation_date FROM reservations
        WHERE store_id = ? AND realname != 'キャンセル' AND status = '仮予約'
          AND reservation_date >= ? AND reservation_date <= ?
      `).all(storeId, from, to).forEach((r) => { pendingDates[r.reservation_date] = true; });
    }

    res.json({ month: monthStr, from, to, staffName: targetStaff, counts, pendingDates });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ★2026-09-22追加：GAS版dashboard_functions.gs getUpcomingReservationsの移植。
//   スタッフダッシュボードの「📋 直近の予約」カード用に、本人担当の予約のうち
//   「今日から UPCOMING_RESERVATION_DAYS 日以内」のものだけを日時順で返す。
//   GAS版はオーナーなら全スタッフ分・未定担当分も含めていたが、Node版の/api/staff/*は
//   既存の週次・月間タブと同じ方針（本人担当分のみに統一、簡略化）に合わせてある。
// GET /api/staff/reservations/upcoming
// ----------------------------------------------------------------------------
app.get('/api/staff/reservations/upcoming', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const staffName = req.session.staff.name;
    let rangeDays = Number(engine.getRuleValue_(storeId, 'UPCOMING_RESERVATION_DAYS'));
    if (!rangeDays || Number.isNaN(rangeDays)) rangeDays = 15;

    const pad2 = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const endDate = new Date(today); endDate.setDate(today.getDate() + rangeDays);
    const from = fmt(today);
    const to = fmt(endDate);

    // ★2026-09-23変更：GAS版getUpcomingReservationsと同じく、オーナーは全員分、
    //   一般スタッフは自分の担当＋担当未定の予約を表示する
    const vis = staffReservationVisibility_(req.session.staff);
    const rows = db.prepare(`
      SELECT * FROM reservations
      WHERE store_id = ? AND realname != 'キャンセル' AND ${vis.sql}
        AND reservation_date >= ? AND reservation_date <= ?
      ORDER BY reservation_date ASC, reservation_time ASC
    `).all(storeId, ...vis.params, from, to);

    res.json({ from, to, rangeDays, staffName, isOwner: !!req.session.staff.isOwner, reservations: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ★2026-09-23追加：スタッフダッシュボードの「月間シフト表」（GAS版staff_dashboard.html
//   1045-1314行・dashboard_functions.js getMonthlyShifts / getDayReservations の移植）
//
// GET /api/staff/shifts/monthly?month=YYYY-MM
//   → { month, isOwner, myName, shifts:[{id,staffName,date,startTime,endTime}], staffList:[{name,color}] }
//   GAS版は全員分のシフトを返し、一般スタッフの場合は画面側で本人分だけ表示していたが、
//   Node版は他のスタッフのシフトを一般スタッフへ送らないよう、サーバー側で本人分に絞る。
// ----------------------------------------------------------------------------
app.get('/api/staff/shifts/monthly', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const myName = req.session.staff.name;
    const isOwner = !!req.session.staff.isOwner;
    const m = /^(\d{4})-(\d{2})$/.exec(String(req.query.month || ''));
    const now = new Date();
    const year = m ? Number(m[1]) : now.getFullYear();
    const month = m ? Number(m[2]) : now.getMonth() + 1;
    const pad2 = (n) => String(n).padStart(2, '0');
    const monthStr = `${year}-${pad2(month)}`;
    const from = `${monthStr}-01`;
    const to = `${monthStr}-${pad2(new Date(year, month, 0).getDate())}`;
    const rows = isOwner
      ? db.prepare(`SELECT id, staff_name, shift_date, start_time, end_time FROM shift_master
                    WHERE store_id = ? AND is_active = 1 AND shift_date >= ? AND shift_date <= ?
                    ORDER BY shift_date, staff_name, start_time`).all(storeId, from, to)
      : db.prepare(`SELECT id, staff_name, shift_date, start_time, end_time FROM shift_master
                    WHERE store_id = ? AND is_active = 1 AND staff_name = ? AND shift_date >= ? AND shift_date <= ?
                    ORDER BY shift_date, start_time`).all(storeId, myName, from, to);
    res.json({
      month: monthStr, from, to, isOwner, myName,
      shifts: rows.map((r) => ({ id: r.id, staffName: r.staff_name, date: r.shift_date, startTime: r.start_time, endTime: r.end_time })),
      staffList: shiftTargetStaff_(storeId)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/staff/reservations/day?date=YYYY-MM-DD
//   その日の予約（キャンセル除く・開始時刻順）。見え方は週表示と同じ（オーナー：全員／
//   一般スタッフ：自分＋未定）。GAS版getDayReservations相当。
app.get('/api/staff/reservations/day', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date（YYYY-MM-DD）は必須です' });
    const vis = staffReservationVisibility_(req.session.staff);
    const rows = db.prepare(`
      SELECT id, realname, staff_name, menu, reservation_date, reservation_time, note, status, customer_id
      FROM reservations
      WHERE store_id = ? AND reservation_date = ? AND realname != 'キャンセル' AND ${vis.sql}
      ORDER BY reservation_time ASC
    `).all(storeId, date, ...vis.params);
    res.json({ date, reservations: rows.map((r) => ({ ...r, end_time: addMinutesToTime_(r.reservation_time, 90) })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/staff/shifts/booking-check?staffName=&date=
//   シフト削除の前に、その日にそのスタッフの予約が入っていないか確認する
//   （GAS版checkShiftBooking相当。画面で「⚠️予約が入っています」と警告してから削除させる）。
//   一般スタッフは本人分しか確認できない。
app.get('/api/staff/shifts/booking-check', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const isOwner = !!req.session.staff.isOwner;
    const staffName = isOwner && req.query.staffName ? String(req.query.staffName) : req.session.staff.name;
    const date = String(req.query.date || '');
    const rows = db.prepare(`
      SELECT realname, reservation_time FROM reservations
      WHERE store_id = ? AND staff_name = ? AND reservation_date = ? AND realname != 'キャンセル'
      ORDER BY reservation_time
    `).all(storeId, staffName, date);
    res.json({ hasBooking: rows.length > 0, bookingInfo: rows.map((r) => `${r.reservation_time} ${r.realname}さん`).join('、') });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ★2026-09-23追加：GET /api/staff/available-slots
//   ?staffName=&date=&excludeId= : スタッフ／オーナー向けの予約登録・編集画面の
//   「🔍空き時間を確認する」ボタン用（GAS版reservation_form_functions.gs
//   getAvailableSlots相当、README §51-7で見送っていたもの）。一般スタッフには
//   実際に空いている枠のみ（埋まっている理由付き）、オーナーには全時間帯を
//   warn付きで返す（シフト外・満床・イベント・予約済みでも警告のうえ選べる）。
//   staffNameを空／'未定'で呼ぶと「誰でも良い」扱いになり、一般スタッフの場合は
//   在籍中の全スタッフの予約状況を合算してブロック判定する（GAS版と同じ）。
// ----------------------------------------------------------------------------
app.get('/api/staff/available-slots', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const isOwner = !!req.session.staff.isOwner;
    const staffName = String(req.query.staffName || '未定');
    const date = String(req.query.date || '');
    const excludeId = req.query.excludeId ? Number(req.query.excludeId) : null;
    if (!date) {
      return res.status(400).json({ success: false, message: 'dateは必須です' });
    }
    const slots = engine.getAvailableSlots_(storeId, staffName, date, excludeId, isOwner);
    res.json({ success: true, isOwner, slots });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

function addMinutesToTime_(t, add) {
  const m = engine.toMin_(t) + add;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// ----------------------------------------------------------------------------
// ★2026-09-22追加：GAS版dashboard_functions.gs addShiftRow_body_ /
//   saveWeeklyShifts_body_ / deleteShiftRow_body_ の移植。スタッフダッシュボードの
//   「② シフト編集モーダル」相当で、一般スタッフが自分自身のシフトを直接
//   追加・変更・削除できるようにする（他スタッフのシフトは対象外）。
//   GAS版は「オーナーなら3日前ルールを免除・他スタッフも編集可」だったが、
//   Node版の/api/staff/*は既存方針（本人分のみに統一）に合わせ、オーナーが
//   自分自身の分を編集する場合のみ3日前ルールを免除する（他スタッフの代理編集は
//   従来通り管理画面 /admin/shifts.html を使う）。
//   予約との重複チェック（この時間帯に既に本人担当の予約が入っていないか）も
//   GAS版と同様に行う。
// ----------------------------------------------------------------------------
const STAFF_SHIFT_EDIT_LOCK_DAYS = 3;

function staffShiftEditDateOk_(isOwner, dateStr) {
  if (isOwner) return true;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const limit = new Date(today); limit.setDate(today.getDate() + STAFF_SHIFT_EDIT_LOCK_DAYS);
  const target = new Date(String(dateStr).replace(/\//g, '-') + 'T00:00:00');
  return target >= limit;
}

// ★指定スタッフ・日付・時間帯に、本人担当の予約（キャンセル除く）が重なっていないか確認する
function staffHasBookingConflict_(storeId, staffName, dateStr, startTime, endTime) {
  const rows = db.prepare(`
    SELECT reservation_time FROM reservations
    WHERE store_id = ? AND staff_name = ? AND reservation_date = ? AND realname != 'キャンセル'
  `).all(storeId, staffName, dateStr);
  const newStart = engine.toMin_(startTime);
  const newEnd = engine.toMin_(endTime);
  return rows.some((r) => {
    const resStart = engine.toMin_(r.reservation_time);
    const resEnd = resStart + 90; // ★施術時間は既存コードと同じ固定90分想定
    return resStart < newEnd && resEnd > newStart;
  });
}

// POST /api/staff/shifts : 自分自身のシフトを新規追加する
app.post('/api/staff/shifts', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const isOwner = !!req.session.staff.isOwner;
    const { date, startTime, endTime } = req.body || {};
    // ★2026-09-23追加：GAS版addShiftRow_body_と同じく、オーナーは担当スタッフを指定して
    //   代理でシフトを追加できる（一般スタッフは常に本人分のみ）
    let staffName = req.session.staff.name;
    if (isOwner && req.body && req.body.staffName && req.body.staffName !== staffName) {
      const target = db.prepare('SELECT name FROM staff WHERE store_id = ? AND name = ? AND is_active = 1 AND is_shared_terminal = 0').get(storeId, String(req.body.staffName));
      if (!target) return res.status(400).json({ success: false, message: '在籍中のスタッフとして見つかりません' });
      staffName = target.name;
    }
    if (!date || !startTime || !endTime) {
      return res.status(400).json({ success: false, message: '日付・開始時間・終了時間は必須です' });
    }
    if (!staffShiftEditDateOk_(isOwner, date)) {
      return res.status(400).json({ success: false, message: `${STAFF_SHIFT_EDIT_LOCK_DAYS}日以内のシフトは追加できません` });
    }
    if (engine.toMin_(startTime) >= engine.toMin_(endTime)) {
      return res.status(400).json({ success: false, message: '開始時間は終了時間より前にしてください' });
    }
    const dupe = db.prepare(`
      SELECT id FROM shift_master WHERE store_id = ? AND staff_name = ? AND shift_date = ? AND start_time = ? AND end_time = ?
    `).get(storeId, staffName, date, startTime, endTime);
    if (dupe) {
      return res.status(400).json({ success: false, message: '同じ内容のシフトが既に登録されています' });
    }
    db.prepare(`
      INSERT INTO shift_master (store_id, staff_name, shift_date, start_time, end_time, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(storeId, staffName, date, startTime, endTime);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/staff/shifts/:id : 自分自身のシフトの時間帯を変更する
app.put('/api/staff/shifts/:id', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const staffName = req.session.staff.name;
    const isOwner = !!req.session.staff.isOwner;
    const { id } = req.params;
    const { startTime, endTime } = req.body || {};
    if (!startTime || !endTime) {
      return res.status(400).json({ success: false, message: '開始時間・終了時間は必須です' });
    }
    // ★2026-09-23変更：オーナーは他のスタッフのシフトも変更できる（GAS版saveWeeklyShifts_body_と同じ）
    const row = isOwner
      ? db.prepare('SELECT * FROM shift_master WHERE id = ? AND store_id = ?').get(id, storeId)
      : db.prepare('SELECT * FROM shift_master WHERE id = ? AND store_id = ? AND staff_name = ?').get(id, storeId, staffName);
    if (!row) return res.status(404).json({ success: false, message: '対象のシフトが見つかりません（自分自身のシフトのみ変更できます）' });
    if (!staffShiftEditDateOk_(isOwner, row.shift_date)) {
      return res.status(400).json({ success: false, message: `${STAFF_SHIFT_EDIT_LOCK_DAYS}日以内のシフトは変更できません` });
    }
    if (engine.toMin_(startTime) >= engine.toMin_(endTime)) {
      return res.status(400).json({ success: false, message: '開始時間は終了時間より前にしてください' });
    }
    // ★予約が新しい時間帯の外にはみ出す場合は変更を拒否する（GAS版のhasBooking判定相当）
    const conflictRows = db.prepare(`
      SELECT reservation_time FROM reservations
      WHERE store_id = ? AND staff_name = ? AND reservation_date = ? AND realname != 'キャンセル'
    `).all(storeId, row.staff_name, row.shift_date);
    const newStart = engine.toMin_(startTime);
    const newEnd = engine.toMin_(endTime);
    const outOfRange = conflictRows.some((r) => {
      const resStart = engine.toMin_(r.reservation_time);
      const resEnd = resStart + 90;
      return resStart < newStart || resEnd > newEnd;
    });
    if (outOfRange) {
      return res.status(400).json({ success: false, message: 'この日に入っている予約の時間帯を含められないため変更できません' });
    }
    db.prepare('UPDATE shift_master SET start_time = ?, end_time = ? WHERE id = ?').run(startTime, endTime, id);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/staff/shifts/:id : 自分自身のシフトを削除する
app.delete('/api/staff/shifts/:id', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const staffName = req.session.staff.name;
    const isOwner = !!req.session.staff.isOwner;
    const { id } = req.params;
    // ★2026-09-23変更：オーナーは他のスタッフのシフトも削除できる。GAS版deleteShiftRow_body_と
    //   同じく、予約の重なりによる削除拒否は一般スタッフのみ（オーナーは画面側で「⚠️予約が
    //   入っています」の警告を確認したうえで削除できる）
    const row = isOwner
      ? db.prepare('SELECT * FROM shift_master WHERE id = ? AND store_id = ?').get(id, storeId)
      : db.prepare('SELECT * FROM shift_master WHERE id = ? AND store_id = ? AND staff_name = ?').get(id, storeId, staffName);
    if (!row) return res.status(404).json({ success: false, message: '対象のシフトが見つかりません（自分自身のシフトのみ削除できます）' });
    if (!staffShiftEditDateOk_(isOwner, row.shift_date)) {
      return res.status(400).json({ success: false, message: `${STAFF_SHIFT_EDIT_LOCK_DAYS}日以内のシフトは削除できません` });
    }
    if (!isOwner && staffHasBookingConflict_(storeId, staffName, row.shift_date, row.start_time, row.end_time)) {
      return res.status(400).json({ success: false, message: 'この時間帯に予約が入っているため削除できません' });
    }
    db.prepare('DELETE FROM shift_master WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ★2026-09-22追加：GAS版reservation_form_functions.gs addReservationUnified_body_ /
//   updateReservation_body_ / cancelReservation_body_ の移植（一般スタッフ向け）。
//   これまで予約の追加・編集・キャンセルは/api/admin/reservations（オーナー専用）
//   にしか存在せず、一般スタッフには開放されていなかった。GAS版では一般スタッフも
//   「自分の担当」または「担当未定」の予約であれば操作できたため、その挙動を
//   requireStaffSession + 所有権チェック（オーナーは無条件で許可）で再現する。
//
//   GAS版の権限ルール（isOwnerRole_での分岐）：
//   ・新規登録：一般スタッフは担当を「自分」か「未定」にしか指定できない
//   ・変更：一般スタッフは「元の担当が自分か未定」の予約のみ編集できる（変更後の担当は制限なし＝GAS版もそう）
//   ・キャンセル：一般スタッフは「担当が自分か未定」の予約のみキャンセルできる
//   ・予約上限超過：一般スタッフはハードブロック（登録不可）、オーナーはownerOverrideで続行可能
// ----------------------------------------------------------------------------

// POST /api/staff/reservations : 新規予約登録（電話予約・当日飛び込み対応、一般スタッフ向け）
app.post('/api/staff/reservations', requireStaffSession, async (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const staffName = req.session.staff.name;
    const isOwner = !!req.session.staff.isOwner;
    const data = req.body || {};

    if (!data.realname || !data.staffName || !data.date || !data.time || !data.menu) {
      return res.status(400).json({ success: false, message: 'realname / staffName / date / time / menu は必須です' });
    }

    // ★一般スタッフの新規登録は「自分」か「未定」の担当でのみ許可（他スタッフ指定は禁止）
    if (!isOwner && data.staffName !== staffName && data.staffName !== '未定') {
      return res.status(403).json({ success: false, message: '他のスタッフを担当に指定した新規登録はできません' });
    }

    const limitCheck = engine.checkCustomerReservationLimit(storeId, data.realname, null);
    if (limitCheck.exceeded) {
      if (!isOwner) {
        return res.status(400).json({
          success: false,
          message: `${data.realname}様の予約は現在${limitCheck.count}件あります。上限（${limitCheck.limit}件）に達しているため登録できません。オーナーにご相談ください。`
        });
      }
      if (!data.ownerOverride) {
        return res.status(200).json({
          success: false,
          isLimitWarning: true,
          message: `${data.realname}様の確定予約が${limitCheck.count}件あります（上限${limitCheck.limit}件）。このまま登録しますか？`,
          count: limitCheck.count,
          limit: limitCheck.limit
        });
      }
    }

    // ★2026-09-22追加：スタッフ用エンドポイントでも「仮予約として登録」チェックに対応
    //   （オーナー用/api/admin/reservationsと同じ仕組み。31章：スタッフダッシュボードの
    //   仮予約確定操作を実装するにあたり、これまでstatusが常に'確定'固定だった漏れに気付き修正）
    const status = data.provisional ? '仮予約' : '確定';

    const insert = db.prepare(`
      INSERT INTO reservations
        (store_id, realname, kana, line_name, user_id, staff_name, menu, reservation_date, reservation_time, note, editor, line_sent, done, customer_id, status)
      VALUES
        (@store_id, @realname, @kana, '', '', @staff_name, @menu, @reservation_date, @reservation_time, @note, @editor, 0, 0, @customer_id, @status)
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
        editor: staffName,
        customer_id: data.customerId || '',
        status
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

    let message = status === '仮予約' ? '✅ 仮予約として登録しました（確定操作が必要です）' : '✅ 予約を登録しました';
    // ★仮予約は確定操作時にconfirm_finalizeで通知するため、二重通知を避けここでは送らない
    if (status === '確定') {
      // ★2026-09-23追加修正：以前はINSERT時にline_sentを0固定のまま放置しており、
      //   通知が実際に成功していてもreservations-view.htmlの📨アイコンに反映されない
      //   不具合があった。notifyAndGetResult()のsentフラグで実態を書き込む。
      const notifyResult = await notifyAndGetResult(storeId, data.customerId, {
        staffName: data.staffName, menu: data.menu, date: data.date, time: data.time
      }, 'confirm_add');
      message += notifyResult.text;
      markReservationLineSent(info.lastInsertRowid, notifyResult.sent);
    }

    res.json({
      success: true,
      message,
      reservationId: info.lastInsertRowid
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/staff/reservations/:id : 予約の変更（元の担当が自分か未定の予約のみ／オーナーは制限なし）
app.put('/api/staff/reservations/:id', requireStaffSession, async (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const staffName = req.session.staff.name;
    const isOwner = !!req.session.staff.isOwner;
    const id = Number(req.params.id);
    const data = req.body || {};

    const existing = db.prepare('SELECT * FROM reservations WHERE id = ? AND store_id = ?').get(id, storeId);
    if (!existing) {
      return res.status(404).json({ success: false, message: '対象の予約が見つかりません' });
    }
    if (existing.realname === 'キャンセル') {
      return res.status(400).json({ success: false, message: 'キャンセル済みの予約は編集できません' });
    }
    // ★GAS版と同じく「元の担当」で判定する（変更後の担当は制限しない）
    if (!isOwner && existing.staff_name !== staffName && existing.staff_name !== '未定') {
      return res.status(403).json({ success: false, message: '他のスタッフの予約は編集できません' });
    }
    if (!data.staffName || !data.date || !data.time || !data.menu) {
      return res.status(400).json({ success: false, message: 'staffName / date / time / menu は必須です' });
    }

    try {
      db.prepare(`
        UPDATE reservations
        SET staff_name = @staff_name, menu = @menu, reservation_date = @reservation_date,
            reservation_time = @reservation_time, note = @note, editor = @editor, updated_at = CURRENT_TIMESTAMP
        WHERE id = @id AND store_id = @store_id
      `).run({
        id, store_id: storeId,
        staff_name: data.staffName, menu: data.menu,
        reservation_date: data.date, reservation_time: data.time,
        note: data.note || existing.note || '', editor: staffName
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

    let editMessage = '✅ 予約を変更しました';
    if (existing.customer_id) {
      editMessage += await notifyAndBuildResultText(storeId, existing.customer_id, {
        staffName: data.staffName, menu: data.menu, date: data.date, time: data.time
      }, 'change');
    }
    res.json({ success: true, message: editMessage });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/staff/reservations/:id : キャンセル（担当が自分か未定の予約のみ／オーナーは制限なし）
app.delete('/api/staff/reservations/:id', requireStaffSession, async (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const staffName = req.session.staff.name;
    const isOwner = !!req.session.staff.isOwner;
    const id = Number(req.params.id);

    const row = db.prepare('SELECT * FROM reservations WHERE id = ? AND store_id = ?').get(id, storeId);
    if (!row) {
      return res.status(404).json({ success: false, message: '対象の予約が見つかりません' });
    }
    if (!isOwner && row.staff_name !== staffName && row.staff_name !== '未定') {
      return res.status(403).json({ success: false, message: '他のスタッフの予約はキャンセルできません' });
    }

    db.prepare(`UPDATE reservations SET realname = 'キャンセル', editor = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(staffName, id);

    let cancelMessage = '✅ キャンセルしました';
    if (row.customer_id) {
      cancelMessage += await notifyAndBuildResultText(storeId, row.customer_id, {
        staffName: row.staff_name, menu: row.menu, date: row.reservation_date, time: row.reservation_time
      }, 'cancel');
    }
    res.json({ success: true, message: cancelMessage });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ★2026-09-22追加：GET /api/staff/customers/search?q=
//   スタッフ用の予約登録フォームから、既存の顧客を検索して選ぶための簡易検索API
//   （GAS版reservation_form_assets.htmlのopenCustomerModal()相当。GAS版はかな行
//   インデックス付きの全件ブラウズ方式だったが、Node版はより実用的な部分一致検索
//   （本名・フリガナ・電話番号）に簡略化した）。GAS版のcustomerModalにオーナー限定の
//   分岐は無く、ログイン中のスタッフなら誰でも顧客を検索・選択できたため、
//   requireStaffSessionのみで許可する。受付拒否（booking_blocked）中の顧客も
//   スタッフ側からの新規予約登録には支障が無いため除外しない（お客様向けフォームの
//   受付拒否ブロックとは別の話）
// ----------------------------------------------------------------------------
app.get('/api/staff/customers/search', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const q = (req.query.q || '').trim();
    if (!q) {
      return res.json({ customers: [] });
    }
    const like = `%${q}%`;
    const rows = db.prepare(`
      SELECT customer_id AS customerId, realname, kana, phone, line_name AS lineName, user_id AS userId
      FROM customers
      WHERE store_id = ? AND is_deleted = 0 AND (realname LIKE ? OR kana LIKE ? OR phone LIKE ?)
      ORDER BY realname ASC
      LIMIT 20
    `).all(storeId, like, like, like);
    res.json({ customers: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ★2026-09-22追加：GET /api/staff/customers/list
//   予約フォームの「お客様を選択」モーダル用に、店舗の在籍顧客を全件返す
//   （GAS版reservation_form_assets.htmlのopenCustomerModal()相当。GAS版は
//   かな行インデックス（あ/か/さ…の見出しボタン）付きの全件ブラウズ方式で、
//   検索ボックスではなくこのリストボックス形式が本来の作りだったため、社長の
//   指摘を受けて/api/staff/customers/search（部分一致検索）に加えてこちらを
//   新設し、フロント側の顧客選択UIをかな行インデックス方式に作り直した）。
//   件数が多くなった場合に備え上限500件（この規模のプロトタイプでは実用上
//   問題ない。将来件数が増えた場合はページング等の再検討が必要）
// ----------------------------------------------------------------------------
app.get('/api/staff/customers/list', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const rows = db.prepare(`
      SELECT customer_id AS customerId, realname, kana, phone
      FROM customers
      WHERE store_id = ? AND is_deleted = 0
      ORDER BY kana ASC, realname ASC
      LIMIT 500
    `).all(storeId);
    res.json({ customers: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/staff/customers : 顧客マスタへの新規登録（GAS版registerCustomer相当。
//   GAS版にオーナー限定の分岐はなく、一般スタッフにも開放されているためrequireStaffSessionのみで許可する）
app.post('/api/staff/customers', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const result = createCustomerManually(db, storeId, req.body || {});
    if (!result.success) {
      return res.status(result.status || 400).json({ success: false, message: result.message });
    }
    res.json({ success: true, customerId: result.customerId, merged: result.merged });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// ★2026-09-22追加：サロンダッシュボード（GAS版calendar_page.html / calendar_dashboard_functions.gs
//   の移植）。週・月表示のカレンダーグリッドで店舗全体の予約を担当者色分け表示し、
//   その場で予約の追加・編集・キャンセルや、臨時休業日／イベント（ブロック枠）の
//   確認ができる画面。2026-09-22の棚卸し（41章）で「完全に未着手」と判明した機能。
//
//   予約自体の追加・編集・キャンセルは本セッション既存の/api/staff/reservations
//   （29章で一般スタッフ開放済み）をそのまま利用する。ここで新規追加するのは、
//   ①週・月範囲の予約＋イベントをまとめて返す集計API、②スタッフごとの色割り当て、
//   ③一般スタッフでも閲覧できるイベント参照API（作成/変更/削除はオーナー専用のまま）。
//
//   GAS版との差異（README章44に詳細）：
//   ・GAS版は日曜始まり週、Node版は既存のスタッフダッシュボード月間カレンダー等と
//     合わせ月曜始まりに統一
//   ・スタッフの色はGAS版はマスタシートで手動割り当てだが、Node版はスタッフID順に
//     固定パレットから自動割り当てする簡略化（色を手動で選び直す機能は無い）
//   ・イベントの「バッファ時間帯」（前後の予約ブロック時間）は既存のgetBlockedEventSlots_
//     と同じ計算式をそのまま流用するが、斜線ハッチング等の視覚表現は簡略化
//   ・Googleカレンダー連携（GAS版のcalendarId書き込み・同期）は対象外（スタンディング除外）
// ============================================================================

// ★スタッフの表示色パレット（GAS版COLOR_MAP/BG_MAP/TX_MAPの簡略移植。
//   GAS版はマスタシートで手動割り当てだったが、Node版はstaff.id順に自動割り当てする）
const CALENDAR_COLOR_KEYS = ['BLUE', 'RED', 'GREEN', 'ORANGE', 'GRAPE', 'CYAN', 'YELLOW', 'BASIL', 'MAUVE', 'PALE_BLUE', 'PALE_RED', 'PALE_GREEN', 'GRAPHITE'];
const CALENDAR_COLOR_MAP = {
  YELLOW: '#EFB100', CYAN: '#00ACC1', ORANGE: '#E65100', GRAPE: '#7B1FA2', GREEN: '#2E7D32',
  BLUE: '#1565C0', RED: '#C62828', BASIL: '#33691E', GRAPHITE: '#616161',
  PALE_BLUE: '#64B5F6', PALE_GREEN: '#81C784', MAUVE: '#BA68C8', PALE_RED: '#E57373'
};
// ★2026-09-23：背景色・文字色をGAS版calendar_page.html 324-325行のBG_MAP/TX_MAPと
//   完全に同じ値に揃えた（以前は一部の色で値が少し異なっていた）
const CALENDAR_BG_MAP = {
  YELLOW: '#FFF8E1', CYAN: '#E0F7FA', ORANGE: '#FBE9E7', GRAPE: '#F3E5F5', GREEN: '#E8F5E9',
  BLUE: '#E3F2FD', RED: '#FFEBEE', BASIL: '#F1F8E9', GRAPHITE: '#F5F5F5',
  PALE_BLUE: '#EEF5FF', PALE_GREEN: '#F1F8E9', MAUVE: '#F8F0FF', PALE_RED: '#FFF0F0'
};
const CALENDAR_TX_MAP = {
  YELLOW: '#795B00', CYAN: '#005662', ORANGE: '#7B2800', GRAPE: '#4A0072', GREEN: '#1B5E20',
  BLUE: '#0D3780', RED: '#7F0000', BASIL: '#1B5E20', GRAPHITE: '#212121',
  PALE_BLUE: '#0D3780', PALE_GREEN: '#1B5E20', MAUVE: '#4A148C', PALE_RED: '#B71C1C'
};
// スタッフ管理画面の色選択肢に出す日本語名
const CALENDAR_COLOR_LABELS = {
  BLUE: '青', RED: '赤', GREEN: '緑', ORANGE: 'オレンジ', GRAPE: 'ぶどう', CYAN: '水色', YELLOW: '黄',
  BASIL: 'バジル', MAUVE: '藤色', PALE_BLUE: '薄い青', PALE_RED: '薄い赤', PALE_GREEN: '薄い緑', GRAPHITE: 'グレー'
};

// ★2026-09-23変更：GAS版（calendar_dashboard_functions.js 88-97行、マスタシートC列に
//   スタッフ毎の色名を保存しておき、それを読む方式）に合わせ、staff.color列に保存
//   された色を使うようにした。以前はstaff.id順に自動で割り当てていたため、スタッフの
//   追加・退職のたびに全員の色がずれてしまう問題があった。
//   ・在籍中スタッフの色（凡例に出す）…戻り値 colors
//   ・退職済みスタッフの色も含める（過去の予約が灰色にならないように）…GAS版も
//     マスタの全行を読んでいたのと同じ
//   ・色が空のスタッフ（マイグレーション前に作られた行など）には、まだ誰も使っていない
//     色を表示上だけ割り当てる（保存はしない。オーナーがスタッフ管理画面で選び直せる）
function getStaffColorRows_(storeId) {
  return db.prepare(`
    SELECT name, color, is_active FROM staff WHERE store_id = ? AND is_shared_terminal = 0 ORDER BY is_active DESC, id ASC
  `).all(storeId);
}
function assignStaffColors_(storeId, { includeInactive = true } = {}) {
  const rows = getStaffColorRows_(storeId);
  const used = new Set(rows.map((r) => r.color).filter(Boolean));
  const spare = CALENDAR_COLOR_KEYS.filter((k) => !used.has(k));
  let spareIdx = 0;
  const colors = {};
  rows.forEach((row) => {
    if (!includeInactive && !row.is_active) return;
    let key = CALENDAR_COLOR_MAP[row.color] ? row.color : '';
    if (!key) key = spare.length ? spare[spareIdx++ % spare.length] : 'GRAPHITE';
    colors[row.name] = key;
  });
  return colors;
}
// 凡例用：在籍中スタッフの名前だけ（表示順＝staff.id順）
function activeStaffNamesForLegend_(storeId) {
  return db.prepare(`
    SELECT name FROM staff WHERE store_id = ? AND is_active = 1 AND role != '見習い' AND is_shared_terminal = 0 ORDER BY id ASC
  `).all(storeId).map((r) => r.name);
}
// 新規スタッフ登録時の既定色：同じ店舗でまだ使われていない最初の色
function nextUnusedStaffColor_(storeId) {
  const used = new Set(db.prepare('SELECT color FROM staff WHERE store_id = ? AND is_active = 1 AND is_shared_terminal = 0').all(storeId).map((r) => r.color));
  return CALENDAR_COLOR_KEYS.find((k) => !used.has(k)) || CALENDAR_COLOR_KEYS[0];
}

// ★GAS版getCalendarData_相当：指定期間の予約＋イベントをまとめて返す
function getCalendarData_(storeId, fromDate, toDate) {
  const resvRows = db.prepare(`
    SELECT id, realname, staff_name, menu, reservation_date, reservation_time, status, customer_id
    FROM reservations
    WHERE store_id = ? AND realname != 'キャンセル' AND reservation_date >= ? AND reservation_date <= ?
    ORDER BY reservation_date ASC, reservation_time ASC
  `).all(storeId, fromDate, toDate);

  const reservations = resvRows.map((r) => {
    const endMin = engine.toMin_(r.reservation_time) + 90;
    const endH = String(Math.floor(endMin / 60)).padStart(2, '0');
    const endM = String(endMin % 60).padStart(2, '0');
    return {
      id: r.id,
      date: r.reservation_date,
      realname: r.realname,
      staffName: r.staff_name,
      menu: r.menu,
      startTime: r.reservation_time,
      endTime: `${endH}:${endM}`,
      isProvisional: r.status === '仮予約',
      customerId: r.customer_id || ''
    };
  });

  const eventRows = db.prepare(`
    SELECT id, title, event_date, start_time, end_time, restrict_booking, block_start_time, block_end_time
    FROM events
    WHERE store_id = ? AND is_active = 1 AND event_date >= ? AND event_date <= ?
    ORDER BY event_date ASC, start_time ASC
  `).all(storeId, fromDate, toDate);

  const events = eventRows.map((e) => {
    const restrict = !!e.restrict_booking;
    let blockStart = e.block_start_time || '';
    let blockEnd = e.block_end_time || '';
    if (restrict && e.start_time && e.end_time) {
      if (!blockStart) {
        const m = Math.max(0, engine.toMin_(e.start_time) - 90);
        blockStart = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      }
      if (!blockEnd) {
        const m = Math.min(1439, engine.toMin_(e.end_time) + 60);
        blockEnd = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      }
    }
    // ★2026-09-23追加：終日の行事かどうか（行事管理モーダルの「終日」チェックは
    //   00:00〜23:59として保存される。GAS版は開始・終了が空欄＝終日だった）
    const allDay = !e.start_time || !e.end_time || (e.start_time === '00:00' && e.end_time === '23:59');
    return {
      id: e.id, date: e.event_date, label: e.title,
      startTime: e.start_time, endTime: e.end_time, allDay,
      blockReservation: restrict, blockStart: allDay ? '' : blockStart, blockEnd: allDay ? '' : blockEnd
    };
  });

  return {
    reservations, events,
    staffColors: assignStaffColors_(storeId),
    legendStaff: activeStaffNamesForLegend_(storeId),
    colorMap: CALENDAR_COLOR_MAP, bgMap: CALENDAR_BG_MAP, txMap: CALENDAR_TX_MAP
  };
}

// GET /api/staff/calendar/week?start=YYYY-MM-DD : 指定週（月曜始まり、開始日から7日分）
app.get('/api/staff/calendar/week', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const start = String(req.query.start || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      return res.status(400).json({ success: false, message: 'start（YYYY-MM-DD）は必須です' });
    }
    const startDate = new Date(start + 'T00:00:00');
    const endDate = new Date(startDate); endDate.setDate(endDate.getDate() + 6);
    const pad2 = (n) => String(n).padStart(2, '0');
    const to = `${endDate.getFullYear()}-${pad2(endDate.getMonth() + 1)}-${pad2(endDate.getDate())}`;
    res.json({ success: true, data: getCalendarData_(storeId, start, to) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/staff/calendar/month?year=YYYY&month=MM : 指定月（1〜31日、前後月の端数日は含まない）
app.get('/api/staff/calendar/month', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const year = Number(req.query.year);
    const month = Number(req.query.month); // 1-12
    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ success: false, message: 'year・month は必須です' });
    }
    const pad2 = (n) => String(n).padStart(2, '0');
    const from = `${year}-${pad2(month)}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const to = `${year}-${pad2(month)}-${pad2(lastDay)}`;
    res.json({ success: true, data: getCalendarData_(storeId, from, to) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/staff/calendar/events?date=YYYY-MM-DD : 指定日のイベント一覧（閲覧のみ、一般スタッフも可。
//   作成/変更/削除はGAS版と同じくオーナー専用のため既存/api/admin/eventsを使う）
app.get('/api/staff/calendar/events', requireStaffSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, message: 'date（YYYY-MM-DD）は必須です' });
    }
    const rows = db.prepare(`
      SELECT id, title, event_date, start_time, end_time, restrict_booking, block_start_time, block_end_time
      FROM events WHERE store_id = ? AND event_date = ? AND is_active = 1
      ORDER BY start_time ASC
    `).all(storeId, date);
    res.json({
      success: true,
      events: rows.map((e) => ({
        id: e.id, date: e.event_date, label: e.title, startTime: e.start_time, endTime: e.end_time,
        restrictBooking: !!e.restrict_booking, blockStartTime: e.block_start_time || '', blockEndTime: e.block_end_time || ''
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/admin/events/:id : イベントの変更（GAS版updateCalendarEvent相当。オーナー専用。
//   これまで/api/admin/eventsはGET（一覧）・POST（新規）・DELETE（削除）のみでPUTが無かったため追加）
app.put('/api/admin/events/:id', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const id = Number(req.params.id);
    const data = req.body || {};
    const existing = db.prepare('SELECT * FROM events WHERE id = ? AND store_id = ?').get(id, storeId);
    if (!existing) {
      return res.status(404).json({ success: false, message: '対象のイベントが見つかりません' });
    }
    if (!data.title || !data.date || !data.startTime || !data.endTime) {
      return res.status(400).json({ success: false, message: 'title / date / startTime / endTime は必須です' });
    }
    if (data.startTime >= data.endTime) {
      return res.status(400).json({ success: false, message: '終了時刻は開始時刻より後にしてください' });
    }
    db.prepare(`
      UPDATE events SET title = ?, event_date = ?, start_time = ?, end_time = ?,
        restrict_booking = ?, block_start_time = ?, block_end_time = ?
      WHERE id = ?
    `).run(
      data.title, data.date, data.startTime, data.endTime,
      data.restrictBooking ? 1 : 0,
      data.restrictBooking ? (data.blockStartTime || null) : null,
      data.restrictBooking ? (data.blockEndTime || null) : null,
      id
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

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
app.delete('/api/admin/reservations/:id', requireOwnerSession, async (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const id = Number(req.params.id);

    // ★店舗スコープ確認：他店の予約IDを推測して叩かれても操作できないようにする
    const row = db.prepare('SELECT * FROM reservations WHERE id = ? AND store_id = ?').get(id, storeId);
    if (!row) {
      return res.status(404).json({ success: false, message: '対象の予約が見つかりません（他店舗のデータは操作できません）' });
    }

    db.prepare(`UPDATE reservations SET realname = 'キャンセル', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);

    let cancelMessage = '';
    if (row.customer_id) {
      cancelMessage = await notifyAndBuildResultText(storeId, row.customer_id, {
        staffName: row.staff_name, menu: row.menu, date: row.reservation_date, time: row.reservation_time
      }, 'cancel');
    }
    res.json({ success: true, message: cancelMessage || undefined });
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
app.put('/api/admin/reservations/:id', requireOwnerSession, async (req, res) => {
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

    let adminEditMessage = '✅ 予約を変更しました';
    if (existing.customer_id) {
      adminEditMessage += await notifyAndBuildResultText(storeId, existing.customer_id, {
        staffName: data.staffName, menu: data.menu, date: data.date, time: data.time
      }, 'change');
    }
    res.json({ success: true, message: adminEditMessage });
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
app.post('/api/admin/reservations', requireOwnerSession, async (req, res) => {
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

    // ★2026-09-20追加：「仮予約として登録」チェック（GAS版dashboard_functions.gsの
    //   仮予約フロー相当）。trueの場合はstatus='仮予約'で登録し、後で担当スタッフが
    //   確定操作（POST /api/admin/reservations/:id/confirm）を行うまで確定しない。
    const status = data.provisional ? '仮予約' : '確定';

    const insert = db.prepare(`
      INSERT INTO reservations
        (store_id, realname, kana, line_name, user_id, staff_name, menu, reservation_date, reservation_time, note, editor, line_sent, done, customer_id, status)
      VALUES
        (@store_id, @realname, @kana, '', '', @staff_name, @menu, @reservation_date, @reservation_time, @note, @editor, 0, 0, @customer_id, @status)
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
        customer_id: data.customerId || '',
        status
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

    let adminNewMessage = status === '仮予約' ? '✅ 仮予約として登録しました（確定操作が必要です）' : '✅ 予約を登録しました';
    if (status === '確定') {
      // ★2026-09-23追加修正：line_sentが常に0固定のまま更新されていなかった不具合を修正
      //   （INSERT時の共通の穴。public予約・スタッフ予約と同じ修正）
      const notifyResult = await notifyAndGetResult(storeId, data.customerId, {
        staffName: data.staffName, menu: data.menu, date: data.date, time: data.time
      }, 'confirm_add');
      adminNewMessage += notifyResult.text;
      markReservationLineSent(info.lastInsertRowid, notifyResult.sent);
    }

    res.json({
      success: true,
      message: adminNewMessage,
      reservationId: info.lastInsertRowid
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ★2026-09-20追加：仮予約の確定操作（GAS版dashboard_functions.gsのconfirmReservation
//   相当）。担当スタッフが「未定」のままでは確定できない（GAS版と同じ安全策）。
//   確定に伴い、顧客がLINE連携済みであればconfirm_finalizeテンプレートで通知を送る
//   （LINE通知はあくまで付加機能。失敗しても確定操作自体は成功として扱う）。
//
//   ★2026-09-23追加修正：GAS版confirmReservationStatus_body_（reservation_form_functions.js
//   325-401行）は、確定操作の結果メッセージに「📱 お客様にLINE通知しました／
//   ⚠️ お客様へのLINE通知に失敗しました／ℹ️ LINE IDが未登録のため通知できませんでした」
//   という通知結果を必ず含めて返す（'✅ 予約を確定しました\n' + customerResult）。
//   Node版はこれまで確定操作自体をawaitせずfire-and-forgetにしていたため、確定した
//   スタッフ・オーナーには通知が実際に届いたかどうかが一切分からない状態だった（社長の
//   ご指摘「スタッフやオーナーにも仮予約や本予約の通知システムがあるはず、テストして
//   完成させて」で発覚した未移植箇所）。既存の他5経路（新規登録・編集・キャンセル）で
//   確立済みのnotifyAndGetResultパターンに合わせ、通知完了を待ってから結果を返す形に
//   修正し、あわせてreservations.line_sent（オーナーの閲覧専用画面の📨アイコン用）も
//   実際の送信結果で更新する。「仮予約」のまま作られた予約は作成時点ではLINE通知を
//   送っていない（二重通知を避けるため）ため、line_sentが初めて意味を持つのはこの
//   確定操作のタイミングになる。
// ----------------------------------------------------------------------------
// ★2026-09-23追加：確定処理の本体をオーナー版・スタッフ版で共通化した。
//   GAS版confirmReservationStatus_body_（reservation_form_functions.js 333-358行）と同じく、
//   画面上で選び直した担当スタッフ（selectedStaffName）がまだ保存されていなければ、
//   確定と同時にその担当へ変更する（サロンダッシュボードの編集画面で「担当を選んで
//   → 仮予約中のチェックを外す」操作を、保存ボタンを押さずに1回で済ませられる）。
async function confirmProvisionalReservation_(req, res) {
  try {
    const storeId = req.session.staff.storeId;
    const id = Number(req.params.id);
    let row = db.prepare('SELECT * FROM reservations WHERE id = ? AND store_id = ?').get(id, storeId);
    if (!row) {
      return res.status(404).json({ success: false, message: '対象の予約が見つかりません' });
    }
    if (row.realname === 'キャンセル') {
      return res.status(400).json({ success: false, message: 'この予約はキャンセル済みです' });
    }
    if (row.status !== '仮予約') {
      return res.status(400).json({ success: false, message: 'この予約はすでに確定済みです' });
    }
    const selectedStaff = String((req.body && req.body.staffName) || '').trim();
    if (selectedStaff && selectedStaff !== '未定' && selectedStaff !== row.staff_name) {
      try {
        db.prepare('UPDATE reservations SET staff_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(selectedStaff, id);
      } catch (constraintErr) {
        if (String(constraintErr.message).includes('UNIQUE constraint failed')) {
          return res.status(409).json({ success: false, isDoubleBooking: true, message: `${selectedStaff}さんはその日時に別の予約が入っているため、担当にできません` });
        }
        throw constraintErr;
      }
      row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
    }
    if (!row.staff_name || row.staff_name === '未定') {
      return res.status(400).json({ success: false, message: '❌ 担当スタッフが未定のため確定できません。先に担当を設定してください' });
    }

    db.prepare(`UPDATE reservations SET status = '確定', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);

    let confirmMessage = '✅ 予約を確定しました';
    if (row.customer_id) {
      const notifyResult = await notifyAndGetResult(storeId, row.customer_id, {
        staffName: row.staff_name, menu: row.menu, date: row.reservation_date, time: row.reservation_time
      }, 'confirm_finalize');
      confirmMessage += notifyResult.text;
      markReservationLineSent(id, notifyResult.sent);
    }

    res.json({ success: true, message: confirmMessage, staffName: row.staff_name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
}

app.post('/api/admin/reservations/:id/confirm', requireOwnerSession, confirmProvisionalReservation_);

// ----------------------------------------------------------------------------
// ★2026-09-22追加：スタッフダッシュボードからの仮予約確定（GAS版staff_dashboard.html
//   の confirmReservation 相当）。GAS版はconfirmReservation_body_にオーナー限定の
//   分岐が一切なく、ログイン中のスタッフなら誰でも確定操作ができる仕様だったため、
//   上のオーナー専用エンドポイントとは別に、一般スタッフでも呼べるエンドポイントを
//   新設した（requireStaffSessionのみ、isOwnerチェック無し）。バリデーション内容は
//   オーナー版と完全に同一（仮予約以外は400、担当が未定のままなら400）。
// ----------------------------------------------------------------------------
app.post('/api/staff/reservations/:id/confirm', requireStaffSession, confirmProvisionalReservation_);

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
    // ★2026-09-23修正：GAS版getAdminStaffList（admin_ui_functions.js）はスタッフマスタ
    //   シートを上から順に読むだけでソートをかけておらず、一覧はマスタの行登録順
    //   （＝スタッフを追加した順）のまま表示される仕様だった。Node版がis_active DESC,
    //   name ASCで並べ替えていたため、GAS版で見慣れた並び順と一致しない「表示順」の
    //   差異が生じていた。マスタの登録順に一致させるため、並び順の指定をid ASC
    //   （＝登録順）に統一する（在籍中／退職済みでのグループ分けも行わない）。
    const rows = db.prepare(`
      SELECT id, name, nickname, role, opt_support, night_restrict, show_in_booking, is_active, is_owner, is_shared_terminal, color,
             (pin_hash IS NOT NULL) AS has_pin
      FROM staff WHERE store_id = ? ORDER BY id ASC
    `).all(storeId);
    // ★2026-09-23追加：スタッフ管理画面の色選択（GAS版マスタC列の色名）用に、
    //   選べる色の一覧と、実際にカレンダーに表示される色（未設定なら仮の色）も返す
    const effective = assignStaffColors_(storeId);
    rows.forEach((r) => { r.effective_color = effective[r.name] || ''; });
    res.json({
      staff: rows,
      colorOptions: CALENDAR_COLOR_KEYS.map((key) => ({
        key, label: CALENDAR_COLOR_LABELS[key], border: CALENDAR_COLOR_MAP[key], bg: CALENDAR_BG_MAP[key], tx: CALENDAR_TX_MAP[key]
      }))
    });
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

    if (data.color && !CALENDAR_COLOR_MAP[data.color]) {
      return res.status(400).json({ success: false, message: '表示色の指定が正しくありません' });
    }
    // ★色の指定が無ければ、同じ店舗でまだ誰も使っていない色を既定で割り当てる
    const color = data.color || nextUnusedStaffColor_(storeId);

    // ★2026-09-24追加：サロン端末（共有ログイン、GAS版ST099相当）として登録する場合は、
    //   GAS版と同じくisOwner扱い（is_owner=1）にし、予約対象スタッフには出さない
    //   （show_in_booking=0）。表示色も割り当てない（カレンダーの担当者色に使わないため）
    const isTerminal = !!data.isSharedTerminal;
    const { hash, salt } = createPinHash(data.pin);
    const info = db.prepare(`
      INSERT INTO staff (store_id, name, nickname, role, opt_support, night_restrict, show_in_booking, is_active, pin_hash, pin_salt, is_owner, color, is_shared_terminal)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      storeId, data.name.trim(), data.nickname || '', data.role || (isTerminal ? 'サロン端末' : 'スタッフ'),
      isTerminal ? 0 : (data.optSupport ? 1 : 0), isTerminal ? 0 : (data.nightRestrict ? 1 : 0),
      isTerminal ? 0 : (data.showInBooking === false ? 0 : 1),
      hash, salt, (data.isOwner || isTerminal) ? 1 : 0, isTerminal ? null : color, isTerminal ? 1 : 0
    );
    res.json({ success: true, staffId: info.lastInsertRowid, color });
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
    // ★2026-09-24追加：サロン端末フラグ。項目を送らない既存の呼び出し元（テスト等）では
    //   現在の値を保持する。端末ならPOSTと同じくis_owner=1・予約対象外に揃える。
    //   ログイン中の本人の端末フラグは切り替えられない（オーナーが自分を端末化して
    //   オーナー設定・スタッフ管理に入れなくなる事故を防ぐ）
    const isTerminal = Object.prototype.hasOwnProperty.call(data, 'isSharedTerminal')
      ? !!data.isSharedTerminal : !!existing.is_shared_terminal;
    if (id === req.session.staff.id && isTerminal !== !!existing.is_shared_terminal) {
      return res.status(400).json({ success: false, message: 'ログイン中の自分自身のサロン端末設定は変更できません' });
    }
    params.is_shared_terminal = isTerminal ? 1 : 0;
    if (isTerminal) {
      params.is_owner = 1;
      params.show_in_booking = 0;
    }
    if (data.pin) {
      if (!/^\d{4}$/.test(String(data.pin))) {
        return res.status(400).json({ success: false, message: 'PINは4桁の数字で指定してください' });
      }
      const { hash, salt } = createPinHash(data.pin);
      pinClause = ', pin_hash = @pin_hash, pin_salt = @pin_salt';
      params.pin_hash = hash;
      params.pin_salt = salt;
    }
    // ★2026-09-23追加：表示色（GAS版マスタC列相当）。指定が無い場合は現在の色を保持する
    //   （既存の呼び出し元＝色の項目を送らない画面・テストを壊さないため）
    let colorClause = '';
    if (Object.prototype.hasOwnProperty.call(data, 'color')) {
      if (data.color && !CALENDAR_COLOR_MAP[data.color]) {
        return res.status(400).json({ success: false, message: '表示色の指定が正しくありません' });
      }
      colorClause = ', color = @color';
      params.color = data.color || null;
    }

    db.prepare(`
      UPDATE staff
      SET name = @name, nickname = @nickname, role = @role,
          opt_support = @opt_support, night_restrict = @night_restrict, show_in_booking = @show_in_booking,
          is_active = @is_active, is_owner = @is_owner, is_shared_terminal = @is_shared_terminal
          ${pinClause}${colorClause}
      WHERE id = @id AND store_id = @store_id
    `).run(params);

    // ★2026-09-23追加：氏名変更時、旧名義の「シフト初期値」（shift_templates）を
    //   削除する（GAS版saveStaffMemberのdeleteShiftInitialRowsByName_相当）。
    //   これをしないと、旧名義のテンプレートが残ったまま日次展開が続き、新しい
    //   氏名の方にはシフトが一切展開されなくなる（過去のシフトマスタ／予約履歴は
    //   GAS版と同様、あえて書き換えない＝旧名義のまま残す）。
    let renamedTemplatesRemoved = 0;
    const oldName = existing.name;
    const newName = params.name;
    if (oldName && newName && oldName !== newName) {
      const delResult = db.prepare(`
        DELETE FROM shift_templates WHERE store_id = ? AND staff_name = ?
      `).run(storeId, oldName);
      renamedTemplatesRemoved = delResult.changes;
    }

    res.json({ success: true, renamedTemplatesRemoved });
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
const { normalizePhoneDigits, findMergeCandidates, mergeCustomerRecords, createCustomerManually, registerCustomerFromPublicForm } = require('./lib/customerMerge');

// ----------------------------------------------------------------------------
// ★2026-09-22追加：顧客マスタへの新規登録（GAS版reservation_form_functions.gs
//   registerCustomer相当）。お客様予約フォームを介さず、電話予約や来店受付の際に
//   スタッフが顧客マスタへ直接1件登録できるようにする。GAS版と同じく、①本名の
//   重複チェック（拒否）②LINE USER IDが既存の仮登録行と一致する場合はその行へ
//   統合③「キープメンバーとして登録する」チェックで来店回数の初期値を1にする、
//   という挙動をlib/customerMerge.jsのcreateCustomerManuallyに実装している。
//
// POST /api/admin/customers  { realname, kana, lineName, userId, isKeepMember }
// ----------------------------------------------------------------------------
app.post('/api/admin/customers', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const result = createCustomerManually(db, storeId, req.body || {});
    if (!result.success) {
      return res.status(result.status || 400).json({ success: false, message: result.message });
    }
    res.json({ success: true, customerId: result.customerId, merged: result.merged });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

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

// ----------------------------------------------------------------------------
// ★2026-09-23追加：POST /api/admin/customers/:customerId/toggle-keep-member
//   GAS版 owner_ui.html の顧客一覧トグルスイッチ（toggleCustomerKeepMember /
//   toggleCustomerKeepMember_body_、対象列を1回のsetValueで書き換えるだけの軽量な
//   1クリック操作）の移植。既存の編集モーダル（#cm-keep チェックボックス→
//   PUT /api/admin/customers/:customerId、顧客レコード全体を送信）とは別の、
//   一覧行から直接ON/OFFできる専用エンドポイント。あえて既存のPUTを使い回さず
//   新設したのは、一覧行はフロント側に対象顧客の全フィールドを保持していない
//   （軽量化のため一覧APIは主要列のみ返している）ため、PUTを流用すると
//   他のフィールドを空値で上書きしてしまう事故につながるため。
//   is_keep_memberの1列だけを書き換える。
// ----------------------------------------------------------------------------
app.post('/api/admin/customers/:customerId/toggle-keep-member', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const existing = findCustomerByCid_(storeId, req.params.customerId);
    if (!existing) {
      return res.status(404).json({ success: false, message: '対象の顧客が見つかりません（他店舗のデータは操作できません）' });
    }
    const newValue = existing.is_keep_member ? 0 : 1;
    db.prepare(`
      UPDATE customers SET is_keep_member = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE store_id = ? AND customer_id = ?
    `).run(newValue, req.session.staff.name, storeId, existing.customer_id);
    res.json({ success: true, isKeepMember: !!newValue });
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
      'SELECT 1 FROM staff WHERE store_id = ? AND name = ? AND is_active = 1 AND is_shared_terminal = 0'
    ).get(storeId, staffName);
    if (!staffExists) {
      return res.status(400).json({ success: false, message: '在籍中のスタッフとして見つかりません' });
    }
    // ★2026-09-23追加：完全に同一内容（スタッフ・日付・開始・終了）のシフトが
    //   既に存在する場合は重複登録を拒否する（README §50-2の⑤で報告した不具合の修正）
    const dupe = db.prepare(`
      SELECT id FROM shift_master WHERE store_id = ? AND staff_name = ? AND shift_date = ? AND start_time = ? AND end_time = ?
    `).get(storeId, staffName, date, startTime, endTime);
    if (dupe) {
      return res.status(400).json({ success: false, message: '同じ内容のシフトが既に登録されています' });
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

// ----------------------------------------------------------------------------
// ★2026-09-22追加：シフト初期値（曜日パターン）のCRUD
//   GAS版の「シフト初期値」シート相当。ここに登録した「スタッフ×曜日×時刻」を
//   もとに、日次メンテナンスがSHIFT_EXPAND_DAYS日先の1日分をshift_masterへ
//   自動展開する（GAS版expandShiftByRule_の移植、下のmaintenance/run-dailyを参照）。
//
// GET    /api/admin/settings/shift-templates
// POST   /api/admin/settings/shift-templates    { staffName, dayOfWeek, startTime, endTime }
// PUT    /api/admin/settings/shift-templates/:id { isActive } … 一時停止/再開の切替
// DELETE /api/admin/settings/shift-templates/:id
// ----------------------------------------------------------------------------
app.get('/api/admin/settings/shift-templates', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const rows = db.prepare(
      'SELECT * FROM shift_templates WHERE store_id = ? ORDER BY day_of_week ASC, staff_name ASC'
    ).all(storeId);
    res.json({ templates: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/settings/shift-templates', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const { staffName, dayOfWeek, startTime, endTime } = req.body || {};
    const dow = Number(dayOfWeek);
    // ★2026-09-23追加：7は「祝」（休業日）パターンを表す特別値（GAS版SHIFT_DAY_ORDERの
    //   '祝'相当）。通常の曜日（0〜6）より優先され、events側で休業日に指定された日に
    //   このパターンが割り当てられていればそちらが使われる（無ければその日は出勤なし）
    if (!staffName || Number.isNaN(dow) || dow < 0 || dow > 7 || !startTime || !endTime) {
      return res.status(400).json({ success: false, message: 'staffName / dayOfWeek(0〜6、7=祝) / startTime / endTime は必須です' });
    }
    if (startTime >= endTime) {
      return res.status(400).json({ success: false, message: '終了時間は開始時間より後にしてください' });
    }
    const staffExists = db.prepare(
      'SELECT 1 FROM staff WHERE store_id = ? AND name = ? AND is_active = 1 AND is_shared_terminal = 0'
    ).get(storeId, staffName);
    if (!staffExists) {
      return res.status(400).json({ success: false, message: '在籍中のスタッフとして見つかりません' });
    }
    const info = db.prepare(`
      INSERT INTO shift_templates (store_id, staff_name, day_of_week, start_time, end_time, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(storeId, staffName, dow, startTime, endTime);
    res.json({ success: true, templateId: info.lastInsertRowid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.put('/api/admin/settings/shift-templates/:id', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const id = Number(req.params.id);
    const row = db.prepare('SELECT id FROM shift_templates WHERE id = ? AND store_id = ?').get(id, storeId);
    if (!row) {
      return res.status(404).json({ success: false, message: '対象のシフト初期値が見つかりません' });
    }
    const isActive = req.body && typeof req.body.isActive !== 'undefined' ? (req.body.isActive ? 1 : 0) : 1;
    db.prepare('UPDATE shift_templates SET is_active = ? WHERE id = ?').run(isActive, id);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/admin/settings/shift-templates/:id', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const id = Number(req.params.id);
    const row = db.prepare('SELECT id FROM shift_templates WHERE id = ? AND store_id = ?').get(id, storeId);
    if (!row) {
      return res.status(404).json({ success: false, message: '対象のシフト初期値が見つかりません' });
    }
    db.prepare('DELETE FROM shift_templates WHERE id = ?').run(id);
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
    // ★2026-09-24追加：初期メニュー（is_initial=1）の名称・カテゴリを編集できるかどうか
    //   （管理者ログイン時のみtrue）。画面側はこれを見て2項目をロックする
    res.json({ items, categories: MENU_CATEGORIES, targets: MENU_TARGETS, canEditInitialNameCategory: !!req.session.staff.isAdmin });
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
    // ★2026-09-24追加：GAS版owner_ui.htmlと同じ権限分岐。初期メニュー（is_initial=1）の
    //   名称・カテゴリは管理者ログイン時のみ変更でき、オーナーは所要時間・料金・対象・
    //   有効/無効だけ変更できる。オーナー自身が追加したメニュー（is_initial=0）は全項目可。
    //   画面は現在の値をそのまま送ってくるので、「値が変わる場合だけ」拒否する。
    if (existing.is_initial && !req.session.staff.isAdmin &&
        (data.name.trim() !== existing.name || data.category !== existing.category)) {
      return res.status(403).json({ success: false, message: '初期メニューの名称・カテゴリは管理者のみ変更できます（所要時間・料金・対象・有効/無効は変更できます）' });
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

// ============================================================================
// ★2026-09-20追加：メッセージ設定（GAS版owner_ui.htmlの「メッセージ設定」パネル・
//   admin_ui_functions.gsのgetMessageSettings/saveMessageSettingsに相当）。
//   LINE通知テンプレート（本文＋締めの文）の管理。実装は lib/messageTemplates.js。
// ============================================================================

// ----------------------------------------------------------------------------
// GET /api/admin/settings/messages
// ----------------------------------------------------------------------------
app.get('/api/admin/settings/messages', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const store = db.prepare('SELECT plan FROM stores WHERE id = ?').get(storeId);
    const settings = getMessageSettings(db, storeId);
    // ★GAS版のLINE_NOTIFY_OPTION_CONTRACTに相当。このプロトタイプでは⑤課金基盤の
    //   プラン('line'系)がLINE通知機能を持つかどうかで代用する（lib/plans.js参照）。
    settings.lineOptionContract = hasFeature(store ? store.plan : 'trial', 'lineNotify');
    res.json(settings);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// PUT /api/admin/settings/messages
//   { items: [{ key, body, closing }, ...] }
// ----------------------------------------------------------------------------
app.put('/api/admin/settings/messages', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const items = (req.body && req.body.items) || [];
    const result = saveMessageSettings(db, storeId, items);
    res.json(result);
  } catch (e) {
    // ★バリデーションエラー（本文未入力・文字数超過等）はメッセージをそのまま返す
    res.status(400).json({ success: false, message: e.message });
  }
});

// ============================================================================
// ★2026-09-20追加：受付ルール・注意書き（GAS版owner_ui.html「受付ルール・注意書き」
//   パネル・admin_ui_functions.gsのgetRule2Settings/saveRule2Info/saveRule2Noticeに相当）。
//   カード①基本情報（電話番号は閲覧のみ・予約受付期間は編集可）＋カード②お客様向け注意書き
//   （対象別・有効/無効切替）を実装。GAS版カード③（管理者専用の生データ編集欄）と
//   「定型文（オーナーは文言編集不可）」の区別は、対応する管理者ロールの仕組みが
//   Node版にまだ無いため今回は対象外とした（README_PROTOTYPE.md参照）。
// ============================================================================

const BOOKING_NOTICE_TARGETS = ['全員', '初回', 'リピーター'];

// ----------------------------------------------------------------------------
// GET /api/admin/settings/rule2
// ----------------------------------------------------------------------------
app.get('/api/admin/settings/rule2', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const store = db.prepare('SELECT phone, booking_period_info_days FROM stores WHERE id = ?').get(storeId);
    const notices = db.prepare('SELECT * FROM booking_notices WHERE store_id = ? ORDER BY id ASC').all(storeId);
    res.json({
      info: { phone: store ? store.phone : '', bookingPeriodInfoDays: store ? store.booking_period_info_days : 14 },
      notices
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------------------
// PUT /api/admin/settings/rule2/info
//   { bookingPeriodInfoDays }（電話番号はこの画面からは編集不可＝GAS版のRULE2_INFO_EDITABLEに準拠）
// ----------------------------------------------------------------------------
app.put('/api/admin/settings/rule2/info', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const days = Number((req.body || {}).bookingPeriodInfoDays);
    if (isNaN(days) || days < 0 || days > 30) {
      return res.status(400).json({ success: false, message: '予約受付期間は0〜30の範囲で入力してください' });
    }
    db.prepare('UPDATE stores SET booking_period_info_days = ? WHERE id = ?').run(days, storeId);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/admin/settings/rule2/notices
//   { target, text } 新規追加（削除はGAS版同様この画面では扱わない）
// ----------------------------------------------------------------------------
app.post('/api/admin/settings/rule2/notices', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const data = req.body || {};
    if (BOOKING_NOTICE_TARGETS.indexOf(data.target) === -1) {
      return res.status(400).json({ success: false, message: '対象の指定が不正です' });
    }
    if (!data.text || !String(data.text).trim()) {
      return res.status(400).json({ success: false, message: '文言を入力してください' });
    }
    const info = db.prepare(`
      INSERT INTO booking_notices (store_id, target, text, is_active) VALUES (?, ?, ?, 1)
    `).run(storeId, data.target, String(data.text).trim());
    res.json({ success: true, noticeId: info.lastInsertRowid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// PUT /api/admin/settings/rule2/notices/:id
//   { target, text, active }
// ----------------------------------------------------------------------------
app.put('/api/admin/settings/rule2/notices/:id', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const id = Number(req.params.id);
    const data = req.body || {};
    const existing = db.prepare('SELECT id FROM booking_notices WHERE id = ? AND store_id = ?').get(id, storeId);
    if (!existing) {
      return res.status(404).json({ success: false, message: '対象の注意書きが見つかりません' });
    }
    if (BOOKING_NOTICE_TARGETS.indexOf(data.target) === -1) {
      return res.status(400).json({ success: false, message: '対象の指定が不正です' });
    }
    if (!data.text || !String(data.text).trim()) {
      return res.status(400).json({ success: false, message: '文言を入力してください' });
    }
    db.prepare(`
      UPDATE booking_notices SET target = ?, text = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(data.target, String(data.text).trim(), data.active === false ? 0 : 1, id);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ★2026-09-21追加：GET/PUT /api/admin/settings/line
//   LINE公式アカウント接続設定（店舗ごとのチャネルアクセストークン／チャネル
//   シークレット）を管理画面から入力できるようにする画面。これまでは
//   stores.line_customer_channel_token / line_staff_channel_secret を直接DBに
//   書き込む以外に設定する手段が無かった（v28実装時点の既知の制約）ため追加した。
//
//   ・チャネルアクセストークン（stores.line_customer_channel_token）：
//     お客様向けLINE公式アカウントのMessaging APIチャネルアクセストークン。
//     友だち追加時のあいさつ返信・スタンプ/キーワード返信等の送信に使用する
//     （lib/lineClient.js の replyMessage / getLineDisplayName）。
//   ・チャネルシークレット（stores.line_staff_channel_secret）：
//     Webhookの署名検証に使う値。実際の署名検証自体は環境変数
//     LINE_CHANNEL_SECRET（Renderの環境変数設定）を使う一本構成のままだが、
//     ここに同じ値を保存しておくことで、複数店舗展開時に
//     resolveStoreIdForWebhook_相当の店舗判別ロジックが機能するようになる
//     （現状は1チャネル運用のため、まずは値を保持できるようにするだけの位置づけ）。
//
//   セキュリティ上、GET時は値をそのまま返さず「設定済みかどうか」と末尾4文字の
//   ヒントのみを返す（画面上に平文のトークンを表示し続けない）。PUT時は空文字
//   なら「変更しない」として扱う。
// ----------------------------------------------------------------------------
function maskSecretHint(value) {
  if (!value) return null;
  const tail = String(value).slice(-4);
  return `••••••••${tail}`;
}

app.get('/api/admin/settings/line', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const store = db.prepare(
      'SELECT line_customer_channel_token, line_staff_channel_secret FROM stores WHERE id = ?'
    ).get(storeId);
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    res.json({
      customerChannelTokenSet: !!(store && store.line_customer_channel_token),
      customerChannelTokenHint: maskSecretHint(store && store.line_customer_channel_token),
      // ★2026-09-21追加：DB側が未設定でも環境変数LINE_CUSTOMER_CHANNEL_TOKENの
      //   フォールバックが効いているかを画面上で分かるようにする（安全策の可視化）
      customerChannelTokenEnvFallbackSet: !!process.env.LINE_CUSTOMER_CHANNEL_TOKEN,
      staffChannelSecretSet: !!(store && store.line_staff_channel_secret),
      staffChannelSecretHint: maskSecretHint(store && store.line_staff_channel_secret),
      webhookUrl: base ? `${base}/webhook/line` : null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/settings/line', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const data = req.body || {};
    const setClauses = [];
    const params = {};
    if (typeof data.customerChannelToken === 'string' && data.customerChannelToken.trim()) {
      setClauses.push('line_customer_channel_token = @customerChannelToken');
      params.customerChannelToken = data.customerChannelToken.trim();
    }
    if (typeof data.staffChannelSecret === 'string' && data.staffChannelSecret.trim()) {
      setClauses.push('line_staff_channel_secret = @staffChannelSecret');
      params.staffChannelSecret = data.staffChannelSecret.trim();
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, message: '入力欄が空です（変更したい項目だけ入力してください）' });
    }
    params.storeId = storeId;
    db.prepare(`UPDATE stores SET ${setClauses.join(', ')} WHERE id = @storeId`).run(params);
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
// ★2026-09-20追加：日次メンテナンス処理（GAS版コード.gs dailyProcessAll_の一部移植）
//
//   GAS版は時間主導トリガーで毎日自動実行され、①実行済み（施術完了）フラグの
//   自動更新②来店回数の再集計③古いキャンセル予約の削除④シフト自動展開などを
//   一括で行っていた。このプロトタイプはRenderの無料枠で動いており、Node側に
//   まだ常駐のスケジューラ（node-cron等）を用意していないため、GAS版と全く同じ
//   「毎日決まった時刻に自動実行」は今回は対象外とし、効果が分かりやすく単独で
//   意味のあるステップを、オーナー管理画面から手動実行できるボタンとして
//   再現した（本番運用では別途スケジューラの整備が必要。README明記）。
//
//   【③古いキャンセル予約の削除】GAS版deleteCancelledReservations相当
//   （2026-09-22追加）。キャンセル済み（realname='キャンセル'）かつ予約日が
//   CANCEL_DELETE_DAYS（店舗設定「基本ルール」、デフォルト60日）より前の予約を
//   物理削除する。GAS版はシート容量の圧迫を避けるための処理だったが、Node/SQLite
//   では容量制約は薄いものの、GAS版と同じ運用感（古いキャンセルはいずれ消える）を
//   保つため同じ挙動で移植した。GAS版は予約シートとarchiveシート（月次アーカイブ後
//   のシート）の両方が対象だったが、Node版にはarchiveの仕組み自体が無い（未移植）
//   ため、reservationsテーブルのみを対象にしている。
//
//   【④シフトの自動展開・⑤古いシフトの削除】GAS版dailyProcessShiftMaster
//   （expandShiftByRule_・deleteOldShifts_）相当（2026-09-22追加）。店舗設定
//   「シフト初期値」に登録した曜日パターン（スタッフ×曜日×時刻）から、
//   SHIFT_EXPAND_DAYS（デフォルト49日、GAS版と同じ既定値）日先の1日分を
//   shift_masterへ自動展開し、7日より前の古いshift_master行を削除する。
//   GAS版にあったremoveDuplicateShifts_（重複行の有効フラグ再計算）は、GAS版が
//   「行を追記していく」設計のために必要だった仕組みで、Node版はシフトの追加・
//   削除がそもそも直接CRUD（POST/DELETE /api/admin/shifts）のため重複が蓄積
//   しない設計になっており、移植の必要が無い（README明記）。
//
//   【①実行済み（施術完了）フラグの自動更新】GAS版updateExecutedFlags_相当。
//   予約日が「今日」より前で、まだ完了扱いになっていない（done=0）有効な予約
//   （キャンセルを除く）を、自動的に完了（done=1）として扱う。GAS版同様、
//   スタッフが個別にチェックを付ける運用ではなく、日付が過ぎたら自動で
//   完了扱いになる設計（施術当日に何もしなくても翌日には反映される）。
//
//   【②来店回数の再集計】GAS版updateVisitCounts_相当。完了（done=1・
//   キャンセル除く）予約を顧客ごとに数え、customers.total_visitsを更新する。
//   GAS版はLINEのuserIdでしか顧客を紐付けられなかったが、Node版は予約作成時に
//   customer_idを直接紐付けられるため、customer_idで集計する（LINE未連携の
//   顧客もカウントされるようになり、GAS版よりも対象が広がっている）。GAS版と
//   同様、集計結果が現在の値より大きい場合のみ更新する（手動で多めに入力された
//   数値を誤って減らさないための安全策）。
//
// POST /api/admin/maintenance/run-daily
// ----------------------------------------------------------------------------
// ★2026-09-23更新：処理本体はlib/maintenance.jsへ切り出した（常設スケジューラ
//   lib/scheduler.jsからHTTPリクエスト無しで同じ処理を呼べるようにするため）。
app.post('/api/admin/maintenance/run-daily', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const result = runDailyMaintenance(db, engine, storeId);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ★2026-09-23追加：日次LINEレポート4種（GAS版triggers.jsの時間主導トリガー
//   sendMorningReportToOwner / sendEveningReportToOwner / sendDayBeforeReminders /
//   sendStaffTomorrowSchedule_ 相当）。日次メンテナンス（run-daily）と同じく、
//   常駐スケジューラをまだ用意していないため、オーナー管理画面からの手動実行
//   ボタンとして再現する（本番運用では別途スケジューラの整備が必要）。
//   実装本体はlib/dailyReports.jsを参照。
//
// POST /api/admin/reports/morning                … 朝レポート（本日の予約状況）
// POST /api/admin/reports/evening                … 夕方レポート（本日確定・要確認
//                                                     リクエスト・未確定仮予約）＋
//                                                     スタッフ翌日予約通知（相乗り）
// POST /api/admin/reports/day-before-reminders   … 前日リマインダー（お客様向け）
// POST /api/admin/reports/staff-tomorrow-schedule … スタッフ翌日予約通知（単独実行）
// ----------------------------------------------------------------------------
app.post('/api/admin/reports/morning', requireOwnerSession, async (req, res) => {
  try {
    const result = await dailyReports.sendMorningReportToOwner(db, req.session.staff.storeId);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/reports/evening', requireOwnerSession, async (req, res) => {
  try {
    const result = await dailyReports.sendEveningReportToOwner(db, req.session.staff.storeId);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/reports/day-before-reminders', requireOwnerSession, async (req, res) => {
  try {
    const result = await dailyReports.sendDayBeforeReminders(db, req.session.staff.storeId);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/admin/reports/staff-tomorrow-schedule', requireOwnerSession, async (req, res) => {
  try {
    const result = await dailyReports.sendStaffTomorrowSchedule(db, req.session.staff.storeId);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// ★2026-09-23追加：DB一覧ビューア（社長より「全体の予約や顧客データを見渡せる
//   スプレットシートのような画面」「admin権限のみで入れるDBを直接視覚的にみれる
//   ページ」の要望）。既存のcustomers-view.html／reservations-view.htmlは
//   目的別に整形・絞り込み済みの一覧だが、こちらは店舗の全テーブルを横断的に
//   スプレットシートのグリッドのような形で閲覧できる、より網羅的な一覧を狙った
//   ページ。オーナーのみアクセス可（requireOwnerSession）。
//
//   【対象テーブルのホワイトリスト】DB_VIEWER_TABLES に無いテーブル名は拒否する
//   （SQLインジェクション対策・想定外テーブルの露出防止）。各テーブルのカラムも
//   ホワイトリスト化し、スタッフのpin_hash／pin_saltなど認証情報は最初から
//   一覧に含めない（LINE連携情報を生のまま扱わない、という既存の方針を踏襲）。
//   閲覧専用（編集・削除は今回のスコープ外。既存のCRUD用APIで対応する）。
// ============================================================================
// ★2026-09-24追加：管理者ログイン時だけ、editable に挙げたカラムを1行ずつ編集できる
//   （社長の要望 v56 の設計方針：①編集可能カラムのホワイトリスト化 ②変更ログ（監査ログ）
//   の記録 ③保存前の確認ダイアログ必須）。行の追加・削除はできない（各管理画面の既存機能で行う）。
//   editable から外しているもの：id・created_at・updated_at（自動）・店舗ID・顧客IDなどの
//   紐付けキー・認証情報（PIN）・権限系（is_owner・is_shared_terminal・is_active（スタッフ））・
//   統合済みフラグ（is_deleted）・スタッフの氏名（予約・シフトの担当者名と文字列で紐付いており、
//   変更時はスタッフ管理画面のシフト初期値の整理処理を通す必要があるため）・シフトの担当者名。
//   型：text（required:trueなら空不可）／int／bool（0・1）／date（YYYY-MM-DD）／time（HH:MM）／enum
//   adminOnly:true のテーブル（編集ログ・LINE webhook受信ログ）は管理者だけが閲覧でき、編集はできない。
const DB_VIEWER_TABLES = {
  reservations: {
    label: '予約 (reservations)',
    columns: ['id', 'realname', 'kana', 'line_name', 'staff_name', 'menu', 'reservation_date', 'reservation_time', 'note', 'editor', 'line_sent', 'reminder_sent', 'done', 'customer_id', 'status', 'created_at', 'updated_at'],
    defaultSort: 'reservation_date', defaultDir: 'DESC',
    searchColumns: ['realname', 'kana', 'staff_name', 'menu', 'note'],
    editable: {
      realname: { type: 'text', required: true }, kana: { type: 'text' }, line_name: { type: 'text' },
      staff_name: { type: 'text', required: true }, menu: { type: 'text' },
      reservation_date: { type: 'date', required: true }, reservation_time: { type: 'time', required: true },
      note: { type: 'text' }, line_sent: { type: 'bool' }, reminder_sent: { type: 'bool' }, done: { type: 'bool' },
      status: { type: 'enum', options: ['確定', '仮予約'] }
    }
  },
  customers: {
    label: '顧客 (customers)',
    columns: ['id', 'customer_id', 'realname', 'kana', 'phone', 'address', 'line_name', 'birthday', 'first_visit_date', 'last_visit_date', 'total_visits', 'memo', 'status', 'staff_name', 'is_keep_member', 'opt_support', 'booking_blocked', 'notify_enabled', 'is_deleted', 'created_at', 'updated_at'],
    defaultSort: 'last_visit_date', defaultDir: 'DESC',
    searchColumns: ['realname', 'kana', 'phone', 'memo'],
    editable: {
      realname: { type: 'text', required: true }, kana: { type: 'text' }, phone: { type: 'text' }, address: { type: 'text' },
      line_name: { type: 'text' }, birthday: { type: 'date' }, first_visit_date: { type: 'date' }, last_visit_date: { type: 'date' },
      total_visits: { type: 'int', min: 0 }, memo: { type: 'text' }, status: { type: 'enum', options: ['active', 'inactive'] },
      staff_name: { type: 'text' }, is_keep_member: { type: 'bool' }, opt_support: { type: 'bool' },
      booking_blocked: { type: 'bool' }, notify_enabled: { type: 'bool' }
    }
  },
  staff: {
    label: 'スタッフ (staff)',
    columns: ['id', 'name', 'nickname', 'role', 'color', 'opt_support', 'night_restrict', 'show_in_booking', 'is_active', 'is_owner', 'is_shared_terminal', 'created_at'],
    defaultSort: 'id', defaultDir: 'ASC',
    searchColumns: ['name', 'nickname', 'role'],
    editable: {
      nickname: { type: 'text' }, role: { type: 'enum', options: ['オーナー', 'スタッフ', '見習い', 'サロン端末'] },
      opt_support: { type: 'bool' }, night_restrict: { type: 'bool' }, show_in_booking: { type: 'bool' }
    }
  },
  shift_master: {
    label: 'シフトマスタ (shift_master)',
    columns: ['id', 'staff_name', 'shift_date', 'start_time', 'end_time', 'is_active', 'created_at'],
    defaultSort: 'shift_date', defaultDir: 'DESC',
    searchColumns: ['staff_name'],
    editable: {
      shift_date: { type: 'date', required: true }, start_time: { type: 'time', required: true },
      end_time: { type: 'time', required: true }, is_active: { type: 'bool' }
    }
  },
  shift_templates: {
    label: 'シフト初期値 (shift_templates)',
    columns: ['id', 'staff_name', 'day_of_week', 'start_time', 'end_time', 'is_active', 'created_at'],
    defaultSort: 'staff_name', defaultDir: 'ASC',
    searchColumns: ['staff_name'],
    editable: {
      start_time: { type: 'time', required: true }, end_time: { type: 'time', required: true }, is_active: { type: 'bool' }
    }
  },
  events: {
    label: 'イベント／休業日 (events)',
    columns: ['id', 'title', 'event_date', 'start_time', 'end_time', 'restrict_booking', 'block_start_time', 'block_end_time', 'is_active', 'created_at'],
    defaultSort: 'event_date', defaultDir: 'DESC',
    searchColumns: ['title'],
    editable: {
      title: { type: 'text', required: true }, event_date: { type: 'date', required: true },
      start_time: { type: 'time', required: true }, end_time: { type: 'time', required: true },
      restrict_booking: { type: 'bool' }, block_start_time: { type: 'time' }, block_end_time: { type: 'time' }, is_active: { type: 'bool' }
    }
  },
  menu_items: {
    label: 'メニュー (menu_items)',
    columns: ['id', 'category', 'name', 'duration_min', 'price', 'target', 'is_active', 'display_order', 'is_initial', 'created_at'],
    defaultSort: 'display_order', defaultDir: 'ASC',
    searchColumns: ['category', 'name'],
    editable: {
      category: { type: 'enum', options: ['メインメニュー', '施術系オプション', 'オプション'] }, name: { type: 'text', required: true },
      duration_min: { type: 'int', min: 0 }, price: { type: 'int', min: 0 },
      target: { type: 'enum', options: ['全員', '初回', 'キープメンバー', 'ビジター'] },
      is_active: { type: 'bool' }, display_order: { type: 'int', min: 0 }, is_initial: { type: 'bool' }
    }
  },
  rules: {
    label: '店舗設定値 (rules)',
    columns: ['id', 'rule_id', 'memo', 'value'],
    defaultSort: 'rule_id', defaultDir: 'ASC',
    searchColumns: ['rule_id', 'memo'],
    editable: { memo: { type: 'text' }, value: { type: 'text', required: true } }
  },
  zones: {
    label: 'ゾーン設定 (zones)',
    columns: ['id', 'zone_key', 'label', 'start_time', 'end_time', 'fixed_target', 'fixed_start', 'fixed_interval_min', 'is_active'],
    defaultSort: 'zone_key', defaultDir: 'ASC',
    searchColumns: ['zone_key', 'label'],
    editable: {
      label: { type: 'text', required: true }, start_time: { type: 'time', required: true }, end_time: { type: 'time', required: true },
      fixed_target: { type: 'bool' }, fixed_start: { type: 'time' }, fixed_interval_min: { type: 'int', min: 0 }, is_active: { type: 'bool' }
    }
  },
  message_templates: {
    label: 'メッセージテンプレート (message_templates)',
    columns: ['id', 'msg_key', 'body', 'closing', 'updated_at'],
    defaultSort: 'msg_key', defaultDir: 'ASC',
    searchColumns: ['msg_key', 'body'],
    editable: { body: { type: 'text' }, closing: { type: 'text' } }
  },
  booking_notices: {
    label: 'お知らせ (booking_notices)',
    columns: ['id', 'target', 'text', 'is_active', 'created_at', 'updated_at'],
    defaultSort: 'id', defaultDir: 'DESC',
    searchColumns: ['text'],
    editable: { target: { type: 'enum', options: ['全員', '初回', 'リピーター'] }, text: { type: 'text', required: true }, is_active: { type: 'bool' } }
  },
  db_edit_log: {
    label: '🛡️ 編集ログ (db_edit_log)',
    adminOnly: true,
    columns: ['id', 'edited_at', 'edited_by', 'table_name', 'row_id', 'column_name', 'old_value', 'new_value'],
    defaultSort: 'id', defaultDir: 'DESC',
    searchColumns: ['table_name', 'column_name', 'old_value', 'new_value']
  },
  webhook_log: {
    label: '🛡️ LINE webhook受信ログ (webhook_log)',
    adminOnly: true,
    columns: ['id', 'received_at', 'event_type', 'message_type', 'destination', 'source_type', 'user_id', 'body', 'result', 'raw_json'],
    defaultSort: 'id', defaultDir: 'DESC',
    searchColumns: ['event_type', 'message_type', 'user_id', 'body', 'result']
  }
};
const DB_EDIT_TEXT_MAX = 2000;

// 編集値の型チェック・正規化（NGならエラーメッセージを返す）
function normalizeDbEditValue_(spec, value) {
  const str = value == null ? '' : String(value);
  switch (spec.type) {
    case 'int': {
      if (!/^-?\d+$/.test(str.trim())) return { error: '整数で入力してください' };
      const n = Number(str.trim());
      if (spec.min != null && n < spec.min) return { error: `${spec.min}以上で入力してください` };
      return { value: n };
    }
    case 'bool':
      if (!['0', '1', 'true', 'false'].includes(str)) return { error: '0か1で指定してください' };
      return { value: (str === '1' || str === 'true') ? 1 : 0 };
    case 'date':
      if (!str) return spec.required ? { error: '必須項目です' } : { value: null };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str) || isNaN(new Date(str + 'T00:00:00').getTime())) return { error: 'YYYY-MM-DD形式で入力してください' };
      return { value: str };
    case 'time':
      if (!str) return spec.required ? { error: '必須項目です' } : { value: null };
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(str)) return { error: 'HH:MM形式で入力してください' };
      return { value: str };
    case 'enum':
      if (!spec.options.includes(str)) return { error: '選択肢の中から指定してください' };
      return { value: str };
    default:
      if (spec.required && !str.trim()) return { error: '必須項目です' };
      if (str.length > DB_EDIT_TEXT_MAX) return { error: `${DB_EDIT_TEXT_MAX}文字以内で入力してください` };
      return { value: str };
  }
}
// 旧値・新値の比較と監査ログ用に、値を文字列（nullはnull）にそろえる
function dbEditValueToText_(v) { return v == null ? null : String(v); }

// GET /api/admin/db-viewer/tables : 閲覧可能なテーブルの一覧とカラム定義を返す
app.get('/api/admin/db-viewer/tables', requireOwnerSession, (req, res) => {
  // ★2026-09-24追加：管理者ログイン時だけ、管理者専用タブ（編集ログ・webhook受信ログ）と
  //   各テーブルの編集可能カラム（editable）を返す。オーナーには従来どおり閲覧用の情報だけ
  const isAdmin = !!req.session.staff.isAdmin;
  const tables = Object.entries(DB_VIEWER_TABLES)
    .filter(([, def]) => isAdmin || !def.adminOnly)
    .map(([key, def]) => ({
      key, label: def.label, columns: def.columns,
      adminOnly: !!def.adminOnly,
      editable: isAdmin && def.editable ? def.editable : null
    }));
  res.json({ tables, isAdmin });
});

// GET /api/admin/db-viewer/:table : 指定テーブルの行を返す（自店舗のみ・閲覧専用）
//   ?q=検索語 ?sort=カラム名 ?dir=ASC|DESC ?limit= ?offset=
app.get('/api/admin/db-viewer/:table', requireOwnerSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const tableKey = req.params.table;
    const def = DB_VIEWER_TABLES[tableKey];
    if (!def) {
      return res.status(400).json({ success: false, message: '対象のテーブルではありません' });
    }
    if (def.adminOnly && !req.session.staff.isAdmin) {
      return res.status(403).json({ success: false, error: 'admin_only', message: 'このテーブルは管理者ログイン時のみ閲覧できます' });
    }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    let sortCol = def.defaultSort;
    if (req.query.sort && def.columns.includes(String(req.query.sort))) {
      sortCol = String(req.query.sort);
    }
    const sortDir = String(req.query.dir).toUpperCase() === 'ASC' ? 'ASC' : (String(req.query.dir).toUpperCase() === 'DESC' ? 'DESC' : def.defaultDir);

    let where = 'store_id = ?';
    const params = [storeId];
    if (req.query.q && def.searchColumns.length) {
      const like = `%${req.query.q}%`;
      where += ' AND (' + def.searchColumns.map((c) => `${c} LIKE ?`).join(' OR ') + ')';
      def.searchColumns.forEach(() => params.push(like));
    }

    const colList = def.columns.map((c) => `"${c}"`).join(', ');
    const total = db.prepare(`SELECT COUNT(*) AS c FROM ${tableKey} WHERE ${where}`).get(...params).c;
    const rows = db.prepare(`
      SELECT ${colList} FROM ${tableKey} WHERE ${where}
      ORDER BY "${sortCol}" ${sortDir}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ table: tableKey, label: def.label, columns: def.columns, total, limit, offset, sort: sortCol, dir: sortDir, rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ----------------------------------------------------------------------------
// ★2026-09-24追加：PUT /api/admin/db-viewer/:table/:id （管理者のみ）
//   { changes: { カラム名: 新しい値 }, expected: { カラム名: 画面に表示されていた旧値 } }
//   → { success, changed: [{ column, oldValue, newValue }] }
//   ・editable（ホワイトリスト）に無いカラム、自店舗以外の行は拒否する
//   ・expected（画面で確認ダイアログに出した旧値）とDBの現在値が食い違う場合は、
//     別の画面等で先に変更されたとみなし409で拒否する（古い画面のまま上書きする事故を防ぐ）
//   ・値が実際に変わるカラムだけを更新し、1カラム1行で db_edit_log に記録する
//     （更新と記録は1トランザクション。記録できなければ更新もしない）
//   ・編集ログ・webhook受信ログ（adminOnly）は編集できない（改ざん防止）
// ----------------------------------------------------------------------------
app.put('/api/admin/db-viewer/:table/:id', requireAdminSession, (req, res) => {
  try {
    const storeId = req.session.staff.storeId;
    const tableKey = req.params.table;
    const def = DB_VIEWER_TABLES[tableKey];
    if (!def || !def.editable) {
      return res.status(400).json({ success: false, message: 'このテーブルは編集できません' });
    }
    const id = Number(req.params.id);
    const changes = (req.body && req.body.changes) || {};
    const expected = (req.body && req.body.expected) || {};
    const cols = Object.keys(changes);
    if (!Number.isInteger(id) || !cols.length) {
      return res.status(400).json({ success: false, message: '変更内容がありません' });
    }
    const errors = [];
    const normalized = {};
    cols.forEach((c) => {
      const spec = def.editable[c];
      if (!spec) { errors.push(`${c}：編集できないカラムです`); return; }
      const r = normalizeDbEditValue_(spec, changes[c]);
      if (r.error) errors.push(`${c}：${r.error}`); else normalized[c] = r.value;
    });
    if (errors.length) {
      return res.status(400).json({ success: false, message: errors.join(' / '), errors });
    }

    const tableCols = new Set(db.prepare(`PRAGMA table_info(${tableKey})`).all().map((r) => r.name));
    const run = db.transaction(() => {
      const current = db.prepare(`SELECT * FROM ${tableKey} WHERE id = ? AND store_id = ?`).get(id, storeId);
      if (!current) return { status: 404, body: { success: false, message: '対象の行が見つかりません（他店舗のデータは編集できません）' } };
      const conflicts = cols.filter((c) => Object.prototype.hasOwnProperty.call(expected, c) &&
        dbEditValueToText_(expected[c] === '' ? null : expected[c]) !== dbEditValueToText_(current[c] === '' ? null : current[c]));
      if (conflicts.length) {
        return { status: 409, body: { success: false, message: '画面を開いた後に別の操作でこの行が変更されています。再読み込みしてからやり直してください', conflicts } };
      }
      const changed = cols
        .filter((c) => dbEditValueToText_(current[c]) !== dbEditValueToText_(normalized[c]))
        .map((c) => ({ column: c, oldValue: dbEditValueToText_(current[c]), newValue: dbEditValueToText_(normalized[c]) }));
      if (!changed.length) return { status: 200, body: { success: true, changed: [] } };
      const setSql = changed.map((ch) => `"${ch.column}" = @${ch.column}`).join(', ') +
        (tableCols.has('updated_at') ? ', updated_at = CURRENT_TIMESTAMP' : '');
      const params = { id, store_id: storeId };
      changed.forEach((ch) => { params[ch.column] = normalized[ch.column]; });
      db.prepare(`UPDATE ${tableKey} SET ${setSql} WHERE id = @id AND store_id = @store_id`).run(params);
      const insLog = db.prepare(`
        INSERT INTO db_edit_log (store_id, table_name, row_id, column_name, old_value, new_value, edited_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      changed.forEach((ch) => insLog.run(storeId, tableKey, id, ch.column, ch.oldValue, ch.newValue, req.session.staff.name));
      return { status: 200, body: { success: true, changed } };
    });
    let result;
    try {
      result = run();
    } catch (dbErr) {
      // UNIQUE制約（二重予約防止など）・NOT NULL制約に触れる値は400で返す（何も書き込まれない）
      if (String(dbErr.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return res.status(400).json({ success: false, message: 'DBの制約に反するため保存できません（重複や必須項目の空欄など）: ' + dbErr.message });
      }
      throw dbErr;
    }
    res.status(result.status).json(result.body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
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

// ★2026-09-23追加：常設スケジューラ起動（lib/scheduler.js）。DB初期化・マイグレーション
//   （上のinitDatabase()/runMigrations(db)）が完了した後、サーバー起動と同時に開始する。
//   ★SKIP_SEED=1のテスト環境でも常に起動する（node-cronのタイマー登録自体は
//   軽量なのでテストの妨げにはならない想定。実際に発火するのは毎時0分のみ）。
startScheduler(db, engine);
