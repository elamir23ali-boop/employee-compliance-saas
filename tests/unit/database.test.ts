import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../../packages/database/src/index';

describe('createDb', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers a pool error handler that logs without throwing', () => {
    const { pool } = createDb({ connectionString: 'postgres://test-only-never-connected' });

    const listeners = pool.listeners('error');
    expect(listeners).toHaveLength(1);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const simulated = new Error('terminating connection due to administrator command');

    expect(() => pool.emit('error', simulated)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const loggedArg = errorSpy.mock.calls[0]?.[0] as string;
    expect(JSON.parse(loggedArg)).toEqual({ action: 'db_pool_error', message: simulated.message });

    void pool.end();
  });
});
