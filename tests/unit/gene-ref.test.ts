import { describe, it, expect } from "vitest";
import { parseGeneRef, parseUserRef } from "../../src/cloud/gene-ref.js";

describe("parseGeneRef", () => {
  it("recognizes lowercase UUID", () => {
    const ref = parseGeneRef("11111111-2222-3333-4444-555555555555");
    expect(ref.kind).toBe("uuid");
    if (ref.kind === "uuid") expect(ref.raw).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("recognizes uppercase UUID", () => {
    const ref = parseGeneRef("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
    expect(ref.kind).toBe("uuid");
  });

  it("recognizes 64-hex content hash", () => {
    const hash = "a".repeat(64);
    const ref = parseGeneRef(hash);
    expect(ref.kind).toBe("contentHash");
    if (ref.kind === "contentHash") expect(ref.raw).toBe(hash);
  });

  it("does NOT treat 32-hex as content hash (must be 64)", () => {
    const ref = parseGeneRef("a".repeat(32));
    expect(ref.kind).toBe("name");
  });

  it("parses @owner/name into kind ownerName", () => {
    const ref = parseGeneRef("@xiaoba-dev/scope-cli-2026");
    expect(ref.kind).toBe("ownerName");
    if (ref.kind === "ownerName") {
      expect(ref.owner).toBe("xiaoba-dev");
      expect(ref.name).toBe("scope-cli-2026");
      expect(ref.raw).toBe("@xiaoba-dev/scope-cli-2026");
    }
  });

  it("parses @owner/name with dots and dashes in name", () => {
    const ref = parseGeneRef("@alice/my-gene.v2");
    expect(ref.kind).toBe("ownerName");
    if (ref.kind === "ownerName") {
      expect(ref.owner).toBe("alice");
      expect(ref.name).toBe("my-gene.v2");
    }
  });

  it("treats input with no leading @ as plain name even when it has a slash", () => {
    // gene names should not contain `/`; this is a defensive choice — a
    // user typing `xiaoba-dev/foo` (forgot the @) is more likely making a
    // typo than referring to a literal gene named with a slash, but we
    // don't try to be clever: it falls through to `kind: name`.
    const ref = parseGeneRef("xiaoba-dev/foo");
    expect(ref.kind).toBe("name");
  });

  it("treats single-segment @user as plain name (no embedded slash → not ownerName)", () => {
    const ref = parseGeneRef("@xiaoba-dev");
    expect(ref.kind).toBe("name");
  });

  it("rejects empty @ / @owner with no name", () => {
    expect(parseGeneRef("@").kind).toBe("name");
    expect(parseGeneRef("@owner/").kind).toBe("name");
    expect(parseGeneRef("@/name").kind).toBe("name");
  });

  it("trims whitespace before classifying", () => {
    const ref = parseGeneRef("  @alice/foo  ");
    expect(ref.kind).toBe("ownerName");
    if (ref.kind === "ownerName") expect(ref.name).toBe("foo");
  });

  it("falls back to plain name for ordinary gene names", () => {
    const ref = parseGeneRef("citation-manager");
    expect(ref.kind).toBe("name");
    if (ref.kind === "name") expect(ref.raw).toBe("citation-manager");
  });
});

describe("parseUserRef", () => {
  it("parses @username", () => {
    const ref = parseUserRef("@alice");
    expect(ref).toEqual({ username: "alice" });
  });

  it("parses @username with dashes and digits", () => {
    expect(parseUserRef("@xiaoba-dev")).toEqual({ username: "xiaoba-dev" });
    expect(parseUserRef("@user42")).toEqual({ username: "user42" });
  });

  it("returns null for @owner/name (caller should use parseGeneRef instead)", () => {
    expect(parseUserRef("@alice/foo")).toBeNull();
  });

  it("returns null for plain name (no @)", () => {
    expect(parseUserRef("alice")).toBeNull();
  });

  it("returns null for bare @", () => {
    expect(parseUserRef("@")).toBeNull();
  });

  it("trims whitespace", () => {
    expect(parseUserRef("  @alice  ")).toEqual({ username: "alice" });
  });
});
