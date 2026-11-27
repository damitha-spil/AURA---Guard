# QA tools: summary and suggested order

This comes from web research only; none of these tools has been installed or tried.
The full list with notes and links is in [qa-tool-research.md](qa-tool-research.md).

## Tools worth adding

| Order | What you get | Tools |
|---|---|---|
| 1 | Run C# tests and turn failures into defects | `dotnet test`, `vstest.console` |
| 2 | Write unit tests automatically and check their quality | Microsoft's code-testing-generator, Stryker.NET |
| 3 | Test a Windows desktop app and create C# tests | FlaUI, FlaUI-MCP |
| 4 | Create and run web tests | Playwright test agents, mcp-selenium, Selenium C# |
| 5 | Create temporary test environments | Windows Sandbox, Testcontainers, Respawn |
| 6 | API tests and reports | Schemathesis, Allure, ReportPortal |

We'd still need to build the part that turns what mcp-selenium does into Selenium C# tests.

## Be careful with

- **Paid licences:** FluentAssertions 8 and later needs one for commercial use, and NBomber 5 and later for use by organisations.
- **Old tools:** avoid WinAppDriver.
- **Security:** Trivy had malicious releases in March 2026.
- **Self-repairing tests:** review Playwright's fixes, because they can hide a real bug.

## Suggested next step

Start with the C# test runner, since generated tests need a way to run.

## Sources

- [FlaUI-MCP](https://github.com/shanselman/FlaUI-MCP)
- [Microsoft's test agent](https://devops.com/microsofts-new-testing-agent-tackles-the-trust-gap-in-ai-generated-code/)
- [Stryker.NET](https://stryker-mutator.io/docs/stryker-net/technical-reference/introduction)
- [Playwright agents](https://testdino.com/blog/playwright-test-agents)
- [mcp-selenium](https://mcpservers.org/hi/servers/angiejones/mcp-selenium)
- [Windows Sandbox CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli)
- [FluentAssertions licence](https://www.infoq.com/news/2025/01/fluent-assertions-v8-license)
- [NBomber licence](https://nbomber.com/assets/NBOMBER-LICENSE-AGREEMENT-3.0.pdf)
- [Trivy incident](https://www.aquasec.com/blog/trivy-supply-chain-attack-what-you-need-to-know/)
