---
name: qa-api-fuzzing
description: Property-based OpenAPI endpoint fuzzing via api_schemathesis_fuzz (Schemathesis pattern) strictly on localhost to uncover HTTP 5xx and schema drift.
---

# QA: Schemathesis OpenAPI Property Fuzzing

1. Supply a verified `127.0.0.1` / `localhost` `baseUrl` and OpenAPI 3.x / Swagger 2.0 spec text.
2. Call `api_schemathesis_fuzz` to fuzz safe `GET`/`HEAD` endpoints with boundary integers (`-1`, overflow), null-byte Unicode, and type-confusion arrays.
3. Enforce two core invariants: zero unhandled `5xx` server crashes (`not_a_server_error`) and valid `application/json` payloads (`content_type_conformance`).
4. Report every failing endpoint + minimal reproducing fuzz vector to `Defects`.
