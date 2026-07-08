/**
 * Minimal argument-list parser for the V1 native IFC parser.
 *
 * STEP entity args look like:
 *
 *   '0xQVwz...',#5,'Wall-001',$,$,#34,#56,$
 *
 * V1 needs only enough of this to:
 *  - Read the GlobalId (first arg of IfcRoot subclasses).
 *  - Read Name + Description (3rd + 4th of IfcRoot).
 *  - Resolve relationship refs (e.g. #34, lists like (#5,#7,#9)).
 *  - Recognise null `$` and omitted `*`.
 *
 * Everything else (numbers, enums, typed wrappers like `IFCLABEL('foo')`)
 * is preserved as a raw `unknown` value so callers can dig in later if
 * they need to. V2 will replace this with a fully-typed parser.
 */

export type ArgValue =
  | { kind: 'null' }
  | { kind: 'omitted' }
  | { kind: 'string'; value: string }
  | { kind: 'integer'; value: number }
  | { kind: 'real'; value: number }
  | { kind: 'enum'; value: string }
  | { kind: 'ref'; value: number }
  | { kind: 'list'; value: ArgValue[] }
  | { kind: 'typed'; type: string; value: ArgValue }
  | { kind: 'unknown'; raw: string };

const HASH = '#'.charCodeAt(0);
const LPAREN = '('.charCodeAt(0);
const RPAREN = ')'.charCodeAt(0);
const COMMA = ','.charCodeAt(0);
const SQUOTE = "'".charCodeAt(0);
const DOLLAR = '$'.charCodeAt(0);
const ASTERISK = '*'.charCodeAt(0);
const DOT = '.'.charCodeAt(0);
const SP = ' '.charCodeAt(0);
const TAB = '\t'.charCodeAt(0);
const NL = '\n'.charCodeAt(0);
const CR = '\r'.charCodeAt(0);
const ZERO = '0'.charCodeAt(0);
const NINE = '9'.charCodeAt(0);
const A_UP = 'A'.charCodeAt(0);
const Z_UP = 'Z'.charCodeAt(0);
const A_LO = 'a'.charCodeAt(0);
const Z_LO = 'z'.charCodeAt(0);
const UNDERSCORE = '_'.charCodeAt(0);
const PLUS = '+'.charCodeAt(0);
const MINUS = '-'.charCodeAt(0);

function isWs(c: number): boolean {
  return c === SP || c === TAB || c === NL || c === CR;
}

function isDigit(c: number): boolean {
  return c >= ZERO && c <= NINE;
}

function isIdentStart(c: number): boolean {
  return (c >= A_UP && c <= Z_UP) || (c >= A_LO && c <= Z_LO) || c === UNDERSCORE;
}

function isIdentCont(c: number): boolean {
  return isIdentStart(c) || isDigit(c);
}

/**
 * Split a raw arg list (the text between the outer `(` and `)`) into top-
 * level argument strings. Ignores commas inside nested `()` and `'…'`.
 *
 * Caller can hand the strings back to `parseValue` for typed parsing.
 */
export function splitTopLevelArgs(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (inStr) {
      if (c === SQUOTE) {
        // Doubled-quote escape inside string.
        if (i + 1 < raw.length && raw.charCodeAt(i + 1) === SQUOTE) {
          i++;
          continue;
        }
        inStr = false;
      }
      continue;
    }
    if (c === SQUOTE) {
      inStr = true;
      continue;
    }
    if (c === LPAREN) {
      depth++;
      continue;
    }
    if (c === RPAREN) {
      depth--;
      continue;
    }
    if (c === COMMA && depth === 0) {
      out.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  // Don't push an empty-tail arg for `(...,...,)`; that'd produce a phantom
  // `omitted` entry. STEP doesn't use trailing commas, so the last slice is
  // either content or a deliberate empty position which we treat as omitted.
  if (start < raw.length || raw.length === 0) {
    out.push(raw.slice(start));
  }
  return out;
}

/**
 * Parse a single argument token (the output of `splitTopLevelArgs`).
 * Whitespace-tolerant.
 */
export function parseValue(raw: string): ArgValue {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'omitted' };

  const first = trimmed.charCodeAt(0);

  if (first === DOLLAR) return { kind: 'null' };
  if (first === ASTERISK) return { kind: 'omitted' };

  if (first === SQUOTE) {
    // Strip surrounding quotes; un-double `''` escapes.
    return { kind: 'string', value: unescapeStepString(trimmed) };
  }

  if (first === HASH) {
    const id = parseInt(trimmed.slice(1), 10);
    if (Number.isFinite(id)) return { kind: 'ref', value: id };
    return { kind: 'unknown', raw: trimmed };
  }

  if (first === DOT) {
    // `.UNDEFINED.`, `.T.`, `.F.`, etc.
    const lastDot = trimmed.lastIndexOf('.');
    if (lastDot > 0) return { kind: 'enum', value: trimmed.slice(1, lastDot) };
    return { kind: 'unknown', raw: trimmed };
  }

  if (first === LPAREN) {
    // List of values.
    const inner = trimmed.slice(1, -1); // drop ( and )
    const items = splitTopLevelArgs(inner).map(parseValue);
    return { kind: 'list', value: items };
  }

  if (first === PLUS || first === MINUS || isDigit(first)) {
    // Numeric literal: handles `1`, `-2`, `1.5`, `1.5E+2`, `1.5e-2`. The
    // STEP `D` exponent (`1.5D+2`) is rare in IFC and is left as `unknown`
    // for V1; V2 normalises it.
    if (/^[+-]?\d+$/.test(trimmed)) {
      return { kind: 'integer', value: parseInt(trimmed, 10) };
    }
    if (/^[+-]?\d+(\.\d*)?([eE][+-]?\d+)?$/.test(trimmed) || /^[+-]?\.\d+([eE][+-]?\d+)?$/.test(trimmed)) {
      return { kind: 'real', value: parseFloat(trimmed) };
    }
    return { kind: 'unknown', raw: trimmed };
  }

  if (isIdentStart(first)) {
    // Could be a typed wrapper: `IFCLABEL('foo')`, `IFCREAL(1.5)`.
    let i = 1;
    while (i < trimmed.length && isIdentCont(trimmed.charCodeAt(i))) i++;
    const ident = trimmed.slice(0, i).toUpperCase();
    let j = i;
    while (j < trimmed.length && isWs(trimmed.charCodeAt(j))) j++;
    if (j < trimmed.length && trimmed.charCodeAt(j) === LPAREN) {
      // Find matching ')'.
      let depth = 1;
      let inStr = false;
      let k = j + 1;
      while (k < trimmed.length && depth > 0) {
        const c = trimmed.charCodeAt(k);
        if (inStr) {
          if (c === SQUOTE) {
            if (k + 1 < trimmed.length && trimmed.charCodeAt(k + 1) === SQUOTE) {
              k += 2;
              continue;
            }
            inStr = false;
          }
        } else if (c === SQUOTE) inStr = true;
        else if (c === LPAREN) depth++;
        else if (c === RPAREN) depth--;
        k++;
      }
      const inner = trimmed.slice(j + 1, k - 1);
      // For typed wrappers, the inner is usually a single value.
      const innerArgs = splitTopLevelArgs(inner);
      const innerValue: ArgValue =
        innerArgs.length === 1 ? parseValue(innerArgs[0]!) : { kind: 'list', value: innerArgs.map(parseValue) };
      return { kind: 'typed', type: ident, value: innerValue };
    }
    return { kind: 'unknown', raw: trimmed };
  }

  return { kind: 'unknown', raw: trimmed };
}

/**
 * Strip the surrounding `'` and un-double `''` escapes. STEP `\X2\…\X0\`
 * Unicode escapes are NOT decoded in V1; they pass through verbatim.
 * V2 will normalise them.
 */
function unescapeStepString(quoted: string): string {
  // Drop leading and trailing `'`.
  let body = quoted;
  if (body.length >= 2 && body.charCodeAt(0) === SQUOTE) body = body.slice(1);
  if (body.length >= 1 && body.charCodeAt(body.length - 1) === SQUOTE) body = body.slice(0, -1);
  // Un-double quotes.
  return body.replace(/''/g, "'");
}

/**
 * Convenience: parse the full `argsRaw` of an entity into a typed array.
 */
export function parseArgs(rawArgs: string): ArgValue[] {
  return splitTopLevelArgs(rawArgs).map(parseValue);
}

/* ─────────────────────────── helpers for callers ─────────────────────────── */

export function asString(v: ArgValue | undefined): string | null {
  if (!v) return null;
  if (v.kind === 'string') return v.value;
  return null;
}

export function asRef(v: ArgValue | undefined): number | null {
  if (!v) return null;
  if (v.kind === 'ref') return v.value;
  return null;
}

export function asRefList(v: ArgValue | undefined): number[] {
  if (!v || v.kind !== 'list') return [];
  const out: number[] = [];
  for (const item of v.value) {
    if (item.kind === 'ref') out.push(item.value);
  }
  return out;
}

export function asEnum(v: ArgValue | undefined): string | null {
  if (!v) return null;
  if (v.kind === 'enum') return v.value;
  return null;
}
