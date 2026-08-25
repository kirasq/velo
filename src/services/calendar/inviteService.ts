import { buildRawEmail } from "@/utils/emailBuilder";
import { sendEmail } from "@/services/emailActions";
import { setInviteRsvp } from "@/services/db/calendarInvites";
import type { CalendarInvite } from "./inviteExtractor";

export type RsvpResponse = "accepted" | "tentative" | "declined";

const PARTSTAT: Record<RsvpResponse, string> = {
  accepted: "ACCEPTED",
  tentative: "TENTATIVE",
  declined: "DECLINED",
};

/**
 * Build a minimal ITIP `method=REPLY` iCalendar payload for an attendee's
 * response to an invite. This is the standard way to notify the organizer.
 */
export function buildReplyIcs(
  invite: CalendarInvite,
  attendeeEmail: string,
  response: RsvpResponse,
): string {
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dtstart = new Date(invite.startTime * 1000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dtend = new Date(invite.endTime * 1000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Velo Mail//CalDAV Client//EN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${invite.uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SEQUENCE:${invite.sequence}`,
    `SUMMARY:${invite.summary ?? ""}`,
    `ORGANIZER;CN=${invite.organizerName ?? invite.organizerEmail ?? "Organizer"}:mailto:${invite.organizerEmail ?? ""}`,
    `ATTENDEE;CN=${attendeeEmail};PARTSTAT=${PARTSTAT[response]};RSVP=TRUE:mailto:${attendeeEmail}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Respond to an invite: persist the RSVP locally and send a `method=REPLY`
 * email back to the organizer via the app's normal send path. Acceptance is
 * reflected locally; the organizer is also notified (standard client UX).
 */
export async function respondToInvite(params: {
  accountId: string;
  invite: CalendarInvite;
  attendeeEmail: string;
  response: RsvpResponse;
  organizerEmail: string | null;
  subject: string | null;
}): Promise<void> {
  const { accountId, invite, attendeeEmail, response, organizerEmail, subject } = params;

  await setInviteRsvp(accountId, invite.uid, invite.method, response);

  if (!organizerEmail) return;

  const replyIcs = buildReplyIcs(invite, attendeeEmail, response);
  const displaySubject = subject ?? invite.summary ?? "Meeting";
  const htmlBody = `<p>You have been invited to <b>${escapeHtml(invite.summary ?? "(no subject)")}</b>.</p><p>Response: <b>${PARTSTAT[response]}</b></p>`;

  const raw = buildRawEmail({
    from: attendeeEmail,
    to: [organizerEmail],
    subject: `Re: ${displaySubject}`,
    htmlBody,
    attachments: [
      {
        filename: "reply.ics",
        mimeType: 'text/calendar; method=REPLY; charset="utf-8"',
        content: utf8ToBase64(replyIcs),
      },
    ],
  });

  await sendEmail(accountId, raw);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
