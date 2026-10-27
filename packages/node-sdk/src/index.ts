export { ObservabilityClient, createClient } from './client.js';
export type {
  Logger,
  LogMethod,
  Middleware,
  MiddlewareRequest,
  MiddlewareResponse,
} from './client.js';
export { currentRequestId } from './context.js';
export { SdkError } from './types.js';
export type {
  Attributes,
  ClientOptions,
  ClientStats,
  ConnectionTestResult,
  Environment,
  Severity,
} from './types.js';
