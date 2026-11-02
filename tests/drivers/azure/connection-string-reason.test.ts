import { BlobServiceClient } from '@azure/storage-blob';
import { AzureBlobStorage } from '@cloudbitmaps/azure-blob';
import { isValidationError } from '@/core/errors';

const KEY = 'S3cretAccountKeyValue0123456789abcdefg==';
const SAS = 'sv=2022-11-02&sig=TopSecretSignature123%3D';
const PLAIN = 'is not a valid Azure Storage connection string';

/** What `new AzureBlobStorage` throws when the SDK's parser throws `sdkMessage` for `connectionString`. */
function refused(connectionString: string, sdkMessage: string): string {
  const spy = vi.spyOn(BlobServiceClient, 'fromConnectionString').mockImplementation(() => {
    throw new Error(sdkMessage);
  });
  try {
    new AzureBlobStorage({ connectionString, container: 'c' });
  } catch (err) {
    expect(isValidationError(err)).toBe(true);
    return (err as Error).message;
  } finally {
    spy.mockRestore();
  }
  throw new Error('expected a refusal');
}

describe('a refused connection string never quotes a part of itself', () => {
  it('leaves out an SDK reason that quotes the account key', () => {
    const msg = refused(`AccountName=acct;AccountKey=${KEY}`, `bad key ${KEY}`);
    expect(msg).not.toContain(KEY);
    expect(msg).not.toContain('S3cretAccountKey');
    expect(msg).toContain(PLAIN);
  });

  it('leaves out an SDK reason that quotes a shared access signature', () => {
    const msg = refused(
      `BlobEndpoint=https://acct.blob.core.windows.net;SharedAccessSignature=${SAS}`,
      `bad sas ${SAS}`,
    );
    expect(msg).not.toContain('TopSecretSignature');
    expect(msg).not.toContain(SAS);
  });

  it('never contains any value of the string', () => {
    const msg = refused(`AccountName=acct;AccountKey=${KEY}`, 'cannot use acct');
    expect(msg).not.toContain('acct');
    expect(msg).not.toContain('cannot use');
  });

  it('gives the plain message for a valid-shaped string the SDK rejects', () => {
    const msg = refused(`AccountName=acct;AccountKey=${KEY}`, 'Invalid Account Key');
    expect(msg).toMatch(new RegExp(`${PLAIN}$`));
  });
});
