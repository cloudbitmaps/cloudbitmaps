/**
 * Reading the options a piece of code passes to `new CloudRoaring({ … })`, for the gates that hold the docs' samples
 * and the harnesses to the keys the store takes (`@/option-keys`). Nothing here runs the code: it reads the object
 * literal, the top level and each group whose value is itself a literal.
 */
import { OPTION_KEYS } from '@/option-keys';

/**
 * `src` with every comment and string literal blanked to spaces, so a URL, a comma or a brace inside one cannot be
 * read as code. Offsets into `src` still hold.
 */
export function codeOnly(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return src.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g,
    blank,
  );
}

/** The index of the bracket that closes the one at `open`. */
function closing(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return code.length;
}

/** An object literal's keys, and for each whose value is itself an object literal, that literal's body. */
function literalKeys(body: string): Array<{ key: string; object?: string }> {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      entries.push(body.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(body.slice(start));
  const out: Array<{ key: string; object?: string }> = [];
  for (const raw of entries) {
    const entry = raw.trim();
    // A spread, and a sample's elision (`…`), name no key.
    const m = /^([A-Za-z_$][\w$]*)\s*(?::\s*([\s\S]*))?$/.exec(entry);
    if (!m) continue;
    const value = m[2]?.trim() ?? '';
    out.push({
      key: m[1] as string,
      ...(value.startsWith('{') && closing(value, 0) === value.length - 1
        ? { object: value.slice(1, -1) }
        : {}),
    });
  }
  return out;
}

/**
 * Every key a `new CloudRoaring({ … })` in `src` passes that the store does not take, as `key` or `group.key`, with
 * the line it is on. With `namespaced`, `new m.CloudRoaring({ … })` is read too, as the harnesses write it.
 */
export function unknownStoreKeys(
  src: string,
  { namespaced = false } = {},
): Array<{ line: number; key: string }> {
  const code = codeOnly(src);
  const opener = namespaced
    ? /new\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?CloudRoaring\(\s*\{/g
    : /new\s+CloudRoaring\(\s*\{/g;
  const top = OPTION_KEYS.top as readonly string[];
  const out: Array<{ line: number; key: string }> = [];
  for (const m of code.matchAll(opener)) {
    const open = code.indexOf('{', m.index ?? 0);
    const line = src.slice(0, open).split('\n').length;
    for (const { key, object } of literalKeys(code.slice(open + 1, closing(code, open)))) {
      if (!top.includes(key)) {
        out.push({ line, key });
        continue;
      }
      const group = OPTION_KEYS[key as keyof typeof OPTION_KEYS] as readonly string[] | undefined;
      if (group === undefined || object === undefined) continue;
      for (const inner of literalKeys(object)) {
        if (!group.includes(inner.key)) out.push({ line, key: `${key}.${inner.key}` });
      }
    }
  }
  return out;
}
