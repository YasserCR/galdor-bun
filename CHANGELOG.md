# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Core framework: schema, provider, tool, graph, agent, store, observability,
  eval, replay, memory, embedder, council, and spellbook.
- Provider adapters for Anthropic, OpenAI, Google, and Amazon Bedrock.
- Model Context Protocol (MCP) client and server, and Agent-to-Agent (A2A)
  transport.
- Embedded OpenTelemetry observability dashboard with a timeline, span tree,
  span detail, step-by-step view, and graph topology, plus a light/dark theme.
- Command-line tool (`galdor`) for inspecting traces and serving the dashboard.
- Runs on both Bun and Node with full parity.
