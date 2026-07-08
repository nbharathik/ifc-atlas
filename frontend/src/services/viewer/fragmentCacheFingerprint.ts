// Fragment-cache fingerprint helpers.
// SubtleCrypto SHA-1 when available; FNV + rolling mix fallback otherwise.

export function buildFnvFingerprint(bytes: Uint8Array): string {
  const length = bytes.length;
  if (length === 0) return '0-0';

  let h1 = 2166136261;
  let h2 = 2246822519;
  for (let i = 0; i < length; i++) {
    const b = bytes[i];
    h1 ^= b;
    h1 = Math.imul(h1, 16777619);
    h2 ^= (b + (i & 0xff));
    h2 = Math.imul(h2, 1597334677);
  }

  return `${length.toString(16)}-${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

export async function buildFragmentCacheFingerprint(bytes: Uint8Array): Promise<string> {
  const length = bytes.length;
  if (length === 0) return '0-0';

  const subtle =
    typeof globalThis !== 'undefined'
      ? (globalThis.crypto as Crypto | undefined)?.subtle
      : undefined;

  if (subtle && typeof subtle.digest === 'function') {
    try {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const digest = await subtle.digest('SHA-1', copy);
      const digestBytes = new Uint8Array(digest);
      return `${length.toString(16)}-${bytesToHex(digestBytes)}`;
    } catch {
      // Fall through to FNV below.
    }
  }

  return buildFnvFingerprint(bytes);
}
