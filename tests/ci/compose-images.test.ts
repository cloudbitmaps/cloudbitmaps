import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * No integration service runs a floating image tag.
 *
 * WHY THIS EXISTS. Two of the three services carried an explicit "PINNED (not `:latest`) … bump deliberately"
 * note, each naming the behaviour the pin protects — fake-gcs because 1.52.2 is the version verified to
 * enforce `ifGenerationMatch: 0` on the upload path the driver uses, azurite for its own reasons. MinIO alone
 * floated on `:latest`, so every run pulled whatever shipped that morning.
 *
 * That is the worst kind of red: the integration suite asserts write-once semantics, which is precisely what
 * an object-store release can change, and the failure arrives with nothing in our own diff to point at. The
 * rationale was already written down twice; what was missing was anything that noticed the third service did
 * not follow it.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const compose = parse(readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8')) as {
  services: Record<string, { image?: string }>;
};

const SERVICES = Object.entries(compose.services ?? {});

/** A tag that means "whatever is newest", which is the class of thing being banned. */
const FLOATING = /:(latest|main|master|edge|stable|nightly)$/;

describe('every integration image is pinned', () => {
  it('found the services (an empty sweep would prove nothing)', () => {
    expect(SERVICES.length).toBeGreaterThanOrEqual(3);
  });

  it.each(SERVICES)('%s', (name, service) => {
    const image = service.image ?? '';
    expect(image, `service "${name}" declares no image`).not.toBe('');
    expect(
      FLOATING.test(image),
      `service "${name}" uses the floating tag "${image}". Every run would pull whatever that project ` +
        'shipped that morning, and this suite asserts write-once semantics — exactly what an upstream ' +
        'release can change. Pin a version and say why, as the other services do.',
    ).toBe(false);
    // A bare `image: name` with no tag is `:latest` by another spelling.
    expect(
      image.split('/').pop()?.includes(':'),
      `service "${name}" declares "${image}" with no tag, which Docker resolves as :latest`,
    ).toBe(true);
  });
});
