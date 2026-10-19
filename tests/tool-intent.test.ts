import { describe, expect, it } from 'vitest';
import { toolIntentFields } from '../src/tool-intent.js';

describe('toolIntentFields', () => {
  it('create_qrcode wifi: type only, no url fields', () => {
    const fields = toolIntentFields('create_qrcode', { type: 'wifi', ssid: 'secret-net' });

    expect(fields).toMatchObject({ qrType: 'wifi', hasTag: false, hasRules: false });
    expect(fields.placeholderDestination).toBeUndefined();
    expect(fields.hasUtm).toBeUndefined();
  });

  it('create_qrcode defaults the type to url', () => {
    expect(toolIntentFields('create_qrcode', { url: 'https://codeqr.io' }).qrType).toBe('url');
  });

  it('create_link with utm, tags and rules sets every flag and has no qrType', () => {
    const fields = toolIntentFields('create_link', {
      url: 'https://codeqr.io/?utm_source=x',
      tagIds: ['t1'],
      rules: [{ split: [] }],
    });

    expect(fields).toMatchObject({ hasUtm: true, hasTag: true, hasRules: true, placeholderDestination: false });
    expect(fields.qrType).toBeUndefined();
  });

  it('tagNames count as tags; empty arrays do not', () => {
    expect(toolIntentFields('create_link', { url: 'https://a.test', tagNames: ['x'] }).hasTag).toBe(true);
    expect(toolIntentFields('create_link', { url: 'https://a.test', tagIds: [], rules: [] })).toMatchObject({
      hasTag: false,
      hasRules: false,
    });
  });

  it('flags a placeholder destination and tolerates an invalid url', () => {
    expect(toolIntentFields('create_link', { url: 'https://example.com' }).placeholderDestination).toBe(true);
    expect(toolIntentFields('create_qrcode', { url: 'example.com/menu' }).placeholderDestination).toBe(true);
    expect(toolIntentFields('create_link', { url: '::bad' })).toMatchObject({
      placeholderDestination: false,
      hasUtm: false,
    });
  });

  it('other tools, and the url itself, produce nothing', () => {
    expect(toolIntentFields('list_links', { url: 'https://example.com' })).toEqual({});
    expect(JSON.stringify(toolIntentFields('create_link', { url: 'https://secret.test/path' }))).not.toContain(
      'secret',
    );
  });

  it('logs a declared type as sent, anything else as other, none as url', () => {
    expect(toolIntentFields('create_qrcode', { type: 'wifi' }).qrType).toBe('wifi');
    expect(toolIntentFields('create_qrcode', { type: 'evil <script>' }).qrType).toBe('other');
    expect(toolIntentFields('create_qrcode', { type: 42 }).qrType).toBe('other');
    expect(toolIntentFields('create_qrcode', {}).qrType).toBe('url');
  });
});
