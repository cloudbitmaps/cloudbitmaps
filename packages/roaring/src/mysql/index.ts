/**
 * `@cloudbitmaps/roaring/mysql` — a thin re-export of `@cloudbitmaps/core/mysql`.
 *
 * The drivers live in **core** (they move opaque payload bytes, so they are codec-agnostic and every flavor
 * reuses one driver set with zero duplication). This barrel exists purely for ergonomics: a consumer who
 * installed `@cloudbitmaps/roaring` keeps **one package name to know** —
 * `import { … } from '@cloudbitmaps/roaring/mysql'` — instead of also naming core, which arrives transitively.
 * Importing from `@cloudbitmaps/core/mysql` is equivalent.
 */
export * from '@cloudbitmaps/core/mysql';
