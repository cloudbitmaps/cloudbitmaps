import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * The SDK's `ApiError` class, found where the SDK defines it. A release exports it from the package's top level only
 * from some version on; the class itself (the one the client raises for a JSON API call that fails) sits in the same
 * place in every release the driver admits, and the driver never imports it, so a test that needs it must not depend on
 * the export.
 */
export type ApiErrorClass = new (options: {
  code?: number;
  message?: string;
  errors?: unknown[];
  response?: never;
}) => Error & { code?: number; errors?: unknown[]; response?: unknown };

const nodeRequire = createRequire(import.meta.url);
const util = nodeRequire(
  join(dirname(nodeRequire.resolve('@google-cloud/storage')), 'nodejs-common', 'util'),
) as { ApiError?: ApiErrorClass };
if (typeof util.ApiError !== 'function') throw new Error('the installed SDK defines no ApiError');

export const ApiError: ApiErrorClass = util.ApiError;
