import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { checkWebhookUrl, type UrlPolicy } from './ssrf.js';

export const MAX_WEBHOOK_PAYLOAD_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024;

export type WebhookResult =
  | { status: 'success'; responseStatus: number }
  | { status: 'failed'; responseStatus?: number; errorSummary: string; retryable: boolean }
  | { status: 'blocked'; errorSummary: string };

export interface WebhookClientOptions extends UrlPolicy {
  timeoutMs: number;
}

/** Sends webhooks. Abstracted so the notifier can be tested with a fake. */
export interface WebhookSender {
  send(url: string, body: string, headers: Record<string, string>): Promise<WebhookResult>;
}

/**
 * Delivers one webhook with the SSRF policy applied at send time:
 * - the URL is re-validated and re-resolved now (it may have changed since it was saved),
 * - the socket connects to the validated address only (DNS pinning through `lookup`), while TLS
 *   still verifies the certificate against the original hostname,
 * - redirects are never followed (a 3xx is a failed delivery),
 * - total time and response size are bounded; the response body is discarded.
 */
export class WebhookClient implements WebhookSender {
  constructor(private readonly options: WebhookClientOptions) {}

  async send(
    rawUrl: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<WebhookResult> {
    if (Buffer.byteLength(body) > MAX_WEBHOOK_PAYLOAD_BYTES) {
      return { status: 'failed', errorSummary: 'Payload exceeds the size limit', retryable: false };
    }
    const check = await checkWebhookUrl(rawUrl, this.options);
    if (!check.ok) return { status: 'blocked', errorSummary: check.reason };

    const { url, address, family } = check;
    // Connect to the address validated above, whatever DNS says at connection time.
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if ((options as { all?: boolean }).all) {
        (
          callback as unknown as (
            err: null,
            addresses: Array<{ address: string; family: number }>,
          ) => void
        )(null, [{ address, family }]);
      } else {
        callback(null, address, family);
      }
    };

    const transport = url.protocol === 'https:' ? https : http;
    return new Promise<WebhookResult>((resolve) => {
      const req = transport.request(
        url,
        {
          method: 'POST',
          lookup: pinnedLookup,
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
            'User-Agent': 'AOP-Webhooks/1.0',
          },
          timeout: this.options.timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          let received = 0;
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_RESPONSE_BYTES) res.destroy();
          });
          const done = () => {
            if (status >= 200 && status < 300)
              resolve({ status: 'success', responseStatus: status });
            else if (status >= 300 && status < 400)
              resolve({
                status: 'failed',
                responseStatus: status,
                errorSummary: 'Redirects are not followed',
                retryable: false,
              });
            else
              resolve({
                status: 'failed',
                responseStatus: status,
                errorSummary: `Receiver responded with HTTP ${status}`,
                // Retry rate limits and server errors; client errors will not fix themselves.
                retryable: status === 429 || status >= 500 || status === 408,
              });
          };
          res.on('end', done);
          res.on('close', done);
          res.on('error', done);
        },
      );
      // A hard deadline for the whole exchange, not just socket idleness.
      const deadline = setTimeout(() => req.destroy(new Error('timeout')), this.options.timeoutMs);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (error) => {
        clearTimeout(deadline);
        resolve({
          status: 'failed',
          errorSummary: error.message === 'timeout' ? 'Timed out' : 'Connection failed',
          retryable: true,
        });
      });
      req.on('close', () => clearTimeout(deadline));
      req.end(body);
    });
  }
}
