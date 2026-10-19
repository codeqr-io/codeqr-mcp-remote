import type { Messages } from './en.js';

export const ru: Messages = {
  'consent.pageTitle': 'Разрешение доступа к API | CodeQR',
  'consent.request': '<b>{client}</b> запрашивает доступ к API проекта в CodeQR.io.',
  'consent.verified': 'Проверено CodeQR.io',
  'consent.unverified':
    'CodeQR.io не проверял это приложение. Продолжайте, только если вы сами начали это подключение; если кто-то прислал вам эту ссылку, откажитесь.',
  'consent.destinationLabel': 'Доступ будет передан по адресу:',
  'consent.destinationLoopback':
    'Этот адрес находится на вашем собственном компьютере, поэтому доступ может получить любая запущенная на нём программа.',
  'consent.destinationApp': 'Этот адрес открывает приложение, установленное на этом устройстве.',
  'consent.permissionsLabel': 'Предоставить разрешения:',
  'consent.scope.linksRead': 'Доступ на <strong>чтение</strong> ваших ссылок',
  'consent.scope.linksWrite': 'Доступ на <strong>чтение и запись</strong> ваших ссылок',
  'consent.scope.qrcodesRead': 'Доступ на <strong>чтение</strong> ваших QR-кодов',
  'consent.scope.qrcodesWrite': 'Доступ на <strong>чтение и запись</strong> ваших QR-кодов',
  'consent.scope.analyticsRead': 'Доступ на <strong>чтение</strong> вашей аналитики и событий',
  'consent.scope.domainsRead': 'Доступ на <strong>чтение</strong> ваших доменов',
  'consent.scope.tagsRead': 'Доступ на <strong>чтение</strong> ваших тегов',
  'consent.scope.tagsWrite': 'Доступ на <strong>чтение и запись</strong> ваших тегов',
  'consent.scope.userRead': '<strong>Чтение</strong> вашего имени, электронной почты и фото профиля',
  'consent.nextTitle': 'Что будет дальше',
  'consent.nextSignIn': 'Войдите в CodeQR или создайте бесплатный аккаунт.',
  'consent.nextProject': 'Выберите проект для подключения или создайте новый.',
  'consent.nextReturnVerified': 'Вы вернётесь в {client}.',
  'consent.nextReturnGeneric': 'Вы вернётесь в приложение, с которого начали.',
  'consent.refuse': 'Отклонить',
  'consent.continue': 'Продолжить',
  'consent.privacy': 'Политика конфиденциальности',
  'consent.terms': 'Условия использования',
};
