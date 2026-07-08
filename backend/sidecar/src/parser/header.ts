/**
 * Parse the three standard STEP HEADER entities.
 *
 * The lexer hands us raw `TYPE(args)` strings (no `;`); we split args at
 * top level and pull out the fields we care about.
 *
 * HEADER shape (same for IFC2X3 / IFC4 / IFC4X3):
 *
 *   FILE_DESCRIPTION(description: STRING[], implementation_level: STRING);
 *   FILE_NAME(name, time_stamp, author[], organization[],
 *             preprocessor_version, originating_system, authorization);
 *   FILE_SCHEMA(schema_identifiers: STRING[]);
 */

import { parseArgs, asString } from './args.js';
import type { HeaderRecord } from './types.js';

function emptyHeader(): HeaderRecord {
  return {
    schema: null,
    description: [],
    implementationLevel: null,
    fileName: {
      name: null,
      timeStamp: null,
      author: [],
      organization: [],
      preprocessorVersion: null,
      originatingSystem: null,
      authorization: null,
    },
    extras: [],
  };
}

/**
 * Pull the entity type out of a raw `TYPE(args)` string and return the
 * substring between the outer `(` and `)`.
 */
function splitTypeAndArgs(raw: string): { type: string; argsRaw: string } | null {
  const lparen = raw.indexOf('(');
  if (lparen < 0) return null;
  const type = raw.slice(0, lparen).trim().toUpperCase();
  // The lexer guarantees balanced parens, so the last char of `raw` is `)`.
  const argsRaw = raw.slice(lparen + 1, raw.length - 1);
  return { type, argsRaw };
}

/**
 * Build a HeaderRecord from the raw header strings the lexer collected.
 * Tolerates missing entities and out-of-order entries.
 */
export function buildHeader(rawHeaderStrings: readonly string[]): HeaderRecord {
  const header = emptyHeader();

  for (const raw of rawHeaderStrings) {
    const split = splitTypeAndArgs(raw);
    if (split === null) {
      header.extras.push(raw);
      continue;
    }
    const args = parseArgs(split.argsRaw);

    if (split.type === 'FILE_DESCRIPTION') {
      // arg 0 = description list, arg 1 = implementation_level
      const desc = args[0];
      if (desc && desc.kind === 'list') {
        header.description = desc.value
          .map((v) => (v.kind === 'string' ? v.value : null))
          .filter((s): s is string => s !== null);
      }
      header.implementationLevel = asString(args[1]);
      continue;
    }

    if (split.type === 'FILE_NAME') {
      header.fileName.name = asString(args[0]);
      header.fileName.timeStamp = asString(args[1]);
      const authors = args[2];
      if (authors && authors.kind === 'list') {
        header.fileName.author = authors.value
          .map((v) => (v.kind === 'string' ? v.value : null))
          .filter((s): s is string => s !== null);
      }
      const orgs = args[3];
      if (orgs && orgs.kind === 'list') {
        header.fileName.organization = orgs.value
          .map((v) => (v.kind === 'string' ? v.value : null))
          .filter((s): s is string => s !== null);
      }
      header.fileName.preprocessorVersion = asString(args[4]);
      header.fileName.originatingSystem = asString(args[5]);
      header.fileName.authorization = asString(args[6]);
      continue;
    }

    if (split.type === 'FILE_SCHEMA') {
      // arg 0 = list of schema identifiers, usually 1 element.
      const list = args[0];
      if (list && list.kind === 'list') {
        for (const v of list.value) {
          if (v.kind === 'string') {
            header.schema = v.value;
            break;
          }
        }
      }
      continue;
    }

    // Unknown header entity: keep the raw text for diagnostics.
    header.extras.push(raw);
  }

  return header;
}
