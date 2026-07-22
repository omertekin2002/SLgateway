# Source provenance

This service was extracted on **2026-07-22** from the following immutable SignLoop revision:

- Local source checkout: `/Users/omertekin/Desktop/Grind/SignLoop`
- GitHub repository: <https://github.com/omertekin2002/SignLoop>
- Source commit: `5d06ed2630386c4a9af78373ce998d31dbc1f776`
- Pinned tree: <https://github.com/omertekin2002/SignLoop/tree/5d06ed2630386c4a9af78373ce998d31dbc1f776>

Every source file was read from that commit. No generated files, local environment files, credentials, uploads, database configuration, or build output were copied.

## Adapted files

| SignLoop source | Standalone destination | Adaptation |
| --- | --- | --- |
| `apps/web/lib/chat.ts` | `src/pipeline/chat.ts` | Retains UTC context, one-pass grounded research, generation, fallback, and streaming; accepts explicit runtime configuration and dependencies. |
| `apps/web/lib/llm-client.ts` | `src/pipeline/llm-client.ts` | Retains OpenAI-compatible client validation and ordered primary/OpenRouter fallback; removes ambient application configuration. |
| `apps/web/lib/gemini-search.ts` | `src/pipeline/gemini-search.ts` | Retains grounded Google research, source validation, bounded evidence, and prompt-injection defenses; accepts an explicit API key/model and abort signal. |
| `apps/web/lib/chat-policy.ts` | `src/pipeline/chat-policy.ts` | Retains message/history/body limits, validation, incremental JSON parsing, and inline generated-image compaction. |
| `apps/web/lib/chat-time.ts` | `src/pipeline/chat-time.ts` | Retains authoritative current UTC date/time context. |
| `apps/web/lib/personality-settings.ts` | `src/pipeline/personality.ts` | Retains the two supported personality identifiers and default. |
| `apps/web/app/api/chat/route.ts` | `src/prompts.ts`, `src/handler.ts` | Retains server-owned prompts, source-link attachment, safe errors, NDJSON events, and response metadata; replaces Next/Clerk/database behavior with service-key HTTP handling. |
| `apps/web/lib/utils.ts` | `src/utils.ts` | Extracts only `isRecord` and `getErrorMessage`, avoiding UI dependencies. |
| `apps/web/lib/chat.test.ts` | `tests/chat.test.ts` | Ports UTC, one-search, evidence reuse, fail-closed, delta, and streaming fallback coverage using injected providers. |
| `apps/web/lib/chat-policy.test.ts` | `tests/chat-policy.test.ts` | Ports request/history limit, role validation, bounded-reader, and inline-image compaction coverage. |
| `apps/web/lib/gemini-search.test.ts` | `tests/gemini-search.test.ts` | Ports grounded-response parsing, evidence safety, failure, timeout, cancellation, and redaction coverage. |
| `apps/web/lib/llm-client.test.ts` | `tests/llm-client.test.ts` | Ports provider URL, response extraction, provider configuration, abort, and fallback-order coverage. |

`src/config.ts`, `src/auth.ts`, `src/server.ts`, the standalone parts of `src/handler.ts`, and their HTTP/configuration tests are new service-specific code rather than copied application infrastructure.

The Next.js and React UI, Clerk authentication, Postgres persistence, saved threads, model settings UI, contracts/projects/uploads, image generation, Vercel Blob, and all runtime database bootstrapping were intentionally excluded. The SignLoop source worktree was not modified during extraction.
