// ============================================================================
// public/admin/admin-mode.js
// ★2026-09-24追加：管理者（相野様）ログイン中であることを、どの画面でも一目で分かるように
//   画面右下に「🛡️ 管理者モード」のバッジを出す（通常のオーナーログインでは何も出さない）。
//   各管理画面・スタッフ画面・統一メニューの </body> 直前で読み込む。
//   ログイン状態の判定は /api/auth/me の staff.isAdmin（サーバー側のセッション）で行い、
//   このバッジ自体は表示のためだけのもの（権限の判定はすべてサーバー側で行っている）。
// ============================================================================
(function () {
  fetch('/api/auth/me').then(function (res) {
    return res.ok ? res.json() : null;
  }).then(function (data) {
    if (!data || !data.staff || !data.staff.isAdmin) return;
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
  }).catch(function () { /* 表示用のバッジなので、取得に失敗しても画面の動作には影響させない */ });
})();
