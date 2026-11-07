/**
 * An upstream HTTP failure from a search vendor, carrying the status
 * ProviderGuard retries on.
 *
 * Its own file so both vendor clients can throw it without importing each
 * other: SerpApiClient depends on SearchApiClient, and a class import running
 * the other way would be a cycle that leaves one of them undefined at boot.
 */
export class SerpApiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SerpApiHttpError';
  }
}
