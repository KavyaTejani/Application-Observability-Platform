/**
 * Readiness probes for the private telemetry backends. Both endpoints are documented
 * readiness routes that return 200 only when the service can accept work.
 */
async function expectOk(url: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal });
  // Drain the body so the socket is released back to the pool.
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export const pingPrometheus = (baseUrl: string, signal: AbortSignal) =>
  expectOk(`${baseUrl}/-/ready`, signal);

export const pingLoki = (baseUrl: string, signal: AbortSignal) =>
  expectOk(`${baseUrl}/ready`, signal);
