import type { Messages } from './en.js';

export const es: Messages = {
  'consent.pageTitle': 'Autorizar acceso a la API | CodeQR',
  'consent.request': '<b>{client}</b> solicita acceso a la API de un proyecto en CodeQR.io.',
  'consent.verified': 'Verificado por CodeQR.io',
  'consent.unverified':
    'CodeQR.io no ha verificado esta aplicación. Continúa solo si iniciaste tú esta conexión; si alguien te envió este enlace, recházala.',
  'consent.destinationLabel': 'El acceso se enviará a:',
  'consent.destinationLoopback':
    'Esta dirección está en tu propio ordenador, así que cualquier programa que se ejecute en él puede recibir el acceso.',
  'consent.destinationApp': 'Esta dirección abre una app instalada en este dispositivo.',
  'consent.permissionsLabel': 'Conceder permisos:',
  'consent.scope.linksRead': 'Acceso de <strong>lectura</strong> a tus enlaces',
  'consent.scope.linksWrite': 'Acceso de <strong>lectura y escritura</strong> a tus enlaces',
  'consent.scope.qrcodesRead': 'Acceso de <strong>lectura</strong> a tus códigos QR',
  'consent.scope.qrcodesWrite': 'Acceso de <strong>lectura y escritura</strong> a tus códigos QR',
  'consent.scope.analyticsRead': 'Acceso de <strong>lectura</strong> a tus analíticas y eventos',
  'consent.scope.domainsRead': 'Acceso de <strong>lectura</strong> a tus dominios',
  'consent.scope.tagsRead': 'Acceso de <strong>lectura</strong> a tus etiquetas',
  'consent.scope.tagsWrite': 'Acceso de <strong>lectura y escritura</strong> a tus etiquetas',
  'consent.scope.userRead': '<strong>Leer</strong> tu nombre, correo electrónico y foto de perfil',
  'consent.nextTitle': 'Qué ocurre a continuación',
  'consent.nextSignIn': 'Inicia sesión en CodeQR o crea una cuenta gratuita.',
  'consent.nextProject': 'Elige el proyecto que quieres conectar o crea uno nuevo.',
  'consent.nextReturnVerified': 'Vuelves a {client}.',
  'consent.nextReturnGeneric': 'Vuelves a la app desde la que empezaste.',
  'consent.refuse': 'Rechazar',
  'consent.continue': 'Continuar',
  'consent.privacy': 'Política de privacidad',
  'consent.terms': 'Términos del servicio',
};
