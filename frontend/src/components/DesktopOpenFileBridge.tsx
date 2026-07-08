import { useEffect, useRef } from 'react';
import { invokeCommand, isTauri } from '../lib/platform';
import { useIfcUpload } from '../hooks/useIfcUpload';

/**
 * Desktop-only bridge for OS "Open with" file associations.
 *
 * Two arrival paths (see src-tauri/src/lib.rs):
 *  - FIRST launch: Explorer passes the double-clicked .ifc as plain argv; the
 *    Rust shell stashes it and we collect it once via `get_open_with_path`.
 *  - While RUNNING: a second launch is captured by the single-instance plugin,
 *    which focuses this window and emits an `open-file` event with the path.
 *
 * The file bytes come through the `read_ifc_file` command as a raw binary IPC
 * response (ArrayBuffer - no JSON copy of a 100 MB model), get wrapped in a
 * File, and enter the exact same `useIfcUpload` pipeline as drag-drop and the
 * Menubar's Open. Renders nothing; a no-op on web builds.
 */
export default function DesktopOpenFileBridge() {
  const upload = useIfcUpload();
  // The upload fn identity changes with store state; keep the latest in a ref
  // so the mount-once effect below never re-subscribes.
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  const busyRef = useRef(false);

  useEffect(() => {
    // Runtime check on purpose (NOT compile-time isDesktop): `tauri dev` loads
    // the plain Vite server where VITE_PLATFORM is unset, and the bridge must
    // still work there. Web builds have no window.__TAURI__, so this no-ops.
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const loadPath = async (path: string) => {
      if (busyRef.current) {
        console.warn('[open-with] already loading a file, ignoring', path);
        return;
      }
      busyRef.current = true;
      try {
        const bytes = await invokeCommand<ArrayBuffer>('read_ifc_file', { path });
        if (!bytes) return;
        const name = path.split(/[\\/]/).pop() || 'model.ifc';
        const file = new File([bytes], name, { type: 'application/octet-stream' });
        const result = await uploadRef.current(file);
        if (result.ok === false) {
          console.error('[open-with] failed to load', path, result.error);
        }
      } catch (err) {
        console.error('[open-with] could not open', path, err);
      } finally {
        busyRef.current = false;
      }
    };

    // First-launch handoff (take-once; returns null when launched normally).
    void invokeCommand<string | null>('get_open_with_path').then((p) => {
      if (!disposed && p) void loadPath(p);
    });

    // Second launches while running (single-instance plugin).
    window.__TAURI__?.event
      ?.listen<{ path: string }>('open-file', ({ payload }) => {
        if (payload?.path) void loadPath(payload.path);
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      })
      .catch((err) => console.warn('[open-with] failed to attach listener', err));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return null;
}
