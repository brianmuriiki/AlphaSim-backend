import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/lib/crypto.js';

describe('AES-GCM session encryption', () => {
  it('round trips encrypted content', () => {
    const ciphertext = encrypt('session-cookie-value');
    expect(ciphertext.equals(Buffer.from('session-cookie-value'))).toBe(false);
    expect(decrypt(ciphertext)).toBe('session-cookie-value');
  });

  it('rejects modified ciphertext', () => {
    const ciphertext = encrypt('private'); ciphertext[ciphertext.length - 1] ^= 1;
    expect(() => decrypt(ciphertext)).toThrow();
  });
});
