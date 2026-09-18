// ============================================================================
// lib/auth.js
// PINハッシュ化ロジック（server.js / db/init.js の両方から共有利用する）
//
// 【ハッシュ方式について】
//   Node.js標準の crypto モジュールのみを使用（新規npm依存は追加しない）。
//   scrypt（鍵導出関数）でPIN文字列をハッシュ化し、行ごとにランダムなsaltを
//   staff.pin_salt に保存する。scryptは意図的に計算コストが高く、
//   総当たり攻撃（ブルートフォース）に強い。
//   4桁PINは組み合わせが1万通りしかなく本質的に弱いが、
//   「平文で保存しない」「saltを行ごとに変える」ことで、DB漏洩時に
//   レインボーテーブル等での一括解析を困難にする最低限の防御を行う。
//
//   MySQL移行時もこのファイルはそのまま使い回せる（DBアクセスを含まない
//   純粋なハッシュ計算ロジックのみのため）。
// ============================================================================

const crypto = require('crypto');

const SCRYPT_KEYLEN = 32;

// ランダムなsalt（16バイト→hex32文字）を生成する
function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// PIN文字列 + salt から scrypt ハッシュ（hex）を計算する
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, SCRYPT_KEYLEN).toString('hex');
}

// 新規PIN登録用：salt生成＋ハッシュ計算をまとめて行う
function createPinHash(pin) {
  const salt = generateSalt();
  const hash = hashPin(pin, salt);
  return { salt, hash };
}

// 入力されたPINが、保存済みのsalt・hashと一致するかを検証する（定数時間比較）
function verifyPin(pin, salt, storedHashHex) {
  if (!salt || !storedHashHex) return false;
  const candidateHex = hashPin(pin, salt);
  const candidateBuf = Buffer.from(candidateHex, 'hex');
  const storedBuf = Buffer.from(storedHashHex, 'hex');
  if (candidateBuf.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(candidateBuf, storedBuf);
}

module.exports = { generateSalt, hashPin, createPinHash, verifyPin };
