/**
 * Security regression tests for source capture (command injection + SSRF).
 *
 * - markitdown extraction must run without a shell, passing the source as a
 *   discrete argv element (no `sh -c` string interpolation).
 * - captureUrl must reject non-HTTP(S) schemes and loopback/link-local hosts
 *   before any fetch happens.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureFile,
  captureUrl,
} from "../extensions/llm-wiki/lib/source-packet.js";
import {
  assertFetchableUrl,
  ensureVaultStructure,
  getVaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

describe("source capture security", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      import.meta.dirname,
      "..",
      "tmp",
      `capture-sec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function makePaths() {
    const p = getVaultPaths(
      join(tmpDir, `wiki-${Math.random().toString(36).slice(2)}`),
    );
    ensureVaultStructure(p);
    return p;
  }

  describe("assertFetchableUrl (SSRF scheme allowlist)", () => {
    it("allows http and https", () => {
      expect(() => assertFetchableUrl("http://example.com")).not.toThrow();
      expect(() =>
        assertFetchableUrl("https://example.com/a/b?c=d"),
      ).not.toThrow();
    });

    it("allows RFC1918 private hosts (intranet capture stays possible)", () => {
      expect(() => assertFetchableUrl("http://192.168.1.10/doc")).not.toThrow();
      expect(() => assertFetchableUrl("http://10.0.0.5/doc")).not.toThrow();
    });

    it("rejects non-HTTP(S) schemes", () => {
      for (const u of [
        "file:///etc/passwd",
        "gopher://x/",
        "dict://x/",
        "ftp://x/f",
        "data:text/plain,hi",
      ]) {
        expect(() => assertFetchableUrl(u), u).toThrow();
      }
    });

    it("rejects loopback and link-local hosts", () => {
      for (const u of [
        "http://localhost/x",
        "http://127.0.0.1/x",
        "https://[::1]/x",
        "http://169.254.169.254/latest/meta-data/",
      ]) {
        expect(() => assertFetchableUrl(u), u).toThrow();
      }
    });

    it("rejects malformed URLs", () => {
      expect(() => assertFetchableUrl("not a url")).toThrow();
    });
  });

  describe("captureUrl", () => {
    it("refuses a file:// URL before any fetch", async () => {
      const paths = makePaths();
      const pi = {
        exec: async () => {
          throw new Error("exec must not run for a blocked URL");
        },
      };
      await expect(
        captureUrl(pi as never, paths, "file:///etc/passwd"),
      ).rejects.toThrow(/http/i);
    });
  });

  describe("markitdown extraction is injection-safe", () => {
    it("passes the source as a discrete argv element, never through a shell", async () => {
      const paths = makePaths();
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const pi = {
        exec: async (cmd: string, args: string[]) => {
          calls.push({ cmd, args });
          if (cmd === "which")
            return { stdout: "/usr/bin/uvx\n", stderr: "", code: 0 };
          if (cmd === "uvx")
            return { stdout: "# Extracted\n", stderr: "", code: 0 };
          if (cmd === "cp") return { stdout: "", stderr: "", code: 0 };
          return { stdout: "", stderr: "", code: 0 };
        },
      };
      // A .pdf path routes through markitdown; the crafted name would break a
      // shell if it were interpolated into `sh -c`.
      const evil = '/tmp/eviltitle"; touch /tmp/pwned #.pdf';
      await captureFile(pi as never, paths, evil);

      expect(calls.some((c) => c.cmd === "sh")).toBe(false);
      const uvx = calls.find((c) => c.cmd === "uvx");
      expect(uvx).toBeDefined();
      expect(uvx?.args).toContain(evil);
    });
  });
});
