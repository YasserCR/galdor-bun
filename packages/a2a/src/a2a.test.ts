import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "./client.ts";
import { type Handler, handlerFunc, newServer } from "./server.ts";
import {
  AGENT_CARD_PATH,
  type AgentCard,
  agentText,
  appendMessage,
  ERR_PARSE_ERROR,
  messageText,
  type Task,
} from "./types.ts";

let listening: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  listening?.stop(true);
  listening = undefined;
});

/** start spins up an A2A Server on an ephemeral port and returns a Client. */
function start(handler: Handler): Client {
  const card: AgentCard = {
    name: "test-agent",
    description: "test fixture",
    url: "",
    version: "0.1",
    capabilities: {},
    skills: [{ id: "echo", name: "Echo", description: "Repeats whatever the user said" }],
  };
  const server = newServer(card, handler);
  listening = Bun.serve({ port: 0, fetch: server.fetch });
  return new Client(`http://localhost:${listening.port}`);
}

/** echo replays the latest user message back as an agent turn, then completes. */
const echo = handlerFunc(async (task: Task) => {
  let said = "";
  for (const m of task.messages) {
    if (m.role === "user") said = messageText(m);
  }
  appendMessage(task, agentText(`echo: ${said}`));
  task.status.state = "completed";
});

describe("a2a", () => {
  test("fetchAgentCard returns the published card", async () => {
    const client = start(echo);
    const card = await client.fetchAgentCard();
    expect(card.name).toBe("test-agent");
    expect(card.version).toBe("0.1");
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0]?.id).toBe("echo");
  });

  test("sendTask runs the handler and returns the completed task", async () => {
    const client = start(echo);
    const task = await client.sendTask({ role: "user", parts: [{ type: "text", text: "hello" }] });

    expect(task.id).not.toBe("");
    expect(task.status.state).toBe("completed");
    // Log holds the user turn + the echoed agent turn.
    expect(task.messages).toHaveLength(2);
    const agentTurn = task.messages[1];
    expect(agentTurn?.role).toBe("agent");
    expect(messageText(agentTurn!)).toContain("echo: hello");
  });

  test("getTask retrieves a task by id", async () => {
    const client = start(echo);
    const created = await client.sendTask({
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    const got = await client.getTask(created.id);
    expect(got.id).toBe(created.id);
    expect(got.status.state).toBe("completed");
    expect(messageText(got.messages[1]!)).toContain("echo: hi");
  });

  test("handler errors mark the task failed without an RPC error", async () => {
    const client = start(
      handlerFunc(async () => {
        throw new Error("planet exploded");
      }),
    );
    // SendTask succeeds at the protocol level; the failure is in the status.
    const task = await client.sendTask({ role: "user", parts: [{ type: "text", text: "oops" }] });
    expect(task.status.state).toBe("failed");
    expect(task.status.errorMessage).toContain("planet exploded");
  });

  test("server auto-completes when the handler forgets the terminal state", async () => {
    const client = start(
      handlerFunc(async (task: Task) => {
        appendMessage(task, agentText("done but forgot the flag"));
        // Intentionally leaves state at "running".
      }),
    );
    const task = await client.sendTask({ role: "user", parts: [{ type: "text", text: "hi" }] });
    expect(task.status.state).toBe("completed");
  });

  test("getTask on an unknown id rejects", async () => {
    const client = start(echo);
    await expect(client.getTask("ghost")).rejects.toThrow();
  });

  test("getTask truncates the log to historyLength", async () => {
    const client = start(
      handlerFunc(async (task: Task) => {
        appendMessage(task, agentText("a"));
        appendMessage(task, agentText("b"));
        appendMessage(task, agentText("c"));
        task.status.state = "completed";
      }),
    );
    const created = await client.sendTask({ role: "user", parts: [{ type: "text", text: "go" }] });
    // Full log = 1 user + 3 agent = 4 messages.
    const got = await client.getTask(created.id, 2);
    expect(got.messages).toHaveLength(2);
  });

  test("server rejects an over-cap request body", async () => {
    const client = start(echo);
    // A text part larger than the 4 MiB request cap.
    const big = "y".repeat((4 << 20) + 1024);
    await expect(
      client.sendTask({ role: "user", parts: [{ type: "text", text: big }] }),
    ).rejects.toThrow();
  });
});

/** A minimal Agent Card fixture for the protection tests. */
function fixtureCard(name = "test-agent"): AgentCard {
  return { name, description: "fixture", url: "", version: "0.1", capabilities: {}, skills: [] };
}

describe("a2a protections", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  test("client refuses a cross-host redirect (SSRF guard)", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, { status: 302, headers: { Location: "http://example.com/evil" } }),
    });
    const client = new Client(`http://localhost:${server.port}`);
    await expect(client.fetchAgentCard()).rejects.toThrow(/cross-host/);
  });

  test("client follows a same-host redirect", async () => {
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === AGENT_CARD_PATH) {
          return new Response(null, { status: 302, headers: { Location: "/card" } });
        }
        return new Response(JSON.stringify(fixtureCard("redirected")), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const client = new Client(`http://localhost:${server.port}`);
    const card = await client.fetchAgentCard();
    expect(card.name).toBe("redirected");
  });

  test("client rejects an over-cap response body", async () => {
    // One byte past the 4 MiB response cap.
    const big = "x".repeat((4 << 20) + 1);
    server = Bun.serve({ port: 0, fetch: () => new Response(big) });
    const client = new Client(`http://localhost:${server.port}`);
    await expect(client.fetchAgentCard()).rejects.toThrow(/exceeds/);
  });

  test("client honors a caller signal alongside the default deadline", async () => {
    server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(2000);
        return new Response("{}");
      },
    });
    const client = new Client(`http://localhost:${server.port}`);
    // The caller's 50ms signal must fire even though it is combined with the
    // 60s default deadline.
    await expect(client.fetchAgentCard(AbortSignal.timeout(50))).rejects.toThrow();
  });

  test("server rejects an over-cap streamed request without content-length", async () => {
    const a2a = newServer(fixtureCard(), echo);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array((4 << 20) + 1));
        controller.close();
      },
    });
    const req = new Request("http://localhost/rpc", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const resp = await a2a.fetch(req);
    const reply = (await resp.json()) as { error?: { code: number } };
    expect(reply.error?.code).toBe(ERR_PARSE_ERROR);
  });
});
