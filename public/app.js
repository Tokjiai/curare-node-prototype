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
  customerRecognized: false
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

  // ★2026-09-22追加：GAS版getCustomerFormDataの移植（簡略版）。①予約フォーム受付拒否の
  //   顧客は、入力を始める前にブロック画面を出して以降の表示を止める②本人特定できた
  //   顧客は、お名前欄を編集不可で顧客マスタの本名を表示し、以後の送信にcustomerIdを
  //   含める（GAS版のような新規/キープ/ビジターでのテーマ色・メニュー出し分けまでは
  //   行っていない簡略版。README_PROTOTYPE.md参照）
  if (data.customer && data.customer.bookingBlocked) {
    document.getElementById('blockedCard').style.display = 'block';
    document.querySelectorAll('.container > .card').forEach((el) => {
      if (el.id !== 'blockedCard') el.style.display = 'none';
    });
    return;
  }
  if (data.customer && data.customer.found) {
    state.customerId = data.customer.customerId;
    state.customerRecognized = true;
    const badge = document.getElementById('customerBadge');
    document.getElementById('customerBadgeName').textContent = data.customer.realname;
    badge.style.display = 'block';
    // ★本人特定できている場合は、お名前欄を編集不可にして顧客マスタの本名を表示する
    //   （GAS版同様、送信時もクライアントの入力値ではなくサーバー側で顧客マスタの
    //   値を正として使う。server.jsのPOST /api/reservations参照）
    const nameInput = document.getElementById('nameInput');
    nameInput.value = data.customer.realname;
    nameInput.readOnly = true;
    nameInput.style.background = '#f5f5f5';
    document.getElementById('nameInputLabel').textContent = 'お名前（ご登録内容から自動入力）';
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
      opt.textContent = m.name + priceLabel;
      menuSel.appendChild(opt);
    });
    menuSel.addEventListener('change', updateTotalPrice);

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

// ★選択中のメインメニュー名にチェック済みオプション名を「＋」で連結した文字列を返す
//   （reservations.menuはフリーテキスト列のため、GAS版同様に組み合わせ結果を1つの
//   文字列として保存する）
function buildMenuLabel() {
  const menuSel = document.getElementById('menuSelect');
  const parts = [menuSel.value];
  state.optionMenuItems.forEach((m) => {
    if (state.selectedOptionIds.has(m.id)) parts.push(m.name);
  });
  return parts.join('＋');
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

async function submitReservation() {
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
    loadReservations();
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
        : `<div class="msg ng">${data2.error || '登録に失敗しました'}</div>`;
      loadReservations();
    }
  } else {
    msgEl.innerHTML = `<div class="msg ng">${data.error || '登録に失敗しました'}</div>`;
  }
}

async function loadReservations() {
  const res = await fetch(`/api/reservations?store=${state.storeSlug}`);
  const data = await res.json();
  const list = document.getElementById('reservList');
  list.innerHTML = '';
  if (data.reservations.length === 0) {
    list.innerHTML = '<li>予約はまだありません</li>';
    return;
  }
  data.reservations.forEach((r) => {
    const li = document.createElement('li');
    li.textContent = `${r.reservation_date} ${r.reservation_time} / ${r.staff_name} / ${r.realname}様 / ${r.menu}`;
    list.appendChild(li);
  });
}

document.getElementById('checkBtn').addEventListener('click', checkAvailability);
document.getElementById('submitBtn').addEventListener('click', submitReservation);

loadStoreInfo();
loadReservations();
