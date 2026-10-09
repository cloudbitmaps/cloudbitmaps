/**
 * The two widths every `.crbm` v1 object is framed by: its front preamble and its footer. Frozen with the rest of the
 * layout in `format.ts`, which re-exports them. They live in a module of their own, with no imports, so that what needs
 * only the smallest size an object can have (the registry's check of a summary's fingerprint) does not bring the
 * format's other constants, or the reader, with it.
 */

/** Front preamble: magic(4) + version_major(1) + version_minor(1) + reserved(2). */
export const PREAMBLE_BYTES = 8;

/** Fixed footer size (v1.0). */
export const FOOTER_BYTES = 104;
