# SignLoop Chat Service

A standalone, stateless, text-only HTTP extraction of SignLoop's chat-generation pipeline. It exposes a small authenticated API for SignLoop Assistant or bare-LLM conversations, performs Gemini-grounded Google research for every chat turn, and generates a response through a server-configured OpenAI-compatible provider with ordered OpenRouter fallback.

This repository contains no UI, Clerk integration, database, saved threads, uploads, or model selector. The service does not store conversations: callers must send the complete conversation history with every request.

## Architecture

```text
client
  -> Bun.serve HTTP boundary
  -> Bearer authentication + per-process concurrency gate
  -> bounded JSON reader + conversation validation
  -> server-owned personality prompt + authoritative UTC time
  -> one Gemini-grounded Google research pass (required)
  -> primary OpenAI-compatible model
       -> OpenRouter fallbacks in fixed order, when eligible
  -> missing source-link attachment
  -> JSON response or newline-delimited JSON stream
```

The service has two routes:

- `GET /healthz` is an unauthenticated process-liveness check. It does not contact Gemini or a generation provider.
- `POST /v1/chat` is the authenticated chat endpoint. It supports non-streaming JSON and streaming NDJSON responses.

The model and provider URLs are controlled only by server configuration. Clients cannot select an arbitrary model or provider.

## Source provenance

The pipeline was extracted from the immutable SignLoop revision below, rather than from a moving checkout:

- Repository: [omertekin2002/SignLoop](https://github.com/omertekin2002/SignLoop)
- Branch: `main`
- Commit: `5d06ed2630386c4a9af78373ce998d31dbc1f776`
- Pinned tree: [SignLoop at `5d06ed2`](https://github.com/omertekin2002/SignLoop/tree/5d06ed2630386c4a9af78373ce998d31dbc1f776)
- Local source checkout used during extraction: `/Users/omertekin/Desktop/Grind/SignLoop`

See [SOURCE_PROVENANCE.md](./SOURCE_PROVENANCE.md) for the source-to-destination file map and the intentionally excluded application code. No credentials, local environment files, generated files, database configuration, or SignLoop worktree changes were copied.

## Local setup

Bun is pinned to **1.3.11** in `package.json` and the Render Blueprint. Install that exact version with your preferred Bun version manager, then verify it before installing dependencies:

```sh
bun --version
# 1.3.11

bun install --frozen-lockfile
cp .env.example .env
```

Edit `.env` and provide `SERVICE_API_KEY`, `GEMINI_API_KEY`, and at least one generation path. A primary path requires both `PRIMARY_LLM_BASE_URL` and `PRIMARY_LLM_API_KEY`; alternatively, set `OPENROUTER_API_KEY`, or configure both for fallback.

Run the static checks and unit tests, then start the service:

```sh
bun run check-types
bun run test
bun run dev
```

`bun run dev` watches source files. Use `bun run start` for the non-watching production command. By default the server listens on `0.0.0.0:10000`.

After Bun has parsed a request's headers, the listener disables its shorter per-request idle timeout because grounded research can legitimately be quiet before the first response byte. Bun's header-phase transport guard remains active, while the abort-aware `REQUEST_TIMEOUT_MS` limit is authoritative for request bodies and provider work.

## Configuration

Configuration is validated once when the process starts. Secret values belong in the runtime environment and must never be committed.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SERVICE_API_KEY` | Yes | — | Shared secret accepted as the `/v1/chat` Bearer token. Use a long, randomly generated value. |
| `GEMINI_API_KEY` | Yes | — | Authenticates the mandatory Gemini-grounded Google research pass. |
| `GEMINI_SEARCH_MODEL` | No | `gemini-2.5-flash` | Gemini model used for grounded research. |
| `PRIMARY_LLM_BASE_URL` | Conditional | — | HTTP(S) base URL of the primary OpenAI-compatible Responses API. Must be set together with `PRIMARY_LLM_API_KEY`. |
| `PRIMARY_LLM_API_KEY` | Conditional | — | Primary-provider credential. Must be set together with `PRIMARY_LLM_BASE_URL`. |
| `PRIMARY_LLM_MODEL` | No | `gemini-3-flash` | Server-controlled model for the primary provider. It is not accepted from API clients. |
| `OPENROUTER_API_KEY` | Conditional | — | Enables OpenRouter generation and fallback. Required if the primary path is absent. |
| `OPENROUTER_BASE_URL` | No | `https://openrouter.ai/api/v1` | OpenRouter-compatible HTTP(S) base URL. |
| `PUBLIC_SERVICE_URL` | No | `RENDER_EXTERNAL_URL`, then `http://localhost:<PORT>` | Public service identity sent to compatible providers as `HTTP-Referer`. |
| `RENDER_EXTERNAL_URL` | No | — | Render-provided fallback for `PUBLIC_SERVICE_URL`; it is not normally set by hand. |
| `APP_NAME` | No | `SignLoop Chat Service` | Service identity sent to compatible providers as `X-Title`. |
| `PORT` | No | `10000` | Listening port, from `1` through `65535`. Render supplies this in hosted environments. |
| `MAX_CONCURRENT_REQUESTS` | No | `4` | Maximum active inference requests in this process. Excess requests receive `429`. |
| `REQUEST_TIMEOUT_MS` | No | `180000` | Request/provider timeout in milliseconds; maximum `3600000`. |
| `CORS_ALLOWED_ORIGINS` | No | empty (CORS disabled) | Comma-separated explicit HTTP(S) browser origins. Wildcards are rejected. |
| `BUN_VERSION` | Render only | `1.3.11` in `render.yaml` | Selects the Bun runtime used by Render's build and start commands. |
| `NODE_ENV` | Render only | `production` in `render.yaml` | Marks the Blueprint service as a production runtime. |

At least one generation path must be valid at startup. If both paths are configured, the primary is attempted first and OpenRouter is used only as described under [Research and provider fallback](#research-and-provider-fallback).

## Authentication

`POST /v1/chat` requires both headers:

```http
Authorization: Bearer <SERVICE_API_KEY>
Content-Type: application/json
```

Authentication is checked before the body is read or any provider work begins. Missing or invalid credentials return `401`; key comparison is timing-safe. The expected key, authorization header, provider credentials, and provider base URLs are never returned to clients.

CORS is a browser interoperability control, not authentication. Keep the Bearer key secret even when an origin allowlist is enabled.

## Chat request

Every request supplies the complete conversation history:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Explain indemnification clauses."
    }
  ],
  "personality": "signloop-assistant",
  "stream": false
}
```

Request rules:

- `messages` is required and must be a non-empty array.
- Only `user` and `assistant` roles are accepted. Client-supplied `system` messages are rejected.
- The final message must have the `user` role.
- `personality` is optional and defaults to `signloop-assistant`; the other valid value is `bare-llm`.
- `stream` is optional and defaults to `true`.
- A client-controlled model or provider URL is not supported.

### Non-streaming example

```sh
curl --fail-with-body --silent --show-error \
  --request POST "http://localhost:10000/v1/chat" \
  --header "Authorization: Bearer $SERVICE_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{
    "messages": [
      {
        "role": "user",
        "content": "Explain indemnification clauses."
      }
    ],
    "personality": "signloop-assistant",
    "stream": false
  }'
```

Successful response:

```json
{
  "message": "The complete assistant response, with any missing source links attached.",
  "provider": "primary-openai-compatible",
  "model": "configured-model",
  "webSearchQuery": "query used by Gemini",
  "webSearchAttempts": ["query used by Gemini"],
  "webSearchSuccessfulCount": 1,
  "webSources": [
    {
      "title": "Source title",
      "url": "https://example.com/",
      "snippet": "Optional supported claim"
    }
  ]
}
```

`provider` is either `primary-openai-compatible` or `openrouter`; `model` reports the server-selected model that completed the request.

### Streaming example

Use `--no-buffer` so `curl` prints each event as it arrives:

```sh
curl --no-buffer --fail-with-body --silent --show-error \
  --request POST "http://localhost:10000/v1/chat" \
  --header "Authorization: Bearer $SERVICE_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{
    "messages": [
      {
        "role": "user",
        "content": "What changed recently in EU AI regulation?"
      }
    ],
    "personality": "bare-llm",
    "stream": true
  }'
```

The response content type is `application/x-ndjson; charset=utf-8`. Each event is one JSON object followed by exactly one newline:

```json
{"type":"delta","text":"Partial text"}
{"type":"delta","text":" continues."}
{"type":"done","message":"Partial text continues.\n\nSources:\n1. [Source title](<https://example.com/>)","provider":"primary-openai-compatible","model":"configured-model","webSearchQuery":"query used by Gemini","webSearchAttempts":["query used by Gemini"],"webSearchSuccessfulCount":1,"webSources":[{"title":"Source title","url":"https://example.com/","snippet":"Optional supported claim"}]}
```

If a failure occurs after the stream is open, the terminal event is safe and contains no upstream details:

```json
{"type":"error","error":"Chat request failed. Please try again."}
```

**Treat the terminal `done.message` as the canonical complete answer.** Do not persist or display only the concatenated `delta.text` values: source links can be attached after model token streaming has finished and therefore may appear only in `done.message`. Every stream terminates with either `done` or `error`.

## Health check

```sh
curl --fail --silent --show-error http://localhost:10000/healthz
```

```json
{
  "ok": true,
  "service": "signloop-chat-service"
}
```

The health check is intentionally unauthenticated and does not probe upstream providers. A Gemini or LLM outage therefore does not make the process-liveness endpoint fail.

## Research and provider fallback

For each accepted chat request, the service:

1. Prepends the selected, server-owned personality prompt and authoritative current UTC context.
2. Runs exactly one Gemini-grounded Google research pass.
3. Fails closed before generation if Gemini does not return grounded sources.
4. Adds a bounded research brief to the latest user message as untrusted evidence with prompt-injection defenses.
5. Attempts the configured primary model, when present.
6. On an eligible transport/provider failure, tries these OpenRouter models in this exact order:

   1. `google/gemma-4-31b-it:free`
   2. `openai/gpt-oss-120b:free`
   3. `openrouter/free`

7. Attaches any missing grounded source links to the canonical final answer.

Research happens once, outside the provider fallback loop, and the same result is reused verbatim for every generation attempt. The service does not repeat search for each fallback model.

For streaming requests, fallback is allowed only before visible response content has been emitted. After the first `delta`, the service never restarts the answer on another provider; a later failure produces a terminal `error` event instead. This prevents a single response from silently mixing output from multiple models.

## Limits and abuse protection

| Limit | Value |
| --- | ---: |
| Messages per request | 30 |
| Characters per message | 4,000 |
| Total message characters | 60,000 |
| HTTP request body | 128 KiB |
| Generated output tokens | 4,096 |

The body is read incrementally, so chunked transfer encoding cannot bypass the 128 KiB limit. Oversized bodies or histories receive `413`.

The concurrency gate is an in-memory semaphore and therefore applies **per process instance**, not globally. Horizontal scaling multiplies the effective capacity. Before accepting untrusted third-party traffic or enforcing account quotas across instances, put quota/rate enforcement in a shared datastore or API gateway. The service itself intentionally has no datastore.

CORS is disabled by default. When `CORS_ALLOWED_ORIGINS` is set, only those exact origins are allowed; a wildcard is not accepted. CORS does not replace Bearer authentication and does not protect non-browser clients.

## Errors and request IDs

Errors returned before a stream opens use a safe JSON message and an appropriate HTTP status. Streaming requests establish the NDJSON response before grounded research and generation finish, so later failures are represented by a terminal `error` event and the already-sent HTTP status remains `200`.

| Status | Meaning |
| ---: | --- |
| `400` | Malformed JSON, invalid request fields or roles, empty messages, or a non-user final message. |
| `401` | Missing or invalid Bearer credential. |
| `404` | Unknown route. |
| `413` | Request body, message, message count, or history limit exceeded. |
| `415` | Request content type is not `application/json`. |
| `429` | This process has reached `MAX_CONCURRENT_REQUESTS`; inspect `Retry-After` before retrying. |
| `502` | A non-streaming request's Gemini research or all eligible generation providers failed. |
| `504` | Service-level timeout. |
| `500` | Unexpected internal failure. |

An incoming `X-Request-ID` is propagated when safe; otherwise the service generates one. The response request ID can be used to correlate structured logs. Public errors and logs do not include authorization headers, API keys, prompts, research briefs, source snippets, full upstream bodies, provider base URLs, or stack traces.

## Privacy and data handling

The service itself is stateless. It has no database or persistent disk requirement and does not save conversations, messages, threads, user settings, or research results. Request data exists in process memory only for the work needed to serve the request, and callers remain responsible for sending complete history on the next turn.

Stateless does not mean that request content stays on the host:

- Conversation content is transmitted to Gemini for grounded Google research.
- The prepared request, including conversation context and bounded research evidence, is transmitted to the selected primary or OpenRouter generation provider.
- Provider retention, logging, regional processing, and training policies are outside this service's control. Review the policies and account settings of every configured provider before sending sensitive or regulated information.

## Deploy with the Render Blueprint

[`render.yaml`](./render.yaml) defines a Bun web service named `signloop-chat-api`. It pins `BUN_VERSION=1.3.11`, runs dependency installation, type checking, and tests during the build, starts with `bun run start`, and uses `/healthz` as the HTTP health-check path.

To deploy it as a [Render Blueprint](https://render.com/docs/infrastructure-as-code):

1. Push this repository to a Git host and create a new Blueprint in Render from that repository.
2. Review the service generated from `render.yaml`.
3. Enter secret values for the `sync: false` variables in Render. Set `SERVICE_API_KEY` and `GEMINI_API_KEY`, plus a complete primary provider pair, `OPENROUTER_API_KEY`, or both. Do not commit those values.
4. Apply the Blueprint and let Render run the declared build and start commands.
5. Use the assigned external URL for the smoke requests below. Render supplies `PORT`, and the server binds to `0.0.0.0`.

No Render Postgres database, persistent disk, or other storage resource is needed. If configuration changes outside the Blueprint, keep the required and conditional relationships from the environment table intact. See Render's documentation for [environment variables](https://render.com/docs/configure-environment-variables), [web-service port binding](https://render.com/docs/web-services), and [health checks](https://render.com/docs/health-checks).

These are deployment instructions only; this repository does not assert that a Render deployment or live-provider validation has already been completed.

## `curl` smoke check

With a local server running—or after substituting a deployed base URL—set values in the shell and check liveness plus both response modes:

```sh
export CHAT_SERVICE_URL="http://localhost:10000"
export SERVICE_API_KEY="replace-with-the-same-key-configured-on-the-service"

curl --fail --silent --show-error \
  "$CHAT_SERVICE_URL/healthz"

curl --fail-with-body --silent --show-error \
  --request POST "$CHAT_SERVICE_URL/v1/chat" \
  --header "Authorization: Bearer $SERVICE_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{"messages":[{"role":"user","content":"Reply with a one-sentence description of this service."}],"stream":false}'

curl --no-buffer --fail-with-body --silent --show-error \
  --request POST "$CHAT_SERVICE_URL/v1/chat" \
  --header "Authorization: Bearer $SERVICE_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{"messages":[{"role":"user","content":"Reply with a one-sentence description of this service."}],"stream":true}'
```

The chat checks call live external providers and can incur provider usage or cost. They are not part of the normal unit-test suite.

An equivalent automated live smoke test is explicitly opt-in and is skipped by a normal `bun run test` invocation:

```sh
RUN_LIVE_TESTS=1 bun run test -- tests/live.test.ts
```
