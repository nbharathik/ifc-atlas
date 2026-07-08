/**
 * Chat transcript export utilities.
 * Pure functions - no DOM side effects except the triggered download.
 */

import type { ChatMessage } from '../../types/ifc';
import { exportFilename } from '../exportFilename';

export type ExportFormat = 'markdown' | 'json';

// ── Formatters ─────────────────────────────────────────────────────────────────

/** Convert a list of ChatMessage objects to a Markdown string. */
export function messagesToMarkdown(messages: ChatMessage[], modelName?: string): string {
  const header = [
    '# IFC Atlas - Chat Transcript',
    `**Exported:** ${new Date().toISOString()}`,
    modelName ? `**Model:** ${modelName}` : null,
    '',
    '---',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');

  const body = messages
    .map((msg) => {
      const roleLabel = msg.role === 'user' ? '**You**' : '**Assistant**';
      const lines: string[] = [`${roleLabel}\n`];

      if (msg.content) lines.push(msg.content);

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          lines.push(`\n> **Tool call:** \`${tc.name}\``);
          if (tc.result) lines.push(`> **Result:** ${tc.result.slice(0, 200)}${tc.result.length > 200 ? '…' : ''}`);
        }
      }

      if (msg.attachments && msg.attachments.length > 0) {
        const names = msg.attachments.map((a) => `\`${a.name ?? 'attachment'}\``).join(', ');
        lines.push(`\n> **Attachments:** ${names}`);
      }

      return lines.join('\n');
    })
    .join('\n\n---\n\n');

  return header + body;
}

/** Convert a list of ChatMessage objects to a pretty-printed JSON string. */
export function messagesToJson(messages: ChatMessage[], modelName?: string): string {
  return JSON.stringify(
    {
      exported: new Date().toISOString(),
      model: modelName ?? null,
      messages,
    },
    null,
    2,
  );
}

// ── Filename builder ───────────────────────────────────────────────────────────

/** Generate a timestamped filename for the export. Delegates to the shared
 *  `exportFilename` helper so the timestamp shape stays in one place. */
export function buildExportFilename(format: ExportFormat): string {
  const ext = format === 'markdown' ? 'md' : 'json';
  return exportFilename('ifc-chat', ext);
}

// ── Download trigger ───────────────────────────────────────────────────────────

/** Trigger a browser file download with the given text content. */
export function downloadText(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── High-level entry point ─────────────────────────────────────────────────────

/**
 * Export the given messages in the specified format and trigger a download.
 * Safe to call with an empty array - produces a valid but sparse file.
 */
export function exportChatHistory(
  messages: ChatMessage[],
  format: ExportFormat,
  modelName?: string,
): void {
  if (format === 'markdown') {
    const content = messagesToMarkdown(messages, modelName);
    const filename = buildExportFilename('markdown');
    downloadText(content, filename, 'text/markdown;charset=utf-8');
  } else {
    const content = messagesToJson(messages, modelName);
    const filename = buildExportFilename('json');
    downloadText(content, filename, 'application/json;charset=utf-8');
  }
}
