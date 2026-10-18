import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_HOSTS, isPlaceholderDestination } from '../src/placeholder-destination.js';

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
