import { describe, it, expect } from "vitest";
import { parseSearchQuery } from "./searchParser";
import {
  parseQueryToConditions,
  buildQueryFromConditions,
  type Condition,
} from "./visualQueryBuilder";

function stripIds(conditions: Condition[]) {
  return conditions.map((c) => ({ type: c.type, value: c.value }));
}

describe("parseQueryToConditions", () => {
  it("parses plain text as keywords", () => {
    const conditions = parseQueryToConditions("budget report");
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({ type: "keywords", value: "budget report" });
  });

  it("parses operators into typed conditions", () => {
    const conditions = parseQueryToConditions("is:unread from:boss has:attachment");
    expect(stripIds(conditions)).toEqual([
      { type: "from", value: "boss" },
      { type: "is", value: "unread" },
      { type: "hasAttachment", value: "attachment" },
    ]);
  });

  it("parses all supported operators", () => {
    const conditions = parseQueryToConditions(
      'keywords from:alice to:bob subject:"meeting notes" is:starred after:2024/01/15 before:2024/06/01 label:work has:attachment',
    );
    expect(stripIds(conditions)).toEqual([
      { type: "keywords", value: "keywords" },
      { type: "from", value: "alice" },
      { type: "to", value: "bob" },
      { type: "subject", value: "meeting notes" },
      { type: "is", value: "starred" },
      { type: "hasAttachment", value: "attachment" },
      { type: "after", value: "2024/01/15" },
      { type: "before", value: "2024/06/01" },
      { type: "label", value: "work" },
    ]);
  });

  it("returns empty array for empty query", () => {
    expect(parseQueryToConditions("")).toEqual([]);
  });

  it("ignores unknown operators", () => {
    const conditions = parseQueryToConditions("is:banana has:nothing");
    expect(conditions).toEqual([]);
  });

  it("formats dates from timestamps", () => {
    const conditions = parseQueryToConditions("after:2024-03-15");
    expect(conditions[0]).toMatchObject({ type: "after", value: "2024/03/15" });
  });
});

describe("buildQueryFromConditions", () => {
  it("builds a query from conditions", () => {
    const conditions: Condition[] = [
      { id: "a", type: "is", value: "unread" },
      { id: "b", type: "from", value: "boss" },
    ];
    expect(buildQueryFromConditions(conditions)).toBe("is:unread from:boss");
  });

  it("quotes values containing spaces", () => {
    const conditions: Condition[] = [
      { id: "a", type: "from", value: "John Doe" },
      { id: "b", type: "subject", value: "Project Update" },
    ];
    expect(buildQueryFromConditions(conditions)).toBe(
      'from:"John Doe" subject:"Project Update"',
    );
  });

  it("preserves keywords and free text", () => {
    const conditions: Condition[] = [
      { id: "a", type: "keywords", value: "budget report" },
      { id: "b", type: "is", value: "unread" },
    ];
    expect(buildQueryFromConditions(conditions)).toBe("budget report is:unread");
  });

  it("emits has:attachment without value", () => {
    const conditions: Condition[] = [
      { id: "a", type: "hasAttachment", value: "attachment" },
    ];
    expect(buildQueryFromConditions(conditions)).toBe("has:attachment");
  });

  it("skips empty values", () => {
    const conditions: Condition[] = [
      { id: "a", type: "from", value: "" },
      { id: "b", type: "is", value: "read" },
      { id: "c", type: "keywords", value: "   " },
    ];
    expect(buildQueryFromConditions(conditions)).toBe("is:read");
  });

  it("round-trips a complex query semantically", () => {
    const original = 'is:unread from:boss subject:"Q3 review" after:2024/01/01 label:work';
    const conditions = parseQueryToConditions(original);
    const rebuilt = buildQueryFromConditions(conditions);
    expect(parseSearchQuery(rebuilt)).toEqual(parseSearchQuery(original));
  });
});
