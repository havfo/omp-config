import { describe, it, expect } from "vitest";
import { submitFollowUp, FollowUpPriority } from "./followup-bus.ts";

// The bus flushes on a macrotask, so every assertion waits one tick past it.
const tick = () => new Promise((r) => setTimeout(r, 5));

function harness() {
  const sent: { message: string; deliverAs?: string }[] = [];
  const pi: any = {
    sendUserMessage: (message: string, opts?: { deliverAs?: string }) =>
      sent.push({ message, deliverAs: opts?.deliverAs }),
  };
  return { pi, sent };
}

describe("followup-bus delivery", () => {
  it("delivers the highest-priority submission of the turn", async () => {
    const { pi, sent } = harness();
    submitFollowUp(pi, "quality", FollowUpPriority.QUALITY, "quality", "steer");
    submitFollowUp(pi, "syntax", FollowUpPriority.SYNTAX_ERROR, "syntax", "steer");
    await tick();
    expect(sent.map((s) => s.message)).toEqual(["syntax"]);
    expect(sent[0].deliverAs).toBe("steer");
  });

  // Regression: syntax corrections were arriving hours after the edit that
  // raised them, naming files the model had long since fixed. The bus now
  // re-checks the condition at delivery.
  it("drops a message whose validate() says the condition is gone", async () => {
    const { pi, sent } = harness();
    submitFollowUp(pi, "syntax", FollowUpPriority.SYNTAX_ERROR, "stale", "steer", () => false);
    await tick();
    expect(sent).toEqual([]);
  });

  it("delivers when validate() still holds, including async checks", async () => {
    const { pi, sent } = harness();
    submitFollowUp(pi, "syntax", FollowUpPriority.SYNTAX_ERROR, "live", "steer",
      async () => true);
    await tick();
    expect(sent.map((s) => s.message)).toEqual(["live"]);
  });

  it("drops the message when validate() throws rather than sending blind", async () => {
    const { pi, sent } = harness();
    submitFollowUp(pi, "syntax", FollowUpPriority.SYNTAX_ERROR, "boom", "steer", () => {
      throw new Error("parse failed");
    });
    await tick();
    expect(sent).toEqual([]);
  });
});
