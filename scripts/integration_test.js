// ============================================================================
// scripts/integration_test.js
// ⑥統合テスト：①〜⑤を通しで動かし、主要な不具合が無いかを自動チェックする。
//
// 実行前提：
//   1. `node db/init.js` でDBを作り直す（ダミーデータ投入）
//   2. `node scripts/seed_test_store2.js` でテスト用2店舗目を追加投入
//   3. `SKIP_SEED=1 node server.js` でサーバーを起動する（1・2の投入結果を消さないため）
//   4. `node scripts/integration_test.js` を実行する
//
// このスクリプトはテストフレームワークを使わず、Node標準機能のみで書いている
// （新規npm依存を増やさないため）。assert()で失敗したら例外を投げて即終了し、
// 最後に PASS/FAIL のサマリーを表示する。
// ============================================================================

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const db = require('../lib/db'); // ★11章（顧客統合）のテスト用フィクスチャ直接投入にのみ使用

let passCount = 0;
let failCount = 0;
const failures = [];

function assert(cond, label) {
  if (cond) {
    passCount++;
    console.log(`  ✅ ${label}`);
  } else {
    failCount++;
    failures.push(label);
    console.log(`  ❌ ${label}`);
  }
}

// ----------------------------------------------------------------------------
// 簡易Cookie Jar：fetchは自動でCookieを保持しないため、セッションごとに
// Set-Cookieを受け取って次のリクエストにCookieヘッダーで載せる小さな実装。
// ----------------------------------------------------------------------------
function makeSession() {
  let cookie = null;
  return {
    async request(path, opts = {}) {
      const headers = Object.assign({}, opts.headers);
      if (cookie) headers['Cookie'] = cookie;
      const res = await fetch(BASE + path, Object.assign({}, opts, { headers }));
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let body = null;
      try { body = await res.json(); } catch (_) { /* 本文なし等 */ }
      return { status: res.status, body };
    },
    async postJson(path, data) {
      return this.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    },
    async get(path) {
      return this.request(path, { method: 'GET' });
    }
  };
}

async function main() {
  console.log(`\n=== ⑥統合テスト開始（対象: ${BASE}）===\n`);

  // --------------------------------------------------------------------------
  // 1. 認証まわり
  // --------------------------------------------------------------------------
  console.log('--- 1. 認証 ---');
  const anon = makeSession();
  {
    const r = await anon.get('/api/admin/dashboard');
    assert(r.status === 401, '未ログインで管理画面APIを叩くと401になる');
  }

  const owner1 = makeSession();
  {
    const r = await owner1.postJson('/api/auth/login', { store: '1', pin: '9999' });
    assert(r.status === 401, '誤ったPINでのログインは401になる（正しいPINと誤認しない）');
  }
  {
    const r = await owner1.postJson('/api/auth/login', { store: '1', pin: '5678' });
    assert(r.status === 200 && r.body.success === true, 'store1オーナー（PIN5678）が正しくログインできる');
  }
  {
    const r = await owner1.postJson('/api/auth/login', { store: '1', pin: '6789' }); // 花子（is_owner=0）
    assert(r.status === 403, '一般スタッフPINでのログインは403（オーナー限定メッセージ）になる');
  }

  // --------------------------------------------------------------------------
  // 2. 複数店舗のデータ分離（★今回の目玉：store_idによる分離が本当に効くか）
  // --------------------------------------------------------------------------
  console.log('--- 2. 複数店舗のデータ分離 ---');
  const owner2 = makeSession();
  {
    const r = await owner2.postJson('/api/auth/login', { store: 'iwatamachi-test', pin: '4321' });
    assert(r.status === 200 && r.body.success === true, '岩田町店（テスト用2店舗目）のオーナーがログインできる');
  }
  {
    const r1 = await owner1.get('/api/admin/customers');
    const r2 = await owner2.get('/api/admin/customers');
    const names1 = (r1.body.customers || []).map((c) => c.realname);
    const names2 = (r2.body.customers || []).map((c) => c.realname);
    assert(!names1.includes('岩田 花子'), 'store1オーナーには岩田町店の顧客が見えない');
    assert(names2.includes('岩田 花子') && names2.length === 1, '岩田町店オーナーには岩田町店の顧客（1件）だけが見える');
    assert(!names2.some((n) => names1.includes(n)), '両店の顧客リストが混ざっていない');
  }
  {
    // ?store= を渡しても無視され、セッションの店舗に固定されることを確認
    const r = await owner2.get('/api/admin/customers?store=1');
    const names = (r.body.customers || []).map((c) => c.realname);
    assert(names.length === 1 && names[0] === '岩田 花子', '?store=1を渡しても岩田町店オーナーはstore1のデータを見られない（なりすまし防止）');
  }

  // --------------------------------------------------------------------------
  // 3. 二重予約防止（同時アクセス）
  // --------------------------------------------------------------------------
  console.log('--- 3. 二重予約防止（同時5件リクエスト） ---');
  {
    const d = new Date(); d.setDate(d.getDate() + 10);
    const dateStr = d.toISOString().slice(0, 10);
    const payload = {
      store: '1', realname: '統合テスト太郎', staffName: '花子', menu: 'テストメニュー',
      date: dateStr, time: '14:00', customerId: 'ITEST01'
    };
    const results = await Promise.all(
      Array.from({ length: 5 }).map(() =>
        fetch(BASE + '/api/reservations', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        }).then((res) => res.json().then((b) => ({ status: res.status, body: b })))
      )
    );
    const succeeded = results.filter((r) => r.body && r.body.success === true);
    const doubleBooked = results.filter((r) => r.body && r.body.isDoubleBooking === true);
    assert(succeeded.length === 1, `同時5件のうち登録成功は1件のみ（実際:${succeeded.length}件）`);
    assert(doubleBooked.length === 4, `同時5件のうち4件が「二重予約」として正しく拒否される（実際:${doubleBooked.length}件）`);
  }

  // --------------------------------------------------------------------------
  // 4. 予約上限チェック（MAX_RESERVATIONS_PER_CUSTOMER=3）
  // --------------------------------------------------------------------------
  console.log('--- 4. 予約上限チェック ---');
  {
    const base = new Date(); base.setDate(base.getDate() + 20);
    const custName = '統合テスト花子';
    let warningSeen = false;
    for (let i = 0; i < 4; i++) {
      const d = new Date(base); d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      const r = await fetch(BASE + '/api/reservations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store: '1', realname: custName, staffName: '美咲', menu: 'テストメニュー',
          date: dateStr, time: '15:00', customerId: 'ITEST02'
        })
      }).then((res) => res.json());
      if (i < 3) {
        assert(r.success === true, `${i + 1}件目の予約は正常に登録できる`);
      } else {
        warningSeen = r.isLimitWarning === true;
      }
    }
    assert(warningSeen, '4件目の予約で上限警告（isLimitWarning）が返る');
  }

  // --------------------------------------------------------------------------
  // 5. CSV取込の冪等性（実データ量：sample_data/を2回連続で取り込む）
  // --------------------------------------------------------------------------
  console.log('--- 5. CSV取込の冪等性 ---');
  {
    const first = await owner1.postJson('/api/admin/import-sample-data', {});
    const second = await owner1.postJson('/api/admin/import-sample-data', {});
    assert(first.status === 200 && first.body.success === true, '1回目のサンプルデータ取込が成功する');
    assert(second.status === 200 && second.body.success === true, '2回目のサンプルデータ取込も成功する（エラーにならない）');
    assert(second.body.customers.inserted === 0, '2回目の取込では顧客が新規登録されない（重複しない）');
    // 既知の制約：キャンセル済み予約は顧客IDが無い行があり、重複が生じ得る（README 9-3参照）。
    // ここでは「エラーにならず走りきること」までを確認し、件数の完全一致は求めない。
    console.log(`  ℹ️  参考：2回目の予約取込 新規${second.body.reservations.inserted}件（キャンセル済み行の重複はREADME既知の制約）`);
  }

  // --------------------------------------------------------------------------
  // 6. 課金基盤（プラン切替でLINE通知の扱いが変わるか）
  // --------------------------------------------------------------------------
  console.log('--- 6. プラン切替 ---');
  {
    const r1 = await owner1.postJson('/api/admin/plan', { plan: 'base' });
    assert(r1.body.currentPlan.features.lineNotify === false, '①ベースプランではlineNotify=false');
    const r2 = await owner1.postJson('/api/admin/plan', { plan: 'line' });
    assert(r2.body.currentPlan.features.lineNotify === true, '②LINE連携プランではlineNotify=true');
    const r3 = await owner1.postJson('/api/admin/plan', { plan: 'bogus-plan' });
    assert(r3.status === 400, '存在しないプランを指定すると400になる');
    // 元の状態に戻しておく（他のテスト・デモ表示に影響しないように）
    await owner1.postJson('/api/admin/plan', { plan: 'trial' });
  }

  // --------------------------------------------------------------------------
  // 7. ログアウト後にセッションが無効になるか
  // --------------------------------------------------------------------------
  console.log('--- 7. ログアウト ---');
  {
    await owner1.postJson('/api/auth/logout', {});
    const r = await owner1.get('/api/admin/dashboard');
    assert(r.status === 401, 'ログアウト後は管理画面APIが401になる');
  }

  // --------------------------------------------------------------------------
  // 8. シフト管理（★2026-09-19追加）
  // --------------------------------------------------------------------------
  console.log('--- 8. シフト管理 ---');
  const ownerFresh = makeSession();
  await ownerFresh.postJson('/api/auth/login', { store: '1', pin: '5678' });
  {
    const r = await ownerFresh.get('/api/admin/staff');
    assert(r.status === 200 && Array.isArray(r.body.staff) && r.body.staff.length >= 3, 'スタッフ一覧（見習い含む全員）が取得できる');
  }
  let addedShiftId = null;
  {
    const r = await ownerFresh.postJson('/api/admin/shifts', { staffName: '花子', date: '2026-12-01', startTime: '10:00', endTime: '18:00' });
    assert(r.status === 200 && r.body.success === true, 'シフトを新規追加できる');
    addedShiftId = r.body.shiftId;
  }
  {
    const r = await ownerFresh.postJson('/api/admin/shifts', { staffName: '花子', date: '2026-12-01', startTime: '18:00', endTime: '10:00' });
    assert(r.status === 400, '終了が開始より前のシフトは400で拒否される');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/shifts', { staffName: '存在しないスタッフ', date: '2026-12-01', startTime: '10:00', endTime: '18:00' });
    assert(r.status === 400, '在籍しないスタッフ名のシフトは400で拒否される');
  }
  {
    const r = await ownerFresh.get('/api/admin/shifts?from=2026-12-01&to=2026-12-01');
    const found = (r.body.shifts || []).some((s) => s.id === addedShiftId);
    assert(found, '追加したシフトが期間指定の一覧に反映される');
  }
  {
    // 店2のオーナーは店1のシフトを削除できない
    const r = await owner2.request(`/api/admin/shifts/${addedShiftId}`, { method: 'DELETE' });
    assert(r.status === 404, '他店舗のシフトIDを指定しても削除できない（店舗スコープ確認）');
  }
  {
    const r = await ownerFresh.request(`/api/admin/shifts/${addedShiftId}`, { method: 'DELETE' });
    assert(r.status === 200 && r.body.success === true, '自店舗のシフトは削除できる');
  }

  // --------------------------------------------------------------------------
  // 9. 予約の編集・キャンセル（★2026-09-19追加）
  // --------------------------------------------------------------------------
  console.log('--- 9. 予約の編集・キャンセル ---');
  let editTargetId = null;
  {
    const r = await fetch(BASE + '/api/reservations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store: '1', realname: '編集テスト客', staffName: '美咲', menu: '編集前メニュー', date: '2026-12-05', time: '13:00' })
    }).then((res) => res.json());
    assert(r.success === true, '編集テスト用の予約を作成できる');
    editTargetId = r.reservationId;
  }
  {
    const r = await owner2.request(`/api/admin/reservations/${editTargetId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffName: '美咲', menu: 'なりすまし編集', date: '2026-12-05', time: '14:00' })
    });
    assert(r.status === 404, '他店舗オーナーは他店の予約を編集できない（店舗スコープ確認）');
  }
  {
    const r = await ownerFresh.request(`/api/admin/reservations/${editTargetId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffName: '美咲', menu: '編集後メニュー', date: '2026-12-05', time: '14:00', note: '統合テストで編集' })
    });
    assert(r.status === 200 && r.body.success === true, '自店舗オーナーは予約を編集できる');
  }
  {
    const r = await owner2.request(`/api/admin/reservations/${editTargetId}`, { method: 'DELETE' });
    assert(r.status === 404, '他店舗オーナーは他店の予約をキャンセルできない（店舗スコープ確認）');
  }
  {
    const r = await ownerFresh.request(`/api/admin/reservations/${editTargetId}`, { method: 'DELETE' });
    assert(r.status === 200 && r.body.success === true, '自店舗オーナーは予約をキャンセルできる');
  }
  {
    const r = await ownerFresh.request(`/api/admin/reservations/${editTargetId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffName: '美咲', menu: 'x', date: '2026-12-05', time: '15:00' })
    });
    assert(r.status === 400, 'キャンセル済みの予約は再編集できない');
  }

  // --------------------------------------------------------------------------
  // 10. スタッフ管理（★2026-09-19追加）
  // --------------------------------------------------------------------------
  console.log('--- 10. スタッフ管理 ---');
  let newStaffId = null;
  {
    const r = await ownerFresh.postJson('/api/admin/staff', {
      name: '統合テスト新人', nickname: 'てすと', role: '見習い',
      showInBooking: true, optSupport: false, nightRestrict: false, isOwner: false, pin: '9999'
    });
    assert(r.status === 200 && r.body.success === true, '新規スタッフを追加できる');
    newStaffId = r.body.staffId;
  }
  {
    const r = await ownerFresh.postJson('/api/admin/staff', { pin: '9999' });
    assert(r.status === 400, '氏名なしでは追加できない');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/staff', { name: '桁不正', pin: '12' });
    assert(r.status === 400, 'PINが4桁でなければ追加できない');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/staff', { name: '統合テスト新人', pin: '1234' });
    assert(r.status === 400, '同一店舗内で在籍中の同姓同名は追加できない');
  }
  {
    const r = await ownerFresh.request(`/api/admin/staff/${newStaffId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '統合テスト新人', nickname: 'てすと2', role: 'スタッフ', showInBooking: true, optSupport: true, nightRestrict: false, isOwner: false, isActive: true })
    });
    assert(r.status === 200 && r.body.success === true, 'スタッフ情報を編集できる');
  }
  {
    const r = await ownerFresh.get('/api/admin/staff');
    const found = (r.body.staff || []).find((s) => s.id === newStaffId);
    assert(!!found && found.nickname === 'てすと2' && found.opt_support === 1, '編集内容が一覧に反映される');
  }
  {
    // ログイン中の自分自身を在籍中=falseにはできない
    const r = await ownerFresh.request('/api/admin/staff/1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '寿子', isActive: false })
    });
    assert(r.status === 400, 'ログイン中の自分自身は在籍中を外せない');
  }
  {
    const r = await ownerFresh.request(`/api/admin/staff/${newStaffId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' })
    });
    assert(r.status === 400, '氏名を空にする編集は拒否される');
  }
  {
    const r = await ownerFresh.request('/api/admin/staff/999999', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'だれか' })
    });
    assert(r.status === 404, '存在しないIDの編集は404になる');
  }
  {
    // 他店舗オーナーは他店のスタッフを編集できない
    const r = await owner2.request(`/api/admin/staff/${newStaffId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'なりすまし' })
    });
    assert(r.status === 404, '他店舗オーナーは他店のスタッフを編集できない（店舗スコープ確認）');
  }
  {
    const r = await ownerFresh.request(`/api/admin/staff/${newStaffId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '統合テスト新人', pin: '5555' })
    });
    assert(r.status === 200 && r.body.success === true, 'PINをリセットできる');
  }

  // --------------------------------------------------------------------------
  // 11. 顧客マスタの重複統合（★2026-09-19追加）
  // --------------------------------------------------------------------------
  console.log('--- 11. 顧客マスタの重複統合 ---');
  const dupTel = '09055556666';
  db.prepare(`INSERT INTO customers (store_id, customer_id, realname, kana, phone, total_visits) VALUES (1, 'CT900', 'テスト統合太郎', 'テストトウゴウタロウ', ?, 3)`).run(dupTel);
  db.prepare(`INSERT INTO customers (store_id, customer_id, realname, kana, phone, total_visits) VALUES (1, 'CT901', 'てすと統合太郎', '', ?, 2)`).run(dupTel.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3'));
  // 店2側にも同じ電話番号の顧客を1件だけ投入（店舗スコープ確認用：店1の候補に混ざらないこと）
  db.prepare(`INSERT INTO customers (store_id, customer_id, realname, kana, phone, total_visits) VALUES (2, 'CT902', '店2テスト花子', '', ?, 1)`).run(dupTel);

  let ct900Candidate = null;
  {
    const r = await ownerFresh.get('/api/admin/customers/merge-candidates');
    ct900Candidate = (r.body.candidates || []).find((c) =>
      (c.customerA.customer_id === 'CT900' && c.customerB.customer_id === 'CT901') ||
      (c.customerA.customer_id === 'CT901' && c.customerB.customer_id === 'CT900')
    );
    assert(r.status === 200 && !!ct900Candidate, '電話番号一致の重複候補（CT900⇔CT901）が検出される');
  }
  {
    const r = await owner2.get('/api/admin/customers/merge-candidates');
    const leaked = (r.body.candidates || []).some((c) => c.customerA.customer_id === 'CT900' || c.customerB.customer_id === 'CT900');
    assert(r.status === 200 && !leaked, '他店舗の重複候補には自店舗のデータしか出ない（店舗スコープ確認）');
  }
  {
    const r = await owner2.postJson('/api/admin/customers/merge', { keepCustomerId: 'CT900', mergeCustomerId: 'CT901' });
    assert(r.status === 400, '他店舗オーナーは他店の顧客を統合できない');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/customers/merge', { keepCustomerId: 'CT900', mergeCustomerId: 'CT900' });
    assert(r.status === 400, '同じ顧客同士は統合できない');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/customers/merge', { keepCustomerId: 'CT900', mergeCustomerId: 'CT901' });
    assert(r.status === 200 && r.body.success === true, 'CT901をCT900に統合できる');
  }
  {
    const r = await ownerFresh.get('/api/admin/customers?q=' + encodeURIComponent('テスト統合太郎'));
    const found = (r.body.customers || []).find((c) => c.customer_id === 'CT900');
    assert(!!found && found.total_visits === 5, '統合後：残った側の来店回数が合算される（3+2=5）');
  }
  {
    const r = await ownerFresh.get('/api/admin/customers?q=' + encodeURIComponent('てすと統合太郎'));
    assert((r.body.customers || []).length === 0, '統合後：消えた側（CT901）は一覧に出てこない（論理削除）');
  }
  {
    const r = await ownerFresh.get('/api/admin/customers/merge-candidates');
    const stillThere = (r.body.candidates || []).some((c) => c.customerA.customer_id === 'CT901' || c.customerB.customer_id === 'CT901');
    assert(!stillThere, '統合済みの組み合わせは候補一覧に再度出てこない');
  }
  // 見送り（別人）機能の確認：店2の顧客とは別電話番号の組み合わせを新規に作る
  const dismissTel = '09077778888';
  db.prepare(`INSERT INTO customers (store_id, customer_id, realname, phone) VALUES (1, 'CT910', '見送りA', ?)`).run(dismissTel);
  db.prepare(`INSERT INTO customers (store_id, customer_id, realname, phone) VALUES (1, 'CT911', '見送りB', ?)`).run(dismissTel);
  {
    const r = await ownerFresh.postJson('/api/admin/customers/merge-candidates/dismiss', { customerIdA: 'CT910', customerIdB: 'CT911' });
    assert(r.status === 200 && r.body.success === true, '別人として見送りを記録できる');
  }
  {
    const r = await ownerFresh.get('/api/admin/customers/merge-candidates');
    const stillThere = (r.body.candidates || []).some((c) =>
      (c.customerA.customer_id === 'CT910' && c.customerB.customer_id === 'CT911') ||
      (c.customerA.customer_id === 'CT911' && c.customerB.customer_id === 'CT910')
    );
    assert(!stillThere, '見送り済みの組み合わせは候補一覧に再度出てこない');
  }
  {
    const r = await ownerFresh.get('/api/admin/customers?q=' + encodeURIComponent('見送りA'));
    const found = (r.body.customers || []).find((c) => c.customer_id === 'CT910');
    assert(!!found, '見送り後も両方の顧客データはそのまま残る（削除されない）');
  }

  // --------------------------------------------------------------------------
  // 12. 管理画面からの新規予約登録（★2026-09-19追加）
  // --------------------------------------------------------------------------
  console.log('--- 12. 管理画面からの新規予約登録 ---');
  {
    const r = await ownerFresh.postJson('/api/admin/reservations', {
      realname: '電話予約テスト太郎', staffName: '花子', menu: 'フェイシャル', date: '2026-12-15', time: '10:00'
    });
    assert(r.status === 200 && r.body.success === true, '管理画面から新規予約を登録できる');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/reservations', {
      realname: '重複テスト', staffName: '花子', menu: 'x', date: '2026-12-15', time: '10:00'
    });
    assert(r.status === 409 && r.body.isDoubleBooking === true, '同じ日時・担当が既に埋まっていれば409で拒否される');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/reservations', {
      realname: '', staffName: '花子', menu: 'x', date: '2026-12-15', time: '11:00'
    });
    assert(r.status === 400, 'お客様氏名なしでは登録できない');
  }
  {
    for (const t of ['12:00', '13:00', '14:00']) {
      await ownerFresh.postJson('/api/admin/reservations', {
        realname: '上限テスト花子', staffName: '花子', menu: 'x', date: '2026-12-16', time: t
      });
    }
    const r = await ownerFresh.postJson('/api/admin/reservations', {
      realname: '上限テスト花子', staffName: '花子', menu: 'x', date: '2026-12-16', time: '15:00'
    });
    assert(r.status === 200 && r.body.isLimitWarning === true, '確定予約が上限に達していれば警告が返る（この時点では登録しない）');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/reservations', {
      realname: '上限テスト花子', staffName: '花子', menu: 'x', date: '2026-12-16', time: '15:00', ownerOverride: true
    });
    assert(r.status === 200 && r.body.success === true, 'ownerOverride指定で上限警告を無視して登録できる');
  }
  {
    const r = await owner2.get('/api/admin/reservations?from=2026-12-15&to=2026-12-16');
    assert(r.status === 200 && (r.body.reservations || []).length === 0, '他店舗オーナーには管理画面登録した予約が見えない（店舗スコープ確認）');
  }

  // --------------------------------------------------------------------------
  console.log(`\n=== 結果: PASS ${passCount} / FAIL ${failCount} ===`);
  if (failCount > 0) {
    console.log('\n失敗した項目:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  } else {
    console.log('全項目パスしました。');
  }
}

main().catch((e) => {
  console.error('統合テスト実行中に予期しないエラー:', e);
  process.exitCode = 1;
});
