import { vi } from 'vitest';
import { describeCounts } from '../helpers/count-suite';

vi.setConfig({ testTimeout: 120_000 });
vi.mock('@/count-route', () => ({ COUNT_BY_KERNELS: false }));

describeCounts('the counting methods, answered by the build-then-count route', 'derived');
