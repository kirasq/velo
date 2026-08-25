import { useState } from "react";
import { Calendar, MapPin, Clock, User, Check, HelpCircle, X } from "lucide-react";
import type { DbCalendarInvite } from "@/services/db/calendarInvites";
import { parseCalendarInvite, type CalendarInvite } from "@/services/calendar/inviteExtractor";
import { respondToInvite, type RsvpResponse } from "@/services/calendar/inviteService";
import { getAccount } from "@/services/db/accounts";

interface Props {
  inviteRow: DbCalendarInvite;
  accountId: string;
}

const RSVP_LABEL: Record<string, string> = {
  "needs-action": "Not yet responded",
  accepted: "Accepted",
  tentative: "Tentative",
  declined: "Declined",
  canceled: "Canceled",
};

export function MeetingInviteCard({ inviteRow, accountId }: Props) {
  const parsed = parseCalendarInvite(inviteRow.ical_data ?? "");
  if (!parsed) return null;
  // Captured as a non-null type so closures (handle/onClick) keep the type.
  const invite: CalendarInvite = parsed;
  const [rsvp, setRsvp] = useState<string>(inviteRow.rsvp_status);
  const [busy, setBusy] = useState<RsvpResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!invite) return null;

  const start = new Date(invite.startTime * 1000);
  const end = new Date(invite.endTime * 1000);
  const fmt = (d: Date) =>
    d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  const timeText = invite.isAllDay
    ? `${fmt(start)} (all day)`
    : `${fmt(start)} – ${fmt(end)}`;

  const methodLabel =
    invite.method === "CANCEL"
      ? "Meeting canceled"
      : invite.method === "REPLY"
        ? "Response received"
        : "Meeting invitation";

  const isCanceled = invite.method === "CANCEL" || rsvp === "canceled";
  const responded = rsvp !== "needs-action";

  async function handle(response: RsvpResponse) {
    setBusy(response);
    setError(null);
    try {
      const account = await getAccount(accountId);
      const attendeeEmail = account?.email ?? invite.organizerEmail ?? "";
      await respondToInvite({
        accountId,
        invite,
        attendeeEmail,
        response,
        organizerEmail: invite.organizerEmail,
        subject: invite.summary,
      });
      setRsvp(response);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send response");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className={`mx-6 mb-3 rounded-lg border p-4 ${
        isCanceled
          ? "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/30"
          : "border-blue-300 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            isCanceled ? "bg-red-100 text-red-600" : "bg-blue-100 text-blue-600"
          }`}
        >
          <Calendar size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
              {methodLabel}
            </p>
            {responded && (
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  rsvp === "accepted"
                    ? "bg-green-100 text-green-700"
                    : rsvp === "tentative"
                      ? "bg-amber-100 text-amber-700"
                      : rsvp === "declined" || rsvp === "canceled"
                        ? "bg-red-100 text-red-700"
                        : "bg-gray-100 text-gray-700"
                }`}
              >
                {RSVP_LABEL[rsvp] ?? rsvp}
              </span>
            )}
          </div>

          <h3 className="mt-0.5 truncate text-base font-semibold text-text-primary">
            {invite.summary ?? "(No subject)"}
          </h3>

          <div className="mt-2 space-y-1 text-sm text-text-secondary">
            <div className="flex items-center gap-2">
              <Clock size={14} className="shrink-0 text-text-tertiary" />
              <span>{timeText}</span>
            </div>
            {invite.location && (
              <div className="flex items-center gap-2">
                <MapPin size={14} className="shrink-0 text-text-tertiary" />
                <span className="truncate">{invite.location}</span>
              </div>
            )}
            {invite.organizerEmail && (
              <div className="flex items-center gap-2">
                <User size={14} className="shrink-0 text-text-tertiary" />
                <span className="truncate">
                  {invite.organizerName ?? invite.organizerEmail}
                </span>
              </div>
            )}
            {invite.attendees.length > 0 && (
              <div className="flex items-center gap-2">
                <User size={14} className="shrink-0 text-text-tertiary" />
                <span className="truncate">
                  {invite.attendees.length} attendee
                  {invite.attendees.length !== 1 ? "s" : ""}
                  {invite.attendees
                    .slice(0, 3)
                    .map((a) => a.displayName ?? a.email)
                    .join(", ")}
                  {invite.attendees.length > 3 ? "…" : ""}
                </span>
              </div>
            )}
          </div>

          {error && (
            <p className="mt-2 text-xs text-red-600">Response failed: {error}</p>
          )}

          {!isCanceled && (
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => handle("accepted")}
                className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                <Check size={14} />
                {busy === "accepted" ? "…" : "Accept"}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => handle("tentative")}
                className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
              >
                <HelpCircle size={14} />
                {busy === "tentative" ? "…" : "Maybe"}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => handle("declined")}
                className="inline-flex items-center gap-1 rounded-md bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
              >
                <X size={14} />
                {busy === "declined" ? "…" : "Decline"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
