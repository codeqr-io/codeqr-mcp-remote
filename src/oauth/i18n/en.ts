/**
 * Message text is trusted HTML: `<b>` and `<strong>` are markup, and `{name}`
 * values are inserted as given, so a caller rendering HTML escapes them first.
 */
export const en = {
  'consent.pageTitle': 'Authorize API Access | CodeQR',
  'consent.request': '<b>{client}</b> is requesting API access for a project on CodeQR.io.',
  'consent.verified': 'Verified by CodeQR.io',
  'consent.unverified':
    'CodeQR.io has not verified this application. Continue only if you started this connection yourself; if someone sent you this link, refuse.',
  'consent.destinationLabel': 'Access will be sent to:',
  'consent.destinationLoopback':
    'This address is on your own computer, so any program running on it can receive the access.',
  'consent.destinationApp': 'This address opens an app installed on this device.',
  'consent.permissionsLabel': 'Grant permissions:',
  // Same wording as OAUTH_SCOPE_DESCRIPTIONS in the main repo, so both screens
  // describe the access the same way.
  'consent.scope.linksRead': '<strong>Read</strong> access to your links',
  'consent.scope.linksWrite': '<strong>Read and write</strong> access to your links',
  'consent.scope.qrcodesRead': '<strong>Read</strong> access to your QR Codes',
  'consent.scope.qrcodesWrite': '<strong>Read and write</strong> access to your QR Codes',
  'consent.scope.analyticsRead': '<strong>Read</strong> access to your analytics and events',
  'consent.scope.domainsRead': '<strong>Read</strong> access to your domains',
  'consent.scope.tagsRead': '<strong>Read</strong> access to your tags',
  'consent.scope.tagsWrite': '<strong>Read and write</strong> access to your tags',
  'consent.scope.userRead': '<strong>Read</strong> your name, email, and profile picture',
  'consent.nextTitle': 'What happens next',
  'consent.nextSignIn': 'Sign in to CodeQR, or create a free account.',
  'consent.nextProject': 'Choose the project to connect, or create a new one.',
  'consent.nextReturnVerified': 'You return to {client}.',
  'consent.nextReturnGeneric': 'You return to the app you started from.',
  'consent.refuse': 'Refuse',
  'consent.continue': 'Continue',
  'consent.privacy': 'Privacy Policy',
  'consent.terms': 'Terms of Service',
  // Shown on mobile in place of the automatic redirect back to the client.
  'handoff.pageTitle': 'Back to your app | CodeQR',
  'handoff.successVerified': 'Connected to CodeQR. Tap to go back to {client}.',
  'handoff.successGeneric': 'Connected to CodeQR. Tap to go back to your app.',
  'handoff.errorVerified': 'The connection was not completed. Tap to go back to {client}.',
  'handoff.errorGeneric': 'The connection was not completed. Tap to go back to your app.',
  'handoff.button': 'Go back',
} as const satisfies Record<string, string>;

export type MessageKey = keyof typeof en;

export type Messages = Record<MessageKey, string>;
