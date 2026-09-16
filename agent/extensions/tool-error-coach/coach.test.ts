import { describe, expect, it } from "vitest";
import { pickBackgroundHint, pickHint, pickNoopHint } from "./index.ts";

describe("pickHint", () => {
  it("matches ENOENT to a Glob suggestion", () => {
    expect(pickHint("read", "ENOENT: no such file or directory")).toMatch(/Glob/);
  });
  it("coaches a 'no preceding hunk header' hashline error with the PUT shape", () => {
    const h = pickHint("edit", "line 1: payload line has no preceding hunk header. Got \"+x\".");
    expect(h).toMatch(/own line/i);
    expect(h).toMatch(/PUT N\.=M:/);
    expect(h).not.toMatch(/SWAP/);
  });
  it("coaches a unified-diff `-old` row", () => {
    expect(pickHint("edit", "`-` rows are not valid; the range already names the lines being changed."))
      .toMatch(/not a diff/i);
  });
  it("coaches a stale snapshot tag", () => {
    expect(pickHint("edit", "stale snapshot: the file changed since [a.ts#0DB3]")).toMatch(/re-`read`/i);
  });
  it("matches whitelist failure", () => {
    expect(pickHint("bash", "bash whitelist: rm not in SAFE_PREFIXES")).toMatch(/whitelisted prefix/);
  });
  it("returns undefined for unknown errors", () => {
    expect(pickHint("read", "kernel panic")).toBeUndefined();
  });
});

describe("pickNoopHint", () => {
  it("coaches a byte-identical no-op edit", () => {
    expect(pickNoopHint("parsed and applied cleanly, but produced no change: your body row(s) are byte-identical"))
      .toMatch(/changed nothing/);
  });
  it("coaches an ast_edit with no replacements", () => {
    expect(pickNoopHint("No replacements made")).toMatch(/changed nothing/);
  });
  it("returns undefined for a normal successful result", () => {
    expect(pickNoopHint("Successfully wrote 7474 bytes to file.go")).toBeUndefined();
  });

  // 18.0.1 warns on edits that applied but left the file unparseable. These
  // come back with isError=false, so only the no-op path ever sees them.
  it("coaches an applied edit that broke the parse", () => {
    expect(pickNoopHint(
      "This edit introduced a syntax error near line 42: the file parsed before the patch and no longer does.",
    )).toMatch(/BROKE the parse/);
  });

  it("coaches an insert that landed by indentation", () => {
    expect(pickNoopHint(
      "PUT >12: body indented shallower than the anchor, so the landing moved past 2 closing lines to after line 19.",
    )).toMatch(/INDENTATION/);
  });

  it("coaches an auto-repaired boundary", () => {
    expect(pickNoopHint(
      "Auto-repaired a replacement boundary echo at line 7: dropped 1 leading body line(s) already present outside the range.",
    )).toMatch(/exactly the changed lines/);
  });
});

// Every string below is a verbatim diagnostic emitted by omp 18.0.1's hashline
// packages; they are the regression fence for the coach's pattern table.
describe("pickHint — omp 18.x hashline diagnostics", () => {
  it("coaches an absolute-range mistake", () => {
    expect(pickHint("edit",
      "line 3: Invalid absolute range: start 12, end 2. The value after `.=` is an absolute source line, not a line count or replacement length.",
    )).toMatch(/ABSOLUTE last source line/);
  });

  it("coaches an unresolvable block anchor", () => {
    expect(pickHint("edit",
      "`PUT 5*:` could not resolve a syntactic block beginning on line 5 (unsupported language, blank/closer line, or parse error).",
    )).toMatch(/OPENING line/);
  });

  it("coaches a closing-delimiter anchor", () => {
    expect(pickHint("edit",
      "`PUT >3*:` anchors on a closing delimiter, so it was applied as plain `PUT >3:`.",
    )).toMatch(/CLOSING line/);
  });

  it("coaches an empty register paste", () => {
    expect(pickHint("edit",
      "`@fn` was empty — no `CUT … @fn` precedes this op in this call and no persisted register has that name.",
    )).toMatch(/register is empty/);
  });

  it("coaches ambiguous unlabeled CUTs", () => {
    expect(pickHint("edit",
      "2 unlabeled `CUT`s are pending (4, 9) — an unlabeled paste cannot tell which one you meant.",
    )).toMatch(/Label the moves/);
  });

  it("coaches a missing snapshot tag without calling it stale", () => {
    const h = pickHint("edit", "Missing hashline snapshot tag for gcc.go; use `[gcc.go#tag]` from your latest read/search output.");
    expect(h).toMatch(/carries no `#TAG`/);
    expect(h).not.toMatch(/stale/);
  });

  it("coaches conflicting tags for one file", () => {
    expect(pickHint("edit",
      "Conflicting hashline snapshot tags for gcc.go: #0DB3 and #A1B2. Re-read the file and retry with one current header.",
    )).toMatch(/single current tag/);
  });

  it("coaches two sections targeting one file", () => {
    expect(pickHint("edit",
      "Multiple hashline sections resolve to the same file (a.go and a.go). Merge their ops under one header before applying.",
    )).toMatch(/ONE header/);
  });

  it("coaches a `+`-prefixed op", () => {
    expect(pickHint("edit",
      "line 6: body row `+PUT 9.=9:` is itself a valid hunk header, so it was inserted into the file as literal text rather than executed.",
    )).toMatch(/never `\+`-prefixed/);
  });

  it("coaches pasted read-output rows", () => {
    expect(pickHint("edit",
      "two or more pasted `12:TEXT` read-output rows name line 12.",
    )).toMatch(/NO line-number prefixes/);
  });

  it("coaches a body that echoes lines outside the range", () => {
    expect(pickHint("edit",
      "`PUT 10.=12:` rejected: the body opens by restating the 2 line(s) just above the range, but is too short to be the full final content of the selected range.",
    )).toMatch(/OUTSIDE the range/);
  });

  it("coaches an ambiguous boundary row", () => {
    expect(pickHint("edit",
      "`PUT 4.=8:` rejected: a selected boundary row is required for the file to parse, but the body indentation does not establish whether it belongs before or after that row.",
    )).toMatch(/excludes every unchanged boundary row/);
  });

  it("coaches a foreign patch dialect", () => {
    expect(pickHint("edit",
      "unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline.",
    )).toMatch(/different patch format|not a diff/);
    expect(pickHint("edit",
      'apply_patch sentinel "*** Update File: a.go" is not valid in hashline.',
    )).toMatch(/different patch format/);
  });
});

describe("pickBackgroundHint", () => {
  it("coaches a backgrounded bash job to not wait", () => {
    const h = pickBackgroundHint("bash", "Backgrounded as job bash-7; result will be delivered automatically.");
    expect(h).toMatch(/bash-7/);
    expect(h).toMatch(/Do NOT sleep/);
    expect(h).toMatch(/end your turn/);
  });
  it("ignores ordinary output and other tools", () => {
    expect(pickBackgroundHint("bash", "ok\n2 passed")).toBeUndefined();
    expect(pickBackgroundHint("read", "Backgrounded as job x; result will be delivered automatically.")).toBeUndefined();
  });
});
