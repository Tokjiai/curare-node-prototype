// ============================================================================
// lib/db.js
// SQLiteデータベースへの接続をまとめるモジュール。
//
// 【本番移行メモ】
// ここを mysql2 等に差し替えれば、他のファイル（reservationEngine.js /
// server.js）はSQL文の書き方を大きく変えずに移行できるよう、
// クエリはできるだけ標準的なSQLで書いている。
// ============================================================================

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Renderのようなエフェメラル（再起動で消える）ディスク環境でも動くよう、
// 環境変数で置き場所を変えられるようにしておく。
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');

// dataディレクトリが無ければ作る
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
