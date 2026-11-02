import { BlobServiceClient } from '@azure/storage-blob';
import { AzureBlobStorage } from '@cloudbitmaps/azure-blob';
import { isValidationError } from '@/core/errors';

const KEY = 'S3cretAccountKeyValue0123456789abcdefg==';
const SAS = 'sv=2022-11-02&sig=TopSecretSignature123%3D';

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
  it('drops an SDK reason that quotes only the account key', () => {
    const msg = refused(`AccountName=acct;AccountKey=${KEY}`, `bad key ${KEY}`);
    expect(msg).not.toContain(KEY);
    expect(msg).not.toContain('S3cretAccountKey');
    expect(msg).toContain('is not a valid Azure Storage connection string');
  });

  it('drops an SDK reason that quotes only a shared access signature', () => {
    const msg = refused(
      `BlobEndpoint=https://acct.blob.core.windows.net;SharedAccessSignature=${SAS}`,
      `bad sas ${SAS}`,
    );
    expect(msg).not.toContain('TopSecretSignature');
    expect(msg).not.toContain(SAS);
  });

  it('drops a reason that quotes the whole string', () => {
    const cs = `AccountName=acct;AccountKey=${KEY}`;
    expect(refused(cs, `cannot parse ${cs}`)).not.toContain(KEY);
  });

  it('names the parts a string lacks, without a value', () => {
    const msg = refused('AccountName=acct', 'cannot use acct');
    expect(msg).toContain('AccountKey');
    expect(msg).toContain('SharedAccessSignature');
  });

  it('still shows a reason that quotes nothing', () => {
    const msg = refused(`AccountName=acct;AccountKey=${KEY}`, 'Invalid Account Key');
    expect(msg).toContain('(Invalid Account Key)');
  });
});
