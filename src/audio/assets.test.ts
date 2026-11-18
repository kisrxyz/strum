import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadUserAssetBytes } from './assets';
import { userGet } from './userFiles';

vi.mock('./userFiles', () => ({ userGet: vi.fn(), userPut: vi.fn(), userList: vi.fn(), userDelete: vi.fn() }));

beforeEach(() => vi.mocked(userGet).mockReset());

describe('loadUserAssetBytes', () => {
  it('gives a dropped model (stored as text) as UTF-8 bytes', async () => {
    vi.mocked(userGet).mockResolvedValue({ kind: 'model', data: '{"версия":"0.5.4"}' });
    const asset = await loadUserAssetBytes('user:m');
    expect(asset?.kind).toBe('model');
    expect(new TextDecoder().decode(asset!.bytes)).toBe('{"версия":"0.5.4"}');
    expect(userGet).toHaveBeenCalledWith('user:m');
  });

  it('gives a dropped cabinet (stored as bytes) as it is', async () => {
    const wav = Uint8Array.of(82, 73, 70, 70, 1, 2, 3).buffer;
    vi.mocked(userGet).mockResolvedValue({ kind: 'ir', data: wav });
    const asset = await loadUserAssetBytes('user:c');
    expect(asset?.kind).toBe('ir');
    expect(Array.from(asset!.bytes)).toEqual([82, 73, 70, 70, 1, 2, 3]);
  });

  it('gives null for a file that is gone, and never looks up a built-in one', async () => {
    vi.mocked(userGet).mockResolvedValue(undefined);
    expect(await loadUserAssetBytes('user:gone')).toBeNull();
    expect(await loadUserAssetBytes('nam:jc')).toBeNull();
    expect(await loadUserAssetBytes('simple')).toBeNull();
    expect(userGet).toHaveBeenCalledTimes(1);
  });
});
