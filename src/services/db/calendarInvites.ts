import { getDb } from "./connection";

export type RsvpStatus = "needs-action" | "accepted" | "tentative" | "declined" | "canceled";

export interface DbCalendarInvite {
  id: number;
  account_id: string;
  message_id: string | null;
  thread_id: string | null;
  uid: string;
  method: string | null;
  sequence: number;
  summary: string | null;
  description: string | null;
  location: string | null;
  start_time: string | null;
  end_time: string | null;
  is_all_day: number;
  organizer_email: string | null;
  organizer_name: string | null;
  attendees_json: string | null;
  ical_data: string | null;
  rsvp_status: string;
  created_at: string | null;
}

/**
 * Upsert a parsed calendar invite. Uses (account_id, uid, method) as the
 * business key so repeated updates of the same invite collapse to one row,
 * with the highest SEQUENCE winning.
 */
export async function upsertCalendarInvite(inv: {
  accountId: string;
  messageId: string | null;
  threadId: string | null;
  uid: string;
  method: string | null;
  sequence: number;
  summary: string | null;
  description: string | null;
  location: string | null;
  startTime: string | null;
  endTime: string | null;
  isAllDay: boolean;
  organizerEmail: string | null;
  organizerName: string | null;
  attendeesJson: string | null;
  icalData: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO calendar_invites
       (account_id, message_id, thread_id, uid, method, sequence, summary, description,
        location, start_time, end_time, is_all_day, organizer_email, organizer_name,
        attendees_json, ical_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT(account_id, uid, method) DO UPDATE SET
       sequence = CASE WHEN excluded.sequence > calendar_invites.sequence
                       THEN excluded.sequence ELSE calendar_invites.sequence END,
       message_id = excluded.message_id,
       thread_id = excluded.thread_id,
       summary = excluded.summary,
       description = excluded.description,
       location = excluded.location,
       start_time = excluded.start_time,
       end_time = excluded.end_time,
       is_all_day = excluded.is_all_day,
       organizer_email = excluded.organizer_email,
       organizer_name = excluded.organizer_name,
       attendees_json = excluded.attendees_json,
       ical_data = excluded.ical_data`,
    [
      inv.accountId,
      inv.messageId,
      inv.threadId,
      inv.uid,
      inv.method,
      inv.sequence,
      inv.summary,
      inv.description,
      inv.location,
      inv.startTime,
      inv.endTime,
      inv.isAllDay ? 1 : 0,
      inv.organizerEmail,
      inv.organizerName,
      inv.attendeesJson,
      inv.icalData,
    ],
  );
}

export async function getInviteByMessage(
  accountId: string,
  messageId: string,
): Promise<DbCalendarInvite | null> {
  const db = await getDb();
  const rows = await db.select<DbCalendarInvite[]>(
    "SELECT * FROM calendar_invites WHERE account_id = $1 AND message_id = $2 LIMIT 1",
    [accountId, messageId],
  );
  return rows[0] ?? null;
}

export async function getInvitesForAccount(
  accountId: string,
): Promise<DbCalendarInvite[]> {
  const db = await getDb();
  return db.select<DbCalendarInvite[]>(
    "SELECT * FROM calendar_invites WHERE account_id = $1 ORDER BY created_at DESC",
    [accountId],
  );
}

export async function setInviteRsvp(
  accountId: string,
  uid: string,
  method: string | null,
  rsvpStatus: RsvpStatus,
): Promise<void> {
  const db = await getDb();
  if (method === null) {
    await db.execute(
      "UPDATE calendar_invites SET rsvp_status = $1 WHERE account_id = $2 AND uid = $3 AND method IS NULL",
      [rsvpStatus, accountId, uid],
    );
  } else {
    await db.execute(
      "UPDATE calendar_invites SET rsvp_status = $1 WHERE account_id = $2 AND uid = $3 AND method = $4",
      [rsvpStatus, accountId, uid, method],
    );
  }
}
