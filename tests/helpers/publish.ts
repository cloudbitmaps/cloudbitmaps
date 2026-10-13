/**
 * `publishGeneration` for a test that publishes a number with no object behind it: the publish needs the footer checksum
 * of the object it records in the ledger, which here is the checksum of a clear summary's fingerprint when one is given,
 * and 0 otherwise.
 */
import { fingerprintParts } from '@/core/crbm/fingerprint';
import { publishGeneration as publish } from '@/core/publish';

type Options = Omit<Parameters<typeof publish>[2], 'footerCrc'> & { footerCrc?: number };

export function publishGeneration(
  registry: Parameters<typeof publish>[0],
  key: Parameters<typeof publish>[1],
  options: Options = {},
): Promise<boolean> {
  const summary = options.summary;
  const footerCrc =
    options.footerCrc ??
    (summary !== undefined && 'fingerprint' in summary
      ? (fingerprintParts(summary.fingerprint)?.footerCrc ?? 0)
      : 0);
  return publish(registry, key, { ...options, footerCrc });
}
