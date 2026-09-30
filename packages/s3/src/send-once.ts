/**
 * `sendOnce` — send a conditional write exactly once, with the SDK's retry off for that one command.
 *
 * The SDK re-sends a request whose response it did not get: a timeout, a reset connection, a 5xx. For a conditional
 * write that is the wrong thing to do. When the write landed and only its response was lost, the second send meets
 * the first — `If-None-Match: *` finds the object it created, `If-Match` finds the ETag it replaced — and fails with
 * `412`, which the driver can only report as a lost race. The caller is told its write lost when it won. Only the
 * caller can find out which happened, by reading the pointer or listing the generations, so the write is sent once
 * and a transient failure reaches it as `TransientError`.
 *
 * **How.** The client runs its retry as one middleware, `retryMiddleware`, at high priority in the `finalizeRequest`
 * step, whatever retry strategy or `maxAttempts` it was built with. When a command is sent, its own middleware stack
 * is merged over the client's, and an entry with the same name, step and priority that sets `override` replaces the
 * client's. So this command runs with a pass-through where the retry was, and nothing about the client changes: a
 * caller's own client keeps its configuration, and every other command sent through it keeps its retry.
 *
 * The options object passed to `send` matters too. A client built with `cacheMiddleware: true` reuses the handler it
 * resolved for the first command of a class, and that handler holds the retry; `send` resolves afresh whenever it is
 * given options, so the replacement always takes effect.
 */
import type {
  $Command,
  S3Client,
  S3ClientResolvedConfig,
  ServiceInputTypes,
  ServiceOutputTypes,
} from '@aws-sdk/client-s3';

/** Where the client registers its retry. Overriding an entry takes the same name, step and priority. */
const NO_RETRY = {
  name: 'retryMiddleware',
  step: 'finalizeRequest',
  priority: 'high',
  override: true,
} as const;

/** Send `command` once: its retry step is a pass-through, and the client's stays as it is for every other command. */
export function sendOnce<Input extends ServiceInputTypes, Output extends ServiceOutputTypes>(
  client: S3Client,
  command: $Command<Input, Output, S3ClientResolvedConfig, ServiceInputTypes, ServiceOutputTypes>,
): Promise<Output> {
  command.middlewareStack.add((next) => next, NO_RETRY);
  return client.send(command, {});
}
