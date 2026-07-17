export const PANEL_RESIZE_START_EVENT = 'ifc-panel-resize-start';
export const PANEL_RESIZE_END_EVENT = 'ifc-panel-resize-end';

export interface PanelResizeEnvironment {
  body: Pick<HTMLElement, 'classList'>;
  events: Pick<EventTarget, 'dispatchEvent'>;
}

/** Mark a panel drag as active before its first layout mutation. */
export function beginPanelResize(env: PanelResizeEnvironment): void {
  if (env.body.classList.contains('is-resizing')) return;
  env.body.classList.add('is-resizing');
  env.events.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));
}

/** End a panel drag and let the viewer perform one settled render refresh. */
export function endPanelResize(env: PanelResizeEnvironment): void {
  if (!env.body.classList.contains('is-resizing')) return;
  env.body.classList.remove('is-resizing');
  env.events.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
}
