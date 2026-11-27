# QA tool integration research (2026-11-27)

Web research only. Nothing here has been installed or tried. Several sources are
blogs, so check each project's own repository and LICENSE before adopting it.

Risk tiers follow the tool registry: **read** (runs alone), **local** (asks first),
**blocked** (never against shared or production systems).

## Phase 1: .NET test loop

| Tool | What it adds | Tier | Notes |
|---|---|---|---|
| `dotnet test` / `vstest.console` runner | Run xUnit, NUnit, MSTest and parse TRX results into defects | local | Build this first; later tools depend on it. .NET Framework projects may need MSBuild and `vstest.console`. |
| [code-testing-generator](https://devops.com/microsofts-new-testing-agent-tackles-the-trust-gap-in-ai-generated-code/) | Microsoft's open-source (MIT) unit-test agent in `dotnet/skills`; checks that tests build and pass | local | Unit tests only. Runs through Copilot. Benchmark figures are Microsoft's own. |
| [NetAI.TestGenerator](https://github.com/emineo-net/NetAI.TestGenerator) | Roslyn analysis plus a local model to write xUnit/NUnit/MSTest tests | local | Small project; review first. |
| [Stryker.NET](https://stryker-mutator.io/docs/stryker-net/technical-reference/introduction) | Mutation testing: shows whether tests catch real faults | local | Supports .NET Framework (needs `nuget.exe`). Good check on AI-written tests. |
| Coverlet + ReportGenerator | Coverage reports | local | .NET Framework 4.8 support not confirmed. |
| [Reqnroll](https://reqnroll.net/news/2025/01/specflow-end-of-life-has-been-announced/) | Given/When/Then test cases; successor to SpecFlow (end of life) | local | Readable cases for QA staff. |

## Phase 2: Windows desktop UI

| Tool | What it adds | Notes |
|---|---|---|
| [FlaUI](https://github.com/FlaUI/FlaUI) | Maintained .NET UI Automation library (MIT) | Best base for C# desktop tests; generate FlaUI test code from recorded steps. |
| [FlaUI-MCP](https://github.com/shanselman/FlaUI-MCP) | MCP server that lets an agent drive Windows apps | Forks exist. [ckir/flauimcp](https://github.com/ckir/flauimcp) is non-commercial only. |
| [WinApp CLI](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/ui-automation) | Microsoft UI Automation commands, can run inside Windows Sandbox | Recent; check versions. |
| WinAppDriver | Avoid | No stable release since 2020. |

## Phase 3: Web UI (Selenium and Playwright)

| Tool | What it adds | Notes |
|---|---|---|
| [Playwright test agents](https://testdino.com/blog/playwright-test-agents) | Planner writes a test plan, generator writes tests, healer repairs them | `npx playwright init-agents`. A person must review healer changes: it can hide a real bug. Playwright is already a dependency. |
| [mcp-selenium](https://mcpservers.org/hi/servers/angiejones/mcp-selenium) | MCP server for Selenium WebDriver | Lets the agent explore pages, then emit Selenium C# tests. The C# generator is ours to build. |
| Selenium.WebDriver C# + page-object templates | Generate and run Selenium tests | Run them through the Phase 1 runner. |
| [Healenium](https://github.com/healenium/healenium) | Self-healing Selenium locators | C# setup not confirmed. [Selenium.SelfHealing](https://github.com/DeliveryAssured/Selenium.SelfHealing) is listed as GPL-3.0. |
| Selenium IDE | Record and replay | Low activity; not a good base. |

## Phase 4: Test environments

| Tool | What it adds | Notes |
|---|---|---|
| [Windows Sandbox `wsb` CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli) | Throwaway Windows machine for UI tests | Windows 11 24H2 or later. Returns exit codes; write results to a shared folder. |
| [Testcontainers + SQL Server](https://startdebugging.net/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) | Disposable test database | Needs Docker with Linux containers. |
| [Respawn](https://the-runtime.dev/articles/respawn-database-reset/) | Fast database reset between tests | Only against a disposable database, never a shared one. |

## Phase 5: API, security, reporting

| Tool | What it adds | Notes |
|---|---|---|
| [Schemathesis](https://dev.tools/blog/best-open-source-api-testing-tools/) | Generates API tests from OpenAPI (MIT) | Extends the current contract runner. Local targets only. |
| k6 | Load tests | AGPL-3.0. Local targets only. |
| Semgrep, gitleaks | Code and secret scanning | Not researched; check licences. |
| Trivy | Dependency scanning | [Compromised in March 2026](https://www.aquasec.com/blog/trivy-supply-chain-attack-what-you-need-to-know/). If used, pin a safe version by hash. |
| [Allure Report](https://allurereport.org/) | HTML test reports (Apache 2.0) | |
| [ReportPortal](https://www.reportportal.io/docs) | Self-hosted result history and analysis | Heavier to run. |

## Licence traps

- [FluentAssertions 8+](https://www.infoq.com/news/2025/01/fluent-assertions-v8-license) is paid for commercial use. Use 7.x or AwesomeAssertions.
- [NBomber 5+](https://nbomber.com/assets/NBOMBER-LICENSE-AGREEMENT-3.0.pdf) is paid for organisations.

## Suggested order

1. .NET test runner with results fed into the defect store.
2. AI test writing with a quality gate: build, pass, then Stryker.NET.
3. FlaUI desktop recorder that generates C# tests.
4. Playwright agents and a Selenium C# generator.
5. Windows Sandbox environments, then reporting.

Each tool needs a registry entry with a tier, an allow-list of targets, and secret
masking on its output before anything reaches a model.
