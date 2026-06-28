/**
 * An MCP client and server talking over an in-process transport pair.
 *
 * Run it:
 *
 *   bun packages/examples/mcp-inproc.ts
 *
 * The Model Context Protocol carries tool discovery and tool calls over
 * JSON-RPC 2.0. Here both ends live in the same process: `inMemoryTransportPair`
 * gives us two connected transports with no real I/O. The server publishes a
 * tool registry; the client performs the initialize handshake, lists the
 * server's tools, calls one, and prints the result.
 */

import { z } from "zod";
import { defineTool, Registry } from "@galdor/core/tool";
import { Server, Client, inMemoryTransportPair } from "@galdor/mcp";

// The tool the server will expose over MCP.
const add = defineTool({
  name: "add",
  description: "Add two integers and return their sum.",
  input: z.object({ a: z.number(), b: z.number() }),
  handler: ({ a, b }) => ({ sum: a + b }),
});

const server = new Server(new Registry(add), { name: "demo-server", version: "1.0" });

// Two ends of one in-memory pipe: one for the server, one for the client.
const [clientTransport, serverTransport] = inMemoryTransportPair();

// The server serves until its transport closes; run it in the background.
const serving = server.serve(serverTransport);

const client = new Client(clientTransport, { info: { name: "demo-client", version: "1.0" } });

try {
  // 1. Handshake.
  await client.initialize();
  console.log("=== initialized ===");
  console.log("server     :", client.serverInfo());
  console.log("protocol   :", client.protocolVersion());
  console.log();

  // 2. Discover the catalog.
  const tools = await client.listTools();
  console.log("=== tools/list ===");
  for (const t of tools) {
    console.log(`- ${t.name}: ${t.description ?? ""}`);
  }
  console.log();

  // 3. Invoke a tool. The reply is the tool's JSON output as text.
  const result = await client.call("add", { a: 2, b: 3 });
  console.log("=== tools/call add(2, 3) ===");
  console.log("result     :", result);
} finally {
  // Closing the client tears down the pipe; the server's serve loop then ends.
  client.close();
  serverTransport.close();
  await serving;
}
