---
name: qa-hurl-contracts
description: Author and run plain-text chainable .hurl HTTP capture & assertion contract suites against localhost via api_hurl_runner.
---

# QA: Hurl Chainable HTTP Contract Suites

1. Generate concise `.hurl` suites capturing IDs/tokens from response JSON (`[Captures]`) and chaining them into follow-up requests via `{{varName}}`.
2. Add explicit `[Asserts]` rules verifying HTTP status codes, JSONPath fields, and response body expectations.
3. Execute only against verified `127.0.0.1` / `localhost` endpoints using `api_hurl_runner`.
4. Commit or archive reviewed `.hurl` scripts inside REO's `qa/` suite folder rather than external source repositories.
