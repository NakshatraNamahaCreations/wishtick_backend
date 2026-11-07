import { envValidationSchema } from './env.validation';

/** The product search vendor: each one needs its own key, or the boot fails. */
describe('env validation — product search vendor', () => {
  const base = {
    MONGO_URI: 'mongodb://localhost:27017',
    MONGO_DB_NAME: 'wishtick_test',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    PRODUCT_PROVIDER: 'serpapi',
  };

  const check = (env: Record<string, string>) =>
    envValidationSchema.validate({ ...base, ...env }, { allowUnknown: true }).error?.message ??
    'OK';

  it('SearchApi without its key refuses to boot', () => {
    expect(check({ PRODUCT_SEARCH_VENDOR: 'searchapi', SERPAPI_KEY: 'serp' })).toBe(
      'PRODUCT_SEARCH_VENDOR=searchapi requires SEARCHAPI_KEY',
    );
  });

  it('SearchApi with its key boots, and needs no SerpApi key', () => {
    expect(check({ PRODUCT_SEARCH_VENDOR: 'searchapi', SEARCHAPI_KEY: 'key' })).toBe('OK');
  });

  it('SerpApi stays the default, and still needs its own key', () => {
    expect(check({ SERPAPI_KEY: 'serp' })).toBe('OK');
    expect(check({})).toBe('PRODUCT_PROVIDER=serpapi requires SERPAPI_KEY');
  });

  it('no other vendor is accepted', () => {
    expect(check({ PRODUCT_SEARCH_VENDOR: 'bing', SERPAPI_KEY: 'serp' })).toMatch(
      /PRODUCT_SEARCH_VENDOR/,
    );
  });
});
