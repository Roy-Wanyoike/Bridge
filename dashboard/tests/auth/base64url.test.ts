import { describe, expect, test } from 'vitest';
import {
  decodeBase64,
  encodeBase64Standard,
  encodeBase64Url,
  utf8Bytes,
  utf8Text,
} from '@/lib/auth/base64url';

describe('base64url primitives (issue #163)', () => {
  test('round-trips ASCII and unicode', () => {
    for (const s of ['', 'bridge', 'secret value: /+?=y', 'ünïcodé ✓ 中文']) {
      const encoded = encodeBase64Url(utf8Bytes(s));
      expect(encoded).not.toMatch(/[+/=]/);
      const decoded = decodeBase64(encoded);
      expect(decoded).not.toBeNull();
      expect(utf8Text(decoded as Uint8Array)).toBe(s);
    }
  });

  test('matches known vectors', () => {
    // RFC 4648 test vectors (base64url form, no padding)
    expect(encodeBase64Url(utf8Bytes('f'))).toBe('Zg');
    expect(encodeBase64Url(utf8Bytes('fo'))).toBe('Zm8');
    expect(encodeBase64Url(utf8Bytes('foo'))).toBe('Zm9v');
    expect(encodeBase64Url(utf8Bytes('foob'))).toBe('Zm9vYg');
    expect(encodeBase64Url(utf8Bytes('fooba'))).toBe('Zm9vYmE');
    expect(encodeBase64Url(utf8Bytes('foobar'))).toBe('Zm9vYmFy');
  });

  test('standard base64 pads like the platform', () => {
    expect(encodeBase64Standard(utf8Bytes('f'))).toBe('Zg==');
    expect(encodeBase64Standard(utf8Bytes('fo'))).toBe('Zm8=');
    expect(encodeBase64Standard(utf8Bytes('foobar'))).toBe('Zm9vYmFy');
  });

  test('decode rejects invalid input instead of throwing', () => {
    expect(decodeBase64('!!!!')).toBeNull();
    expect(decodeBase64('Zm9v!')).toBeNull();
    // Non-canonical trailing bits must not silently decode.
    expect(decodeBase64('Zh')).toBeNull();
    expect(decodeBase64('')).toEqual(new Uint8Array(0));
  });
});
