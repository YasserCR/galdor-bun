import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineTool, Registry } from "@galdor/core/tool";
import { Client } from "./client.ts";
import { ProtocolVersion, ToolCallError } from "./jsonrpc.ts";
import { Server } from "./server.ts";
import {
  inMemoryTransportPair,
  StreamableHTTPClientTransport,
  StreamableHTTPTransport,
  type Transport,
} from "./transports.ts";

// Two simple tools exercised across every test below.
function buildRegistry(): Registry {
  const add = defineTool({
    name: "add",
    description: "add two numbers",
    input: z.object({ a: z.number(), b: z.number() }),
    handler: ({ a, b }) => ({ sum: a + b }),
  });
  const greet = defineTool({
    name: "greet",
    description: "greet someone",
    input: z.object({ who: z.string() }),
    handler: ({ who }) => ({ message: `hello, ${who}` }),
  });
  const boom = defineTool({
    name: "boom",
    input: z.object({}),
    handler: () => {
      throw new Error("kaboom");
    },
  });
  return new Registry(add, greet, boom);
}

/** Wire a Client to a Server over a transport pair, serving in the background. */
function connect(transports?: [Transport, Transport]): {
  client: Client;
  serveDone: Promise<void>;
  stop: () => void;
} {
  const [clientT, serverT] = transports ?? inMemoryTransportPair();
  const server = new Server(buildRegistry(), { name: "test-server", version: "9.9" });
  const serveDone = server.serve(serverT);
  const client = new Client(clientT, { info: { name: "test-client", version: "1.0" } });
  return {
    client,
    serveDone,
    stop: () => {
      client.close();
      serverT.close();
    },
  };
}

describe("Client <-> Server over an in-memory transport", () => {
  test("initialize negotiates the protocol version and server info", async () => {
    const { client, serveDone, stop } = connect();
    await client.initialize();
    expect(client.protocolVersion()).toBe(ProtocolVersion);
    expect(client.serverInfo()).toEqual({ name: "test-server", version: "9.9" });
    stop();
    await serveDone;
  });

  test("listTools returns the catalog with names and schemas", async () => {
    const { client, serveDone, stop } = connect();
    await client.initialize();
    const tools = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["add", "boom", "greet"]);

    const add = tools.find((t) => t.name === "add");
    expect(add?.description).toBe("add two numbers");
    const schema = add?.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect((schema.properties as Record<string, unknown>).a).toBeDefined();
    stop();
    await serveDone;
  });

  test("call invokes a tool and returns its text result", async () => {
    const { client, serveDone, stop } = connect();
    await client.initialize();
    const out = await client.call("add", { a: 2, b: 3 });
    expect(JSON.parse(out)).toEqual({ sum: 5 });
    stop();
    await serveDone;
  });

  test("call surfaces a tool error as ToolCallError", async () => {
    const { client, serveDone, stop } = connect();
    await client.initialize();
    await expect(client.call("boom", {})).rejects.toBeInstanceOf(ToolCallError);
    stop();
    await serveDone;
  });

  test("asRegistry wraps remote tools and executes them over the wire", async () => {
    const { client, serveDone, stop } = connect();
    await client.initialize();
    const reg = await client.asRegistry();
    expect(reg.tools().map((t) => t.name())).toEqual(["add", "boom", "greet"]);

    const greet = reg.get("greet");
    expect(greet).toBeDefined();
    const result = await greet!.executeJSON({ who: "world" });
    // The adapter wraps the remote tool's free-form text result as { text }.
    expect(result).toHaveProperty("text");
    expect(JSON.parse((result as { text: string }).text)).toEqual({ message: "hello, world" });
    stop();
    await serveDone;
  });

  test("unknown tool yields a JSON-RPC error", async () => {
    const { client, serveDone, stop } = connect();
    await client.initialize();
    await expect(client.call("nope", {})).rejects.toThrow();
    stop();
    await serveDone;
  });
});

describe("Streamable HTTP transport round trip", () => {
  test("client and server exchange initialize / list / call over real HTTP", async () => {
    const serverT = new StreamableHTTPTransport(0);
    const server = new Server(buildRegistry(), { name: "http-server", version: "1" });
    const serveDone = server.serve(serverT);

    await serverT.ready; // node:http assigns the ephemeral port asynchronously
    expect(serverT.port).toBeGreaterThan(0);
    const clientT = StreamableHTTPClientTransport.create(serverT.url);
    const client = new Client(clientT, { callTimeoutMs: 5_000 });
    try {
      await client.initialize();
      expect(client.serverInfo().name).toBe("http-server");

      const tools = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["add", "boom", "greet"]);

      const out = await client.call("add", { a: 10, b: 5 });
      expect(JSON.parse(out)).toEqual({ sum: 15 });
    } finally {
      client.close();
      serverT.close();
      await serveDone;
    }
  });
});
