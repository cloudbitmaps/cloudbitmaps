/**
 * The error a `.crbm` read throws for bytes it cannot trust. The message says the next step: the object is the
 * damage, so the segment is loaded again from its source, or rolled back to a generation that reads.
 */
import { IntegrityError } from '../errors';

export const crbmIntegrity = (message: string): IntegrityError =>
  new IntegrityError(`${message}; re-load from source or roll back`);
