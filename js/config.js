/**
 * 管理者が編集する設定ファイル（GAS_URL は必須、OAUTH_CLIENT_ID は任意）
 * 手順は docs/SETUP.md を参照
 */
window.APP_CONFIG = {
  // GASウェブアプリのデプロイURL（https://script.google.com/macros/s/XXXX/exec）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbz02UksLpOOIgyy-zR_5ck5TWRdkbR1eqjrgGCFJlBcA2Flp-juxgg9YuNBfrk9bDiL/exec',

  // GCPで発行したOAuth 2.0クライアントID（xxxx.apps.googleusercontent.com）
  // 「Googleドライブに保存」を使うときだけ必要。空のままなら保存ボタンが非表示になる（コピー・txt保存は使える）
  OAUTH_CLIENT_ID: '',
};
