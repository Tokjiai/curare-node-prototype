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
    async putJson(path, data) {
      return this.request(path, {
        method: 'PUT',
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
    // ★2026-09-20更新：以前は一般スタッフのログイン自体を403でブロックしていたが、
    //   スタッフダッシュボード（17章）の実装に伴いログインを解放したため、
    //   ここは200・isOwner:falseになる（オーナー専用/admin/*には別途アクセスできない）。
    //   ★owner1のセッションを上書きしないよう、必ず別セッションで試す
    //   （以前は403で失敗する想定だったためowner1を流用していたが、今は成功するので
    //   流用するとowner1が花子のセッションに変わってしまい、以降のテストが壊れる）
    const hanakoProbe = makeSession();
    const r = await hanakoProbe.postJson('/api/auth/login', { store: '1', pin: '6789' }); // 花子（is_owner=0）
    assert(r.status === 200 && r.body.success === true && r.body.isOwner === false, '一般スタッフPINでもログインでき、isOwner:falseが返る');
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
  // 13. 店舗設定（基本ルール・営業時間帯・休業日/イベント）（★2026-09-19追加）
  // --------------------------------------------------------------------------
  console.log('--- 13. 店舗設定 ---');
  {
    const r = await ownerFresh.get('/api/admin/settings/rules');
    const bedLimit = (r.body.rules || []).find((x) => x.rule_id === 'BED_LIMIT');
    assert(r.status === 200 && !!bedLimit, '基本ルール一覧が取得できる');
  }
  {
    const r = await ownerFresh.request('/api/admin/settings/rules/BED_LIMIT', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: '4' })
    });
    assert(r.status === 200 && r.body.success === true, '基本ルールの値を更新できる');
  }
  {
    const r = await ownerFresh.request('/api/admin/settings/rules/BED_LIMIT', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'abc' })
    });
    assert(r.status === 400, '数値以外の値は拒否される');
  }
  {
    const r = await ownerFresh.request('/api/admin/settings/rules/NOT_EXIST', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: '1' })
    });
    assert(r.status === 404, '存在しないルールIDの更新は404になる');
  }
  {
    const r = await ownerFresh.get('/api/admin/settings/zones');
    const evZone = (r.body.zones || []).find((z) => z.zone_key === 'ev');
    assert(r.status === 200 && !!evZone, '営業時間帯（ゾーン）一覧が取得できる');
  }
  {
    const r = await ownerFresh.request('/api/admin/settings/zones/ev', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startTime: '17:00', endTime: '22:30', isActive: true, fixedTarget: true, fixedStart: '20:00', fixedIntervalMin: 60 })
    });
    assert(r.status === 200 && r.body.success === true, '営業時間帯（夜ゾーン）を更新できる');
  }
  {
    const r = await ownerFresh.request('/api/admin/settings/zones/ev', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startTime: '22:00', endTime: '17:00' })
    });
    assert(r.status === 400, '終了時刻が開始時刻より前の指定は拒否される');
  }
  {
    const r = await owner2.request('/api/admin/settings/zones/ev', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startTime: '10:00', endTime: '11:00' })
    });
    assert(r.status === 404, '他店舗のゾーン設定は更新できない（店舗スコープ確認、店2にはevゾーンが存在しないため404）');
  }
  let createdEventId = null;
  {
    const r = await ownerFresh.postJson('/api/admin/events', {
      title: '統合テスト休業日', date: '2026-12-28', startTime: '09:00', endTime: '23:00', restrictBooking: true
    });
    assert(r.status === 200 && r.body.success === true, '休業日/イベントを追加できる');
    createdEventId = r.body.eventId;
  }
  {
    const r = await ownerFresh.postJson('/api/admin/events', { title: '', date: '2026-12-29', startTime: '09:00', endTime: '10:00' });
    assert(r.status === 400, 'タイトルなしでは追加できない');
  }
  {
    const r = await ownerFresh.get('/api/admin/events?from=2026-12-28&to=2026-12-28');
    const found = (r.body.events || []).some((e) => e.id === createdEventId);
    assert(r.status === 200 && found, '追加したイベントが期間指定の一覧に反映される');
  }
  {
    const r = await owner2.request(`/api/admin/events/${createdEventId}`, { method: 'DELETE' });
    assert(r.status === 404, '他店舗オーナーは他店のイベントを削除できない（店舗スコープ確認）');
  }
  {
    const r = await ownerFresh.request(`/api/admin/events/${createdEventId}`, { method: 'DELETE' });
    assert(r.status === 200 && r.body.success === true, '自店舗のイベントは削除できる');
  }

  // --------------------------------------------------------------------------
  // 14. メニューマスタ（★2026-09-19追加）
  // --------------------------------------------------------------------------
  console.log('--- 14. メニューマスタ ---');
  {
    const r = await ownerFresh.get('/api/admin/settings/menu');
    assert(r.status === 200 && (r.body.items || []).length >= 4, '初期投入した4件のメニューが取得できる');
  }
  {
    const r = await fetch(BASE + '/api/store?store=kurare-kotobuki').then((res) => res.json());
    assert(Array.isArray(r.menuItems) && r.menuItems.length >= 4, 'お客様フォーム用APIにもメニュー一覧が含まれる');
  }
  let newMenuId = null;
  {
    const r = await ownerFresh.postJson('/api/admin/settings/menu', {
      category: 'オプション', name: '統合テストメニュー', durationMin: 30, price: 1500, target: '全員'
    });
    assert(r.status === 200 && r.body.success === true, '新規メニューを追加できる');
    newMenuId = r.body.menuItemId;
  }
  {
    const r = await ownerFresh.postJson('/api/admin/settings/menu', { category: '存在しないカテゴリ', name: 'x', durationMin: 10, price: 0, target: '全員' });
    assert(r.status === 400, '不正なカテゴリは拒否される');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/settings/menu', { category: 'オプション', name: '', durationMin: 10, price: 0, target: '全員' });
    assert(r.status === 400, 'メニュー名なしでは追加できない');
  }
  {
    const r = await ownerFresh.request(`/api/admin/settings/menu/${newMenuId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'オプション', name: '統合テストメニュー（改）', durationMin: 45, price: 2000, target: '全員', isActive: true })
    });
    assert(r.status === 200 && r.body.success === true, 'メニューを編集できる');
  }
  {
    const r = await owner2.request(`/api/admin/settings/menu/${newMenuId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'オプション', name: 'なりすまし', durationMin: 10, price: 0, target: '全員' })
    });
    assert(r.status === 404, '他店舗オーナーは他店のメニューを編集できない（店舗スコープ確認）');
  }
  {
    const r = await ownerFresh.request(`/api/admin/settings/menu/${newMenuId}`, { method: 'DELETE' });
    assert(r.status === 200 && r.body.success === true, 'メニューを削除（非表示化）できる');
  }
  {
    const r = await fetch(BASE + '/api/store?store=kurare-kotobuki').then((res) => res.json());
    const found = r.menuItems.some((m) => m.id === newMenuId);
    assert(!found, '削除（非表示化）したメニューはお客様フォーム用の一覧から消える');
  }
  {
    const r = await ownerFresh.get('/api/admin/settings/menu');
    const found = (r.body.items || []).find((m) => m.id === newMenuId);
    assert(!!found && found.is_active === 0, '削除後も管理画面の一覧にはis_active=0として残っている（物理削除ではない）');
  }
  {
    // ★2026-09-20追加：お客様フォーム用APIが返すメニュー一覧に、カテゴリ「メインメニュー」
    //   以外（施術系オプション／オプション）のシードデータが含まれ、フロント側（app.js）で
    //   メインメニューの択一選択肢とオプションのチェックボックスに正しく分離できる材料が
    //   揃っていることを確認する（以前はカテゴリを区別せず全件を1つのセレクトに
    //   流し込んでいた不具合の修正確認）
    const r = await fetch(BASE + '/api/store?store=kurare-kotobuki').then((res) => res.json());
    const mainItems = r.menuItems.filter((m) => m.category === 'メインメニュー');
    const optItems = r.menuItems.filter((m) => m.category !== 'メインメニュー');
    assert(mainItems.length >= 4, 'お客様フォーム用メニュー一覧にメインメニューが4件以上含まれる');
    assert(optItems.length >= 2 && optItems.every((m) => ['施術系オプション', 'オプション'].includes(m.category)),
      'お客様フォーム用メニュー一覧に施術系オプション／オプションのカテゴリ項目が含まれ、メインメニューとカテゴリで区別できる');
  }

  // --------------------------------------------------------------------------
  // 15. ログイン管理（強制ログアウト）（★2026-09-19追加）
  // --------------------------------------------------------------------------
  console.log('--- 15. ログイン管理（強制ログアウト） ---');
  let kotokoStaffId = null;
  {
    const r = await ownerFresh.get('/api/admin/staff');
    const kotoko = (r.body.staff || []).find((s) => s.name === '寿子');
    kotokoStaffId = kotoko ? kotoko.id : null;
    assert(!!kotokoStaffId, 'スタッフ一覧から寿子（オーナー）のstaffIdが取得できる');
  }
  {
    const r = await ownerFresh.get('/api/admin/sessions/staff-list');
    const kotoko = (r.body.staff || []).find((s) => s.id === kotokoStaffId);
    assert(r.status === 200 && !!kotoko && kotoko.isLoggedIn === true, 'ログイン管理画面用の一覧に、現在ログイン中の寿子がisLoggedIn=trueで含まれる');
  }
  // ownerFresh とは別に、同じ寿子でもう1つログインセッションを作る（複数端末ログインを模す）
  const kotokoOtherDevice = makeSession();
  {
    const r = await kotokoOtherDevice.postJson('/api/auth/login', { store: '1', pin: '5678' });
    assert(r.status === 200 && r.body.success === true, '同じ寿子で別端末からもログインできる（多重ログイン）');
  }
  {
    const r = await kotokoOtherDevice.get('/api/auth/me');
    assert(r.status === 200, '強制ログアウト前は別端末セッションもまだ有効');
  }
  {
    const r = await owner2.postJson('/api/admin/sessions/force-logout', { staffId: kotokoStaffId });
    assert(r.status === 404, '他店舗オーナーは他店のスタッフを強制ログアウトできない（店舗スコープ確認）');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/sessions/force-logout', { staffId: kotokoStaffId });
    assert(r.status === 200 && r.body.success === true && /件/.test(r.body.message), '強制ログアウトが成功する（無効化件数メッセージ付き）');
  }
  {
    const r = await kotokoOtherDevice.get('/api/auth/me');
    assert(r.status === 401, '強制ログアウト後は別端末セッションが無効になっている');
  }
  {
    const r = await ownerFresh.get('/api/auth/me');
    assert(r.status === 401, '強制ログアウトは同じスタッフの全セッション（実行者自身の元セッションも含む）を無効化する');
  }
  // 以降のテストで ownerFresh を使い続けられるよう、再ログインしておく
  {
    const r = await ownerFresh.postJson('/api/auth/login', { store: '1', pin: '5678' });
    assert(r.status === 200 && r.body.success === true, '強制ログアウト後、再ログインすればownerFreshを引き続き使える');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/sessions/force-logout', { staffId: 999999 });
    assert(r.status === 404, '存在しないstaffIdの強制ログアウトは404になる');
  }

  // --------------------------------------------------------------------------
  // 16. 顧客マスタの詳細編集・削除・復元（★2026-09-19追加）
  // --------------------------------------------------------------------------
  console.log('--- 16. 顧客マスタの詳細編集・削除・復元 ---');
  {
    const r = await ownerFresh.request('/api/admin/customers/C0001', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        realname: '田中 美穂（改）', kana: 'タナカ ミホ', phone: '090-1111-2222', totalVisits: 15,
        staffName: '花子', status: 'active', memo: '統合テストで編集', isKeepMember: true, optSupport: true,
        bookingBlocked: false, notifyEnabled: true
      })
    });
    assert(r.status === 200 && r.body.success === true, '顧客情報を編集できる');
  }
  {
    const r = await ownerFresh.get('/api/admin/customers?q=' + encodeURIComponent('田中'));
    const found = (r.body.customers || []).find((c) => c.customer_id === 'C0001');
    assert(!!found && found.realname === '田中 美穂（改）' && found.total_visits === 15 && found.is_keep_member === 1, '編集内容（氏名・来店回数・キープメンバー）が反映される');
  }
  {
    const r = await ownerFresh.request('/api/admin/customers/C0001', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realname: '不正電話テスト', phone: '123' })
    });
    assert(r.status === 400, '不正な形式の電話番号は拒否される');
  }
  {
    const r = await ownerFresh.request('/api/admin/customers/C0001', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realname: '' })
    });
    assert(r.status === 400, '氏名なしでは編集できない');
  }
  {
    const r = await owner2.request('/api/admin/customers/C0001', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realname: 'なりすまし編集' })
    });
    assert(r.status === 404, '他店舗オーナーは他店の顧客を編集できない（店舗スコープ確認）');
  }
  {
    const r = await ownerFresh.request('/api/admin/customers/C0002', { method: 'DELETE' });
    assert(r.status === 200 && r.body.success === true, '顧客を削除（論理削除）できる');
  }
  {
    const r = await ownerFresh.get('/api/admin/customers?q=' + encodeURIComponent('佐藤'));
    const found = (r.body.customers || []).some((c) => c.customer_id === 'C0002');
    assert(!found, '削除した顧客は通常の一覧（includeDeletedなし）には出てこない');
  }
  {
    const r = await ownerFresh.get('/api/admin/customers?q=' + encodeURIComponent('佐藤') + '&includeDeleted=1');
    const found = (r.body.customers || []).find((c) => c.customer_id === 'C0002');
    assert(!!found && found.is_deleted === 1, 'includeDeleted=1を指定すると削除済みの顧客も一覧に出る（is_deleted=1）');
  }
  {
    const r = await owner2.request('/api/admin/customers/C0002/restore', { method: 'POST' });
    assert(r.status === 404, '他店舗オーナーは他店の顧客を復元できない（店舗スコープ確認）');
  }
  {
    const r = await ownerFresh.request('/api/admin/customers/C0002/restore', { method: 'POST' });
    assert(r.status === 200 && r.body.success === true, '削除した顧客を復元できる');
  }
  {
    const r = await ownerFresh.get('/api/admin/customers?q=' + encodeURIComponent('佐藤'));
    const found = (r.body.customers || []).some((c) => c.customer_id === 'C0002');
    assert(found, '復元した顧客は通常の一覧に再び出てくる');
  }
  {
    const r = await ownerFresh.request('/api/admin/customers/C9999', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realname: 'テスト' })
    });
    assert(r.status === 404, '存在しない顧客IDの編集は404になる');
  }

  // --------------------------------------------------------------------------
  // 17. スタッフダッシュボード（GAS版staff_dashboard.htmlの移植：一般スタッフの
  //     ログイン解放・自分の予約確認・自分のシフト確認）
  // --------------------------------------------------------------------------
  console.log('--- 17. スタッフダッシュボード ---');
  const hanako = makeSession();
  {
    const r = await hanako.postJson('/api/auth/login', { store: '1', pin: '6789' }); // 花子（is_owner=0）
    assert(r.status === 200 && r.body.success === true && r.body.staffName === '花子', '一般スタッフ（花子）がログインできる');
  }
  {
    const r = await hanako.get('/api/admin/customers');
    assert(r.status === 401, '一般スタッフはログイン済みでもオーナー専用の/api/admin/*にはアクセスできない');
  }
  {
    // ★他のテスト区画（3章の二重予約防止テスト等）も花子名義のダミー予約を
    //   同じ14日以内の日付に作ることがあるため、件数の完全一致ではなく
    //   「db/init.jsが投入した花子の2件（田中美穂・佐藤由紀）が両方含まれていて、
    //   かつ全件が花子名義（他スタッフの予約が紛れ込んでいない）」ことを確認する
    const r = await hanako.get('/api/staff/reservations');
    const rows = r.body.reservations || [];
    const names = rows.map((x) => x.realname);
    const allHanako = rows.every((x) => x.staff_name === '花子');
    assert(
      r.status === 200 && allHanako && names.includes('田中 美穂') && names.includes('佐藤 由紀'),
      '/api/staff/reservationsは自分（花子）が担当の予約だけを返す（他スタッフの予約は含まない）'
    );
  }
  {
    const r = await hanako.get('/api/staff/shifts');
    const rows = r.body.shifts || [];
    const allHanako = rows.every((s) => s.staff_name === '花子');
    assert(r.status === 200 && rows.length > 0 && allHanako, '/api/staff/shiftsは自分（花子）のシフトだけを返す（他スタッフのシフトは含まない）');
  }
  {
    // オーナー（寿子）自身も同じ/api/staff/*で自分の予約・シフトを見られる
    // （寿子はday5に1件のみ予約を持つ、花子の2件とは別）
    const r = await ownerFresh.get('/api/staff/reservations');
    const rows = r.body.reservations || [];
    assert(
      r.status === 200 && rows.length === 1 && rows[0].realname === '鈴木 花' && rows[0].staff_name === '寿子',
      'オーナー自身も/api/staff/reservationsで自分の予約（1件・花子分とは別）だけを見られる'
    );
  }
  {
    const anonStaff = makeSession();
    const r = await anonStaff.get('/api/staff/reservations');
    assert(r.status === 401, '未ログインでは/api/staff/*も401になる');
  }

  // --------------------------------------------------------------------------
  // 18. メッセージ設定（GAS版owner_ui.htmlの「メッセージ設定」パネル・
  //     admin_ui_functions.gsのgetMessageSettings/saveMessageSettingsの移植）
  // --------------------------------------------------------------------------
  console.log('--- 18. メッセージ設定 ---');
  {
    const r = await anon.get('/api/admin/settings/messages');
    assert(r.status === 401, '未ログインではメッセージ設定を取得できない');
  }
  {
    const r = await ownerFresh.get('/api/admin/settings/messages');
    assert(r.status === 200 && Array.isArray(r.body.items) && r.body.items.length === 8, 'メッセージ設定は8キー（あいさつ＋予約確認4種＋変更＋キャンセル＋リマインド）返る');
    const welcome = r.body.items.find((it) => it.key === 'welcome');
    assert(!!welcome && welcome.body.includes('{NICKNAME}'), '初期状態は未編集のためデフォルト文言（{NICKNAME}を含むあいさつ文）が返る');
  }
  {
    const r = await ownerFresh.putJson('/api/admin/settings/messages', {
      items: [
        { key: 'confirm_add', body: 'ご予約ありがとうございます！\n{DATE} {TIME}\n{MENU}（担当：{STAFF}）', closing: '当日のご来店をお待ちしております。' }
      ]
    });
    assert(r.status === 200 && r.body.success === true, 'メッセージテンプレートを保存できる');
  }
  {
    const r = await ownerFresh.get('/api/admin/settings/messages');
    const item = r.body.items.find((it) => it.key === 'confirm_add');
    assert(!!item && item.body.includes('ご予約ありがとうございます') && item.closing === '当日のご来店をお待ちしております。', '保存した内容が次回取得時に反映される（未編集の他キーはデフォルトのまま）');
    const cancelItem = r.body.items.find((it) => it.key === 'cancel');
    assert(!!cancelItem && cancelItem.body.includes('キャンセルしました'), '編集していない他のキーは引き続きデフォルト文言のまま');
  }
  {
    const r = await ownerFresh.putJson('/api/admin/settings/messages', { items: [{ key: 'cancel', body: '', closing: '' }] });
    assert(r.status === 400 && /本文を入力してください/.test(r.body.message), '本文が空のテンプレートは保存できない（バリデーション）');
  }
  {
    const longBody = 'あ'.repeat(501);
    const r = await ownerFresh.putJson('/api/admin/settings/messages', { items: [{ key: 'remind', body: longBody, closing: '' }] });
    assert(r.status === 400 && /500文字以内/.test(r.body.message), '本文が500文字を超えるテンプレートは保存できない（バリデーション）');
  }
  {
    // store2（岩田町店）オーナーがstore1のconfirm_addを保存しても、store1側には影響しない（店舗スコープ確認）
    await owner2.putJson('/api/admin/settings/messages', {
      items: [{ key: 'confirm_add', body: '岩田町店だけの予約確認メッセージです', closing: '' }]
    });
    const r1 = await ownerFresh.get('/api/admin/settings/messages');
    const item1 = r1.body.items.find((it) => it.key === 'confirm_add');
    assert(item1.body.includes('ご予約ありがとうございます'), '他店舗オーナーがメッセージを保存してもstore1側のテンプレートは変わらない（店舗スコープ確認）');
  }

  // --------------------------------------------------------------------------
  // 19. 受付ルール・注意書き（GAS版owner_ui.htmlの「受付ルール・注意書き」パネル・
  //     admin_ui_functions.gsのgetRule2Settings/saveRule2Info/saveRule2Noticeの移植）
  // --------------------------------------------------------------------------
  console.log('--- 19. 受付ルール・注意書き ---');
  {
    const r = await anon.get('/api/admin/settings/rule2');
    assert(r.status === 401, '未ログインでは受付ルール・注意書きを取得できない');
  }
  {
    const r = await ownerFresh.get('/api/admin/settings/rule2');
    assert(r.status === 200 && typeof r.body.info.phone === 'string' && Array.isArray(r.body.notices), '基本情報（電話番号・予約受付期間）と注意書き一覧が取得できる');
    assert(r.body.notices.length >= 2, 'seed投入した注意書き（全員・初回むけの2件）が含まれる');
  }
  {
    const r = await ownerFresh.putJson('/api/admin/settings/rule2/info', { bookingPeriodInfoDays: 21 });
    assert(r.status === 200 && r.body.success === true, '予約受付期間（お知らせ用）を更新できる');
    const r2 = await ownerFresh.get('/api/admin/settings/rule2');
    assert(r2.body.info.bookingPeriodInfoDays === 21, '更新した予約受付期間が次回取得時に反映される');
  }
  {
    const r = await ownerFresh.putJson('/api/admin/settings/rule2/info', { bookingPeriodInfoDays: 99 });
    assert(r.status === 400 && /0〜30の範囲/.test(r.body.message), '予約受付期間は0〜30の範囲外だと拒否される（バリデーション）');
  }
  let addedNoticeId = null;
  {
    const r = await ownerFresh.postJson('/api/admin/settings/rule2/notices', { target: 'リピーター', text: '次回のご来店もお待ちしております' });
    assert(r.status === 200 && r.body.success === true && !!r.body.noticeId, '新しい注意書きを追加できる');
    addedNoticeId = r.body.noticeId;
  }
  {
    const r = await ownerFresh.postJson('/api/admin/settings/rule2/notices', { target: '存在しない対象', text: 'テスト' });
    assert(r.status === 400 && /対象の指定が不正/.test(r.body.message), '不正な対象の注意書きは追加できない（バリデーション）');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/settings/rule2/notices', { target: '全員', text: '' });
    assert(r.status === 400 && /文言を入力/.test(r.body.message), '文言が空の注意書きは追加できない（バリデーション）');
  }
  {
    const r = await ownerFresh.putJson('/api/admin/settings/rule2/notices/' + addedNoticeId, { target: 'リピーター', text: '次回のご来店を心よりお待ちしております', active: false });
    assert(r.status === 200 && r.body.success === true, '追加した注意書きを編集（無効化含む）できる');
  }
  {
    const r = await owner2.putJson('/api/admin/settings/rule2/notices/' + addedNoticeId, { target: '全員', text: 'なりすまし', active: true });
    assert(r.status === 404, '他店舗オーナーは他店の注意書きを編集できない（店舗スコープ確認）');
  }
  {
    // 公開の/api/storeには「全員」向けの有効な注意書きのみが反映される（初回/リピーター向けは対象外）
    const r = await fetch(BASE + '/api/store?store=1').then((res) => res.json());
    assert(Array.isArray(r.notices) && r.notices.some((t) => t.includes('当日キャンセル')), '公開の/api/storeには「全員」向けの有効な注意書きが反映される');
    assert(!r.notices.some((t) => t.includes('初めてご来店')), '「初回」向けの注意書きは公開の/api/storeには含まれない（このプロトタイプの簡略化仕様）');
    assert(r.store.phone === '097-000-0000', '公開の/api/storeに店舗の電話番号が含まれる');
  }

  // --------------------------------------------------------------------------
  // 20. 仮予約の確定操作（GAS版dashboard_functions.gsのconfirmReservation相当）
  // --------------------------------------------------------------------------
  console.log('--- 20. 仮予約の確定操作 ---');
  let provisionalId = null;
  {
    const d = new Date(); d.setDate(d.getDate() + 30);
    const dateStr = d.toISOString().slice(0, 10);
    const r = await ownerFresh.postJson('/api/admin/reservations', {
      realname: '仮予約統合テスト', staffName: '花子', menu: 'テストメニュー', date: dateStr, time: '13:00', provisional: true
    });
    assert(r.status === 200 && r.body.success === true && /仮予約として登録/.test(r.body.message), '「仮予約として登録する」チェックを付けて新規予約を追加すると仮予約状態で登録される');
    provisionalId = r.body.reservationId;
  }
  {
    const r = await ownerFresh.get('/api/admin/reservations?from=2026-01-01&to=2027-12-31');
    const row = (r.body.reservations || []).find((x) => x.id === provisionalId);
    assert(!!row && row.status === '仮予約', '登録直後の予約はstatus=仮予約で取得できる');
  }
  {
    const r = await owner2.postJson('/api/admin/reservations/' + provisionalId + '/confirm', {});
    assert(r.status === 404, '他店舗オーナーは他店の仮予約を確定できない（店舗スコープ確認）');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/reservations/' + provisionalId + '/confirm', {});
    assert(r.status === 200 && r.body.success === true, '担当スタッフが設定済みの仮予約は確定操作が成功する');
  }
  {
    const r = await ownerFresh.get('/api/admin/reservations?from=2026-01-01&to=2027-12-31');
    const row = (r.body.reservations || []).find((x) => x.id === provisionalId);
    assert(!!row && row.status === '確定', '確定操作後はstatus=確定に変わる');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/reservations/' + provisionalId + '/confirm', {});
    assert(r.status === 400 && /すでに確定済み/.test(r.body.message), 'すでに確定済みの予約を再度確定操作しようとすると拒否される');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/reservations/999999/confirm', {});
    assert(r.status === 404, '存在しない予約IDの確定操作は404になる');
  }
  {
    const d = new Date(); d.setDate(d.getDate() + 31);
    const dateStr = d.toISOString().slice(0, 10);
    const r = await ownerFresh.postJson('/api/admin/reservations', {
      realname: '担当未定テスト', staffName: '未定', menu: 'テストメニュー', date: dateStr, time: '13:00', provisional: true
    });
    const confirmR = await ownerFresh.postJson('/api/admin/reservations/' + r.body.reservationId + '/confirm', {});
    assert(confirmR.status === 400 && /担当スタッフが未定/.test(confirmR.body.message), '担当スタッフが「未定」のままの仮予約は確定操作できない（GAS版と同じ安全策）');
  }

  // --------------------------------------------------------------------------
  // 21. 月間カレンダー（GAS版staff_dashboard.htmlのgetMonthlyDateCounts_/
  //     getMonthlyPendingStatus_相当。スタッフ用ダッシュボードの📆月間カレンダータブ）
  // --------------------------------------------------------------------------
  console.log('--- 21. 月間カレンダー ---');
  const hanakoFresh = makeSession();
  await hanakoFresh.postJson('/api/auth/login', { store: '1', pin: '6789' }); // 花子（is_owner=0）
  {
    const r = await fetch(BASE + '/api/staff/reservations/monthly?month=2026-09').then((res) => res.status);
    assert(r === 401, '未ログインでは月間カレンダーAPIは401になる');
  }
  {
    // ★シードデータの「4日後」はシード投入時点の「今日」基準の相対日付のため、
    //   実行日によって暦日がずれる。ハードコードせず、実行時に動的計算する
    //   （2026-09-21時点で09-24固定だったものが翌日以降ずれて失敗していたため修正）。
    const seedDay = new Date(); seedDay.setDate(seedDay.getDate() + 4);
    const seedDateStr = seedDay.toISOString().slice(0, 10);
    const seedMonthStr = seedDateStr.slice(0, 7);
    const r = await hanakoFresh.get('/api/staff/reservations/monthly?month=' + seedMonthStr);
    assert(r.status === 200 && r.body.month === seedMonthStr, '月間カレンダーAPIが200で該当月のデータを返す');
    assert(r.body.counts[seedDateStr] && r.body.counts[seedDateStr].count === 2, 'シードデータの4日後（2件予約）の日付が件数2で集計される（キャンセルは既に別テストで除外確認済みのロジックを流用）');
    assert(r.body.counts[seedDateStr].pending === false, '通常予約のみの日はpending=false');
  }
  {
    // monthパラメータ省略時は当月がデフォルトになる（GAS版はページ表示時の当月起点と同等）
    const r = await hanakoFresh.get('/api/staff/reservations/monthly');
    assert(r.status === 200 && typeof r.body.month === 'string' && /^\d{4}-\d{2}$/.test(r.body.month), 'monthパラメータ省略時も当月のデータがデフォルトで返る');
  }
  {
    // 仮予約を1件追加すると、その日のpendingフラグがtrueになる
    const d = new Date(); d.setDate(d.getDate() + 40);
    const dateStr = d.toISOString().slice(0, 10);
    const monthStr = dateStr.slice(0, 7);
    const addR = await ownerFresh.postJson('/api/admin/reservations', {
      realname: '月間カレンダー仮予約テスト', staffName: '花子', menu: 'テストメニュー', date: dateStr, time: '14:00', provisional: true
    });
    assert(addR.status === 200, '月間カレンダーpendingテスト用の仮予約が登録できる');
    const r = await hanakoFresh.get('/api/staff/reservations/monthly?month=' + monthStr);
    assert(r.status === 200 && r.body.counts[dateStr] && r.body.counts[dateStr].pending === true, '仮予約が含まれる日はpending=trueになる');
  }
  {
    // 自分（花子）以外が担当の予約は、花子の月間カレンダーには集計されない（既存の週次タブと同じ本人限定スコープ）
    const d = new Date(); d.setDate(d.getDate() + 41);
    const dateStr = d.toISOString().slice(0, 10);
    const monthStr = dateStr.slice(0, 7);
    await ownerFresh.postJson('/api/admin/reservations', {
      realname: '他スタッフ担当テスト', staffName: 'ことこ', menu: 'テストメニュー', date: dateStr, time: '14:00'
    });
    const r = await hanakoFresh.get('/api/staff/reservations/monthly?month=' + monthStr);
    assert(r.status === 200 && !r.body.counts[dateStr], '他スタッフ担当の予約は自分の月間カレンダーに集計されない（本人担当分のみのスコープ）');
  }

  // --------------------------------------------------------------------------
  // 22. 日次メンテナンス（GAS版コード.gs dailyProcessAll_のupdateExecutedFlags_/
  //     updateVisitCounts_相当。オーナー管理画面の「日次メンテナンスを今すぐ実行」）
  // --------------------------------------------------------------------------
  console.log('--- 22. 日次メンテナンス ---');
  {
    const r = await owner2.postJson('/api/admin/maintenance/run-daily', {});
    assert(r.status === 200 && r.body.success === true, '未ログインではなくセッションがあれば実行できる（店舗スコープは以降の項目で確認）');
  }
  // ★seed投入済みのC0001は初期total_visits=12（過去のdone=1実績なしの数値）のため、
  //   このテストではまず0にリセットしてから、実際に作った完了予約1件で1に増える
  //   ことを確認する（再集計の「増加分」自体を検証するため、seedの数値に依存しない）
  db.prepare(`UPDATE customers SET total_visits = 0 WHERE store_id = 1 AND customer_id = 'C0001'`).run();
  let pastResId = null;
  {
    // 過去日・customer_id付き・未完了(done=0)の予約を1件作成
    const d = new Date(); d.setDate(d.getDate() - 5);
    const dateStr = d.toISOString().slice(0, 10);
    const r = await ownerFresh.postJson('/api/admin/reservations', {
      realname: '日次メンテナンステスト', staffName: '花子', menu: 'テストメニュー', date: dateStr, time: '13:00', customerId: 'C0001'
    });
    assert(r.status === 200 && r.body.success === true, '過去日・顧客ID付きのテスト予約を登録できる（メンテナンス対象データの準備）');
    pastResId = r.body.reservationId;
  }
  {
    const row = db.prepare('SELECT done FROM reservations WHERE id = ?').get(pastResId);
    assert(row.done === 0, '登録直後は完了（done）フラグが0のまま（自動では立たない）');
  }
  const visitsBefore = db.prepare(`SELECT total_visits FROM customers WHERE store_id = 1 AND customer_id = 'C0001'`).get().total_visits;
  {
    const r = await ownerFresh.postJson('/api/admin/maintenance/run-daily', {});
    assert(r.status === 200 && r.body.success === true && r.body.executedUpdated >= 1,
      '日次メンテナンス実行で①過去日の予約が1件以上「完了」扱いに更新される');
  }
  {
    const row = db.prepare('SELECT done FROM reservations WHERE id = ?').get(pastResId);
    assert(row.done === 1, 'メンテナンス実行後、対象の予約はdone=1になる');
  }
  {
    const visitsAfter = db.prepare(`SELECT total_visits FROM customers WHERE store_id = 1 AND customer_id = 'C0001'`).get().total_visits;
    assert(visitsAfter > visitsBefore, '②完了予約の再集計により、対象顧客（C0001）のtotal_visitsが増加する');
  }
  {
    // 2回目の実行では既にdone=1・total_visitsも反映済みのため、対象0件（冪等性の確認）
    const r = await ownerFresh.postJson('/api/admin/maintenance/run-daily', {});
    assert(r.status === 200 && r.body.executedUpdated === 0, '同じ予約に対して2回目のメンテナンス実行では①の対象が0件になる（冪等）');
  }
  {
    // total_visitsを手動で意図的に大きい値にしておくと、再集計されても減らされない
    db.prepare(`UPDATE customers SET total_visits = 9999 WHERE store_id = 1 AND customer_id = 'C0001'`).run();
    const r = await ownerFresh.postJson('/api/admin/maintenance/run-daily', {});
    const visitsAfter = db.prepare(`SELECT total_visits FROM customers WHERE store_id = 1 AND customer_id = 'C0001'`).get().total_visits;
    assert(r.status === 200 && visitsAfter === 9999, '手動で多めに設定された来店回数は、再集計によって減らされない（GAS版と同じ安全策）');
  }
  {
    // キャンセル済みの過去日予約は完了扱いにならない
    const d = new Date(); d.setDate(d.getDate() - 6);
    const dateStr = d.toISOString().slice(0, 10);
    const addR = await ownerFresh.postJson('/api/admin/reservations', {
      realname: 'キャンセル済みメンテナンステスト', staffName: '花子', menu: 'テストメニュー', date: dateStr, time: '10:00'
    });
    await ownerFresh.request(`/api/admin/reservations/${addR.body.reservationId}`, { method: 'DELETE' });
    await ownerFresh.postJson('/api/admin/maintenance/run-daily', {});
    const row = db.prepare('SELECT done FROM reservations WHERE id = ?').get(addR.body.reservationId);
    assert(row.done === 0, 'キャンセル済みの過去日予約はメンテナンスの完了フラグ更新対象にならない');
  }

  // --------------------------------------------------------------------------
  // 23. LINE Webhook：友だち追加・スタンプ・予約キーワード返信
  //     （GAS版webhook_handler.gsのhandleFollow_/handleStickerMessage_/
  //      handleTextMessage_の移植）
  // --------------------------------------------------------------------------
  console.log('--- 23. LINE Webhook（友だち追加・スタンプ・予約キーワード） ---');
  const anonWebhook = makeSession();
  {
    // トライアルプラン（lineNotify対象外）のままでも、顧客登録自体は行われる
    const before = db.prepare(`SELECT COUNT(*) AS c FROM customers WHERE store_id = 1 AND user_id = 'Utest_webhook_001'`).get().c;
    assert(before === 0, 'テスト対象のuserIdはまだ顧客マスタに存在しない（前提確認）');
    const r = await anonWebhook.postJson('/webhook/line', {
      destination: 'TEST_DEST',
      events: [{ type: 'follow', replyToken: 'itest-reply-1', source: { type: 'user', userId: 'Utest_webhook_001' }, timestamp: Date.now() }]
    });
    assert(r.status === 200, '友だち追加イベントのWebhookは200を返す');
    const row = db.prepare(`SELECT customer_id, status FROM customers WHERE store_id = 1 AND user_id = 'Utest_webhook_001'`).get();
    assert(!!row && row.status === 'inactive', '友だち追加により顧客マスタへ自動登録される（本名未確定のため非アクティブ分類）');
  }
  {
    // 同じuserIdでもう一度follow：新規行が増えず、既存の顧客IDのまま（冪等性）
    const countBefore = db.prepare(`SELECT COUNT(*) AS c FROM customers WHERE store_id = 1 AND user_id = 'Utest_webhook_001'`).get().c;
    await anonWebhook.postJson('/webhook/line', {
      destination: 'TEST_DEST',
      events: [{ type: 'follow', replyToken: 'itest-reply-2', source: { type: 'user', userId: 'Utest_webhook_001' }, timestamp: Date.now() }]
    });
    const countAfter = db.prepare(`SELECT COUNT(*) AS c FROM customers WHERE store_id = 1 AND user_id = 'Utest_webhook_001'`).get().c;
    assert(countBefore === 1 && countAfter === 1, '同じuserIdで2回目の友だち追加が来ても、顧客マスタの行が重複して増えない（冪等）');
  }
  {
    // スタンプ・予約キーワードのWebhookも200で受理される（実送信はシミュレーションのため、ここではエラーにならないことを確認）
    const r1 = await anonWebhook.postJson('/webhook/line', {
      destination: 'TEST_DEST',
      events: [{ type: 'message', message: { type: 'sticker', stickerId: 1, packageId: 1 }, replyToken: 'itest-reply-3', source: { type: 'user', userId: 'Utest_webhook_001' }, timestamp: Date.now() }]
    });
    assert(r1.status === 200, 'スタンプ受信のWebhookは200を返す（定型返信をシミュレーション送信）');
    const r2 = await anonWebhook.postJson('/webhook/line', {
      destination: 'TEST_DEST',
      events: [{ type: 'message', message: { type: 'text', text: 'エステ予約したい' }, replyToken: 'itest-reply-4', source: { type: 'user', userId: 'Utest_webhook_001' }, timestamp: Date.now() }]
    });
    assert(r2.status === 200, '「エステ予約したい」キーワードのWebhookは200を返す（予約リンクをシミュレーション送信）');
    const r3 = await anonWebhook.postJson('/webhook/line', {
      destination: 'TEST_DEST',
      events: [{ type: 'message', message: { type: 'text', text: '関係ないメッセージ' }, replyToken: 'itest-reply-5', source: { type: 'user', userId: 'Utest_webhook_001' }, timestamp: Date.now() }]
    });
    assert(r3.status === 200, 'キーワード不一致のテキストメッセージも200を返す（無反応でエラーにはならない）');
  }
  {
    // プランをLINE連携プランに切り替えると、あいさつメッセージが実際に組み立てられる経路が通る
    // （実送信はトークン未設定のためシミュレーションになるが、テンプレート取得〜返信呼び出しまで
    //   例外なく完走することを確認する）
    await ownerFresh.postJson('/api/admin/plan', { plan: 'line' });
    const r = await anonWebhook.postJson('/webhook/line', {
      destination: 'TEST_DEST',
      events: [{ type: 'follow', replyToken: 'itest-reply-6', source: { type: 'user', userId: 'Utest_webhook_002' }, timestamp: Date.now() }]
    });
    assert(r.status === 200, 'LINE連携プランでの友だち追加も200を返す（あいさつメッセージ組み立て〜送信呼び出しが例外なく完走する）');
    await ownerFresh.postJson('/api/admin/plan', { plan: 'trial' }); // 後続テストに影響しないよう戻す
  }

  // --------------------------------------------------------------------------
  // 24. LINE連携設定（GET/PUT /api/admin/settings/line、店舗設定「LINE連携設定」パネル）
  //     （v28で実装したWebhook機能を実際のLINE公式アカウントに接続する準備として、
  //      チャネルアクセストークン／チャネルシークレットを管理画面から入力できるようにした）
  // --------------------------------------------------------------------------
  console.log('--- 24. LINE連携設定 ---');
  {
    const r = await fetch(BASE + '/api/admin/settings/line').then((res) => res.status);
    assert(r === 401, '未ログインではLINE連携設定を取得できない');
  }
  {
    const r = await ownerFresh.get('/api/admin/settings/line');
    assert(
      r.status === 200 && r.body.customerChannelTokenSet === false && r.body.staffChannelSecretSet === false,
      '初期状態はチャネルアクセストークン・チャネルシークレットともに未設定として返る'
    );
  }
  {
    const r = await ownerFresh.putJson('/api/admin/settings/line', {});
    assert(r.status === 400, '両方とも空欄では保存できない（バリデーション）');
  }
  {
    const r = await ownerFresh.putJson('/api/admin/settings/line', { customerChannelToken: 'test-token-abcd1234' });
    assert(r.status === 200 && r.body.success === true, 'チャネルアクセストークンを保存できる');
  }
  {
    const r = await ownerFresh.get('/api/admin/settings/line');
    assert(
      r.status === 200 && r.body.customerChannelTokenSet === true && r.body.customerChannelTokenHint === '••••••••1234',
      '保存したトークンは設定済み・末尾4文字のヒント付きで返る（平文の全体は返さない）'
    );
    assert(r.body.staffChannelSecretSet === false, 'トークンのみ保存してもチャネルシークレットは未設定のまま');
  }
  {
    const r = await ownerFresh.putJson('/api/admin/settings/line', { staffChannelSecret: 'my-test-secret-xyz' });
    assert(r.status === 200 && r.body.success === true, 'チャネルシークレットを別途保存できる（トークンは上書きされない）');
    const r2 = await ownerFresh.get('/api/admin/settings/line');
    assert(
      r2.body.customerChannelTokenSet === true && r2.body.staffChannelSecretSet === true,
      'トークン・シークレットの両方が設定済みとして返る'
    );
  }
  {
    const r = await owner2.putJson('/api/admin/settings/line', { customerChannelToken: 'store2-token-value' });
    assert(r.status === 200, '岩田町店オーナーも自店のLINE連携設定を保存できる');
    const r2 = await ownerFresh.get('/api/admin/settings/line');
    assert(
      r2.body.customerChannelTokenHint === '••••••••1234',
      '他店舗オーナーの保存はstore1側のトークンに影響しない（店舗スコープ確認）'
    );
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
