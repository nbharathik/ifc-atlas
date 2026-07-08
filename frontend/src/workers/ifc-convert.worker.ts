/// <reference lib="webworker" />
//
// IFC conversion worker - runs IfcImporter.process() off the main thread
// so the UI stays 60 fps during the heavy WASM geometry conversion step.
//
// Protocol:
//   req → { id, type:'convert', bytes: ArrayBuffer [transferred], profile, wasmPath }
//   res ← { type:'done',     id, buffer: ArrayBuffer [transferred], parseMs }
//     | { type:'progress', id, stage: string, pct: number }
//     | { type:'error',    id, message: string }
//
// The IfcImporter singleton is kept alive between requests so WASM init
// only pays once per worker lifetime. It is recreated only when the
// profile changes (profile settings are baked into the importer).

// IMPORTANT: this side-effect import MUST come before @thatopen/fragments
// so the IfcImporter instance inside FRAGS uses our patched, single-threaded
// IfcAPI.Init. Otherwise web-ifc tries to spawn child workers from the
// dev server with the wrong worker type and the whole convert fails.
import '../services/ifc/webIfcPatch';
import * as FRAGS from '@thatopen/fragments';
import { configureImporter, type ParseProfile } from '../services/viewer/parseProfiles';

// ── Message types ─────────────────────────────────────────────────────────

interface ConvertRequest {
  id: string;
  type: 'convert';
  bytes: ArrayBuffer; // transferred zero-copy
  profile: ParseProfile;
  wasmPath: string;
}

interface ConvertDone {
  type: 'done';
  id: string;
  buffer: ArrayBuffer; // transferred zero-copy
  parseMs: number;
}

interface ConvertProgress {
  type: 'progress';
  id: string;
  stage: string;
  pct: number;
}

interface ConvertError {
  type: 'error';
  id: string;
  message: string;
}

type OutMessage = ConvertDone | ConvertProgress | ConvertError;

// ── Singleton importer ─────────────────────────────────────────────────────

let importer: FRAGS.IfcImporter | null = null;
let activeProfile: ParseProfile | null = null;

function getImporter(profile: ParseProfile, wasmPath: string): FRAGS.IfcImporter {
  if (importer && activeProfile === profile) return importer;
  // Profile changed (or first call) - recreate so settings are clean.
  importer = new FRAGS.IfcImporter();
  importer.wasm.path = wasmPath;
  importer.wasm.absolute = true;
  configureImporter(importer, profile);
  activeProfile = profile;
  return importer;
}

// ── Main handler ───────────────────────────────────────────────────────────

const post = (msg: OutMessage, transfer?: Transferable[]): void => {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
};

self.onmessage = async (e: MessageEvent<ConvertRequest>) => {
  const { id, bytes, profile, wasmPath } = e.data;
  if (!bytes || bytes.byteLength === 0) {
    post({ type: 'error', id, message: 'empty IFC bytes received' });
    return;
  }
  const imp = getImporter(profile, wasmPath);
  const start = performance.now();
  try {
    const result = await imp.process({
      bytes: new Uint8Array(bytes),
      progressCallback: (pct, data) => {
        post({ type: 'progress', id, stage: data.process ?? 'parsing', pct });
      },
    });
    const parseMs = performance.now() - start;
    post({ type: 'done', id, buffer: result.buffer, parseMs }, [result.buffer]);
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};

export {};
