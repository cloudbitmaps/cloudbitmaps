/*
 * ElastiCache node prices, as bench/sizing.cjs prices Redis bought on a reserved term, and the one reader of AWS's
 * price list (its offer file) that they are checked against.
 *
 * The reader exists because the price list was read wrongly twice. A node type has several products in it: the node
 * itself, its extended-support surcharges, a sync-durability rate, and a Memcached twin at the same price. A join on
 * the instance type and the engine picks among them by chance, and did: once for the on-demand catalogue, and again for
 * these reserved terms, where it priced a `cache.m6g.large` Valkey node at $0.0215 an hour. So a node is found by its
 * usage type, `NodeUsage:<type>`, and a type that matches no product, or more than one, is refused rather than read.
 */
'use strict';

/**
 * What each catalogue node type costs reserved, at the two ends of what AWS sells: one year with nothing upfront
 * (`oneYear`, dollars an hour) and three years paid all upfront (`threeYearsUpfront`, dollars once). Read from price
 * list version 20260914063714, us-east-1, the version the estimator's catalogue cites, for Redis OSS. On every row of
 * that list a Valkey node's reserved price is its Redis one less a fifth, exactly, so the Valkey discount stacks on
 * these. `node bench/check-elasticache-prices.cjs <offer.json>` holds every row to the list.
 */
const RESERVED = Object.freeze({
  'cache.t4g.micro': { oneYear: 0.011, threeYearsUpfront: 190 },
  'cache.t4g.small': { oneYear: 0.022, threeYearsUpfront: 379 },
  'cache.t4g.medium': { oneYear: 0.044, threeYearsUpfront: 771 },
  'cache.m6g.large': { oneYear: 0.102, threeYearsUpfront: 1758 },
  'cache.r6g.large': { oneYear: 0.141, threeYearsUpfront: 2434 },
  'cache.r6g.xlarge': { oneYear: 0.281, threeYearsUpfront: 4867 },
  'cache.r6g.2xlarge': { oneYear: 0.561, threeYearsUpfront: 9733 },
  'cache.r6g.4xlarge': { oneYear: 1.121, threeYearsUpfront: 19466 },
  'cache.r6g.8xlarge': { oneYear: 2.241, threeYearsUpfront: 38931 },
  'cache.r6g.12xlarge': { oneYear: 3.362, threeYearsUpfront: 58396 },
  'cache.r6g.16xlarge': { oneYear: 4.482, threeYearsUpfront: 77862 },
  'cache.r6gd.xlarge': { oneYear: 0.531, threeYearsUpfront: 9229.86 },
  'cache.r6gd.2xlarge': { oneYear: 1.061, threeYearsUpfront: 18437.27 },
  'cache.r6gd.4xlarge': { oneYear: 2.121, threeYearsUpfront: 36874.54 },
  'cache.r6gd.8xlarge': { oneYear: 4.243, threeYearsUpfront: 73749.08 },
  'cache.r6gd.12xlarge': { oneYear: 6.363, threeYearsUpfront: 110601.16 },
  'cache.r6gd.16xlarge': { oneYear: 8.485, threeYearsUpfront: 147475.7 },
});

/**
 * How much less AWS prices an ElastiCache for Valkey node than a Redis OSS one, on demand and on each reserved term:
 * https://aws.amazon.com/elasticache/pricing/. `sizing.cjs` prices Valkey with it, and {@link disagreements} holds
 * every row of the price list to it.
 */
const VALKEY_DISCOUNT = 0.2;

/** The one product for a node type and engine: its `NodeUsage:<type>` SKU, or a refusal naming what was found. */
function nodeProduct(offer, type, engine) {
  const skus = Object.entries(offer.products)
    .filter(
      ([, p]) =>
        p.attributes?.instanceType === type &&
        p.attributes?.cacheEngine === engine &&
        p.attributes?.usagetype === `NodeUsage:${type}`,
    )
    .map(([sku]) => sku);
  if (skus.length !== 1) {
    throw new Error(
      `price list: ${skus.length === 0 ? 'no' : skus.length} NodeUsage:${type} product(s) for ${engine}` +
        (skus.length === 0 ? '' : ` (${skus.join(', ')})`) +
        ' — a node is read on its full key, never guessed among several',
    );
  }
  return skus[0];
}

/** The terms of one product, each with exactly one price of the unit asked for: a second would be a guess too. */
function onlyPrice(term, unit, what) {
  const prices = Object.values(term.priceDimensions).filter(
    (d) => (unit === 'Quantity') === (d.unit === 'Quantity'),
  );
  if (prices.length !== 1)
    throw new Error(`price list: ${prices.length} ${unit} prices for ${what}`);
  return Number(prices[0].pricePerUnit.USD);
}

/** A node's on-demand hourly price, and its reserved terms at both ends, read on the full key. */
function nodePrices(offer, type, engine) {
  const sku = nodeProduct(offer, type, engine);
  const onDemand = Object.values(offer.terms.OnDemand?.[sku] ?? {});
  if (onDemand.length !== 1)
    throw new Error(`price list: ${onDemand.length} on-demand terms for ${type} ${engine}`);
  const reserved = (length, option) => {
    const terms = Object.values(offer.terms.Reserved?.[sku] ?? {}).filter(
      (t) =>
        t.termAttributes.LeaseContractLength === length &&
        t.termAttributes.PurchaseOption === option,
    );
    if (terms.length !== 1)
      throw new Error(`price list: ${terms.length} ${length} ${option} terms for ${type}`);
    return terms[0];
  };
  const threeYears = reserved('3yr', 'All Upfront');
  return {
    hourlyUSD: onlyPrice(onDemand[0], 'Hrs', `${type} on demand`),
    oneYear: onlyPrice(reserved('1yr', 'No Upfront'), 'Hrs', `${type} one year`),
    threeYearsUpfront: onlyPrice(threeYears, 'Quantity', `${type} three years`),
    // Zero on every row of the list RESERVED was read from, which is why RESERVED holds the upfront alone.
    threeYearsHourly: onlyPrice(threeYears, 'Hrs', `${type} three years, hourly`),
  };
}

/**
 * Every way a price list disagrees with what the pages price: a catalogue node's on-demand price, a reserved row, a
 * Valkey price that is not Redis's less {@link VALKEY_DISCOUNT}, or a three-year term that also charges by the hour.
 * `nodeTypes` is the catalogue's, `reserved` the table the pages read, and `version`, when given, the list version the
 * catalogue cites, which the list must be.
 */
function disagreements(offer, nodeTypes, reserved = RESERVED, version = undefined) {
  const wrong = [];
  if (version !== undefined && offer.version !== version) {
    wrong.push(`the list is version ${offer.version}, where the catalogue cites ${version}`);
  }
  const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  for (const { name, hourlyUSD } of nodeTypes) {
    const redis = nodePrices(offer, name, 'Redis');
    const valkey = nodePrices(offer, name, 'Valkey');
    const row = reserved[name];
    if (redis.hourlyUSD !== hourlyUSD) {
      wrong.push(
        `${name}: on demand ${redis.hourlyUSD} an hour, where the catalogue says ${hourlyUSD}`,
      );
    }
    if (row === undefined) {
      wrong.push(`${name}: no reserved row`);
      continue;
    }
    for (const term of ['oneYear', 'threeYearsUpfront']) {
      if (redis[term] !== row[term])
        wrong.push(`${name}: ${term} is ${redis[term]}, where RESERVED says ${row[term]}`);
    }
    for (const term of ['hourlyUSD', 'oneYear', 'threeYearsUpfront']) {
      if (!near(valkey[term], (1 - VALKEY_DISCOUNT) * redis[term])) {
        wrong.push(
          `${name}: Valkey's ${term} is ${valkey[term]}, not Redis's ${redis[term]} less ${VALKEY_DISCOUNT * 100}%`,
        );
      }
    }
    for (const [engine, prices] of [
      ['Redis', redis],
      ['Valkey', valkey],
    ]) {
      if (prices.threeYearsHourly !== 0) {
        wrong.push(
          `${name}: ${engine}'s three years paid upfront also charges ${prices.threeYearsHourly} an hour`,
        );
      }
    }
  }
  for (const name of Object.keys(reserved)) {
    if (!nodeTypes.some((n) => n.name === name))
      wrong.push(`${name}: a reserved row for no catalogue node`);
  }
  return wrong;
}

/**
 * The version of AWS's price list a catalogue cites, by its `source`: the list the check holds it to. A source that no
 * longer names one throws, since the check would otherwise compare against whichever list it was given.
 */
function citedVersion(source) {
  const version = /price list (\d{14})\b/.exec(source)?.[1];
  if (version === undefined) {
    throw new Error(
      `the catalogue's source names no price list version: ${JSON.stringify(source)}`,
    );
  }
  return version;
}

module.exports = {
  RESERVED,
  VALKEY_DISCOUNT,
  citedVersion,
  disagreements,
  nodePrices,
  nodeProduct,
};
