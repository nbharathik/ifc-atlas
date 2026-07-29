import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../../../types/ifc';
import {
  messagesToMarkdown,
  messagesToJson,
  buildExportFilename,
} from '../ChatPanel';

const msgs: ChatMessage[] = [
  { role: 'user', content: 'How many walls are there?' },
  { role: 'assistant', content: 'There are 12 walls in the model.' },
];

describe('messagesToMarkdown', () => {
  it('includes the export header', () => {
    const md = messagesToMarkdown(msgs);
    expect(md).toContain('# IFC Atlas - Chat Transcript');
  });

  it('includes the model name when provided', () => {
    const md = messagesToMarkdown(msgs, 'claude-sonnet-4-6');
    expect(md).toContain('claude-sonnet-4-6');
  });

  it('omits the model line when not provided', () => {
    const md = messagesToMarkdown(msgs);
    expect(md).not.toContain('**Model:**');
  });

  it('labels user messages with **You**', () => {
    const md = messagesToMarkdown(msgs);
    expect(md).toContain('**You**');
  });

  it('labels assistant messages with **Assistant**', () => {
    const md = messagesToMarkdown(msgs);
    expect(md).toContain('**Assistant**');
  });

  it('includes message content', () => {
    const md = messagesToMarkdown(msgs);
    expect(md).toContain('How many walls are there?');
    expect(md).toContain('There are 12 walls in the model.');
  });

  it('includes tool call info when present', () => {
    const withTool: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'Let me check.',
        toolCalls: [{ name: 'describe_model', result: '{"walls": 12}' }] as ChatMessage['toolCalls'],
      },
    ];
    const md = messagesToMarkdown(withTool);
    expect(md).toContain('describe_model');
  });

  it('truncates long tool results to 200 chars', () => {
    const longResult = 'x'.repeat(300);
    const withTool: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'Done.',
        toolCalls: [{ name: 'search', result: longResult }] as ChatMessage['toolCalls'],
      },
    ];
    const md = messagesToMarkdown(withTool);
    expect(md).toContain('…');
    // Should not contain the full 300-char string
    expect(md.includes(longResult)).toBe(false);
  });

  it('includes attachment names when present', () => {
    const withAttachment: ChatMessage[] = [
      {
        role: 'user',
        content: 'Check this.',
        attachments: [{ name: 'report.pdf', kind: 'other' as const, mime: 'application/pdf', data_base64: '', size: 0 }],
      },
    ];
    const md = messagesToMarkdown(withAttachment);
    expect(md).toContain('report.pdf');
  });

  it('handles empty messages array gracefully', () => {
    const md = messagesToMarkdown([]);
    expect(md).toContain('# IFC Atlas');
    expect(md).not.toContain('**You**');
  });
});

describe('messagesToJson', () => {
  it('produces valid JSON', () => {
    const json = messagesToJson(msgs);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('includes exported timestamp field', () => {
    const parsed = JSON.parse(messagesToJson(msgs));
    expect(parsed).toHaveProperty('exported');
    expect(typeof parsed.exported).toBe('string');
  });

  it('includes model field when provided', () => {
    const parsed = JSON.parse(messagesToJson(msgs, 'claude-opus-4-7'));
    expect(parsed.model).toBe('claude-opus-4-7');
  });

  it('sets model to null when not provided', () => {
    const parsed = JSON.parse(messagesToJson(msgs));
    expect(parsed.model).toBeNull();
  });

  it('includes all messages', () => {
    const parsed = JSON.parse(messagesToJson(msgs));
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0].content).toBe('How many walls are there?');
  });

  it('handles empty messages array', () => {
    const parsed = JSON.parse(messagesToJson([]));
    expect(parsed.messages).toHaveLength(0);
  });
});

describe('buildExportFilename', () => {
  it('produces a .md filename for markdown format', () => {
    const name = buildExportFilename('markdown');
    expect(name).toMatch(/\.md$/);
  });

  it('produces a .json filename for json format', () => {
    const name = buildExportFilename('json');
    expect(name).toMatch(/\.json$/);
  });

  it('starts with ifc-chat-', () => {
    const name = buildExportFilename('markdown');
    expect(name).toMatch(/^ifc-chat-/);
  });

  it('contains a timestamp in the filename', () => {
    const name = buildExportFilename('json');
    // Format: ifc-chat-YYYY-MM-DDTHH-MM-SS.json
    expect(name).toMatch(/ifc-chat-\d{4}-\d{2}-\d{2}/);
  });
});
