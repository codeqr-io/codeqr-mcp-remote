import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_HOSTS,
  isPlaceholderDestination,
  placeholderDestinationIn,
  placeholderRefusal,
} from '../src/placeholder-destination.js';

describe('isPlaceholderDestination', () => {
  it.each(['https://example.com', 'https://www.example.com/x', 'http://localhost:3000/x', 'https://a.b.demo.com'])(
    'flags %s',
    (url) => {
      expect(isPlaceholderDestination(url)).toBe(true);
    },
  );

  it.each(['https://example.com.br', 'https://myexample.com', 'https://codeqr.io', 'not a url', ''])(
    'accepts %s',
    (url) => {
      expect(isPlaceholderDestination(url)).toBe(false);
    },
  );

  it('flags every listed host', () => {
    for (const host of PLACEHOLDER_HOSTS) expect(isPlaceholderDestination(`https://${host}/`)).toBe(true);
  });
});

describe('placeholderDestinationIn', () => {
  it.each(['create_link', 'update_link', 'create_qrcode', 'update_qrcode'])(
    'finds a placeholder url sent to %s',
    (tool) => {
      expect(placeholderDestinationIn(tool, { url: 'https://menu.example.com/x' })).toBe('https://menu.example.com/x');
    },
  );

  it('leaves real destinations, other tools and non-string urls alone', () => {
    expect(placeholderDestinationIn('create_link', { url: 'https://codeqr.io/menu' })).toBeUndefined();
    expect(placeholderDestinationIn('get_link_info', { url: 'https://example.com' })).toBeUndefined();
    expect(placeholderDestinationIn('create_qrcode', { type: 'wifi', wifi: { ssid: 'Cafe' } })).toBeUndefined();
    expect(placeholderDestinationIn('create_qrcode', { url: 42 })).toBeUndefined();
    expect(placeholderDestinationIn('create_qrcode', undefined)).toBeUndefined();
  });
});

describe('placeholderRefusal', () => {
  it('names the host, says nothing was written and asks for the real link', () => {
    const text = placeholderRefusal('https://example.com/menu?table=4');
    expect(text).toMatch(/^example\.com is a placeholder/);
    expect(text).not.toContain('table=4');
    expect(text).toMatch(/nothing was created or changed/);
    expect(text).toMatch(/Ask the person for the real link/);
  });
});
