// ============================================================================
// public/app.js
// 予約プロトタイプ用フロントエンド（素のJS + fetch APIのみ。フレームワーク不要）
// ============================================================================

const state = {
  storeSlug: 'kurare-kotobuki',
  staffId: 'nopref',
  date: null,
  selectedZone: null,
  selectedTime: null
};

async function loadStoreInfo() {
  const res = await fetch(`/api/store?store=${state.storeSlug}`);
  const data = await res.json();
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
  const menuSel = document.getElementById('menuSelect');
  if (menuSel && Array.isArray(data.menuItems)) {
    menuSel.innerHTML = '';
    data.menuItems.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.name;
      const priceLabel = m.price ? `　¥${Number(m.price).toLocaleString('ja-JP')}` : '';
      opt.textContent = m.name + priceLabel;
      menuSel.appendChild(opt);
    });
  }

  // 日付の初期値：3日後（GAS版の受付締め切りルールに合わせておく）
  const d = new Date();
  d.setDate(d.getDate() + 3);
  document.getElementById('dateInput').value = d.toISOString().slice(0, 10);
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
  const menu = document.getElementById('menuSelect').value;
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
