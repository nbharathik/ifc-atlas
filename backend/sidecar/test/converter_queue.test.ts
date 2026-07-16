import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _internal } from '../src/converter.js';

describe('converter serial executor', () => {
  it('runs queued work in FIFO order with at most one active job', async () => {
    const runSerial = _internal.createSerialExecutor();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runSerial(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push('first:start');
      await firstGate;
      events.push('first:end');
      active -= 1;
      return 1;
    });
    const second = runSerial(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push('second:start');
      active -= 1;
      return 2;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['first:start']);
    releaseFirst();

    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.equal(maxActive, 1);
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
  });

  it('continues with the next job after a rejection', async () => {
    const runSerial = _internal.createSerialExecutor();
    const failed = runSerial(async () => {
      throw new Error('conversion failed');
    });
    const next = runSerial(async () => 'completed');

    await assert.rejects(failed, /conversion failed/);
    assert.equal(await next, 'completed');
  });
});
