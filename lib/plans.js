// ============================================================================
// lib/plans.js
// ★2026-09-18(続き)追加：⑤ 課金基盤（プラン管理）の骨組み
//
// 【位置づけ】
//   実際の決済処理・申込みフォーム・与信管理はまだ無い（それらは本番VPS移行後の
//   スコープ）。ここでは「プランごとに何が使えるか」を1箇所に集約し、機能側の
//   コードがこの定義を見て分岐できるようにする土台だけを用意する。
//   プラン切替APIはこのプロトタイプでは「オーナーが自分で切り替えられるデモ用
//   スイッチ」であり、本番では決済確認後にシステム側（またはオーナー申込み＋
//   承認フロー）が更新する想定。
//
// 【商用プラン構成（プロジェクトメモリ記録済み・確定事項）】
//   ⓪ワンコイン：月額¥300〜500・台帳閲覧・電話予約手入力のみ
//   ①ベース：月額¥1,000・お客様予約フォーム稼働・LINE非取得
//   ②LINE連携：①込み合計¥3,000＋¥500×追加スタッフ数
// ============================================================================

const PLANS = {
  trial: {
    label: 'トライアル',
    priceNote: 'デモ・評価用（期限つき運用は未実装）',
    features: {
      customerBookingForm: true,   // お客様予約フォームを公開するか
      ownerDashboard: true,        // オーナー管理画面（台帳閲覧）を使えるか
      lineNotify: false,           // LINEの実送信を許可するか（falseなら常にシミュレーション）
      calendarSync: false          // Googleカレンダー同期（★未実装機能。プランに関わらず常にfalse）
    }
  },
  onecoin: {
    label: '⓪ワンコイン',
    priceNote: '¥300〜500/月',
    features: {
      customerBookingForm: false,  // お客様自身の予約フォームは対象外（電話予約の手入力のみ）
      ownerDashboard: true,
      lineNotify: false,
      calendarSync: false
    }
  },
  base: {
    label: '①ベース',
    priceNote: '¥1,000/月',
    features: {
      customerBookingForm: true,
      ownerDashboard: true,
      lineNotify: false,           // LINE非取得プラン
      calendarSync: false
    }
  },
  line: {
    label: '②LINE連携',
    priceNote: '¥3,000/月〜（＋¥500×追加スタッフ）',
    features: {
      customerBookingForm: true,
      ownerDashboard: true,
      lineNotify: true,            // ★このプランのみ、店舗にチャネルトークンが設定されていれば実送信され得る
      calendarSync: false
    }
  }
};

function getPlan(slug) {
  return PLANS[slug] || PLANS.trial;
}

function hasFeature(slug, featureKey) {
  return !!getPlan(slug).features[featureKey];
}

function listPlans() {
  return Object.entries(PLANS).map(([slug, p]) => ({ slug, ...p }));
}

module.exports = { PLANS, getPlan, hasFeature, listPlans };
