#!/usr/bin/env node
'use strict';

/*
 * Consumer install: pack the six packages the way a release does, install the tarballs with npm into a clean
 * project, and run code against them, as a user who followed the README would.
 *
 * `scripts/smoke.cjs` loads the built packages from inside the workspace, where pnpm links them, `files` is not
 * consulted and `workspace:*` is never rewritten. This is the other half: it reads only what `pnpm pack` put in
 * a tarball. A file left out of `files`, an `exports` target that resolves only inside the workspace, a
 * dependency in the wrong field, a `workspace:*` left unrewritten, or an install script npm refuses to run
 * shows here as a failed install or a failed import, and nowhere earlier.
 *
 * Where each half runs
 *   host        builds the workspace and runs `pnpm pack` on each package under packages/ (the workspace's pnpm and
 *               its locked dependencies, so `workspace:*` becomes the exact version as at publish), then starts the
 *               container below.
 *   container   `--image <image>`: a throwaway container of an official Node image, with the tarballs and this
 *               script mounted read-only, nothing else mounted, no environment passed in, no capabilities, and no
 *               Docker socket. Everything that runs third-party code happens here: npm installs the tarballs
 *               together with the cloud SDKs, resolved fresh from the registry with no lockfile, and runs their
 *               install scripts, and the programs below run against the result. Code that runs there cannot reach
 *               the runner's files, processes, tokens or caches.
 *   no container `--no-container`: the same second half on this machine, for local use only. It runs third-party
 *               install scripts on the machine with this user's access, and it refuses to run when `CI` is set.
 *
 * What the second half does
 *   1. Creates a temporary project whose package.json allows the `roaring` install script, as the README's
 *      install steps say.
 *   2. `npm install`s all the tarballs together. A failed install is tried again, twice, after a pause: a registry
 *      or binary-download blip is not a packaging fault.
 *   3. Checks the installed tree: no `workspace:` in a packed manifest, one copy of each package, every `exports`
 *      target, `bin` target, `typesVersions` target and `files` entry present, `dist` not empty.
 *   4. Runs a program, once as ESM and once as CommonJS: it imports every entry of every package by name, builds
 *      a store on the in-memory driver and again on the local-files driver, loads ids, and reads them back
 *      (`has`, `count`, an intersect).
 *   5. Runs the installed `export-segments` bin with `--help`.
 * The cloud drivers are imported, never used, so nothing contacts a cloud.
 *
 * What it does not show: that the types compile in a consumer's project (smoke.cjs does that, in the
 * workspace), anything about npm 12 (the `allowScripts` key is written but only npm 12 enforces it), or a pnpm or
 * yarn install.
 *
 * Usage:  node scripts/consumer-install.cjs (--image <image> | --no-container) [--keep]
 *   --image <image>  run the second half in this image, which needs Docker; give it more than once to name
 *                    fallbacks, tried in order when a registry throttles or refuses a pull
 *   --no-container   run it on this machine; local use only
 *   --keep           leave the tarballs (and, with --no-container, the project) behind and print where
 *   --in-container <dir>  the second half itself, over the tarballs in <dir>; what the container runs
 *
 * Needs `pnpm`, `tar` and, for `--image`, `docker` on the PATH, and network access to the npm registry.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep');

/** Pack, install and run budgets, in milliseconds. A run past its budget is killed and fails. The CI job's own limit bounds the whole run. */
const PACK_MS = 4 * 60_000;
const INSTALL_MS = 3 * 60_000;
const RUN_MS = 2 * 60_000;
/** Pauses before the second and third `npm install`, in milliseconds. */
const INSTALL_BACKOFF_MS = [5_000, 15_000];

/** The environment variables a child process may inherit; everything else, tokens included, is dropped. */
const INHERITED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TERM',
  'CI',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/** The value of `--name <value>`, `undefined` when the flag is absent; a flag with no value is an error. */
function option(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) fail(`${name} needs a value`);
  return value;
}

/** Every value of a repeatable `--name <value>`, in order. */
function options(name) {
  const found = [];
  process.argv.forEach((arg, i) => {
    if (arg !== name) return;
    const value = process.argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`${name} needs a value`);
    found.push(value);
  });
  return found;
}

/** The environment of a child process: the allowed variables of this one, then `extra`. */
function childEnv(extra) {
  const env = {};
  for (const name of INHERITED_ENV)
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...extra };
}

/** The dependency whose install script the README tells a consumer to allow. A blocked script shows as an import error. */
const NATIVE_ADDON = 'roaring';

function fail(message) {
  throw new Error(message);
}

/** Run a command; return its output, or throw with the command, status and what it printed. */
function run(cmd, args, options) {
  const { cwd, timeout, env } = options;
  const result = spawnSync(cmd, args, {
    cwd,
    env: childEnv(env),
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error) {
    fail(`${cmd} ${args.join(' ')}: ${result.error.message}\n${out}`);
  }
  if (result.status !== 0) {
    fail(`${cmd} ${args.join(' ')} exited ${result.status}\n${out}`);
  }
  return out;
}

/** Every package directory under packages/ with a manifest, in a stable order. */
function workspacePackages() {
  const dir = path.join(ROOT, 'packages');
  const found = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'package.json')))
    .map((e) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'package.json'), 'utf8'));
      return {
        dir: path.join(dir, e.name),
        name: manifest.name,
        private: manifest.private === true,
      };
    })
    .filter((p) => !p.private)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (found.length === 0) fail('no publishable package under packages/: refusing to pass');
  return found;
}

/** Pack each package into its own folder under `dest`; return the tarball paths. */
function packAll(pkgs, dest) {
  // Each package's `prepack` builds it against the built `core` its siblings import, so core must be built
  // first; a workspace build does that in dependency order.
  console.log('  build the workspace');
  run('pnpm', ['run', 'build'], { cwd: ROOT, timeout: PACK_MS });
  const tarballs = [];
  for (const pkg of pkgs) {
    const out = path.join(dest, pkg.name.replace('/', '__'));
    fs.mkdirSync(out, { recursive: true });
    console.log(`  pack ${pkg.name}`);
    run('pnpm', ['pack', '--pack-destination', out], { cwd: pkg.dir, timeout: PACK_MS });
    const files = fs.readdirSync(out).filter((f) => f.endsWith('.tgz'));
    if (files.length !== 1)
      fail(`${pkg.name}: pnpm pack wrote ${files.length} tarballs, expected 1`);
    tarballs.push(path.join(out, files[0]));
  }
  return tarballs;
}

/** The tarballs in `dir` (searched one level down too), for `--tarballs`. */
function tarballsIn(dir) {
  const found = [];
  const walk = (d, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.tgz')) found.push(path.join(d, e.name));
      else if (e.isDirectory() && depth < 1) walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(dir, 0);
  return found;
}

/** The `package.json` of every installed `@cloudbitmaps/*` package, wherever it sits in node_modules. */
function installedCopies(project, name) {
  const copies = [];
  const walk = (nm) => {
    const direct = path.join(nm, ...name.split('/'), 'package.json');
    if (fs.existsSync(direct)) copies.push(direct);
    for (const e of fs.existsSync(nm) ? fs.readdirSync(nm, { withFileTypes: true }) : []) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('@')) {
        for (const s of fs.readdirSync(path.join(nm, e.name), { withFileTypes: true })) {
          if (s.isDirectory()) walk(path.join(nm, e.name, s.name, 'node_modules'));
        }
      } else {
        walk(path.join(nm, e.name, 'node_modules'));
      }
    }
  };
  walk(path.join(project, 'node_modules'));
  return copies;
}

/** Every file an `exports` map points at, as paths relative to the package. */
function exportTargets(exportsField) {
  const targets = [];
  const visit = (v) => {
    if (typeof v === 'string') targets.push(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(exportsField);
  return targets;
}

/** Every file a `typesVersions` map points at: `{ "*": { "subpath": ["./dist/x.d.ts"] } }`. */
function typesVersionsTargets(typesVersions) {
  const targets = [];
  for (const ranges of Object.values(typesVersions ?? {})) {
    for (const list of Object.values(ranges ?? {})) {
      for (const t of Array.isArray(list) ? list : [list])
        if (typeof t === 'string') targets.push(t);
    }
  }
  return targets;
}

/** The public entry specifiers of a package, by name: `name`, `name/subpath`, one per `exports` key. */
function entrySpecifiers(manifest) {
  return Object.keys(manifest.exports ?? {})
    .filter((key) => key !== './package.json') // JSON needs an import attribute; resolved, not imported
    .map((key) => (key === '.' ? manifest.name : `${manifest.name}/${key.slice(2)}`));
}

/** Checks on the installed tree, before any code runs. Returns the list of problems. */
function checkInstalled(project, pkgs) {
  const problems = [];
  for (const pkg of pkgs) {
    const copies = installedCopies(project, pkg.name);
    if (copies.length !== 1) {
      problems.push(`${pkg.name}: ${copies.length} installed copies, expected exactly 1`);
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(copies[0], 'utf8'));
    const root = path.dirname(copies[0]);
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (String(range).startsWith('workspace:')) {
          problems.push(`${pkg.name}: ${field}.${dep} is "${range}" in the packed manifest`);
        }
      }
    }
    for (const target of exportTargets(manifest.exports)) {
      if (!fs.existsSync(path.join(root, target))) {
        problems.push(`${pkg.name}: exports target ${target} is not in the tarball`);
      }
    }
    for (const bin of Object.values(manifest.bin ?? {})) {
      if (!fs.existsSync(path.join(root, bin))) {
        problems.push(`${pkg.name}: bin ${bin} is not in the tarball`);
      }
    }
    for (const target of typesVersionsTargets(manifest.typesVersions)) {
      if (!fs.existsSync(path.join(root, target))) {
        problems.push(`${pkg.name}: typesVersions target ${target} is not in the tarball`);
      }
    }
    // `pnpm pack` leaves out a `files` entry that is not there, without a word, so a package can ship with no
    // licence or no `dist` and every other check still passes.
    for (const entry of manifest.files ?? []) {
      if (/[*!?[]/.test(entry)) continue; // a pattern, not a name
      const at = path.join(root, entry);
      if (!fs.existsSync(at))
        problems.push(`${pkg.name}: files entry ${entry} is not in the tarball`);
      else if (fs.statSync(at).isDirectory() && fs.readdirSync(at).length === 0)
        problems.push(`${pkg.name}: files entry ${entry} is an empty directory in the tarball`);
    }
  }
  return problems;
}

/** The program run against the installed packages. `mode` is `esm` or `cjs`; the checks are the same. */
function programFor(mode, specifiers, manifests, scratchDir) {
  const esm = mode === 'esm';
  const load = esm
    ? (s) => `await import(${JSON.stringify(s)})`
    : (s) => `require(${JSON.stringify(s)})`;
  const lines = [];
  if (!esm) {
    lines.push("const { createRequire } = require('node:module');");
    lines.push("const assert = require('node:assert/strict');");
    lines.push('(async () => {');
  } else {
    lines.push("import assert from 'node:assert/strict';");
  }
  lines.push('const entries = {};');
  for (const name of manifests) {
    const resolve = esm ? 'import.meta.resolve' : 'require.resolve';
    lines.push(
      `assert.ok(${resolve}(${JSON.stringify(name + '/package.json')}), 'cannot resolve ${name}/package.json');`,
    );
  }
  for (const s of specifiers) lines.push(`entries[${JSON.stringify(s)}] = ${load(s)};`);
  lines.push(`for (const [name, mod] of Object.entries(entries)) {`);
  lines.push(`  assert.ok(Object.keys(mod).length > 0, name + ' exports nothing');`);
  lines.push('}');
  const roaring = '@cloudbitmaps/roaring';
  lines.push(
    `const { CloudRoaring, MemoryStorage, LocalFsStorage } = entries[${JSON.stringify(roaring)}];`,
  );
  lines.push('async function exercise(storage, label) {');
  lines.push('  const store = new CloudRoaring({ storage });');
  lines.push("  await store.load({ segment: 'shoppers' }, [5, 99_999, 1_234_567_890]);");
  lines.push("  await store.load({ segment: 'active' }, [5, 7, 1_234_567_890]);");
  lines.push("  const shoppers = store.segment('shoppers');");
  lines.push("  assert.equal(await shoppers.has(99_999), true, label + ': has(99999)');");
  lines.push("  assert.equal(await shoppers.has(6), false, label + ': has(6)');");
  lines.push("  assert.equal(await shoppers.count(), 3, label + ': count');");
  lines.push('  const both = [];');
  lines.push(
    "  for await (const id of shoppers.intersect([store.segment('active')])) both.push(id);",
  );
  lines.push("  assert.deepEqual(both, [5, 1_234_567_890], label + ': intersect');");
  lines.push('}');
  lines.push("await exercise(new MemoryStorage(), 'memory');");
  lines.push(`await exercise(new LocalFsStorage(${JSON.stringify(scratchDir)}), 'local files');`);
  lines.push(
    `console.log('${mode}: ' + Object.keys(entries).length + ' entries imported; store checks passed');`,
  );
  if (!esm) {
    lines.push('})().catch((e) => { console.error(e); process.exit(1); });');
  }
  const body = lines.join('\n') + '\n';
  // `createRequire` is only needed to keep the CJS file honest about resolving from its own location.
  return esm ? body : body.replace("const { createRequire } = require('node:module');\n", '');
}

/** Run one stage; a failure names it, so a registry blip and a packaging fault read differently. */
function stage(name, fn) {
  try {
    return fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

/** Sleep without a timer, which `spawnSync` of `sleep` would need a binary for. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `npm install` the tarballs, trying again after a pause when it fails, and say so in the log. */
function installWithRetry(tarballs, project, env) {
  for (let attempt = 1; ; attempt++) {
    try {
      run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], {
        cwd: project,
        timeout: INSTALL_MS,
        env,
      });
      return;
    } catch (error) {
      const wait = INSTALL_BACKOFF_MS[attempt - 1];
      if (wait === undefined) throw error;
      console.log(
        `  npm install failed (attempt ${attempt} of ${INSTALL_BACKOFF_MS.length + 1}); trying again in ${wait / 1000}s:\n${String(error.message).split('\n').slice(0, 6).join('\n')}`,
      );
      pause(wait);
    }
  }
}

/** The package name of a tarball, read from the manifest inside it. */
function packageNameOf(tarball) {
  const manifest = run('tar', ['-xOzf', tarball, 'package/package.json'], {
    cwd: path.dirname(tarball),
    timeout: RUN_MS,
  });
  return JSON.parse(manifest).name;
}

/** The arguments of the `docker run` that does the second half: what is mounted, and what is not. */
function dockerRunArgs({ image, name, tarballDir, scriptFile }) {
  return [
    'run',
    '--rm',
    '--name',
    name,
    // Nothing from the host is passed in: no `-e`, no `--env-file`, no home or workspace mount, no socket.
    '--user',
    'node',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '1024',
    '--read-only',
    '--tmpfs',
    '/tmp:exec,mode=1777,size=2g',
    '--tmpfs',
    '/home/node:exec,uid=1000,gid=1000,size=1g',
    '-v',
    `${tarballDir}:/w/tarballs:ro`,
    '-v',
    `${scriptFile}:/w/consumer-install.cjs:ro`,
    '--entrypoint',
    'node',
    image,
    '/w/consumer-install.cjs',
    '--in-container',
    '/w/tarballs',
  ];
}

/**
 * Pull the first of `images` that can be had, so that one registry's throttle or quota does not fail the run: each
 * is tried twice, after a short pause, and the one that comes down is the one that runs. Returns it.
 */
function pullFirst(images) {
  const errors = [];
  for (const image of images) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        run('docker', ['pull', image], { cwd: ROOT, timeout: INSTALL_MS });
        return image;
      } catch (error) {
        errors.push(`${image}: ${String(error.message).split('\n').slice(0, 3).join(' ')}`);
        console.log(`  docker pull of ${image} failed (attempt ${attempt} of 2)`);
        if (attempt === 1) pause(INSTALL_BACKOFF_MS[0]);
      }
    }
  }
  fail(`no image could be pulled:\n  ${errors.join('\n  ')}`);
}

/** Refuse the no-container mode where a runner holds a token: it runs registry code on the host. */
function refuseLocalModeInCi(env) {
  if (env.CI !== undefined && env.CI !== '' && env.CI !== 'false') {
    fail(
      '--no-container runs third-party install scripts on this machine and is for local use only; ' +
        'CI sets CI, so use --image',
    );
  }
}

/** The second half: install the tarballs in `tarballDir` into a clean project and run code against them. */
function installAndRun(tarballDir, keep) {
  const tarballs = tarballsIn(tarballDir);
  if (tarballs.length === 0) fail(`no tarballs in ${tarballDir}`);
  const pkgs = tarballs
    .map((t) => ({ name: packageNameOf(t) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-install-'));
  const cleanup = () => {
    if (!keep) fs.rmSync(work, { recursive: true, force: true });
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      cleanup();
      process.exit(130);
    });
  }
  try {
    console.log(`consumer-install: ${pkgs.length} package(s), working in ${work}`);
    const project = path.join(work, 'project');
    fs.mkdirSync(project);
    // What the README tells a user to put in package.json before installing. npm 12 skips a dependency's
    // install script unless this allows it; npm 10 and 11 ignore the key or warn.
    fs.writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify(
        {
          name: 'consumer-project',
          version: '0.0.0',
          private: true,
          allowScripts: { [NATIVE_ADDON]: true },
        },
        null,
        2,
      ),
    );
    // A user-level npmrc must not change what is being tested, and nothing here may reach a private registry.
    const emptyRc = path.join(work, 'empty.npmrc');
    fs.writeFileSync(emptyRc, '');
    const npmEnv = { npm_config_userconfig: emptyRc, npm_config_update_notifier: 'false' };
    const npmOut = (...args) =>
      run('npm', args, { cwd: project, timeout: RUN_MS, env: npmEnv }).trim();
    console.log(
      `  node ${process.version}, npm ${npmOut('--version')}, userconfig ${path.basename(npmOut('config', 'get', 'userconfig'))}: install`,
    );
    stage('install', () => installWithRetry(tarballs, project, npmEnv));

    stage('check', () => {
      const problems = checkInstalled(project, pkgs);
      if (problems.length > 0) fail(`the installed tree is wrong:\n  ${problems.join('\n  ')}`);
    });
    console.log('  installed tree: one copy of each package, every declared file present');

    const specifiers = pkgs.flatMap((pkg) => {
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(project, 'node_modules', ...pkg.name.split('/'), 'package.json'),
          'utf8',
        ),
      );
      return entrySpecifiers(manifest);
    });
    const scratch = path.join(work, 'local-files');
    fs.mkdirSync(scratch);
    stage('run', () => {
      for (const mode of ['esm', 'cjs']) {
        const file = path.join(project, mode === 'esm' ? 'check.mjs' : 'check.cjs');
        fs.writeFileSync(
          file,
          programFor(
            mode,
            specifiers,
            pkgs.map((p) => p.name),
            path.join(scratch, mode),
          ),
        );
        fs.mkdirSync(path.join(scratch, mode));
        process.stdout.write(
          `  ${run('node', [file], { cwd: project, timeout: RUN_MS, env: {} })}`,
        );
      }

      const bin = path.join(project, 'node_modules', '.bin', 'export-segments');
      if (!fs.existsSync(bin))
        fail('npm did not link the export-segments bin into node_modules/.bin');
      const help = run(bin, ['--help'], { cwd: project, timeout: RUN_MS, env: {} });
      if (!/export-segments/.test(help)) fail(`export-segments --help printed no usage:\n${help}`);
      console.log('  export-segments --help ran');
    });
    console.log(
      'consumer-install: the packed packages install and run as a consumer would use them',
    );
  } finally {
    if (keep) console.log(`consumer-install: left ${work}`);
    else cleanup();
  }
}

function main() {
  const inContainer = option('--in-container');
  if (inContainer !== undefined) return installAndRun(inContainer, false);
  const images = options('--image');
  const local = process.argv.includes('--no-container');
  if ((images.length === 0) === !local)
    fail('give --image <image> (one or more), or --no-container, not both');
  if (local) refuseLocalModeInCi(process.env);

  const pkgs = workspacePackages();
  // Under the checkout and not the system temp folder: Docker Desktop shares the user's folders with the
  // container and not /var/folders. Ignored by git.
  const work = fs.mkdtempSync(path.join(ROOT, '.consumer-install-tmp-'));
  const name = `consumer-install-${process.pid}`;
  const cleanup = () => {
    if (!local) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    if (!KEEP) fs.rmSync(work, { recursive: true, force: true });
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      cleanup();
      process.exit(130);
    });
  }
  try {
    const tarballs = stage('pack', () => packAll(pkgs, path.join(work, 'tarballs')));
    if (tarballs.length !== pkgs.length) {
      fail(`[pack] expected ${pkgs.length} tarballs, found ${tarballs.length}`);
    }
    if (local) {
      installAndRun(path.join(work, 'tarballs'), KEEP);
      return;
    }
    const image = stage('pull', () => pullFirst(images));
    console.log(`  install and run inside ${image}`);
    const args = dockerRunArgs({
      image,
      name,
      tarballDir: path.join(work, 'tarballs'),
      scriptFile: __filename,
    });
    // Streamed, not captured: the container's output is the log.
    const result = spawnSync('docker', args, {
      cwd: ROOT,
      env: childEnv({}),
      stdio: 'inherit',
      timeout: 15 * 60_000,
    });
    if (result.status !== 0)
      fail(`[container] docker run exited ${result.status ?? result.error?.message}`);
  } finally {
    if (KEEP) console.log(`consumer-install: left ${work}`);
    cleanup();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\nconsumer-install: FAILED\n${error.message}`);
    process.exit(1);
  }
} else {
  module.exports = {
    checkInstalled,
    entrySpecifiers,
    exportTargets,
    typesVersionsTargets,
    childEnv,
    dockerRunArgs,
    refuseLocalModeInCi,
  };
}
