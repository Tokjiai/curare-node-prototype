// ============================================================================
// public/app.js
// 予約プロトタイプ用フロントエンド（素のJS + fetch APIのみ。フレームワーク不要）
// ============================================================================

const state = {
  storeSlug: 'kurare-kotobuki',
  staffId: 'nopref',
  date: null,
  selectedZone: null,
  selectedTime: null,
  mainMenuItems: [],
  optionMenuItems: [],
  selectedOptionIds: new Set(),
  // ★2026-09-22追加：GAS版customer_form.htmlのcid連携（URLの?cid=顧客IDで
  //   本人特定・受付拒否チェックを行う仕組み）。詳細はloadStoreInfo参照
  customerId: null,
  customerRecognized: false,
  // ★2026-09-23追加：GAS版customer_form.htmlのS.selectedKeepUpgrade相当。
  //   「キープメンバーへの変更を希望する」が選択中かどうか（セッション内のみ・target:'visitor'限定）
  keepUpgradeSelected: false,
  custTarget: 'new'
};

// ★2026-09-22追加：URLの?cid=顧客IDを読み取る（GAS版doGetのe.parameter.cid相当。
//   LINEから届く個別予約リンクに埋め込まれている想定）
function getCidFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('cid') || '';
}

async function loadStoreInfo() {
  const cid = getCidFromUrl();
  const url = cid ? `/api/store?store=${state.storeSlug}&cid=${encodeURIComponent(cid)}` : `/api/store?store=${state.storeSlug}`;
  const res = await fetch(url);
  const data = await res.json();

  // ★2026-09-22追加／2026-09-23拡張：GAS版getCustomerFormData（reservation_form_functions.js
  //   lines 834-880）の移植。①予約フォーム受付拒否の顧客は、入力を始める前にブロック画面を
  //   出して以降の表示を止める②本人特定できた顧客は、お名前欄を編集不可で顧客マスタの本名を
  //   表示し、以後の送信にcustomerIdを含める③★2026-09-23追加：GAS版と同じくキープメンバー
  //   （pink）／それ以外（green）のテーマ色を切り替え、メニュー・注意書きはサーバー側
  //   （/api/store）で顧客区分（target）によりフィルタ済みのものをそのまま表示する
  //   （ページ構成自体は既存の単一ページ簡略版のまま。README_PROTOTYPE.md参照）
  if (data.customer && data.customer.bookingBlocked) {
    document.getElementById('blockedCard').style.display = 'block';
    document.querySelectorAll('.container > .card').forEach((el) => {
      if (el.id !== 'blockedCard') el.style.display = 'none';
    });
    return;
  }
  // ★2026-09-23追加：テーマ色の切り替え（GAS版のpink=キープメンバー／green=それ以外）
  document.body.classList.toggle('theme-green', data.customer && data.customer.theme === 'green');

  if (data.customer && data.customer.found) {
    state.customerId = data.customer.customerId;
    state.customerRecognized = true;
    // ★2026-09-23修正：以前は「found:true（cidに一致する顧客マスタ行がある）」なら
    //   無条件に本名を編集不可で表示していたが、GAS版のLINE友だち追加時の自動登録
    //   （registerOrUpdateCustomerFromLine_body_）は、LINE表示名しか分からない段階では
    //   本名（realname）を空欄のまま顧客IDだけを発行する（本名確定は別途、お客様自身の
    //   入力を待つ）。Node版でも同様にcustomerIdだけ発行されLINE表示名しか無い顧客が
    //   存在し得るため、realnameが空のときはお名前欄をロックせず、ご自身で入力できる
    //   ようにした（以前の実装だと、本名未確定の初めての方が空欄のまま入力できなく
    //   なってしまうバグだった）。
    const hasRealname = !!(data.customer.realname && data.customer.realname.trim());
    const badge = document.getElementById('customerBadge');
    document.getElementById('customerBadgeName').textContent =
      hasRealname ? data.customer.realname : (data.customer.lineName || 'お客様');
    // ★2026-09-23追加：初めての方（visitCount===0）には「いつもご利用〜」ではなく
    //   初回向けの文言を出す（GAS版のtarget別出し分けの趣旨を踏襲）
    document.getElementById('customerBadgeGreeting').textContent =
      data.customer.target === 'new' ? 'この度はご予約ありがとうございます、初めてのご利用ですね' : 'いつもご利用ありがとうございます';
    badge.style.display = 'block';
    if (hasRealname) {
      // ★本名が確定している場合のみ、お名前欄を編集不可にして顧客マスタの本名を表示する
      //   （GAS版同様、送信時もクライアントの入力値ではなくサーバー側で顧客マスタの
      //   値を正として使う。server.jsのPOST /api/reservations参照）
      const nameInput = document.getElementById('nameInput');
      nameInput.value = data.customer.realname;
      nameInput.readOnly = true;
      nameInput.style.background = '#f5f5f5';
      document.getElementById('nameInputLabel').textContent = 'お名前（ご登録内容から自動入力）';
    } else {
      // 本名未確定（LINE表示名のみ）の場合は、ご自身でお名前を入力していただく
      document.getElementById('nameInputLabel').textContent = 'お名前（初めてのご利用のため入力してください）';
    }
  }

  // ★2026-09-23追加：GAS版customer_form.htmlの新規登録オーバーレイ相当。
  //   キープメンバー（target==='keep'）は既に登録済みとみなし対象外。
  //   それ以外（'new'／'visitor'）で、顧客マスタのinfo_confirmedがfalseの場合のみ
  //   氏名・フリガナ・電話番号・住所の入力欄（registrationCard）を必須表示する。
  const custInfo = data.customer || { target: 'new', infoConfirmed: false, keepMemberRequested: false };
  const needsRegistration = custInfo.target !== 'keep' && !custInfo.infoConfirmed;
  document.getElementById('registrationCard').style.display = needsRegistration ? 'block' : 'none';
  if (needsRegistration) {
    // 登録画面を出す間は、通常のお名前欄（nameInput）は登録完了後に自動入力するため隠す
    document.getElementById('nameInputLabel').style.display = 'none';
    document.getElementById('nameInput').style.display = 'none';
  }

  // ★2026-09-23同日修正：社長のご指摘を受け、GAS版customer_form.htmlのbuildKeepUpgradeCard/
  //   selectKeepUpgradeと同じ挙動に作り直した。①表示対象はGAS版のisVisitor条件と同じく
  //   target==='visitor'（来店実績のある既存のお客様・キープ以外）のみ。'new'（初めての方）
  //   には出さない（来店実績が無いのにキープメンバー云々は不自然なため）②GAS版はこの選択を
  //   顧客マスタへ保存せず常にセッションのみ・未選択スタートのため、Node版も過去の申告有無に
  //   関わらず毎回チェック無しの状態で表示する（以前の実装は既に申告済みなら初期状態で
  //   チェック済み表示にしていたが、社長のテストで「最初からTRUEになっている」バグとして
  //   報告されたため撤去。過去の申告状況はオーナー管理画面の顧客一覧バッジで確認する運用に
  //   一本化した）
  state.keepUpgradeSelected = false;
  state.custTarget = custInfo.target || 'new';
  const keepRow = document.getElementById('keepRequestRow');
  const keepCheck = document.getElementById('keepRequestCheck');
  if (custInfo.target === 'visitor') {
    keepRow.style.display = 'block';
    keepCheck.checked = false;
    keepCheck.disabled = false;
  } else {
    keepRow.style.display = 'none';
  }
  // ★2026-09-23追加：GAS版selectKeepUpgradeの移植。チェックのON/OFFで、
  //   メンバー限定メニューの選択可否をその場（クライアント側のみ・サーバー通信無し）で
  //   切り替える。onchangeは毎回付け替えると重複登録されるため、要素ごと一度だけ設定する。
  if (!keepCheck.dataset.bound) {
    keepCheck.addEventListener('change', () => {
      state.keepUpgradeSelected = keepCheck.checked;
      applyKeepUpgradeGating();
    });
    keepCheck.dataset.bound = '1';
  }
  const sel = document.getElementById('staffSelect');
  sel.innerHTML = '';
  const optAny = document.createElement('option');
  optAny.value = 'nopref';
  optAny.textContent = '指名なし（おまかせ）';
  sel.appendChild(optAny);
  data.staffList.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name + (s.role === 'オーナー' ? '（オーナー）' : '');
    sel.appendChild(opt);
  });
  // ★2026-09-23追加：GAS版の「前回担当スタッフの利便的な事前選択」相当（キープメンバーの
  //   場合のみサーバー側から menuStaffName が届く。updateLastStaff_ 相当の値）。
  //   一致するスタッフが選択肢にいれば、指名なしの代わりにそれを初期選択にする。
  if (data.customer && data.customer.menuStaffName) {
    const match = data.staffList.find((s) => s.realName === data.customer.menuStaffName);
    if (match) sel.value = match.id;
  }

  // ★2026-09-19追加：メニューマスタで管理している有効なメニューを反映する
  //   （以前はここに直接4件をハードコードしていた。店舗設定画面から追加・編集した内容が届く）
  // ★2026-09-20更新：以前はカテゴリを区別せず全メニューを1つのセレクトに流し込んでいた
  //   ため、店舗設定で「施術系オプション」「オプション」を追加すると、メインメニューの
  //   択一選択肢に紛れ込んでしまう不具合があった。GAS版customer_form.htmlのbuildMenus_
  //   相当の区分（メインメニューは1つ選択・オプションは複数追加可）に合わせて分離した。
  const menuSel = document.getElementById('menuSelect');
  if (menuSel && Array.isArray(data.menuItems)) {
    state.mainMenuItems = data.menuItems.filter((m) => m.category === 'メインメニュー');
    state.optionMenuItems = data.menuItems.filter((m) => m.category !== 'メインメニュー');
    state.selectedOptionIds = new Set();

    menuSel.innerHTML = '';
    state.mainMenuItems.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.name;
      const priceLabel = m.price ? `　¥${Number(m.price).toLocaleString('ja-JP')}` : '';
      // ★2026-09-23追加：GAS版getCustomerMenuList_のisFeatured（初めての方におすすめ）／
      //   isMemberOnly（メンバー限定）の目印を、<select><option>のテキストに反映する
      //   （GAS版はカード型UIでバッジ表示だが、単一ページ簡略版のプルダウンではテキスト
      //   接頭辞で代替。対象外のisMemberOnly商品はサーバー側で既に除外済みのため、ここに
      //   来るisMemberOnly項目＝キープメンバー本人が見ている状態）
      // ★2026-09-23同日修正：requiresKeepUpgrade（＝既存客・キープ以外に見えている
      //   メンバー限定メニュー）は🔒プレフィックスにし、実際に選択できるかどうかは
      //   applyKeepUpgradeGating()がoption.disabledで制御する（GAS版のdisabled-until-upgrade）
      let prefix = '';
      if (m.isFeatured) prefix = '★初回おすすめ　';
      else if (m.requiresKeepUpgrade) prefix = '🔒メンバー限定（変更希望を選択すると選べます）　';
      else if (m.isMemberOnly) prefix = '💎メンバー限定　';
      opt.textContent = prefix + m.name + priceLabel;
      opt.dataset.requiresKeepUpgrade = m.requiresKeepUpgrade ? '1' : '';
      menuSel.appendChild(opt);
    });
    menuSel.addEventListener('change', updateTotalPrice);

    applyKeepUpgradeGating();
    renderOptionMenu();
  }

  // ★2026-09-20追加：受付ルール・注意書き（rule2「注意書き（お客様向け）」相当）。
  //   店舗設定画面で編集した内容（対象「全員」の有効な注意書きのみ）をそのまま表示する。
  const noticeCard = document.getElementById('noticeCard');
  const noticeList = document.getElementById('noticeList');
  if (Array.isArray(data.notices) && data.notices.length > 0) {
    noticeList.innerHTML = '';
    data.notices.forEach((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      noticeList.appendChild(li);
    });
    noticeCard.style.display = 'block';
  }
  if (data.store && data.store.phone) {
    document.getElementById('storePhoneNote').textContent = `お電話でのお問い合わせ：${data.store.phone}`;
  }

  // 日付の初期値：3日後（GAS版の受付締め切りルールに合わせておく）
  const d = new Date();
  d.setDate(d.getDate() + 3);
  document.getElementById('dateInput').value = d.toISOString().slice(0, 10);
}

// ★2026-09-20追加：オプションメニュー（GAS版customer_form.htmlのbuildAddOptionsHtml/
//   buildOptionCard/selectOptionGroup相当）。「施術系オプション」「オプション」カテゴリの
//   メニューをチェックボックス形式で複数選択できるようにし、選択中の合計金額を表示する。
//   【GAS版からの簡略化】GAS版は「施術系オプション」はラジオ形式で1つのみ選択・スタッフの
//   対応可否によって選択肢を絞り込む（rebuildStaffForOptMenu）が、このプロトタイプでは
//   カテゴリを区別せずすべてチェックボックス（複数選択可）に統一し、スタッフ絞り込みは
//   行っていない（README_PROTOTYPE.mdに明記）。
function renderOptionMenu() {
  const wrap = document.getElementById('optionMenuWrap');
  const list = document.getElementById('optionMenuList');
  if (!wrap || !list) return;
  list.innerHTML = '';

  if (state.optionMenuItems.length === 0) {
    wrap.style.display = 'none';
    updateTotalPrice();
    return;
  }
  wrap.style.display = 'block';

  state.optionMenuItems.forEach((m) => {
    const item = document.createElement('label');
    item.className = 'option-menu-item';
    const priceLabel = m.price ? `+¥${Number(m.price).toLocaleString('ja-JP')}` : '';
    item.innerHTML = `<input type="checkbox" data-opt-id="${m.id}"><span class="opt-name">${m.name}</span><span class="opt-price">${priceLabel}</span>`;
    const checkbox = item.querySelector('input');
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        state.selectedOptionIds.add(m.id);
        item.classList.add('checked');
      } else {
        state.selectedOptionIds.delete(m.id);
        item.classList.remove('checked');
      }
      updateTotalPrice();
    });
    list.appendChild(item);
  });
  updateTotalPrice();
}

// ★2026-09-23追加：GAS版selectKeepUpgradeの移植。「キープメンバーへの変更を希望する」
//   のON/OFFに応じて、メンバー限定メニュー（requiresKeepUpgrade付きの<option>）を
//   選択可能／不可に切り替える。OFFに戻した時、現在の選択がメンバー限定メニューのままだと
//   送信できてしまうため、GAS版と同じくOFFへ戻すと自動的に選択を解除する
//   （if(S.selectedMain&&S.selectedMain.isMemberOnly) S.selectedMain=null; 相当）。
function applyKeepUpgradeGating() {
  const menuSel = document.getElementById('menuSelect');
  if (!menuSel) return;
  let needsReset = false;
  Array.from(menuSel.options).forEach((opt) => {
    if (!opt.dataset.requiresKeepUpgrade) return;
    opt.disabled = !state.keepUpgradeSelected;
    if (opt.disabled && opt.selected) needsReset = true;
  });
  if (needsReset) {
    const firstEnabled = Array.from(menuSel.options).find((opt) => !opt.disabled);
    if (firstEnabled) menuSel.value = firstEnabled.value;
  }
  updateTotalPrice();
}

function updateTotalPrice() {
  const row = document.getElementById('totalPriceRow');
  const valueEl = document.getElementById('totalPriceValue');
  if (!row || !valueEl) return;

  const menuSel = document.getElementById('menuSelect');
  const mainItem = state.mainMenuItems.find((m) => menuSel && m.name === menuSel.value);
  let total = mainItem ? Number(mainItem.price) || 0 : 0;
  state.optionMenuItems.forEach((m) => {
    if (state.selectedOptionIds.has(m.id)) total += Number(m.price) || 0;
  });

  if (total > 0) {
    valueEl.textContent = `¥${total.toLocaleString('ja-JP')}`;
    row.style.display = 'block';
  } else {
    row.style.display = 'none';
  }
}

// ★選択中のメインメニュー名にチェック済みオプション名を「　＋　」（全角スペース+全角プラス+
//   全角スペース）で連結した文字列を返す（reservations.menuはフリーテキスト列のため、GAS版
//   reservation_form_assets.htmlのbuildMenuValue()と同じ区切り文字列で保存する。
//   ★2026-09-22修正：以前は区切りが「＋」のみ（スペース無し）だったため、後から実装した
//   閲覧専用画面（reservations-view.html等）のsplitMenu()が「　＋　」でしか分割できず、
//   オプション付き予約の表示が崩れる不整合があった。GAS版の区切りに統一して解消）
function buildMenuLabel() {
  const menuSel = document.getElementById('menuSelect');
  const parts = [menuSel.value];
  state.optionMenuItems.forEach((m) => {
    if (state.selectedOptionIds.has(m.id)) parts.push(m.name);
  });
  // ★2026-09-23追加：GAS版calcTotal()のnameList.push('キープメンバー変更希望')相当。
  //   選択中なら、スタッフが予約一覧のメニュー欄を見ただけで分かるよう文言を追記する
  if (state.keepUpgradeSelected) parts.push('キープメンバー変更希望');
  return parts.join('　＋　');
}

async function checkAvailability() {
  state.staffId = document.getElementById('staffSelect').value;
  state.date = document.getElementById('dateInput').value;
  if (!state.date) { alert('日付を選んでください'); return; }

  const url = `/api/availability?store=${state.storeSlug}&date=${state.date}&staffId=${state.staffId}`;
  const res = await fetch(url);
  const data = await res.json();

  const zoneCard = document.getElementById('zoneCard');
  zoneCard.style.display = 'block';
  const grid = document.getElementById('zoneGrid');
  grid.innerHTML = '';
  document.getElementById('timeSlotWrap').style.display = 'none';
  document.getElementById('formCard').style.display = 'none';
  state.selectedZone = null;

  data.zones.forEach((z) => {
    const box = document.createElement('div');
    const selectable = (z.status === '空き' || z.status === '残1');
    box.className = 'zone-box' + (selectable ? ' selectable' : '');
    box.innerHTML = `<div class="zone-label">${z.label}<br><span style="font-size:11px;color:#999;">${z.start}-${z.end}</span></div>
                      <div class="zone-status status-${z.status}">${z.status}</div>`;
    if (selectable) {
      box.addEventListener('click', () => selectZone(z, box));
    }
    grid.appendChild(box);
  });
}

async function selectZone(zone, boxEl) {
  document.querySelectorAll('.zone-box').forEach((b) => b.classList.remove('selected'));
  boxEl.classList.add('selected');
  state.selectedZone = zone.key;
  state.selectedTime = null;

  const url = `/api/timeslots?store=${state.storeSlug}&date=${state.date}&staffId=${state.staffId}&zone=${zone.key}`;
  const res = await fetch(url);
  const data = await res.json();

  const wrap = document.getElementById('timeSlotWrap');
  const grid = document.getElementById('timeGrid');
  grid.innerHTML = '';
  wrap.style.display = 'block';
  document.getElementById('formCard').style.display = 'none';

  if (data.slots.length === 0) {
    grid.innerHTML = '<span class="note">この時間帯は選択可能な時刻がありません</span>';
    return;
  }

  data.slots.forEach((s) => {
    const chip = document.createElement('div');
    chip.className = 'time-chip' + (s.disabled ? ' disabled' : '');
    chip.textContent = s.time;
    if (!s.disabled) {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.time-chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        state.selectedTime = s.time;
        document.getElementById('formCard').style.display = 'block';
      });
    }
    grid.appendChild(chip);
  });
}

// ★2026-09-23追加：GAS版のsubmitRegistrationOverlay() → submitBooking('green')の
//   シーケンスを移植。予約送信の前に、①新規登録が必要なら/api/customer-registrationで
//   本登録し、顧客IDと本名を確定させる②「キープメンバーへの変更希望」チェックが
//   ON（かつ未申告）ならそれも同じ呼び出しで一緒に送る。どちらも不要な場合は何もせず
//   success:trueを返す。
async function submitRegistrationIfNeeded() {
  const regCard = document.getElementById('registrationCard');
  const needsFullReg = regCard.style.display !== 'none';
  const keepRow = document.getElementById('keepRequestRow');
  const keepCheck = document.getElementById('keepRequestCheck');
  // ★2026-09-23同日修正：keepRowはtarget==='visitor'の時だけ表示される（loadStoreInfo参照）
  const keepRequestToSend = keepRow.style.display !== 'none';

  if (!needsFullReg && !(keepRequestToSend && keepCheck.checked)) {
    return { success: true };
  }

  const payload = { store: state.storeSlug };
  if (state.customerId) payload.customerId = state.customerId;
  let combinedName = null;

  if (needsFullReg) {
    // ★2026-09-23追加修正：以前は姓・名の未入力しかチェックしておらず、フリガナ・
    //   電話番号・ご住所が空欄のままでも登録→予約が完走できてしまっていた
    //   （社長のテストで発覚。サーバー側lib/customerMerge.jsも同時に修正済み）。
    //   お客様への案内としてここで先に空欄チェックを行い、該当欄にフォーカスする。
    const lastName = document.getElementById('regLastName').value.trim();
    const firstName = document.getElementById('regFirstName').value.trim();
    const lastKana = document.getElementById('regLastKana').value.trim();
    const firstKana = document.getElementById('regFirstKana').value.trim();
    const phone = document.getElementById('regPhone').value.trim();
    const address = document.getElementById('regAddress').value.trim();
    if (!lastName || !firstName) return { success: false, message: '姓・名を入力してください' };
    if (!lastKana || !firstKana) return { success: false, message: 'フリガナ姓・フリガナ名を入力してください' };
    if (!phone) return { success: false, message: '電話番号を入力してください' };
    if (!address) return { success: false, message: 'ご住所を入力してください' };
    payload.lastName = lastName;
    payload.firstName = firstName;
    payload.lastKana = lastKana;
    payload.firstKana = firstKana;
    payload.phone = phone;
    payload.address = address;
    combinedName = `${lastName} ${firstName}`;
  }
  if (keepRequestToSend) {
    payload.keepMemberRequested = keepCheck.checked;
  }

  const res = await fetch('/api/customer-registration', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (data.success) {
    state.customerId = data.customerId;
    if (combinedName) {
      const nameInput = document.getElementById('nameInput');
      nameInput.value = combinedName;
      nameInput.style.display = '';
      document.getElementById('nameInputLabel').style.display = '';
    }
    regCard.style.display = 'none';
  }
  return data;
}

async function submitReservation() {
  const regMsgEl = document.getElementById('regMsg');
  regMsgEl.innerHTML = '';
  const regResult = await submitRegistrationIfNeeded();
  if (!regResult.success) {
    regMsgEl.innerHTML = `<div class="msg ng">${regResult.message || '入力内容をご確認ください'}</div>`;
    return;
  }

  const name = document.getElementById('nameInput').value.trim();
  const menu = buildMenuLabel();
  const note = document.getElementById('noteInput').value.trim();
  const msgEl = document.getElementById('submitMsg');

  if (!name) { alert('お名前を入力してください'); return; }
  if (!state.selectedTime) { alert('時刻を選んでください'); return; }

  const staffSelect = document.getElementById('staffSelect');
  const staffLabel = staffSelect.options[staffSelect.selectedIndex].textContent;
  const staffName = state.staffId === 'nopref' ? '未定' : staffLabel.replace('（オーナー）', '');

  const payload = {
    store: state.storeSlug,
    realname: name,
    staffName: staffName,
    menu: menu,
    date: state.date,
    time: state.selectedTime,
    note: note,
    editor: 'プロトタイプ画面'
  };
  // ★本人特定できている場合はcustomerIdを一緒に送る。server.js側でこれを見て
  //   本名等を顧客マスタの値で上書きし、受付拒否フラグも再チェックする
  if (state.customerId) payload.customerId = state.customerId;

  const res = await fetch('/api/reservations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();

  if (data.success) {
    msgEl.innerHTML = `<div class="msg ok">${data.message}</div>`;
    checkAvailability();
  } else if (data.isLimitWarning) {
    if (confirm(data.message)) {
      payload.ownerOverride = true;
      const res2 = await fetch('/api/reservations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data2 = await res2.json();
      msgEl.innerHTML = data2.success
        ? `<div class="msg ok">${data2.message}</div>`
        : `<div class="msg ng">${data2.message || data2.error || '登録に失敗しました'}</div>`;
    }
  } else {
    // ★2026-09-23修正：以前はdata.errorしか見ておらず、booking_blocked／二重予約
    //   （isDoubleBooking）などdata.messageに実際の失敗理由が入っているケースで
    //   常に汎用文言「登録に失敗しました」しか表示されず、お客様が理由を確認できない
    //   不具合があった（社長のテストで「途中で弾かれます」とだけ見える形で発覚）。
    //   data.message（サーバーが用意した具体的な理由）を優先して表示するよう修正。
    msgEl.innerHTML = `<div class="msg ng">${data.message || data.error || '登録に失敗しました'}</div>`;
  }
}

document.getElementById('checkBtn').addEventListener('click', checkAvailability);
document.getElementById('submitBtn').addEventListener('click', submitReservation);

loadStoreInfo();
