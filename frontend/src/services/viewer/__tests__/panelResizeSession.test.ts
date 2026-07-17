import { describe, expect, it, vi } from 'vitest';
import {
  beginPanelResize,
  endPanelResize,
  PANEL_RESIZE_END_EVENT,
  PANEL_RESIZE_START_EVENT,
} from '../panelResizeSession';

function makeEnvironment() {
  const values = new Set<string>();
  const dispatched: string[] = [];
  const body = {
    classList: {
      add: (name: string) => values.add(name),
      remove: (name: string) => values.delete(name),
      contains: (name: string) => values.has(name),
    },
  } as unknown as HTMLElement;
  const dispatchEvent = vi.fn((event: Event) => {
    dispatched.push(event.type);
    return true;
  });
  return { env: { body, events: { dispatchEvent } }, values, dispatchEvent, dispatched };
}

describe('panel resize session', () => {
  it('emits one start and one end event for a drag session', () => {
    const { env, values, dispatchEvent, dispatched } = makeEnvironment();
    beginPanelResize(env);
    beginPanelResize(env);
    expect(values.has('is-resizing')).toBe(true);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatched[0]).toBe(PANEL_RESIZE_START_EVENT);

    endPanelResize(env);
    endPanelResize(env);
    expect(values.has('is-resizing')).toBe(false);
    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    expect(dispatched[1]).toBe(PANEL_RESIZE_END_EVENT);
  });
});
