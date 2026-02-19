/**
 * tmail – emailnator-based temporary inbox client.
 * Provides: generateEmail(), listMessages(), getMessageBody(messageID), waitForMessage(options).
 * Parsing (e.g. extract auth code from HTML) is left to the consumer.
 */
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

const DEFAULT_DOMAIN = 'https://www.emailnator.com';
const TOKEN_EXPIRY_MS = 30 * 60 * 1000;
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

class TmailError extends Error {
  constructor(message, code, statusCode = null) {
    super(message);
    this.name = 'TmailError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

class RequestQueue {
  constructor(maxConcurrent = 2, delayMs = 100) {
    this.queue = [];
    this.running = 0;
    this.maxConcurrent = maxConcurrent;
    this.delayMs = delayMs;
  }

  async add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return;
    this.running++;
    const { fn, resolve, reject } = this.queue.shift();
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

/**
 * @param {object} [options]
 * @param {string} [options.domain]
 * @param {string} [options.proxyUrl]
 * @param {string} [options.token] – pre-set XSRF token
 * @param {string} [options.cookie] – pre-set cookie
 * @param {string} [options.tokenCachePath] – optional file path to cache token (JSON with token, cookie, timestamp)
 * @param {object} [options.logger] – { info, warn, error, debug } (optional)
 * @param {number} [options.timeout]
 * @param {number} [options.maxRetries]
 * @param {number} [options.retryDelay]
 */
function createClient(options = {}) {
  const domain = options.domain || DEFAULT_DOMAIN;
  const proxyUrl = options.proxyUrl || null;
  const logger = options.logger || null;
  const tokenCachePath = options.tokenCachePath || null;

  let token = options.token || null;
  let cookie = options.cookie || null;
  let email = null;
  let memoryCache = null;
  let tokenFetchPromise = null;

  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
  const timeout = options.timeout ?? (proxyUrl ? 45000 : 30000);
  const maxRetries = options.maxRetries ?? 2;
  const retryDelay = options.retryDelay ?? (proxyUrl ? 15000 : 10000);
  const queue = new RequestQueue(2, 100);

  function log(level, msg) {
    if (logger && typeof logger[level] === 'function') logger[level](msg);
  }

  function loadCachedToken() {
    if (!tokenCachePath) return null;
    try {
      const fs = require('fs');
      if (!fs.existsSync(tokenCachePath)) return null;
      const data = JSON.parse(fs.readFileSync(tokenCachePath, 'utf8'));
      if (Date.now() < data.timestamp + TOKEN_EXPIRY_MS) {
        return { token: data.token, cookie: data.cookie };
      }
    } catch (_) {}
    return null;
  }

  function saveCachedToken(t, c) {
    if (!tokenCachePath) return;
    try {
      const fs = require('fs');
      fs.writeFileSync(
        tokenCachePath,
        JSON.stringify({ token: t, cookie: c, timestamp: Date.now() }, null, 2),
        'utf8'
      );
    } catch (_) {}
  }

  function clearTokenCache() {
    memoryCache = null;
    if (tokenCachePath) {
      try {
        require('fs').unlinkSync(tokenCachePath);
      } catch (_) {}
    }
  }

  async function fetchTokenFresh() {
    const url = `${domain}/`;
    const opts = {
      method: 'GET',
      headers: {
        'User-Agent': pickUserAgent(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      timeout,
    };
    if (agent) opts.agent = agent;

    const res = await fetch(url, opts);
    if (!res.ok) throw new TmailError(`Token fetch failed: HTTP ${res.status}`, 'TOKEN_FAILED', res.status);

    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) throw new TmailError('No set-cookie in token response', 'TOKEN_FAILED');

    const cookies = {};
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

  async function ensureCredentials() {
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
      memoryCache = { token, cookie, timestamp: Date.now() };
      saveCachedToken(token, cookie);
      return;
    }
    tokenFetchPromise = fetchTokenFresh();
    try {
      const fresh = await tokenFetchPromise;
      token = fresh.token;
      cookie = fresh.cookie;
      memoryCache = { token, cookie, timestamp: Date.now() };
      saveCachedToken(token, cookie);
      log('info', 'Credentials obtained');
    } finally {
      tokenFetchPromise = null;
    }
  }

  async function refreshCredentials() {
    clearTokenCache();
    const fresh = await fetchTokenFresh();
    token = fresh.token;
    cookie = fresh.cookie;
    memoryCache = { token, cookie, timestamp: Date.now() };
    saveCachedToken(token, cookie);
    log('info', 'Credentials refreshed');
  }

  function createFetchOptions(method, headers, body) {
    const opt = { method, headers, body, timeout };
    if (agent) opt.agent = agent;
    return opt;
  }

  async function makeRequest(url, opts, retryCount = 0) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 403 && retryCount === 0) {
        log('warn', 'HTTP 403, refreshing credentials and retrying');
        await refreshCredentials();
        const h = { ...opts.headers };
        if (h['x-xsrf-token']) h['x-xsrf-token'] = token;
        if (h['cookie']) h['cookie'] = cookie;
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
        log('warn', `Request failed (${retryCount + 1}/${maxRetries}), retrying: ${e.message}`);
        await delay(retryDelay);
        return makeRequest(url, opts, retryCount + 1);
      }
      throw new TmailError(`Request failed: ${e.message}`, 'REQUEST_FAILED');
    }
  }

  const client = {
    /**
     * Generate a temporary Gmail-style address. Uses emailnator dotGmail + googleMail.
     * @returns {Promise<string>} The new email address.
     */
    async generateEmail() {
      await ensureCredentials();
      return queue.add(async () => {
        const url = `${domain}/generate-email`;
        const headers = {
          'x-xsrf-token': token,
          cookie,
          'content-type': 'application/json, text/plain, */*',
        };
        const body = JSON.stringify({ email: ['dotGmail', 'googleMail'] });
        const res = await makeRequest(url, createFetchOptions('POST', headers, body));
        const data = await res.json();
        if (!data.email || !Array.isArray(data.email) || data.email.length === 0) {
          throw new TmailError('Invalid response: no email in body', 'INVALID_RESPONSE');
        }
        email = data.email[0];
        log('info', `Email obtained: ${email}`);
        return email;
      });
    },

    /**
     * List messages for the current inbox (must have called generateEmail first).
     * @returns {Promise<Array<{ from: string, messageID: string, subject?: string }>>}
     */
    async listMessages() {
      if (!email) throw new TmailError('Generate an email first', 'EMAIL_NOT_SET');
      await ensureCredentials();
      return queue.add(async () => {
        const url = `${domain}/message-list`;
        const headers = {
          'x-xsrf-token': token,
          cookie,
          'content-type': 'application/json, text/plain, */*',
        };
        const body = JSON.stringify({ email });
        const res = await makeRequest(url, createFetchOptions('POST', headers, body));
        const data = await res.json();
        const list = data.messageData || [];
        return list.map((m) => ({
          from: m.from,
          messageID: m.messageID,
          subject: m.subject,
        }));
      });
    },

    /**
     * Get raw HTML body for a message. Consumer can parse (e.g. cheerio) to extract codes/links.
     * @param {string} messageID
     * @returns {Promise<string>} Raw HTML string.
     */
    async getMessageBody(messageID) {
      if (!email) throw new TmailError('Generate an email first', 'EMAIL_NOT_SET');
      if (!messageID) throw new TmailError('messageID required', 'MESSAGE_ID_NOT_SET');
      await ensureCredentials();
      return queue.add(async () => {
        const url = `${domain}/message-list`;
        const headers = {
          'x-xsrf-token': token,
          cookie,
          'content-type': 'application/json, text/plain, */*',
        };
        const body = JSON.stringify({ email, messageID });
        const res = await makeRequest(url, createFetchOptions('POST', headers, body));
        return res.text();
      });
    },

    /**
     * Poll until a message from expectedFrom appears or timeout. Returns the matching message info or null.
     * @param {object} [opts]
     * @param {string} [opts.expectedFrom]
     * @param {number} [opts.timeout]
     * @param {number} [opts.pollInterval]
     * @param {number} [opts.maxAttempts]
     * @returns {Promise<{ from: string, messageID: string } | null>}
     */
    async waitForMessage(opts = {}) {
      const expectedFrom = opts.expectedFrom || null;
      const timeoutMs = opts.timeout ?? timeout;
      const pollInterval = opts.pollInterval ?? retryDelay;
      const maxAttempts = opts.maxAttempts ?? Math.max(1, Math.floor(timeoutMs / pollInterval));

      const deadline = Date.now() + timeoutMs;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const list = await this.listMessages();
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

    /** Reset inbox state (email / messageID). Does not clear token/cookie. */
    reset() {
      email = null;
    },

    /** Clear token cache and force fresh credentials on next use. */
    clearTokenCache,

    getState() {
      return {
        email,
        hasCredentials: !!(token && cookie),
      };
    },
  };

  return client;
}

module.exports = createClient;
module.exports.TmailError = TmailError;
