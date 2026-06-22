import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCpuSimulator } from "../cpuRunner.js";

describe("CPU simulator runner", () => {
  it("times out simulator processes and releases the working directory", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-cpu-runner-"));
    const scriptPath = join(tempRoot, "run.py");
    const assemblyPath = join(tempRoot, "program.de1");

    try {
      writeFileSync(scriptPath, [
        "import time",
        "time.sleep(30)",
      ].join("\n"));
      writeFileSync(assemblyPath, "HLT\n");

      const result = await runCpuSimulator(scriptPath, assemblyPath, tempRoot, 100);
      expect(result).toMatchObject({
        ok: false,
        cancelled: false,
      });
      expect(result.error).toContain("timed out");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
