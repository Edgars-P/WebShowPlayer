import { describe, it, expect } from 'vitest';
import { authorizeRemote } from './authorize';
import { deriveControllerKey } from '../src/lib/remote/derive';

const HOST_KEY = 'super-secret-shared-key';

describe('authorizeRemote', () => {
  it('accepts the host presenting the host key', async () => {
    expect(await authorizeRemote('host', HOST_KEY, 'room1', HOST_KEY)).toBe('host');
  });

  it('rejects a wrong host key', async () => {
    expect(await authorizeRemote('host', 'nope', 'room1', HOST_KEY)).toBeNull();
  });

  it('accepts a controller presenting the correctly derived key', async () => {
    const key = await deriveControllerKey(HOST_KEY, 'room1');
    expect(await authorizeRemote('controller', key, 'room1', HOST_KEY)).toBe('controller');
  });

  it('rejects a controller key derived for a different room', async () => {
    const key = await deriveControllerKey(HOST_KEY, 'other-room');
    expect(await authorizeRemote('controller', key, 'room1', HOST_KEY)).toBeNull();
  });

  it('rejects the raw host key presented as a controller (no role escalation)', async () => {
    expect(await authorizeRemote('controller', HOST_KEY, 'room1', HOST_KEY)).toBeNull();
  });

  it('rejects unknown roles and missing inputs', async () => {
    const key = await deriveControllerKey(HOST_KEY, 'room1');
    expect(await authorizeRemote('admin', key, 'room1', HOST_KEY)).toBeNull();
    expect(await authorizeRemote('', key, 'room1', HOST_KEY)).toBeNull();
    expect(await authorizeRemote('host', '', 'room1', HOST_KEY)).toBeNull();
    expect(await authorizeRemote('controller', key, '', HOST_KEY)).toBeNull();
    // A misconfigured Worker with no HOST_KEY must never authorize anyone.
    expect(await authorizeRemote('host', '', 'room1', '')).toBeNull();
    expect(await authorizeRemote('host', 'anything', 'room1', '')).toBeNull();
  });
});
