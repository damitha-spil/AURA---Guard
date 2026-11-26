---
name: qa-swagger-api
description: Design and execute Swagger/OpenAPI contract and endpoint tests (positive, negative, boundary, status codes, headers, schema drift) strictly against configured local or test environments.
---

# QA: Swagger / OpenAPI Endpoint & Contract Testing

Verify backend HTTP/REST/RPC endpoints against Swagger/OpenAPI specifications without ever hitting production or mutating live ERP records.

## Steps

1. **Locate Specs & Changed Endpoints:** Inspect OpenAPI/Swagger JSON/YAML files and compare them against recent diffs or MCP tool schemas.
2. **Generate Test Matrix per Endpoint:**
   - **Positive:** Valid payloads returning expected `2xx` status, headers, and response schema.
   - **Negative:** Missing required fields, invalid types, unauthorized/unauthenticated calls (`401`/`403`), unknown IDs (`404`).
   - **Boundary:** Empty strings, zero/negative numbers, max length strings, oversized payloads (`413`).
3. **Execute Safely:** Run read-only GETs and isolated test-DB checks only (`127.0.0.1` / `localhost` / configured Cobalt test DB). Never mutate production or ERP write tables.
4. **Verify:** Check status codes, response JSON types, error-message hygiene (no stack traces), and response latency; record readback proof.
