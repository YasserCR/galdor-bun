import { describe, expect, test } from "bun:test";
import { runDuration, runStatus, type Span, spanDuration, Store } from "./index.ts";

const span = (over: Partial<Span> = {}): Span => ({
  spanId: "s1",
  traceId: "t1",
  parentSpanId: "",
  name: "galdor.graph.run",
  startTimeUnixNano: 1_700_000_000_000_000_000n,
  endTimeUnixNano: 1_700_000_000_500_000_000n,
  statusCode: "ok",
  statusMessage: "",
  attributes: {},
  events: [],
  runId: "",
  ...over,
});

describe("Store", () => {
  test("insert + spansForRun round-trips, preserving nanosecond precision", () => {
    const st = Store.open(":memory:");
    const root = span({ spanId: "root", runId: "run-1" });
    const child = span({
      spanId: "child",
      parentSpanId: "root",
      name: "galdor.provider.generate",
      startTimeUnixNano: 1_700_000_000_100_000_000n,
      endTimeUnixNano: 1_700_000_000_200_000_000n,
      attributes: { "gen_ai.request.model": "m" },
    });
    st.insertSpans([root, child]);

    const spans = st.spansForRun("run-1");
    expect(spans).toHaveLength(2);
    expect(spans[0]?.spanId).toBe("root");
    // nanosecond field is exact (would lose precision as a JS number)
    expect(spans[0]?.startTimeUnixNano).toBe(1_700_000_000_000_000_000n);
    expect(spanDuration(spans[0]!)).toBe(500_000_000n);
    expect(spans[1]?.attributes["gen_ai.request.model"]).toBe("m");
    st.close();
  });

  test("listRuns aggregates by trace and reports status/error counts", () => {
    const st = Store.open(":memory:");
    st.insertSpans([
      span({ spanId: "a", traceId: "tA", runId: "rA", statusCode: "ok" }),
      span({ spanId: "b", traceId: "tA", parentSpanId: "a", statusCode: "error" }),
    ]);
    const runs = st.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("rA");
    expect(runs[0]?.spanCount).toBe(2);
    expect(runs[0]?.errorCount).toBe(1);
    expect(runStatus(runs[0]!)).toBe("error");
    expect(runDuration(runs[0]!)).toBe(500_000_000n);
    st.close();
  });

  test("duplicate span ids are ignored, not fatal", () => {
    const st = Store.open(":memory:");
    st.insertSpans([span({ spanId: "dup", runId: "r" })]);
    st.insertSpans([span({ spanId: "dup", runId: "r" })]);
    expect(st.spanCount()).toBe(1);
    st.close();
  });

  test("graph spec upsert + orphan span count", () => {
    const st = Store.open(":memory:");
    st.setGraphSpec("run-1", '{"entry":"a"}');
    st.setGraphSpec("run-1", '{"entry":"b"}'); // upsert
    expect(st.getGraphSpec("run-1")).toBe('{"entry":"b"}');
    expect(st.getGraphSpec("missing")).toBe("");

    // a span with no run id anywhere in its trace is an orphan
    st.insertSpans([span({ spanId: "orphan", traceId: "torphan", runId: "" })]);
    expect(st.orphanSpanCount()).toBe(1);
    st.close();
  });

  test("span events with bigint times survive the JSON round-trip", () => {
    const st = Store.open(":memory:");
    st.insertSpans([
      span({
        spanId: "e",
        runId: "r",
        events: [{ name: "exception", timeUnixNano: 1_700_000_000_123_456_789n, attributes: { msg: "boom" } }],
      }),
    ]);
    const got = st.spansForRun("r")[0];
    expect(got?.events[0]?.timeUnixNano).toBe(1_700_000_000_123_456_789n);
    expect(got?.events[0]?.attributes?.msg).toBe("boom");
    st.close();
  });

  test("reads events whose time field is the canonical snake_case time_unix_nano", () => {
    const st = Store.open(":memory:");
    // A row as written by a peer galdor span store: event time is `time_unix_nano`.
    const eventsJson = '[{"name":"exception","time_unix_nano":1700000000123000000,"attributes":{"exception.message":"boom"}}]';
    st.db
      .prepare(
        `INSERT INTO spans (span_id, trace_id, parent_span_id, name, start_time_unix_nano, end_time_unix_nano,
          status_code, status_message, attrs_json, events_json, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("g", "tg", "", "galdor.graph.run", 1n, 2n, "ok", "", "{}", eventsJson, "rg");
    const ev = st.spansForRun("rg")[0]!.events[0]!;
    expect(typeof ev.timeUnixNano).toBe("bigint");
    expect(ev.timeUnixNano / 1_000_000n).toBe(1_700_000_000_123n); // millisecond precision preserved
    expect(ev.attributes?.["exception.message"]).toBe("boom");
    st.close();
  });
});
