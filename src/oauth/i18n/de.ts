import type { Messages } from './en.js';

export const de: Messages = {
  'consent.pageTitle': 'API-Zugriff autorisieren | CodeQR',
  'consent.request': '<b>{client}</b> fordert API-Zugriff auf ein Projekt bei CodeQR.io an.',
  'consent.verified': 'Von CodeQR.io verifiziert',
  'consent.unverified':
    'CodeQR.io hat diese Anwendung nicht verifiziert. Fahren Sie nur fort, wenn Sie diese Verbindung selbst gestartet haben; wenn Ihnen jemand diesen Link geschickt hat, lehnen Sie ab.',
  'consent.destinationLabel': 'Der Zugriff wird gesendet an:',
  'consent.destinationLoopback':
    'Diese Adresse liegt auf Ihrem eigenen Computer, daher kann jedes dort laufende Programm den Zugriff erhalten.',
  'consent.destinationApp': 'Diese Adresse öffnet eine auf diesem Gerät installierte App.',
  'consent.permissionsLabel': 'Berechtigungen erteilen:',
  'consent.scope.linksRead': '<strong>Lesezugriff</strong> auf Ihre Links',
  'consent.scope.linksWrite': '<strong>Lese- und Schreibzugriff</strong> auf Ihre Links',
  'consent.scope.qrcodesRead': '<strong>Lesezugriff</strong> auf Ihre QR-Codes',
  'consent.scope.qrcodesWrite': '<strong>Lese- und Schreibzugriff</strong> auf Ihre QR-Codes',
  'consent.scope.analyticsRead': '<strong>Lesezugriff</strong> auf Ihre Analysen und Ereignisse',
  'consent.scope.domainsRead': '<strong>Lesezugriff</strong> auf Ihre Domains',
  'consent.scope.tagsRead': '<strong>Lesezugriff</strong> auf Ihre Tags',
  'consent.scope.tagsWrite': '<strong>Lese- und Schreibzugriff</strong> auf Ihre Tags',
  'consent.scope.userRead': 'Ihren Namen, Ihre E-Mail-Adresse und Ihr Profilbild <strong>lesen</strong>',
  'consent.nextTitle': 'So geht es weiter',
  'consent.nextSignIn': 'Melden Sie sich bei CodeQR an oder erstellen Sie ein kostenloses Konto.',
  'consent.nextProject': 'Wählen Sie das Projekt aus, das verbunden werden soll, oder erstellen Sie ein neues.',
  'consent.nextReturnVerified': 'Sie kehren zu {client} zurück.',
  'consent.nextReturnGeneric': 'Sie kehren zu der App zurück, in der Sie begonnen haben.',
  'consent.refuse': 'Ablehnen',
  'consent.continue': 'Weiter',
  'consent.privacy': 'Datenschutzerklärung',
  'consent.terms': 'Nutzungsbedingungen',
};
