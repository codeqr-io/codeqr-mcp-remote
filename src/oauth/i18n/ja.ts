import type { Messages } from './en.js';

export const ja: Messages = {
  'consent.pageTitle': 'API アクセスの許可 | CodeQR',
  'consent.request': '<b>{client}</b> が CodeQR.io のプロジェクトへの API アクセスを求めています。',
  'consent.verified': 'CodeQR.io による確認済み',
  'consent.unverified':
    'CodeQR.io はこのアプリケーションを確認していません。この接続をご自身で開始した場合にのみ続行してください。誰かからこのリンクが送られてきた場合は、拒否してください。',
  'consent.destinationLabel': 'アクセス権の送信先：',
  'consent.destinationLoopback':
    'このアドレスはお使いのコンピューター上にあるため、そこで動作しているどのプログラムでもアクセス権を受け取れます。',
  'consent.destinationApp': 'このアドレスは、このデバイスにインストールされたアプリを開きます。',
  'consent.permissionsLabel': '権限を付与：',
  'consent.scope.linksRead': 'リンクの<strong>読み取り</strong>',
  'consent.scope.linksWrite': 'リンクの<strong>読み取りと書き込み</strong>',
  'consent.scope.qrcodesRead': 'QR コードの<strong>読み取り</strong>',
  'consent.scope.qrcodesWrite': 'QR コードの<strong>読み取りと書き込み</strong>',
  'consent.scope.analyticsRead': '分析データとイベントの<strong>読み取り</strong>',
  'consent.scope.domainsRead': 'ドメインの<strong>読み取り</strong>',
  'consent.scope.tagsRead': 'タグの<strong>読み取り</strong>',
  'consent.scope.tagsWrite': 'タグの<strong>読み取りと書き込み</strong>',
  'consent.scope.userRead': '名前、メールアドレス、プロフィール画像の<strong>読み取り</strong>',
  'consent.nextTitle': 'このあとの流れ',
  'consent.nextSignIn': 'CodeQR にログインするか、無料アカウントを作成します。',
  'consent.nextProject': '接続するプロジェクトを選ぶか、新しく作成します。',
  'consent.nextReturnVerified': '{client} に戻ります。',
  'consent.nextReturnGeneric': '接続を始めたアプリに戻ります。',
  'consent.refuse': '拒否',
  'consent.continue': '続行',
  'consent.privacy': 'プライバシーポリシー',
  'consent.terms': '利用規約',
};
