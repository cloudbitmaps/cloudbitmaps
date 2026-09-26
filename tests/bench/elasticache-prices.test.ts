import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELASTICACHE_REDIS_US_EAST_1_ONDEMAND } from '@cloudbitmaps/core';

/**
 * The price list was read wrongly twice, on a join that looked unique and was not: the instance type and the engine.
 * A node type has several products, and the fixture below holds the ones that fooled it — an extended-support
 * surcharge, a sync-durability rate, a Memcached twin — around the one real node. The reader must find that one, and
 * refuse a list where the full key matches none or more than one.
 */
const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));
const { RESERVED, nodePrices, nodeProduct } = require_('./lib/elasticache-prices.cjs') as {
  RESERVED: Record<string, { oneYear: number; threeYearsUpfront: number }>;
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

function offer(extra: Record<string, object> = {}) {
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
        node: { t: { priceDimensions: { d: hourly('0.4110000000') } } },
        support: { t: { priceDimensions: { d: hourly('0.3290000000') } } },
        durability: { t: { priceDimensions: { d: hourly('0.0592000000') } } },
        valkey: { t: { priceDimensions: { d: hourly('0.3288000000') } } },
      },
      Reserved: {
        node: {
          one: term('1yr', 'No Upfront', { h: hourly('0.2810000000') }),
          three: term('3yr', 'All Upfront', { q: upfront('4867'), h: hourly('0.0000000000') }),
        },
      },
    },
  };
}

describe('the ElastiCache price reader reads each node on its full key', () => {
  it('finds the one real node among the products that share its type and engine', () => {
    expect(nodeProduct(offer(), TYPE, 'Redis')).toBe('node');
    expect(nodeProduct(offer(), TYPE, 'Valkey')).toBe('valkey');
    // The join the bug made: type and engine alone match two Redis products here.
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

  it('holds a reserved row for every node the catalogue prices, and none it does not', () => {
    expect(Object.keys(RESERVED).sort()).toEqual(
      ELASTICACHE_REDIS_US_EAST_1_ONDEMAND.nodeTypes.map((n) => n.name).sort(),
    );
  });
});
