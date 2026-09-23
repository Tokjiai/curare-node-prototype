// ============================================================================
// lib/customerMerge.js
// 顧客マスタの重複統合（マージ）機能。GAS版のcustomer_merge_functions.gs
// （mergeCustomerRows_・getMergeCandidates・manualMergeCustomers 相当）を移植。
//
// GAS版は「LINE Webhook・お客様予約フォーム・スタッフ手入力」など複数の入口で
// 顧客が新規作成されるたびに自動で重複を検知していたが、このNode試作版では
// 顧客の作成経路がCSV取込（顧客IDはGAS側で発行済み）のみのため、
// 「作成時に自動検知する」のではなく「電話番号が一致する現行データをいつでも
// スキャンできる」方式に置き換えている。統合・見送りの結果は同じ形で記録する。
// ============================================================================

'use strict';

// 電話番号を数字だけに正規化する（ハイフン・全角等を無視して比較するため）
function normalizePhoneDigits(tel) {
  if (!tel) return '';
  return String(tel).replace(/[^\d]/g, '');
}

// ----------------------------------------------------------------------------
// findMergeCandidates(db, storeId)
//   店舗内のアクティブな顧客を電話番号でグルーピングし、同一電話番号なのに
//   顧客IDが異なる組み合わせを重複候補として返す（見送り済みの組み合わせは除外）。
// ----------------------------------------------------------------------------
function findMergeCandidates(db, storeId) {
  const rows = db.prepare(
    'SELECT customer_id, realname, kana, phone, line_name, user_id, total_visits, memo FROM customers WHERE store_id = ? AND is_deleted = 0'
  ).all(storeId);

  const byPhone = new Map();
  for (const row of rows) {
    const digits = normalizePhoneDigits(row.phone);
    if (!digits) continue;
    if (!byPhone.has(digits)) byPhone.set(digits, []);
    byPhone.get(digits).push(row);
  }

  const dismissed = new Set(
    db.prepare('SELECT customer_id_a, customer_id_b FROM customer_merge_dismissals WHERE store_id = ?').all(storeId)
      .map((d) => `${d.customer_id_a}::${d.customer_id_b}`)
  );

  const candidates = [];
  for (const [digits, group] of byPhone.entries()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [x, y] = [group[i], group[j]].sort((a, b) => (a.customer_id < b.customer_id ? -1 : 1));
        const key = `${x.customer_id}::${y.customer_id}`;
        if (dismissed.has(key)) continue;
        candidates.push({
          reason: '電話番号一致',
          phone: digits,
          customerA: x,
          customerB: y
        });
      }
    }
  }
  return candidates;
}

// ----------------------------------------------------------------------------
// mergeCustomerRecords(db, storeId, keepCustomerId, mergeCustomerId, staffName)
//   keep側の空欄だけをmerge側の値で補完し（既存の値は上書きしない）、
//   merge側は論理削除（is_deleted=1）する。GAS版のmergeCustomerRows_相当。
// ----------------------------------------------------------------------------
function mergeCustomerRecords(db, storeId, keepCustomerId, mergeCustomerId, staffName) {
  const getRow = db.prepare('SELECT * FROM customers WHERE store_id = ? AND customer_id = ? AND is_deleted = 0');
  const keep = getRow.get(storeId, keepCustomerId);
  const merge = getRow.get(storeId, mergeCustomerId);

  if (!keep || !merge) {
    return { success: false, message: '対象の顧客データが見つかりません（' + (!keep ? keepCustomerId : mergeCustomerId) + '）' };
  }

  const fill = {};
  if (!keep.kana && merge.kana) fill.kana = merge.kana;
  if (!keep.phone && merge.phone) fill.phone = merge.phone;
  if (!keep.line_name && merge.line_name) fill.line_name = merge.line_name;
  if (!keep.user_id && merge.user_id) fill.user_id = merge.user_id;
  if (!keep.realname && merge.realname) fill.realname = merge.realname;
  if (!keep.memo && merge.memo) fill.memo = merge.memo;
  if (!keep.first_visit_date && merge.first_visit_date) fill.first_visit_date = merge.first_visit_date;
  // 来店回数は両方の合算にする（統合前提が「同一人物の重複登録」であるため）
  const mergedVisits = (keep.total_visits || 0) + (merge.total_visits || 0);

  const setClauses = Object.keys(fill).map((col) => `${col} = @${col}`);
  setClauses.push('total_visits = @total_visits', 'updated_at = CURRENT_TIMESTAMP');

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE customers SET ${setClauses.join(', ')}
      WHERE store_id = @store_id AND customer_id = @customer_id
    `).run({ ...fill, total_visits: mergedVisits, store_id: storeId, customer_id: keepCustomerId });

    db.prepare(`
      UPDATE customers SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE store_id = ? AND customer_id = ?
    `).run(storeId, mergeCustomerId);
  });
  txn();

  console.log(`✅ 顧客統合完了: ${mergeCustomerId} → ${keepCustomerId}（実行: ${staffName || '不明'}）`);
  return {
    success: true,
    message: `統合しました（${mergeCustomerId} の情報を ${keepCustomerId} に統合し、${mergeCustomerId} は削除済みにしました）`
  };
}

// ----------------------------------------------------------------------------
// issueNextCustomerId(db, storeId)
//   「C0001」形式の顧客IDを、店舗内の既存最大値+1で発行する共通ヘルパー。
//   findOrCreateCustomerFromLine・createCustomerManually・registerCustomerFromPublicForm
//   の3箇所で同じ採番ロジックが重複していたため、2026-09-23にここへ集約した。
// ----------------------------------------------------------------------------
function issueNextCustomerId(db, storeId) {
  const rows = db.prepare(
    `SELECT customer_id FROM customers WHERE store_id = ? AND customer_id LIKE 'C%'`
  ).all(storeId);
  let maxNum = 0;
  rows.forEach((row) => {
    const m = /^C(\d+)$/.exec(row.customer_id);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > maxNum) maxNum = num;
    }
  });
  return 'C' + String(maxNum + 1).padStart(4, '0');
}

// ----------------------------------------------------------------------------
// ★2026-09-21追加：findOrCreateCustomerFromLine(db, storeId, lineUserId, lineName)
//   GAS版webhook_handler.gsのregisterOrUpdateCustomerFromLine_ /
//   customer_merge_functions.gsのfindOrCreateCustomer_の一部移植。
//   LINEのfollowイベント（友だち追加）を受け取ったときに、その場で顧客マスタへ
//   自動登録する。ファイルの冒頭コメントにある通り、これまでNode版の顧客作成経路は
//   CSV取込（顧客IDはGAS側で発行済み）のみだったが、これが初めての「Node版自身が
//   新しい顧客IDを発行して新規作成する」経路になる。
//
//   【GAS版からの簡略化】GAS版はLINE userId一致に加え、電話番号＋フリガナ一致でも
//   既存行への自動バックフィルを行い、電話番号のみ一致／フリガナのみ一致の場合は
//   重複候補として記録していたが、このプロトタイプではLINE友だち追加の時点では
//   お客様の電話番号・フリガナが分からない（LINEの表示名しか取得できない）ため、
//   その部分の突合は行わない。電話番号を伴う重複は、既存のfindMergeCandidates
//   （スキャン方式）が後からカバーする
//
//   戻り値：{ customerId, isNew }
// ----------------------------------------------------------------------------
function findOrCreateCustomerFromLine(db, storeId, lineUserId, lineName) {
  const existing = db.prepare(
    'SELECT customer_id FROM customers WHERE store_id = ? AND user_id = ?'
  ).get(storeId, lineUserId);
  if (existing) {
    return { customerId: existing.customer_id, isNew: false };
  }

  const newCid = issueNextCustomerId(db, storeId);

  // ★GAS版同様、本名が未確定（LINE表示名しか分からない）新規行は一覧で見つけやすい
  //   よう非アクティブ分類にしておく。予約受付・LINE通知には影響しない表示専用の区分。
  db.prepare(`
    INSERT INTO customers
      (store_id, customer_id, realname, kana, line_name, user_id, total_visits, status, notify_enabled)
    VALUES
      (?, ?, '', '', ?, ?, 0, 'inactive', 1)
  `).run(storeId, newCid, lineName || '', lineUserId);

  console.log(`✅ 顧客新規登録（LINE友だち追加）: ${lineName || '(表示名取得失敗)'} / ${newCid}`);
  return { customerId: newCid, isNew: true };
}

// ----------------------------------------------------------------------------
// createCustomerManually(db, storeId, data)
//   GAS版registerCustomer_body_（reservation_form_functions.gs）の移植。スタッフが
//   顧客マスタへ直接、新規顧客を登録する（お客様予約フォームを介さない・電話予約や
//   来店受付時の運用を想定）。2026-09-22追加。
//
//   GAS版の挙動をそのまま踏襲：
//   ① 本名の重複チェック（同じ店舗内に同姓同名が既にいれば拒否）
//   ② ただしLINE USER IDが指定されていて、それが既存の顧客行と一致する場合は
//      「重複」として拒否せず、その既存行（LINE友だち追加で仮登録されていた行など）
//      に本名などを書き込んで本登録に更新する（findOrCreateCustomerFromLineが
//      Webhookで作った仮登録の続きとして扱うため）
//   ③ 「キープメンバーとして登録する」チェックがオンなら来店回数の初期値を1にする
//      （GAS版と同じ、通常来店実績があるお客様を新規に台帳へ移す想定のため）
// ----------------------------------------------------------------------------
function createCustomerManually(db, storeId, data) {
  const realname = String(data.realname || '').trim();
  if (!realname) {
    return { success: false, status: 400, message: '本名は必須です' };
  }
  if (/[\s　]/.test(realname)) {
    return { success: false, status: 400, message: '本名はスペースなしで入力してください' };
  }
  const kana = String(data.kana || '').trim();
  if (/[\s　]/.test(kana)) {
    return { success: false, status: 400, message: 'フリガナはスペースなしで入力してください' };
  }
  const lineName = String(data.lineName || '').trim();
  const userId = String(data.userId || '').trim();
  const isKeepMember = !!data.isKeepMember;

  // ② LINE USER IDが既存行と一致する場合は、その行を本登録に更新する
  if (userId) {
    const existing = db.prepare(
      'SELECT customer_id FROM customers WHERE store_id = ? AND user_id = ? AND is_deleted = 0'
    ).get(storeId, userId);
    if (existing) {
      db.prepare(`
        UPDATE customers SET
          realname = ?, kana = ?, line_name = COALESCE(NULLIF(?, ''), line_name),
          is_keep_member = ?, total_visits = CASE WHEN ? = 1 AND total_visits = 0 THEN 1 ELSE total_visits END,
          status = 'active', updated_at = CURRENT_TIMESTAMP
        WHERE store_id = ? AND customer_id = ?
      `).run(realname, kana, lineName, isKeepMember ? 1 : 0, isKeepMember ? 1 : 0, storeId, existing.customer_id);
      return { success: true, customerId: existing.customer_id, merged: true };
    }
  }

  // ① 本名の重複チェック（①のLINE一致に該当しなかった場合のみ）
  const dup = db.prepare(
    'SELECT customer_id FROM customers WHERE store_id = ? AND realname = ? AND is_deleted = 0'
  ).get(storeId, realname);
  if (dup) {
    return { success: false, status: 409, message: `この本名はすでに登録されています：${realname}` };
  }

  // 新規発行：共通の採番ヘルパー（issueNextCustomerId）を使う
  const newCid = issueNextCustomerId(db, storeId);
  const initialVisits = isKeepMember ? 1 : 0;

  db.prepare(`
    INSERT INTO customers
      (store_id, customer_id, realname, kana, line_name, user_id, total_visits, is_keep_member, status, notify_enabled)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)
  `).run(storeId, newCid, realname, kana, lineName, userId, initialVisits, isKeepMember ? 1 : 0);

  return { success: true, customerId: newCid, merged: false };
}

// ----------------------------------------------------------------------------
// ★2026-09-23追加：registerCustomerFromPublicForm(db, storeId, data)
//   お客様予約フォーム（public/index.html）からの「新規登録」を移植。
//   GAS版customer_form.htmlの新規登録オーバーレイ（g0r）→
//   reservation_form_functions.js registerNewCustomer_body_ →
//   customer_merge_functions.gs findOrCreateCustomer_ 相当のロジック。
//
//   【GAS版との違い・設計判断】
//   ・GAS版は姓/名/フリガナ姓/フリガナ名の4分割フィールドだが、Node版の顧客マスタは
//     GAS版移植前からrealname/kanaが単一フィールドの設計になっている。このため
//     このフォームだけ4分割で入力を受け取り、この関数の内部で
//     `${lastName} ${firstName}`（半角スペース1つ）に結合してから保存する。
//     ※createCustomerManuallyのスペース禁止バリデーションとは別経路のため抵触しない。
//   ・重複判定（dedup）は「①指定されたcustomerIdが実在すればそれを使う
//     （更新モード）→②電話番号が一致する既存行があればそれを使う（GAS版の
//     findOrCreateCustomer_と同じ優先順位）→③どちらもなければ新規発行」の順。
//     createCustomerManuallyと違い、本名の重複だけでは拒否しない
//     （公開フォームで同姓同名の別人が別顧客として登録できないと困るため）。
//   ・「更新モード」（data.customerIdが指定され、かつ実在する行の場合）は、
//     氏名・フリガナ・電話番号・住所を「入力されたものだけ」上書きし、空欄は
//     既存値を保持する。これにより、既に登録済み（info_confirmed=1）の
//     お客様が「キープメンバーへの変更希望」チェックだけを送信するケース
//     （氏名等の再入力を求めない）にも同じ関数で対応できる。
//   ・「新規登録モード」（customerId未指定 or 該当行なし）は、姓名・フリガナ・
//     電話番号・住所をすべて必須とし、GAS版と同じ全角チェック（氏名は半角文字
//     不可、フリガナは全角カタカナのみ）・電話番号形式チェックを行う。
//   ・保存時にinfo_confirmed=1をセットする（GAS版の「情報確定フラグ」相当）。
//   ・keepMemberRequested（true/false/undefined）が指定された場合のみ
//     keep_member_requested列を更新する（undefinedなら現状維持）。
//
//   戻り値：{ success, customerId, message? } または { success:false, status, message }
// ----------------------------------------------------------------------------
const NAME_FULLWIDTH_RE = /^[^\x01-\x7E･-ﾟ]+$/; // GAS版と同じ：半角文字（半角カナ含む）を含まないこと
const KANA_FULLWIDTH_RE = /^[ァ-ヶー　]+$/; // GAS版と同じ：全角カタカナ・長音・全角スペースのみ
const PHONE_RE = /^0\d{9,10}$/; // GAS版と同じ：先頭0・10～11桁（ハイフン除去後）

function registerCustomerFromPublicForm(db, storeId, data) {
  const customerIdInput = String(data.customerId || '').trim();
  const existing = customerIdInput
    ? db.prepare('SELECT * FROM customers WHERE store_id = ? AND customer_id = ? AND is_deleted = 0').get(storeId, customerIdInput)
    : null;

  const lastName = String(data.lastName || '').trim();
  const firstName = String(data.firstName || '').trim();
  const lastKana = String(data.lastKana || '').trim();
  const firstKana = String(data.firstKana || '').trim();
  const phoneRaw = String(data.phone || '').trim();
  const phoneDigits = phoneRaw.replace(/-/g, '');
  const address = String(data.address || '').trim();
  const hasKeepRequestField = Object.prototype.hasOwnProperty.call(data, 'keepMemberRequested');
  const keepMemberRequested = hasKeepRequestField ? !!data.keepMemberRequested : undefined;

  const anyNameFieldGiven = !!(lastName || firstName || lastKana || firstKana || phoneRaw || address);

  if (existing) {
    // --- 更新モード：入力された項目だけ検証・上書き。全欄空でも
    //     「キープメンバー希望のみ変更」として成立させる ---
    if (anyNameFieldGiven) {
      if (lastName || firstName) {
        if (!lastName || !firstName) {
          return { success: false, status: 400, message: '姓・名は両方入力してください' };
        }
        if (!NAME_FULLWIDTH_RE.test(lastName) || !NAME_FULLWIDTH_RE.test(firstName)) {
          return { success: false, status: 400, message: '姓・名は全角で入力してください' };
        }
      }
      if (lastKana || firstKana) {
        if (!lastKana || !firstKana) {
          return { success: false, status: 400, message: 'フリガナ姓・フリガナ名は両方入力してください' };
        }
        if (!KANA_FULLWIDTH_RE.test(lastKana) || !KANA_FULLWIDTH_RE.test(firstKana)) {
          return { success: false, status: 400, message: 'フリガナは全角カタカナで入力してください' };
        }
      }
      if (phoneRaw && !PHONE_RE.test(phoneDigits)) {
        return { success: false, status: 400, message: '電話番号の形式が正しくありません' };
      }
    }

    const fields = {};
    if (lastName && firstName) fields.realname = `${lastName} ${firstName}`;
    if (lastKana && firstKana) fields.kana = `${lastKana} ${firstKana}`;
    if (phoneRaw) fields.phone = phoneDigits;
    if (address) fields.address = address;
    // 氏名・電話番号が今回そろった、または既に揃っていれば情報確定とみなす
    const willHaveRealname = fields.realname || existing.realname;
    const willHavePhone = fields.phone || existing.phone;
    if (willHaveRealname && willHavePhone) fields.info_confirmed = 1;
    if (keepMemberRequested !== undefined) fields.keep_member_requested = keepMemberRequested ? 1 : 0;

    if (Object.keys(fields).length > 0) {
      const setClauses = Object.keys(fields).map((col) => `${col} = @${col}`);
      setClauses.push('updated_at = CURRENT_TIMESTAMP');
      db.prepare(`
        UPDATE customers SET ${setClauses.join(', ')}
        WHERE store_id = @store_id AND customer_id = @customer_id
      `).run({ ...fields, store_id: storeId, customer_id: existing.customer_id });
    }
    return { success: true, customerId: existing.customer_id };
  }

  // --- 新規登録モード：GAS版customer_form.htmlの必須項目一式を検証 ---
  if (!lastName || !firstName) {
    return { success: false, status: 400, message: '姓・名は必須です' };
  }
  if (!NAME_FULLWIDTH_RE.test(lastName) || !NAME_FULLWIDTH_RE.test(firstName)) {
    return { success: false, status: 400, message: '姓・名は全角で入力してください' };
  }
  if (!lastKana || !firstKana) {
    return { success: false, status: 400, message: 'フリガナ姓・フリガナ名は必須です' };
  }
  if (!KANA_FULLWIDTH_RE.test(lastKana) || !KANA_FULLWIDTH_RE.test(firstKana)) {
    return { success: false, status: 400, message: 'フリガナは全角カタカナで入力してください' };
  }
  if (!phoneRaw) {
    return { success: false, status: 400, message: '電話番号は必須です' };
  }
  if (!PHONE_RE.test(phoneDigits)) {
    return { success: false, status: 400, message: '電話番号の形式が正しくありません（例：09012345678）' };
  }
  if (!address) {
    return { success: false, status: 400, message: 'ご住所は必須です' };
  }

  const realname = `${lastName} ${firstName}`;
  const kana = `${lastKana} ${firstKana}`;

  // ②電話番号一致の既存行があれば、そこへ本登録として書き込む（GAS版findOrCreateCustomer_の優先順位）
  const byPhone = db.prepare(
    'SELECT customer_id FROM customers WHERE store_id = ? AND phone = ? AND is_deleted = 0'
  ).get(storeId, phoneDigits);
  if (byPhone) {
    db.prepare(`
      UPDATE customers SET
        realname = ?, kana = ?, address = ?, info_confirmed = 1,
        keep_member_requested = CASE WHEN ? IS NULL THEN keep_member_requested ELSE ? END,
        status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE store_id = ? AND customer_id = ?
    `).run(
      realname, kana, address,
      keepMemberRequested === undefined ? null : (keepMemberRequested ? 1 : 0),
      keepMemberRequested === undefined ? null : (keepMemberRequested ? 1 : 0),
      storeId, byPhone.customer_id
    );
    console.log(`✅ 顧客新規登録（お客様予約フォーム・電話番号一致で既存行に統合）: ${realname} / ${byPhone.customer_id}`);
    return { success: true, customerId: byPhone.customer_id };
  }

  // ③新規発行
  const newCid = issueNextCustomerId(db, storeId);
  db.prepare(`
    INSERT INTO customers
      (store_id, customer_id, realname, kana, phone, address, line_name, user_id, total_visits, status, info_confirmed, keep_member_requested, notify_enabled)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', 1, ?, 1)
  `).run(
    storeId, newCid, realname, kana, phoneDigits, address,
    String(data.lineName || '').trim(), String(data.userId || '').trim(),
    keepMemberRequested ? 1 : 0
  );
  console.log(`✅ 顧客新規登録（お客様予約フォーム）: ${realname} / ${newCid}`);
  return { success: true, customerId: newCid };
}

module.exports = {
  normalizePhoneDigits,
  findMergeCandidates,
  mergeCustomerRecords,
  findOrCreateCustomerFromLine,
  createCustomerManually,
  registerCustomerFromPublicForm
};
