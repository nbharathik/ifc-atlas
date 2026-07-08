/**
 * Vitest unit tests for PromptSnippetPanel pure helpers.
 *
 * Only tests the exported pure functions - no DOM, no React rendering.
 */

import { describe, it, expect } from 'vitest';
import {
  isSnippetBodyValid,
  isSnippetTitleValid,
  validateSnippetForm,
  filterSnippets,
  normaliseTag,
  parseTags,
  extractAllTags,
  filterByTag,
  applySnippetFilters,
} from '../PromptSnippetPanel';
import type { PromptSnippet } from '../../../services/api';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSnippet(overrides: Partial<PromptSnippet> = {}): PromptSnippet {
  return {
    id: 'snip-test',
    title: 'Find All Walls',
    body: 'How many walls are in this model?',
    tags: ['walls', 'overview'],
    is_builtin: true,
    created_at: null,
    ...overrides,
  };
}

// ── isSnippetBodyValid ────────────────────────────────────────────────────────

describe('isSnippetBodyValid', () => {
  it('returns true for non-empty body', () => {
    expect(isSnippetBodyValid('How many walls?')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isSnippetBodyValid('')).toBe(false);
  });

  it('returns false for whitespace-only string', () => {
    expect(isSnippetBodyValid('   ')).toBe(false);
  });
});

// ── isSnippetTitleValid ───────────────────────────────────────────────────────

describe('isSnippetTitleValid', () => {
  it('returns true for non-empty title', () => {
    expect(isSnippetTitleValid('Walls Query')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isSnippetTitleValid('')).toBe(false);
  });

  it('returns false for whitespace-only', () => {
    expect(isSnippetTitleValid('\t\n')).toBe(false);
  });
});

// ── validateSnippetForm ───────────────────────────────────────────────────────

describe('validateSnippetForm', () => {
  it('returns null for valid inputs', () => {
    expect(validateSnippetForm('My Snippet', 'How many walls?')).toBeNull();
  });

  it('returns error when title is missing', () => {
    const result = validateSnippetForm('', 'some body');
    expect(result).not.toBeNull();
    expect(result).toContain('Title');
  });

  it('returns error when body is missing', () => {
    const result = validateSnippetForm('Title', '');
    expect(result).not.toBeNull();
    expect(result).toContain('Prompt');
  });

  it('returns title error before body error when both missing', () => {
    const result = validateSnippetForm('', '');
    expect(result).not.toBeNull();
    expect(result).toContain('Title');
  });
});

// ── filterSnippets ────────────────────────────────────────────────────────────

describe('filterSnippets', () => {
  const snippets: PromptSnippet[] = [
    makeSnippet({ id: '1', title: 'Find All Walls', body: 'List all walls by storey.', tags: ['walls'] }),
    makeSnippet({ id: '2', title: 'Material Breakdown', body: 'Show material usage.', tags: ['materials'] }),
    makeSnippet({ id: '3', title: 'Storey Totals', body: 'Total area per storey.', tags: ['storeys', 'area'] }),
  ];

  it('returns all snippets for empty query', () => {
    expect(filterSnippets(snippets, '').length).toBe(3);
    expect(filterSnippets(snippets, '  ').length).toBe(3);
  });

  it('matches by title (case-insensitive)', () => {
    const result = filterSnippets(snippets, 'WALL');
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('1');
  });

  it('matches by body text', () => {
    const result = filterSnippets(snippets, 'material usage');
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('2');
  });

  it('matches by tag', () => {
    const result = filterSnippets(snippets, 'area');
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('3');
  });

  it('returns empty array when no match', () => {
    const result = filterSnippets(snippets, 'nonexistent-xyz-query');
    expect(result.length).toBe(0);
  });
});

// ── normaliseTag ──────────────────────────────────────────────────────────────

describe('normaliseTag', () => {
  it('lowercases and trims', () => {
    expect(normaliseTag('  Walls  ')).toBe('walls');
  });

  it('replaces spaces with hyphens', () => {
    expect(normaliseTag('model analysis')).toBe('model-analysis');
  });

  it('truncates to 20 chars', () => {
    expect(normaliseTag('a'.repeat(30)).length).toBe(20);
  });
});

// ── parseTags ─────────────────────────────────────────────────────────────────

describe('parseTags', () => {
  it('splits on commas', () => {
    expect(parseTags('walls, doors, windows')).toEqual(['walls', 'doors', 'windows']);
  });

  it('removes empty entries', () => {
    expect(parseTags('walls,,  ,doors')).toEqual(['walls', 'doors']);
  });

  it('returns empty array for empty string', () => {
    expect(parseTags('')).toEqual([]);
  });

  it('normalises each tag', () => {
    expect(parseTags('  My Tag , ANOTHER ')).toEqual(['my-tag', 'another']);
  });
});

// ── extractAllTags ────────────────────────────────────────────────────────────

describe('extractAllTags', () => {
  it('returns empty array for empty snippet list', () => {
    expect(extractAllTags([])).toEqual([]);
  });

  it('returns empty array when snippets carry no tags', () => {
    const snippets = [
      makeSnippet({ id: '1', tags: [] }),
      makeSnippet({ id: '2', tags: [] }),
    ];
    expect(extractAllTags(snippets)).toEqual([]);
  });

  it('deduplicates case-insensitively and sorts ascending', () => {
    const snippets = [
      makeSnippet({ id: '1', tags: ['Walls', 'overview'] }),
      makeSnippet({ id: '2', tags: ['walls', 'materials'] }),
      makeSnippet({ id: '3', tags: ['WALLS', 'analysis'] }),
    ];
    expect(extractAllTags(snippets)).toEqual(['analysis', 'materials', 'overview', 'walls']);
  });

  it('skips whitespace-only tags', () => {
    const snippets = [
      makeSnippet({ id: '1', tags: ['walls', '   ', ''] }),
    ];
    expect(extractAllTags(snippets)).toEqual(['walls']);
  });
});

// ── filterByTag ───────────────────────────────────────────────────────────────

describe('filterByTag', () => {
  const snippets: PromptSnippet[] = [
    makeSnippet({ id: '1', tags: ['walls', 'overview'] }),
    makeSnippet({ id: '2', tags: ['materials'] }),
    makeSnippet({ id: '3', tags: ['walls', 'analysis'] }),
  ];

  it('returns all snippets when activeTag is null', () => {
    expect(filterByTag(snippets, null).length).toBe(3);
  });

  it('returns all snippets when activeTag is empty string', () => {
    expect(filterByTag(snippets, '').length).toBe(3);
    expect(filterByTag(snippets, '   ').length).toBe(3);
  });

  it('matches exact tag (case-insensitive)', () => {
    const result = filterByTag(snippets, 'WALLS');
    expect(result.length).toBe(2);
    expect(result.map((s) => s.id).sort()).toEqual(['1', '3']);
  });

  it('does NOT match substring (exact only)', () => {
    // "wall" should NOT match "walls" - that's what the search box is for.
    expect(filterByTag(snippets, 'wall').length).toBe(0);
  });

  it('returns empty array when no snippet has the tag', () => {
    expect(filterByTag(snippets, 'doors').length).toBe(0);
  });
});

// ── applySnippetFilters ───────────────────────────────────────────────────────

describe('applySnippetFilters', () => {
  const snippets: PromptSnippet[] = [
    makeSnippet({ id: '1', title: 'Find All Walls', body: 'List walls by storey.', tags: ['walls'] }),
    makeSnippet({ id: '2', title: 'Wall Materials', body: 'Show material usage.', tags: ['materials', 'walls'] }),
    makeSnippet({ id: '3', title: 'Storey Totals', body: 'Total area per storey.', tags: ['storeys'] }),
  ];

  it('no filters: returns all snippets', () => {
    expect(applySnippetFilters(snippets, '', null).length).toBe(3);
  });

  it('tag-only filter narrows to tag matches', () => {
    const result = applySnippetFilters(snippets, '', 'walls');
    expect(result.length).toBe(2);
    expect(result.map((s) => s.id).sort()).toEqual(['1', '2']);
  });

  it('query-only filter matches title / body / tags substring', () => {
    const result = applySnippetFilters(snippets, 'storey', null);
    expect(result.length).toBe(2);
    expect(result.map((s) => s.id).sort()).toEqual(['1', '3']);
  });

  it('tag + query compose (tag first, then query)', () => {
    // Among "walls"-tagged snippets (#1, #2), keep those mentioning "materials".
    const result = applySnippetFilters(snippets, 'materials', 'walls');
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('2');
  });

  it('returns empty when tag matches but query does not', () => {
    const result = applySnippetFilters(snippets, 'unrelated-text', 'walls');
    expect(result.length).toBe(0);
  });
});
