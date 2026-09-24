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
const engine = require('../lib/reservationEngine'); // ★44章（常設スケジューラ）のgetRuleValue_直接呼び出し用
const { getRuleHour } = require('../lib/scheduler'); // ★44章：スケジューラのエクスポート関数を直接テスト

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
    },
    async del(path) {
      return this.request(path, { method: 'DELETE' });
    },
    // ★2026-09-24追加：ログインがGAS版と同じ「名前タイルで本人を選ぶ→PIN」の2段階に
    //   なったため、画面と同じ手順（①タイル一覧を取得→②名前からstaffIdを特定→
    //   ③staffId＋PINで送信）でログインする
    async loginAs(store, staffName, pin) {
      const list = await this.get('/api/auth/login-staff?store=' + encodeURIComponent(store));
      const tile = ((list.body && list.body.staff) || []).find((t) => t.name === staffName);
      if (!tile) return { status: 404, body: { success: false, message: 'タイルが見つかりません: ' + staffName } };
      return this.postJson('/api/auth/login', { staffId: tile.id, pin, store });
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
    const r = await owner1.loginAs('1', '寿子', '9999');
    assert(r.status === 401, '誤ったPINでのログインは401になる（正しいPINと誤認しない）');
  }
  {
    const r = await owner1.loginAs('1', '寿子', '5678');
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
    const r = await hanakoProbe.loginAs('1', '花子', '6789'); // 花子（is_owner=0）
    assert(r.status === 200 && r.body.success === true && r.body.isOwner === false, '一般スタッフPINでもログインでき、isOwner:falseが返る');
  }

  // --------------------------------------------------------------------------
  // 2. 複数店舗のデータ分離（★今回の目玉：store_idによる分離が本当に効くか）
  // --------------------------------------------------------------------------
  console.log('--- 2. 複数店舗のデータ分離 ---');
  const owner2 = makeSession();
  {
    const r = await owner2.loginAs('iwatamachi-test', '岩田町オーナー', '4321');
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
    // ★2026-09-23更新：予約上限チェックはstatus='確定'の予約のみを数える仕様（GAS版と同じ、
    //   lib/reservationEngine.jsのcheckCustomerReservationLimit参照）。以前はcustomerId
    //   'ITEST02'（顧客マスタ未登録＝架空ID）で送っており、お客様フォームからの予約は常に
    //   status='確定'でINSERTされていたため上限判定が機能していたが、★お客様予約フォームの
    //   キープメンバー／初めての方／既存お客様の出し分け機能追加により、customerIdが顧客
    //   マスタに存在しない場合は常に「仮予約」扱いになった（GAS版submitCustomerBooking_body_
    //   の仕様どおり）。そのため、確実に「確定」扱いになるキープメンバー（担当者指名あり）
    //   のC0006（seedデータ）を使うよう変更した。
    const base = new Date(); base.setDate(base.getDate() + 20);
    let warningSeen = false;
    for (let i = 0; i < 4; i++) {
      const d = new Date(base); d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      const r = await fetch(BASE + '/api/reservations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store: '1', realname: '統合テスト花子', staffName: '花子', menu: 'テストメニュー',
          date: dateStr, time: '15:00', customerId: 'C0006'
        })
      }).then((res) => res.json());
      if (i < 3) {
        assert(r.success === true && r.status === '確定', `${i + 1}件目の予約は正常に登録できる（キープメンバー＋担当指名のため確定扱い）`);
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
  await ownerFresh.loginAs('1', '寿子', '5678');
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
    // ★2026-09-23追加：顧客台帳の統合候補カードに「一致理由・電話番号・来店回数」を
    //   表示できるよう、APIレスポンスに必要なフィールドが揃っていることを確認
    //   （社長よりGAS版customer_view.htmlとの視野性比較の依頼で見つかったギャップ）
    assert(!!ct900Candidate.reason, '統合候補に一致理由（reason）が含まれる');
    assert(!!ct900Candidate.phone, '統合候補に突合した電話番号（phone）が含まれる');
    assert(typeof ct900Candidate.customerA.total_visits === 'number' && typeof ct900Candidate.customerB.total_visits === 'number', '統合候補の両顧客に来店回数（total_visits）が含まれる');
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
    const r = await kotokoOtherDevice.loginAs('1', '寿子', '5678');
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
    const r = await ownerFresh.loginAs('1', '寿子', '5678');
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
    const r = await hanako.loginAs('1', '花子', '6789'); // 花子（is_owner=0）
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
    // ★2026-09-23仕様変更：GAS版getWeeklyReservationsと同じく、オーナーは/api/staff/reservationsで
    //   全員分の予約を見られる（以前は本人分だけ）。寿子自身の1件と花子の2件の両方が含まれる
    const r = await ownerFresh.get('/api/staff/reservations');
    const rows = r.body.reservations || [];
    const names = rows.map((x) => x.realname);
    assert(
      r.status === 200 && names.includes('鈴木 花') && names.includes('田中 美穂') && names.includes('佐藤 由紀'),
      'オーナーは/api/staff/reservationsで全員分の予約（自分の担当＋花子の担当）を見られる（GAS版と同じ）'
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
    // ★2026-09-23更新：GAS版getRule2Notices_の移植により、公開の/api/storeは顧客区分
    //   （target）に応じた出し分けを行うようになった。cid未指定時はGAS版と同じくtarget:'new'
    //   がデフォルトのため、「全員」に加えて「初回」向けの注意書きも含まれる（「リピーター」
    //   向けは含まれない）。
    const r = await fetch(BASE + '/api/store?store=1').then((res) => res.json());
    assert(Array.isArray(r.notices) && r.notices.some((t) => t.includes('当日キャンセル')), '公開の/api/storeには「全員」向けの有効な注意書きが反映される');
    assert(r.notices.some((t) => t.includes('初めてご来店')), 'cid未指定時（target:new扱い）は「初回」向けの注意書きも公開の/api/storeに含まれる');
    assert(!r.notices.some((t) => t.includes('メンバー特典')), 'cid未指定時（target:new扱い）は「リピーター」向けの注意書きは公開の/api/storeに含まれない');
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
  await hanakoFresh.loginAs('1', '花子', '6789'); // 花子（is_owner=0）
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
  {
    // ★2026-09-22追加：③古いキャンセル予約の削除（GAS版deleteCancelledReservations相当）
    // CANCEL_DELETE_DAYS（デフォルト60日）より新しいキャンセル予約は削除されない
    const dRecent = new Date(); dRecent.setDate(dRecent.getDate() - 5);
    const recentR = await ownerFresh.postJson('/api/admin/reservations', {
      realname: '直近キャンセルテスト', staffName: '花子', menu: 'テストメニュー', date: dRecent.toISOString().slice(0, 10), time: '11:00'
    });
    await ownerFresh.request(`/api/admin/reservations/${recentR.body.reservationId}`, { method: 'DELETE' });

    // CANCEL_DELETE_DAYSより古いキャンセル予約は削除される
    const dOld = new Date(); dOld.setDate(dOld.getDate() - 90);
    const oldR = await ownerFresh.postJson('/api/admin/reservations', {
      realname: '古いキャンセルテスト', staffName: '花子', menu: 'テストメニュー', date: dOld.toISOString().slice(0, 10), time: '11:30'
    });
    await ownerFresh.request(`/api/admin/reservations/${oldR.body.reservationId}`, { method: 'DELETE' });

    const r = await ownerFresh.postJson('/api/admin/maintenance/run-daily', {});
    assert(r.status === 200 && r.body.cancelDeleteDays === 60, 'メンテナンス実行結果にCANCEL_DELETE_DAYS（デフォルト60日）が返る');
    assert(r.body.cancelledDeleted >= 1, '③60日より前のキャンセル予約が1件以上削除される');

    const recentRow = db.prepare('SELECT id FROM reservations WHERE id = ?').get(recentR.body.reservationId);
    assert(!!recentRow, '60日以内の直近キャンセル予約は削除されずに残る');
    const oldRow = db.prepare('SELECT id FROM reservations WHERE id = ?').get(oldR.body.reservationId);
    assert(!oldRow, '60日より前の古いキャンセル予約は物理削除される');
  }
  {
    // 店舗設定「基本ルール」からCANCEL_DELETE_DAYSを短縮すると、より新しいキャンセルも削除対象になる
    const dMid = new Date(); dMid.setDate(dMid.getDate() - 10);
    const midR = await ownerFresh.postJson('/api/admin/reservations', {
      realname: '10日前キャンセルテスト', staffName: '花子', menu: 'テストメニュー', date: dMid.toISOString().slice(0, 10), time: '12:00'
    });
    await ownerFresh.request(`/api/admin/reservations/${midR.body.reservationId}`, { method: 'DELETE' });

    await ownerFresh.putJson('/api/admin/settings/rules/CANCEL_DELETE_DAYS', { value: '7' });
    const r = await ownerFresh.postJson('/api/admin/maintenance/run-daily', {});
    assert(r.status === 200 && r.body.cancelDeleteDays === 7, '店舗設定でCANCEL_DELETE_DAYSを7日に変更すると、その値がメンテナンス結果に反映される');
    const midRow = db.prepare('SELECT id FROM reservations WHERE id = ?').get(midR.body.reservationId);
    assert(!midRow, 'CANCEL_DELETE_DAYSを7日に短縮すると、10日前のキャンセル予約も削除対象になる');

    await ownerFresh.putJson('/api/admin/settings/rules/CANCEL_DELETE_DAYS', { value: '60' }); // 後続テストに影響しないよう戻す
  }

  // --------------------------------------------------------------------------
  // 23. シフト初期値（曜日パターンの自動展開）
  //     （GAS版コード.gs expandShiftByRule_/deleteOldShifts_の移植）
  // --------------------------------------------------------------------------
  console.log('--- 23. シフト初期値（曜日パターンの自動展開） ---');
  {
    const r = await fetch(BASE + '/api/admin/settings/shift-templates').then((res) => res.status);
    assert(r === 401, '未ログインではシフト初期値を取得できない');
  }
  {
    const r = await ownerFresh.get('/api/admin/settings/shift-templates');
    assert(r.status === 200 && Array.isArray(r.body.templates) && r.body.templates.length > 0,
      'シードデータのシフト初期値（寿子・花子の曜日パターン）が取得できる');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/settings/shift-templates', {
      staffName: '存在しないスタッフ', dayOfWeek: 1, startTime: '10:00', endTime: '18:00'
    });
    assert(r.status === 400, '在籍していないスタッフ名では登録できない');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/settings/shift-templates', {
      staffName: '花子', dayOfWeek: 1, startTime: '18:00', endTime: '10:00'
    });
    assert(r.status === 400, '終了時間が開始時間より前では登録できない（バリデーション）');
  }
  // シフト自動展開の対象日（SHIFT_EXPAND_DAYS=49日先）を計算し、その曜日で
  // まだ登録されていないテスト用スタッフ「美咲」に新しいパターンを1件追加する
  const shiftTarget = new Date(); shiftTarget.setDate(shiftTarget.getDate() + 49);
  const shiftTargetDateStr = shiftTarget.toISOString().slice(0, 10);
  const shiftTargetDow = shiftTarget.getDay();
  let newTemplateId = null;
  {
    const before = db.prepare(`SELECT id FROM shift_master WHERE store_id = 1 AND staff_name = '美咲' AND shift_date = ?`).get(shiftTargetDateStr);
    assert(!before, '対象日にはまだ「美咲」のシフトが無い（前提確認）');
    const r = await ownerFresh.postJson('/api/admin/settings/shift-templates', {
      staffName: '美咲', dayOfWeek: shiftTargetDow, startTime: '13:00', endTime: '22:00'
    });
    assert(r.status === 200 && r.body.success === true, '「美咲」の曜日パターンを新規登録できる');
    newTemplateId = r.body.templateId;
  }
  {
    const r = await ownerFresh.postJson('/api/admin/maintenance/run-daily', {});
    assert(r.status === 200 && r.body.shiftExpandDays === 49 && r.body.shiftExpandTargetDate === shiftTargetDateStr,
      'メンテナンス実行結果にSHIFT_EXPAND_DAYS（49日）と展開対象日が返る');
    assert(r.body.shiftsExpanded >= 1, '④曜日パターンに一致するシフトが1件以上、対象日へ自動展開される');
    const row = db.prepare(`SELECT start_time, end_time FROM shift_master WHERE store_id = 1 AND staff_name = '美咲' AND shift_date = ?`).get(shiftTargetDateStr);
    assert(!!row && row.start_time === '13:00' && row.end_time === '22:00', '展開されたシフトの時刻がパターン通りになっている');
  }
  {
    // 2回目の実行では同じ日付・スタッフの組み合わせが既に存在するため、重複登録されない
    const r = await ownerFresh.postJson('/api/admin/maintenance/run-daily', {});
    const count = db.prepare(`SELECT COUNT(*) c FROM shift_master WHERE store_id = 1 AND staff_name = '美咲' AND shift_date = ?`).get(shiftTargetDateStr).c;
    assert(r.status === 200 && count === 1, '同じ日次メンテナンスを再実行しても、同じ日のシフトが重複登録されない（GAS版より堅牢にした冪等性）');
  }
  {
    // パターンを無効化（一時停止）すると、以後の展開対象から外れる
    await ownerFresh.putJson(`/api/admin/settings/shift-templates/${newTemplateId}`, { isActive: false });
    db.prepare(`DELETE FROM shift_master WHERE store_id = 1 AND staff_name = '美咲' AND shift_date = ?`).run(shiftTargetDateStr);
    const r = await ownerFresh.postJson('/api/admin/maintenance/run-daily', {});
    const row = db.prepare(`SELECT id FROM shift_master WHERE store_id = 1 AND staff_name = '美咲' AND shift_date = ?`).get(shiftTargetDateStr);
    assert(r.status === 200 && !row, 'パターンを無効化（isActive:false）すると、その日には展開されなくなる');
  }
  {
    // ⑤7日より前の古いシフトは日次メンテナンスで削除される
    const dOldShift = new Date(); dOldShift.setDate(dOldShift.getDate() - 10);
    const oldShiftDateStr = dOldShift.toISOString().slice(0, 10);
    await ownerFresh.postJson('/api/admin/shifts', { staffName: '花子', date: oldShiftDateStr, startTime: '10:00', endTime: '15:00' });
    const before = db.prepare(`SELECT COUNT(*) c FROM shift_master WHERE store_id = 1 AND shift_date = ?`).get(oldShiftDateStr).c;
    assert(before >= 1, '10日前の古いシフトを1件登録できる（削除テストの準備）');
    const r = await ownerFresh.postJson('/api/admin/maintenance/run-daily', {});
    assert(r.status === 200 && r.body.oldShiftsDeleted >= 1, '⑤7日より前の古いシフトが1件以上削除される');
    const after = db.prepare(`SELECT COUNT(*) c FROM shift_master WHERE store_id = 1 AND shift_date = ?`).get(oldShiftDateStr).c;
    assert(after === 0, '削除対象だった10日前のシフトが実際に無くなっている');
  }
  {
    // 店舗スコープ：他店舗の曜日パターンは操作できない
    const own = await ownerFresh.get('/api/admin/settings/shift-templates');
    const targetId = own.body.templates[0].id;
    const r = await owner2.request(`/api/admin/settings/shift-templates/${targetId}`, { method: 'DELETE' });
    assert(r.status === 404, '他店舗オーナーはstore1のシフト初期値を削除できない（店舗スコープ確認）');
  }
  {
    const del = await ownerFresh.request(`/api/admin/settings/shift-templates/${newTemplateId}`, { method: 'DELETE' });
    assert(del.status === 200 && del.body.success === true, 'シフト初期値パターンを削除できる');
    const after = await ownerFresh.get('/api/admin/settings/shift-templates');
    assert(!after.body.templates.some((t) => t.id === newTemplateId), '削除後は一覧に含まれなくなる');
  }

  // --------------------------------------------------------------------------
  // 24. LINE Webhook：友だち追加・スタンプ・予約キーワード返信
  //     （GAS版webhook_handler.gsのhandleFollow_/handleStickerMessage_/
  //      handleTextMessage_の移植）
  // --------------------------------------------------------------------------
  console.log('--- 24. LINE Webhook（友だち追加・スタンプ・予約キーワード） ---');
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
  console.log('--- 25. LINE連携設定 ---');
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
  // 26. 顧客マスタへの新規登録（GAS版reservation_form_functions.gs registerCustomer
  //     相当。お客様予約フォームを介さない、スタッフによる直接登録）
  // --------------------------------------------------------------------------
  console.log('--- 26. 顧客マスタへの新規登録 ---');
  {
    const r = await fetch(BASE + '/api/admin/customers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realname: '未ログインテスト' })
    }).then((res) => res.status);
    assert(r === 401, '未ログインでは顧客マスタへの新規登録はできない');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/customers', {});
    assert(r.status === 400, '本名が空では登録できない');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/customers', { realname: '山田 花子' });
    assert(r.status === 400, '本名にスペースが含まれる場合は登録できない（GAS版と同じバリデーション）');
  }
  let newCustomerId = null;
  {
    const r = await ownerFresh.postJson('/api/admin/customers', { realname: '新規登録花子', kana: 'シンキトウロクハナコ' });
    assert(r.status === 200 && r.body.success === true && !!r.body.customerId, '本名のみで新規顧客を登録できる（Cxxxx形式の顧客IDが発行される）');
    newCustomerId = r.body.customerId;
    const row = db.prepare('SELECT total_visits, is_keep_member, status FROM customers WHERE store_id = 1 AND customer_id = ?').get(newCustomerId);
    assert(!!row && row.total_visits === 0 && row.is_keep_member === 0 && row.status === 'active', 'キープメンバーを指定しない場合、来店回数は0・ステータスはactiveで登録される');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/customers', { realname: '新規登録花子' });
    assert(r.status === 409, '既に登録済みの本名を再度登録しようとすると409で拒否される');
  }
  {
    const r = await ownerFresh.postJson('/api/admin/customers', { realname: 'キープ登録次郎', isKeepMember: true });
    assert(r.status === 200 && r.body.success === true, '「キープメンバーとして登録する」を指定して新規登録できる');
    const row = db.prepare('SELECT total_visits, is_keep_member FROM customers WHERE store_id = 1 AND customer_id = ?').get(r.body.customerId);
    assert(!!row && row.total_visits === 1 && row.is_keep_member === 1, 'キープメンバー指定時は来店回数の初期値が1になる（GAS版と同じ挙動）');
  }
  {
    // LINE友だち追加で仮登録された行（本名未確定）に、後からスタッフが本名を登録するケース
    const fakeUserId = 'Utest-manual-register-001';
    db.prepare(`
      INSERT INTO customers (store_id, customer_id, realname, kana, line_name, user_id, total_visits, status, notify_enabled)
      VALUES (1, 'C0900', '', '', 'てすと表示名', ?, 0, 'inactive', 1)
    `).run(fakeUserId);
    const r = await ownerFresh.postJson('/api/admin/customers', { realname: '本登録太郎', userId: fakeUserId, isKeepMember: true });
    assert(r.status === 200 && r.body.success === true && r.body.customerId === 'C0900' && r.body.merged === true,
      'LINE USER IDが既存の仮登録行と一致する場合は、新規作成ではなくその行への統合になる');
    const row = db.prepare('SELECT realname, total_visits, status FROM customers WHERE store_id = 1 AND customer_id = ?').get('C0900');
    assert(!!row && row.realname === '本登録太郎' && row.total_visits === 1 && row.status === 'active',
      '統合された行の本名・来店回数（キープ指定により1）・ステータス（active）が更新される');
  }
  {
    // 店舗スコープ：他店舗オーナーが登録した顧客は自店にしか影響しない
    const r = await owner2.postJson('/api/admin/customers', { realname: '新規登録花子' });
    assert(r.status === 200 && r.body.success === true,
      '他店舗オーナーは、自店に同名の顧客がいなければ同じ本名でも新規登録できる（店舗ごとに独立した重複チェック）');
  }

  // --------------------------------------------------------------------------
  // 27. スタッフダッシュボードの「直近の予約」・シフト自己編集
  //     （GAS版dashboard_functions.gs getUpcomingReservations /
  //      addShiftRow_body_ / saveWeeklyShifts_body_ / deleteShiftRow_body_ の移植）
  // --------------------------------------------------------------------------
  console.log('--- 27. 直近の予約・シフト自己編集 ---');
  const pad2_ = (n) => String(n).padStart(2, '0');
  const fmtDate_ = (d) => `${d.getFullYear()}-${pad2_(d.getMonth() + 1)}-${pad2_(d.getDate())}`;
  const today27 = new Date(); today27.setHours(0, 0, 0, 0);
  const nearDate27 = fmtDate_(new Date(today27.getTime() + 1 * 86400000));   // 明日（3日以内）
  // ★他のテスト区画が予約登録に使う相対日付（多くはBOOKING_LIMIT_DAYS=49日以内）と
  //   衝突しないよう、十分に先の日付を使う
  const farDate27 = fmtDate_(new Date(today27.getTime() + 500 * 86400000));  // 3日より先・他区画と衝突しない遠い未来日
  {
    const r = await fetch(BASE + '/api/staff/reservations/upcoming').then((res) => res.status);
    assert(r === 401, '未ログインでは/api/staff/reservations/upcomingを取得できない');
  }
  {
    const r = await hanako.get('/api/staff/reservations/upcoming');
    assert(r.status === 200 && r.body.rangeDays === 15 && Array.isArray(r.body.reservations),
      '/api/staff/reservations/upcomingは既定15日分の担当予約一覧を返す');
    const allHanako = (r.body.reservations || []).every((x) => x.staff_name === '花子');
    assert(allHanako, '/api/staff/reservations/upcomingは自分（花子）担当分のみを返す');
  }
  {
    const r = await fetch(BASE + '/api/staff/shifts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: farDate27, startTime: '10:00', endTime: '18:00' })
    }).then((res) => res.status);
    assert(r === 401, '未ログインでは/api/staff/shiftsへのシフト追加はできない');
  }
  {
    const r = await hanako.postJson('/api/staff/shifts', { date: nearDate27, startTime: '10:00', endTime: '18:00' });
    assert(r.status === 400, '一般スタッフは3日以内の日付にシフトを追加できない');
  }
  {
    const r = await hanako.postJson('/api/staff/shifts', { date: farDate27, startTime: '18:00', endTime: '10:00' });
    assert(r.status === 400, '開始時間が終了時間より後の場合はシフトを追加できない');
  }
  let hanakoShiftId27 = null;
  {
    const r = await hanako.postJson('/api/staff/shifts', { date: farDate27, startTime: '10:00', endTime: '18:00' });
    assert(r.status === 200 && r.body.success === true, '一般スタッフは3日より先の自分のシフトを追加できる');
    const row = db.prepare(
      'SELECT * FROM shift_master WHERE store_id = 1 AND staff_name = ? AND shift_date = ? AND start_time = ?'
    ).get('花子', farDate27, '10:00');
    assert(!!row, '追加したシフトがshift_masterに保存されている');
    hanakoShiftId27 = row.id;
  }
  {
    // オーナーは3日以内でもシフトを追加できる（本人分のみに限定した簡略化のもと、オーナー自身は制限を免除）
    const r = await ownerFresh.postJson('/api/staff/shifts', { date: nearDate27, startTime: '09:00', endTime: '12:00' });
    assert(r.status === 200 && r.body.success === true, 'オーナーは3日以内でも自分のシフトを追加できる（3日前ルール免除）');
    db.prepare(`DELETE FROM shift_master WHERE store_id = 1 AND staff_name = '寿子' AND shift_date = ? AND start_time = '09:00'`).run(nearDate27);
  }
  {
    // 他スタッフのシフトIDを直接挿入し、花子が編集しようとしても対象外（404）になることを確認
    const other = db.prepare(`
      INSERT INTO shift_master (store_id, staff_name, shift_date, start_time, end_time, is_active)
      VALUES (1, '寿子', ?, '10:00', '18:00', 1)
    `).run(farDate27);
    const r = await hanako.putJson(`/api/staff/shifts/${other.lastInsertRowid}`, { startTime: '11:00', endTime: '17:00' });
    assert(r.status === 404, '一般スタッフは他スタッフのシフトを編集できない（自分のシフトのみ対象）');
    db.prepare('DELETE FROM shift_master WHERE id = ?').run(other.lastInsertRowid);
  }
  {
    const r = await hanako.putJson(`/api/staff/shifts/${hanakoShiftId27}`, { startTime: '11:00', endTime: '19:00' });
    assert(r.status === 200 && r.body.success === true, '一般スタッフは3日より先の自分のシフトを変更できる');
    const row = db.prepare('SELECT start_time, end_time FROM shift_master WHERE id = ?').get(hanakoShiftId27);
    assert(!!row && row.start_time === '11:00' && row.end_time === '19:00', '変更後のシフト時間が保存されている');
  }
  {
    // この時間帯に予約を入れてから、予約時間をはみ出す変更を試みると拒否される
    db.prepare(`
      INSERT INTO reservations (store_id, realname, staff_name, menu, reservation_date, reservation_time, status)
      VALUES (1, '直近予約テスト客', '花子', 'テストメニュー', ?, '12:00', '確定')
    `).run(farDate27);
    const r = await hanako.putJson(`/api/staff/shifts/${hanakoShiftId27}`, { startTime: '13:00', endTime: '19:00' });
    assert(r.status === 400, '予約時間をシフト範囲から外す変更は拒否される');
  }
  {
    const r = await hanako.del(`/api/staff/shifts/${hanakoShiftId27}`);
    assert(r.status === 400, 'この時間帯に予約が入っているシフトは削除できない');
  }
  {
    db.prepare(`DELETE FROM reservations WHERE store_id = 1 AND realname = '直近予約テスト客' AND reservation_date = ?`).run(farDate27);
    const r = await hanako.del(`/api/staff/shifts/${hanakoShiftId27}`);
    assert(r.status === 200 && r.body.success === true, '予約が無くなれば自分のシフトを削除できる');
    const row = db.prepare('SELECT id FROM shift_master WHERE id = ?').get(hanakoShiftId27);
    assert(!row, '削除したシフトがshift_masterから消えている');
  }
  {
    const r = await hanako.del('/api/staff/shifts/999999');
    assert(r.status === 404, '存在しないシフトIDの削除は404になる');
  }

  // --------------------------------------------------------------------------
  // 28. お客様予約フォームの顧客ID連携（GAS版reservation_form_functions.gs
  //     getCustomerFormData / submitCustomerBooking_body_の移植）
  // --------------------------------------------------------------------------
  console.log('--- 28. お客様予約フォームの顧客ID連携 ---');
  db.prepare(`
    INSERT INTO customers (store_id, customer_id, realname, kana, line_name, user_id, total_visits, is_keep_member, booking_blocked, status, notify_enabled)
    VALUES (1, 'CT950', 'フォーム連携花子', 'フォームレンケイハナコ', 'はなこ', 'Utest-form-950', 3, 1, 0, 'active', 1)
  `).run();
  db.prepare(`
    INSERT INTO customers (store_id, customer_id, realname, kana, line_name, user_id, total_visits, booking_blocked, status, notify_enabled)
    VALUES (1, 'CT951', '受付拒否太郎', 'ウケツケキョヒタロウ', '', '', 5, 1, 'active', 1)
  `).run();
  {
    // ★2026-09-23更新：キープメンバー／初めての方／既存お客様の出し分け機能追加に伴い、
    //   cid未指定時もGAS版と同じくtarget:'new', theme:'green'のデフォルトオブジェクトを
    //   返すよう変更した（以前はnullを返していた）。
    const r = await fetch(BASE + '/api/store?store=1').then((res) => res.json());
    assert(
      r.customer && r.customer.found === false && r.customer.target === 'new' && r.customer.theme === 'green',
      'cidパラメータ無しでは/api/storeのcustomerはfound:false・target:new・theme:greenのデフォルト値になる'
    );
  }
  {
    const r = await fetch(BASE + '/api/store?store=1&cid=CT950').then((res) => res.json());
    assert(
      r.customer && r.customer.found === true && r.customer.realname === 'フォーム連携花子' &&
      r.customer.kana === 'フォームレンケイハナコ' && r.customer.isKeepMember === true && r.customer.visitCount === 3,
      '?cid=既存顧客IDを指定すると、本名・フリガナ・キープメンバー・来店回数が返る'
    );
    // ★2026-09-23追加：キープメンバー・来店実績ありなのでtarget:'keep'・theme:'pink'になる
    assert(r.customer.target === 'keep' && r.customer.theme === 'pink', 'キープメンバーはtarget:keep・theme:pinkになる');
  }
  {
    const r = await fetch(BASE + '/api/store?store=1&cid=CT-not-exist').then((res) => res.json());
    assert(r.customer && r.customer.found === false && r.customer.bookingBlocked === false, '存在しない顧客IDではfound:falseが返る（エラーにはならない）');
    // ★2026-09-23追加：存在しない顧客IDはGAS版同様、初めての方扱い（target:'new'・theme:'green'）になる
    assert(r.customer.target === 'new' && r.customer.theme === 'green', '存在しない顧客IDはtarget:new・theme:greenのデフォルト扱いになる');
  }
  {
    const r = await fetch(BASE + '/api/store?store=1&cid=CT951').then((res) => res.json());
    assert(r.customer && r.customer.found === true && r.customer.bookingBlocked === true, '予約フォーム受付拒否フラグが立っている顧客はbookingBlocked:trueが返る');
  }
  {
    // 店舗スコープ：他店舗の顧客IDをstore=1側から問い合わせても見つからない
    const r = await fetch(BASE + '/api/store?store=1&cid=CT2001').then((res) => res.json()).catch(() => null);
    // CT2001はstore2側の顧客IDを想定した架空ID。存在しないので単純にfound:falseになることだけ確認する
    assert(r && r.customer && r.customer.found === false, '他店舗の顧客IDや存在しないIDはstore=1側では見つからない（found:false）');
  }
  {
    const r = await fetch(BASE + '/api/reservations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store: '1', customerId: 'CT951', realname: 'クライアント側入力名', staffName: '花子',
        menu: 'フェイシャル(60分)', date: '2026-12-10', time: '10:00', note: '', editor: 'テスト'
      })
    }).then((res) => res.json());
    assert(r.success === false && !r.isLimitWarning, '受付拒否の顧客IDを指定した予約送信は、サーバー側の再チェックで拒否される');
    const row = db.prepare(`SELECT id FROM reservations WHERE customer_id = 'CT951'`).get();
    assert(!row, '受付拒否の予約は実際にはDBへ登録されていない');
  }
  {
    const r = await fetch(BASE + '/api/reservations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store: '1', customerId: 'CT950', realname: 'クライアント側から届いた別の名前', staffName: '花子',
        menu: 'フェイシャル(60分)', date: '2026-12-11', time: '10:00', note: '', editor: 'テスト'
      })
    }).then((res) => res.json());
    assert(r.success === true, '受付拒否されていない顧客IDでの予約送信は成功する');
    const row = db.prepare(`SELECT realname, kana FROM reservations WHERE customer_id = 'CT950'`).get();
    assert(!!row && row.realname === 'フォーム連携花子' && row.kana === 'フォームレンケイハナコ',
      'クライアント側から送られた本名は無視され、顧客マスタの本名・フリガナが実際に保存される（なりすまし防止）');
  }

  // --------------------------------------------------------------------------
  // 29. 予約の追加・編集・キャンセル・顧客登録の一般スタッフ開放
  //     （GAS版reservation_form_functions.gs addReservationUnified_body_ /
  //      updateReservation_body_ / cancelReservation_body_ / registerCustomer_body_の移植）
  // --------------------------------------------------------------------------
  console.log('--- 29. 予約の追加・編集・キャンセル・顧客登録の一般スタッフ開放 ---');
  const date29 = fmtDate_(new Date(today27.getTime() + 600 * 86400000)); // 他区画と衝突しない遠い未来日
  {
    const r = await fetch(BASE + '/api/staff/reservations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realname: '未ログインテスト', staffName: '花子', menu: 'フェイシャル(60分)', date: date29, time: '10:00' })
    }).then((res) => res.status);
    assert(r === 401, '未ログインでは/api/staff/reservationsへの新規登録はできない');
  }
  {
    const r = await hanako.postJson('/api/staff/reservations', {
      realname: '他担当指定テスト', staffName: '寿子', menu: 'フェイシャル(60分)', date: date29, time: '09:00'
    });
    assert(r.status === 403, '一般スタッフは他スタッフを担当に指定した新規登録ができない');
  }
  let hanakoResvId29 = null;
  {
    const r = await hanako.postJson('/api/staff/reservations', {
      realname: '花子担当29テスト', staffName: '花子', menu: 'フェイシャル(60分)', date: date29, time: '09:00'
    });
    assert(r.status === 200 && r.body.success === true, '一般スタッフは自分担当の新規予約を登録できる');
    hanakoResvId29 = r.body.reservationId;
  }
  {
    const r = await hanako.postJson('/api/staff/reservations', {
      realname: '未定担当29テスト', staffName: '未定', menu: 'フェイシャル(60分)', date: date29, time: '09:15'
    });
    assert(r.status === 200 && r.body.success === true, '一般スタッフは「未定」担当でも新規予約を登録できる');
    db.prepare(`DELETE FROM reservations WHERE store_id = 1 AND realname = '未定担当29テスト'`).run();
  }
  {
    // 二重予約防止：同じ日時・担当に既に別の予約があるとUNIQUE制約で409になる
    const r = await hanako.postJson('/api/staff/reservations', {
      realname: '二重予約テスト29', staffName: '花子', menu: 'フェイシャル(60分)', date: date29, time: '09:00'
    });
    assert(r.status === 409 && r.body.isDoubleBooking === true, '同じ日時・担当への重複登録は二重予約として拒否される');
  }
  {
    // 予約上限（既定3件）：同姓同名で確定予約を3件作ってから一般スタッフが4件目を追加しようとするとハードブロックされる
    const limitDate = (n) => fmtDate_(new Date(today27.getTime() + (610 + n) * 86400000));
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO reservations (store_id, realname, staff_name, menu, reservation_date, reservation_time, status)
        VALUES (1, '上限テスト客29', '花子', 'テストメニュー', ?, '10:00', '確定')
      `).run(limitDate(i));
    }
    const r = await hanako.postJson('/api/staff/reservations', {
      realname: '上限テスト客29', staffName: '花子', menu: 'フェイシャル(60分)', date: limitDate(3), time: '10:00'
    });
    assert(r.status === 400 && r.body.success === false, '一般スタッフは予約上限を超える登録をハードブロックされる（オーバーライド不可）');

    const rOwner = await ownerFresh.postJson('/api/staff/reservations', {
      realname: '上限テスト客29', staffName: '寿子', menu: 'フェイシャル(60分)', date: limitDate(3), time: '10:00'
    });
    assert(rOwner.status === 200 && rOwner.body.success === false && rOwner.body.isLimitWarning === true,
      'オーナーは予約上限超過時にisLimitWarningの確認メッセージを受け取る（ハードブロックされない）');

    const rOwnerOverride = await ownerFresh.postJson('/api/staff/reservations', {
      realname: '上限テスト客29', staffName: '寿子', menu: 'フェイシャル(60分)', date: limitDate(3), time: '10:00', ownerOverride: true
    });
    assert(rOwnerOverride.status === 200 && rOwnerOverride.body.success === true, 'オーナーはownerOverrideを指定すれば上限を超えて登録できる');

    db.prepare(`DELETE FROM reservations WHERE store_id = 1 AND realname = '上限テスト客29'`).run();
  }
  {
    // 他スタッフ（寿子）担当の予約を花子が編集しようとすると拒否される
    const other = db.prepare(`
      INSERT INTO reservations (store_id, realname, staff_name, menu, reservation_date, reservation_time, status)
      VALUES (1, '他担当編集テスト29', '寿子', 'テストメニュー', ?, '11:00', '確定')
    `).run(date29);
    const r = await hanako.putJson(`/api/staff/reservations/${other.lastInsertRowid}`, {
      staffName: '寿子', menu: 'フェイシャル(90分)', date: date29, time: '11:00', note: '変更試行'
    });
    assert(r.status === 403, '一般スタッフは他スタッフ担当の予約を編集できない');
    db.prepare('DELETE FROM reservations WHERE id = ?').run(other.lastInsertRowid);
  }
  {
    const r = await hanako.putJson(`/api/staff/reservations/${hanakoResvId29}`, {
      staffName: '花子', menu: 'フェイシャル(90分)', date: date29, time: '09:00', note: '花子が自分で変更'
    });
    assert(r.status === 200 && r.body.success === true, '一般スタッフは自分担当の予約を編集できる');
    const row = db.prepare('SELECT menu, note, editor FROM reservations WHERE id = ?').get(hanakoResvId29);
    assert(!!row && row.menu === 'フェイシャル(90分)' && row.note === '花子が自分で変更' && row.editor === '花子',
      '編集後の内容とeditor（編集者）が正しく保存されている');
  }
  {
    // GAS版と同じく、変更後の担当自体には制限がない（元の担当が自分か未定であれば変更先は問わない）
    const r = await hanako.putJson(`/api/staff/reservations/${hanakoResvId29}`, {
      staffName: '寿子', menu: 'フェイシャル(90分)', date: date29, time: '09:00', note: '担当を寿子に変更'
    });
    assert(r.status === 200 && r.body.success === true, '一般スタッフは自分担当だった予約の担当を別スタッフに変更できる（GAS版と同じ挙動）');
    db.prepare(`UPDATE reservations SET staff_name = '花子' WHERE id = ?`).run(hanakoResvId29); // 後続テストのため花子担当に戻す
  }
  {
    // 他スタッフ担当の予約を花子がキャンセルしようとすると拒否される
    const other = db.prepare(`
      INSERT INTO reservations (store_id, realname, staff_name, menu, reservation_date, reservation_time, status)
      VALUES (1, '他担当キャンセルテスト29', '寿子', 'テストメニュー', ?, '12:00', '確定')
    `).run(date29);
    const r = await hanako.del(`/api/staff/reservations/${other.lastInsertRowid}`);
    assert(r.status === 403, '一般スタッフは他スタッフ担当の予約をキャンセルできない');
    db.prepare('DELETE FROM reservations WHERE id = ?').run(other.lastInsertRowid);
  }
  {
    const r = await hanako.del(`/api/staff/reservations/${hanakoResvId29}`);
    assert(r.status === 200 && r.body.success === true, '一般スタッフは自分担当の予約をキャンセルできる');
    const row = db.prepare('SELECT realname, editor FROM reservations WHERE id = ?').get(hanakoResvId29);
    assert(!!row && row.realname === 'キャンセル' && row.editor === '花子', 'キャンセル後はrealnameが「キャンセル」・editorが花子になっている（物理削除しない）');
  }
  {
    // オーナーは他スタッフ担当の予約でも編集・キャンセルできる（制限なし）
    const other = db.prepare(`
      INSERT INTO reservations (store_id, realname, staff_name, menu, reservation_date, reservation_time, status)
      VALUES (1, 'オーナー操作テスト29', '花子', 'テストメニュー', ?, '13:00', '確定')
    `).run(date29);
    const rEdit = await ownerFresh.putJson(`/api/staff/reservations/${other.lastInsertRowid}`, {
      staffName: '花子', menu: 'ハンド(45分)', date: date29, time: '13:00', note: 'オーナーが編集'
    });
    assert(rEdit.status === 200 && rEdit.body.success === true, 'オーナーは他スタッフ担当の予約でも編集できる');
    const rCancel = await ownerFresh.del(`/api/staff/reservations/${other.lastInsertRowid}`);
    assert(rCancel.status === 200 && rCancel.body.success === true, 'オーナーは他スタッフ担当の予約でもキャンセルできる');
    db.prepare('DELETE FROM reservations WHERE id = ?').run(other.lastInsertRowid);
  }
  {
    // 顧客登録：一般スタッフにも開放されている（GAS版registerCustomer_body_にオーナー限定の分岐はない）
    const r = await hanako.postJson('/api/staff/customers', { realname: '花子登録29太郎', kana: 'ハナコトウロク29タロウ' });
    assert(r.status === 200 && r.body.success === true && /^C\d{4}$/.test(r.body.customerId),
      '一般スタッフは顧客マスタへ新規登録できる（GAS版に権限制限なし）');
    const row = db.prepare(`SELECT * FROM customers WHERE store_id = 1 AND customer_id = ?`).get(r.body.customerId);
    assert(!!row && row.realname === '花子登録29太郎', '登録した顧客が実際にcustomersテーブルへ保存されている');
  }
  {
    // 本名重複チェック（①の分岐）は一般スタッフの登録でも働く
    const r = await hanako.postJson('/api/staff/customers', { realname: '花子登録29太郎' });
    assert(r.status === 409 && r.body.success === false, '一般スタッフの顧客登録でも本名の重複は拒否される');
  }
  {
    const r = await fetch(BASE + '/api/staff/customers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realname: '未ログイン顧客登録29' })
    }).then((res) => res.status);
    assert(r === 401, '未ログインでは/api/staff/customersへの登録はできない');
  }

  // --------------------------------------------------------------------------
  // 30. サロンダッシュボード（GAS版calendar_page.html / calendar_dashboard_functions.gsの移植）
  // --------------------------------------------------------------------------
  console.log('--- 30. サロンダッシュボード ---');
  const cal30Date = fmtDate_(new Date(today27.getTime() + 700 * 86400000)); // 他区画と衝突しない遠い未来日
  const cal30Monday = (() => {
    const d = new Date(cal30Date + 'T00:00:00');
    const dow = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dow);
    return fmtDate_(d);
  })();
  {
    const r = await fetch(BASE + '/api/staff/calendar/week?start=' + cal30Monday).then((res) => res.status);
    assert(r === 401, '未ログインでは/api/staff/calendar/weekを取得できない');
  }
  {
    const r = await hanako.get('/api/staff/calendar/week?start=' + cal30Monday);
    assert(r.status === 200 && r.body.success === true && Array.isArray(r.body.data.reservations) && Array.isArray(r.body.data.events),
      '一般スタッフでも週の予約・イベントを取得できる（閲覧は権限制限なし）');
    assert(typeof r.body.data.staffColors === 'object' && Object.keys(r.body.data.staffColors).length > 0,
      'staffColorsに在籍スタッフの色割り当てが含まれる');
  }
  {
    const r = await hanako.get(`/api/staff/calendar/month?year=2026&month=12`);
    assert(r.status === 200 && r.body.success === true && Array.isArray(r.body.data.reservations), '月表示データも取得できる');
  }
  {
    const r = await hanako.get('/api/staff/calendar/month?year=0&month=13');
    assert(r.status === 400, '不正なyear/monthは400になる');
  }
  let cal30ResvId = null;
  {
    const r = await hanako.postJson('/api/staff/reservations', {
      realname: 'カレンダー表示テスト30', staffName: '花子', menu: 'フェイシャル(60分)', date: cal30Date, time: '11:00'
    });
    assert(r.status === 200 && r.body.success === true, 'カレンダー表示確認用の予約を登録できる');
    cal30ResvId = r.body.reservationId;
  }
  {
    const r = await hanako.get('/api/staff/calendar/week?start=' + cal30Monday);
    const found = (r.body.data.reservations || []).find((x) => x.id === cal30ResvId);
    assert(!!found && found.date === cal30Date && found.startTime === '11:00' && found.endTime === '12:30' && found.realname === 'カレンダー表示テスト30',
      '登録した予約が週データに反映され、終了時刻が開始+90分で計算されている');
  }
  {
    // 未ログインでのイベント作成は拒否される
    const r = await fetch(BASE + '/api/admin/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '未ログインテスト30', date: cal30Date, startTime: '14:00', endTime: '16:00' })
    }).then((res) => res.status);
    assert(r === 401, '未ログインでは行事（イベント）を作成できない');
  }
  {
    const r = await hanako.postJson('/api/admin/events', { title: '一般スタッフテスト30', date: cal30Date, startTime: '14:00', endTime: '16:00' });
    assert(r.status === 401, '一般スタッフは行事（イベント）を作成できない（オーナー専用）');
  }
  let cal30EventId = null;
  {
    const r = await ownerFresh.postJson('/api/admin/events', {
      title: '研修会30', date: cal30Date, startTime: '14:00', endTime: '16:00', restrictBooking: true
    });
    assert(r.status === 200 && r.body.success === true, 'オーナーは行事（イベント）を作成できる');
    cal30EventId = r.body.eventId;
  }
  {
    const r = await hanako.get('/api/staff/calendar/events?date=' + cal30Date);
    assert(r.status === 200 && r.body.success === true, '一般スタッフでも指定日の行事一覧を取得できる（閲覧は権限制限なし）');
    const found = (r.body.events || []).find((x) => x.id === cal30EventId);
    assert(!!found && found.label === '研修会30' && found.restrictBooking === true, '作成した行事が一般スタッフからも正しく見える');
  }
  {
    const r = await hanako.get('/api/staff/calendar/week?start=' + cal30Monday);
    const found = (r.body.data.events || []).find((x) => x.id === cal30EventId);
    assert(!!found && found.blockReservation === true && found.blockStart === '12:30' && found.blockEnd === '17:00',
      '週データのイベントには予約ブロック用のバッファ時間帯（開始-90分/終了+60分）が自動計算されて含まれる');
  }
  {
    const r = await hanako.putJson('/api/admin/events/' + cal30EventId, {
      title: '研修会30（変更）', date: cal30Date, startTime: '15:00', endTime: '17:00', restrictBooking: false
    });
    assert(r.status === 401, '一般スタッフは行事を変更できない（オーナー専用）');
  }
  {
    const r = await ownerFresh.putJson('/api/admin/events/' + cal30EventId, {
      title: '研修会30（変更）', date: cal30Date, startTime: '15:00', endTime: '17:00', restrictBooking: false
    });
    assert(r.status === 200 && r.body.success === true, 'オーナーは行事を変更できる');
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(cal30EventId);
    assert(!!row && row.title === '研修会30（変更）' && row.start_time === '15:00' && row.restrict_booking === 0,
      '変更後の内容が実際にDBへ保存されている');
  }
  {
    const r = await hanako.del('/api/admin/events/' + cal30EventId);
    assert(r.status === 401, '一般スタッフは行事を削除できない（オーナー専用）');
  }
  {
    const r = await ownerFresh.del('/api/admin/events/' + cal30EventId);
    assert(r.status === 200 && r.body.success === true, 'オーナーは行事を削除できる');
    const row = db.prepare('SELECT id FROM events WHERE id = ?').get(cal30EventId);
    assert(!row, '削除した行事がeventsテーブルから消えている');
  }
  {
    const r = await hanako.get('/api/staff/calendar/week?start=' + cal30Monday);
    const found = (r.body.data.events || []).find((x) => x.id === cal30EventId);
    assert(!found, '削除した行事は週データにも表示されなくなる');
  }
  {
    // 予約のキャンセルは週データから除外される（GAS版と同じく、キャンセル済み予約はカレンダー上に表示しない）
    const rCancel = await hanako.del('/api/staff/reservations/' + cal30ResvId);
    assert(rCancel.status === 200 && rCancel.body.success === true, '表示確認用の予約をキャンセルできる');
    const r = await hanako.get('/api/staff/calendar/week?start=' + cal30Monday);
    const found = (r.body.data.reservations || []).find((x) => x.id === cal30ResvId);
    assert(!found, 'キャンセル済みの予約は週データに含まれない');
  }

  // --------------------------------------------------------------------------
  // 31. スタッフダッシュボードからの仮予約確定（一般スタッフ開放、GAS版と同じ権限）
  // --------------------------------------------------------------------------
  console.log('--- 31. スタッフダッシュボードからの仮予約確定 ---');
  let staffProvisionalId = null;
  {
    const d = new Date(); d.setDate(d.getDate() + 32);
    const dateStr = d.toISOString().slice(0, 10);
    const r = await hanako.postJson('/api/staff/reservations', {
      realname: 'スタッフ確定テスト', staffName: '花子', menu: 'テストメニュー', date: dateStr, time: '13:00', provisional: true
    });
    assert(r.status === 200 && r.body.success === true, '一般スタッフが仮予約として新規登録できる（29章の既存API）');
    staffProvisionalId = r.body.reservationId;
  }
  {
    const anonConfirm = makeSession();
    const r = await anonConfirm.postJson('/api/staff/reservations/' + staffProvisionalId + '/confirm', {});
    assert(r.status === 401, '未ログインでは仮予約を確定できない');
  }
  {
    const r = await owner2.postJson('/api/staff/reservations/' + staffProvisionalId + '/confirm', {});
    assert(r.status === 404, '他店舗のスタッフ/オーナーは他店の仮予約を確定できない（店舗スコープ確認）');
  }
  {
    const r = await hanako.postJson('/api/staff/reservations/' + staffProvisionalId + '/confirm', {});
    assert(r.status === 200 && r.body.success === true, '一般スタッフ（オーナーでない）が仮予約を確定できる（GAS版confirmReservation_body_と同じくオーナー限定の分岐は無い）');
  }
  {
    const r = await ownerFresh.get('/api/admin/reservations?from=2026-01-01&to=2027-12-31');
    const row = (r.body.reservations || []).find((x) => x.id === staffProvisionalId);
    assert(!!row && row.status === '確定', '一般スタッフによる確定操作後もstatus=確定に変わる');
  }
  {
    const r = await hanako.postJson('/api/staff/reservations/' + staffProvisionalId + '/confirm', {});
    assert(r.status === 400 && /すでに確定済み/.test(r.body.message), 'すでに確定済みの予約を一般スタッフが再度確定しようとすると拒否される');
  }
  {
    const r = await hanako.postJson('/api/staff/reservations/999999/confirm', {});
    assert(r.status === 404, '存在しない予約IDの確定操作（スタッフ版）は404になる');
  }
  {
    const d = new Date(); d.setDate(d.getDate() + 33);
    const dateStr = d.toISOString().slice(0, 10);
    const r = await hanako.postJson('/api/staff/reservations', {
      realname: '担当未定スタッフ確定テスト', staffName: '未定', menu: 'テストメニュー', date: dateStr, time: '13:00', provisional: true
    });
    const confirmR = await hanako.postJson('/api/staff/reservations/' + r.body.reservationId + '/confirm', {});
    assert(confirmR.status === 400 && /担当スタッフが未定/.test(confirmR.body.message), '担当スタッフが「未定」のままの仮予約は一般スタッフでも確定操作できない');
  }

  // --------------------------------------------------------------------------
  // 32. スタッフ用の顧客検索（予約フォームでの既存顧客選択、46章の続き）
  // --------------------------------------------------------------------------
  console.log('--- 32. スタッフ用の顧客検索 ---');
  {
    const anonSearch = makeSession();
    const r = await anonSearch.get('/api/staff/customers/search?q=田中');
    assert(r.status === 401, '未ログインでは顧客検索できない');
  }
  {
    const r = await hanako.get('/api/staff/customers/search?q=');
    assert(r.status === 200 && Array.isArray(r.body.customers) && r.body.customers.length === 0, '検索語が空のときは空配列を返す（全件ブラウズはしない）');
  }
  {
    // ★C0001は他セクションのテストで本名・電話番号が書き換えられている場合があるため
    //   （テスト全体を通しで実行する都合上）、customerId一致で判定する
    const r = await hanako.get('/api/staff/customers/search?q=' + encodeURIComponent('田中'));
    assert(r.status === 200 && r.body.customers.some((c) => c.customerId === 'C0001'), '一般スタッフでも本名の部分一致で既存顧客を検索できる（customerId付き）');
  }
  {
    const r = await hanako.get('/api/staff/customers/search?q=' + encodeURIComponent('タナカ'));
    assert(r.status === 200 && r.body.customers.some((c) => c.customerId === 'C0001'), 'フリガナの部分一致でも検索できる');
  }
  {
    const r = await hanako.get('/api/staff/customers/search?q=' + encodeURIComponent('1111'));
    assert(r.status === 200 && r.body.customers.some((c) => c.customerId === 'C0001'), '電話番号の部分一致でも検索できる');
  }
  {
    const r = await owner2.get('/api/staff/customers/search?q=' + encodeURIComponent('田中'));
    assert(r.status === 200 && r.body.customers.length === 0, '他店舗のスタッフからは検索結果に含まれない（店舗スコープ確認）');
  }
  {
    const d = new Date(); d.setDate(d.getDate() + 36);
    const dateStr = d.toISOString().slice(0, 10);
    const r = await hanako.postJson('/api/staff/reservations', {
      realname: '田中 美穂', customerId: 'C0001', staffName: '花子', menu: 'テストメニュー', date: dateStr, time: '13:00'
    });
    assert(r.status === 200 && r.body.success === true, '検索で選択したcustomerIdを付けて予約登録できる（一般スタッフ）');
    const listR = await hanako.get('/api/staff/reservations?from=2026-01-01&to=2027-12-31');
    const row = (listR.body.reservations || []).find((x) => x.id === r.body.reservationId);
    assert(!!row && row.customer_id === 'C0001', '登録した予約にcustomerIdが正しく保存されている');
  }

  // --------------------------------------------------------------------------
  // 33. スタッフ用の顧客一覧（かな行インデックス選択モーダル用、47-6章）
  // --------------------------------------------------------------------------
  console.log('--- 33. スタッフ用の顧客一覧 ---');
  {
    const anonList = makeSession();
    const r = await anonList.get('/api/staff/customers/list');
    assert(r.status === 401, '未ログインでは顧客一覧を取得できない');
  }
  {
    const r = await hanako.get('/api/staff/customers/list');
    assert(r.status === 200 && Array.isArray(r.body.customers) && r.body.customers.length > 0, '一般スタッフでも在籍顧客の全件一覧を取得できる');
    assert(r.body.customers.some((c) => c.customerId === 'C0001'), '一覧にcustomerId付きで顧客が含まれる');
  }
  {
    // 注：customer_idは店舗ごとに独立採番されるため、店1のC0001と店2の
    // 新規登録顧客がたまたま同じID「C0001」になり得る（それ自体は店舗分離の
    // バグではない）。よって「customerId===店1のC0001」ではなく、店1の
    // シードにしか存在しない実名（田中）が混入していないかで判定する。
    const r = await owner2.get('/api/staff/customers/list');
    assert(r.status === 200 && !r.body.customers.some((c) => c.realname && c.realname.startsWith('田中')), '他店舗のスタッフの一覧には自店舗以外の顧客が含まれない（店舗スコープ確認）');
  }

  // --------------------------------------------------------------------------
  // 34. 予約の追加・編集・キャンセルでのLINE通知拡張（GAS版confirm_add/change/cancel、
  //     47-7章参照。社長より「顧客への通知のみ拡張」の方針で承認を得て実装）
  // --------------------------------------------------------------------------
  console.log('--- 34. 予約の追加・編集・キャンセルでのLINE通知拡張 ---');
  let notifyTestResvId = null;
  {
    // 顧客未連携（customerIdなし）での新規登録は、LINE通知がスキップされた旨が
    // メッセージに含まれる（GAS版の「ℹ️LINE IDが未登録のため通知できませんでした」相当）
    const r = await hanako.postJson('/api/staff/reservations', {
      realname: 'LINE通知テスト太郎', staffName: '花子', menu: 'テストメニュー',
      date: '2026-12-20', time: '10:00'
    });
    assert(r.status === 200 && r.body.success && /ℹ️/.test(r.body.message), '顧客未連携の新規登録ではLINE通知スキップの案内がメッセージに含まれる');
  }
  {
    // customerId='C0001'（LINE連携済み、user_id='U0001'）を指定した新規登録では、
    // 店舗にLINEチャネルトークンが未設定のためシミュレーション扱いになるが、
    // その旨（📱）がメッセージに含まれる
    const r = await hanako.postJson('/api/staff/reservations', {
      realname: '田中 美穂（改）', customerId: 'C0001', staffName: '花子', menu: 'テストメニュー',
      date: '2026-12-21', time: '10:00'
    });
    assert(r.status === 200 && r.body.success && /📱/.test(r.body.message), 'LINE連携済み顧客の新規登録ではLINE通知実行の案内（📱）がメッセージに含まれる');
    notifyTestResvId = r.body.reservationId;
  }
  {
    // 仮予約として登録した場合は、確定操作時にconfirm_finalizeで別途通知するため、
    // 新規登録時点ではLINE通知の案内文言を含まない（二重通知防止）
    const r = await hanako.postJson('/api/staff/reservations', {
      realname: '田中 美穂（改）', customerId: 'C0001', staffName: '花子', menu: 'テストメニュー',
      date: '2026-12-21', time: '11:00', provisional: true
    });
    assert(r.status === 200 && r.body.success && !/📱|⚠️|ℹ️/.test(r.body.message), '仮予約としての新規登録ではLINE通知の案内文言を含まない（確定操作時に別途通知するため）');
  }
  {
    // 上で作成した確定予約を編集すると、change通知の実行結果がメッセージに含まれる
    const r = await hanako.putJson('/api/staff/reservations/' + notifyTestResvId, {
      staffName: '花子', menu: 'テストメニュー（変更後）', date: '2026-12-21', time: '10:30', note: 'LINE通知拡張テスト'
    });
    assert(r.status === 200 && r.body.success && /📱/.test(r.body.message), '予約編集ではLINE通知（change）実行の案内がメッセージに含まれる');
  }
  {
    // 同じ予約をキャンセルすると、cancel通知の実行結果がメッセージに含まれる
    const r = await hanako.del('/api/staff/reservations/' + notifyTestResvId);
    assert(r.status === 200 && r.body.success && /📱/.test(r.body.message), '予約キャンセルではLINE通知（cancel）実行の案内がメッセージに含まれる');
  }
  {
    // オーナー管理画面からの新規登録・編集・キャンセルでも同様にLINE通知結果が含まれる
    const rNew = await ownerFresh.postJson('/api/admin/reservations', {
      realname: '田中 美穂（改）', customerId: 'C0001', staffName: '寿子', menu: 'テストメニュー',
      date: '2026-12-22', time: '10:00'
    });
    assert(rNew.status === 200 && rNew.body.success && /📱/.test(rNew.body.message), 'オーナー管理画面からの新規登録でもLINE通知の案内がメッセージに含まれる');
    const adminResvId = rNew.body.reservationId;

    const rEdit = await ownerFresh.putJson('/api/admin/reservations/' + adminResvId, {
      staffName: '寿子', menu: 'テストメニュー（変更後）', date: '2026-12-22', time: '10:30'
    });
    assert(rEdit.status === 200 && rEdit.body.success && /📱/.test(rEdit.body.message), 'オーナー管理画面からの編集でもLINE通知の案内がメッセージに含まれる');

    const rCancel = await ownerFresh.del('/api/admin/reservations/' + adminResvId);
    assert(rCancel.status === 200 && rCancel.body.success && /📱/.test(rCancel.body.message), 'オーナー管理画面からのキャンセルでもLINE通知の案内がメッセージに含まれる');
  }

  // --------------------------------------------------------------------------
  // 35. お客様予約フォームのキープメンバー／初めての方／既存お客様（キープ以外）の出し分け
  //     （GAS版reservation_form_functions.gsのgetCustomerFormData / getCustomerMenuList_ /
  //     getRule2Notices_ / submitCustomerBooking_body_ の移植。2026-09-23追加）
  //     seed済みテストデータ：C0006=キープメンバー（前回担当:花子・来店15回）、
  //     C0007=初めての方（来店0回）、C0008=既存客・キープ以外（来店3回）
  // --------------------------------------------------------------------------
  console.log('--- 35. お客様予約フォームのキープ／初回／既存客の出し分け ---');
  {
    const r = await fetch(BASE + '/api/store?store=1&cid=C0006').then((res) => res.json());
    assert(r.customer.target === 'keep' && r.customer.theme === 'pink', 'C0006（キープメンバー）はtarget:keep・theme:pinkになる');
    assert(r.customer.menuStaffName === '花子', 'キープメンバーの前回担当スタッフ名（menuStaffName）が返る');
    assert(r.menuItems.some((m) => m.name === 'メンバーコース(90分)'), 'キープメンバーにはメンバー限定メニューが表示される');
    assert(!r.menuItems.some((m) => m.name === '初回限定フェイシャル体験(60分)'), 'キープメンバーには初回限定メニューは表示されない');
    const memberItem = r.menuItems.find((m) => m.name === 'メンバーコース(90分)');
    assert(memberItem && memberItem.isMemberOnly === true, 'メンバー限定メニューにはisMemberOnly:trueが付与される');
    assert(r.notices.some((t) => t.includes('メンバー特典')), 'キープメンバーには「リピーター」向けの注意書きが表示される');
    assert(!r.notices.some((t) => t.includes('初めてご来店')), 'キープメンバーには「初回」向けの注意書きは表示されない');
  }
  {
    const r = await fetch(BASE + '/api/store?store=1&cid=C0007').then((res) => res.json());
    assert(r.customer.target === 'new' && r.customer.theme === 'green', 'C0007（初めての方）はtarget:new・theme:greenになる');
    assert(r.customer.menuStaffName === '', '初めての方にはmenuStaffNameが空で返る');
    // ★2026-09-23追加：C0007はLINE友だち追加のみで本名未確定という現実的な状態を再現した
    //   テストデータ（GAS版webhook_handler.jsのregisterOrUpdateCustomerFromLine_body_と同じく
    //   本名は空欄・LINE表示名のみ設定）。found:trueだが本名（realname）は空のままであることを確認
    assert(r.customer.found === true && r.customer.realname === '' && r.customer.lineName === 'あやか',
      'C0007はLINE友だち追加のみ・本名未確定（realname空欄・lineNameのみ設定）の状態で見つかる');
    assert(r.menuItems.some((m) => m.name === '初回限定フェイシャル体験(60分)'), '初めての方には初回限定メニューが表示される');
    assert(!r.menuItems.some((m) => m.name === 'メンバーコース(90分)'), '初めての方にはメンバー限定メニューは表示されない');
    const featuredItem = r.menuItems.find((m) => m.name === '初回限定フェイシャル体験(60分)');
    assert(featuredItem && featuredItem.isFeatured === true, '初回限定メニューにはisFeatured:trueが付与される');
    assert(r.notices.some((t) => t.includes('初めてご来店')), '初めての方には「初回」向けの注意書きが表示される');
    assert(!r.notices.some((t) => t.includes('メンバー特典')), '初めての方には「リピーター」向けの注意書きは表示されない');
  }
  {
    const r = await fetch(BASE + '/api/store?store=1&cid=C0008').then((res) => res.json());
    assert(r.customer.target === 'visitor' && r.customer.theme === 'green', 'C0008（既存客・キープ以外）はtarget:visitor・theme:greenになる');
    assert(!r.menuItems.some((m) => m.name === '初回限定フェイシャル体験(60分)'),
      '既存客・キープ以外には初回限定メニューは表示されない');
    // ★2026-09-23同日修正：GAS版customer_form.htmlのbuildKeepUpgradeCard/selectKeepUpgrade
    //   移植に伴う仕様変更。既存客・キープ以外にもメンバー限定メニューは「見えるが選択には
    //   キープメンバー変更希望の選択が必要」という形で一覧に含まれるようになった（以前は
    //   完全に除外していたが、GAS版の実際の挙動＝一覧には出すがdisabled-until-upgradeに
    //   合わせて修正）
    const memberItem = r.menuItems.find((m) => m.name === 'メンバーコース(90分)');
    assert(!!memberItem && memberItem.requiresKeepUpgrade === true,
      '既存客・キープ以外にもメンバー限定メニューはrequiresKeepUpgrade:true付きで一覧に含まれる（キープメンバー変更希望を選ぶと選択可能になる想定）');
    assert(r.notices.some((t) => t.includes('メンバー特典')), '既存客・キープ以外にも「リピーター」向けの注意書きが表示される');
  }
  {
    // キープメンバー＋担当者指名あり → 即「確定」・confirm_keepテンプレートで通知
    // ★4章の予約上限チェックのテストで既にC0006（中村さゆり）の確定予約が上限（3件）に
    //   達しているため、ownerOverride:trueで上限チェックを無視して登録する（上限チェック
    //   自体の動作確認は4章で完了済みのため、ここではstatus分岐の確認に専念する）。
    const r = await fetch(BASE + '/api/reservations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store: '1', realname: 'x', staffName: '花子', menu: 'メンバーコース(90分)',
        date: '2026-12-24', time: '14:00', customerId: 'C0006', ownerOverride: true
      })
    }).then((res) => res.json());
    assert(r.success === true && r.status === '確定', 'キープメンバー＋担当者指名ありの予約は即「確定」になる');
    assert(/確定/.test(r.message), '確定時のメッセージには「確定」の文言が含まれる');
  }
  {
    // キープメンバーでも担当者未定（指名なし）なら「仮予約」扱い（GAS版2026-09-02修正の踏襲）
    const r = await fetch(BASE + '/api/reservations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store: '1', realname: 'x', staffName: '未定', menu: 'メンバーコース(90分)',
        date: '2026-12-24', time: '15:00', customerId: 'C0006', ownerOverride: true
      })
    }).then((res) => res.json());
    assert(r.success === true && r.status === '仮予約', 'キープメンバーでも担当者未定（指名なし）の予約は「仮予約」になる');
    assert(/仮予約/.test(r.message), '仮予約時のメッセージには「仮予約」の文言が含まれる');
  }
  {
    // 既存客・キープ以外は担当者を指名しても「仮予約」扱い
    const r = await fetch(BASE + '/api/reservations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store: '1', realname: 'x', staffName: '美咲', menu: 'フェイシャル(60分)',
        date: '2026-12-24', time: '16:00', customerId: 'C0008'
      })
    }).then((res) => res.json());
    assert(r.success === true && r.status === '仮予約', '既存客・キープ以外は担当者を指名しても「仮予約」になる');
  }
  {
    // 顧客ID未連携（一般の来店未経験者の直接入力）も「仮予約」扱い
    const r = await fetch(BASE + '/api/reservations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store: '1', realname: '統合テスト初回太郎', staffName: '花子', menu: '初回限定フェイシャル体験(60分)',
        date: '2026-12-24', time: '17:00'
      })
    }).then((res) => res.json());
    assert(r.success === true && r.status === '仮予約', '顧客ID未連携（cid無し）の予約は「仮予約」になる');
  }

  // --------------------------------------------------------------------------
  // 36. GET /api/reservations の認証必須化（★2026-09-23修正：店舗全体の全予約
  //     （他のお客様の氏名を含む）が未ログインで誰でも取得できてしまっていた
  //     セキュリティ上の不具合の修正確認。GAS版のcustomer_form.htmlにはこのような
  //     店舗全体の予約一覧をお客様へ見せる機能はそもそも存在しない）
  // --------------------------------------------------------------------------
  console.log('--- 36. GET /api/reservationsの認証必須化 ---');
  {
    const r = await anon.get('/api/reservations?store=1');
    assert(r.status === 401, '未ログインでは店舗全体の予約一覧（GET /api/reservations）を取得できない（他のお客様の氏名の露出防止）');
  }
  {
    const r = await hanako.get('/api/reservations');
    assert(r.status === 200 && Array.isArray(r.body.reservations), 'ログイン中のスタッフは自店舗の予約一覧を取得できる（内部利用のためのエンドポイントとして存置）');
  }
  {
    const r = await owner2.get('/api/reservations');
    const anyStore1Only = r.body.reservations.some((res) => res.realname === '田中 美穂（改）');
    assert(r.status === 200 && !anyStore1Only, '他店舗のオーナーには自店舗（store2）の予約のみが返り、store1のデータは含まれない（店舗スコープ確認）');
  }

  // --------------------------------------------------------------------------
  // 37. お客様予約フォームの新規登録・キープメンバー変更希望・1クリックトグル
  //     （★2026-09-23追加：社長からのご指摘「①初めての方の名前がわかる理由・
  //     顧客ID発行ロジックが無い」「③キープメンバーへの変更ロジックが無い」への
  //     対応。GAS版customer_form.htmlの新規登録オーバーレイ・findOrCreateCustomer_
  //     の移植（lib/customerMerge.js registerCustomerFromPublicForm）と、
  //     お客様発信の「キープメンバーへの変更希望」申告（今回の新機能）、
  //     オーナー管理画面「顧客管理」の1クリックトグル（GAS版owner_ui.html相当）の確認。
  // --------------------------------------------------------------------------
  console.log('--- 37. お客様予約フォームの新規登録・キープメンバー変更希望・1クリックトグル ---');
  {
    const r = await anon.postJson('/api/customer-registration', { store: '1' });
    assert(r.status === 400, '姓名未入力の新規登録は400エラーになる');
  }
  {
    const r = await anon.postJson('/api/customer-registration', {
      store: '1', lastName: '統合', firstName: '花子', lastKana: 'トウゴウ', firstKana: 'ハナコ', phone: '090', address: '大分県'
    });
    assert(r.status === 400, '電話番号の形式が不正な新規登録は400エラーになる');
  }
  {
    const r = await anon.postJson('/api/customer-registration', {
      store: '1', lastName: '統合', firstName: '花子', lastKana: 'とうごう', firstKana: 'はなこ', phone: '09099990001', address: '大分県大分市1-1-1'
    });
    assert(r.status === 400, 'フリガナが平仮名の新規登録は400エラーになる（GAS版と同じく全角カタカナのみ許容）');
  }
  let newRegCid = null;
  {
    const r = await anon.postJson('/api/customer-registration', {
      store: '1', lastName: '統合', firstName: '花子', lastKana: 'トウゴウ', firstKana: 'ハナコ', phone: '090-9999-0001', address: '大分県大分市1-1-1'
    });
    assert(r.status === 200 && r.body.success === true && !!r.body.customerId, '必須項目がすべて揃った新規登録は成功し顧客IDが発行される（GAS版findOrCreateCustomer_相当）');
    newRegCid = r.body.customerId;
  }
  {
    const r = await anon.get(`/api/store?store=1&cid=${newRegCid}`);
    assert(r.body.customer.infoConfirmed === true, '新規登録した顧客はinfo_confirmed（登録確定フラグ）がtrueになる');
    assert(r.body.customer.address === '大分県大分市1-1-1', '新規登録した顧客の住所が保存されている');
    assert(r.body.customer.realname === '統合 花子', '新規登録した顧客の氏名が姓＋名（半角スペース区切り）で結合保存されている');
  }
  {
    // 同じ電話番号で再度登録リクエスト → 新規発行ではなく既存の顧客ID（電話番号一致）へ統合される
    const r = await anon.postJson('/api/customer-registration', {
      store: '1', lastName: '統合', firstName: '花子', lastKana: 'トウゴウ', firstKana: 'ハナコ', phone: '09099990001', address: '大分県大分市1-1-1（更新）'
    });
    assert(r.body.success === true && r.body.customerId === newRegCid, '同一電話番号での再登録は新規発行せず既存の顧客IDに統合される（GAS版と同じ電話番号優先の重複判定）');
  }
  {
    // 更新モード：customerId指定・氏名等は未入力 →「キープメンバーへの変更希望」だけを送信できる
    //  （すでに本登録済みの既存客が、再度氏名・住所を入力させられずに希望だけ送れることの確認）
    const r = await anon.postJson('/api/customer-registration', {
      store: '1', customerId: 'C0007', keepMemberRequested: true
    });
    assert(r.status === 200 && r.body.success === true, '本登録が済んでいない顧客でも、customerIdが分かっていればキープメンバー変更希望だけを送信できる（氏名等の再入力は不要）');
  }
  {
    const r = await anon.get('/api/store?store=1&cid=C0007');
    assert(r.body.customer.keepMemberRequested === true, 'キープメンバー変更希望の申告がkeepMemberRequestedへ保存されている');
  }
  {
    // 既に申告済み顧客（シードデータC0008・keep_member_requested=1）はGET /api/storeでも申告済みと分かる
    const r = await anon.get('/api/store?store=1&cid=C0008');
    assert(r.body.customer.keepMemberRequested === true, 'シードデータで申告済みのC0008はkeepMemberRequested:trueで返る（一覧バッジ表示用データの確認）');
  }
  {
    // ★2026-09-23同日修正：社長のご指摘②への対応確認。GAS版customer_form.htmlの
    //   buildKeepUpgradeCard/selectKeepUpgrade相当の挙動：キープメンバー本人（target:'keep'）
    //   には元々メンバー限定メニューが通常表示され、requiresKeepUpgradeは付かない
    //   （既に選択できる状態のため、変更希望を選ぶ必要が無い）
    const r = await anon.get('/api/store?store=1&cid=C0006');
    const memberItem = r.body.menuItems.find((m) => m.name === 'メンバーコース(90分)');
    assert(!!memberItem && memberItem.isMemberOnly === true && !memberItem.requiresKeepUpgrade,
      'キープメンバー本人にはメンバー限定メニューが最初から（requiresKeepUpgrade無しで）選択可能な状態で表示される');
  }
  {
    // --- 1クリックトグル（オーナー管理画面「顧客管理」一覧行から直接ON/OFF） ---
    const r = await anon.postJson(`/api/admin/customers/C0008/toggle-keep-member`, {});
    assert(r.status === 401, '未ログインでは1クリックトグルを操作できない');
  }
  {
    const before = await ownerFresh.get('/api/admin/customers?q=渡辺');
    const beforeVal = !!before.body.customers.find((c) => c.customer_id === 'C0008').is_keep_member;
    assert(beforeVal === false, '（前提確認）C0008はトグル前はキープメンバーではない');

    const r = await ownerFresh.postJson('/api/admin/customers/C0008/toggle-keep-member', {});
    assert(r.status === 200 && r.body.success === true && r.body.isKeepMember === true, 'オーナーが1クリックでキープメンバーをONにできる（GAS版toggleCustomerKeepMember相当）');

    const after = await ownerFresh.get('/api/admin/customers?q=渡辺');
    const afterVal = !!after.body.customers.find((c) => c.customer_id === 'C0008').is_keep_member;
    assert(afterVal === true, 'トグル操作の結果が顧客マスタへ実際に保存されている');

    const r2 = await ownerFresh.postJson('/api/admin/customers/C0008/toggle-keep-member', {});
    assert(r2.status === 200 && r2.body.isKeepMember === false, 'もう一度押すとOFFに戻る（トグル＝反転動作の確認）');
  }
  {
    // 他店舗のオーナーは他店の顧客をトグルできない（店舗スコープ確認）
    const r = await owner2.postJson('/api/admin/customers/C0008/toggle-keep-member', {});
    assert(r.status === 404, '他店舗のオーナーは他店の顧客をトグルできない（店舗スコープ確認）');
  }
  {
    // ★既存の編集モーダル（PUT /api/admin/customers/:id、フルレコード送信）は
    //   引き続き動作し、is_keep_memberも従来どおり変更できる（今回の1クリック
    //   トグル追加により既存の編集モーダル経路が壊れていないことの確認）
    const current = await ownerFresh.get('/api/admin/customers?q=渡辺');
    const c = current.body.customers.find((x) => x.customer_id === 'C0008');
    const r = await ownerFresh.putJson('/api/admin/customers/C0008', {
      realname: c.realname, kana: c.kana, phone: c.phone, totalVisits: c.total_visits,
      staffName: c.staff_name, status: c.status, memo: c.memo,
      isKeepMember: true, optSupport: !!c.opt_support, bookingBlocked: !!c.booking_blocked, notifyEnabled: !!c.notify_enabled
    });
    assert(r.status === 200 && r.body.success === true, '既存の編集モーダル（PUT・フルレコード送信）は1クリックトグル追加後も引き続き動作する');
    const after = await ownerFresh.get('/api/admin/customers?q=渡辺');
    const afterVal = !!after.body.customers.find((x) => x.customer_id === 'C0008').is_keep_member;
    assert(afterVal === true, '編集モーダル経由のキープメンバー変更も正しく保存される（既存の2経路が両方使える確認）');
  }

  // --------------------------------------------------------------------------
  // 38. 社長の本番実機テスト（2026-09-23）で発覚した3点への追加対応の確認
  //     ①電話番号・住所が空欄のままでも予約完走できてしまう不具合の修正
  //     ④（追加要望）LINE連携済みのお客様への通知結果を、お客様本人にも・
  //       確定操作を行うスタッフ/オーナーにも、分かるように表示する
  // --------------------------------------------------------------------------
  console.log('--- 38. 予約フォームの必須項目チェック強化・LINE通知結果の可視化 ---');
  {
    // ★社長ご指摘①：LINE友だち追加のみ・本登録が済んでいない顧客（C0007相当）が、
    //   姓名・フリガナは入力したが電話番号を空欄のまま送信すると、以前（修正前）は
    //   更新モードの検証が緩く、そのまま登録が成立してしまっていた。
    const r = await anon.postJson('/api/customer-registration', {
      store: '1', customerId: 'C0007', lastName: '岡目', firstName: '彩花', lastKana: 'オカメ', firstKana: 'アヤカ'
      // phone・address は未入力のまま
    });
    assert(r.status === 400 && /電話番号/.test(r.body.message || ''),
      '本登録が済んでいない顧客が電話番号を空欄のまま送信すると400エラーになる（社長ご指摘①の修正確認）');
  }
  {
    const r = await anon.postJson('/api/customer-registration', {
      store: '1', customerId: 'C0007', lastName: '岡目', firstName: '彩花', lastKana: 'オカメ', firstKana: 'アヤカ',
      phone: '090-1234-5678'
      // address は未入力のまま
    });
    assert(r.status === 400 && /住所/.test(r.body.message || ''),
      '電話番号はあっても住所が空欄のままだと400エラーになる（社長ご指摘①の修正確認）');
  }
  {
    const before = await anon.get('/api/store?store=1&cid=C0007');
    assert(before.body.customer.infoConfirmed === false, '（前提確認）C0007はこの時点でまだinfo_confirmedがfalse');
  }
  {
    const r = await anon.postJson('/api/customer-registration', {
      store: '1', customerId: 'C0007', lastName: '岡目', firstName: '彩花', lastKana: 'オカメ', firstKana: 'アヤカ',
      phone: '090-1234-5678', address: '大分県大分市希望が丘1-1-1'
    });
    assert(r.status === 200 && r.body.success === true,
      '姓名・フリガナ・電話番号・住所をすべて入力すれば本登録が成功する（空欄チェックが厳しすぎて正常系を壊していないことの確認）');
  }
  {
    const after = await anon.get('/api/store?store=1&cid=C0007');
    assert(after.body.customer.infoConfirmed === true, '必須項目がすべて揃った登録では、登録完了後にinfo_confirmedがtrueになる');
  }
  let notifiedReservationId = null;
  {
    // ★社長ご指摘④（追加要望）：LINE ID連携済みのお客様（C0006・user_id:'U0006'）が
    //   即「確定」となる予約を送信した場合、以前はお客様向けレスポンスに通知結果を
    //   一切含めていなかった（GAS版に倣った設計だったが、社長より「お客様にも通知が
    //   送られたことが分かるように」とのご指摘を受けて表示するよう変更）。
    const r = await anon.postJson('/api/reservations', {
      store: '1', realname: 'x', staffName: '花子', menu: 'メンバーコース(90分)',
      date: '2026-12-24', time: '18:00', customerId: 'C0006', ownerOverride: true
    });
    assert(r.status === 200 && r.body.success === true && r.body.status === '確定', '（前提）キープメンバー＋担当指名ありの予約は確定になる');
    assert(/📱|⚠️/.test(r.body.message),
      'LINE連携済みのお客様への確定予約では、予約完了メッセージにLINE通知結果（📱送信済み／⚠️失敗）が含まれる（社長ご指摘④の対応確認）');
    notifiedReservationId = r.body.reservationId;
  }
  {
    const row = db.prepare('SELECT line_sent FROM reservations WHERE id = ?').get(notifiedReservationId);
    assert(row.line_sent === 1,
      '確定予約の作成時、実際の通知結果に応じてreservations.line_sent列が更新される（以前は常に0固定だった不具合の修正確認）');
  }
  {
    // 顧客ID未連携（cid無し）の予約では、そもそもLINE通知自体が発生しないため、
    // お客様向けメッセージにLINE関連の文言が含まれない（未使用の人に紛らわしい文言を出さない）
    const r = await anon.postJson('/api/reservations', {
      store: '1', realname: '通知確認太郎', staffName: '花子', menu: 'x',
      date: '2026-12-24', time: '19:00'
    });
    assert(r.status === 200 && r.body.success === true && !/📱|⚠️|LINE/.test(r.body.message),
      '顧客ID未連携の予約では、お客様向けメッセージにLINE通知関連の文言が含まれない'
    );
  }
  // ★注記：お客様予約フォーム経由（POST /api/reservations、上のテストで使用）は
  //   GAS版submitCustomerBooking_body_と同じく、仮予約であってもconfirm_provisional
  //   テンプレートで即座に通知する（＝作成時点でline_sentが立つ）。「仮予約→確定操作の
  //   タイミングで初めて通知する」のはスタッフ・オーナーが手動登録する場合のみ
  //   （二重通知を避けるための設計、47-7参照）。そのため、以下の確認は
  //   POST /api/staff/reservations・POST /api/admin/reservations（provisional:true）を使う。
  let notify38ProvisionalIdA = null;
  {
    // ★社長ご指摘④の後半：「仮予約→確定」操作（GAS版confirmReservationStatus_body_相当）
    //   でも、以前は確定操作を行ったスタッフ/オーナーに通知結果が一切表示されていなかった
    //  （fire-and-forgetで結果を待たずに「予約を確定しました」の固定文言のみ返していた）。
    // ★C0007を使う（C0008は37章末の1クリックトグルのテストでkeep_memberに変更済みのため、
    //   ここでは確実に非キープメンバーのままであるC0007を使う）
    const r = await ownerFresh.postJson('/api/admin/reservations', {
      realname: 'x', staffName: '未定', menu: 'フェイシャル(60分)',
      date: '2026-12-25', time: '10:00', customerId: 'C0007', provisional: true
    });
    assert(r.status === 200 && r.body.success === true, '（前提）オーナー管理画面から「仮予約として登録」できる');
    notify38ProvisionalIdA = r.body.reservationId;
    const row = db.prepare('SELECT status, line_sent FROM reservations WHERE id = ?').get(notify38ProvisionalIdA);
    assert(row.status === '仮予約' && row.line_sent === 0,
      '仮予約として登録した時点ではまだ顧客への通知を送っていないため、line_sentは0のまま（二重通知防止の確認）');
  }
  {
    // 仮予約の担当スタッフを設定してから確定操作を行う（未定のままでは確定できない仕様のため）
    const r0 = await ownerFresh.putJson(`/api/admin/reservations/${notify38ProvisionalIdA}`, {
      staffName: '花子', menu: 'フェイシャル(60分)', date: '2026-12-25', time: '10:00'
    });
    assert(r0.status === 200 && r0.body.success === true, '（準備）確定操作の前に担当スタッフを設定する');

    const r = await ownerFresh.postJson(`/api/admin/reservations/${notify38ProvisionalIdA}/confirm`, {});
    assert(r.status === 200 && r.body.success === true, 'オーナー管理画面からの仮予約確定操作が成功する');
    assert(/📱|⚠️|ℹ️/.test(r.body.message),
      'オーナー管理画面での確定操作の結果メッセージに、お客様へのLINE通知結果が含まれる（GAS版confirmReservationStatus_body_相当・社長ご指摘④の対応確認）');

    const row = db.prepare('SELECT line_sent FROM reservations WHERE id = ?').get(notify38ProvisionalIdA);
    assert(row.line_sent === 1,
      '仮予約→確定操作の時点で、この予約について初めて顧客へ通知が送られるため、line_sentがここで1に更新される');
  }
  let notify38ProvisionalIdB = null;
  {
    // スタッフダッシュボード経由（一般スタッフ、オーナー限定ではない）の確定操作でも
    // 同様に通知結果が返ることを確認する
    const r = await ownerFresh.postJson('/api/admin/reservations', {
      realname: 'x', staffName: '花子', menu: 'フェイシャル(60分)',
      date: '2026-12-25', time: '11:00', customerId: 'C0007', provisional: true
    });
    assert(r.status === 200 && r.body.success === true, '（前提）オーナー管理画面から「仮予約として登録」できる（2件目）');
    notify38ProvisionalIdB = r.body.reservationId;
  }
  {
    const r = await ownerFresh.postJson(`/api/staff/reservations/${notify38ProvisionalIdB}/confirm`, {});
    assert(r.status === 200 && r.body.success === true, 'スタッフ用の仮予約確定エンドポイントも成功する');
    assert(/📱|⚠️|ℹ️/.test(r.body.message),
      'スタッフ用の確定操作エンドポイントでも、結果メッセージにLINE通知結果が含まれる');
    const row = db.prepare('SELECT line_sent FROM reservations WHERE id = ?').get(notify38ProvisionalIdB);
    assert(row.line_sent === 1, 'スタッフ用の確定操作でもline_sentが実際の通知結果で更新される');
  }

  // --------------------------------------------------------------------------
  // 39. スタッフ色の保存・サロンダッシュボードの行事表示・スタッフダッシュボードの
  //     月間シフト表まわり（GAS版staff_dashboard.html / calendar_page.htmlの未移植分）
  // --------------------------------------------------------------------------
  console.log('--- 39. スタッフ色・終日行事・月間シフト表・未定予約の表示 ---');
  const fmt39 = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const plus39 = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return fmt39(d); };
  {
    const r = await ownerFresh.get('/api/admin/staff');
    const byName = {};
    (r.body.staff || []).forEach((s) => { byName[s.name] = s.color; });
    assert(byName['寿子'] === 'BLUE' && byName['花子'] === 'RED' && byName['美咲'] === 'GREEN',
      '既存スタッフの表示色が、これまでの自動割り当てと同じ色でstaff.colorに保存されている（見た目が変わらない）');
    assert(Array.isArray(r.body.colorOptions) && r.body.colorOptions.length === 13, 'スタッフ管理画面用に選べる色（GAS版と同じ13色）が返る');
  }
  let staff39Hanako = null;
  {
    const list = await ownerFresh.get('/api/admin/staff');
    staff39Hanako = list.body.staff.find((s) => s.name === '花子');
    const bad = await ownerFresh.putJson(`/api/admin/staff/${staff39Hanako.id}`, {
      name: '花子', nickname: staff39Hanako.nickname, role: staff39Hanako.role, isActive: true, isOwner: false, showInBooking: true, color: 'PINK_NOT_EXIST'
    });
    assert(bad.status === 400, '存在しない色名は400エラーになる');
    const ok = await ownerFresh.putJson(`/api/admin/staff/${staff39Hanako.id}`, {
      name: '花子', nickname: staff39Hanako.nickname, role: staff39Hanako.role, isActive: true, isOwner: false, showInBooking: true, color: 'MAUVE'
    });
    assert(ok.status === 200 && ok.body.success === true, 'オーナーがスタッフの表示色を変更できる');
    const wk = await ownerFresh.get('/api/staff/calendar/week?start=' + plus39(0));
    assert(wk.body.data.staffColors['花子'] === 'MAUVE', '変更した色がサロンダッシュボードの色分けにそのまま反映される');
    assert(wk.body.data.staffColors['寿子'] === 'BLUE', '他のスタッフの色は変わらない（以前の自動割り当てのように全員の色がずれない）');
    // 色の項目を送らない更新（既存の画面・呼び出し元）では色が保持される
    await ownerFresh.putJson(`/api/admin/staff/${staff39Hanako.id}`, {
      name: '花子', nickname: staff39Hanako.nickname, role: staff39Hanako.role, isActive: true, isOwner: false, showInBooking: true
    });
    const after = await ownerFresh.get('/api/admin/staff');
    assert(after.body.staff.find((s) => s.name === '花子').color === 'MAUVE', '色を送らないスタッフ更新では、保存済みの色がそのまま保持される');
    await ownerFresh.putJson(`/api/admin/staff/${staff39Hanako.id}`, {
      name: '花子', nickname: staff39Hanako.nickname, role: staff39Hanako.role, isActive: true, isOwner: false, showInBooking: true, color: 'RED'
    });
  }
  {
    const r = await ownerFresh.postJson('/api/admin/staff', { name: '色テスト新人', pin: '8642' });
    const used = ['BLUE', 'RED', 'GREEN'];
    assert(r.status === 200 && r.body.success === true && r.body.color && !used.includes(r.body.color),
      '色を指定せずにスタッフを新規登録すると、まだ誰も使っていない色が自動で割り当てられる');
  }
  {
    // 終日の行事は allDay:true で返り、時間指定の行事は allDay:false
    const d = plus39(3);
    await ownerFresh.postJson('/api/admin/events', { title: '終日テスト祝日', date: d, startTime: '00:00', endTime: '23:59', restrictBooking: false });
    await ownerFresh.postJson('/api/admin/events', { title: '時間指定テスト', date: d, startTime: '14:00', endTime: '15:00', restrictBooking: true });
    const wk = await ownerFresh.get('/api/staff/calendar/week?start=' + d);
    const evs = wk.body.data.events.filter((e) => e.date === d);
    const allDay = evs.find((e) => e.label === '終日テスト祝日');
    const timed = evs.find((e) => e.label === '時間指定テスト');
    assert(allDay && allDay.allDay === true && !allDay.blockStart, '終日の行事はallDay:trueで返る（列全体を覆うブロックではなく上部の帯として描くため）');
    assert(timed && timed.allDay === false && timed.blockStart && timed.blockEnd, '時間指定の行事はallDay:falseで、予約ブロックの前後時間帯（斜線表示用）も返る');
    assert(Array.isArray(wk.body.data.legendStaff) && wk.body.data.legendStaff.includes('寿子'), '凡例用の在籍スタッフ一覧が返る');
  }
  let undecided39Id = null;
  {
    // 担当「未定」の予約は一般スタッフにも見える（GAS版getWeeklyReservationsと同じ）
    const d = plus39(4);
    const r = await ownerFresh.postJson('/api/admin/reservations', {
      realname: '未定表示テスト', staffName: '未定', menu: 'フェイシャル(60分)', date: d, time: '12:00', provisional: true, ownerOverride: true
    });
    undecided39Id = r.body.reservationId;
    const hr = await hanako.get(`/api/staff/reservations?from=${d}&to=${d}`);
    assert((hr.body.reservations || []).some((x) => x.realname === '未定表示テスト'), '担当が「未定」の予約は一般スタッフの予約一覧にも表示される（誰かが引き受けられるように）');
    const up = await hanako.get('/api/staff/reservations/upcoming');
    assert((up.body.reservations || []).some((x) => x.realname === '未定表示テスト'), '「直近の予約」にも担当未定の予約が表示される');
    const others = (hr.body.reservations || []).filter((x) => x.staff_name !== '花子' && x.staff_name !== '未定');
    assert(others.length === 0, '一般スタッフには他のスタッフが担当する予約は見えない');
    const day = await hanako.get('/api/staff/reservations/day?date=' + d);
    assert((day.body.reservations || []).some((x) => x.realname === '未定表示テスト' && x.end_time === '13:30'), '日別の予約（月間シフト表の詳細）にも未定予約が終了時刻付きで返る');
  }
  {
    // 確定操作で担当スタッフも同時に決める（GAS版confirmReservationStatusのselectedStaffName）
    const r = await ownerFresh.postJson(`/api/staff/reservations/${undecided39Id}/confirm`, { staffName: '美咲' });
    const row = db.prepare('SELECT staff_name, status FROM reservations WHERE id = ?').get(undecided39Id);
    assert(r.status === 200 && r.body.success === true && row.staff_name === '美咲' && row.status === '確定',
      '担当未定の仮予約でも、確定と同時に担当スタッフを指定すれば確定できる（サロンダッシュボードの編集画面から）');
  }
  {
    // 月間シフト表：一般スタッフは本人分のみ、オーナーは全員分＋色付きスタッフ一覧
    const month = plus39(0).slice(0, 7);
    const h = await hanako.get('/api/staff/shifts/monthly?month=' + month);
    assert(h.status === 200 && h.body.shifts.length > 0 && h.body.shifts.every((s) => s.staffName === '花子'), '一般スタッフの月間シフト表は本人のシフトだけが返る');
    const o = await ownerFresh.get('/api/staff/shifts/monthly?month=' + month);
    const names = new Set(o.body.shifts.map((s) => s.staffName));
    assert(names.has('寿子') && names.has('花子') && names.has('美咲'), 'オーナーの月間シフト表は全員分のシフトが返る');
    const hk = (o.body.staffList || []).find((s) => s.name === '花子');
    assert(hk && hk.color && hk.color.startsWith('#'), '月間シフト表のスタッフ一覧に表示色が付いている（サロンダッシュボードと同じ色）');
    const cnt = await ownerFresh.get(`/api/staff/reservations/monthly?month=${month}&staff=${encodeURIComponent('花子')}`);
    assert(cnt.body.staffName === '花子' && typeof cnt.body.pendingDates === 'object', 'オーナーは凡例で選んだスタッフの月間予約件数と、店舗全体の仮予約日を取得できる');
    const hcnt = await hanako.get(`/api/staff/reservations/monthly?month=${month}&staff=${encodeURIComponent('寿子')}`);
    assert(hcnt.body.staffName === '花子', '一般スタッフは他のスタッフの件数を指定しても本人分しか取得できない');
  }
  {
    // オーナーの代理シフト追加・変更（GAS版addShiftRow/saveWeeklyShiftsのオーナー分岐）
    const d = plus39(2); // 3日以内でもオーナーは可
    const add = await ownerFresh.postJson('/api/staff/shifts', { date: d, startTime: '11:00', endTime: '15:00', staffName: '美咲' });
    const row = db.prepare("SELECT * FROM shift_master WHERE store_id = 1 AND staff_name = '美咲' AND shift_date = ? AND start_time = '11:00'").get(d);
    assert(add.status === 200 && add.body.success === true && !!row, 'オーナーはスタッフダッシュボードから他のスタッフのシフトを代理で追加できる');
    const put = await ownerFresh.putJson(`/api/staff/shifts/${row.id}`, { startTime: '11:00', endTime: '16:00' });
    assert(put.status === 200 && put.body.success === true, 'オーナーは他のスタッフのシフトも変更できる');
    const hadd = await hanako.postJson('/api/staff/shifts', { date: plus39(20), startTime: '10:00', endTime: '12:00', staffName: '美咲' });
    const leaked = db.prepare("SELECT 1 FROM shift_master WHERE store_id = 1 AND staff_name = '美咲' AND shift_date = ? AND start_time = '10:00'").get(plus39(20));
    assert(hadd.status === 200 && !leaked, '一般スタッフがstaffNameを指定しても、他のスタッフのシフトは追加されない（本人分として扱われる）');
    const hput = await hanako.putJson(`/api/staff/shifts/${row.id}`, { startTime: '10:00', endTime: '16:00' });
    assert(hput.status === 404, '一般スタッフは他のスタッフのシフトを変更できない');
    const chk = await ownerFresh.get(`/api/staff/shifts/booking-check?staffName=${encodeURIComponent('花子')}&date=${plus39(4)}`);
    assert(chk.status === 200 && typeof chk.body.hasBooking === 'boolean', 'シフト削除前の予約確認（GAS版checkShiftBooking相当）が使える');
    const ownerWeek = await ownerFresh.get(`/api/staff/shifts?from=${plus39(0)}&to=${plus39(6)}`);
    const wn = new Set((ownerWeek.body.shifts || []).map((s) => s.staff_name));
    assert(wn.size >= 2 && Array.isArray(ownerWeek.body.staffList), 'オーナーの週間シフトは全員分が返る（一般スタッフは従来どおり本人分のみ）');
  }

  // --------------------------------------------------------------------------
  // 40. シフト連携の一括反映・氏名変更時のシフト初期値クリーンアップ・
  //     シフト重複防止・DB一覧ビューア（2026-09-23追加）
  // --------------------------------------------------------------------------
  console.log('--- 40. シフト連携の修正とDB一覧ビューア ---');
  {
    // ①一括シフト反映：範囲内の歯抜けを日次メンテナンスで補完できる（README §50-2①の修正確認）
    const gapFrom = '2026-10-15';
    const gapTo = '2026-11-05';
    db.prepare("DELETE FROM shift_master WHERE store_id = 1 AND shift_date BETWEEN ? AND ?").run(gapFrom, gapTo);
    const before = db.prepare("SELECT COUNT(*) c FROM shift_master WHERE store_id = 1 AND shift_date BETWEEN ? AND ?").get(gapFrom, gapTo).c;
    assert(before === 0, '（前提）意図的に作った歯抜け期間にはシフトマスタの行が無い');
    const run = await ownerFresh.postJson('/api/admin/maintenance/run-daily', {});
    assert(run.status === 200 && run.body.success === true && run.body.shiftsExpanded > 0 && run.body.daysBackfilled > 0,
      '日次メンテナンスが範囲全体（今日〜SHIFT_EXPAND_DAYS日先）の歯抜けを一括で補完する（以前は1日分しか展開されなかった不具合の修正）');
    const after = db.prepare("SELECT COUNT(*) c FROM shift_master WHERE store_id = 1 AND shift_date BETWEEN ? AND ?").get(gapFrom, gapTo).c;
    assert(after > 0, '歯抜け期間にシフトマスタの行が復元されている');
    const runAgain = await ownerFresh.postJson('/api/admin/maintenance/run-daily', {});
    assert(runAgain.status === 200 && runAgain.body.shiftsExpanded === 0, '既に埋まっている期間へ再実行しても重複追加されない（歯抜けのみ補完する設計の確認）');
  }
  {
    // ②氏名変更時、旧名義の「シフト初期値」（shift_templates）だけが削除される（履歴は残す）
    const staffRow = db.prepare("SELECT id, name FROM staff WHERE store_id = 1 AND name = '美咲'").get();
    const beforeTpl = db.prepare('SELECT COUNT(*) c FROM shift_templates WHERE store_id = 1 AND staff_name = ?').get(staffRow.name).c;
    const beforeHistory = db.prepare('SELECT COUNT(*) c FROM shift_master WHERE store_id = 1 AND staff_name = ?').get(staffRow.name).c;
    const rename = await ownerFresh.putJson(`/api/admin/staff/${staffRow.id}`, { name: '美咲改名テスト', nickname: '', role: 'スタッフ' });
    assert(rename.status === 200 && rename.body.success === true, '氏名変更が成功する');
    if (beforeTpl > 0) {
      assert(rename.body.renamedTemplatesRemoved === beforeTpl, '旧名義のシフト初期値（shift_templates）が氏名変更時に削除される（README §50-2②の修正確認）');
    }
    const afterTplOld = db.prepare('SELECT COUNT(*) c FROM shift_templates WHERE store_id = 1 AND staff_name = ?').get(staffRow.name).c;
    assert(afterTplOld === 0, '旧名義のシフト初期値はもう残っていない');
    const afterHistoryOld = db.prepare('SELECT COUNT(*) c FROM shift_master WHERE store_id = 1 AND staff_name = ?').get(staffRow.name).c;
    assert(afterHistoryOld === beforeHistory, '過去のシフトマスタ（履歴）は氏名変更で書き換えられない（GAS版と同じ、あえて残す設計）');
    // 元に戻す（他のテストへの影響を避けるため）
    await ownerFresh.putJson(`/api/admin/staff/${staffRow.id}`, { name: '美咲', nickname: '', role: 'スタッフ' });
  }
  {
    // ③完全に同一内容のシフトの重複登録を拒否する（README §50-2⑤の修正確認）
    const body = { staffName: '寿子', date: '2026-12-05', startTime: '10:00', endTime: '12:00' };
    const r1 = await ownerFresh.postJson('/api/admin/shifts', body);
    assert(r1.status === 200 && r1.body.success === true, '（前提）シフトを1件追加できる');
    const r2 = await ownerFresh.postJson('/api/admin/shifts', body);
    assert(r2.status === 400 && r2.body.success === false, '完全に同一内容（スタッフ・日付・開始・終了）のシフトは重複登録を拒否される');
    const r3 = await ownerFresh.postJson('/api/staff/shifts', { date: '2026-12-06', startTime: '09:00', endTime: '11:00' });
    assert(r3.status === 200, '（前提）スタッフ用エンドポイントでもシフトを1件追加できる');
    const r4 = await ownerFresh.postJson('/api/staff/shifts', { date: '2026-12-06', startTime: '09:00', endTime: '11:00' });
    assert(r4.status === 400, 'スタッフ用エンドポイント（/api/staff/shifts）でも同一内容の重複登録を拒否する');
  }
  {
    // ④DB一覧ビューア：admin権限のみアクセス可能で、店舗スコープを外れたテーブルは拒否され、
    //   認証情報（pin_hash等）は最初から返らない（社長ご要望「DBを直接視覚的にみれるページ」）
    const tabs = await ownerFresh.get('/api/admin/db-viewer/tables');
    assert(tabs.status === 200 && Array.isArray(tabs.body.tables) && tabs.body.tables.some((t) => t.key === 'reservations') && tabs.body.tables.some((t) => t.key === 'customers'),
      'DB一覧ビューアが閲覧可能なテーブル一覧（予約・顧客含む）を返す');
    const staffCols = tabs.body.tables.find((t) => t.key === 'staff').columns;
    assert(!staffCols.includes('pin_hash') && !staffCols.includes('pin_salt'), 'DB一覧ビューアのスタッフテーブルにはPINのハッシュ・ソルトが含まれない（認証情報を生で扱わない方針の確認）');
    const badTable = await ownerFresh.get('/api/admin/db-viewer/sqlite_master');
    assert(badTable.status === 400, 'ホワイトリストに無いテーブル名は拒否される（SQLインジェクション・想定外テーブル露出の防止）');
    const rows = await ownerFresh.get('/api/admin/db-viewer/reservations?limit=5&sort=reservation_date&dir=ASC');
    assert(rows.status === 200 && rows.body.rows.length <= 5 && rows.body.sort === 'reservation_date' && rows.body.dir === 'ASC', 'DB一覧ビューアが並べ替え・件数制限付きで予約データを返す');
    const searched = await ownerFresh.get('/api/admin/db-viewer/customers?q=' + encodeURIComponent('花子'));
    assert(searched.status === 200 && (searched.body.rows || []).every((r) => JSON.stringify(r).includes('花子')), 'DB一覧ビューアの検索（あいまい一致）が機能する');
    const owner2Session = makeSession();
    await owner2Session.loginAs('2', '岩田町オーナー', '4321');
    const scoped = await owner2Session.get('/api/admin/db-viewer/staff');
    assert(scoped.status === 200 && (scoped.body.rows || []).every((r) => !String(r.name || '').includes('寿子')), '他店舗のオーナーは自店舗のデータしかDB一覧ビューアで見られない（店舗スコープの確認）');
    const staffSession = makeSession();
    await staffSession.loginAs('1', '花子', '6789'); // 花子（is_owner=0）
    const denied = await staffSession.get('/api/admin/db-viewer/reservations');
    assert(denied.status === 401 || denied.status === 403, '一般スタッフ（オーナー権限なし）はDB一覧ビューアにアクセスできない');
  }

  // --------------------------------------------------------------------------
  // 41. シフト初期値の「祝」パターン対応・予約登録の空き時間確認ボタン
  //     （README §51-7で見送っていた残り2点、2026-09-23追加）
  // --------------------------------------------------------------------------
  console.log('--- 41. シフト初期値の「祝」パターンと空き時間確認 ---');
  {
    // ①シフト初期値のday_of_week=7（祝）：休業日（restrict_booking=1のevents）に一致する
    //   日は、通常の曜日パターンより優先して「祝」パターンが使われる
    const holiday = db.prepare("SELECT event_date FROM events WHERE store_id = 1 AND restrict_booking = 1 LIMIT 1").get();
    const holidayDate = holiday.event_date;
    const holidayDow = new Date(holidayDate + 'T00:00:00').getDay();
    const badDow = await ownerFresh.postJson('/api/admin/settings/shift-templates', { staffName: '寿子', dayOfWeek: 8, startTime: '09:00', endTime: '10:00' });
    assert(badDow.status === 400, 'dayOfWeekは0〜7の範囲外だと拒否される（7=祝が上限）');
    const normalTpl = await ownerFresh.postJson('/api/admin/settings/shift-templates', { staffName: '寿子', dayOfWeek: holidayDow, startTime: '09:00', endTime: '12:00' });
    assert(normalTpl.status === 200, '（前提）休業日と同じ曜日の通常パターンを登録できる');
    const holidayTpl = await ownerFresh.postJson('/api/admin/settings/shift-templates', { staffName: '寿子', dayOfWeek: 7, startTime: '13:00', endTime: '15:00' });
    assert(holidayTpl.status === 200, '（前提）「祝」（dayOfWeek=7）パターンを登録できる');
    db.prepare("DELETE FROM shift_master WHERE store_id = 1 AND staff_name = '寿子' AND shift_date = ?").run(holidayDate);
    const run = await ownerFresh.postJson('/api/admin/maintenance/run-daily', {});
    assert(run.status === 200 && run.body.success === true, '（前提）日次メンテナンスが成功する');
    const row = db.prepare("SELECT start_time, end_time FROM shift_master WHERE store_id = 1 AND staff_name = '寿子' AND shift_date = ?").get(holidayDate);
    assert(row && row.start_time === '13:00' && row.end_time === '15:00', '休業日には通常の曜日パターンではなく「祝」パターンが優先して展開される（GAS版applyShiftInitialValues_のholidaySet相当）');
    // 後片付け（他のテストへの影響を避ける）
    db.prepare("DELETE FROM shift_templates WHERE store_id = 1 AND staff_name = '寿子' AND day_of_week IN (?, 7)").run(holidayDow);
    db.prepare("DELETE FROM shift_master WHERE store_id = 1 AND staff_name = '寿子' AND shift_date = ?").run(holidayDate);
  }
  {
    // ②GET /api/staff/available-slots：一般スタッフには空いている枠のみ（理由付き）、
    //   オーナーには全時間帯を警告ラベル付きで返す（GAS版getAvailableSlots相当）
    const d = plus39(4); // 花子に2件予約あり（4日後の午前）
    const staffView = await hanako.get(`/api/staff/available-slots?staffName=${encodeURIComponent('花子')}&date=${d}`);
    assert(staffView.status === 200 && staffView.body.success === true && Array.isArray(staffView.body.slots) && staffView.body.isOwner === false,
      '一般スタッフが空き時間を確認できる');
    assert(staffView.body.slots.some((s) => s.disabled === true && s.reason), '一般スタッフの表示には予約済み等の理由付きで選択できない枠が含まれる');
    assert(!staffView.body.slots.some((s) => s.warn), '一般スタッフの表示には警告付きの選択可能枠（オーナー専用機能）は含まれない');
    const ownerView = await ownerFresh.get(`/api/staff/available-slots?staffName=${encodeURIComponent('花子')}&date=${d}`);
    assert(ownerView.status === 200 && ownerView.body.isOwner === true, 'オーナーが空き時間を確認できる');
    assert(ownerView.body.slots.length > staffView.body.slots.length, 'オーナーには全時間帯（シフト外・満床等も含む）が返る（一般スタッフより選択肢が多い）');
    assert(ownerView.body.slots.some((s) => s.warn === true && s.warnLabel), 'オーナーの表示には警告ラベル付きで選択可能な枠が含まれる');
    const noDate = await ownerFresh.get('/api/staff/available-slots?staffName=花子');
    assert(noDate.status === 400, 'dateを省略すると400エラーになる');
  }

  // --------------------------------------------------------------------------
  // 42. GAS版との表示順の一致調査・修正（2026-09-23追加、社長指摘「表形式にした時の
  //     表示順」への対応の第一弾）
  // --------------------------------------------------------------------------
  console.log('--- 42. GAS版との表示順の一致（スタッフ管理一覧） ---');
  {
    // GAS版getAdminStaffList（admin_ui_functions.js）はスタッフマスタシートを
    // 上から順に読むだけでソートをかけない（＝スタッフを追加した順のまま表示）。
    // Node版がORDER BY is_active DESC, name ASCで並べ替えていたのを、id ASC
    // （＝登録順）に修正した。既存シードだと寿子→花子→美咲の順で登録されているため、
    // 名前のアルファベット/かな順（花子→寿子→美咲）とは一致しないことを利用して確認する。
    const list = await ownerFresh.get('/api/admin/staff');
    assert(list.status === 200, 'スタッフ管理一覧を取得できる');
    const names = list.body.staff.map((s) => s.name);
    const ids = list.body.staff.map((s) => s.id);
    const sortedIds = [...ids].sort((a, b) => a - b);
    assert(JSON.stringify(ids) === JSON.stringify(sortedIds), 'スタッフ管理一覧はid昇順（＝マスタへの登録順）で返る（GAS版は名前順ソートをしていないため）');
    assert(names[0] === '寿子', '先頭は最初に登録されたスタッフ（寿子）になる（name ASCなら花子が先頭になるはずなので区別できる）');
  }

  // --------------------------------------------------------------------------
  // 43. 日次LINEレポート4種（前日リマインダー・朝レポート・夕方レポート・
  //     スタッフ翌日予約通知）と、予約データの月次表示（2026-09-23追加）
  //     GAS版triggers.jsの時間主導トリガー4種の移植（lib/dailyReports.js）。
  // --------------------------------------------------------------------------
  console.log('--- 43. 日次LINEレポート4種・予約データの月次表示 ---');
  const fmt43 = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const tomorrow43 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1); return fmt43(d); })();
  {
    // フィクスチャ：オーナー（寿子）・花子にLINE userIdを付与し、美咲は未付与のまま
    // （「LINE未連携のスタッフはスキップされる」ことを区別して確認するため）
    db.prepare("UPDATE staff SET line_user_id = 'Utest_owner_43' WHERE store_id = 1 AND name = '寿子'").run();
    db.prepare("UPDATE staff SET line_user_id = 'Utest_hanako_43' WHERE store_id = 1 AND name = '花子'").run();
    db.prepare("UPDATE staff SET line_user_id = NULL WHERE store_id = 1 AND name = '美咲'").run();

    // 明日・花子担当・LINE連携済み顧客（C0001等既存の顧客IDを使わず、テスト用に
    // customer_idをNULLのまま、user_idだけ直接指定した予約を1件作る）
    const insertTomorrow = db.prepare(`
      INSERT INTO reservations (store_id, realname, user_id, staff_name, menu, reservation_date, reservation_time, status, editor)
      VALUES (1, 'リマインドテスト太郎', 'Utest_customer_43', '花子', 'フェイシャル', ?, '10:00', '確定', 'テスト投入')
    `);
    const info = insertTomorrow.run(tomorrow43);
    const reservationId = info.lastInsertRowid;

    // ①前日リマインダー：対象1件を送信し、reminder_sentが1になる
    const r1 = await ownerFresh.postJson('/api/admin/reports/day-before-reminders', {});
    assert(r1.status === 200 && r1.body.success === true, '前日リマインダーAPIが成功する');
    assert(r1.body.date === tomorrow43, '前日リマインダーの対象日が明日になっている');
    const found1 = r1.body.results.find((x) => x.reservationId === reservationId);
    assert(!!found1, '今回作成した明日の予約が前日リマインダーの送信対象に含まれる');
    const afterFlag = db.prepare('SELECT reminder_sent FROM reservations WHERE id = ?').get(reservationId);
    assert(afterFlag.reminder_sent === 1, '送信後、reminder_sentが1に更新される（GAS版COL_Y_REMINDER相当）');

    // ★2026-09-23追加：予約台帳（reservations-view.html）の🔔マークが参照する
    //   GET /api/admin/reservationsのレスポンスにも、更新後のreminder_sentが
    //   正しく反映されていることを確認（値自体は52章以前から返っていたが、
    //   画面側に表示ロジックが無かったため今回追加。データ経路の確認として残す）
    const listAfter = await ownerFresh.get(`/api/admin/reservations?limit=200&offset=0&from=${tomorrow43}&to=${tomorrow43}`);
    const listedRow = listAfter.body.reservations.find((x) => x.id === reservationId);
    assert(!!listedRow && listedRow.reminder_sent === 1, '予約一覧APIのレスポンスにもreminder_sent=1が反映されている（予約台帳の🔔マーク表示に使うデータ経路）');

    // 再実行すると、既に送付済みのため対象から外れる（重複送信防止）
    const r1b = await ownerFresh.postJson('/api/admin/reports/day-before-reminders', {});
    const found1b = r1b.body.results.find((x) => x.reservationId === reservationId);
    assert(!found1b, '既に送付済みの予約は次回実行で対象から除外される（GAS版と同じ重複防止）');

    // ②スタッフ翌日予約通知：花子（LINE連携済み）が通知対象に含まれ、美咲（未連携）は
    //    そもそも明日の予約が無いので対象外
    const r2 = await ownerFresh.postJson('/api/admin/reports/staff-tomorrow-schedule', {});
    assert(r2.status === 200 && r2.body.success === true, 'スタッフ翌日予約通知APIが成功する');
    const hanakoResult = r2.body.results.find((x) => x.staffName === '花子');
    assert(!!hanakoResult && hanakoResult.simulated === true, '花子（LINE連携済み）宛に通知が送られる（トークン未設定のためシミュレーション扱い）');

    // ③朝レポート：オーナー（寿子、LINE連携済み）に送信される
    const r3 = await ownerFresh.postJson('/api/admin/reports/morning', {});
    assert(r3.status === 200 && r3.body.success === true, '朝レポートAPIが成功する');
    assert(r3.body.sentTo === 1 && r3.body.results[0].staffName === '寿子', '朝レポートはis_owner=1かつLINE連携済みのスタッフ（寿子）へ送信される');

    // ④夕方レポート：①本日確定・要確認リクエスト②未確定の仮予約③スタッフ翌日予約通知（相乗り）の3部構成
    const r4 = await ownerFresh.postJson('/api/admin/reports/evening', {});
    assert(r4.status === 200 && r4.body.success === true, '夕方レポートAPIが成功する');
    assert(r4.body.mainReport && r4.body.mainReport.success === true, '夕方レポート①本日確定・要確認リクエストの部が成功する');
    assert(r4.body.pendingReport && r4.body.pendingReport.success === true, '夕方レポート②未確定の仮予約の部が成功する');
    assert(r4.body.staffSchedule && r4.body.staffSchedule.success === true, '夕方レポート③スタッフ翌日予約通知（相乗り）の部が成功する（GAS版sendEveningReportToOwnerの構成を踏襲）');

    // ⑤一般スタッフ（オーナー権限なし）はレポート配信APIを呼べない
    const denied = await hanako.postJson('/api/admin/reports/morning', {});
    assert(denied.status === 401 || denied.status === 403, '一般スタッフはLINEレポート配信APIを実行できない（オーナー限定）');

    // 後片付け
    db.prepare('DELETE FROM reservations WHERE id = ?').run(reservationId);
    db.prepare("UPDATE staff SET line_user_id = NULL WHERE store_id = 1 AND name IN ('寿子', '花子')").run();
  }
  {
    // ⑥予約データの月次表示（社長要望「過去の予約データを月次毎に表示する機能」）：
    //   既存のGET /api/admin/reservationsのfrom/toパラメータを使い、当月の予約だけに
    //   絞り込めることを確認する（public/admin/reservations-view.htmlの月選択プルダウンが
    //   内部で呼ぶのと同じAPI呼び出し）。GAS版のような月次アーカイブ処理は行わない方針
    //   （SQLiteは行数・パフォーマンス制約が薄いため全件reservationsテーブルに残す）。
    const now = new Date();
    const y = now.getFullYear(); const m = String(now.getMonth() + 1).padStart(2, '0');
    const from = `${y}-${m}-01`;
    const to = fmt43(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    const monthView = await ownerFresh.get(`/api/admin/reservations?limit=200&offset=0&from=${from}&to=${to}`);
    assert(monthView.status === 200, '月範囲（from/to）を指定した予約データ取得ができる');
    assert(monthView.body.reservations.every((r) => r.reservation_date >= from && r.reservation_date <= to), '月範囲で絞り込んだ結果は全件その月の日付に収まっている');
  }

  // --------------------------------------------------------------------------
  // 44. 常設スケジューラ（lib/scheduler.js、2026-09-23追加）
  //     社長指摘「オーナー管理画面からの手動送信ボタンとして実装ではこまります」を受けて
  //     node-cronによる自動実行に置き換えた。cronの実発火自体は自動テストで検証しにくいため、
  //     ①新規設定値（4種の時刻ルール）がstore_id=1・2両方に既定値で入っていること
  //     ②スケジューラがエクスポートするgetRuleHour（時刻判定ロジック本体）が
  //     rules値・既定値フォールバックの両方で正しく動くこと、を直接呼び出して確認する。
  // --------------------------------------------------------------------------
  console.log('--- 44. 常設スケジューラ（日次配信の自動実行時刻設定） ---');
  {
    const expectedDefaults = {
      DAILY_MAINTENANCE_HOUR: 5,
      MORNING_REPORT_HOUR: 8,
      EVENING_REPORT_HOUR: 20,
      REMINDER_HOUR: 18
    };
    [1, 2].forEach((storeId) => {
      Object.entries(expectedDefaults).forEach(([ruleId, defaultHour]) => {
        const row = db.prepare('SELECT value FROM rules WHERE store_id = ? AND rule_id = ?').get(storeId, ruleId);
        assert(!!row, `store_id=${storeId}に${ruleId}のルール行が存在する（db/init.jsのシード or lib/migrate.jsの補完）`);
        assert(Number(row.value) === defaultHour, `store_id=${storeId}の${ruleId}は既定値${defaultHour}になっている`);
      });
    });

    // getRuleHour: rules値がある場合はその値を使う
    assert(getRuleHour(engine, 1, 'REMINDER_HOUR', 99) === 18, 'getRuleHourはrules値（18時）を正しく返す');

    // getRuleHour: 未知のrule_idの場合はデフォルト値にフォールバックする
    assert(getRuleHour(engine, 1, 'NOT_A_REAL_RULE_ID', 12) === 12, 'getRuleHourは値が無いルールIDに対してデフォルト値へフォールバックする');

    // ルール値を変更すると、getRuleHourの戻り値もすぐに反映される（店舗別に変更可能な設計の確認）
    const putRes = await ownerFresh.putJson('/api/admin/settings/rules/REMINDER_HOUR', { value: '19' });
    assert(putRes.status === 200, 'オーナーはREMINDER_HOURの値を設定画面から変更できる');
    assert(getRuleHour(engine, 1, 'REMINDER_HOUR', 99) === 19, 'ルール値変更後、getRuleHourは新しい値（19時）を返す（常設スケジューラが次回チェック時に使う値と同じ経路）');
    // 元に戻す（他のテスト・実運用のデフォルトに影響しないように）
    db.prepare("UPDATE rules SET value = '18' WHERE store_id = 1 AND rule_id = 'REMINDER_HOUR'").run();

    // 店舗をまたいだ設定は独立している（store_id=2のREMINDER_HOURはstore_id=1の変更の影響を受けない）
    assert(getRuleHour(engine, 2, 'REMINDER_HOUR', 99) === 18, '店舗ごとの実行時刻設定は独立している（store_id=1の変更がstore_id=2に影響しない）');

    // 一般スタッフはルール値を変更できない（オーナー限定、他の設定変更系エンドポイントと同じ方針）
    const deniedPut = await hanako.putJson('/api/admin/settings/rules/REMINDER_HOUR', { value: '10' });
    assert(deniedPut.status === 401 || deniedPut.status === 403, '一般スタッフはスケジューラの実行時刻設定を変更できない（オーナー限定）');
  }

  // --------------------------------------------------------------------------
  // 45. ログインUI（名前タイル→PIN）・統一タイルメニュー・サロン端末（GAS版ST099相当）の権限分岐
  //     （GAS版 login_modal_partial.html / loginStaff_ / top_page.html の移植。README 57章）
  // --------------------------------------------------------------------------
  console.log('--- 45. ログインUI・統一メニュー・サロン端末の権限分岐 ---');
  const tiles45 = await makeSession().get('/api/auth/login-staff?store=1');
  const tile45 = (name) => ((tiles45.body && tiles45.body.staff) || []).find((t) => t.name === name);
  {
    const names = (tiles45.body.staff || []).map((t) => t.name);
    assert(tiles45.status === 200 && tiles45.body.success === true && tiles45.body.store.id === 1,
      'ログイン画面用の名前タイル一覧（GAS版getStaffLoginList相当）を未ログインで取得できる');
    assert(['寿子', '花子', '美咲', 'サロン端末'].every((n) => names.includes(n)), 'タイル一覧に在籍中のスタッフ全員とサロン端末が並ぶ');
    assert(names[names.length - 1] === 'サロン端末' && tile45('サロン端末').isTerminal === true && tile45('花子').isTerminal === false,
      'サロン端末のタイルは末尾に置かれ、isTerminal:trueで区別できる');
    const keys = Object.keys(tiles45.body.staff[0]).sort().join(',');
    assert(keys === 'id,isTerminal,name', 'タイル一覧はid・name・isTerminalだけを返す（権限やPINの有無など内部情報は未ログインに見せない）');
  }
  {
    const r = await makeSession().get('/api/auth/login-staff?store=iwatamachi-test');
    const names = (r.body.staff || []).map((t) => t.name);
    assert(r.status === 200 && names.length === 1 && names[0] === '岩田町オーナー', 'slug指定でその店舗のスタッフだけがタイルに出る（他店のスタッフは混ざらない）');
  }
  {
    const r = await makeSession().get('/api/auth/login-staff?store=no-such-store');
    assert(r.status === 404 && r.body.success === false, '存在しない店舗を指定するとタイル一覧は404（既定店舗のタイルにすり替わらない）');
  }
  {
    const ins = db.prepare(`INSERT INTO staff (store_id, name, role, is_active, pin_hash, pin_salt) VALUES (1, '退職済みタイル45', 'スタッフ', 0, 'x', 'y')`).run();
    const r = await makeSession().get('/api/auth/login-staff?store=1');
    assert(!(r.body.staff || []).some((t) => t.name === '退職済みタイル45'), '在籍中フラグOFFのスタッフはタイルに出ない');
    db.prepare('DELETE FROM staff WHERE id = ?').run(ins.lastInsertRowid);
  }
  {
    const r = await makeSession().postJson('/api/auth/login', { store: '1', pin: '5678' });
    assert(r.status === 400 && r.body.success === false, '旧方式（店舗＋PINのみ、staffIdなし）のログインは400で受け付けない');
  }
  {
    const r = await makeSession().postJson('/api/auth/login', { staffId: tile45('花子').id, pin: '5678', store: '1' });
    assert(r.status === 401, '選んだ本人と違うスタッフ（寿子）のPINではログインできない（staffIdで本人を特定してから照合）');
  }
  {
    const r = await makeSession().postJson('/api/auth/login', { staffId: tile45('花子').id, pin: '6789', store: 'iwatamachi-test' });
    assert(r.status === 401, 'staffIdと店舗の組み合わせが食い違うとログインできない');
  }
  {
    // PIN重複：旧方式では同じ店舗に同じPINの人がいると誰でログインしたか区別できなかった
    const { createPinHash } = require('../lib/auth');
    const h = createPinHash('6789');
    const dupId = db.prepare(`INSERT INTO staff (store_id, name, role, is_active, show_in_booking, pin_hash, pin_salt) VALUES (1, 'PIN重複45', 'スタッフ', 1, 0, ?, ?)`).run(h.hash, h.salt).lastInsertRowid;
    const sDup = makeSession();
    const rDup = await sDup.loginAs('1', 'PIN重複45', '6789');
    const sHana = makeSession();
    const rHana = await sHana.loginAs('1', '花子', '6789');
    assert(rDup.status === 200 && rDup.body.name === 'PIN重複45' && rHana.status === 200 && rHana.body.name === '花子',
      '同じ店舗でPINが重複していても、タイルで選んだ本人としてログインできる');
    db.prepare('DELETE FROM staff WHERE id = ?').run(dupId);
  }

  const owner45 = makeSession();
  const staff45 = makeSession();
  const term45 = makeSession();
  {
    const rO = await owner45.loginAs('1', '寿子', '5678');
    const rS = await staff45.loginAs('1', '花子', '6789');
    const rT = await term45.loginAs('1', 'サロン端末', '0000');
    assert(rO.status === 200 && rO.body.isOwner === true && rO.body.isTerminal === false && rO.body.staffId === tile45('寿子').id,
      'オーナー：ログイン結果が {staffId, name, role, isOwner:true, isTerminal:false}（GAS版loginStaff_の戻り値相当）');
    assert(rS.status === 200 && rS.body.isOwner === false && rS.body.isTerminal === false, '一般スタッフ：isOwner:false・isTerminal:false');
    assert(rT.status === 200 && rT.body.isOwner === true && rT.body.isTerminal === true && rT.body.role === 'サロン端末',
      'サロン端末：GAS版ST099と同じくisOwner:true扱いで、isTerminal:trueが付く');
    const me = await term45.get('/api/auth/me');
    assert(me.status === 200 && me.body.staff.isTerminal === true && me.body.staff.isOwner === true, '/api/auth/meでもサロン端末であることが分かる（統一メニューの出し分けに使う）');
  }

  // 統一タイルメニュー（GAS版top_page.html）の3段階の出し分けに対応する実際の権限
  {
    const page = await fetch(BASE + '/menu.html').then((r) => r.text());
    assert(page.includes("tier: 'all'") && page.includes("tier: 'owner'") && page.includes("tier: 'trueOwner'") &&
      page.includes('me.isOwner && !me.isTerminal'), '統一タイルメニュー（/menu.html）が存在し、全員／isOwner／isOwnerかつ端末以外の3段階で出し分ける');
    // GAS版の「カレンダー（koyomi）」＝サロン端末が日常使う全スタッフ共有カレンダー（README 57-7）
    assert(/name: 'カレンダー（koyomi）'[^}]*href: '\/staff\/calendar\.html'/.test(page), '「カレンダー（koyomi）」タイルは共有カレンダー（/staff/calendar.html）を開く');
    const login = await fetch(BASE + '/admin/login.html').then((r) => r.text());
    assert(login.includes('/api/auth/login-staff') && login.includes('staffId: selectedStaff.id') && login.includes("'/menu.html'"),
      'ログイン画面は名前タイル→PINの2段階で、ログイン後は統一メニューへ進む');
  }
  {
    // ①全員共通：カレンダー（koyomi＝スタッフダッシュボード）・サロンダッシュボードのAPI
    for (const [label, sess] of [['一般スタッフ', staff45], ['サロン端末', term45], ['オーナー', owner45]]) {
      const a = await sess.get('/api/staff/reservations/upcoming');
      const b = await sess.get('/api/staff/calendar/week?start=' + fmtDate_(new Date()));
      assert(a.status === 200 && b.status === 200, `${label}：カレンダー（スタッフダッシュボード）・サロンダッシュボードのAPIを使える`);
    }
  }
  {
    // ②isOwner（端末含む）：顧客マスタ閲覧・予約データ閲覧
    const sC = await staff45.get('/api/admin/customers?limit=5');
    const sR = await staff45.get('/api/admin/reservations');
    assert(sC.status === 401 && sR.status === 401, '一般スタッフ：顧客マスタ閲覧・予約データ閲覧のAPIは使えない（401）');
    const tC = await term45.get('/api/admin/customers?limit=200');
    const tR = await term45.get('/api/admin/reservations');
    const tM = await term45.get('/api/admin/customers/merge-candidates');
    assert(tC.status === 200 && tR.status === 200 && tM.status === 200, 'サロン端末：顧客マスタ閲覧・予約データ閲覧の画面が使うAPIは使える');
    assert(!(tC.body.customers || []).some((c) => c.realname === '岩田 花子'), 'サロン端末でも他店舗の顧客は見えない（店舗スコープは維持）');
    const oC = await owner45.get('/api/admin/customers?limit=5');
    assert(oC.status === 200, 'オーナー：顧客マスタ閲覧のAPIを使える');
  }
  {
    // ③isOwnerかつ端末以外：オーナー設定・スタッフ管理、顧客/予約の編集
    const custRow = db.prepare(`SELECT customer_id FROM customers WHERE store_id = 1 AND is_deleted = 0 LIMIT 1`).get();
    const resvRow = db.prepare(`SELECT id FROM reservations WHERE store_id = 1 AND realname != 'キャンセル' LIMIT 1`).get();
    const denied = [
      ['GET', '/api/admin/settings/rules'], ['PUT', '/api/admin/settings/rules/REMINDER_HOUR'],
      ['GET', '/api/admin/settings/menu'], ['GET', '/api/admin/settings/line'],
      ['GET', '/api/admin/staff'], ['POST', '/api/admin/staff'], ['PUT', '/api/admin/staff/1'],
      ['GET', '/api/admin/dashboard'], ['GET', '/api/admin/shifts'],
      ['POST', '/api/admin/customers'], ['PUT', '/api/admin/customers/' + (custRow ? custRow.customer_id : 'X')],
      ['DELETE', '/api/admin/customers/' + (custRow ? custRow.customer_id : 'X')],
      ['POST', '/api/admin/reservations'], ['PUT', '/api/admin/reservations/' + (resvRow ? resvRow.id : 1)],
      ['DELETE', '/api/admin/reservations/' + (resvRow ? resvRow.id : 1)],
      ['GET', '/api/admin/db-viewer/tables'], ['GET', '/api/admin/plan'], ['GET', '/api/admin/sessions/staff-list'],
      ['POST', '/api/admin/import-sample-data']
    ];
    const results = [];
    for (const [method, path] of denied) {
      const r = await term45.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify({ value: '10', name: 'x', pin: '1234' }) });
      results.push([method, path, r.status, r.body && r.body.error]);
    }
    const bad = results.filter((x) => x[2] !== 403 || x[3] !== 'forbidden_for_shared_terminal');
    assert(bad.length === 0, 'サロン端末：オーナー設定・スタッフ管理・顧客/予約の編集など真のオーナー専用APIはすべて403' + (bad.length ? ' ' + JSON.stringify(bad) : ''));
    const stillThere = custRow && db.prepare('SELECT is_deleted FROM customers WHERE store_id = 1 AND customer_id = ?').get(custRow.customer_id);
    assert(!stillThere || stillThere.is_deleted === 0, 'サロン端末からの顧客削除要求で実際にデータが消えていない');
    const oS = await owner45.get('/api/admin/staff');
    const oR = await owner45.get('/api/admin/settings/rules');
    assert(oS.status === 200 && oR.status === 200, 'オーナー（端末以外）：スタッフ管理・オーナー設定のAPIを使える');
  }

  // サロン端末はカレンダー経由の予約編集でオーナーと同等の全権限（社長確認済みの意図的な設計）
  const date45 = fmtDate_(new Date(Date.now() + 700 * 86400000));
  {
    const rS = await staff45.postJson('/api/staff/reservations', { realname: '端末テスト45', staffName: '寿子', menu: 'フェイシャル(60分)', date: date45, time: '10:00' });
    assert(rS.status === 403, '一般スタッフ：他スタッフ担当の予約は登録できない（比較用）');
    const rT = await term45.postJson('/api/staff/reservations', { realname: '端末テスト45', staffName: '寿子', menu: 'フェイシャル(60分)', date: date45, time: '10:00' });
    assert(rT.status === 200 && rT.body.success === true, 'サロン端末：他スタッフ（寿子）担当の予約を登録できる');
    const row = db.prepare(`SELECT id, editor FROM reservations WHERE store_id = 1 AND realname = '端末テスト45'`).get();
    const rPutS = await staff45.putJson(`/api/staff/reservations/${row.id}`, { staffName: '寿子', menu: 'フェイシャル(90分)', date: date45, time: '10:00', note: '' });
    assert(rPutS.status === 403, '一般スタッフ：他スタッフ担当の予約は編集できない（比較用）');
    const rPutT = await term45.putJson(`/api/staff/reservations/${row.id}`, { staffName: '寿子', menu: 'フェイシャル(90分)', date: date45, time: '10:00', note: '端末で変更' });
    assert(rPutT.status === 200 && rPutT.body.success === true, 'サロン端末：他スタッフ担当の予約を編集できる');
    const edited = db.prepare('SELECT menu, editor FROM reservations WHERE id = ?').get(row.id);
    assert(edited.menu === 'フェイシャル(90分)' && edited.editor === 'サロン端末', '端末での編集はeditor＝「サロン端末」として記録される');
    const rDelT = await term45.del(`/api/staff/reservations/${row.id}`);
    assert(rDelT.status === 200 && rDelT.body.success === true, 'サロン端末：他スタッフ担当の予約をキャンセルできる');
    db.prepare(`DELETE FROM reservations WHERE store_id = 1 AND realname IN ('端末テスト45', 'キャンセル') AND reservation_date = ?`).run(date45);
  }
  {
    // 予約上限：一般スタッフはハードブロック、端末はオーナーと同じく確認のうえ超過登録できる
    const limitDate = (n) => fmtDate_(new Date(Date.now() + (710 + n) * 86400000));
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT INTO reservations (store_id, realname, staff_name, menu, reservation_date, reservation_time, status) VALUES (1, '上限テスト客45', '花子', 'テストメニュー', ?, '10:00', '確定')`).run(limitDate(i));
    }
    const rW = await term45.postJson('/api/staff/reservations', { realname: '上限テスト客45', staffName: '花子', menu: 'フェイシャル(60分)', date: limitDate(3), time: '10:00' });
    assert(rW.status === 200 && rW.body.isLimitWarning === true, 'サロン端末：予約上限超過はオーナーと同じく確認メッセージ（ハードブロックされない）');
    const rOv = await term45.postJson('/api/staff/reservations', { realname: '上限テスト客45', staffName: '花子', menu: 'フェイシャル(60分)', date: limitDate(3), time: '10:00', ownerOverride: true });
    assert(rOv.status === 200 && rOv.body.success === true, 'サロン端末：ownerOverrideで上限を超えて登録できる');
    db.prepare(`DELETE FROM reservations WHERE store_id = 1 AND realname = '上限テスト客45'`).run();
  }
  {
    // 予約枠ブロック（イベント）：サロンダッシュボードから端末でも登録・削除できる
    const rS = await staff45.postJson('/api/admin/events', { title: '端末ブロック45', date: date45, startTime: '09:00', endTime: '12:00', restrictBooking: true });
    assert(rS.status === 401, '一般スタッフ：予約枠ブロック（イベント）は登録できない（比較用）');
    const rT = await term45.postJson('/api/admin/events', { title: '端末ブロック45', date: date45, startTime: '09:00', endTime: '12:00', restrictBooking: true });
    assert(rT.status === 200 && rT.body.success === true, 'サロン端末：予約枠ブロック（イベント）を登録できる');
    const rD = await term45.del(`/api/admin/events/${rT.body.eventId}`);
    assert(rD.status === 200 && rD.body.success === true, 'サロン端末：予約枠ブロック（イベント）を削除できる');
  }

  // サロン端末は「人」ではないので、予約対象スタッフ・シフト表・凡例には出さない
  {
    const st = await makeSession().get('/api/store?store=1');
    assert(!(st.body.staffList || []).some((s) => s.realName === 'サロン端末'), 'お客様予約フォームの担当者一覧にサロン端末は出ない');
    const sh = await owner45.get(`/api/staff/shifts?from=${date45}&to=${date45}`);
    assert(sh.status === 200 && (sh.body.staffList || []).length > 0 && !(sh.body.staffList || []).some((s) => s.name === 'サロン端末'), 'シフト表の対象スタッフにサロン端末は出ない');
    const wk = await owner45.get('/api/staff/calendar/week?start=' + date45);
    assert(!(wk.body.data.legendStaff || []).includes('サロン端末'), 'サロンダッシュボードの担当者凡例にサロン端末は出ない');
    const rShift = await owner45.postJson('/api/admin/shifts', { staffName: 'サロン端末', date: date45, startTime: '10:00', endTime: '18:00' });
    assert(rShift.status === 400 || rShift.status === 404, 'サロン端末にはシフトを登録できない');
  }

  // スタッフ管理：オーナーが端末アカウントを追加・設定できる
  {
    const list = await owner45.get('/api/admin/staff');
    const t = (list.body.staff || []).find((s) => s.name === 'サロン端末');
    assert(!!t && t.is_shared_terminal === 1 && t.is_owner === 1 && t.show_in_booking === 0, 'スタッフ管理一覧でサロン端末はis_shared_terminal=1（オーナー扱い・予約フォーム非表示）');
    const add = await owner45.postJson('/api/admin/staff', { name: '2号端末45', pin: '2468', isSharedTerminal: true, isOwner: false, showInBooking: true });
    const row = db.prepare('SELECT * FROM staff WHERE id = ?').get(add.body.staffId);
    assert(add.status === 200 && row.is_shared_terminal === 1 && row.is_owner === 1 && row.show_in_booking === 0 && row.color === null,
      'サロン端末として登録すると、指定に関わらずオーナー扱い・予約フォーム非表示・表示色なしに揃う');
    const s2 = makeSession();
    const r2 = await s2.loginAs('1', '2号端末45', '2468');
    const r2d = await s2.get('/api/admin/staff');
    assert(r2.status === 200 && r2.body.isTerminal === true && r2d.status === 403, '追加した端末アカウントでもログインでき、スタッフ管理には入れない');
    const upd = await owner45.putJson(`/api/admin/staff/${row.id}`, { name: '2号端末45', role: 'サロン端末', isOwner: false, showInBooking: true, isActive: true });
    const row2 = db.prepare('SELECT is_shared_terminal, is_owner, show_in_booking FROM staff WHERE id = ?').get(row.id);
    assert(upd.status === 200 && row2.is_shared_terminal === 1 && row2.is_owner === 1 && row2.show_in_booking === 0,
      '端末フラグを送らない更新では端末設定が保持され、オーナー扱い・予約フォーム非表示も維持される');
    const off = await owner45.putJson(`/api/admin/staff/${row.id}`, { name: '2号端末45', role: 'スタッフ', isOwner: false, showInBooking: false, isActive: false, isSharedTerminal: false });
    const row3 = db.prepare('SELECT is_shared_terminal, is_owner FROM staff WHERE id = ?').get(row.id);
    assert(off.status === 200 && row3.is_shared_terminal === 0 && row3.is_owner === 0, '端末フラグをOFFにすると通常のスタッフ扱いに戻せる');
    db.prepare('DELETE FROM staff WHERE id = ?').run(row.id);
    const self = await owner45.putJson(`/api/admin/staff/${tile45('寿子').id}`, { name: '寿子', role: 'オーナー', isOwner: true, isActive: true, isSharedTerminal: true });
    const selfRow = db.prepare('SELECT is_shared_terminal FROM staff WHERE id = ?').get(tile45('寿子').id);
    assert(self.status === 400 && selfRow.is_shared_terminal === 0, 'ログイン中の自分自身をサロン端末に切り替えることはできない（オーナー画面に入れなくなる事故防止）');
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
