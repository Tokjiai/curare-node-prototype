// ============================================================================
// public/admin/admin-mode.js
// ★2026-09-24追加：管理者（相野様）ログイン中であることを、どの画面でも一目で分かるように
//   画面右下に「🛡️ 管理者モード」のバッジを出す（通常のオーナーログインでは何も出さない）。
//   各管理画面・スタッフ画面・統一メニューの </body> 直前で読み込む。
//   ログイン状態の判定は /api/auth/me の staff.isAdmin（サーバー側のセッション）で行い、
//   このバッジ自体は表示のためだけのもの（権限の判定はすべてサーバー側で行っている）。
//
// ★2026-09-25追加（フェーズB）：
//   ①サイドバーの店舗名（.store-name／.brand）を、ハードコードの「クラーレ寿」ではなく
//   セッションの実際の店舗名（staff.storeName）に合わせて書き換える。管理者が
//   「店舗一覧」から別店舗に切り替えたときに、画面が今どの店舗を操作しているか
//   一目で分かるようにするための変更（通常の単一店舗オーナーは元々自店舗名と
//   一致するため見た目は変わらない）。
//   ②管理者ログイン中だけ、右下に「🏢 店舗一覧」バッジと、サイドバーがある画面には
//   ナビにも「店舗一覧（管理者）」の項目を足す（複数店舗の切り替え導線）。
// ============================================================================
(function () {
  fetch('/api/auth/me').then(function (res) {
    return res.ok ? res.json() : null;
  }).then(function (data) {
    if (!data || !data.staff) return;
    var staff = data.staff;

    if (staff.storeName) {
      document.querySelectorAll('.store-name').forEach(function (el) {
        el.textContent = staff.storeName;
      });
      document.querySelectorAll('.brand').forEach(function (el) {
        var parts = el.textContent.split('／');
        if (parts.length === 2) {
          el.textContent = staff.storeName + ' ／ ' + parts[1].trim();
        }
      });
    }

    if (!data.staff.isAdmin) return;
    document.documentElement.setAttribute('data-admin-mode', '1');

    var badge = document.createElement('a');
    badge.id = 'adminModeBadge';
    badge.href = '/admin/db-viewer.html';
    badge.title = '管理者ログイン中です（DB一覧ビューアの編集・初期メニューの名称変更などが使えます）';
    badge.textContent = '🛡️ 管理者モード';
    badge.style.cssText = [
      'position:fixed', 'right:14px', 'bottom:14px', 'z-index:10000',
      'background:#4A3F6B', 'color:#fff', 'font-size:12.5px', 'font-weight:700',
      'padding:8px 14px', 'border-radius:999px', 'text-decoration:none',
      'box-shadow:0 4px 14px rgba(0,0,0,0.25)', "font-family:'Hiragino Sans','Yu Gothic',sans-serif"
    ].join(';');
    document.body.appendChild(badge);

    // ★2026-09-25追加：複数店舗プラットフォーム管理画面（店舗一覧・切替）への導線
    var storesBadge = document.createElement('a');
    storesBadge.id = 'adminStoresBadge';
    storesBadge.href = '/admin/platform-stores.html';
    storesBadge.title = '店舗一覧から、管理者セッションのまま操作対象の店舗を切り替えられます';
    storesBadge.textContent = '🏢 店舗一覧（' + (staff.storeName || '店舗') + '）';
    storesBadge.style.cssText = [
      'position:fixed', 'right:14px', 'bottom:54px', 'z-index:10000',
      'background:#fff', 'color:#4A3F6B', 'font-size:12.5px', 'font-weight:700',
      'padding:8px 14px', 'border-radius:999px', 'text-decoration:none', 'border:1.5px solid #4A3F6B',
      'box-shadow:0 4px 14px rgba(0,0,0,0.18)', "font-family:'Hiragino Sans','Yu Gothic',sans-serif"
    ].join(';');
    document.body.appendChild(storesBadge);

    // サイドバー（.nav）があるオーナー用画面には、ログアウトの直前にも同じ導線を足す
    var logoutLink = document.getElementById('logoutLink');
    if (logoutLink && logoutLink.parentElement) {
      var navItem = document.createElement('a');
      navItem.href = '/admin/platform-stores.html';
      navItem.className = 'nav-item';
      navItem.textContent = '🏢 店舗一覧（管理者）';
      logoutLink.parentElement.insertBefore(navItem, logoutLink);
    }
  }).catch(function () { /* 表示用のバッジなので、取得に失敗しても画面の動作には影響させない */ });
})();
