import { describe, it, expect } from 'vitest';
import { deriveControllerKey, timingSafeEqual } from './derive';

describe('deriveControllerKey', () => {
  it('is the hex SHA-256 of hostKey:roomId', async () => {
    const got = await deriveControllerKey('secret', 'room-123');
    // Known vector: SHA-256("secret:room-123"), so the Worker and the player can
    // never drift on the derivation without this failing.
    expect(got).toBe('2786a69dad0b5c49723aa2d4c56b55151185d365d8b33feb93a01affe201d359');
    expect(got).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic and sensitive to both inputs', async () => {
    expect(await deriveControllerKey('a', 'b')).toBe(await deriveControllerKey('a', 'b'));
    expect(await deriveControllerKey('a', 'b')).not.toBe(await deriveControllerKey('a', 'c'));
    expect(await deriveControllerKey('a', 'b')).not.toBe(await deriveControllerKey('x', 'b'));
  });
});

describe('timingSafeEqual', () => {
  it('accepts equal strings and rejects any difference', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false); // length difference
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
