import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELASTICACHE_REDIS_US_EAST_1_ONDEMAND } from '@cloudbitmaps/tools';

/**
 * A join on the instance type and the engine looks unique and is not. A node type has several products, and the
 * fixture below holds, around each engine's one real node, the products that share its type: an extended-support
 * surcharge, a sync-durability rate and a Memcached twin. The reader must find that one, and refuse a list where
 * the full key matches none or more than one.
 */
const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));
const { RESERVED, VALKEY_DISCOUNT, citedVersion, disagreements, nodePrices, nodeProduct } =
  require_('./lib/elasticache-prices.cjs') as {
    RESERVED: Record<string, { oneYear: number; threeYearsUpfront: number }>;
    VALKEY_DISCOUNT: number;
    citedVersion: (source: string) => string;
    disagreements: (
      offer: object,
      nodeTypes: ReadonlyArray<{ name: string; hourlyUSD: number }>,
      reserved?: Record<string, { oneYear: number; threeYearsUpfront: number }>,
      version?: string,
    ) => string[];
    nodePrices: (offer: object, type: string, engine: string) => Record<string, number>;
    nodeProduct: (offer: object, type: string, engine: string) => string;
  };

const TYPE = 'cache.r6g.xlarge';
const product = (engine: string, usagetype: string) => ({
  attributes: { instanceType: TYPE, cacheEngine: engine, usagetype },
});
const hourly = (usd: string) => ({ unit: 'Hrs', pricePerUnit: { USD: usd } });
const upfront = (usd: string) => ({ unit: 'Quantity', pricePerUnit: { USD: usd } });
const term = (length: string, option: string, dims: object) => ({
  termAttributes: { LeaseContractLength: length, PurchaseOption: option },
  priceDimensions: dims,
});

function offer(
  extra: Record<string, object> = {},
  terms: {
    onDemand?: object;
    reserved?: object;
    valkeyOnDemand?: string;
    threeYearsHourly?: string;
    valkeyOneYear?: string;
    valkeyThreeYearsHourly?: string;
  } = {},
) {
  return {
    products: {
      node: product('Redis', `NodeUsage:${TYPE}`),
      support: product('Redis', `USE1-ExtendedSupportYr1_Yr2-NodeUsage:${TYPE}`),
      durability: product('Valkey', `USE1-SyncDurability-NodeUsage:${TYPE}`),
      valkey: product('Valkey', `NodeUsage:${TYPE}`),
      memcached: product('Memcached', `NodeUsage:${TYPE}`),
      ...extra,
    },
    terms: {
      OnDemand: {
        node: terms.onDemand ?? { t: { priceDimensions: { d: hourly('0.4110000000') } } },
        support: { t: { priceDimensions: { d: hourly('0.3290000000') } } },
        durability: { t: { priceDimensions: { d: hourly('0.0592000000') } } },
        valkey: { t: { priceDimensions: { d: hourly(terms.valkeyOnDemand ?? '0.3288000000') } } },
      },
      Reserved: {
        node: terms.reserved ?? {
          one: term('1yr', 'No Upfront', { h: hourly('0.2810000000') }),
          three: term('3yr', 'All Upfront', {
            q: upfront('4867'),
            h: hourly(terms.threeYearsHourly ?? '0.0000000000'),
          }),
          // The terms the reader must pass over: every other purchase option, at both lengths.
          oneAll: term('1yr', 'All Upfront', { q: upfront('2336'), h: hourly('0.0000000000') }),
          onePartial: term('1yr', 'Partial Upfront', {
            q: upfront('1168'),
            h: hourly('0.1330000000'),
          }),
          threeNone: term('3yr', 'No Upfront', { h: hourly('0.2070000000') }),
          threePartial: term('3yr', 'Partial Upfront', {
            q: upfront('2530'),
            h: hourly('0.0960000000'),
          }),
        },
        // Valkey's, which is Redis's less a fifth on every term.
        valkey: {
          one: term('1yr', 'No Upfront', { h: hourly(terms.valkeyOneYear ?? '0.2248000000') }),
          three: term('3yr', 'All Upfront', {
            q: upfront('3893.6'),
            h: hourly(terms.valkeyThreeYearsHourly ?? '0.0000000000'),
          }),
        },
      },
    },
  };
}

describe('the ElastiCache price reader reads each node on its full key', () => {
  it('finds the one real node among the products that share its type and engine', () => {
    expect(nodeProduct(offer(), TYPE, 'Redis')).toBe('node');
    expect(nodeProduct(offer(), TYPE, 'Valkey')).toBe('valkey');
    // The loose join, on type and engine alone, matches two Redis products here.
    const loose = Object.values(offer().products).filter(
      (p) => p.attributes.instanceType === TYPE && p.attributes.cacheEngine === 'Redis',
    );
    expect(loose).toHaveLength(2);
  });

  it("reads that node's on-demand price and both reserved terms", () => {
    expect(nodePrices(offer(), TYPE, 'Redis')).toEqual({
      hourlyUSD: 0.411,
      oneYear: 0.281,
      threeYearsUpfront: 4867,
      threeYearsHourly: 0,
    });
  });

  it('refuses a list where the full key matches no product, or more than one', () => {
    expect(() => nodeProduct(offer(), 'cache.r7g.xlarge', 'Redis')).toThrow(
      /no NodeUsage:cache\.r7g\.xlarge/,
    );
    const twice = offer({ again: product('Redis', `NodeUsage:${TYPE}`) });
    expect(() => nodeProduct(twice, TYPE, 'Redis')).toThrow(
      /2 NodeUsage:cache\.r6g\.xlarge product\(s\)/,
    );
  });

  it('refuses a node with several on-demand terms, several of one reserved term, or several prices of one unit', () => {
    const twoOnDemand = offer(
      {},
      {
        onDemand: {
          t: { priceDimensions: { d: hourly('0.4110000000') } },
          u: { priceDimensions: { d: hourly('0.4120000000') } },
        },
      },
    );
    expect(() => nodePrices(twoOnDemand, TYPE, 'Redis')).toThrow(/2 on-demand terms/);
    const twice = offer(
      {},
      {
        reserved: {
          one: term('1yr', 'No Upfront', { h: hourly('0.2810000000') }),
          again: term('1yr', 'No Upfront', { h: hourly('0.2800000000') }),
          three: term('3yr', 'All Upfront', { q: upfront('4867'), h: hourly('0.0000000000') }),
        },
      },
    );
    expect(() => nodePrices(twice, TYPE, 'Redis')).toThrow(/2 1yr No Upfront terms/);
    const twoPrices = offer(
      {},
      {
        onDemand: {
          t: { priceDimensions: { d: hourly('0.4110000000'), e: hourly('0.4120000000') } },
        },
      },
    );
    expect(() => nodePrices(twoPrices, TYPE, 'Redis')).toThrow(/2 Hrs prices/);
  });

  // CI cannot read the list itself, a 2 MB download. What it can see is a mistyped price: within a family, each size
  // is priced as a multiple of the smallest, to within the few tenths of a percent AWS rounds to, so a row off that
  // line by more than 2% is a typo. A price nudged by less still needs `check-elasticache-prices.cjs` and the list.
  it('prices each node of a family in proportion to its size, on both terms', () => {
    const units = (type: string): number => {
      const size = type.slice(type.lastIndexOf('.') + 1);
      const named: Record<string, number> = { micro: 0.25, small: 0.5, medium: 1, large: 2 };
      if (named[size] !== undefined) return named[size];
      const x = /^(\d*)xlarge$/.exec(size);
      if (x === null) throw new Error(`no size for ${type}`);
      return 4 * (x[1] === '' ? 1 : Number(x[1]));
    };
    const families = new Map<string, string[]>();
    for (const type of Object.keys(RESERVED)) {
      const family = type.slice(0, type.lastIndexOf('.'));
      families.set(family, [...(families.get(family) ?? []), type]);
    }
    for (const [family, types] of families) {
      if (types.length < 2) continue;
      for (const term of ['oneYear', 'threeYearsUpfront'] as const) {
        const perUnit = types.map((t) => RESERVED[t]![term] / units(t));
        expect(Math.max(...perUnit) / Math.min(...perUnit), `${family} ${term}`).toBeLessThan(1.02);
      }
    }
  });

  describe('the price check holds every rule the pages price by', () => {
    const catalogue = [{ name: TYPE, hourlyUSD: 0.411 }];
    const reserved = { [TYPE]: RESERVED[TYPE]! };

    it('finds nothing wrong with a list that agrees', () => {
      expect(disagreements(offer(), catalogue, reserved)).toEqual([]);
    });

    it('names a three-year upfront price, and a Valkey reserved price, the list does not bear out', () => {
      const off = { [TYPE]: { ...RESERVED[TYPE]!, threeYearsUpfront: 4800 } };
      expect(disagreements(offer(), catalogue, off)).toEqual([
        `${TYPE}: threeYearsUpfront is 4867, where RESERVED says 4800`,
      ]);
      expect(
        disagreements(offer({}, { valkeyOneYear: '0.2300000000' }), catalogue, reserved),
      ).toEqual([`${TYPE}: Valkey's oneYear is 0.23, not Redis's 0.281 less 20%`]);
      // Exactly the discount: a Valkey price a tenth of a percent off is named too.
      expect(
        disagreements(offer({}, { valkeyOnDemand: '0.3291288000' }), catalogue, reserved),
      ).toHaveLength(1);
    });

    it('reads the reserved table the pages price by when none is passed, and the version the catalogue cites', () => {
      const byDefault = disagreements(offer(), catalogue);
      expect(byDefault).not.toContain(`${TYPE}: no reserved row`);
      expect(byDefault).toHaveLength(Object.keys(RESERVED).length - 1); // the rows for nodes this catalogue lacks
      const cited = citedVersion(ELASTICACHE_REDIS_US_EAST_1_ONDEMAND.source);
      expect(cited).toBe('20260914063714');
      expect(disagreements({ ...offer(), version: cited }, catalogue, reserved, cited)).toEqual([]);
      expect(
        disagreements({ ...offer(), version: '20260801000000' }, catalogue, reserved, cited),
      ).toEqual([`the list is version 20260801000000, where the catalogue cites ${cited}`]);
    });

    it('refuses a catalogue whose source no longer names the list it cites, rather than check against any', () => {
      for (const source of [
        'AWS price list',
        'AWS price list 2026091406371',
        'AWS price list 202609140637140',
      ]) {
        expect(() => citedVersion(source)).toThrow(/names no price list version/);
      }
    });

    it("names a Valkey price that is not Redis's less the discount the pages use", () => {
      expect(VALKEY_DISCOUNT).toBe(0.2);
      expect(
        disagreements(offer({}, { valkeyOnDemand: '0.3500000000' }), catalogue, reserved),
      ).toEqual([`${TYPE}: Valkey's hourlyUSD is 0.35, not Redis's 0.411 less 20%`]);
    });

    it('names a catalogue price, or a reserved row, that the list does not bear out', () => {
      expect(disagreements(offer(), [{ name: TYPE, hourlyUSD: 0.4 }], reserved)).toEqual([
        `${TYPE}: on demand 0.411 an hour, where the catalogue says 0.4`,
      ]);
      const off = { [TYPE]: { ...RESERVED[TYPE]!, oneYear: 0.28 } };
      expect(disagreements(offer(), catalogue, off)).toEqual([
        `${TYPE}: oneYear is 0.281, where RESERVED says 0.28`,
      ]);
    });

    it('names a three-year term that also charges by the hour, and rows on either side with no partner', () => {
      expect(
        disagreements(offer({}, { threeYearsHourly: '0.0100000000' }), catalogue, reserved),
      ).toEqual([`${TYPE}: Redis's three years paid upfront also charges 0.01 an hour`]);
      expect(
        disagreements(offer({}, { valkeyThreeYearsHourly: '0.0080000000' }), catalogue, reserved),
      ).toEqual([`${TYPE}: Valkey's three years paid upfront also charges 0.008 an hour`]);
      expect(disagreements(offer(), catalogue, {})).toEqual([`${TYPE}: no reserved row`]);
      expect(
        disagreements(offer(), catalogue, { ...reserved, 'cache.r9.huge': reserved[TYPE]! }),
      ).toEqual(['cache.r9.huge: a reserved row for no catalogue node']);
    });
  });

  it('holds a reserved row for every node the catalogue prices, and none it does not', () => {
    expect(Object.keys(RESERVED).sort()).toEqual(
      ELASTICACHE_REDIS_US_EAST_1_ONDEMAND.nodeTypes.map((n) => n.name).sort(),
    );
  });
});

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/**
 * Run `node bench/check-elasticache-prices.cjs <file>` in-process, with `offers` (path → parsed list) served in place of
 * files on disk and `catalogue` in place of the estimator's, so the exit a person relies on is tested without the
 * 2 MB download.
 */
function priceCheck(
  argv: string[],
  {
    catalogue = ELASTICACHE_REDIS_US_EAST_1_ONDEMAND,
    offers = {},
  }: { catalogue?: object; offers?: Record<string, object> } = {},
): { code: number; out: string } {
  const script = join(ROOT, 'bench', 'check-elasticache-prices.cjs');
  const realFs = require_('node:fs') as typeof import('node:fs');
  const fs = {
    ...realFs,
    readFileSync: (p: string, ...rest: unknown[]) =>
      p in offers
        ? JSON.stringify(offers[p])
        : (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest),
  };
  const modules: Record<string, unknown> = {
    'node:fs': fs,
    '@cloudbitmaps/tools': { ELASTICACHE_REDIS_US_EAST_1_ONDEMAND: catalogue },
  };
  const lines: string[] = [];
  const log = (...a: unknown[]): void => {
    lines.push(a.join(' '));
  };
  // A function body cannot begin with the script's `#!` line.
  const source = realFs.readFileSync(script, 'utf8').replace(/^#!.*\n/, '');
  try {
    new Function('require', 'process', 'console', source)(
      (id: string) => modules[id] ?? require_(id),
      {
        argv: ['node', script, ...argv],
        exit: (code: number): never => {
          throw new Exit(code);
        },
      },
      { log, error: log },
    );
    return { code: 0, out: lines.join('\n') };
  } catch (e) {
    if (e instanceof Exit) return { code: e.code, out: lines.join('\n') };
    throw e;
  }
}

/** A price list that agrees with every catalogue node and reserved row, Valkey a fifth less, at `version`. */
function fullOffer(version: string) {
  const products: Record<string, object> = {};
  const onDemand: Record<string, object> = {};
  const reserved: Record<string, object> = {};
  for (const { name, hourlyUSD } of ELASTICACHE_REDIS_US_EAST_1_ONDEMAND.nodeTypes) {
    const row = RESERVED[name]!;
    for (const [engine, scale] of [
      ['Redis', 1],
      ['Valkey', 1 - VALKEY_DISCOUNT],
    ] as const) {
      const sku = `${name}:${engine}`;
      products[sku] = {
        attributes: { instanceType: name, cacheEngine: engine, usagetype: `NodeUsage:${name}` },
      };
      onDemand[sku] = { t: { priceDimensions: { d: hourly(String(scale * hourlyUSD)) } } };
      reserved[sku] = {
        one: term('1yr', 'No Upfront', { h: hourly(String(scale * row.oneYear)) }),
        three: term('3yr', 'All Upfront', {
          q: upfront(String(scale * row.threeYearsUpfront)),
          h: hourly('0.0000000000'),
        }),
      };
    }
  }
  return { version, products, terms: { OnDemand: onDemand, Reserved: reserved } };
}

describe('check-elasticache-prices exits as a person running it needs', () => {
  const cited = citedVersion(ELASTICACHE_REDIS_US_EAST_1_ONDEMAND.source);

  it('passes a list of the cited version that agrees, and names the nodes it checked', () => {
    const r = priceCheck(['ec.json'], { offers: { 'ec.json': fullOffer(cited) } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(
      `all ${ELASTICACHE_REDIS_US_EAST_1_ONDEMAND.nodeTypes.length} node types agree with ec.json`,
    );
  });

  it('exits 1 on a list of another version, however well it agrees', () => {
    const r = priceCheck(['ec.json'], { offers: { 'ec.json': fullOffer('20260801000000') } });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      `the list is version 20260801000000, where the catalogue cites ${cited}`,
    );
  });

  it('exits 2, checking nothing, on a catalogue that cites no version, or with no list to read', () => {
    const uncited = { ...ELASTICACHE_REDIS_US_EAST_1_ONDEMAND, source: 'AWS price list' };
    const r = priceCheck(['ec.json'], {
      catalogue: uncited,
      offers: { 'ec.json': fullOffer(cited) },
    });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(
      /check-elasticache-prices: the catalogue's source names no price list version/,
    );
    const none = priceCheck([]);
    expect(none.code).toBe(2);
    expect(none.out).toMatch(/usage: node bench\/check-elasticache-prices\.cjs <offer\.json>/);
  });
});
