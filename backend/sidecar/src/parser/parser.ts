/**
 * Native IFC parser entry point.
 *
 * The public surface is small: `parseIfc(bytes)` runs the lexer, builds
 * the metadata index, and returns the JSON shape that the Python Ask-mode
 * tool router consumes.
 */

import { createHash } from 'node:crypto';

import { scanSections } from './lexer.js';
import { buildIndex } from './extract.js';
import type { EntityRecord, ParseStats } from './types.js';
import type { MetadataIndex } from './index_types.js';

export interface ParseOptions {
  /** Hard cap on warnings recorded; lexer keeps counting beyond this. */
  maxWarnings?: number;
  /** Optional version string to record on the index (sidecar /health.version). */
  producerVersion?: string;
  /** Pre-computed SHA-256 hex; skipped if not provided. */
  sha256?: string;
}

/**
 * Parse a raw IFC byte buffer into a queryable metadata index.
 *
 * Pure function: no I/O, no globals. Safe to run on a worker.
 */
export function parseIfc(bytes: Uint8Array, options: ParseOptions = {}): MetadataIndex {
  const lexStart = Date.now();
  const entities = new Map<number, EntityRecord>();
  const rawHeaders: string[] = [];
  const warnings: string[] = [];
  const maxWarnings = options.maxWarnings ?? 32;

  scanSections(bytes, {
    onEntity: (record) => {
      entities.set(record.expressId, record);
    },
    onHeaderRaw: (raw) => {
      rawHeaders.push(raw);
    },
    onWarning: (message, offset) => {
      if (warnings.length < maxWarnings) {
        warnings.push(`${message} @ ${offset}`);
      }
    },
  });

  const lexMs = Date.now() - lexStart;

  const sha = options.sha256 ?? sha256Hex(bytes);
  const producer = options.producerVersion ?? 'unknown';

  return buildIndex(entities, rawHeaders, sha, bytes.byteLength, producer, lexMs, warnings);
}

/**
 * Lightweight stats-only parse (no metadata index). Useful for the early
 * `/parse?statsOnly=1` path, where the caller just wants entity counts +
 * type histogram for a quick "how big is this file?" pre-flight.
 */
export function parseIfcStatsOnly(bytes: Uint8Array): ParseStats {
  const start = Date.now();
  const byType: Record<string, number> = Object.create(null);
  let entityCount = 0;
  const warnings: string[] = [];

  scanSections(bytes, {
    onEntity: (record) => {
      entityCount++;
      byType[record.type] = (byType[record.type] ?? 0) + 1;
    },
    onHeaderRaw: () => {
      // ignore in stats-only mode
    },
    onWarning: (message, offset) => {
      if (warnings.length < 32) warnings.push(`${message} @ ${offset}`);
    },
  });

  return {
    inputBytes: bytes.byteLength,
    entityCount,
    byType,
    parseMs: Date.now() - start,
    warningCount: warnings.length,
    warnings,
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
