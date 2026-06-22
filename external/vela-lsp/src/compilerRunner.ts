import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface CompilerRunResult {
  ok: boolean;
  output: string;
  stdout: string;
  stderr: string;
  error?: string;
  cancelled?: boolean;
}

interface ProcessCancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested?: (listener: () => void) => { dispose(): void };
}

export async function runCompiler(
  inputPath: string,
  outputPath: string,
  projectRoot: string,
  compilerRoot: string,
  sourceText?: string,
  token?: ProcessCancellationToken,
): Promise<CompilerRunResult> {
  if (!inputPath || (sourceText === undefined && !existsSync(inputPath))) {
    return { ok: false, output: outputPath, stdout: "", stderr: "", error: `Vela source file not found: ${inputPath}` };
  }
  const mode = sourceText === undefined ? "--disk" : "--stdin";
  const result = await runProcess("python", ["-c", compileScript(), inputPath, outputPath, projectRoot, mode], compilerRoot, sourceText, token);
  return {
    ok: result.code === 0 && !result.cancelled,
    output: outputPath,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.cancelled ? "compiler cancelled" : result.code === 0 ? undefined : `compiler exited with code ${result.code}`,
    cancelled: result.cancelled,
  };
}

function compileScript(): string {
  return [
    "import sys",
    "from pathlib import Path",
    "from src.errors import VelaError",
    "from src.main import compile_source",
    "input_file, output_file, project_root, mode = sys.argv[1:5]",
    "source = sys.stdin.read() if mode == '--stdin' else Path(input_file).read_text(encoding='utf-8')",
    "try:",
    "    asm = compile_source(source, input_file, project_root=project_root)",
    "except VelaError as error:",
    "    print(str(error), file=sys.stderr)",
    "    sys.exit(1)",
    "Path(output_file).parent.mkdir(parents=True, exist_ok=True)",
    "Path(output_file).write_text(asm, encoding='utf-8')",
    "print(f'[velac] Compiled {input_file} -> {output_file}')",
  ].join("\n");
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  input?: string,
  token?: ProcessCancellationToken,
): Promise<{ code: number | null; stdout: string; stderr: string; cancelled: boolean }> {
  return new Promise((resolvePromise) => {
    if (token?.isCancellationRequested) {
      resolvePromise({ code: null, stdout: "", stderr: "", cancelled: true });
      return;
    }
    const child = spawn(command, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let cancelled = false;
    const cancellation = token?.onCancellationRequested?.(() => {
      if (settled) {
        return;
      }
      cancelled = true;
      child.kill();
    });
    const settle = (code: number | null, nextStderr = stderr) => {
      if (settled) {
        return;
      }
      settled = true;
      cancellation?.dispose();
      resolvePromise({ code, stdout, stderr: nextStderr, cancelled });
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
    child.stdin.end(input ?? "");
  });
}
