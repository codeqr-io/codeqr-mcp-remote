import type { Messages } from './en.js';

export const ko: Messages = {
  'consent.pageTitle': 'API 액세스 승인 | CodeQR',
  'consent.request': '<b>{client}</b>에서 CodeQR.io 프로젝트에 대한 API 액세스를 요청하고 있습니다.',
  'consent.verified': 'CodeQR.io 인증 완료',
  'consent.unverified':
    'CodeQR.io는 이 애플리케이션을 인증하지 않았습니다. 이 연결을 직접 시작한 경우에만 계속하세요. 다른 사람이 이 링크를 보냈다면 거부하세요.',
  'consent.destinationLabel': '액세스 권한을 받을 곳:',
  'consent.destinationLoopback':
    '이 주소는 사용자의 컴퓨터에 있으므로, 그 컴퓨터에서 실행 중인 어떤 프로그램이든 액세스 권한을 받을 수 있습니다.',
  'consent.destinationApp': '이 주소는 이 기기에 설치된 앱을 엽니다.',
  'consent.permissionsLabel': '권한 부여:',
  'consent.scope.linksRead': '링크 <strong>읽기</strong> 권한',
  'consent.scope.linksWrite': '링크 <strong>읽기 및 쓰기</strong> 권한',
  'consent.scope.qrcodesRead': 'QR 코드 <strong>읽기</strong> 권한',
  'consent.scope.qrcodesWrite': 'QR 코드 <strong>읽기 및 쓰기</strong> 권한',
  'consent.scope.analyticsRead': '분석 데이터 및 이벤트 <strong>읽기</strong> 권한',
  'consent.scope.domainsRead': '도메인 <strong>읽기</strong> 권한',
  'consent.scope.tagsRead': '태그 <strong>읽기</strong> 권한',
  'consent.scope.tagsWrite': '태그 <strong>읽기 및 쓰기</strong> 권한',
  'consent.scope.userRead': '이름, 이메일, 프로필 사진 <strong>읽기</strong>',
  'consent.nextTitle': '다음 단계',
  'consent.nextSignIn': 'CodeQR에 로그인하거나 무료 계정을 만듭니다.',
  'consent.nextProject': '연결할 프로젝트를 선택하거나 새로 만듭니다.',
  'consent.nextReturnVerified': '{client}(으)로 돌아갑니다.',
  'consent.nextReturnGeneric': '연결을 시작한 앱으로 돌아갑니다.',
  'consent.refuse': '거부',
  'consent.continue': '계속',
  'consent.privacy': '개인정보 처리방침',
  'consent.terms': '서비스 약관',
};
