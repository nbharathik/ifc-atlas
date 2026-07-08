/**
 * Byte-level STEP physical file lexer.
 *
 * The point of this module is to walk the raw IFC bytes ONCE, without
 * building intermediate UTF-16 strings, and emit higher-level tokens to a
 * caller (the entity-table parser in `parser.ts`). Working on bytes keeps
 * memory + GC pressure low: a 50 MB `.ifc` slurped into a JS string is
 * ~100 MB on heap (UTF-16 expansion) before parsing even starts.
 *
 * The lexer is deliberately small + side-effect-free. It exposes one entry
 * point, `scanEntities(bytes, onEntity, onHeaderRaw)`, which streams the
 * file:
 *
 *  - HEADER section is collected as a small list of raw entity-shaped
 *    strings, handed to `onHeaderRaw`. The header parser turns those into
 *    typed records.
 *  - DATA section emits each `#N=TYPE(args);` to `onEntity` as a typed
 *    `EntityRecord` (raw `argsRaw`; V1 does no argument typing).
 *
 * Edge cases handled in V1:
 *  - Multi-line entities (anywhere in args).
 *  - Strings using single-quote `'…'` with `''` doubled-quote escape.
 *  - C-style comments `/* … *\/` between entities.
 *  - Whitespace insensitivity (spaces, tabs, CR, LF).
 *  - Mixed case keywords ('header'/'HEADER', 'data'/'DATA' both seen
 *    in the wild).
 *
 * Edge cases deferred to V2:
 *  - `\X2\…\X0\` Unicode escapes inside strings (kept raw).
 *  - `D` exponent in numeric literals (kept raw).
 *  - Fully typed argument parsing (lists, sets, enums, refs).
 */

import { TextDecoder } from 'node:util';

import type { EntityRecord } from './types.js';

// Byte constants. Keeping these as named constants makes the state machine
// readable without sprinkling magic-number ASCII codes.
const HASH = 0x23; // '#'
const EQUALS = 0x3d; // '='
const SEMI = 0x3b; // ';'
const LPAREN = 0x28; // '('
const RPAREN = 0x29; // ')'
const SLASH = 0x2f; // '/'
const ASTERISK = 0x2a; // '*'
const SQUOTE = 0x27; // "'"
const NL = 0x0a;
const CR = 0x0d;
const SP = 0x20;
const TAB = 0x09;
const ZERO = 0x30;
const NINE = 0x39;
const A_UP = 0x41;
const Z_UP = 0x5a;
const A_LO = 0x61;
const Z_LO = 0x7a;
const UNDERSCORE = 0x5f;

function isWhitespace(b: number): boolean {
  return b === SP || b === TAB || b === NL || b === CR;
}

function isDigit(b: number): boolean {
  return b >= ZERO && b <= NINE;
}

function isIdentChar(b: number): boolean {
  return (
    (b >= A_UP && b <= Z_UP) ||
    (b >= A_LO && b <= Z_LO) ||
    (b >= ZERO && b <= NINE) ||
    b === UNDERSCORE
  );
}

/**
 * Skip whitespace + C-style comments starting at `pos`. Returns the new
 * position. Comments only legally appear *between* entities at the top
 * level; strings inside an entity's args are handled by the per-entity
 * scan loop instead.
 */
function skipTrivia(bytes: Uint8Array, pos: number): number {
  const len = bytes.length;
  while (pos < len) {
    const b = bytes[pos];
    if (isWhitespace(b)) {
      pos++;
      continue;
    }
    if (b === SLASH && pos + 1 < len && bytes[pos + 1] === ASTERISK) {
      // /* ... */ block: scan to next */ and continue. EOF inside a comment is
      // a malformed file; the outer loop terminates harmlessly.
      pos += 2;
      while (pos + 1 < len && !(bytes[pos] === ASTERISK && bytes[pos + 1] === SLASH)) {
        pos++;
      }
      pos = Math.min(pos + 2, len); // consume "*/"
      continue;
    }
    return pos;
  }
  return pos;
}

/**
 * Scan a STEP "instance" (a `#N=TYPE(args);` block) starting at the byte
 * just past `#`. Returns the parsed record OR null on parse failure
 * (caller logs a warning and resyncs to the next `;`).
 *
 * `startOffset` should be the offset of the `#` byte (i.e. one less than
 * `pos`).
 */
function scanInstance(
  bytes: Uint8Array,
  pos: number,
  startOffset: number,
  decoder: TextDecoder,
): { record: EntityRecord; nextPos: number } | null {
  const len = bytes.length;

  // 1. integer Express ID
  const idStart = pos;
  while (pos < len && isDigit(bytes[pos])) pos++;
  if (pos === idStart) return null; // expected at least one digit
  // Parse the integer manually: no `decoder.decode` cost on a tiny slice.
  let expressId = 0;
  for (let i = idStart; i < pos; i++) expressId = expressId * 10 + (bytes[i] - ZERO);

  // 2. optional whitespace + '='
  pos = skipTrivia(bytes, pos);
  if (pos >= len || bytes[pos] !== EQUALS) return null;
  pos++;

  // 3. optional whitespace + identifier
  pos = skipTrivia(bytes, pos);
  const typeStart = pos;
  while (pos < len && isIdentChar(bytes[pos])) pos++;
  if (pos === typeStart) return null;
  // Type identifiers are pure ASCII; `decoder.decode` works but a tight
  // loop is faster on a 9-char average string.
  let typeStr = '';
  for (let i = typeStart; i < pos; i++) {
    const b = bytes[i];
    // Uppercase normalize a-z → A-Z so 'IfcWall' === 'IFCWALL'.
    typeStr += String.fromCharCode(b >= A_LO && b <= Z_LO ? b - 32 : b);
  }

  // 4. optional whitespace + '('
  pos = skipTrivia(bytes, pos);
  if (pos >= len || bytes[pos] !== LPAREN) return null;
  pos++;

  // 5. read args until matching top-level ')', then ';'.
  const argsStart = pos;
  let depth = 1;
  let inString = false;
  while (pos < len && depth > 0) {
    const b = bytes[pos];
    if (inString) {
      if (b === SQUOTE) {
        // Doubled-quote escape: '' means stay inside the string.
        if (pos + 1 < len && bytes[pos + 1] === SQUOTE) {
          pos += 2;
          continue;
        }
        inString = false;
        pos++;
        continue;
      }
      pos++;
      continue;
    }
    if (b === SQUOTE) {
      inString = true;
      pos++;
      continue;
    }
    if (b === LPAREN) {
      depth++;
      pos++;
      continue;
    }
    if (b === RPAREN) {
      depth--;
      pos++;
      continue;
    }
    pos++;
  }
  if (depth !== 0) return null;
  // pos is now just past the closing ')'. argsRaw is between argsStart and pos-1.
  const argsRaw = decoder.decode(bytes.subarray(argsStart, pos - 1));

  // 6. optional whitespace + ';'
  pos = skipTrivia(bytes, pos);
  if (pos >= len || bytes[pos] !== SEMI) return null;
  pos++;

  return {
    record: {
      expressId,
      type: typeStr,
      argsRaw,
      startOffset,
      endOffset: pos,
    },
    nextPos: pos,
  };
}

/** Section markers in the SPF file, used by `scanSections` below. */
type Section = 'PRE' | 'HEADER' | 'DATA' | 'POST';

/**
 * Match a literal ASCII keyword (case-insensitive) at `pos`, returning the
 * position just past it on a hit, or `-1` on miss.
 */
function matchKeyword(bytes: Uint8Array, pos: number, keyword: string): number {
  if (pos + keyword.length > bytes.length) return -1;
  for (let i = 0; i < keyword.length; i++) {
    let b = bytes[pos + i];
    if (b >= A_LO && b <= Z_LO) b -= 32;
    if (b !== keyword.charCodeAt(i)) return -1;
  }
  return pos + keyword.length;
}

export interface ScanCallbacks {
  /** Called once per DATA-section entity. */
  onEntity: (record: EntityRecord) => void;
  /**
   * Called once per HEADER entity, with the raw `TYPE(args)` text (no `;`
   * tail, no leading whitespace). The header is small enough that the
   * caller can string-process it without losing perf.
   */
  onHeaderRaw: (raw: string) => void;
  /** Called when the lexer skips a malformed entity. */
  onWarning?: (message: string, offset: number) => void;
}

/**
 * Walk the file once, dispatching entities into HEADER vs DATA buckets.
 *
 * The function is intentionally not async: Node `fs.readFileSync` returns
 * a Buffer in one shot and 50 MB is small enough to keep on heap. If we
 * ever need to handle 1 GB+ files we'll move to a streaming `Readable`.
 */
export function scanSections(bytes: Uint8Array, cb: ScanCallbacks): void {
  const len = bytes.length;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let pos = 0;
  let section: Section = 'PRE';

  while (pos < len) {
    pos = skipTrivia(bytes, pos);
    if (pos >= len) break;

    const b = bytes[pos];

    // Section transitions. Only fire at the start of a "word"; they
    // never appear inside an entity, so this check is safe.
    if (section !== 'DATA' && (b === 0x48 || b === 0x68)) {
      // Possible 'HEADER;' (case-insensitive match).
      const after = matchKeyword(bytes, pos, 'HEADER');
      if (after !== -1) {
        const semiAt = skipTrivia(bytes, after);
        if (semiAt < len && bytes[semiAt] === SEMI) {
          section = 'HEADER';
          pos = semiAt + 1;
          continue;
        }
      }
    }
    if ((b === 0x44 || b === 0x64) && section !== 'DATA') {
      const after = matchKeyword(bytes, pos, 'DATA');
      if (after !== -1) {
        const semiAt = skipTrivia(bytes, after);
        if (semiAt < len && bytes[semiAt] === SEMI) {
          section = 'DATA';
          pos = semiAt + 1;
          continue;
        }
      }
    }
    if (b === 0x45 || b === 0x65) {
      // ENDSEC; closes the current section.
      const after = matchKeyword(bytes, pos, 'ENDSEC');
      if (after !== -1) {
        const semiAt = skipTrivia(bytes, after);
        if (semiAt < len && bytes[semiAt] === SEMI) {
          section = section === 'DATA' ? 'POST' : 'PRE';
          pos = semiAt + 1;
          continue;
        }
      }
    }

    if (section === 'HEADER') {
      // HEADER entities look like `TYPE(args);` with no `#N=` prefix.
      const typeStart = pos;
      while (pos < len && isIdentChar(bytes[pos])) pos++;
      if (pos === typeStart) {
        // Unrecognised: skip a byte to avoid infinite loop.
        pos++;
        continue;
      }
      // Capture raw "TYPE(...)" text by extending until the matching ');'.
      const rawStart = typeStart;
      pos = skipTrivia(bytes, pos);
      if (pos >= len || bytes[pos] !== LPAREN) {
        if (cb.onWarning) cb.onWarning('header entity missing (', typeStart);
        // Resync to next ';'.
        while (pos < len && bytes[pos] !== SEMI) pos++;
        if (pos < len) pos++;
        continue;
      }
      pos++;
      let depth = 1;
      let inString = false;
      while (pos < len && depth > 0) {
        const bb = bytes[pos];
        if (inString) {
          if (bb === SQUOTE) {
            if (pos + 1 < len && bytes[pos + 1] === SQUOTE) {
              pos += 2;
              continue;
            }
            inString = false;
          }
          pos++;
          continue;
        }
        if (bb === SQUOTE) inString = true;
        else if (bb === LPAREN) depth++;
        else if (bb === RPAREN) depth--;
        pos++;
      }
      const rawEnd = pos; // just past closing ')'
      cb.onHeaderRaw(decoder.decode(bytes.subarray(rawStart, rawEnd)));
      pos = skipTrivia(bytes, pos);
      if (pos < len && bytes[pos] === SEMI) pos++;
      continue;
    }

    if (section === 'DATA' && b === HASH) {
      const startOffset = pos;
      pos++;
      const result = scanInstance(bytes, pos, startOffset, decoder);
      if (result === null) {
        if (cb.onWarning) cb.onWarning('failed to parse instance', startOffset);
        // Resync to next ';' so a single malformed entity doesn't abort the file.
        while (pos < len && bytes[pos] !== SEMI) pos++;
        if (pos < len) pos++;
        continue;
      }
      cb.onEntity(result.record);
      pos = result.nextPos;
      continue;
    }

    // Unknown / outside any recognised structure: skip a byte and keep
    // hunting. This makes the lexer tolerant of random whitespace + the
    // top "ISO-10303-21;" / bottom "END-ISO-10303-21;" lines.
    pos++;
  }
}
