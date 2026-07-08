import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { tokenizePython, type Token } from './pythonHighlight';
import './codeEditor.css';

/**
 * Dependency-free code editor.
 *
 * Architecture: a transparent-text <textarea> (the real input, visible caret)
 * is overlaid pixel-perfectly on a <pre> that renders the highlighted tokens,
 * with a line-number gutter alongside. The three layers share identical font
 * metrics (see codeEditor.css) and their scroll positions are kept in sync,
 * so the caret always sits exactly on the colored text underneath.
 */

const INDENT = '    ';

/** Must equal the line-height set on .code-editor in codeEditor.css. */
const LINE_HEIGHT_PX = 20;
/** Must equal top + bottom padding on .code-editor-input in codeEditor.css. */
const VERTICAL_PADDING_PX = 16;

const TOKENIZERS: Record<'python', (code: string) => Token[]> = {
  python: tokenizePython,
};

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: 'python';
  readOnly?: boolean;
  /** Minimum visible height, in text lines. */
  minLines?: number;
  placeholder?: string;
  /** Fired on Ctrl+Enter / Cmd+Enter. */
  onSubmit?: () => void;
  /** Accessible name for the underlying textarea. */
  ariaLabel?: string;
}

/** Index of the first character of the line containing `position`. */
function lineStartAt(value: string, position: number): number {
  return position === 0 ? 0 : value.lastIndexOf('\n', position - 1) + 1;
}

export default function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  minLines,
  placeholder,
  onSubmit,
  ariaLabel,
}: CodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const gutterInnerRef = useRef<HTMLDivElement>(null);
  // Set by Escape: lets the next Tab move focus instead of indenting, so
  // keyboard users are not trapped inside the editor.
  const releaseNextTabRef = useRef(false);

  const tokens = useMemo(() => TOKENIZERS[language](value), [language, value]);

  const lineCount = useMemo(() => {
    let count = 1;
    for (let i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) === 10) count++;
    }
    return count;
  }, [value]);

  const gutterLines = Math.max(lineCount, minLines ?? 1);
  const gutterText = useMemo(() => {
    const numbers: string[] = [];
    for (let i = 1; i <= gutterLines; i++) numbers.push(String(i));
    return numbers.join('\n');
  }, [gutterLines]);

  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = ta.scrollTop;
      highlightRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterInnerRef.current) {
      gutterInnerRef.current.style.transform = `translateY(${-ta.scrollTop}px)`;
    }
  }, []);

  // Re-align the overlay whenever the value changes height (paste, indent,
  // programmatic reset) - the scroll event alone does not cover those.
  useLayoutEffect(() => {
    syncScroll();
  }, [value, syncScroll]);

  /**
   * Replace [start, end) with `insert`, then place the selection.
   * Tries execCommand('insertText') first so the browser's native undo stack
   * keeps working; falls back to setRangeText (which bypasses undo) when the
   * command is unavailable or the insert is empty (where execCommand is
   * unreliable across browsers).
   */
  const applyEdit = useCallback(
    (
      ta: HTMLTextAreaElement,
      start: number,
      end: number,
      insert: string,
      selStart: number,
      selEnd: number,
    ) => {
      ta.focus();
      ta.setSelectionRange(start, end);
      let inserted = false;
      if (insert.length > 0) {
        try {
          inserted = document.execCommand('insertText', false, insert);
        } catch {
          inserted = false;
        }
      }
      if (!inserted) {
        ta.setRangeText(insert, start, end, 'end');
      }
      ta.setSelectionRange(selStart, selEnd);
      onChange(ta.value);
    },
    [onChange],
  );

  const indentSelection = useCallback(
    (ta: HTMLTextAreaElement) => {
      const { selectionStart: start, selectionEnd: end, value: v } = ta;
      if (!v.slice(start, end).includes('\n')) {
        // Single caret / single-line selection: insert one indent unit.
        applyEdit(ta, start, end, INDENT, start + INDENT.length, start + INDENT.length);
        return;
      }
      // Multi-line selection: indent every touched line.
      const blockStart = lineStartAt(v, start);
      const block = v.slice(blockStart, end);
      const indented = block
        .split('\n')
        .map((line) => INDENT + line)
        .join('\n');
      applyEdit(
        ta,
        blockStart,
        end,
        indented,
        start + INDENT.length,
        blockStart + indented.length,
      );
    },
    [applyEdit],
  );

  const dedentSelection = useCallback(
    (ta: HTMLTextAreaElement) => {
      const { selectionStart: start, selectionEnd: end, value: v } = ta;
      const blockStart = lineStartAt(v, start);
      // Extend to the end of the last touched line so a caret sitting at
      // column 0 still dedents its line.
      const lastLineEnd = v.indexOf('\n', end);
      const blockEnd = lastLineEnd === -1 ? v.length : lastLineEnd;
      const lines = v.slice(blockStart, blockEnd).split('\n');

      let removedFirst = 0;
      let removedTotal = 0;
      const dedented = lines
        .map((line, i) => {
          const lead = /^(?: {1,4}|\t)/.exec(line);
          const cut = lead ? lead[0].length : 0;
          if (i === 0) removedFirst = cut;
          removedTotal += cut;
          return line.slice(cut);
        })
        .join('\n');
      if (removedTotal === 0) return;

      const newStart = Math.max(blockStart, start - removedFirst);
      const newEnd = Math.max(newStart, end - removedTotal);
      applyEdit(ta, blockStart, blockEnd, dedented, newStart, newEnd);
    },
    [applyEdit],
  );

  const insertNewlineWithIndent = useCallback(
    (ta: HTMLTextAreaElement) => {
      const { selectionStart: start, selectionEnd: end, value: v } = ta;
      const line = v.slice(lineStartAt(v, start), start);
      const lead = /^[ \t]*/.exec(line);
      let indent = lead ? lead[0] : '';
      // Opening a block (def/if/for/... ending in ':') gets one extra level.
      if (/:\s*$/.test(line)) indent += INDENT;
      const insert = '\n' + indent;
      applyEdit(ta, start, end, insert, start + insert.length, start + insert.length);
    },
    [applyEdit],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget;

      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (onSubmit) {
          e.preventDefault();
          onSubmit();
        }
        return;
      }
      if (readOnly) return;

      if (e.key === 'Escape') {
        releaseNextTabRef.current = true;
        return;
      }
      if (e.key === 'Tab') {
        if (releaseNextTabRef.current) {
          releaseNextTabRef.current = false;
          return; // let the browser move focus
        }
        e.preventDefault();
        if (e.shiftKey) dedentSelection(ta);
        else indentSelection(ta);
        return;
      }
      releaseNextTabRef.current = false;

      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        insertNewlineWithIndent(ta);
      }
    },
    [onSubmit, readOnly, dedentSelection, indentSelection, insertNewlineWithIndent],
  );

  return (
    <div
      className={`code-editor${readOnly ? ' code-editor--readonly' : ''}`}
      style={
        minLines !== undefined
          ? { minHeight: minLines * LINE_HEIGHT_PX + VERTICAL_PADDING_PX + 2 }
          : undefined
      }
    >
      <div className="code-editor-gutter" aria-hidden="true">
        <div className="code-editor-gutter-inner" ref={gutterInnerRef}>
          {gutterText}
        </div>
      </div>
      <div className="code-editor-area">
        <pre className="code-editor-highlight" ref={highlightRef} aria-hidden="true">
          <code className="code-editor-code">
            {tokens.map((token, i) =>
              token.kind === 'plain' ? (
                token.text
              ) : (
                <span key={i} className={`code-editor-tok--${token.kind}`}>
                  {token.text}
                </span>
              ),
            )}
            {/* Trailing newline keeps the pre's height equal to the textarea's
                when the value ends with \n (a bare trailing line break does
                not produce a line box on its own). */}
            {'\n'}
          </code>
        </pre>
        <textarea
          ref={textareaRef}
          className="code-editor-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={handleKeyDown}
          readOnly={readOnly}
          placeholder={placeholder}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          wrap="off"
          aria-label={ariaLabel ?? 'Code editor'}
        />
      </div>
    </div>
  );
}
