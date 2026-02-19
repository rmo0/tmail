# tmail

Client for temporary Gmail via [emailnator](https://www.emailnator.com/). Generates an inbox, lists messages, and returns raw HTML body. Parsing (e.g. extracting auth codes) is up to the consumer.

## What it does

- Generate one temporary Gmail-style address
- List received messages
- Get a message body (HTML string)
- Wait until a message from a given sender arrives

## Requirements

- Node.js 16+

## Install

```bash
npm install tmail
```

With yarn:

```bash
yarn add tmail
```

## Usage

```js
const createClient = require('tmail');

const client = createClient({
  proxyUrl: process.env.PROXY_URL || null,
  tokenCachePath: './token-cache.json',
});

const email = await client.generateEmail();

const msg = await client.waitForMessage({
  expectedFrom: 'no-reply@example.com',
  timeout: 30000,
});
if (!msg) throw new Error('timeout');

const html = await client.getMessageBody(msg.messageID);
```

Options for `createClient`: `proxyUrl`, `tokenCachePath`, `logger` (`{ info, warn, error, debug }`), `timeout`, `maxRetries`, `retryDelay`.  
Methods: `generateEmail()`, `listMessages()`, `getMessageBody(messageID)`, `waitForMessage({ expectedFrom, timeout, pollInterval, maxAttempts })`, `reset()`, `clearTokenCache()`.  
Errors are `TmailError` with `code` and `statusCode`.

## License

MIT
