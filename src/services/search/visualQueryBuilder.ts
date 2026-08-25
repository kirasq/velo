import { parseSearchQuery } from "./searchParser";

export type ConditionType =
  | "keywords"
  | "from"
  | "to"
  | "subject"
  | "is"
  | "hasAttachment"
  | "after"
  | "before"
  | "label";

export interface Condition {
  id: string;
  type: ConditionType;
  value: string;
}

const conditionTypeOrder: ConditionType[] = [
  "keywords",
  "from",
  "to",
  "subject",
  "is",
  "hasAttachment",
  "after",
  "before",
  "label",
];

export const visualQueryBuilderOrder: readonly ConditionType[] = conditionTypeOrder;

function formatDate(ts?: number): string {
  if (ts === undefined) return "";
  const d = new Date(ts * 1000);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

export function parseQueryToConditions(query: string): Condition[] {
  const parsed = parseSearchQuery(query);
  const conditions: Condition[] = [];
  let id = 0;
  const nextId = () => `cond-${++id}`;

  if (parsed.freeText?.trim()) {
    conditions.push({ id: nextId(), type: "keywords", value: parsed.freeText.trim() });
  }
  if (parsed.from !== undefined) {
    conditions.push({ id: nextId(), type: "from", value: parsed.from });
  }
  if (parsed.to !== undefined) {
    conditions.push({ id: nextId(), type: "to", value: parsed.to });
  }
  if (parsed.subject !== undefined) {
    conditions.push({ id: nextId(), type: "subject", value: parsed.subject });
  }
  if (parsed.isUnread) {
    conditions.push({ id: nextId(), type: "is", value: "unread" });
  } else if (parsed.isRead) {
    conditions.push({ id: nextId(), type: "is", value: "read" });
  } else if (parsed.isStarred) {
    conditions.push({ id: nextId(), type: "is", value: "starred" });
  }
  if (parsed.hasAttachment) {
    conditions.push({ id: nextId(), type: "hasAttachment", value: "attachment" });
  }
  if (parsed.after !== undefined) {
    conditions.push({ id: nextId(), type: "after", value: formatDate(parsed.after) });
  }
  if (parsed.before !== undefined) {
    conditions.push({ id: nextId(), type: "before", value: formatDate(parsed.before) });
  }
  if (parsed.label !== undefined) {
    conditions.push({ id: nextId(), type: "label", value: parsed.label });
  }
  return conditions;
}

function quoteIfNeeded(value: string): string {
  if (value === "") return '""';
  if (/\s/.test(value)) return `"${value.replace(/"/g, '\\"')}"`;
  return value;
}

export function buildQueryFromConditions(conditions: Condition[]): string {
  const parts: string[] = [];
  for (const c of conditions) {
    const v = c.value.trim();
    switch (c.type) {
      case "keywords":
        if (v) parts.push(v);
        break;
      case "from":
        if (v) parts.push(`from:${quoteIfNeeded(v)}`);
        break;
      case "to":
        if (v) parts.push(`to:${quoteIfNeeded(v)}`);
        break;
      case "subject":
        if (v) parts.push(`subject:${quoteIfNeeded(v)}`);
        break;
      case "is":
        if (v) parts.push(`is:${v}`);
        break;
      case "hasAttachment":
        parts.push("has:attachment");
        break;
      case "after":
        if (v) parts.push(`after:${v}`);
        break;
      case "before":
        if (v) parts.push(`before:${v}`);
        break;
      case "label":
        if (v) parts.push(`label:${quoteIfNeeded(v)}`);
        break;
    }
  }
  return parts.join(" ");
}
