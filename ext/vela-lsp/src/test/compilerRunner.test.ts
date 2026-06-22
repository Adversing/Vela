import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCompiler } from "../compilerRunner.js";

describe("compiler runner", () => {
  it("compiles supplied in-memory source instead of stale disk contents", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-compile-"));
    const sourcePath = join(tempRoot, "main.vl");
    const staleOutput = join(tempRoot, "stale.de1");
    const memoryOutput = join(tempRoot, "memory.de1");

    try {
      writeFileSync(sourcePath, "module app { U0 main() { ret } }");
      const disk = await runCompiler(sourcePath, staleOutput, tempRoot, resolve("..", ".."));
      expect(disk.ok).toBe(false);

      const memory = await runCompiler(sourcePath, memoryOutput, tempRoot, resolve("..", ".."), "module app { U0 main() { ret; } }");
      expect(memory.ok).toBe(true);
      expect(existsSync(memoryOutput)).toBe(true);
      expect(readFileSync(memoryOutput, "utf8")).toContain("__entry_main");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
