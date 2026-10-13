/**
 * `values` without the entries that are `undefined`, typed as optional properties, so a constructor can pass on the
 * options it was given: `exactOptionalPropertyTypes` refuses `{ x: undefined }` for an optional `x`, and a sub-driver
 * must see an option the caller left out as absent.
 */
export function defined<T extends Record<string, unknown>>(
  values: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
