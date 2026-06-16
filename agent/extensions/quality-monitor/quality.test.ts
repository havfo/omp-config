import { describe, it, expect } from "vitest";
import { assessResponse, buildCorrectionMessage, resetStallCounter } from "./quality.ts";


describe("assessResponse", () => {
  it("accepts text-only assistant response", () => {
    expect(assessResponse("here's my thinking", [], [])).toEqual({ ok: true });
  });
  it("accepts valid tool calls", () => {
    const calls = [{ name: "Read", input: { file_path: "/a" } }];
    expect(assessResponse("", calls, [])).toEqual({ ok: true });
  });
  it("does NOT flag a single transient empty turn (model self-recovers)", () => {
    resetStallCounter();
    // One empty turn is a hiccup — stay silent so a stale nudge can't strand to
    // the end of an autonomous run the model recovers from on its own.
    expect(assessResponse("", [], [])).toEqual({ ok: true });
  });
  it("detects empty response only once empty turns PERSIST", () => {
    resetStallCounter();
    expect(assessResponse("", [], [])).toEqual({ ok: true });
    expect(assessResponse("", [], [])).toEqual({
      ok: false, reason: "empty_response",
    });
  });
  it("resets the empty-turn streak when a productive turn intervenes", () => {
    resetStallCounter();
    expect(assessResponse("", [], [])).toEqual({ ok: true });
    // Productive turn (text) clears the streak…
    expect(assessResponse("here's progress", [], [])).toEqual({ ok: true });
    // …so the next lone empty turn does NOT fire.
    expect(assessResponse("", [], [])).toEqual({ ok: true });
  });
  it("does NOT flag empty when the turn carries reasoning (thinking-only turn)", () => {
    // Reasoning-model + streaming artifact: text block empty at inspection but
    // a thinking block is present. Must not fire the empty_response nudge.
    expect(assessResponse("", [], [], { hasReasoning: true })).toEqual({ ok: true });
  });
  it("detects empty tool name", () => {
    expect(assessResponse("", [{ name: "", input: {} }], [])).toEqual({
      ok: false, reason: "empty_tool_name",
    });
  });
  it("does NOT flag unknown tool names (pi owns the registry)", () => {
    // A name not in the observed set must pass — pi rejects truly-unregistered
    // tools itself with the real available list.
    expect(
      assessResponse("", [{ name: "ShellSession", input: {} }], []),
    ).toEqual({ ok: true });
    expect(
      assessResponse("", [{ name: "Anything", input: {} }], []),
    ).toEqual({ ok: true });
  });
  it("does not flag a single repeated tool call", () => {
    resetStallCounter();
    const call = [{ name: "Read", input: { file_path: "/a" } }];
    // turn 1 -> 2: one repeat is normal, not a loop
    expect(assessResponse("", call, [])).toEqual({ ok: true });
    expect(assessResponse("", call, call)).toEqual({ ok: true });
  });
  it("detects repeated tool call after threshold consecutive turns", () => {
    resetStallCounter();
    const call = [{ name: "Read", input: { file_path: "/a" } }];
    assessResponse("", call, []); // turn 1
    assessResponse("", call, call); // turn 2 (streak 2)
    expect(assessResponse("", call, call)).toEqual({
      ok: false, reason: "repeated_tool_call",
    }); // turn 3 (streak 3) -> loop
  });
  it("resets the repeat streak when the call changes", () => {
    resetStallCounter();
    const a = [{ name: "Read", input: { file_path: "/a" } }];
    const b = [{ name: "Read", input: { file_path: "/b" } }];
    assessResponse("", a, []);
    assessResponse("", a, a); // streak 2 on /a
    expect(assessResponse("", b, a)).toEqual({ ok: true }); // different call
    expect(assessResponse("", a, b)).toEqual({ ok: true }); // streak reset
  });
  it("does not flag as repeat when inputs differ", () => {
    resetStallCounter();
    const now = [{ name: "Read", input: { file_path: "/a" } }];
    const prev = [{ name: "Read", input: { file_path: "/b" } }];
    expect(assessResponse("", now, prev)).toEqual({ ok: true });
  });
  it("detects malformed args sentinel", () => {
    const calls = [{ name: "Read", input: { _raw: "garbage" } }];
    expect(assessResponse("", calls, [])).toEqual({
      ok: false, reason: "malformed_args:Read",
    });
  });
});

describe("buildCorrectionMessage", () => {
  it("generates empty-response message", () => {
    const m = buildCorrectionMessage("empty_response");
    expect(m).toContain("empty");
  });
  it("generates unknown-tool message with tool name", () => {
    const m = buildCorrectionMessage("unknown_tool:FakeTool");
    expect(m).toContain("'FakeTool'");
    expect(m).toContain("does not exist");
  });
  it("generates malformed-args message", () => {
    const m = buildCorrectionMessage("malformed_args:Read");
    expect(m).toContain("'Read'");
    expect(m).toContain("malformed");
  });
  it("generates repeated-tool-call message", () => {
    const m = buildCorrectionMessage("repeated_tool_call");
    expect(m).toContain("loop");
  });
  it("falls back to generic on unknown reason", () => {
    expect(buildCorrectionMessage("weird_thing")).toContain("weird_thing");
  });
});
