/**
 * Unit tests for the V1 native IFC parser.
 *
 * Run with `npx tsx --test test/parser.test.ts` from `backend/sidecar/`.
 *
 * Covers:
 *  - lexer edge cases (escaped strings, comments, multi-line, $/*)
 *  - arg parser (refs, lists, typed wrappers, enums)
 *  - header parser (FILE_SCHEMA, FILE_NAME)
 *  - end-to-end build on a hand-crafted micro-IFC
 *  - element-type filter (rejects IfcRel/IfcProperty/*Type/*Style)
 *  - statsOnly mode
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import {
  parseIfc,
  parseIfcStatsOnly,
  parseArgs,
  splitTopLevelArgs,
  parseValue,
  asString,
  asRef,
  asRefList,
  scanSections,
  buildHeader,
} from '../src/parser/index.js';

function ifc(body: string): Uint8Array {
  return Buffer.from(body, 'utf-8');
}

const MIN_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('Test.ifc','2026-05-09T00:00:00',('me'),('Org'),'preprocessor','origsys','auth');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('1aaaaaaaaaaaaaaaaaaaaa',$,'My Project',$,$,'Long','Phase',(),$);
#2=IFCSITE('2aaaaaaaaaaaaaaaaaaaaa',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$);
#3=IFCBUILDING('3aaaaaaaaaaaaaaaaaaaaa',$,'Bldg',$,$,$,$,$,.ELEMENT.,$,$,$);
#4=IFCBUILDINGSTOREY('4aaaaaaaaaaaaaaaaaaaaa',$,'L1',$,$,$,$,$,.ELEMENT.,0.);
#5=IFCWALL('5aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$);
#6=IFCDOOR('6aaaaaaaaaaaaaaaaaaaaa',$,'Door A',$,$,$,$,$,2.1,0.9);
#7=IFCRELAGGREGATES('7aaaaaaaaaaaaaaaaaaaaa',$,$,$,#1,(#2));
#8=IFCRELAGGREGATES('8aaaaaaaaaaaaaaaaaaaaa',$,$,$,#2,(#3));
#9=IFCRELAGGREGATES('9aaaaaaaaaaaaaaaaaaaaa',$,$,$,#3,(#4));
#10=IFCRELCONTAINEDINSPATIALSTRUCTURE('Aaaaaaaaaaaaaaaaaaaaaa',$,$,$,(#5,#6),#4);
ENDSEC;
END-ISO-10303-21;
`;

describe('lexer', () => {
  it('emits each #N=TYPE(...); as one entity', () => {
    const seen: { id: number; type: string }[] = [];
    scanSections(ifc(MIN_IFC), {
      onEntity: (e) => seen.push({ id: e.expressId, type: e.type }),
      onHeaderRaw: () => {},
    });
    assert.equal(seen.length, 10);
    assert.deepEqual(seen[0], { id: 1, type: 'IFCPROJECT' });
    assert.equal(seen[6].type, 'IFCRELAGGREGATES');
  });

  it('handles doubled-quote escape inside strings', () => {
    const src = `DATA;\n#1=IFCWALL('aaaaaaaaaaaaaaaaaaaaaa',$,'Joe''s wall',$,$,$,$,$);\nENDSEC;\n`;
    const seen: string[] = [];
    scanSections(ifc(src), {
      onEntity: (e) => {
        const args = parseArgs(e.argsRaw);
        seen.push(asString(args[2]) ?? '<null>');
      },
      onHeaderRaw: () => {},
    });
    assert.equal(seen[0], "Joe's wall");
  });

  it('skips C-style comments between entities', () => {
    const src = `DATA;\n/* leading comment */ #1=IFCWALL('aaaaaaaaaaaaaaaaaaaaaa',$,'A',$,$,$,$,$);\n/* mid */\n#2=IFCDOOR('baaaaaaaaaaaaaaaaaaaaa',$,'B',$,$,$,$,$,2.,1.);\nENDSEC;\n`;
    const ids: number[] = [];
    scanSections(ifc(src), {
      onEntity: (e) => ids.push(e.expressId),
      onHeaderRaw: () => {},
    });
    assert.deepEqual(ids, [1, 2]);
  });

  it('handles multi-line entity args', () => {
    const src = `DATA;\n#1=IFCWALL(\n  'aaaaaaaaaaaaaaaaaaaaaa',\n  $,\n  'Wall',$,$,$,$,$\n);\nENDSEC;\n`;
    let count = 0;
    scanSections(ifc(src), {
      onEntity: (e) => {
        count++;
        const args = parseArgs(e.argsRaw);
        assert.equal(asString(args[2]), 'Wall');
      },
      onHeaderRaw: () => {},
    });
    assert.equal(count, 1);
  });

  it('preserves byte offsets for round-trip', () => {
    const src = `DATA;\n#1=IFCWALL('aaaaaaaaaaaaaaaaaaaaaa',$,$,$,$,$,$,$);\nENDSEC;\n`;
    const bytes = ifc(src);
    let offsets: { start: number; end: number } | null = null;
    scanSections(bytes, {
      onEntity: (e) => {
        offsets = { start: e.startOffset, end: e.endOffset };
      },
      onHeaderRaw: () => {},
    });
    assert.ok(offsets, 'should capture offsets');
    // Slice from startOffset to endOffset and confirm it's a real entity.
    const slice = Buffer.from(bytes.slice(offsets!.start, offsets!.end)).toString('utf-8');
    assert.match(slice, /^#1=IFCWALL\(.*\);$/);
  });
});

describe('args parser', () => {
  it('splits top-level args while respecting nested () and strings', () => {
    const args = splitTopLevelArgs(`'a,b',(1,2,3),#5,$,*`);
    assert.deepEqual(args, [`'a,b'`, `(1,2,3)`, `#5`, `$`, `*`]);
  });

  it('parses null, omitted, ref, string, list, integer, real, enum, typed', () => {
    assert.deepEqual(parseValue('$'), { kind: 'null' });
    assert.deepEqual(parseValue('*'), { kind: 'omitted' });
    assert.deepEqual(parseValue("'hello'"), { kind: 'string', value: 'hello' });
    assert.deepEqual(parseValue('#42'), { kind: 'ref', value: 42 });
    assert.deepEqual(parseValue('123'), { kind: 'integer', value: 123 });
    assert.deepEqual(parseValue('-1.5'), { kind: 'real', value: -1.5 });
    assert.deepEqual(parseValue('1.2E+5'), { kind: 'real', value: 1.2e5 });
    assert.deepEqual(parseValue('.UNDEFINED.'), { kind: 'enum', value: 'UNDEFINED' });
    const list = parseValue('(#1,#2,#3)');
    assert.equal(list.kind, 'list');
    if (list.kind === 'list') {
      assert.deepEqual(asRefList({ kind: 'list', value: list.value }), [1, 2, 3]);
    }
    const typed = parseValue("IFCLABEL('foo')");
    assert.equal(typed.kind, 'typed');
    if (typed.kind === 'typed') {
      assert.equal(typed.type, 'IFCLABEL');
      assert.deepEqual(typed.value, { kind: 'string', value: 'foo' });
    }
  });

  it('un-doubles inner doubled-quote escape in strings', () => {
    assert.deepEqual(parseValue("'Joe''s'"), { kind: 'string', value: "Joe's" });
  });

  it('asRef / asString helpers handle wrong types', () => {
    assert.equal(asRef({ kind: 'string', value: '#5' }), null);
    assert.equal(asString({ kind: 'ref', value: 5 }), null);
    assert.equal(asString(undefined), null);
  });
});

describe('header parser', () => {
  it('reads schema, file_name, description', () => {
    const header = buildHeader([
      "FILE_DESCRIPTION(('Some viewdef','Other'),'2;1')",
      "FILE_NAME('Test.ifc','2026-05-09',('Author1','Author2'),('OrgA'),'Pre','Sys','Auth')",
      "FILE_SCHEMA(('IFC4'))",
    ]);
    assert.equal(header.schema, 'IFC4');
    assert.deepEqual(header.description, ['Some viewdef', 'Other']);
    assert.equal(header.implementationLevel, '2;1');
    assert.equal(header.fileName.name, 'Test.ifc');
    assert.deepEqual(header.fileName.author, ['Author1', 'Author2']);
    assert.deepEqual(header.fileName.organization, ['OrgA']);
    assert.equal(header.fileName.preprocessorVersion, 'Pre');
    assert.equal(header.fileName.originatingSystem, 'Sys');
    assert.equal(header.fileName.authorization, 'Auth');
  });
});

describe('parseIfc - micro fixture', () => {
  it('builds a valid metadata index', () => {
    const idx = parseIfc(ifc(MIN_IFC));
    assert.equal(idx.schema, 'IFC2X3');
    assert.equal(idx.project?.name, 'My Project');
    assert.equal(idx.project?.long_name, 'Long');
    assert.equal(idx.project?.phase, 'Phase');
    assert.equal(idx.stats.entityCount, 10);
    assert.equal(idx.stats.element_count, 2); // wall + door
    assert.equal(idx.stats.storey_count, 1);
    // Spatial tree connected by IfcRelAggregates
    const project = idx.spatial[1];
    assert.deepEqual(project.child_ids, [2]);
    const site = idx.spatial[2];
    assert.deepEqual(site.child_ids, [3]);
    // Wall + door contained in storey #4
    assert.deepEqual([...idx.ids_by_storey[4]].sort(), [5, 6]);
    // by_type histogram
    assert.equal(idx.by_type['IFCWALL'], 1);
    assert.equal(idx.by_type['IFCDOOR'], 1);
    // GlobalId map
    assert.equal(idx.id_by_global_id['5aaaaaaaaaaaaaaaaaaaaa'], 5);
  });

  it('rejects IfcRel / IfcProperty / *Type / *Style from element catalog', () => {
    const src = `${MIN_IFC.replace('ENDSEC;\nEND-ISO', `#11=IFCRELDEFINESBYPROPERTIES('Baaaaaaaaaaaaaaaaaaaaa',$,$,$,(#5),#12);\n#12=IFCPROPERTYSET('Caaaaaaaaaaaaaaaaaaaaa',$,'Pset_WallCommon',$,(#13));\n#13=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('60min'),$);\n#14=IFCWALLTYPE('Daaaaaaaaaaaaaaaaaaaaa',$,'StdWall',$,$,$,$,$,$,.STANDARD.);\nENDSEC;\nEND-ISO`)}`;
    const idx = parseIfc(ifc(src));
    // Wall + door still picked up; PropertySet, Property, WallType excluded.
    assert.equal(idx.stats.element_count, 2);
    assert.equal(idx.by_type['IFCWALLTYPE'], undefined);
    assert.equal(idx.by_type['IFCPROPERTYSET'], undefined);
  });

  it('captures source SHA + byte count', () => {
    const bytes = ifc(MIN_IFC);
    const idx = parseIfc(bytes);
    assert.equal(idx.source_bytes, bytes.byteLength);
    assert.equal(idx.source_sha256.length, 64);
  });
});

describe('parseIfcStatsOnly', () => {
  it('returns entity count + by_type histogram only', () => {
    const stats = parseIfcStatsOnly(ifc(MIN_IFC));
    assert.equal(stats.entityCount, 10);
    assert.equal(stats.byType['IFCWALL'], 1);
    assert.ok(stats.parseMs >= 0);
  });
});
