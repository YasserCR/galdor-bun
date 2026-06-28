/**
 * @galdor/mcp — Model Context Protocol (MCP) client and server.
 *
 * MCP is the open specification for connecting LLM applications to external
 * tools and data sources, carried over JSON-RPC 2.0. This package implements
 * both ends of that conversation.
 *
 * Supported:
 *   - JSON-RPC 2.0 framing, the initialize handshake + initialized notification,
 *     `tools/list` and `tools/call`.
 *   - Transports: in-memory (tests), stdio (newline-delimited JSON), HTTP+SSE,
 *     and Streamable HTTP (client and server sides).
 *
 * {@link Client.asRegistry} converts a connected server's tools into core
 * `AnyTool` values, ready to plug straight into an agent.
 */

export * from "./jsonrpc.ts";
export * from "./transports.ts";
export { Client, type ClientOptions } from "./client.ts";
export { Server } from "./server.ts";
