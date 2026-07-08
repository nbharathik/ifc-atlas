import { fetchIfcSaveAsBlob, acknowledgeSaveAs } from '../api';

export type SaveAsOutcome =
  | { status: 'saved'; filename: string; via: 'file-picker' | 'download' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

interface ShowSaveFilePicker {
  (opts: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }): Promise<{
    name: string;
    createWritable(): Promise<{
      write(data: BlobPart): Promise<void>;
      close(): Promise<void>;
    }>;
  }>;
}

function getShowSaveFilePicker(): ShowSaveFilePicker | null {
  const w = window as unknown as { showSaveFilePicker?: ShowSaveFilePicker };
  return typeof w.showSaveFilePicker === 'function' ? w.showSaveFilePicker : null;
}

function suggestedSaveAsName(originalFilename: string | undefined): string {
  const base = (originalFilename ?? 'model.ifc').replace(/\.ifc$/i, '');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${base}-edited-${ts}.ifc`;
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Save the edited IFC to a user-chosen location. Original file on the
 * server is never modified - these bytes come from the hidden working
 * copy carried by ifc_service.
 *
 * Prefers the File System Access API (`showSaveFilePicker`) so the user
 * gets a real "Save As" dialog with location + filename pickers. Falls
 * back to a classic `<a download>` so Firefox/Safari still work.
 */
export async function saveIfcAs(opts: {
  originalFilename?: string;
}): Promise<SaveAsOutcome> {
  const suggested = suggestedSaveAsName(opts.originalFilename);

  let blob: Blob;
  try {
    blob = await fetchIfcSaveAsBlob(suggested);
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  const picker = getShowSaveFilePicker();
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: suggested,
        types: [
          {
            description: 'IFC file',
            accept: { 'application/octet-stream': ['.ifc'] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      await acknowledgeSaveAs().catch(() => undefined);
      return { status: 'saved', filename: handle.name, via: 'file-picker' };
    } catch (err) {
      // AbortError is what the spec emits when the user cancels.
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { status: 'cancelled' };
      }
      // Fall through to download as a best-effort recovery for picker errors.
    }
  }

  triggerBrowserDownload(blob, suggested);
  await acknowledgeSaveAs().catch(() => undefined);
  return { status: 'saved', filename: suggested, via: 'download' };
}
