---
name: research-protocol
type: workflow
triggers: ["/research"]
when_to_use: when the task requires gathering facts from the web and citing them in a final answer
context: inline
token_cost: 180
user_invocable: false
---
## Research Protocol (source-first)

1. Decompose the question into one or two unknowns. Write them down in your first reply.
2. For each unknown, find a source: `web_search` for discovery, then `browser` (or
   `fetch`/`read` on a URL) to read the page and pull the specific fact.
3. Do NOT state a fact you haven't read from a concrete source this session.
4. Track the source URL next to each fact as you go. Your final answer must cite at
   least one source URL per non-obvious claim.
5. If you have no usable source for a claim, keep searching — don't guess.

Stop conditions:
- Every claim in your answer is backed by a source you read → ANSWER, with citations.
- You have tried 3+ search refinements with no usable source → say "insufficient
  evidence" instead of guessing.
