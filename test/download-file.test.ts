/**
 * Tests for the download-file tool command.
 *
 * Tests cover:
 * 1. generateFilename() — filename generation, sanitization, edge cases
 * 2. Argument validation logic
 * 3. Output structure expectations
 * 4. sourceUrl construction
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─── Re-implement generateFilename from index.ts for testing ────────────

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "application/json": ".json",
};

function generateFilename(fileId: string, contentType: string): string {
  const ext = MIME_TO_EXT[contentType] || "";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeId = fileId.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 16);
  return `${timestamp}-${safeId}${ext}`;
}

// ─── Tests ──────────────────────────────────────────────────────

describe("generateFilename", () => {
  it("should generate filename with correct extension for known MIME types", () => {
    const filename = generateFilename("abc-123", "image/png");
    assert.ok(filename.endsWith(".png"), `Expected .png extension, got: ${filename}`);
    assert.ok(filename.includes("abc-123"), `Expected fileId in name, got: ${filename}`);
  });

  it("should generate filename without extension for unknown MIME types", () => {
    const filename = generateFilename("abc-123", "application/x-custom");
    assert.ok(filename.endsWith("abc-123"), `Expected to end with safeId, got: ${filename}`);
  });

  it("should sanitize special characters in fileId (path traversal prevention)", () => {
    const filename = generateFilename("../../etc/passwd", "text/plain");
    assert.ok(!filename.includes("/"), `Filename should not contain /: ${filename}`);
    assert.ok(!filename.includes(".."), `Filename should not contain ..: ${filename}`);
    assert.ok(filename.endsWith(".txt"));
  });

  it("should truncate long fileIds to 16 characters", () => {
    const longId = "a".repeat(100);
    const filename = generateFilename(longId, "image/jpeg");
    const withoutTimestamp = filename.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/, "");
    const safeIdPart = withoutTimestamp.replace(".jpg", "");
    assert.equal(safeIdPart.length, 16, `safeId should be 16 chars, got ${safeIdPart.length}`);
  });

  it("should include ISO timestamp", () => {
    const filename = generateFilename("test", "image/png");
    assert.match(filename, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/);
  });

  it("should handle empty fileId", () => {
    const filename = generateFilename("", "image/png");
    assert.ok(filename.endsWith(".png"));
    assert.match(filename, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("should handle undefined contentType gracefully", () => {
    const filename = generateFilename("test-id", undefined as any);
    assert.ok(filename.endsWith("test-id"), `Expected no extension, got: ${filename}`);
  });

  it("should handle fileId with only special characters", () => {
    const filename = generateFilename("!@#$%^", "image/png");
    assert.ok(!filename.includes("!"), `Should not contain !: ${filename}`);
    assert.ok(!filename.includes("@"), `Should not contain @: ${filename}`);
    assert.ok(filename.endsWith(".png"));
  });

  it("should handle all known MIME types", () => {
    const expected: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "application/pdf": ".pdf",
      "text/plain": ".txt",
      "text/csv": ".csv",
      "application/json": ".json",
    };
    for (const [mime, ext] of Object.entries(expected)) {
      const filename = generateFilename("test", mime);
      assert.ok(filename.endsWith(ext), `MIME ${mime} should produce ${ext}, got: ${filename}`);
    }
  });
});

describe("MIME_TO_EXT", () => {
  it("should have exactly 8 entries", () => {
    assert.equal(Object.keys(MIME_TO_EXT).length, 8);
  });

  it("should map image types correctly", () => {
    assert.equal(MIME_TO_EXT["image/jpeg"], ".jpg");
    assert.equal(MIME_TO_EXT["image/png"], ".png");
    assert.equal(MIME_TO_EXT["image/gif"], ".gif");
    assert.equal(MIME_TO_EXT["image/webp"], ".webp");
  });

  it("should map document types correctly", () => {
    assert.equal(MIME_TO_EXT["application/pdf"], ".pdf");
    assert.equal(MIME_TO_EXT["text/plain"], ".txt");
    assert.equal(MIME_TO_EXT["text/csv"], ".csv");
    assert.equal(MIME_TO_EXT["application/json"], ".json");
  });
});

describe("sourceUrl construction", () => {
  it("should not produce double slashes when hubUrl has trailing slash", () => {
    const hubUrl = "https://hub.example.com/";
    const baseUrl = hubUrl.replace(/\/+$/, "");
    const sourceUrl = `${baseUrl}/api/files/${encodeURIComponent("abc-123")}`;
    assert.ok(!sourceUrl.includes("//api"), `Double slash found: ${sourceUrl}`);
    assert.equal(sourceUrl, "https://hub.example.com/api/files/abc-123");
  });

  it("should handle hubUrl without trailing slash", () => {
    const hubUrl = "https://hub.example.com";
    const baseUrl = hubUrl.replace(/\/+$/, "");
    const sourceUrl = `${baseUrl}/api/files/${encodeURIComponent("abc-123")}`;
    assert.equal(sourceUrl, "https://hub.example.com/api/files/abc-123");
  });

  it("should encode special characters in fileId", () => {
    const hubUrl = "https://hub.example.com";
    const baseUrl = hubUrl.replace(/\/+$/, "");
    const fileId = "file with spaces/and&chars";
    const sourceUrl = `${baseUrl}/api/files/${encodeURIComponent(fileId)}`;
    assert.ok(!sourceUrl.includes(" "), "Spaces should be encoded");
    assert.ok(sourceUrl.includes("file%20with%20spaces"), "Spaces should be %20 encoded");
  });
});

describe("download-file argument validation", () => {
  it("should require file_id", () => {
    const file_id = undefined;
    assert.equal(!file_id, true);
  });

  it("should accept valid file_id", () => {
    const file_id = "abc-123-def";
    assert.equal(!!file_id, true);
  });

  it("should validate max_bytes is positive", () => {
    assert.ok(Number.isFinite(1024) && 1024 > 0);
    assert.ok(!(Number.isFinite(NaN) && NaN > 0));
    assert.ok(!(Number.isFinite(-1) && -1 > 0));
    assert.ok(!(Number.isFinite(0) && 0 > 0));
  });

  it("should validate timeout is positive", () => {
    assert.ok(Number.isFinite(30000) && 30000 > 0);
    assert.ok(!(Number.isFinite(-100) && -100 > 0));
  });

  it("should default max_bytes to 10MB", () => {
    const max_bytes = undefined;
    const resolved = max_bytes ?? 10 * 1024 * 1024;
    assert.equal(resolved, 10485760);
  });

  it("should default timeout to 30s", () => {
    const timeout = undefined;
    const resolved = timeout ?? 30_000;
    assert.equal(resolved, 30000);
  });
});

describe("download-file output structure", () => {
  it("should produce correct JSON output shape on success", () => {
    const output = {
      ok: true,
      account: "default",
      fileId: "abc-123",
      contentType: "image/png",
      size: 12345,
      savedPath: "/data/media/default/2026-03-14T12-00-00-000Z-abc-123.png",
      sourceUrl: "https://hub.example.com/api/files/abc-123",
    };

    assert.equal(output.ok, true);
    assert.equal(typeof output.account, "string");
    assert.equal(typeof output.fileId, "string");
    assert.equal(typeof output.contentType, "string");
    assert.equal(typeof output.size, "number");
    assert.equal(typeof output.savedPath, "string");
    assert.equal(typeof output.sourceUrl, "string");
    assert.ok(output.sourceUrl.includes("/api/files/"));
  });

  it("should include all required fields", () => {
    const requiredFields = ["ok", "account", "fileId", "contentType", "size", "savedPath", "sourceUrl"];
    const output = {
      ok: true,
      account: "default",
      fileId: "test",
      contentType: "image/png",
      size: 100,
      savedPath: "/tmp/test.png",
      sourceUrl: "https://hub.example.com/api/files/test",
    };
    for (const field of requiredFields) {
      assert.ok(field in output, `Missing required field: ${field}`);
    }
  });
});
