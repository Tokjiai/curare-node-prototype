// ============================================================================
// lib/sqliteSessionStore.js
// express-session用の永続化ストア（better-sqlite3ベースの自作実装）。
//
// 【なぜ必要になったか】
//   server.jsはこれまでexpress-session標準の session.MemoryStore()（プロセスの
//   メモリ上だけにセッションを保持する）を使っていた。ところがRenderの無料
//   プランは一定時間アクセスが無いとサーバープロセスがスリープし、次のアクセスで
//   プロセスごと再起動される。MemoryStoreはプロセスの再起動で中身が消えるため、
//   ブラウザのCookie自体は有効期限内（8時間）でも、サーバー側では「そんな
//   セッションは知らない」401 Unauthorizedになってしまう（実際に、LINE連携設定
//   パネルで入力に時間がかかった際にこれが発生したと報告あり）。
//
//   一方、data/app.db（SQLiteファイル）は複数回のデプロイをまたいでデータが
//   保持され続けている実績がある（ダッシュボードの累計顧客数・予約数が
//   9/17以降蓄積され続けている）ため、恐らくRender側でこのディスクに永続化の
//   設定がされている。そこで、セッションも同じ仕組みで永続化されるSQLiteに
//   保存するようにし、プロセス再起動をまたいでもログイン状態が維持されるように
//   した。
//
// 【新規npm依存を増やさない理由】
//   connect-sqlite3等の既製ストアもあるが、内部でnode-sqlite3（ネイティブ
//   ビルドが必要）に依存しており、Renderのビルド時間・失敗リスクを増やす
//   可能性がある。既にbetter-sqlite3を使っているため、express-sessionの
//   Store抽象クラスを継承した最小限の自作実装にとどめた（get/set/destroy/
//   touchの4メソッドのみ）。
// ============================================================================

const session = require('express-session');

class SqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires INTEGER NOT NULL
      )
    `);
    // 起動のたびに期限切れの行を掃除しておく（肥大化防止）
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb();
      if (row.expires < Date.now()) {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return cb();
      }
      return cb(null, JSON.parse(row.sess));
    } catch (e) {
      return cb(e);
    }
  }

  set(sid, sessionData, cb) {
    try {
      const maxAge = (sessionData.cookie && sessionData.cookie.maxAge) || 8 * 60 * 60 * 1000;
      const expires = Date.now() + maxAge;
      this.db.prepare(`
        INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
      `).run(sid, JSON.stringify(sessionData), expires);
      if (cb) cb();
    } catch (e) {
      if (cb) cb(e);
    }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      if (cb) cb();
    } catch (e) {
      if (cb) cb(e);
    }
  }

  // ★force-logout機能（server.jsのgetAllSessionsAsync_）がMemoryStore互換の
  //   {sid: sessionData, ...} 形式のオブジェクトを期待しているため、それに合わせる。
  all(cb) {
    try {
      const rows = this.db.prepare('SELECT sid, sess, expires FROM sessions WHERE expires >= ?').all(Date.now());
      const result = {};
      rows.forEach((row) => {
        try {
          result[row.sid] = JSON.parse(row.sess);
        } catch (_) {
          // 壊れた行は無視する
        }
      });
      cb(null, result);
    } catch (e) {
      cb(e);
    }
  }

  touch(sid, sessionData, cb) {
    try {
      const maxAge = (sessionData.cookie && sessionData.cookie.maxAge) || 8 * 60 * 60 * 1000;
      const expires = Date.now() + maxAge;
      this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(expires, sid);
      if (cb) cb();
    } catch (e) {
      if (cb) cb(e);
    }
  }
}

module.exports = SqliteSessionStore;
