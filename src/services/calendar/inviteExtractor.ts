import { parseVEvent } from "./icalHelper";
import {
  upsertCalendarInvite,
  getInviteByMessage,
  type DbCalendarInvite,
} from "@/services/db/calendarInvites";

export interface CalendarInvite {
  uid: string;
  method: string | null;
  sequence: number;
  summary: string | null;
  description: string | null;
  location: string | null;
  /** Unix seconds */
  startTime: number;
  endTime: number;
  isAllDay: boolean;
  status: string;
  organizerEmail: string | null;
  organizerName: string | null;
  attendees: { email: string; displayName?: string; responseStatus?: string }[];
  icalData: string;
  rsvpStatus: string;
}

/**
 * Parse a raw text/calendar payload into a structured invite.
 * `rawIcs` is the decoded ICS text (NOT base64).
 */
export function parseCalendarInvite(rawIcs: string): CalendarInvite | null {
  const trimmed = rawIcs.trim();
  if (!trimmed.includes("BEGIN:VCALENDAR") && !trimmed.includes("BEGIN:VEVENT")) {
    return null;
  }

  const parsed = parseVEvent(trimmed);
  if (!parsed.uid) return null;

  // METHOD may sit on the VCALENDAR line; parseVEvent already captures it
  // when unfolded lines are flat, but fall back to a direct scan.
  let method = parsed.method ?? null;
  if (!method) {
    const m = trimmed.match(/METHOD:([A-Za-z]+)/);
    if (m) method = m[1]!.toUpperCase();
  }

  let organizerName: string | null = null;
  const orgLine = trimmed.match(/ORGANIZER(?:;[^:]*)?:[^:]*CN=([^;:\r\n]+)/i);
  if (orgLine) organizerName = orgLine[1]!.replace(/^"(.*)"$/, "$1");

  let attendees: { email: string; displayName?: string; responseStatus?: string }[] = [];
  try {
    attendees = parsed.attendeesJson ? JSON.parse(parsed.attendeesJson) : [];
  } catch {
    attendees = [];
  }

  return {
    uid: parsed.uid,
    method,
    sequence: parsed.sequence ?? 0,
    summary: parsed.summary,
    description: parsed.description,
    location: parsed.location,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    isAllDay: parsed.isAllDay,
    status: parsed.status,
    organizerEmail: parsed.organizerEmail,
    organizerName,
    attendees,
    icalData: trimmed,
    rsvpStatus: "needs-action",
  };
}

/**
 * Persist a parsed invite keyed by (account, uid, method). Returns the stored row.
 */
export async function storeInvite(params: {
  accountId: string;
  messageId: string;
  threadId: string | null;
  invite: CalendarInvite;
}): Promise<DbCalendarInvite> {
  const { accountId, messageId, threadId, invite } = params;
  await upsertCalendarInvite({
    accountId,
    messageId,
    threadId,
    uid: invite.uid,
    method: invite.method,
    sequence: invite.sequence,
    summary: invite.summary,
    description: invite.description,
    location: invite.location,
    startTime: String(invite.startTime),
    endTime: String(invite.endTime),
    isAllDay: invite.isAllDay,
    organizerEmail: invite.organizerEmail,
    organizerName: invite.organizerName,
    attendeesJson: invite.attendees.length > 0 ? JSON.stringify(invite.attendees) : null,
    icalData: invite.icalData,
  });
  const row = await getInviteByMessage(accountId, messageId);
  return row!;
}

/**
 * Convenience used during mail sync: parse a raw ICS payload and upsert it into
 * `calendar_invites`. Returns null when the payload isn't a valid
 * VEVENT/VCALENDAR. Keeping this out of the hot sync path's error surface means
 * a malformed invite never aborts a message's other writes.
 */
export async function persistInviteFromRawIcs(params: {
  accountId: string;
  messageId: string;
  threadId: string | null;
  rawIcs: string;
}): Promise<DbCalendarInvite | null> {
  const invite = parseCalendarInvite(params.rawIcs);
  if (!invite) return null;
  return storeInvite({
    accountId: params.accountId,
    messageId: params.messageId,
    threadId: params.threadId,
    invite,
  });
}
