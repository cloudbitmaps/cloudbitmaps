/**
 * `@cloudbitmaps/tools` — offline tools for CloudBitmaps that need nothing internal from a store.
 *
 * The cost model: {@link estimateCost} prices a store you plan, from the segment sizes and the workload you give it,
 * and {@link groundedReport} one you run, from the bytes it stores, which a segment handle's `stat()` reports as
 * `sizeBytes`. Each report compares the store's monthly cost on object storage with an always-on Redis, and says where
 * Redis wins. It is a planning tool: the price lists here are as old as the release that ships them, so pass your
 * own for your region, your cloud or a committed term.
 *
 * Nothing here reads or writes a store. It takes `ValidationError` from `@cloudbitmaps/core`'s public entry, so a
 * caller classifies the model's refusals as it does the library's.
 */
export {
  estimateCost,
  groundedReport,
  AWS_US_EAST_1_ONDEMAND,
  ELASTICACHE_REDIS_US_EAST_1_ONDEMAND,
  ONE_REDIS_HA_CLUSTER,
} from './cost';
export type {
  PricingProfile,
  RedisNodeType,
  RedisSizing,
  CostReport,
  Workload,
  SegmentSizing,
  EstimateInput,
} from './cost';
