import { describe, it, expect } from "vitest";
import { extractMessageParts, stripReasoning } from "./text.ts";

describe("stripReasoning", () => {
  it("removes a closed think block", () => {
    expect(stripReasoning("<think>plan</think>\n\nanswer")).toBe("answer");
  });
  it("removes an unterminated think block to EOL", () => {
    expect(stripReasoning("<think>plan that never closes")).toBe("");
  });
  it("leaves plain text untouched", () => {
    expect(stripReasoning("just an answer")).toBe("just an answer");
  });
});

describe("extractMessageParts", () => {
  it("reads pi canonical blocks (text + thinking + toolCall)", () => {
    const msg = {
      content: [
        { type: "thinking", thinking: "let me look" },
        { type: "text", text: "here is the answer" },
        { type: "toolCall", name: "Read", arguments: { file_path: "/a" } },
      ],
    };
    const p = extractMessageParts(msg);
    expect(p.text).toBe("here is the answer");
    expect(p.hasReasoning).toBe(true);
    expect(p.toolCalls).toEqual([{ name: "Read", input: { file_path: "/a" } }]);
  });

  it("reads provider-native openai-responses blocks (output_text + reasoning + function_call)", () => {
    // This is the shape that reaches turn_end on the llama.cpp openai-responses
    // path BEFORE pi normalizes it — the exact case that produced the bogus
    // empty_response nudge when only "text"/"toolCall" were matched.
    const msg = {
      content: [
        { type: "reasoning", text: "thinking it through" },
        { type: "output_text", text: "Sorry about that — here's the recap.", annotations: [] },
      ],
    };
    const p = extractMessageParts(msg);
    expect(p.text).toBe("Sorry about that — here's the recap.");
    expect(p.hasReasoning).toBe(true);
    expect(p.toolCalls).toEqual([]);
  });

  it("detects native function_call tool calls", () => {
    const msg = {
      content: [{ type: "function_call", name: "Bash", arguments: { command: "ls" } }],
    };
    expect(extractMessageParts(msg).toolCalls).toEqual([
      { name: "Bash", input: { command: "ls" } },
    ]);
  });

  it("handles a bare string body", () => {
    const p = extractMessageParts({ content: "<think>x</think>plain" });
    expect(p.text).toBe("plain");
    expect(p.toolCalls).toEqual([]);
  });

  it("reads text nested inside a `message` wrapper block (openai-responses items)", () => {
    // {type:"message", content:[{type:"output_text",…}]} — a top-level-only scan
    // misses this, so a text-only turn read as empty → bogus empty_response.
    const msg = {
      content: [
        { type: "message", status: "completed", role: "assistant", content: [
          { type: "output_text", text: "Here is the answer.", annotations: [] },
        ] },
      ],
    };
    const p = extractMessageParts(msg);
    expect(p.text).toBe("Here is the answer.");
    expect(p.toolCalls).toEqual([]);
  });

  it("never reports a turn with prose under an unknown shape as empty (deep-scan net)", () => {
    // Shape we don't model explicitly, but it clearly carries text.
    const msg = { content: [{ type: "weird", parts: [{ value: "real output here" }] }] };
    const p = extractMessageParts(msg);
    expect(p.text.trim().length).toBeGreaterThan(0);
  });

  it("reports truly-empty turns as empty", () => {
    const p = extractMessageParts({ content: [] });
    expect(p.text).toBe("");
    expect(p.toolCalls).toEqual([]);
    expect(p.hasReasoning).toBe(false);
  });
});
