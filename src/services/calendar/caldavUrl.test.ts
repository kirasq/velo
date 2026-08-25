import { describe, it, expect } from "vitest";
import { normalizeCalDavUrl, parseCalDavHost } from "./caldavUrl";

describe("normalizeCalDavUrl", () => {
  it("prepends https:// to bare host:port", () => {
    expect(normalizeCalDavUrl("imail.isoftstone.com:443")).toBe(
      "https://imail.isoftstone.com:443",
    );
  });

  it("preserves https:// URLs", () => {
    expect(normalizeCalDavUrl("https://caldav.example.com/")).toBe(
      "https://caldav.example.com/",
    );
  });

  it("preserves http:// URLs", () => {
    expect(normalizeCalDavUrl("http://internal.caldav.local")).toBe(
      "http://internal.caldav.local",
    );
  });

  it("converts protocol-relative URLs to https", () => {
    expect(normalizeCalDavUrl("//caldav.example.com")).toBe(
      "https://caldav.example.com",
    );
  });

  it("trims whitespace", () => {
    expect(normalizeCalDavUrl("  imail.isoftstone.com:443  ")).toBe(
      "https://imail.isoftstone.com:443",
    );
  });

  it("returns null for empty input", () => {
    expect(normalizeCalDavUrl("")).toBeNull();
    expect(normalizeCalDavUrl("   ")).toBeNull();
  });
});

describe("parseCalDavHost", () => {
  it("extracts the hostname", () => {
    expect(parseCalDavHost("https://imail.isoftstone.com:443/caldav")).toBe(
      "imail.isoftstone.com",
    );
  });

  it("returns null for invalid URLs", () => {
    expect(parseCalDavHost("not a url")).toBeNull();
  });
});
