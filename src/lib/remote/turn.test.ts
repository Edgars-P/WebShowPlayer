import { describe, it, expect } from 'vitest';
import {
  credentialsUrl,
  decodeIceServers,
  encodeIceServers,
  parseIceServers,
  type IceServer,
} from './turn';

describe('parseIceServers', () => {
  it('reads an array of servers from a Cloudflare response', () => {
    const payload = {
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        {
          urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'],
          username: 'user',
          credential: 'secret',
        },
      ],
    };
    expect(parseIceServers(payload)).toEqual(payload.iceServers);
  });

  it('accepts a single server object under iceServers', () => {
    const payload = { iceServers: { urls: 'turn:turn.example:3478', username: 'u', credential: 'c' } };
    expect(parseIceServers(payload)).toEqual([{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }]);
  });

  it('drops malformed entries rather than producing a broken config', () => {
    const payload = {
      iceServers: [
        { urls: 'turn:ok:3478', username: 'u', credential: 'c' },
        { notUrls: 'nope' },
        { urls: [1, 2, 3] },
        null,
        'string',
      ],
    };
    expect(parseIceServers(payload)).toEqual([{ urls: 'turn:ok:3478', username: 'u', credential: 'c' }]);
  });

  it('returns [] for anything unexpected', () => {
    expect(parseIceServers(null)).toEqual([]);
    expect(parseIceServers('nope')).toEqual([]);
    expect(parseIceServers({})).toEqual([]);
    expect(parseIceServers({ iceServers: 42 })).toEqual([]);
  });
});

describe('encode/decode ICE servers for the QR fragment', () => {
  const servers: IceServer[] = [
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'user+id/slash', credential: 'p@ss=word' },
  ];

  it('round-trips through the URL-safe encoding', () => {
    const encoded = encodeIceServers(servers);
    expect(encoded).not.toMatch(/[+/=]/); // URL-safe: no +, /, or = that would need escaping
    expect(decodeIceServers(encoded)).toEqual(servers);
  });

  it('re-validates on decode, ignoring a tampered fragment', () => {
    const tampered = encodeIceServers([{ urls: 'turn:ok:3478' }]).slice(0, -3) + 'zzz';
    // Either it fails to parse (null) or it decodes to a clean, validated list.
    const decoded = decodeIceServers(tampered);
    if (decoded !== null) {
      expect(Array.isArray(decoded)).toBe(true);
    }
  });

  it('returns null for non-base64 junk', () => {
    expect(decodeIceServers('!!!not base64!!!')).toBeNull();
  });

  it('rejects a payload that is not an array', () => {
    const encodedObject = encodeIceServers([]).replace(/.*/, () => {
      const json = JSON.stringify({ nope: true });
      return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    });
    expect(decodeIceServers(encodedObject)).toBeNull();
  });
});

describe('credentialsUrl', () => {
  it('builds the Cloudflare generate endpoint for a key id', () => {
    expect(credentialsUrl('abc123')).toBe(
      'https://rtc.live.cloudflare.com/v1/turn/keys/abc123/credentials/generate-ice-servers',
    );
  });

  it('escapes an unusual key id', () => {
    expect(credentialsUrl('a/b')).toContain('a%2Fb');
  });
});
