/*
 * The store with a choice of Roaring codec, for the benches that compare the TypeScript codec with the native one
 * (`bench/ts-codec-engine.cjs`, and `bench/calibrate-aws.cjs` when `CR_CALIBRATE_CODEC` names a codec).
 *
 * The store package's codec switch is internal: no built entry exports it, and the TypeScript codec is not in any
 * built entry, so a bench cannot flip an installed package. This module bundles the sources of the packages it needs
 * (the roaring facade, and the S3 driver when asked) into one CommonJS module with esbuild, so the facade, the switch
 * and the codecs are one copy of each, and returns the exports with the switch in hand. Core is resolved to its source
 * through the roaring package's `tsconfig.json` `paths`, so it is inlined once and shared by every package in the
 * bundle. The native addon and the cloud SDK stay external and are loaded from the install that holds them.
 *
 * Bench only: nothing under `packages/*` reads an environment variable or exposes the switch for this.
 */
'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

/** The two codec names a harness may ask for. */
const CODECS = ['native', 'typescript'];

/**
 * The bundled engine: `{ roaring, s3?, setFlagshipCodec, roaringCodec, tsRoaringCodec }`, where `roaring` is the
 * roaring package's namespace and `s3` the S3 driver's. `root` is the checkout (or a copy of its `packages/` and
 * `tsconfig*.json`); `withS3` adds the S3 driver, whose SDK must then be installed beside `root`.
 */
function bundleEngine({ root, withS3 = false }) {
  const entry = [
    `export * as roaring from './src/index';`,
    withS3 ? `export * as s3 from '../s3/src/index';` : '',
    `export { setFlagshipCodec } from './src/roaring-codec';`,
    `export { roaringCodec } from ${JSON.stringify(path.join(root, 'tests/helpers/native-codec'))};`,
    `export { tsRoaringCodec } from './src/ts-roaring/bitmap';`,
  ].join('\n');
  const text = bundleText({ root, entry, sourcefile: 'codec-engine-entry.ts' });
  const engine = evaluate(text, root);
  // The text the engine runs from, which the calibration harness reads the engine's constants out of.
  Object.defineProperty(engine, 'bundleText', { value: text, enumerable: false });
  return engine;
}

/**
 * One esbuild bundle of the roaring package's sources, as CommonJS text: `entry` is the TypeScript the bundle exports
 * (resolved from `packages/roaring`), the native addon and the cloud SDK stay external. The one place the options live,
 * for the engine and for the single-codec modules the start-up figures load.
 */
function bundleText({ root, entry, sourcefile }) {
  const { buildSync } = require('esbuild');
  const rr = path.join(root, 'packages/roaring');
  const out = buildSync({
    stdin: { contents: entry, resolveDir: rr, sourcefile, loader: 'ts' },
    tsconfig: path.join(rr, 'tsconfig.json'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    packages: 'external',
    write: false,
    logLevel: 'error',
  });
  return out.outputFiles[0].text;
}

/** Runs a bundle's text with a `require` that finds the native addon and the SDK wherever the install put them. */
function evaluate(text, root) {
  const bases = [
    path.join(root, 'packages/roaring/package.json'),
    path.join(root, 'packages/s3/package.json'),
    path.join(root, 'package.json'),
  ].map((file) => createRequire(file));
  const req = (name) => {
    let first;
    for (const base of bases) {
      try {
        return base(name);
      } catch (err) {
        first ??= err;
      }
    }
    throw first;
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', text)(req, mod, mod.exports);
  return mod.exports;
}

/** The engine with the switch set to `codec` (`native` or `typescript`); stores built afterwards use it. */
function engineWith(codec, options) {
  if (!CODECS.includes(codec)) {
    throw new Error(`codec must be one of ${CODECS.join(', ')}, not ${JSON.stringify(codec)}`);
  }
  const engine = bundleEngine(options);
  engine.setFlagshipCodec(codec === 'typescript' ? engine.tsRoaringCodec : engine.roaringCodec);
  return engine;
}

let shared;
/**
 * A package's exports for a calibration harness: the installed published package when `CR_CALIBRATE_CODEC` is unset
 * (`name` is `roaring` or `s3`), and otherwise the same package from one bundle of this checkout's sources with the
 * codec named by the variable, shared by everything in the process that asks.
 */
async function packageFor(name, root) {
  const codec = (process.env.CR_CALIBRATE_CODEC ?? '').trim();
  if (codec === '') {
    return name === 's3' ? import('@cloudbitmaps/s3') : import('@cloudbitmaps/roaring');
  }
  shared ??= engineWith(codec, { root, withS3: true });
  return shared[name];
}

/**
 * The text the harness's stores run from, as `{ core, s3 }` for the engine-constant check: the bundle's own text when
 * `CR_CALIBRATE_CODEC` names a codec (core and the S3 driver are inlined in it), and `null` when it is unset, where the
 * installed packages' entry files are the text.
 */
function bundledSources(root) {
  const codec = (process.env.CR_CALIBRATE_CODEC ?? '').trim();
  if (codec === '') return null;
  shared ??= engineWith(codec, { root, withS3: true });
  return { core: shared.bundleText, s3: shared.bundleText };
}

module.exports = {
  CODECS,
  bundleEngine,
  bundleText,
  bundledSources,
  engineWith,
  evaluate,
  packageFor,
};
