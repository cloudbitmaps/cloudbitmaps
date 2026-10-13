import { defined as azure } from '@/azure-blob/defined';
import { defined as gcs } from '@/gcs/defined';
import { defined as s3 } from '@/s3/defined';

describe.each([
  ['S3', s3],
  ['GCS', gcs],
  ['Azure Blob', azure],
])('%s: defined() passes on only the options that were given', (_, defined) => {
  it('drops undefined entries and keeps every other value, falsy ones included', () => {
    expect(defined({ a: undefined, b: 0, c: '', d: false, e: null, f: 'x' })).toEqual({
      b: 0,
      c: '',
      d: false,
      e: null,
      f: 'x',
    });
  });

  it('leaves the key absent, so a spread adds no property', () => {
    expect('a' in { ...defined({ a: undefined }) }).toBe(false);
  });
});
