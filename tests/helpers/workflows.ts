/**
 * The repository's GitHub Actions configuration, read from disk: every workflow, every composite action, and the
 * `package.json` scripts a step can run. The CI tests sweep what exists rather than a list someone keeps, so a new
 * workflow, action or script is checked the day it lands.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  shell?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  /** A step that may fail without failing its job. */
  'continue-on-error'?: boolean | string;
}

export interface Job {
  /** A job that calls a reusable workflow names it here, and has no steps of its own. */
  uses?: string;
  steps?: Step[];
  services?: unknown;
  container?: unknown;
  strategy?: { matrix?: unknown };
}

/** A file under the root, parsed as YAML. */
export function readYaml<T>(rel: string): T {
  return parse(readFileSync(join(ROOT, rel), 'utf8')) as T;
}

/** Every workflow file, relative to the root. */
export function workflowFiles(): string[] {
  return readdirSync(join(ROOT, '.github/workflows'))
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => `.github/workflows/${f}`);
}

/** Whether a path, with either separator, is an action's metadata file. */
export function isActionFile(path: string): boolean {
  return /(?:^|\/)action\.ya?ml$/.test(path.replace(/\\/g, '/'));
}

/** Every composite action's metadata file, at any depth under `.github/actions`, relative to the root. */
export function compositeActionFiles(): string[] {
  const dir = join(ROOT, '.github/actions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((f) => f.replace(/\\/g, '/'))
    .filter(isActionFile)
    .sort()
    .map((f) => `.github/actions/${f}`);
}

/** Every job of every workflow, and each composite action as a job of its own, since its steps run in a job. */
export function jobs(): { where: string; job: Job }[] {
  return [
    ...workflowFiles().flatMap((file) =>
      Object.entries(readYaml<{ jobs?: Record<string, Job> }>(file).jobs ?? {}).map(
        ([name, job]) => ({
          where: `${file} › ${name}`,
          job,
        }),
      ),
    ),
    ...compositeActionFiles().map((file) => ({
      where: file,
      job: { steps: readYaml<{ runs?: { steps?: Step[] } }>(file).runs?.steps ?? [] },
    })),
  ];
}

/** The root `package.json`'s scripts. */
export function packageScripts(): Record<string, string> {
  return (
    (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      }
    ).scripts ?? {}
  );
}
