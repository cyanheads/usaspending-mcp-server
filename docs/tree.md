# usaspending-mcp-server - Directory Structure

Generated on: 2026-09-20 14:01:08

```text
usaspending-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   └── tools/
│   │       └── definitions/
│   │           ├── autocomplete-filters.tool.ts
│   │           ├── disaster-spending.tool.ts
│   │           ├── filters.ts
│   │           ├── formatting.ts
│   │           ├── get-agency.tool.ts
│   │           ├── get-award-federal-accounts.tool.ts
│   │           ├── get-award-subawards.tool.ts
│   │           ├── get-award-transactions.tool.ts
│   │           ├── get-award.tool.ts
│   │           ├── get-federal-account-breakdown.tool.ts
│   │           ├── get-federal-account.tool.ts
│   │           ├── get-idv-awards.tool.ts
│   │           ├── get-recipient.tool.ts
│   │           ├── index.ts
│   │           ├── list-agencies.tool.ts
│   │           ├── pagination.ts
│   │           ├── search-awards.tool.ts
│   │           ├── search-federal-accounts.tool.ts
│   │           ├── search-recipients.tool.ts
│   │           ├── spending-by-category.tool.ts
│   │           ├── spending-by-geography.tool.ts
│   │           └── spending-over-time.tool.ts
│   ├── services/
│   │   └── usaspending/
│   │       ├── types.ts
│   │       └── usaspending-service.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── session-mode.test.ts
│   ├── scripts/
│   │   └── build-changelog.test.ts
│   ├── security/
│   │   └── input-validation.test.ts
│   ├── services/
│   │   └── usaspending-service.test.ts
│   ├── tools/
│   │   ├── autocomplete-filters.tool.test.ts
│   │   ├── disaster-spending.tool.test.ts
│   │   ├── formatting.test.ts
│   │   ├── get-agency.tool.test.ts
│   │   ├── get-award-federal-accounts.tool.test.ts
│   │   ├── get-award-subawards.tool.test.ts
│   │   ├── get-award-transactions.tool.test.ts
│   │   ├── get-award.tool.test.ts
│   │   ├── get-federal-account-breakdown.tool.test.ts
│   │   ├── get-federal-account.tool.test.ts
│   │   ├── get-idv-awards.tool.test.ts
│   │   ├── get-recipient.tool.test.ts
│   │   ├── list-agencies.tool.test.ts
│   │   ├── pagination.test.ts
│   │   ├── search-awards.tool.test.ts
│   │   ├── search-federal-accounts.tool.test.ts
│   │   ├── search-recipients.tool.test.ts
│   │   ├── spending-by-category.tool.test.ts
│   │   ├── spending-by-geography.tool.test.ts
│   │   ├── spending-over-time.tool.test.ts
│   │   └── tool-contract.test.ts
│   └── utils/
│       └── filters.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
