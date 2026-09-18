// ★自動バックアップスクリプト（プロトタイプ用・本番ではMySQLの定期dumpに置き換え）
// 使い方: node backup.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const src = path.join(__dirname, 'data', 'app.db');
const dir = path.join(__dirname, 'backups');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(dir, `backup_${ts}.db`);

const db = new Database(src, { readonly: true });
db.backup(dest)
  .then(() => {
    console.log(`✅ バックアップ完了: ${dest}`);
    db.close();
  })
  .catch((err) => {
    console.error('❌ バックアップ失敗:', err);
    db.close();
    process.exit(1);
  });
