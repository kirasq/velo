import { DAVClient, type DAVCalendar, type DAVObject } from "tsdav";
import type {
  CalendarProvider,
  CalendarProviderType,
  CalendarInfo,
  CalendarEventData,
  CalendarSyncResult,
  CreateEventInput,
  UpdateEventInput,
} from "./types";
import { generateVEvent, parseVEvent } from "./icalHelper";
import { normalizeCalDavUrl } from "./caldavUrl";
import { davFetch } from "./davFetch";
import { getAccount } from "@/services/db/accounts";

export class CalDAVProvider implements CalendarProvider {
  readonly type: CalendarProviderType = "caldav";
  private client: DAVClient | null = null;

  constructor(readonly accountId: string) {}

  private async getClient(): Promise<DAVClient> {
    if (this.client) return this.client;

    const account = await getAccount(this.accountId);
    if (!account) throw new Error("Account not found");

    const rawServerUrl = account.caldav_url;
    const username = account.caldav_username ?? account.email;
    const password = account.caldav_password;

    if (!rawServerUrl || !password) {
      throw new Error("CalDAV credentials not configured");
    }

    const serverUrl = normalizeCalDavUrl(rawServerUrl);
    if (!serverUrl) {
      throw new Error("CalDAV server URL cannot be parsed");
    }

    this.client = new DAVClient({
      serverUrl,
      credentials: { username, password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
      // Route through Rust (reqwest) to bypass WebView CORS.
      fetch: davFetch as unknown as typeof globalThis.fetch,
    });

    await this.client.login();
    return this.client;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const client = await this.getClient();
    const calendars = await client.fetchCalendars();

    return calendars.map((cal, index) => ({
      remoteId: cal.url,
      displayName: typeof cal.displayName === "string" ? cal.displayName : `Calendar ${index + 1}`,
      color: extractCalendarColor(cal) ?? null,
      isPrimary: index === 0,
    }));
  }

  async fetchEvents(calendarRemoteId: string, timeMin: string, timeMax: string): Promise<CalendarEventData[]> {
    let objects = await this.fetchObjectsWithRange(calendarRemoteId, timeMin, timeMax);

    // Some CalDAV servers (e.g. Nextcloud) mishandle the time-range
    // calendar-query and return an empty set even when events exist.
    // Fall back to a full fetch (no time filter) when the range query
    // yields nothing, so the calendar still populates.
    if (!objects || objects.length === 0) {
      objects = await this.fetchAllObjects(calendarRemoteId);
    }

    return objects
      .filter((obj) => obj.data)
      .map((obj) => {
        const event = parseVEvent(obj.data!, obj.url);
        event.etag = obj.etag ?? null;
        return event;
      });
  }

  private async fetchObjectsWithRange(
    calendarRemoteId: string,
    timeMin: string,
    timeMax: string,
  ): Promise<DAVObject[]> {
    const client = await this.getClient();
    try {
      return await client.fetchCalendarObjects({
        calendar: { url: calendarRemoteId } as DAVCalendar,
        timeRange: {
          start: timeMin,
          end: timeMax,
        },
      });
    } catch (err) {
      console.warn("CalDAV time-range query failed, falling back to full fetch:", err);
      return [];
    }
  }

  private async fetchAllObjects(calendarRemoteId: string): Promise<DAVObject[]> {
    const client = await this.getClient();
    return client.fetchCalendarObjects({
      calendar: { url: calendarRemoteId } as DAVCalendar,
    });
  }

  async createEvent(calendarRemoteId: string, event: CreateEventInput): Promise<CalendarEventData> {
    const client = await this.getClient();
    const uid = crypto.randomUUID();
    const icalData = generateVEvent(event, uid);
    const filename = `${uid}.ics`;

    await client.createCalendarObject({
      calendar: { url: calendarRemoteId } as DAVCalendar,
      filename,
      iCalString: icalData,
    });

    const parsed = parseVEvent(icalData, `${calendarRemoteId}${filename}`);
    return parsed;
  }

  async updateEvent(
    calendarRemoteId: string,
    remoteEventId: string,
    event: UpdateEventInput,
    etag?: string,
  ): Promise<CalendarEventData> {
    const client = await this.getClient();

    // Fetch the existing object to get its current data
    const objects = await client.fetchCalendarObjects({
      calendar: { url: calendarRemoteId } as DAVCalendar,
      objectUrls: [remoteEventId],
    });

    const existing = objects[0];
    if (!existing?.data) throw new Error("Event not found on server");

    // Parse existing, merge updates, regenerate
    const parsed = parseVEvent(existing.data, remoteEventId);
    const merged: CreateEventInput = {
      summary: event.summary ?? parsed.summary ?? "",
      description: event.description ?? parsed.description ?? undefined,
      location: event.location ?? parsed.location ?? undefined,
      startTime: event.startTime ?? new Date(parsed.startTime * 1000).toISOString(),
      endTime: event.endTime ?? new Date(parsed.endTime * 1000).toISOString(),
      isAllDay: event.isAllDay ?? parsed.isAllDay,
    };

    const icalData = generateVEvent(merged, parsed.uid ?? undefined);

    const headers: Record<string, string> = {};
    if (etag) headers["If-Match"] = etag;

    await client.updateCalendarObject({
      calendarObject: {
        url: remoteEventId,
        data: icalData,
        etag: etag ?? existing.etag ?? undefined,
      } as DAVObject,
      headers,
    });

    const result = parseVEvent(icalData, remoteEventId);
    return result;
  }

  async deleteEvent(_calendarRemoteId: string, remoteEventId: string, etag?: string): Promise<void> {
    const client = await this.getClient();

    const headers: Record<string, string> = {};
    if (etag) headers["If-Match"] = etag;

    await client.deleteCalendarObject({
      calendarObject: {
        url: remoteEventId,
        etag: etag ?? undefined,
      } as DAVObject,
      headers,
    });
  }

  async syncEvents(calendarRemoteId: string, _syncToken?: string): Promise<CalendarSyncResult> {
    const client = await this.getClient();
    const created: CalendarEventData[] = [];

    // Full fetch — tsdav's syncCalendars doesn't reliably expose per-object deltas,
    // so we do a time-range fetch and let the DB upsert logic handle deduplication.
    const now = new Date();
    const timeMin = new Date(now);
    timeMin.setDate(timeMin.getDate() - 90);
    const timeMax = new Date(now);
    timeMax.setFullYear(timeMax.getFullYear() + 1);

    const objects = await client.fetchCalendarObjects({
      calendar: { url: calendarRemoteId } as DAVCalendar,
      timeRange: {
        start: timeMin.toISOString(),
        end: timeMax.toISOString(),
      },
    });

    for (const obj of objects) {
      if (obj.data) {
        const event = parseVEvent(obj.data, obj.url);
        event.etag = obj.etag ?? null;
        created.push(event);
      }
    }

    return { created, updated: [], deletedRemoteIds: [], newSyncToken: null, newCtag: null };
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const client = await this.getClient();
      const calendars = await client.fetchCalendars();
      return {
        success: true,
        message: `Connected — found ${calendars.length} calendar${calendars.length !== 1 ? "s" : ""}`,
      };
    } catch (err) {
      // Reset client on failure so next attempt can retry
      this.client = null;
      return { success: false, message: err instanceof Error ? err.message : "Connection failed" };
    }
  }
}

function extractCalendarColor(cal: DAVCalendar): string | null {
  // tsdav may expose calendar-color in props
  const props = cal as unknown as Record<string, unknown>;
  if (typeof props.calendarColor === "string") return props.calendarColor;
  return null;
}
