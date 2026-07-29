import { describe, it, expect } from 'vitest';
import type { SystemPromptEntry } from '../../../types/ifc';
import type { PromptSnippet } from '../../../services/api';
import {
  actionLabel,
  badgeColorFor,
  blankPromptDraft,
  countSkillsByType,
  filterSkills,
  mergeSkills,
  normalizePromptCategory,
  promptToSkill,
  seedEditFromPrompt,
  shortText,
  snippetToSkill,
} from '../ChatManagerPanel';

const PROMPT_A: SystemPromptEntry = {
  id: 'analyst',
  label: 'BIM Analyst',
  description: 'Inspect models',
  content: 'You are a BIM analyst…',
  category: 'ask',
  is_custom: false,
};
const PROMPT_B: SystemPromptEntry = {
  id: 'my-custom',
  label: 'My Custom Prompt',
  description: 'Custom user prompt',
  content: 'Do the thing',
  category: 'general',
  is_custom: true,
};
const SNIPPET_A: PromptSnippet = {
  id: 'snip-1',
  title: 'List walls',
  body: 'List every wall on storey 0.',
  tags: ['Walls', 'Storey'],
  is_builtin: true,
  created_at: null,
};

describe('shortText', () => {
  it('returns the empty string for nullish input', () => {
    expect(shortText(null)).toBe('');
    expect(shortText(undefined)).toBe('');
    expect(shortText('')).toBe('');
  });

  it('returns the text unchanged when within the limit', () => {
    expect(shortText('hello', 10)).toBe('hello');
  });

  it('truncates with an ellipsis when over the limit', () => {
    const out = shortText('abcdefghijkl', 5);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(5);
  });

  it('trims whitespace before measuring', () => {
    expect(shortText('   hi   ', 10)).toBe('hi');
  });
});

describe('promptToSkill', () => {
  it('flags built-in prompts (is_custom === false)', () => {
    const s = promptToSkill(PROMPT_A);
    expect(s.type).toBe('prompt');
    expect(s.isBuiltin).toBe(true);
    expect(s.category).toBe('ask');
    expect(s.key).toBe('prompt:analyst');
  });

  it('does NOT flag custom prompts as builtin', () => {
    const s = promptToSkill(PROMPT_B);
    expect(s.isBuiltin).toBe(false);
    expect(s.category).toBe('general');
  });

  it('falls back to id when label is missing', () => {
    const noLabel: SystemPromptEntry = { ...PROMPT_A, label: '' };
    expect(promptToSkill(noLabel).name).toBe(noLabel.id);
  });
});

describe('snippetToSkill', () => {
  it('uses "snippet" as the category', () => {
    expect(snippetToSkill(SNIPPET_A).category).toBe('snippet');
  });

  it('preserves the is_builtin flag from the native record', () => {
    expect(snippetToSkill(SNIPPET_A).isBuiltin).toBe(true);
    const userSnip = { ...SNIPPET_A, is_builtin: false };
    expect(snippetToSkill(userSnip).isBuiltin).toBe(false);
  });

  it('lowercases the tags', () => {
    expect(snippetToSkill(SNIPPET_A).tags).toEqual(['walls', 'storey']);
  });
});

describe('mergeSkills', () => {
  it('returns prompts first, then snippets', () => {
    const merged = mergeSkills([PROMPT_A], [SNIPPET_A]);
    expect(merged.map((s) => s.type)).toEqual(['prompt', 'snippet']);
  });

  it('sorts each type alphabetically by name', () => {
    const promptZ: SystemPromptEntry = { ...PROMPT_A, id: 'z', label: 'ZZZ prompt' };
    const promptA: SystemPromptEntry = { ...PROMPT_A, id: 'a', label: 'AAA prompt' };
    const merged = mergeSkills([promptZ, promptA], []);
    expect(merged.map((s) => s.name)).toEqual(['AAA prompt', 'ZZZ prompt']);
  });

  it('handles empty inputs without throwing', () => {
    expect(mergeSkills([], [])).toEqual([]);
  });
});

describe('filterSkills', () => {
  const merged = mergeSkills([PROMPT_A, PROMPT_B], [SNIPPET_A]);

  it('returns everything when typeFilter=all and query is empty', () => {
    expect(filterSkills(merged, 'all', '')).toHaveLength(3);
  });

  it('filters by type', () => {
    expect(filterSkills(merged, 'snippet', '')).toHaveLength(1);
    expect(filterSkills(merged, 'prompt', '')).toHaveLength(2);
  });

  it('matches the query against name (case-insensitive)', () => {
    const out = filterSkills(merged, 'all', 'BIM');
    // "BIM Analyst"
    expect(out.length).toBe(1);
  });

  it('matches the query against tags', () => {
    expect(filterSkills(merged, 'all', 'walls')).toHaveLength(1);
  });

  it('returns empty for an unmatched query', () => {
    expect(filterSkills(merged, 'all', 'no-such-thing')).toEqual([]);
  });

  it('combines type + query filters with AND', () => {
    expect(filterSkills(merged, 'snippet', 'walls')).toHaveLength(1);
    expect(filterSkills(merged, 'prompt', 'walls')).toHaveLength(0);
  });
});

describe('countSkillsByType', () => {
  it('counts every type independently', () => {
    const merged = mergeSkills([PROMPT_A], [SNIPPET_A]);
    const counts = countSkillsByType(merged);
    expect(counts).toEqual({ prompt: 1, snippet: 1 });
  });

  it('returns zeros for an empty list', () => {
    expect(countSkillsByType([])).toEqual({ prompt: 0, snippet: 0 });
  });
});

describe('actionLabel', () => {
  const promptSkill = promptToSkill(PROMPT_A);
  const snippetSkill = snippetToSkill(SNIPPET_A);

  it('returns "Use" for prompts that are NOT currently active', () => {
    expect(actionLabel(promptSkill, null)).toBe('Use');
    expect(actionLabel(promptSkill, 'some-other-id')).toBe('Use');
  });

  it('returns "In use" for the currently-active prompt', () => {
    expect(actionLabel(promptSkill, PROMPT_A.id)).toBe('In use');
  });

  it('returns "Insert" for snippets', () => {
    expect(actionLabel(snippetSkill, null)).toBe('Insert');
  });
});

describe('badgeColorFor', () => {
  it('uses distinct colour tokens for prompt / snippet', () => {
    const a = badgeColorFor('prompt');
    const c = badgeColorFor('snippet');
    expect(new Set([a, c]).size).toBe(2);
  });
});

describe('normalizePromptCategory', () => {
  it('passes through the four editable categories', () => {
    expect(normalizePromptCategory('ask')).toBe('ask');
    expect(normalizePromptCategory('plan')).toBe('plan');
    expect(normalizePromptCategory('edit')).toBe('edit');
    expect(normalizePromptCategory('general')).toBe('general');
  });
  it('defaults missing / unknown categories to ask', () => {
    expect(normalizePromptCategory(undefined)).toBe('ask');
    expect(normalizePromptCategory('nonsense')).toBe('ask');
    expect(normalizePromptCategory('')).toBe('ask');
  });
});

describe('blankPromptDraft', () => {
  it('is empty and defaults to the ask category', () => {
    expect(blankPromptDraft()).toEqual({ label: '', description: '', content: '', category: 'ask' });
  });
  it('returns a fresh object each call (no shared mutable state)', () => {
    expect(blankPromptDraft()).not.toBe(blankPromptDraft());
  });
});

describe('seedEditFromPrompt (fork-on-edit)', () => {
  it('forks a built-in into a CREATE draft - built-ins cannot be saved in place', () => {
    // PROMPT_A.is_custom === false
    const seed = seedEditFromPrompt(PROMPT_A);
    expect(seed.mode).toBe('create');
    expect(seed).not.toHaveProperty('promptId');
    if (seed.mode === 'create') expect(seed.forkedFrom).toBe('BIM Analyst');
    expect(seed.draft.label).toBe('BIM Analyst (copy)');
    expect(seed.draft.content).toBe(PROMPT_A.content);
    expect(seed.draft.description).toBe(PROMPT_A.description);
    expect(seed.draft.category).toBe('ask');
  });

  it('edits a custom prompt IN PLACE - no fork, no "(copy)" suffix', () => {
    // PROMPT_B.is_custom === true
    const seed = seedEditFromPrompt(PROMPT_B);
    expect(seed.mode).toBe('edit');
    if (seed.mode === 'edit') expect(seed.promptId).toBe('my-custom');
    expect(seed).not.toHaveProperty('forkedFrom');
    expect(seed.draft.label).toBe('My Custom Prompt');
    expect(seed.draft.category).toBe('general');
  });
});
