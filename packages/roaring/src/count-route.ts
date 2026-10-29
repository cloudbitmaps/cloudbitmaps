/**
 * How the four cardinalities and `intersects` of `RoaringBitmap` are answered: from the containers, with the count
 * kernels (`true`), or by building the combination and counting it (`false`). Both routes give the same answers and
 * change no operand; only the cost differs. `isSubset` and `isEqual` always use their kernels.
 *
 * `true` because the count bench's record (`bench/count-kernels-results.json`) has the count's median below the build's
 * on every data set it judges. One switch, so a measurement that finds the build-then-count route cheaper changes this
 * line and nothing else.
 */
export const COUNT_BY_KERNELS = true;
