# tmail

Temporary Gmail client via [emailnator](https://www.emailnator.com/). Generates an inbox, lists messages, and returns raw HTML. Use your own parser (e.g. cheerio) to extract auth codes or links.

## Features

- Generate a temporary Gmail-style address
- List received messages
- Get message body (HTML string)
- Wait for a message from a specific sender

## Requirements

Node.js 18+

## Install

```bash
npm install @rmo0/tmail
```

## Usage

```js
const createClient = require('@rmo0/tmail');

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

## API

### createClient(options)

| Option | Type | Description |
|--------|------|-------------|
| `proxyUrl` | `string \| null` | HTTP/HTTPS proxy URL |
| `tokenCachePath` | `string` | File path to cache token |
| `logger` | `{ info?, warn?, error?, debug? }` | Optional logger |
| `timeout` | `number` | Request timeout (ms) |
| `maxRetries` | `number` | Retry count on failure |
| `retryDelay` | `number` | Delay between retries (ms) |

### Client methods

- `generateEmail()` → `Promise<string>`
- `listMessages()` → `Promise<Message[]>`
- `getMessageBody(messageID)` → `Promise<string>`
- `waitForMessage({ expectedFrom?, timeout?, pollInterval?, maxAttempts? })` → `Promise<Message | null>`
- `reset()` → `void`
- `clearTokenCache()` → `void`

### Errors

Errors are `TmailError` with `code` and `statusCode`.

### TypeScript

Export types: `TmailError`, `ClientOptions`, `Message`, `WaitForMessageOptions`, `Logger`, `ClientState`, `TmailClient`.

## License

MIT
