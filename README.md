# AlphaSim backend

Node.js 22 API and worker for the AlphaSim IDE. The backend uses Express, MongoDB/Mongoose, Redis/BullMQ, Socket.IO, Zod, Argon2, Pino, and an optional Anthropic integration. All API routes use `/api/v1`; errors use `{ error: { code, message, details? } }`.

## Local development

```sh
cp .env.example .env
openssl rand -base64 32  # use separate output for ENCRYPTION_KEY and both JWT secrets
docker compose up --build
```

The compose stack starts MongoDB, Redis, the API on port 4000, the worker, and an isolated mock BRAIN service on port 4011. Set the generated secrets in `.env` before starting. To run without Docker, start MongoDB/Redis, then run `npm run dev` for the API and local mock BRAIN service together; start `npm run dev:worker` in a separate terminal if you need simulations.

The mock provider uses clearly marked fixture metrics (`source: "mock"`) for local integration work. These values are not AlphaSim estimates and must never be presented as BRAIN results. `NODE_ENV=production` rejects mock mode and development secrets.

## Implemented API

- Auth: `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`
- Account: `GET|PATCH|DELETE /users/me`
- BRAIN connection: `POST /brain/connect`, `GET /brain/status`, `DELETE /brain/disconnect`
- Alpha library: `GET|POST /alphas`, `GET|PATCH|DELETE /alphas/:id`, draft autosave, immutable versions, restore, filters, folder counts
- Folders: `GET|POST|PATCH|DELETE /folders`
- Simulations: create/queue, history, status/results, retry, cancellation, comparison, raw GridFS result access
- Experiments: bounded parameter sweeps with literal and settings variants
- Editor support: `POST /lint`, `GET /datafields`, `GET /operators`
- Forge AI: streamed chat, generate, explain, fix, improve, and suggestion outcome recording
- Realtime events: authenticated Socket.IO rooms by user, Redis event forwarding
- Operations: `/healthz`, `/readyz`; optional Bull Board and queue metrics protected by `OPS_ADMIN_TOKEN`

Auth uses Argon2id passwords, short-lived access JWTs, hashed rotating refresh tokens in an httpOnly cookie, rate limits, and user-scoped data queries. Raw provider payloads are stored in GridFS; the UI result contains a downsampled chart series. Soft-deleted alphas are purged after 30 days by the worker.

## BRAIN integration boundary

The local mock implements the same asynchronous shape used by the worker. The official provider is deliberately unavailable: the referenced document says BRAIN endpoints are based on community clients and still need confirmation. WorldQuant's [Terms and Conditions](https://www.worldquant.com/terms-and-conditions/) prohibit automatic or unauthorized login and scraping. The backend therefore does not submit credentials to BRAIN or call undocumented endpoints. `BRAIN_MODE=official` fails closed with `BRAIN_ADAPTER_UNAVAILABLE` until an authorized API contract and permitted automation path are supplied. The BRAIN module is isolated so an approved provider can be added without changing simulations or UI routes.

The mock provider exposes a clearly labelled fixture catalog. It is cached per user on connect and refreshed every six hours while the mock connection is active, so catalog search and linting work in local development. Built-in editor operator signatures are a starter catalog. No catalog is fetched from official BRAIN while its authorized API contract remains unconfirmed.

## Forge AI

Set `OPENROUTER_API_KEY` in `backend/.env` to enable Forge AI. The default `AI_MODEL=openrouter/free` lets OpenRouter route each request to an available free model; you can set `AI_MODEL` to a specific OpenRouter model ID instead. Create a key in your OpenRouter account and never put it in frontend code or commit it. Free model availability, rate limits, and provider data policies vary; review the selected model's current terms before sending private alpha expressions. Only the active expression/settings, selected run summary, matching field/operator docs, and user chat history are sent. Prompts live under `src/prompts`. AI suggestions are linted, recorded by prompt hash/token use, labelled advisory, and never enqueue simulations.

## Checks

```sh
npm ci
npm run lint
npm test
npm run test:integration
npm audit --audit-level=high
```

Vitest includes parser/encryption/version-hash and mock-adapter unit coverage plus a MongoDB-memory-server route test proving cross-user alpha and catalog isolation. The integration suite needs a local MongoDB child process and runs separately so it works in CI environments that allow ephemeral ports.

## Key environment settings

See `.env.example`. All values are validated at startup. Production must use distinct random JWT secrets and a newly generated 32-byte base64 encryption key, HTTPS, an explicit `CLIENT_ORIGIN`, a non-mock BRAIN mode, and secret-manager values rather than repository files. `OPS_ADMIN_TOKEN` enables the queue dashboard and metrics endpoint.
