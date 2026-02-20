/**
 * tmail – emailnator-based temporary inbox client.
 * Provides: generateEmail(), listMessages(), getMessageBody(messageID), waitForMessage(options).
 * Parsing (e.g. extract auth code from HTML) is left to the consumer.
 *
 * Requires Node.js 18+ (native fetch / undici).
 */
import { fetch, ProxyAgent } from 'undici';
import * as fs from 'fs';

type FetchOptions = Parameters<typeof fetch>[1];

const DEFAULT_DOMAIN = 'https://www.emailnator.com';
const TOKEN_EXPIRY_MS = 30 * 60 * 1000;
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

export interface Logger {
  info?(msg: string): void;
  warn?(msg: string): void;
  error?(msg: string): void;
  debug?(msg: string): void;
}

export interface ClientOptions {
  domain?: string;
  proxyUrl?: string;
  token?: string;
  cookie?: string;
  tokenCachePath?: string;
  logger?: Logger;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
}

export interface Message {
  from: string;
  messageID: string;
  subject?: string;
}

export interface WaitForMessageOptions {
  expectedFrom?: string;
  timeout?: number;
  pollInterval?: number;
  maxAttempts?: number;
}

export interface ClientState {
  email: string | null;
  hasCredentials: boolean;
}

export class TmailError extends Error {
  override name = 'TmailError';
  constructor(
    message: string,
    public code: string,
    public statusCode: number | null = null
  ) {
    super(message);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

interface QueueTask<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

class RequestQueue {
  private queue: QueueTask<unknown>[] = [];
  private running = 0;

  constructor(
    private maxConcurrent = 2,
    private delayMs = 100
  ) {}

  add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.process();
    });
  }

  private async process(): Promise<void> {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return;
    this.running++;
    const { fn, resolve, reject } = this.queue.shift()!;
    try {
      const result = await fn();
      resolve(result);
    } catch (e) {
      reject(e);
    } finally {
      this.running--;
      if (this.delayMs > 0) await delay(this.delayMs);
      this.process();
    }
  }
}

export interface TmailClient {
  generateEmail(): Promise<string>;
  listMessages(): Promise<Message[]>;
  getMessageBody(messageID: string): Promise<string>;
  waitForMessage(opts?: WaitForMessageOptions): Promise<Message | null>;
  reset(): void;
  clearTokenCache(): void;
  getState(): ClientState;
}

interface CachedToken {
  token: string;
  cookie: string;
  timestamp: number;
}

export function createClient(options: ClientOptions = {}): TmailClient {
  const domain = options.domain ?? DEFAULT_DOMAIN;
  const proxyUrl = options.proxyUrl ?? null;
  const logger = options.logger ?? null;
  const tokenCachePath = options.tokenCachePath ?? null;

  let token: string | null = options.token ?? null;
  let cookie: string | null = options.cookie ?? null;
  let email: string | null = null;
  let memoryCache: CachedToken | null = null;
  let tokenFetchPromise: Promise<{ token: string; cookie: string }> | null = null;

  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  const timeout = options.timeout ?? (proxyUrl ? 45000 : 30000);
  const maxRetries = options.maxRetries ?? 2;
  const retryDelay = options.retryDelay ?? (proxyUrl ? 15000 : 10000);
  const queue = new RequestQueue(2, 100);

  function log(level: keyof Logger, msg: string): void {
    if (logger && typeof logger[level] === 'function') (logger[level] as (m: string) => void)(msg);
  }

  function loadCachedToken(): { token: string; cookie: string } | null {
    if (!tokenCachePath) return null;
    try {
      if (!fs.existsSync(tokenCachePath)) return null;
      const data = JSON.parse(fs.readFileSync(tokenCachePath, 'utf8')) as CachedToken & { timestamp: number };
      if (Date.now() < data.timestamp + TOKEN_EXPIRY_MS) {
        return { token: data.token, cookie: data.cookie };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function saveCachedToken(t: string, c: string): void {
    if (!tokenCachePath) return;
    try {
      fs.writeFileSync(
        tokenCachePath,
        JSON.stringify({ token: t, cookie: c, timestamp: Date.now() }, null, 2),
        'utf8'
      );
    } catch {
      /* ignore */
    }
  }

  function clearTokenCache(): void {
    memoryCache = null;
    if (tokenCachePath) {
      try {
        fs.unlinkSync(tokenCachePath);
      } catch {
        /* ignore */
      }
    }
  }

  async function fetchWithTimeout(url: string, opts: Omit<FetchOptions, 'signal'>): Promise<Awaited<ReturnType<typeof fetch>>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function fetchTokenFresh(): Promise<{ token: string; cookie: string }> {
    const url = `${domain}/`;
    const opts: FetchOptions = {
      method: 'GET',
      headers: {
        'User-Agent': pickUserAgent(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      dispatcher,
    };

    const res = await fetchWithTimeout(url, opts);
    if (!res.ok)
      throw new TmailError(`Token fetch failed: HTTP ${res.status}`, 'TOKEN_FAILED', res.status);

    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) throw new TmailError('No set-cookie in token response', 'TOKEN_FAILED');

    const cookies: Record<string, string> = {};
    setCookie.split(',').forEach((part) => {
      const [nameVal] = part.split(';');
      const [name, value] = nameVal.trim().split('=');
      if (name && value) cookies[name] = value;
    });
    const xsrf = cookies['XSRF-TOKEN'];
    if (!xsrf) throw new TmailError('No XSRF-TOKEN in response', 'TOKEN_FAILED');
    const t = xsrf.substring(0, 339) + '=';
    const c = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    return { token: t, cookie: c };
  }

  async function ensureCredentials(): Promise<void> {
    if (token && cookie) return;

    if (memoryCache && Date.now() < memoryCache.timestamp + TOKEN_EXPIRY_MS) {
      token = memoryCache.token;
      cookie = memoryCache.cookie;
      return;
    }
    const cached = loadCachedToken();
    if (cached) {
      token = cached.token;
      cookie = cached.cookie;
      memoryCache = { ...cached, timestamp: Date.now() };
      return;
    }
    if (tokenFetchPromise) {
      const fresh = await tokenFetchPromise;
      token = fresh.token;
      cookie = fresh.cookie;
      memoryCache = { token: fresh.token, cookie: fresh.cookie, timestamp: Date.now() };
      saveCachedToken(token, cookie);
      return;
    }
    tokenFetchPromise = fetchTokenFresh();
    try {
      const fresh = await tokenFetchPromise;
      token = fresh.token;
      cookie = fresh.cookie;
      memoryCache = { token: fresh.token, cookie: fresh.cookie, timestamp: Date.now() };
      saveCachedToken(token, cookie);
      log('info', 'Credentials obtained');
    } finally {
      tokenFetchPromise = null;
    }
  }

  async function refreshCredentials(): Promise<void> {
    clearTokenCache();
    const fresh = await fetchTokenFresh();
    token = fresh.token;
    cookie = fresh.cookie;
    memoryCache = { token: fresh.token, cookie: fresh.cookie, timestamp: Date.now() };
    saveCachedToken(token, cookie);
    log('info', 'Credentials refreshed');
  }

  interface RequestOpts {
    method: string;
    headers: Record<string, string>;
    body: string;
    dispatcher?: ProxyAgent;
  }

  function createFetchOptions(
    method: string,
    headers: Record<string, string>,
    body: string
  ): RequestOpts {
    return {
      method,
      headers,
      body,
      dispatcher,
    };
  }

  async function makeRequest(
    url: string,
    opts: RequestOpts,
    retryCount = 0
  ): Promise<Awaited<ReturnType<typeof fetch>>> {
    try {
      const res = await fetchWithTimeout(url, opts);
      if (res.status === 403 && retryCount === 0) {
        log('warn', 'HTTP 403, refreshing credentials and retrying');
        await refreshCredentials();
        const h = { ...opts.headers };
        if (h['x-xsrf-token']) h['x-xsrf-token'] = token!;
        if (h['cookie']) h['cookie'] = cookie!;
        return makeRequest(url, { ...opts, headers: h }, retryCount + 1);
      }
      if (res.status === 419) {
        throw new TmailError('Invalid or expired XSRF/cookie', 'INVALID_CREDENTIALS', 419);
      }
      if (!res.ok) {
        throw new TmailError(`HTTP ${res.status}: ${res.statusText}`, 'HTTP_ERROR', res.status);
      }
      return res;
    } catch (e) {
      if (e instanceof TmailError) throw e;
      if (retryCount < maxRetries) {
        log('warn', `Request failed (${retryCount + 1}/${maxRetries}), retrying: ${(e as Error).message}`);
        await delay(retryDelay);
        return makeRequest(url, opts, retryCount + 1);
      }
      throw new TmailError(`Request failed: ${(e as Error).message}`, 'REQUEST_FAILED');
    }
  }

  const client: TmailClient = {
    async generateEmail(): Promise<string> {
      await ensureCredentials();
      return queue.add(async () => {
        const url = `${domain}/generate-email`;
        const headers: Record<string, string> = {
          'x-xsrf-token': token!,
          cookie: cookie!,
          'content-type': 'application/json, text/plain, */*',
        };
        const body = JSON.stringify({ email: ['dotGmail', 'googleMail'] });
        const res = await makeRequest(url, createFetchOptions('POST', headers, body));
        const data = (await res.json()) as { email?: string[] };
        if (!data.email || !Array.isArray(data.email) || data.email.length === 0) {
          throw new TmailError('Invalid response: no email in body', 'INVALID_RESPONSE');
        }
        email = data.email[0];
        log('info', `Email obtained: ${email}`);
        return email;
      });
    },

    async listMessages(): Promise<Message[]> {
      if (!email) throw new TmailError('Generate an email first', 'EMAIL_NOT_SET');
      await ensureCredentials();
      return queue.add(async () => {
        const url = `${domain}/message-list`;
        const headers: Record<string, string> = {
          'x-xsrf-token': token!,
          cookie: cookie!,
          'content-type': 'application/json, text/plain, */*',
        };
        const body = JSON.stringify({ email });
        const res = await makeRequest(url, createFetchOptions('POST', headers, body));
        const data = (await res.json()) as { messageData?: Array<{ from: string; messageID: string; subject?: string }> };
        const list = data.messageData ?? [];
        return list.map((m) => ({
          from: m.from,
          messageID: m.messageID,
          subject: m.subject,
        }));
      });
    },

    async getMessageBody(messageID: string): Promise<string> {
      if (!email) throw new TmailError('Generate an email first', 'EMAIL_NOT_SET');
      if (!messageID) throw new TmailError('messageID required', 'MESSAGE_ID_NOT_SET');
      await ensureCredentials();
      return queue.add(async () => {
        const url = `${domain}/message-list`;
        const headers: Record<string, string> = {
          'x-xsrf-token': token!,
          cookie: cookie!,
          'content-type': 'application/json, text/plain, */*',
        };
        const body = JSON.stringify({ email, messageID });
        const res = await makeRequest(url, createFetchOptions('POST', headers, body));
        return res.text();
      });
    },

    async waitForMessage(opts: WaitForMessageOptions = {}): Promise<Message | null> {
      const expectedFrom = opts.expectedFrom ?? null;
      const timeoutMs = opts.timeout ?? timeout;
      const pollInterval = opts.pollInterval ?? retryDelay;
      const maxAttempts = opts.maxAttempts ?? Math.max(1, Math.floor(timeoutMs / pollInterval));

      const deadline = Date.now() + timeoutMs;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const list = await client.listMessages();
        for (const msg of list) {
          if (!expectedFrom || msg.from === expectedFrom) {
            return { from: msg.from, messageID: msg.messageID };
          }
        }
        if (Date.now() >= deadline) break;
        await delay(pollInterval);
      }
      return null;
    },

    reset(): void {
      email = null;
    },

    clearTokenCache,

    getState(): ClientState {
      return {
        email,
        hasCredentials: !!(token && cookie),
      };
    },
  };

  return client;
}
