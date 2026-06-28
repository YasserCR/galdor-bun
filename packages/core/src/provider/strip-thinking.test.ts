import { describe, expect, test } from "bun:test";
import {
  assistantMessage,
  ContentType,
  type Message,
  messageText,
  type Usage,
} from "../schema/index.ts";
import {
  type Capabilities,
  type Event,
  EventType,
  type Provider,
  type Request,
  type Response,
} from "./index.ts";
import { extractThinkingBlocks, stripThinkingBlocks } from "./strip-thinking.ts";

const caps = (): Capabilities => ({
  streaming: true,
  toolCalling: false,
  structuredOutput: false,
  promptCaching: false,
  visionInput: false,
  reasoning: false,
  maxContextTokens: 8192,
});

const usage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
});

const req: Request = { model: "m", messages: [] };

/** Build a stub provider whose generate returns `resp` and stream yields `events`. */
function stub(resp: Response, events: Event[] = []): Provider {
  return {
    name: () => "stub",
    capabilities: () => caps(),
    generate: async () => resp,
    async *stream(): AsyncIterable<Event> {
      for (const ev of events) yield ev;
    },
  };
}

const response = (text: string): Response => ({
  message: assistantMessage(text),
  stopReason: "end_turn",
  usage: usage(),
  model: "m",
});

async function collectDeltas(stream: AsyncIterable<Event>): Promise<string> {
  let text = "";
  for await (const ev of stream) {
    if (ev.type === EventType.ContentDelta && ev.contentDelta) text += ev.contentDelta;
  }
  return text;
}

describe("stripThinkingBlocks (generate)", () => {
  test("removes an inline think block from text", async () => {
    const p = stripThinkingBlocks(stub(response("before<think>secret</think>after")));
    const resp = await p.generate(req);
    expect(messageText(resp.message)).toBe("beforeafter");
  });

  test("removes multiple blocks and is case-insensitive", async () => {
    const p = stripThinkingBlocks(stub(response("a<THINK>x</THINK>b<thinking>y</thinking>c")));
    const resp = await p.generate(req);
    expect(messageText(resp.message)).toBe("abc");
  });
});

describe("extractThinkingBlocks (generate)", () => {
  test("moves reasoning into a thinking part", async () => {
    const p = extractThinkingBlocks(stub(response("a<think>reasoning</think>b")));
    const resp = await p.generate(req);
    expect(messageText(resp.message)).toBe("ab");
    const think = resp.message.content.find((c) => c.type === ContentType.Thinking);
    expect(think?.text).toBe("reasoning");
  });
});

describe("stripThinkingBlocks (stream)", () => {
  const delta = (s: string): Event => ({ type: EventType.ContentDelta, contentDelta: s });
  const stop = (message?: Message): Event => ({
    type: EventType.MessageStop,
    stopReason: "end_turn",
    ...(message ? { message } : {}),
  });

  test("removes a block split across deltas", async () => {
    const events: Event[] = [
      { type: EventType.MessageStart, model: "m" },
      delta("Hello "),
      delta("<thi"),
      delta("nk>secret rea"),
      delta("soning</thi"),
      delta("nk> world"),
      stop(),
    ];
    const p = stripThinkingBlocks(stub(response(""), events));
    expect(await collectDeltas(p.stream(req))).toBe("Hello world");
  });

  test("drops an unclosed think block at end of stream", async () => {
    const events: Event[] = [
      { type: EventType.MessageStart, model: "m" },
      delta("answer "),
      delta("<think>incomplete reasoning forever"),
      stop(),
    ];
    const p = stripThinkingBlocks(stub(response(""), events));
    expect(await collectDeltas(p.stream(req))).toBe("answer ");
  });

  test("passes through text whose '<' is not a think tag", async () => {
    const events: Event[] = [
      { type: EventType.MessageStart, model: "m" },
      delta("a < b"),
      stop(),
    ];
    const p = stripThinkingBlocks(stub(response(""), events));
    expect(await collectDeltas(p.stream(req))).toBe("a < b");
  });

  test("strips the terminal MessageStop message without mutating the original", async () => {
    const original: Message = assistantMessage("keep<think>drop</think>end");
    const events: Event[] = [{ type: EventType.MessageStart, model: "m" }, stop(original)];
    const p = stripThinkingBlocks(stub(response(""), events));
    let stopped: Message | undefined;
    for await (const ev of p.stream(req)) {
      if (ev.type === EventType.MessageStop) stopped = ev.message;
    }
    expect(stopped && messageText(stopped)).toBe("keepend");
    // The provider's own message object is untouched.
    expect(messageText(original)).toBe("keep<think>drop</think>end");
  });
});
