import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface CpuRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  cancelled?: boolean;
}

interface ProcessCancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested?: (listener: () => void) => { dispose(): void };
}

export async function runCpuSimulator(
  scriptPath: string,
  assemblyPath: string,
  cwd: string,
  timeoutMs = 60_000,
  token?: ProcessCancellationToken,
): Promise<CpuRunResult> {
  if (!existsSync(scriptPath)) {
    return { ok: false, stdout: "", stderr: "", error: `CPU simulator entrypoint not found: ${scriptPath}` };
  }
  if (!existsSync(assemblyPath)) {
    return { ok: false, stdout: "", stderr: "", error: `compiled assembly file not found: ${assemblyPath}` };
  }
  const result = await runProcess("python", [scriptPath, assemblyPath], cwd, timeoutMs, token);
  return {
    ok: result.code === 0 && !result.cancelled,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.cancelled ? "CPU simulator cancelled" : result.code === 0 ? undefined : result.timedOut ? `CPU simulator timed out after ${timeoutMs}ms` : `CPU simulator exited with code ${result.code}`,
    cancelled: result.cancelled,
  };
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  token?: ProcessCancellationToken,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean }> {
  return new Promise((resolvePromise) => {
    if (token?.isCancellationRequested) {
      resolvePromise({ code: null, stdout: "", stderr: "", timedOut: false, cancelled: true });
      return;
    }
    const child = spawn(command, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const cancellation = token?.onCancellationRequested?.(() => {
      if (settled) {
        return;
      }
      cancelled = true;
      clearTimeout(timer);
      child.kill();
    });
    const settle = (code: number | null, nextStderr = stderr) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cancellation?.dispose();
      resolvePromise({ code, stdout, stderr: nextStderr, timedOut, cancelled });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      settle(-1, `${stderr}${error.message}`);
    });
    child.on("close", (code) => {
      settle(code);
    });
  });
}
