import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AZURE_BLOB_STORAGE_OPTION_KEYS } from '@/azure-blob/backend';
import { GCS_STORAGE_OPTION_KEYS } from '@/gcs/backend';
import { S3_STORAGE_OPTION_KEYS } from '@/s3/backend';
import { OPTION_KEYS } from '@/option-keys';

/**
 * Each option table in the docs lists the keys the code takes: no more, and no fewer.
 *
 * The keys are the ones the constructors refuse an unknown name by, `OPTION_KEYS` for `CloudRoaring` and each
 * backend's own `*_OPTION_KEYS`, which the compiler or a test holds to the option types. A table that names a key the
 * code refuses sends a reader to a constructor that throws; one that leaves a key out hides an option that works.
 * (`code-fence-sanity.test.ts` holds the samples to the same keys; this holds the tables.)
 *
 * WHAT IS READ. In the three backends' READMEs and the roaring README, the table headed `Option`: the code spans in
 * its first column are the keys, and in the roaring README the code spans of a group's row are the group's keys. In
 * `docs/guide/api-reference.md`, the `new XStorage({ … })` signatures of the backend table, the `CloudRoaringOptions`
 * table and the keys named in each group's row, and the size-settings table, whose rows are a few of a backend's keys.
 */
const ROOT = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/**
 * Keys the code takes that a README's table leaves to the API reference, each with the reason. Nothing else may be
 * left out of a table.
 */
const NOT_IN_README_TABLES: Readonly<Record<string, string>> = {
  now: 'a clock for tests, which the API reference signature lists',
};

/**
 * A group whose row names only some of its keys, and says so: the retry row names `onRetry` and points at the policy
 * the rest come from. The row is held to naming no key the group does not take, but not to naming them all.
 */
const PARTIAL_GROUP_ROWS: Readonly<Record<string, string>> = {
  retry: "the row names `onRetry` and leaves the policy's own keys to the policy it points at",
};

const BACKENDS = {
  S3Storage: { readme: 'packages/s3/README.md', keys: S3_STORAGE_OPTION_KEYS },
  GcsStorage: { readme: 'packages/gcs/README.md', keys: GCS_STORAGE_OPTION_KEYS },
  AzureBlobStorage: {
    readme: 'packages/azure-blob/README.md',
    keys: AZURE_BLOB_STORAGE_OPTION_KEYS,
  },
} as const;

/** The cells of a table row, split at the pipes that are not escaped. */
const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

/** The rows of the first table whose header starts with `header` (its cells, in order), as arrays of cells. */
export function tableRows(md: string, header: readonly string[]): string[][] {
  const lines = md.split('\n');
  const at = lines.findIndex((l) => {
    if (!l.trimStart().startsWith('|')) return false;
    const head = cells(l);
    return header.every((h, i) => head[i] === h);
  });
  if (at < 0) throw new Error(`no table headed ${header.join(' | ')}`);
  const rows: string[][] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.trimStart().startsWith('|')) break;
    rows.push(cells(line));
  }
  return rows;
}

/** The words inside a cell's code spans: ``[`a`, `b`]`` and `` `{ a, b }` `` are both `a` and `b`. */
export function codeWords(cell: string): string[] {
  const words: string[] = [];
  for (const span of cell.matchAll(/`([^`]+)`/g)) {
    for (const word of span[1]!.split(/[^\w]+/)) {
      if (/^[A-Za-z]\w*$/.test(word) && !['true', 'false', 'null'].includes(word)) words.push(word);
    }
  }
  return words;
}

/** The keys a table names, against the keys the code takes: those named that it does not take, and those it leaves out. */
export function compareKeys(
  named: readonly string[],
  taken: readonly string[],
  exempt: readonly string[] = [],
): { unknown: string[]; missing: string[]; repeated: string[] } {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const k of named) {
    if (seen.has(k)) repeated.push(k);
    seen.add(k);
  }
  return {
    unknown: [...seen].filter((k) => !taken.includes(k)),
    missing: taken.filter((k) => !seen.has(k) && !exempt.includes(k)),
    repeated,
  };
}

/** A message for each way `named` is wrong, or none. */
function problems(
  where: string,
  named: readonly string[],
  taken: readonly string[],
  exempt: readonly string[] = [],
): string[] {
  const { unknown, missing, repeated } = compareKeys(named, taken, exempt);
  return [
    ...unknown.map((k) => `${where} names \`${k}\`, which the code does not take`),
    ...missing.map((k) => `${where} leaves out \`${k}\`, which the code takes`),
    ...repeated.map((k) => `${where} names \`${k}\` more than once`),
  ];
}

describe('the option tables name the keys the code takes', () => {
  describe.each(Object.entries(BACKENDS))(
    "the %s README's Option table",
    (name, { readme, keys }) => {
      it('names every key, and no other', () => {
        const rows = tableRows(read(readme), ['Option', 'What it does']);
        const named = rows.flatMap((r) => codeWords(r[0] ?? ''));
        expect(
          problems(`${readme}'s Option table`, named, keys, Object.keys(NOT_IN_README_TABLES)),
        ).toEqual([]);
      });
    },
  );

  describe("the roaring README's Option table", () => {
    const readme = 'packages/roaring/README.md';
    const rows = tableRows(read(readme), ['Option', 'What it holds']);

    it('names every top-level key of CloudRoaring, and no other', () => {
      const named = rows.flatMap((r) => codeWords(r[0] ?? ''));
      expect(problems(`${readme}'s Option table`, named, OPTION_KEYS.top)).toEqual([]);
    });

    it.each(['cache', 'encryption', 'retry', 'budget', 'seams'] as const)(
      "names the %s group's keys, and no other",
      (group) => {
        const row = rows.find((r) => codeWords(r[0] ?? '')[0] === group);
        expect(row, `${readme} has no row for ${group}`).toBeDefined();
        const named = codeWords(row?.[1] ?? '');
        const taken = OPTION_KEYS[group];
        if (group in PARTIAL_GROUP_ROWS) {
          expect(problems(`${readme}'s ${group} row`, named, taken, taken)).toEqual([]);
        } else {
          expect(problems(`${readme}'s ${group} row`, named, taken)).toEqual([]);
        }
      },
    );
  });

  describe("the API reference's tables", () => {
    const doc = 'docs/guide/api-reference.md';
    const text = read(doc);

    it.each(Object.entries(BACKENDS))(
      "signature of %s's constructor names every key, and no other",
      (name, { keys }) => {
        const row = tableRows(text, ['Backend', 'Import', 'Construct']).find((r) =>
          (r[0] ?? '').startsWith(`\`${name}\``),
        );
        expect(row, `${doc} has no backend row for ${name}`).toBeDefined();
        const literals = [...(row?.[2] ?? '').matchAll(/\(\{([^}]*)\}\)/g)];
        expect(literals.length, `${name} has no \`new ${name}({ … })\` in its row`).toBeGreaterThan(
          0,
        );
        // A backend with two ways to be built (Azure) names a key in each literal: it is one key.
        const named = [
          ...new Set(
            literals.flatMap((m) =>
              (m[1] ?? '')
                .split(',')
                .map((k) => k.trim().replace(/\?$/, ''))
                .filter(Boolean),
            ),
          ),
        ];
        expect(problems(`${doc}'s ${name} row`, named, keys)).toEqual([]);
      },
    );

    it('lists the size settings only as keys of the backend they sit under', () => {
      const rows = tableRows(text, ['Backend', 'Option', 'Default', 'What it does']);
      const offenders: string[] = [];
      for (const row of rows) {
        const backend = codeWords(row[0] ?? '')[0] as keyof typeof BACKENDS | undefined;
        const option = codeWords(row[1] ?? '')[0];
        const keys: readonly string[] | undefined =
          backend === undefined ? undefined : BACKENDS[backend]?.keys;
        if (keys === undefined)
          offenders.push(`${doc}: a size-settings row for ${String(backend)}, which is no backend`);
        else if (option === undefined || !keys.includes(option))
          offenders.push(`${doc}: ${backend} has no option \`${String(option)}\``);
      }
      expect(rows.length).toBeGreaterThan(0);
      expect(offenders).toEqual([]);
    });

    describe('the CloudRoaringOptions table', () => {
      const rows = tableRows(text, ['key', 'type', 'what it holds']);

      it('names every top-level key, and no other', () => {
        const named = rows.map((r) => codeWords(r[0] ?? '')[0] ?? '');
        expect(problems(`${doc}'s CloudRoaringOptions table`, named, OPTION_KEYS.top)).toEqual([]);
      });

      it.each(['cache', 'encryption', 'retry', 'budget', 'seams'] as const)(
        "names the %s group's keys, and no other",
        (group) => {
          const row = rows.find((r) => codeWords(r[0] ?? '')[0] === group);
          expect(row, `${doc} has no row for ${group}`).toBeDefined();
          // A group's key is written `key?` in its row; the row's type and prose are not read for words.
          const mentioned = [...(row?.[2] ?? '').matchAll(/`(\w+)\?`/g)].map((m) => m[1]!);
          const taken = OPTION_KEYS[group];
          if (group in PARTIAL_GROUP_ROWS) {
            expect(problems(`${doc}'s ${group} row`, mentioned, taken, taken)).toEqual([]);
          } else if (group === 'budget') {
            expect(problems(`${doc}'s ${group} row`, codeWords(row?.[2] ?? ''), taken)).toEqual([]);
          } else {
            expect(problems(`${doc}'s ${group} row`, mentioned, taken)).toEqual([]);
          }
        },
      );
    });
  });

  describe('as a check on a copy of a table', () => {
    const TABLE = [
      '| Option | What it does |',
      '|---|---|',
      '| `bucket` (required) | the bucket |',
      '| `region`, `endpoint` | build a client |',
      '| `prefix` | a prefix |',
    ].join('\n');
    const keys = ['bucket', 'region', 'endpoint', 'prefix'] as const;
    const named = (md: string): string[] =>
      tableRows(md, ['Option', 'What it does']).flatMap((r) => codeWords(r[0] ?? ''));

    it('passes a table that names each key once', () => {
      expect(problems('t', named(TABLE), keys)).toEqual([]);
    });

    it('fails a key removed from the table, naming it', () => {
      const without = TABLE.replace('| `prefix` | a prefix |\n', '').replace(
        '\n| `prefix` | a prefix |',
        '',
      );
      expect(without).not.toBe(TABLE);
      expect(problems('t', named(without), keys)).toEqual([
        't leaves out `prefix`, which the code takes',
      ]);
    });

    it('fails an option row the code does not take, naming it', () => {
      const added = `${TABLE}\n| \`fakeOption\` | does nothing |`;
      expect(problems('t', named(added), keys)).toEqual([
        't names `fakeOption`, which the code does not take',
      ]);
    });

    it('fails a key named twice', () => {
      const twice = `${TABLE}\n| \`prefix\` | again |`;
      expect(problems('t', named(twice), keys)).toEqual(['t names `prefix` more than once']);
    });

    it('reads a key from inside an object literal in a cell, and not true, false or null', () => {
      expect(codeWords('`{ keystore, required }`')).toEqual(['keystore', 'required']);
      expect(codeWords('`{ maxRequests }` or `false`')).toEqual(['maxRequests']);
    });
  });
});
