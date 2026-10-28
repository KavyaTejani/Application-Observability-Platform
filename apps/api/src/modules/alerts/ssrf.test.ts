import { describe, expect, it } from 'vitest';
import { checkWebhookUrl, isBlockedAddress, urlPreview } from './ssrf.js';

const strict = (records: Array<[string, number]>) => ({
  allowPrivateNetworks: false,
  resolve: async () => records.map(([address, family]) => ({ address, family })),
});

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'fc00::1',
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1', // same, hex form
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe', // NAT64 to metadata
  ])('blocks %s', (address) => expect(isBlockedAddress(address)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows public %s',
    (address) => expect(isBlockedAddress(address)).toBe(false),
  );

  it('blocks non-IP strings', () => expect(isBlockedAddress('example.com')).toBe(true));
});

describe('checkWebhookUrl', () => {
  it('accepts a public https URL and returns the pinned address', async () => {
    const result = await checkWebhookUrl(
      'https://hooks.example.com/x',
      strict([['93.184.216.34', 4]]),
    );
    expect(result).toMatchObject({ ok: true, address: '93.184.216.34', family: 4 });
  });

  it.each([
    ['ftp://example.com/x', /http and https/],
    ['file:///etc/passwd', /http and https/],
    ['gopher://example.com', /http and https/],
    ['https://user:pass@example.com/', /credentials/],
    ['not a url', /valid URL/],
    ['http://localhost:4000/hook', /private/],
    ['http://api.localhost/hook', /private/],
  ])('rejects %s', async (url, reason) => {
    const result = await checkWebhookUrl(url, strict([['93.184.216.34', 4]]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });

  it.each([
    'http://127.0.0.1:27017/',
    'http://[::1]:6379/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5:9464/telemetry-metrics',
    'http://[::ffff:127.0.0.1]/',
  ])('rejects IP-literal internal target %s', async (url) => {
    expect((await checkWebhookUrl(url, strict([]))).ok).toBe(false);
  });

  it('rejects a public-looking hostname that resolves to a private address (DNS-based SSRF)', async () => {
    const result = await checkWebhookUrl('https://evil.example/', strict([['10.0.0.7', 4]]));
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects when ANY of several resolved addresses is private', async () => {
    const result = await checkWebhookUrl(
      'https://mixed.example/',
      strict([
        ['93.184.216.34', 4],
        ['127.0.0.1', 4],
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects unresolvable hosts', async () => {
    const result = await checkWebhookUrl('https://nx.example/', {
      allowPrivateNetworks: false,
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/resolved/) });
  });

  it('never echoes internal addresses in the reason', async () => {
    const result = await checkWebhookUrl('https://evil.example/', strict([['10.9.8.7', 4]]));
    expect(JSON.stringify(result)).not.toContain('10.9.8.7');
  });

  it('allows private targets only when explicitly permitted (development)', async () => {
    const dev = {
      allowPrivateNetworks: true,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    };
    expect((await checkWebhookUrl('http://localhost:5050/hook', dev)).ok).toBe(true);
  });
});

describe('urlPreview', () => {
  it('hides path tokens', () => {
    expect(urlPreview('https://hooks.slack.com/services/T000/B000/SECRET')).toBe(
      'https://hooks.slack.com/…',
    );
    expect(urlPreview('https://example.com/')).toBe('https://example.com/');
  });
});
