/**
 * Apply-conflict client helpers.
 *
 * Pins the response-body parser + EditInProgressError contract so the
 * UI's auto-retry never silently swallows the wrong 409. The fetch
 * wrappers (applyPendingEdit / applyPendingEditWithRetry) are tested via
 * a mock global.fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EditInProgressError,
  parseEditInProgressError,
  applyPendingEdit,
  applyPendingEditWithRetry,
} from '../api';

describe('parseEditInProgressError', () => {
  it('returns null for non-409 statuses', () => {
    expect(parseEditInProgressError(200, '{}', 'e1')).toBeNull();
    expect(parseEditInProgressError(400, 'bad', 'e1')).toBeNull();
    expect(parseEditInProgressError(500, '{}', 'e1')).toBeNull();
  });

  it('returns null for 409 with non-JSON body', () => {
    expect(parseEditInProgressError(409, 'something broke', 'e1')).toBeNull();
  });

  it('returns null for 409 with JSON but wrong shape (legacy ValueError 409)', () => {
    // Legacy backend code raises `HTTPException(409, str(e))` which serialises
    // detail as a string, not an object. That must NOT trigger the retry.
    const body = JSON.stringify({ detail: 'Edit edit-xyz not found' });
    expect(parseEditInProgressError(409, body, 'e1')).toBeNull();
  });

  it('returns null for 409 with detail.status !== "edit_in_progress"', () => {
    const body = JSON.stringify({ detail: { status: 'something_else' } });
    expect(parseEditInProgressError(409, body, 'e1')).toBeNull();
  });

  it('extracts retry_after_ms + message for the edit_in_progress shape', () => {
    const body = JSON.stringify({
      detail: {
        status: 'edit_in_progress',
        retry_after_ms: 2500,
        message: 'Custom retry message',
        edit_id: 'e1',
      },
    });
    const err = parseEditInProgressError(409, body, 'e1');
    expect(err).toBeInstanceOf(EditInProgressError);
    expect(err!.retryAfterMs).toBe(2500);
    expect(err!.editId).toBe('e1');
    expect(err!.message).toBe('Custom retry message');
  });

  it('defaults retry_after_ms to 1500 when absent', () => {
    const body = JSON.stringify({
      detail: { status: 'edit_in_progress', message: 'gate held' },
    });
    const err = parseEditInProgressError(409, body, 'e2');
    expect(err).not.toBeNull();
    expect(err!.retryAfterMs).toBe(1500);
  });
});

describe('applyPendingEdit fetch wrapper', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('throws EditInProgressError on a structured 409', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            detail: { status: 'edit_in_progress', retry_after_ms: 500, message: 'busy' },
          }),
        ),
    } as unknown as Response);

    await expect(applyPendingEdit('e1')).rejects.toBeInstanceOf(EditInProgressError);
  });

  it('throws plain Error for other failures', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('bad input'),
    } as unknown as Response);

    await expect(applyPendingEdit('e1')).rejects.toThrow('API error 400');
  });

  it('returns the envelope on success', async () => {
    const envelope = { edit_id: 'e1', summary: 'ok' };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(envelope),
    } as unknown as Response);

    const result = await applyPendingEdit('e1');
    expect(result).toEqual(envelope);
  });
});

describe('applyPendingEditWithRetry', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it('retries once after edit_in_progress 409 and returns the second envelope', async () => {
    const envelope = { edit_id: 'e1', summary: 'ok-on-retry' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              detail: { status: 'edit_in_progress', retry_after_ms: 100, message: 'busy' },
            }),
          ),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(envelope),
      } as unknown as Response);
    global.fetch = fetchMock;

    const promise = applyPendingEditWithRetry('e1');
    // Advance the retry timer so the second fetch can fire.
    await vi.advanceTimersByTimeAsync(150);
    const result = await promise;
    expect(result).toEqual(envelope);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry for non-EditInProgress errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('bad input'),
    } as unknown as Response);
    global.fetch = fetchMock;

    await expect(applyPendingEditWithRetry('e1')).rejects.toThrow('API error 400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the second 409 if the gate is still held on retry', async () => {
    const errorBody = JSON.stringify({
      detail: { status: 'edit_in_progress', retry_after_ms: 50, message: 'busy' },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: () => Promise.resolve(errorBody),
    } as unknown as Response);
    global.fetch = fetchMock;

    const promise = applyPendingEditWithRetry('e1');
    // Hook the rejection so unhandled-rejection warnings don't fire.
    const settled = promise.catch((err) => err);
    await vi.advanceTimersByTimeAsync(100);
    const err = await settled;
    expect(err).toBeInstanceOf(EditInProgressError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
