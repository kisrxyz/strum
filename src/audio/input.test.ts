import { describe, expect, it } from 'vitest';
import { NO_INPUT, openInput } from './input';

describe('openInput', () => {
  it('«Без входа» opens no microphone at all', async () => {
    // In the node test environment there is no navigator: any getUserMedia call would throw.
    await expect(openInput(NO_INPUT)).resolves.toBeNull();
  });
});
