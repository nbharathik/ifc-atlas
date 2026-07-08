/**
 * Dependency-free Python tokenizer for the CodeEditor highlight overlay.
 *
 * Single-pass, regex-driven and deliberately context-free: good enough for
 * plugin-sized scripts, guaranteed linear-time (no nested quantifiers over
 * overlapping character classes) and guaranteed never to throw - a highlight
 * layer must survive arbitrarily malformed input while the user types.
 *
 * Invariant relied on by tests and by the overlay technique itself:
 * concatenating every token's text reproduces the input exactly.
 */

export type TokenKind =
  | 'keyword'
  | 'builtin'
  | 'string'
  | 'comment'
  | 'number'
  | 'plain';

export interface Token {
  text: string;
  kind: TokenKind;
}

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

// Common Python builtins plus the three names every plugin script revolves
// around: `model` and `params` are the sandbox-provided globals, `result` is
// the variable the sandbox reports back as result_repr.
const BUILTINS = new Set([
  'abs', 'all', 'any', 'bool', 'dict', 'dir', 'divmod', 'enumerate', 'filter',
  'float', 'format', 'frozenset', 'getattr', 'hasattr', 'hash', 'hex', 'id',
  'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'map', 'max',
  'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print', 'range',
  'repr', 'reversed', 'round', 'set', 'setattr', 'sorted', 'str', 'sum',
  'tuple', 'type', 'vars', 'zip',
  'model', 'params', 'result',
]);

// Alternation order is load-bearing: triple-quoted strings must be tried
// before single-line strings (both start with the same quote character), and
// strings before comments so a '#' inside a string never starts a comment.
// Every string variant tolerates a missing closer (`$` / optional quote) so
// half-typed code still tokenizes line by line instead of failing.
// Capture groups: 1 string, 2 comment, 3 number, 4 identifier, 5 plain.
const PY_TOKEN_RE =
  /("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(#[^\n]*)|(0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?[jJ]?)|([A-Za-z_][A-Za-z0-9_]*)|(\s+|[\s\S])/g;

function classifyIdentifier(word: string): TokenKind {
  if (KEYWORDS.has(word)) return 'keyword';
  if (BUILTINS.has(word)) return 'builtin';
  return 'plain';
}

/**
 * Tokenize Python source for syntax highlighting. Never throws; on any
 * unexpected failure the whole input is returned as one plain token so the
 * editor overlay still renders the text.
 */
export function tokenizePython(code: string): Token[] {
  const src = typeof code === 'string' ? code : String(code ?? '');
  if (src.length === 0) return [];

  try {
    const tokens: Token[] = [];
    PY_TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    // True while the previous token was filler (whitespace/punctuation from
    // group 5). Only filler runs merge - identifiers stay separate tokens so
    // callers can reason about word boundaries.
    let prevWasFiller = false;

    while ((match = PY_TOKEN_RE.exec(src)) !== null) {
      // Defensive: a zero-length match would loop forever. The alternation
      // cannot produce one, but a stuck regex must fail safe, not hang.
      if (match[0].length === 0) {
        PY_TOKEN_RE.lastIndex += 1;
        continue;
      }

      let kind: TokenKind;
      const isFiller = match[5] !== undefined;
      if (match[1] !== undefined) kind = 'string';
      else if (match[2] !== undefined) kind = 'comment';
      else if (match[3] !== undefined) kind = 'number';
      else if (match[4] !== undefined) kind = classifyIdentifier(match[4]);
      else kind = 'plain';

      if (isFiller && prevWasFiller) {
        tokens[tokens.length - 1].text += match[0];
      } else {
        tokens.push({ text: match[0], kind });
      }
      prevWasFiller = isFiller;
    }

    return tokens;
  } catch {
    return [{ text: src, kind: 'plain' }];
  }
}
