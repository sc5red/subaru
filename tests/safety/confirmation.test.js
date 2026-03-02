import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConfirmationHandler, resolveConfirmation, getPendingConfirmations } from '../../src/safety/confirmation.js';

vi.mock('../../src/utils/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

describe('confirmation - web handler', () => {
  it('should create a web confirmation and resolve it via resolveConfirmation', async () => {
    const confirmFn = createConfirmationHandler('web');

    // Start confirmation (non-blocking)
    const confirmPromise = confirmFn('Delete important file?');

    // There should be a pending confirmation now
    const pending = getPendingConfirmations();
    expect(pending.length).toBeGreaterThanOrEqual(1);

    const lastPending = pending[pending.length - 1];
    expect(lastPending.description).toBe('Delete important file?');

    // Resolve it
    const resolved = resolveConfirmation(lastPending.confirmationId, true);
    expect(resolved).toBe(true);

    // The promise should resolve to true
    const result = await confirmPromise;
    expect(result).toBe(true);
  });

  it('should resolve to false when denied', async () => {
    const confirmFn = createConfirmationHandler('web');
    const confirmPromise = confirmFn('Run dangerous command?');

    const pending = getPendingConfirmations();
    const lastPending = pending[pending.length - 1];

    resolveConfirmation(lastPending.confirmationId, false);

    const result = await confirmPromise;
    expect(result).toBe(false);
  });

  it('should return false for non-existent confirmation IDs', () => {
    const result = resolveConfirmation('nonexistent_id', true);
    expect(result).toBe(false);
  });
});

describe('confirmation - default handler', () => {
  it('should return false for unknown interface types', async () => {
    const confirmFn = createConfirmationHandler('unknown');
    const result = await confirmFn('Some action');
    expect(result).toBe(false);
  });
});
