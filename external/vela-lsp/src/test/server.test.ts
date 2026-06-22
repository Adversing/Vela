import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

type JsonRpcId = number | string;
type JsonRpcMessage = { jsonrpc?: "2.0"; id?: JsonRpcId; method?: string; params?: any; result?: any; error?: any };

function encode(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

describe("language server process", () => {
  const root = resolve(".");

  beforeAll(() => {
    execFileSync(process.execPath, [resolve(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], {
      cwd: root,
      stdio: "pipe",
    });
  });

  it("starts over stdio, advertises coherent capabilities, handles commands, and shuts down", async () => {
    const server = new ServerProcess(root);
    try {
      const initialized = await server.initialize();
      const capabilities = initialized.result?.capabilities ?? {};
      expect(capabilities.textDocumentSync).toBe(2);
      expect(capabilities.completionProvider?.triggerCharacters).toEqual(expect.arrayContaining([".", "(", ","]));
      expect(capabilities.executeCommandProvider?.commands).toEqual(expect.arrayContaining([
        "vela.compileCurrentFile",
        "vela.compileWorkspaceEntry",
        "vela.showAssembly",
        "vela.runCurrentProgram",
        "vela.restartServer",
        "vela.dumpSymbolIndex",
      ]));
      expect(capabilities.semanticTokensProvider?.full).toMatchObject({ delta: true });
      expect(capabilities.semanticTokensProvider?.range).toBe(true);
      expect(capabilities.documentColorProvider).toBeUndefined();
      expect(capabilities.inlineValueProvider).toBeUndefined();
      expect(capabilities.linkedEditingRangeProvider).toBeUndefined();
      server.notify("initialized", {});

      const dumpSymbolIndex = await server.request("workspace/executeCommand", { command: "vela.dumpSymbolIndex", arguments: [] });
      expect(dumpSymbolIndex.result?.error).toContain("disabled");
      const runDisabled = await server.request("workspace/executeCommand", { command: "vela.runCurrentProgram", arguments: [] });
      expect(runDisabled.result).toMatchObject({ ok: false });
      expect(runDisabled.result?.error).toContain("vela.cpuSimulatorPath");
      const restart = await server.request("workspace/executeCommand", { command: "vela.restartServer", arguments: [] });
      expect(restart.result).toMatchObject({ restartRequired: true });
      const unknown = await server.request("workspace/executeCommand", { command: "vela.unknown", arguments: [] });
      expect(unknown.result?.error).toContain("unknown Vela command");
    } finally {
      await server.shutdown();
    }
  });

  it("does not advertise optional workspace capabilities when the client omits support", async () => {
    const server = new ServerProcess(root);
    try {
      const initialized = await server.initialize(undefined, {
        fileOperations: false,
        textDocumentContent: false,
      });
      const workspace = initialized.result?.capabilities?.workspace ?? {};
      expect(workspace.fileOperations).toBeUndefined();
      expect(workspace.textDocumentContent).toBeUndefined();
    } finally {
      await server.shutdown();
    }
  });

  it("compiles open document snapshots and serves generated assembly virtual documents", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-server-"));
    const sourcePath = join(tempRoot, "main.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const cpuRoot = join(tempRoot, "fake-cpu");
    const server = new ServerProcess(root);

    try {
      mkdirSync(cpuRoot, { recursive: true });
      writeFileSync(join(cpuRoot, "run.py"), [
        "import sys",
        "from pathlib import Path",
        "asm = Path(sys.argv[1])",
        "print(f'fake simulator ran {asm.name}')",
        "print('assembly exists', asm.exists())",
      ].join("\n"));
      writeFileSync(sourcePath, "module app { U0 main() { ret } }");
      server.setConfiguration({ workspaceEntry: "main.vl", cpuSimulatorPath: "fake-cpu" });
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: sourceUri,
          languageId: "vela",
          version: 1,
          text: "module app { U0 main() { ret; } }",
        },
      });

      const workspaceEntry = await server.request("workspace/executeCommand", { command: "vela.compileWorkspaceEntry", arguments: [] }, 10000);
      expect(workspaceEntry.result).toMatchObject({ ok: true });
      expect(workspaceEntry.result?.output).toMatch(/main\.de1$/);

      const currentFile = await server.request("workspace/executeCommand", { command: "vela.compileCurrentFile", arguments: [sourceUri] }, 10000);
      expect(currentFile.result).toMatchObject({ ok: true });
      expect(currentFile.result?.output).toMatch(/main\.de1$/);

      const virtualCompile = await server.request("workspace/executeCommand", { command: "vela.compileCurrentFile", arguments: ["vela-builtin:/builtins.vl"] });
      expect(virtualCompile.result).toMatchObject({ ok: false });
      expect(virtualCompile.result?.error).toContain("file:// .vl document URI");

      const assemblyRefresh = server.waitForNotification("workspace/textDocumentContent/refresh");
      const assembly = await server.request("workspace/executeCommand", { command: "vela.showAssembly", arguments: [sourceUri] }, 10000);
      expect(assembly.result?.uri).toMatch(/^vela-asm:/);
      expect(assembly.result?.content).toContain("__entry_main");
      expect(assembly.result?.opened).toBe(true);
      expect((await assemblyRefresh).params?.uri).toBe(assembly.result.uri);

      const virtualAssembly = await server.request("workspace/executeCommand", { command: "vela.showAssembly", arguments: ["vela-stdlib:/types/int.vl"] });
      expect(virtualAssembly.result).toMatchObject({ ok: false });
      expect(virtualAssembly.result?.error).toContain("file:// .vl document URI");

      const virtual = await server.request("workspace/textDocumentContent", { uri: assembly.result.uri });
      expect(virtual.result?.text).toBe(assembly.result.content);

      const run = await server.request("workspace/executeCommand", { command: "vela.runCurrentProgram", arguments: [sourceUri] }, 10000);
      expect(run.result).toMatchObject({ ok: true });
      expect(run.result?.assembly).toMatch(/main\.de1$/);
      expect(run.result?.stdout).toContain("fake simulator ran main.de1");
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("cancels compile and run command child processes", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-command-cancel-"));
    const sourcePath = join(tempRoot, "main.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const cpuRoot = join(tempRoot, "slow-cpu");
    const server = new ServerProcess(root);

    try {
      mkdirSync(cpuRoot, { recursive: true });
      writeFileSync(join(cpuRoot, "run.py"), [
        "import time",
        "time.sleep(30)",
      ].join("\n"));
      writeFileSync(sourcePath, "module app { U0 main() { ret; } }");
      server.setConfiguration({ cpuSimulatorPath: "slow-cpu" });
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: sourceUri,
          languageId: "vela",
          version: 1,
          text: "module app { U0 main() { ret; } }",
        },
      });

      const compile = await server.requestAndCancel("workspace/executeCommand", {
        command: "vela.compileCurrentFile",
        arguments: [sourceUri],
      }, 10000);
      expect(compile.result).toEqual({ cancelled: true });

      const run = await server.requestAndCancelAfter("workspace/executeCommand", {
        command: "vela.runCurrentProgram",
        arguments: [sourceUri],
      }, 1000, 10000);
      expect(run.result).toEqual({ cancelled: true });
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("ends compile work-done progress when the compiler reports an error", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-command-progress-"));
    const sourcePath = join(tempRoot, "main.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, "module app { U0 main() { ret; } }");
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: sourceUri,
          languageId: "vela",
          version: 1,
          text: "module app { U0 main() { ret } }",
        },
      });

      const progressEnd = server.waitForNotification("$/progress", (message) =>
        message.params?.value?.kind === "end");
      const compile = await server.request("workspace/executeCommand", {
        command: "vela.compileCurrentFile",
        arguments: [sourceUri],
      }, 10000);

      expect(compile.result).toMatchObject({ ok: false });
      expect(compile.result?.error).toContain("compiler exited");
      await progressEnd;
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("bounds generated assembly virtual document cache to the newest entries", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-virtual-cache-"));
    const server = new ServerProcess(root);

    try {
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      const generatedUris: string[] = [];
      for (let index = 0; index < 17; index++) {
        const sourcePath = join(tempRoot, `program-${index}.vl`);
        writeFileSync(sourcePath, `module app${index} { U0 main() { ret; } }`);
        const result = await server.request("workspace/executeCommand", {
          command: "vela.showAssembly",
          arguments: [pathToFileURL(sourcePath).toString()],
        }, 10000);
        expect(result.result?.uri).toMatch(/^vela-asm:/);
        generatedUris.push(result.result.uri);
      }

      const evicted = await server.request("workspace/textDocumentContent", { uri: generatedUris[0] });
      expect(evicted.result).toBeNull();
      const newest = await server.request("workspace/textDocumentContent", { uri: generatedUris.at(-1) });
      expect(newest.result?.text).toContain("__entry_main");
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects non-Vela workspace compile entries with a configuration warning", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-entry-config-"));
    const server = new ServerProcess(root);

    try {
      writeFileSync(join(tempRoot, "README.txt"), "not Vela source");
      server.setConfiguration({ workspaceEntry: "README.txt" });
      const warning = server.waitForNotification("window/showMessageRequest", (message) =>
        message.params?.type === 2
        && typeof message.params?.message === "string"
        && message.params.message.includes("vela.workspaceEntry must point to a .vl file"));

      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      expect((await warning).params?.message).toContain("README.txt");

      const compile = await server.request("workspace/executeCommand", { command: "vela.compileWorkspaceEntry", arguments: [] });
      expect(compile.result).toMatchObject({ ok: false });
      expect(compile.result?.error).toContain(".vl file");
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects workspace compile entries outside the project root", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-entry-root-"));
    const projectRoot = join(tempRoot, "project");
    const outsidePath = join(tempRoot, "outside.vl");
    const server = new ServerProcess(root);

    try {
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(outsidePath, "module outside { U0 main() { ret; } }");
      server.setConfiguration({ workspaceEntry: "../outside.vl" });
      const warning = server.waitForNotification("window/showMessageRequest", (message) =>
        message.params?.type === 2
        && typeof message.params?.message === "string"
        && message.params.message.includes("vela.workspaceEntry must stay under project root"));

      await server.initialize(projectRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      expect((await warning).params?.message).toContain("../outside.vl");

      const compile = await server.request("workspace/executeCommand", { command: "vela.compileWorkspaceEntry", arguments: [] });
      expect(compile.result).toMatchObject({ ok: false });
      expect(compile.result?.error).toContain("project root");
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("serves builtin and stdlib virtual document content without arbitrary assembly file reads", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-virtual-content-"));
    const forgedAssemblyPath = join(tempRoot, "forged.de1");
    const server = new ServerProcess(root);
    try {
      writeFileSync(forgedAssemblyPath, "SHOULD_NOT_BE_READ");
      await server.initialize();
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();

      const builtins = await server.request("workspace/textDocumentContent", { uri: "vela-builtin:/builtins.vl" });
      expect(builtins.result?.text).toContain("Print");
      expect(builtins.result?.text).toContain("SizeOf");

      const intStdlib = await server.request("workspace/textDocumentContent", { uri: "vela-stdlib:/types/int.vl" });
      expect(intStdlib.result?.text).toContain("class Int");

      const invalid = await server.request("workspace/textDocumentContent", { uri: "vela-stdlib:/../types/int.vl" });
      expect(invalid.result).toBeNull();

      const missingUri = await server.request("workspace/textDocumentContent", {});
      expect(missingUri.result).toBeNull();

      const forgedAssembly = await server.request("workspace/textDocumentContent", {
        uri: `vela-asm:${forgedAssemblyPath.replaceAll("\\", "/")}`,
      });
      expect(forgedAssembly.result).toBeNull();
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps synced virtual documents out of source indexing and current-file commands", async () => {
    const server = new ServerProcess(root);
    try {
      server.setConfiguration({ devCommands: { dumpSymbolIndex: true } });
      await server.initialize();
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: "vela-stdlib:/types/int.vl",
          languageId: "vela",
          version: 1,
          text: "module injected { I16 InjectedVirtual() { ret 1; } }",
        },
      });

      const compileCurrent = await server.request("workspace/executeCommand", { command: "vela.compileCurrentFile", arguments: [] });
      expect(compileCurrent.result?.error).toBe("no current Vela document");

      const symbols = await server.request("workspace/executeCommand", { command: "vela.dumpSymbolIndex", arguments: [] });
      expect(JSON.stringify(symbols.result)).not.toContain("InjectedVirtual");
    } finally {
      await server.shutdown();
    }
  });

  it("does not request workspace configuration from clients without configuration support", async () => {
    const server = new ServerProcess(root);
    try {
      await server.initialize(undefined, { configuration: false });
      server.notify("initialized", {});
      const restart = await server.request("workspace/executeCommand", { command: "vela.restartServer", arguments: [] });
      expect(restart.result).toMatchObject({ restartRequired: true });
      expect(server.configurationRequests()).toBe(0);
    } finally {
      await server.shutdown();
    }
  });

  it("ignores null workspace configuration responses without crashing", async () => {
    const server = new ServerProcess(root);
    try {
      server.setConfiguration(null);
      await server.initialize();
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      const restart = await server.request("workspace/executeCommand", { command: "vela.restartServer", arguments: [] });
      expect(restart.result).toMatchObject({ restartRequired: true });
    } finally {
      await server.shutdown();
    }
  });

  it("applies didChangeConfiguration settings payloads when configuration requests are unsupported", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-direct-config-"));
    const sourcePath = join(tempRoot, "library.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const source = `module lib {
    I16 helper() {
        ret 1;
    }
}`;
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, source);
      await server.initialize(tempRoot, { configuration: false });
      server.notify("initialized", {});
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: sourceUri,
          languageId: "vela",
          version: 1,
          text: source,
        },
      });

      const before = await server.request("textDocument/diagnostic", { textDocument: { uri: sourceUri } });
      expect(diagnosticCodes(before.result)).not.toContain("vela.sem.missingMain");

      server.notify("workspace/didChangeConfiguration", {
        settings: {
          vela: {
            requireMainDiagnostic: "currentFile",
          },
        },
      });
      const published = await server.waitForNotification("textDocument/publishDiagnostics", (message) =>
        message.params?.uri === sourceUri && diagnosticCodes(message.params).includes("vela.sem.missingMain"));
      expect(diagnosticCodes(published.params)).toContain("vela.sem.missingMain");
      expect(server.configurationRequests()).toBe(0);
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("refreshes client-derived LSP data on configuration changes when supported", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-folding-refresh-"));
    const supported = new ServerProcess(root);
    const unsupported = new ServerProcess(root);

    try {
      await supported.initialize(tempRoot, {
        configuration: false,
        diagnosticRefresh: true,
        inlayHintRefresh: true,
        semanticTokensRefresh: true,
        foldingRangeRefresh: true,
      });
      supported.notify("initialized", {});
      const diagnosticRefresh = supported.waitForNotification("workspace/diagnostic/refresh");
      const inlayHintRefresh = supported.waitForNotification("workspace/inlayHint/refresh");
      const semanticTokensRefresh = supported.waitForNotification("workspace/semanticTokens/refresh");
      const foldingRangeRefresh = supported.waitForNotification("workspace/foldingRange/refresh");
      supported.notify("workspace/didChangeConfiguration", { settings: { vela: { formatting: { enabled: false } } } });
      await diagnosticRefresh;
      await inlayHintRefresh;
      await semanticTokensRefresh;
      await foldingRangeRefresh;

      await unsupported.initialize(tempRoot, { configuration: false });
      unsupported.notify("initialized", {});
      const noRefresh = unsupported.waitForNotification("workspace/foldingRange/refresh", () => true, 250)
        .then(() => false, () => true);
      unsupported.notify("workspace/didChangeConfiguration", { settings: { vela: { formatting: { enabled: false } } } });
      expect(await noRefresh).toBe(true);
    } finally {
      await supported.shutdown();
      await unsupported.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("emits structured trace logs when enabled by configuration", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-trace-"));
    const server = new ServerProcess(root);

    try {
      await server.initialize(tempRoot, { configuration: false });
      server.notify("initialized", {});

      const configurationTrace = server.waitForNotification("window/logMessage", (message) =>
        traceEvent(message) === "configuration.refreshed");
      server.notify("workspace/didChangeConfiguration", { settings: { vela: { trace: { server: true } } } });
      const configurationPayload = tracePayload(await configurationTrace);
      expect(configurationPayload).toMatchObject({
        source: "vela-lsp",
        event: "configuration.refreshed",
        workspaceFolders: 1,
      });

      const commandTrace = server.waitForNotification("window/logMessage", (message) =>
        traceEvent(message) === "command.execute");
      await server.request("workspace/executeCommand", { command: "vela.restartServer", arguments: [] });
      expect(tracePayload(await commandTrace)).toMatchObject({
        source: "vela-lsp",
        event: "command.execute",
        command: "vela.restartServer",
      });
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("publishes configuration warnings for invalid settings", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-invalid-config-"));
    const missingRoot = join(tempRoot, "missing-root");
    const server = new ServerProcess(root);

    try {
      server.setConfiguration({
        projectRoot: missingRoot,
        requireMainDiagnostic: "always",
        diagnostics: { mode: "all" },
        formatting: { enabled: "yes" },
        cpuSimulatorPath: "missing-cpu",
      });
      const modeWarning = server.waitForNotification("window/showMessageRequest", (message) =>
        message.params?.type === 2
        && typeof message.params?.message === "string"
        && message.params.message.includes("vela.diagnostics.mode must be one of"));
      const rootWarning = server.waitForNotification("window/showMessageRequest", (message) =>
        message.params?.type === 2
        && typeof message.params?.message === "string"
        && message.params.message.includes("vela.projectRoot does not exist"));
      const cpuWarning = server.waitForNotification("window/showMessageRequest", (message) =>
        message.params?.type === 2
        && typeof message.params?.message === "string"
        && message.params.message.includes("vela.cpuSimulatorPath does not exist"));

      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();

      expect((await modeWarning).params?.message).toContain("openFiles");
      expect((await rootWarning).params?.message).toContain(missingRoot);
      expect((await cpuWarning).params?.message).toContain("missing-cpu");
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("indexes a rootUri-only workspace when workspaceFolders are absent", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-rooturi-"));
    const sourcePath = join(tempRoot, "root_only.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, `module app {
    I16 RootUriProbe() {
        ret 1;
    }
}`);
      await server.initialize(tempRoot, { workspaceFolders: false });
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();

      const symbols = await server.request("workspace/symbol", { query: "RootUriProbe" });
      expect(symbolUris(symbols.result)).toContain(sourceUri);
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("indexes multiple initialized workspace folders and resolves cross-root imports", async () => {
    const leftRoot = mkdtempSync(join(tmpdir(), "vela-lsp-left-root-"));
    const rightRoot = mkdtempSync(join(tmpdir(), "vela-lsp-right-root-"));
    const libDir = join(leftRoot, "lib");
    const libraryPath = join(libDir, "math.vl");
    const appPath = join(rightRoot, "app.vl");
    const libraryUri = pathToFileURL(libraryPath).toString();
    const appUri = pathToFileURL(appPath).toString();
    const appSource = `module app {
    import lib::{math};

    I16 main() {
        ret SharedProbe();
    }
}`;
    const server = new ServerProcess(root);

    try {
      mkdirSync(libDir, { recursive: true });
      writeFileSync(libraryPath, `module math {
    I16 SharedProbe() {
        ret 1;
    }
}`);
      writeFileSync(appPath, appSource);

      await server.initialize(leftRoot, { workspaceFolderRoots: [leftRoot, rightRoot] });
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: appUri,
          languageId: "vela",
          version: 1,
          text: appSource,
        },
      });

      const symbols = await server.request("workspace/symbol", { query: "SharedProbe" });
      expect(symbolUris(symbols.result)).toContain(libraryUri);
      const diagnostics = await server.request("textDocument/diagnostic", { textDocument: { uri: appUri } });
      expect(diagnosticCodes(diagnostics.result)).not.toContain("vela.sem.unknownIdentifier");
    } finally {
      await server.shutdown();
      rmSync(leftRoot, { recursive: true, force: true });
      rmSync(rightRoot, { recursive: true, force: true });
    }
  });

  it("updates indexed roots after workspace folder change notifications", async () => {
    const leftRoot = mkdtempSync(join(tmpdir(), "vela-lsp-folder-left-"));
    const rightRoot = mkdtempSync(join(tmpdir(), "vela-lsp-folder-right-"));
    const leftPath = join(leftRoot, "left.vl");
    const rightPath = join(rightRoot, "right.vl");
    const leftUri = pathToFileURL(leftPath).toString();
    const rightUri = pathToFileURL(rightPath).toString();
    const server = new ServerProcess(root);

    try {
      writeFileSync(leftPath, `module left {
    I16 LeftFolderProbe() {
        ret 1;
    }
}`);
      writeFileSync(rightPath, `module right {
    I16 RightFolderProbe() {
        ret 2;
    }
}`);

      await server.initialize(leftRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();

      const initialLeft = await server.request("workspace/symbol", { query: "LeftFolderProbe" });
      expect(symbolUris(initialLeft.result)).toContain(leftUri);
      const initialRight = await server.request("workspace/symbol", { query: "RightFolderProbe" });
      expect(symbolUris(initialRight.result)).not.toContain(rightUri);

      server.notify("workspace/didChangeWorkspaceFolders", {
        event: {
          added: [{ uri: pathToFileURL(rightRoot).toString(), name: "right" }],
          removed: [{ uri: pathToFileURL(leftRoot).toString(), name: "left" }],
        },
      });

      const removedLeft = await server.request("workspace/symbol", { query: "LeftFolderProbe" });
      expect(symbolUris(removedLeft.result)).not.toContain(leftUri);
      const addedRight = await server.request("workspace/symbol", { query: "RightFolderProbe" });
      expect(symbolUris(addedRight.result)).toContain(rightUri);
    } finally {
      await server.shutdown();
      rmSync(leftRoot, { recursive: true, force: true });
      rmSync(rightRoot, { recursive: true, force: true });
    }
  });

  it("does not fall back to repository indexing after all workspace folders are removed", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-folder-clear-"));
    const sourcePath = join(tempRoot, "left.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const repoPath = join(root, `repo_fallback_${process.pid}_${Date.now()}.vl`);
    const repoUri = pathToFileURL(repoPath).toString();
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, `module left {
    I16 LeftFolderProbe() {
        ret 1;
    }
}`);
      writeFileSync(repoPath, `module repo_fallback {
    I16 RepoFallbackProbe() {
        ret 9;
    }
}`);

      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();

      const initialLeft = await server.request("workspace/symbol", { query: "LeftFolderProbe" });
      expect(symbolUris(initialLeft.result)).toContain(sourceUri);
      const initialRepo = await server.request("workspace/symbol", { query: "RepoFallbackProbe" });
      expect(symbolUris(initialRepo.result)).not.toContain(repoUri);

      server.notify("workspace/didChangeWorkspaceFolders", {
        event: {
          added: [],
          removed: [{ uri: pathToFileURL(tempRoot).toString(), name: "left" }],
        },
      });

      const removedLeft = await server.request("workspace/symbol", { query: "LeftFolderProbe" });
      expect(symbolUris(removedLeft.result)).not.toContain(sourceUri);
      const fallbackRepo = await server.request("workspace/symbol", { query: "RepoFallbackProbe" });
      expect(symbolUris(fallbackRepo.result)).not.toContain(repoUri);

      server.notify("workspace/didChangeConfiguration", { settings: {} });
      await server.waitForNextConfigurationRequest();

      const afterConfiguration = await server.request("workspace/symbol", { query: "RepoFallbackProbe" });
      expect(symbolUris(afterConfiguration.result)).not.toContain(repoUri);
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(repoPath, { force: true });
    }
  });

  it("requests workspace folders from the client when initialize omits root data", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-workspace-folders-"));
    const sourcePath = join(tempRoot, "client_folder.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, `module app {
    I16 ClientFolderProbe() {
        ret 1;
    }
}`);
      server.setWorkspaceFolders([{ uri: pathToFileURL(tempRoot).toString(), name: "client-folder" }]);
      await server.initialize();
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();

      const symbols = await server.request("workspace/symbol", { query: "ClientFolderProbe" });
      expect(symbolUris(symbols.result)).toContain(sourceUri);
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("indexes the configured project root during initialization", async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "vela-lsp-empty-root-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "vela-lsp-configured-root-"));
    const sourcePath = join(projectRoot, "configured.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, `module configured {
    I16 ConfiguredRootProbe() {
        ret 1;
    }
}`);
      server.setConfiguration({ projectRoot });
      await server.initialize(emptyRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();

      const symbols = await server.request("workspace/symbol", { query: "ConfiguredRootProbe" });
      expect(symbolUris(symbols.result)).toContain(sourceUri);
    } finally {
      await server.shutdown();
      rmSync(emptyRoot, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("supports workspaceSymbol/resolve when the client advertises resolve support", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-symbol-resolve-"));
    const sourcePath = join(tempRoot, "symbols.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const source = `module app {
    I16 ResolveTarget() {
        ret 1;
    }
}`;
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, source);
      const initialized = await server.initialize(tempRoot, { workspaceSymbolResolve: true });
      expect(initialized.result?.capabilities?.workspaceSymbolProvider?.resolveProvider).toBe(true);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();

      const symbols = await server.request("workspace/symbol", { query: "ResolveTarget" });
      const symbol = (symbols.result as any[]).find((item) => item.name === "ResolveTarget");
      expect(symbol?.location).toEqual({ uri: sourceUri });
      expect(symbol?.data?.symbolId).toEqual(expect.any(String));

      const resolved = await server.request("workspaceSymbol/resolve", symbol);
      expect(resolved.result?.location?.uri).toBe(sourceUri);
      expect(textForLspRange(source, resolved.result?.location?.range)).toBe("ResolveTarget");
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("serves core text document feature requests over JSON-RPC", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-core-"));
    const sourcePath = join(tempRoot, "main.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const source = `module app {
    I16 helper(I16 value) {
        ret value;
    }

    I16 main() {
        Ptr<U0> raw = Malloc(2);
        Print(Cast<I16>(SizeOf(I16)));
        Free(raw);
        I16 x = helper(1);
        ret x;
    }
}`;
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, source);
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: sourceUri,
          languageId: "vela",
          version: 1,
          text: source,
        },
      });

      const completion = await server.request("textDocument/completion", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "ret x", "ret ".length),
      });
      expect(completionLabels(completion.result)).toContain("x");

      const signature = await server.request("textDocument/signatureHelp", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "helper(1", "helper(".length),
      });
      expect(signature.result?.signatures?.[0]?.label).toContain("helper(I16 value)");

      const mallocSignature = await server.request("textDocument/signatureHelp", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "Malloc(2", "Malloc(".length),
      });
      expect(signatureLabel(mallocSignature.result)).toBe("Ptr<U0> Malloc(I16 size)");

      const printSignature = await server.request("textDocument/signatureHelp", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "Print(Cast", "Print(".length),
      });
      expect(signatureLabel(printSignature.result)).toBe("U0 Print(value)");

      const castSignature = await server.request("textDocument/signatureHelp", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "Cast<I16>(SizeOf", "Cast<I16>(".length),
      });
      expect(signatureLabel(castSignature.result)).toBe("T Cast<T>(expr)");

      const sizeOfSignature = await server.request("textDocument/signatureHelp", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "SizeOf(I16", "SizeOf(".length),
      });
      expect(signatureLabel(sizeOfSignature.result)).toBe("U16 SizeOf(Type)");

      const freeSignature = await server.request("textDocument/signatureHelp", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "Free(raw", "Free(".length),
      });
      expect(signatureLabel(freeSignature.result)).toBe("U0 Free(Ptr<T> value)");

      const hover = await server.request("textDocument/hover", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "helper(1"),
      });
      expect(markupText(hover.result?.contents)).toContain("helper");

      const definition = await server.request("textDocument/definition", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "helper(1"),
      });
      expect(locationUris(definition.result)).toEqual([sourceUri]);
      expect(locationRanges(definition.result)[0]?.start.line).toBe(1);

      const references = await server.request("textDocument/references", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "helper(I16"),
        context: { includeDeclaration: true },
      });
      expect(locationUris(references.result).filter((uri) => uri === sourceUri)).toHaveLength(2);

      const referenceWorkToken = "references-work";
      const referencePartialToken = "references-partial";
      const referenceBegin = server.waitForNotification("$/progress", (message) =>
        message.params?.token === referenceWorkToken && message.params?.value?.kind === "begin");
      const referencePartial = server.waitForNotification("$/progress", (message) =>
        message.params?.token === referencePartialToken
        && Array.isArray(message.params?.value)
        && locationUris(message.params.value).filter((uri) => uri === sourceUri).length === 2);
      const referenceEnd = server.waitForNotification("$/progress", (message) =>
        message.params?.token === referenceWorkToken && message.params?.value?.kind === "end");
      const streamedReferences = await server.request("textDocument/references", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "helper(I16"),
        context: { includeDeclaration: true },
        workDoneToken: referenceWorkToken,
        partialResultToken: referencePartialToken,
      });
      expect(streamedReferences.result).toEqual([]);
      await referenceBegin;
      await referencePartial;
      await referenceEnd;

      const symbols = await server.request("textDocument/documentSymbol", { textDocument: { uri: sourceUri } });
      expect(documentSymbolNames(symbols.result)).toContain("app");

      const tokens = await server.request("textDocument/semanticTokens/full", { textDocument: { uri: sourceUri } });
      expect(tokens.result?.data?.length).toBeGreaterThan(0);
      expect(tokens.result?.resultId).toBeDefined();
      const tokenDelta = await server.request("textDocument/semanticTokens/full/delta", {
        textDocument: { uri: sourceUri },
        previousResultId: tokens.result.resultId,
      });
      expect(tokenDelta.result?.edits).toEqual([]);
      expect(tokenDelta.result?.resultId).toBeDefined();
      const staleTokenDelta = await server.request("textDocument/semanticTokens/full/delta", {
        textDocument: { uri: sourceUri },
        previousResultId: "stale-token-result",
      });
      expect(staleTokenDelta.result?.data?.length).toBeGreaterThan(0);
      expect(staleTokenDelta.result?.edits).toBeUndefined();
      const changedSource = source.replace("ret x;", "ret helper(2);");
      server.notify("textDocument/didChange", {
        textDocument: { uri: sourceUri, version: 2 },
        contentChanges: [{ text: changedSource }],
      });
      const changedTokenDelta = await server.request("textDocument/semanticTokens/full/delta", {
        textDocument: { uri: sourceUri },
        previousResultId: tokenDelta.result.resultId,
      });
      expect(Array.isArray(changedTokenDelta.result?.edits)).toBe(true);
      expect(changedTokenDelta.result?.edits?.length).toBeGreaterThan(0);

      const hints = await server.request("textDocument/inlayHint", {
        textDocument: { uri: sourceUri },
        range: fullRange(changedSource),
      });
      expect(inlayHintLabels(hints.result)).toContain("value:");
      expect(inlayHintLabelAt(hints.result, positionIn(changedSource, "Malloc(2", "Malloc(".length))).toBe("size:");
      expect(inlayHintLabelAt(hints.result, positionIn(changedSource, "Print(Cast", "Print(".length))).toBe("value:");
      expect(inlayHintLabelAt(hints.result, positionIn(changedSource, "Cast<I16>(SizeOf", "Cast<I16>(".length))).toBe("expr:");
      expect(inlayHintLabelAt(hints.result, positionIn(changedSource, "SizeOf(I16", "SizeOf(".length))).toBe("type:");
      expect(inlayHintLabelAt(hints.result, positionIn(changedSource, "Free(raw", "Free(".length))).toBe("value:");

      const folding = await server.request("textDocument/foldingRange", { textDocument: { uri: sourceUri } });
      expect(Array.isArray(folding.result) && folding.result.length).toBeGreaterThan(0);

      const selection = await server.request("textDocument/selectionRange", {
        textDocument: { uri: sourceUri },
        positions: [positionIn(source, "helper(1")],
      });
      expect(Array.isArray(selection.result)).toBe(true);
      expect(selection.result?.[0]?.range).toBeDefined();

      const prepare = await server.request("textDocument/prepareRename", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "helper(I16"),
      });
      expect(prepare.result?.placeholder ?? textForLspRange(source, prepare.result)).toBe("helper");

      const renameResult = await server.request("textDocument/rename", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "helper(I16"),
        newName: "calculate",
      });
      expect(editTexts(renameResult.result, sourceUri)).toContain("calculate");
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns empty results instead of request errors for malformed feature requests", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-safe-handlers-"));
    const sourcePath = join(tempRoot, "main.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const source = "module app { I16 main() { ret 0; } }";
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, source);
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: sourceUri,
          languageId: "vela",
          version: 1,
          text: source,
        },
      });

      const hover = await server.request("textDocument/hover", {});
      expect(hover.error).toBeUndefined();
      expect(hover.result).toBeNull();

      const symbols = await server.request("workspace/symbol", {});
      expect(symbols.error).toBeUndefined();
      expect(symbols.result).toEqual([]);

      const tokens = await server.request("textDocument/semanticTokens/full", {});
      expect(tokens.error).toBeUndefined();
      expect(tokens.result).toEqual({ data: [] });

      const references = await server.request("textDocument/references", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "main"),
      });
      expect(references.error).toBeUndefined();
      expect(references.result).toEqual([]);

      const actions = await server.request("textDocument/codeAction", {
        textDocument: { uri: sourceUri },
      });
      expect(actions.error).toBeUndefined();
      expect(actions.result).toEqual([]);

      const diagnostics = await server.request("textDocument/diagnostic", {});
      expect(diagnostics.error).toBeUndefined();
      expect(diagnosticItems(diagnostics.result)).toEqual([]);

      const validSymbols = await server.request("workspace/symbol", { query: "main" });
      expect(validSymbols.error).toBeUndefined();
      expect(symbolUris(validSymbols.result)).toContain(sourceUri);
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("serves formatting edits and diagnostic code actions over JSON-RPC", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-edits-"));
    const formatPath = join(tempRoot, "format.vl");
    const actionPath = join(tempRoot, "action.vl");
    const formatUri = pathToFileURL(formatPath).toString();
    const actionUri = pathToFileURL(actionPath).toString();
    const unformatted = "module app{I16 main(){ret 0;}}";
    const missingReturn = `module app {
    import stdlib::types::{string};

    I16 main() {
        Bool flag;
        I16 x = 1;
    }
}`;
    const server = new ServerProcess(root);

    try {
      writeFileSync(formatPath, unformatted);
      writeFileSync(actionPath, missingReturn);
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: formatUri,
          languageId: "vela",
          version: 1,
          text: unformatted,
        },
      });
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: actionUri,
          languageId: "vela",
          version: 1,
          text: missingReturn,
        },
      });

      const autoImportCompletion = await server.request("textDocument/completion", {
        textDocument: { uri: actionUri },
        position: positionIn(missingReturn, "Bool flag", "Bo".length),
      });
      expect(completionLabels(autoImportCompletion.result)).toContain("Bool");
      expect(completionAdditionalEditTexts(autoImportCompletion.result, "Bool")).toContain(", bool");

      const formatting = await server.request("textDocument/formatting", {
        textDocument: { uri: formatUri },
        options: { tabSize: 4, insertSpaces: true },
      });
      expect(editTexts(formatting.result, formatUri).join("\n")).toContain("module app {");

      const rangeFormatting = await server.request("textDocument/rangeFormatting", {
        textDocument: { uri: formatUri },
        range: fullRange(unformatted),
        options: { tabSize: 4, insertSpaces: true },
      });
      expect(editTexts(rangeFormatting.result, formatUri).join("\n")).toContain("module app {");

      for (const ch of [";", "}", ")", "\n"]) {
        const onTypeFormatting = await server.request("textDocument/onTypeFormatting", {
          textDocument: { uri: formatUri },
          position: ch === "\n" ? { line: 1, character: 0 } : { line: 0, character: unformatted.length },
          ch,
          options: { tabSize: 4, insertSpaces: true },
        });
        expect(editTexts(onTypeFormatting.result, formatUri).join("\n")).toContain("module app {");
      }

      const diagnostics = await server.request("textDocument/diagnostic", { textDocument: { uri: actionUri } });
      const missingReturnDiagnostic = diagnosticItems(diagnostics.result).find((diagnostic) => diagnostic.code === "vela.sem.missingReturn");
      expect(missingReturnDiagnostic).toBeDefined();
      const missingBoolDiagnostic = diagnosticItems(diagnostics.result).find((diagnostic) =>
        diagnostic.code === "vela.sem.unknownType" && diagnosticMessage(diagnostic).includes("'Bool'"));
      expect(missingBoolDiagnostic).toBeDefined();

      const actions = await server.request("textDocument/codeAction", {
        textDocument: { uri: actionUri },
        range: missingReturnDiagnostic!.range,
        context: { diagnostics: [missingReturnDiagnostic], only: ["quickfix"] },
      });
      expect(codeActionTitles(actions.result)).toEqual(expect.arrayContaining(["Add missing return statement", "Change return type to U0"]));
      expect(codeActionKinds(actions.result).every((kind) => kind === "quickfix")).toBe(true);

      const importActions = await server.request("textDocument/codeAction", {
        textDocument: { uri: actionUri },
        range: missingBoolDiagnostic!.range,
        context: { diagnostics: [missingBoolDiagnostic], only: ["quickfix"] },
      });
      expect(codeActionTitles(importActions.result)).toContain("Import 'Bool' from stdlib::types::{bool}");
      expect(codeActionEditTexts(importActions.result, "Import 'Bool' from stdlib::types::{bool}", actionUri)).toContain(", bool");

      const sourceActions = await server.request("textDocument/codeAction", {
        textDocument: { uri: actionUri },
        range: fullRange(missingReturn),
        context: { diagnostics: [missingReturnDiagnostic], only: ["source.organizeImports"] },
      });
      expect(codeActionTitles(sourceActions.result)).toContain("Remove unused import 'string'");
      expect(codeActionTitles(sourceActions.result)).not.toContain("Add missing return statement");
      expect(codeActionKinds(sourceActions.result).every((kind) => kind === "source.organizeImports")).toBe(true);
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("serves hierarchy, document link, moniker, highlight, and implementation requests over JSON-RPC", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-hierarchy-"));
    const sourcePath = join(tempRoot, "main.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const source = `module app {
    import stdlib::types::{int};

    type Drawable {
        skeleton U0 Draw();
    }

    class Sprite : Drawable {
        U0 Draw() {
            ret;
        }

        I16 Value() {
            ret helper();
        }
    }

    I16 helper() {
        ret 1;
    }

    I16 main() {
        Ptr<Sprite> s = null;
        ret helper();
    }
}`;
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, source);
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: sourceUri,
          languageId: "vela",
          version: 1,
          text: source,
        },
      });

      const links = await server.request("textDocument/documentLink", { textDocument: { uri: sourceUri } });
      expect(Array.isArray(links.result) && links.result.length).toBeGreaterThan(0);
      const resolvedLink = await server.request("documentLink/resolve", links.result[0]);
      expect(resolvedLink.result?.target).toBe("vela-stdlib:/types/int.vl");

      const declaration = await server.request("textDocument/declaration", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "Draw() {\n            ret;"),
      });
      expect(locationRanges(declaration.result)[0]?.start.line).toBe(lineOf(source, "skeleton U0 Draw"));

      const implementationResult = await server.request("textDocument/implementation", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "skeleton U0 Draw", "skeleton U0 ".length),
      });
      expect(locationRanges(implementationResult.result).some((range) => range.start.line === lineOf(source, "Draw() {\n            ret;"))).toBe(true);

      const typeDefinitionResult = await server.request("textDocument/typeDefinition", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "s = null"),
      });
      expect(locationRanges(typeDefinitionResult.result)[0]?.start.line).toBe(lineOf(source, "Sprite :"));

      const highlights = await server.request("textDocument/documentHighlight", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "ret helper();", "ret ".length),
      });
      expect(Array.isArray(highlights.result) && highlights.result.length).toBeGreaterThan(1);

      const monikers = await server.request("textDocument/moniker", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "ret helper();", "ret ".length),
      });
      expect(Array.isArray(monikers.result) && monikers.result.length).toBeGreaterThan(0);

      const helperItems = await server.request("textDocument/prepareCallHierarchy", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "helper()"),
      });
      expect(itemNames(helperItems.result)).toContain("helper");
      const incoming = await server.request("callHierarchy/incomingCalls", { item: helperItems.result[0] });
      expect(callFromNames(incoming.result)).toEqual(expect.arrayContaining(["Value", "main"]));

      const callWorkToken = "call-hierarchy-work";
      const callPartialToken = "call-hierarchy-partial";
      const callBegin = server.waitForNotification("$/progress", (message) =>
        message.params?.token === callWorkToken && message.params?.value?.kind === "begin");
      const callPartial = server.waitForNotification("$/progress", (message) =>
        message.params?.token === callPartialToken
        && Array.isArray(message.params?.value)
        && callFromNames(message.params.value).includes("main"));
      const callEnd = server.waitForNotification("$/progress", (message) =>
        message.params?.token === callWorkToken && message.params?.value?.kind === "end");
      const streamedIncoming = await server.request("callHierarchy/incomingCalls", {
        item: helperItems.result[0],
        workDoneToken: callWorkToken,
        partialResultToken: callPartialToken,
      });
      expect(streamedIncoming.result).toEqual([]);
      await callBegin;
      await callPartial;
      await callEnd;

      const mainItems = await server.request("textDocument/prepareCallHierarchy", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "main()"),
      });
      const outgoing = await server.request("callHierarchy/outgoingCalls", { item: mainItems.result[0] });
      expect(callToNames(outgoing.result)).toContain("helper");

      const outgoingWorkToken = "call-hierarchy-outgoing-work";
      const outgoingPartialToken = "call-hierarchy-outgoing-partial";
      const outgoingBegin = server.waitForNotification("$/progress", (message) =>
        message.params?.token === outgoingWorkToken && message.params?.value?.kind === "begin");
      const outgoingPartial = server.waitForNotification("$/progress", (message) =>
        message.params?.token === outgoingPartialToken
        && Array.isArray(message.params?.value)
        && callToNames(message.params.value).includes("helper"));
      const outgoingEnd = server.waitForNotification("$/progress", (message) =>
        message.params?.token === outgoingWorkToken && message.params?.value?.kind === "end");
      const streamedOutgoing = await server.request("callHierarchy/outgoingCalls", {
        item: mainItems.result[0],
        workDoneToken: outgoingWorkToken,
        partialResultToken: outgoingPartialToken,
      });
      expect(streamedOutgoing.result).toEqual([]);
      await outgoingBegin;
      await outgoingPartial;
      await outgoingEnd;

      const drawableItems = await server.request("textDocument/prepareTypeHierarchy", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "Drawable {"),
      });
      expect(itemNames(drawableItems.result)).toContain("Drawable");
      const subtypesResult = await server.request("typeHierarchy/subtypes", { item: drawableItems.result[0] });
      expect(itemNames(subtypesResult.result)).toContain("Sprite");

      const typeWorkToken = "type-hierarchy-work";
      const typePartialToken = "type-hierarchy-partial";
      const typeBegin = server.waitForNotification("$/progress", (message) =>
        message.params?.token === typeWorkToken && message.params?.value?.kind === "begin");
      const typePartial = server.waitForNotification("$/progress", (message) =>
        message.params?.token === typePartialToken
        && Array.isArray(message.params?.value)
        && itemNames(message.params.value).includes("Sprite"));
      const typeEnd = server.waitForNotification("$/progress", (message) =>
        message.params?.token === typeWorkToken && message.params?.value?.kind === "end");
      const streamedSubtypes = await server.request("typeHierarchy/subtypes", {
        item: drawableItems.result[0],
        workDoneToken: typeWorkToken,
        partialResultToken: typePartialToken,
      });
      expect(streamedSubtypes.result).toEqual([]);
      await typeBegin;
      await typePartial;
      await typeEnd;

      const spriteItems = await server.request("textDocument/prepareTypeHierarchy", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "Sprite :"),
      });
      const supertypesResult = await server.request("typeHierarchy/supertypes", { item: spriteItems.result[0] });
      expect(itemNames(supertypesResult.result)).toContain("Drawable");

      const supertypeWorkToken = "type-hierarchy-supertype-work";
      const supertypePartialToken = "type-hierarchy-supertype-partial";
      const supertypeBegin = server.waitForNotification("$/progress", (message) =>
        message.params?.token === supertypeWorkToken && message.params?.value?.kind === "begin");
      const supertypePartial = server.waitForNotification("$/progress", (message) =>
        message.params?.token === supertypePartialToken
        && Array.isArray(message.params?.value)
        && itemNames(message.params.value).includes("Drawable"));
      const supertypeEnd = server.waitForNotification("$/progress", (message) =>
        message.params?.token === supertypeWorkToken && message.params?.value?.kind === "end");
      const streamedSupertypes = await server.request("typeHierarchy/supertypes", {
        item: spriteItems.result[0],
        workDoneToken: supertypeWorkToken,
        partialResultToken: supertypePartialToken,
      });
      expect(streamedSupertypes.result).toEqual([]);
      await supertypeBegin;
      await supertypePartial;
      await supertypeEnd;
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("updates the workspace index and import edits for file operations", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-files-"));
    const libDir = join(tempRoot, "lib");
    const appPath = join(tempRoot, "app.vl");
    const oldPath = join(libDir, "math.vl");
    const newPath = join(libDir, "arith.vl");
    const createdPath = join(libDir, "extra.vl");
    const appUri = pathToFileURL(appPath).toString();
    const oldUri = pathToFileURL(oldPath).toString();
    const newUri = pathToFileURL(newPath).toString();
    const createdUri = pathToFileURL(createdPath).toString();
    const server = new ServerProcess(root);

    try {
      mkdirSync(libDir, { recursive: true });
      writeFileSync(appPath, `module app {
    import lib::{math, extra};

    I16 main() {
        ret RenameProbe();
    }
}`);
      writeFileSync(oldPath, `module math {
    I16 RenameProbe() {
        ret 1;
    }
}`);

      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();

      const initialSymbols = await server.request("workspace/symbol", { query: "RenameProbe" });
      expect(symbolUris(initialSymbols.result)).toContain(oldUri);

      writeFileSync(createdPath, `module extra {
    I16 CreatedProbe() {
        ret 2;
    }
}`);
      server.notify("workspace/didCreateFiles", { files: [{ uri: createdUri }] });
      const createdSymbols = await server.request("workspace/symbol", { query: "CreatedProbe" });
      expect(symbolUris(createdSymbols.result)).toContain(createdUri);

      const rawRenameEdit = await server.request("workspace/willRenameFiles", { files: [{ oldUri: oldPath, newUri: newPath }] });
      expect(rawRenameEdit.result).toBeNull();

      const renameEdit = await server.request("workspace/willRenameFiles", { files: [{ oldUri, newUri }] });
      const edits = renameEdit.result?.changes?.[appUri] ?? [];
      expect(edits).toHaveLength(1);
      expect(edits[0].newText).toBe("arith");
      const renamedFileEdits = renameEdit.result?.changes?.[oldUri] ?? [];
      expect(renamedFileEdits).toHaveLength(1);
      expect(renamedFileEdits[0].newText).toBe("arith");

      const rawDeleteEdit = await server.request("workspace/willDeleteFiles", { files: [{ uri: createdPath }] });
      expect(rawDeleteEdit.result).toBeNull();

      const deleteEdit = await server.request("workspace/willDeleteFiles", { files: [{ uri: createdUri }] });
      const deleteEdits = deleteEdit.result?.changes?.[appUri] ?? [];
      expect(deleteEdits).toHaveLength(1);
      expect(deleteEdits[0].newText).toBe("import lib::{math};");
      const linksBeforeDelete = await server.request("textDocument/documentLink", { textDocument: { uri: appUri } });
      expect(await resolvedDocumentLinkTargets(server, linksBeforeDelete.result)).toContain(createdUri);
      unlinkSync(createdPath);
      server.notify("workspace/didDeleteFiles", { files: [{ uri: createdUri }] });
      const linksAfterImportDelete = await server.request("textDocument/documentLink", { textDocument: { uri: appUri } });
      expect(await resolvedDocumentLinkTargets(server, linksAfterImportDelete.result)).not.toContain(createdUri);

      renameSync(oldPath, newPath);
      server.notify("workspace/didRenameFiles", { files: [{ oldUri, newUri }] });
      const renamedSymbols = await server.request("workspace/symbol", { query: "RenameProbe" });
      expect(symbolUris(renamedSymbols.result)).toContain(newUri);
      expect(symbolUris(renamedSymbols.result)).not.toContain(oldUri);

      unlinkSync(newPath);
      server.notify("workspace/didDeleteFiles", { files: [{ uri: newUri }] });
      const deletedSymbols = await server.request("workspace/symbol", { query: "RenameProbe" });
      expect(symbolUris(deletedSymbols.result)).not.toContain(newUri);
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("ignores non-URI file-operation payloads instead of treating them as files", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-non-uri-files-"));
    const rawPath = join(tempRoot, "raw.vl");
    const server = new ServerProcess(root);

    try {
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      await server.request("workspace/symbol", { query: "NoRawProbeYet" });

      writeFileSync(rawPath, `module raw {
    I16 RawUriProbe() {
        ret 1;
    }
}`);
      server.notify("workspace/didCreateFiles", { files: [{ uri: rawPath }] });
      server.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: rawPath, type: 1 }] });
      server.notify("workspace/didChangeWorkspaceFolders", { event: { added: null, removed: [{ uri: rawPath }] } });
      server.notify("workspace/didCreateFiles", {});
      server.notify("workspace/didChangeWatchedFiles", { changes: null });
      server.notify("workspace/didRenameFiles", { files: [null, { oldUri: rawPath }] });
      server.notify("workspace/didDeleteFiles", { files: "bad" });
      const malformedRenameEdit = await server.request("workspace/willRenameFiles", { files: [null, { oldUri: rawPath }] });
      expect(malformedRenameEdit.result).toBeNull();

      const symbols = await server.request("workspace/symbol", { query: "RawUriProbe" });
      expect(symbolUris(symbols.result)).not.toContain(pathToFileURL(rawPath).toString());
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reanalyzes open importers after watched dependency changes", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-watched-import-"));
    const libDir = join(tempRoot, "lib");
    const appPath = join(tempRoot, "app.vl");
    const mathPath = join(libDir, "math.vl");
    const appUri = pathToFileURL(appPath).toString();
    const mathUri = pathToFileURL(mathPath).toString();
    const source = `module app {
    import lib::{math};

    I16 main() {
        ret FixedProbe();
    }
}`;
    const server = new ServerProcess(root);

    try {
      mkdirSync(libDir, { recursive: true });
      writeFileSync(appPath, source);
      writeFileSync(mathPath, "module math { }");

      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: appUri,
          languageId: "vela",
          version: 1,
          text: source,
        },
      });

      const invalidPull = await server.request("textDocument/diagnostic", { textDocument: { uri: appUri } });
      expect(diagnosticCodes(invalidPull.result)).toContain("vela.sem.unknownIdentifier");

      writeFileSync(mathPath, `module math {
    I16 FixedProbe() {
        ret 7;
    }
}`);
      const clearedPublish = server.waitForNotification("textDocument/publishDiagnostics", (message) =>
        message.params?.uri === appUri && diagnosticCodes(message.params).length === 0);
      server.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: mathUri, type: 2 }] });

      const validPull = await server.request("textDocument/diagnostic", { textDocument: { uri: appUri }, previousResultId: invalidPull.result?.resultId });
      expect(diagnosticCodes(validPull.result)).not.toContain("vela.sem.unknownIdentifier");
      expect((await clearedPublish).params?.diagnostics).toEqual([]);
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reanalyzes open importers after watched dependency creation", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-watched-create-"));
    const libDir = join(tempRoot, "lib");
    const appPath = join(tempRoot, "app.vl");
    const helperPath = join(libDir, "helpers.vl");
    const appUri = pathToFileURL(appPath).toString();
    const helperUri = pathToFileURL(helperPath).toString();
    const source = `module app {
    import lib::{helpers};

    I16 main() {
        ret CreatedProbe();
    }
}`;
    const server = new ServerProcess(root);

    try {
      mkdirSync(libDir, { recursive: true });
      writeFileSync(appPath, source);

      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: appUri,
          languageId: "vela",
          version: 1,
          text: source,
        },
      });

      const invalidPull = await server.request("textDocument/diagnostic", { textDocument: { uri: appUri } });
      expect(diagnosticCodes(invalidPull.result)).toContain("vela.import.unresolved");
      expect(diagnosticCodes(invalidPull.result)).toContain("vela.sem.unknownIdentifier");

      writeFileSync(helperPath, `module helpers {
    I16 CreatedProbe() {
        ret 7;
    }
}`);
      const clearedPublish = server.waitForNotification("textDocument/publishDiagnostics", (message) =>
        message.params?.uri === appUri && diagnosticCodes(message.params).length === 0);
      server.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: helperUri, type: 1 }] });

      const validPull = await server.request("textDocument/diagnostic", { textDocument: { uri: appUri }, previousResultId: invalidPull.result?.resultId });
      expect(diagnosticCodes(validPull.result)).not.toContain("vela.import.unresolved");
      expect(diagnosticCodes(validPull.result)).not.toContain("vela.sem.unknownIdentifier");
      expect((await clearedPublish).params?.diagnostics).toEqual([]);
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps open document snapshots indexed after filesystem delete notifications", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-open-delete-"));
    const sourcePath = join(tempRoot, "main.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const source = "module app { I16 main() { ret missingOpenSnapshot; } }";
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, source);
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: sourceUri,
          languageId: "vela",
          version: 1,
          text: source,
        },
      });

      const beforeDelete = await server.request("textDocument/diagnostic", { textDocument: { uri: sourceUri } });
      expect(diagnosticCodes(beforeDelete.result)).toContain("vela.sem.unknownIdentifier");

      unlinkSync(sourcePath);
      server.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: sourceUri, type: 3 }] });
      const watchedDelete = await server.request("textDocument/diagnostic", { textDocument: { uri: sourceUri } });
      expect(diagnosticCodes(watchedDelete.result)).toContain("vela.sem.unknownIdentifier");

      server.notify("workspace/didDeleteFiles", { files: [{ uri: sourceUri }] });
      const fileDelete = await server.request("textDocument/diagnostic", { textDocument: { uri: sourceUri } });
      expect(diagnosticCodes(fileDelete.result)).toContain("vela.sem.unknownIdentifier");
      const symbols = await server.request("workspace/symbol", { query: "main" });
      expect(symbolUris(symbols.result)).toContain(sourceUri);
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("updates pull and published diagnostics after incremental document changes", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-diagnostics-"));
    const sourcePath = join(tempRoot, "main.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const invalidSource = "module app { I16 main() { ret missing; } }";
    const start = invalidSource.indexOf("missing");
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, invalidSource);
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: sourceUri,
          languageId: "vela",
          version: 1,
          text: invalidSource,
        },
      });

      const invalidPull = await server.request("textDocument/diagnostic", { textDocument: { uri: sourceUri } });
      expect(invalidPull.result?.kind).toBe("full");
      expect(invalidPull.result?.resultId).toBeDefined();
      expect(diagnosticCodes(invalidPull.result)).toContain("vela.sem.unknownIdentifier");
      const unchangedPull = await server.request("textDocument/diagnostic", { textDocument: { uri: sourceUri }, previousResultId: invalidPull.result?.resultId });
      expect(unchangedPull.result).toMatchObject({ kind: "unchanged", resultId: invalidPull.result?.resultId });
      const invalidPublish = await server.waitForNotification("textDocument/publishDiagnostics", (message) =>
        message.params?.uri === sourceUri && diagnosticCodes(message.params).includes("vela.sem.unknownIdentifier"));
      expect(diagnosticCodes(invalidPublish.params)).toContain("vela.sem.unknownIdentifier");

      server.notify("textDocument/didChange", {
        textDocument: { uri: sourceUri, version: 2 },
        contentChanges: [{
          range: {
            start: { line: 0, character: start },
            end: { line: 0, character: start + "missing".length },
          },
          rangeLength: "missing".length,
          text: "0",
        }],
      });

      const validPull = await server.request("textDocument/diagnostic", { textDocument: { uri: sourceUri }, previousResultId: invalidPull.result?.resultId });
      expect(validPull.result?.kind).toBe("full");
      expect(validPull.result?.resultId).toBeDefined();
      expect(validPull.result?.resultId).not.toBe(invalidPull.result?.resultId);
      expect(diagnosticCodes(validPull.result)).not.toContain("vela.sem.unknownIdentifier");
      const validPublish = await server.waitForNotification("textDocument/publishDiagnostics", (message) =>
        message.params?.uri === sourceUri && diagnosticCodes(message.params).length === 0);
      expect(validPublish.params?.diagnostics).toEqual([]);
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("accepts full-document change events as a synchronization fallback", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-full-sync-"));
    const sourcePath = join(tempRoot, "main.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const invalidSource = "module app { I16 main() { ret missing; } }";
    const validSource = "module app { I16 main() { ret 0; } }";
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, invalidSource);
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: sourceUri,
          languageId: "vela",
          version: 1,
          text: invalidSource,
        },
      });

      const invalidPull = await server.request("textDocument/diagnostic", { textDocument: { uri: sourceUri } });
      expect(diagnosticCodes(invalidPull.result)).toContain("vela.sem.unknownIdentifier");

      server.notify("textDocument/didChange", {
        textDocument: { uri: sourceUri, version: 2 },
        contentChanges: [{ text: validSource }],
      });

      const validPull = await server.request("textDocument/diagnostic", { textDocument: { uri: sourceUri }, previousResultId: invalidPull.result?.resultId });
      expect(validPull.result?.kind).toBe("full");
      expect(diagnosticCodes(validPull.result)).not.toContain("vela.sem.unknownIdentifier");
      const validPublish = await server.waitForNotification("textDocument/publishDiagnostics", (message) =>
        message.params?.uri === sourceUri && diagnosticCodes(message.params).length === 0);
      expect(validPublish.params?.diagnostics).toEqual([]);
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("cancels pending debounced diagnostics when a document is saved", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-save-diagnostics-"));
    const sourcePath = join(tempRoot, "main.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const invalidSource = "module app { I16 main() { ret missing; } }";
    const start = invalidSource.indexOf("missing");
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, invalidSource);
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: sourceUri,
          languageId: "vela",
          version: 1,
          text: invalidSource,
        },
      });
      await server.waitForNotification("textDocument/publishDiagnostics", (message) =>
        message.params?.uri === sourceUri && diagnosticCodes(message.params).includes("vela.sem.unknownIdentifier"));

      server.notify("textDocument/didChange", {
        textDocument: { uri: sourceUri, version: 2 },
        contentChanges: [{
          range: {
            start: { line: 0, character: start },
            end: { line: 0, character: start + "missing".length },
          },
          rangeLength: "missing".length,
          text: "0",
        }],
      });
      const cleared = server.waitForNotification("textDocument/publishDiagnostics", (message) =>
        message.params?.uri === sourceUri && diagnosticCodes(message.params).length === 0);
      server.notify("textDocument/didSave", { textDocument: { uri: sourceUri } });
      await cleared;

      const noDuplicate = server.waitForNotification("textDocument/publishDiagnostics", (message) =>
        message.params?.uri === sourceUri && diagnosticCodes(message.params).length === 0, 300)
        .then(() => false, () => true);
      expect(await noDuplicate).toBe(true);
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("cancels pending debounced diagnostics when a document closes", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-close-diagnostics-"));
    const sourcePath = join(tempRoot, "main.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const source = "module app { I16 main() { ret missing; } }";
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, source);
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: sourceUri,
          languageId: "vela",
          version: 1,
          text: source,
        },
      });

      const stalePublish = server.waitForNotification("textDocument/publishDiagnostics", (message) =>
        message.params?.uri === sourceUri && diagnosticCodes(message.params).includes("vela.sem.unknownIdentifier"), 350)
        .then(() => true, () => false);
      const cleared = server.waitForNotification("textDocument/publishDiagnostics", (message) =>
        message.params?.uri === sourceUri && diagnosticCodes(message.params).length === 0);
      server.notify("textDocument/didClose", { textDocument: { uri: sourceUri } });

      expect((await cleared).params?.diagnostics).toEqual([]);
      expect(await stalePublish).toBe(false);
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("scopes workspace diagnostics according to configuration", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-workspace-diagnostics-"));
    const openPath = join(tempRoot, "open.vl");
    const closedPath = join(tempRoot, "closed.vl");
    const openUri = pathToFileURL(openPath).toString();
    const closedUri = pathToFileURL(closedPath).toString();
    const server = new ServerProcess(root);

    try {
      writeFileSync(openPath, "module open { I16 main() { ret missingOpen; } }");
      writeFileSync(closedPath, "module closed { I16 helper() { ret missingClosed; } }");
      server.setConfiguration({ diagnostics: { mode: "openFiles" } });
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: openUri,
          languageId: "vela",
          version: 1,
          text: "module open { I16 main() { ret missingOpen; } }",
        },
      });

      const openFilesReport = await server.request("workspace/diagnostic", { previousResultIds: [] });
      expect(workspaceDiagnosticUris(openFilesReport.result)).toContain(openUri);
      expect(workspaceDiagnosticUris(openFilesReport.result)).not.toContain(closedUri);
      const openFilesItem = workspaceDiagnosticItem(openFilesReport.result, openUri);
      expect(openFilesItem).toMatchObject({ kind: "full" });
      expect(openFilesItem?.resultId).toBeDefined();
      const unchangedOpenFilesReport = await server.request("workspace/diagnostic", { previousResultIds: [{ uri: openUri, value: openFilesItem?.resultId }] });
      expect(workspaceDiagnosticItem(unchangedOpenFilesReport.result, openUri)).toMatchObject({ kind: "unchanged", resultId: openFilesItem?.resultId });

      const openFilePullReport = await server.request("textDocument/diagnostic", { textDocument: { uri: openUri } });
      expect(diagnosticCodes(openFilePullReport.result)).toContain("vela.sem.unknownIdentifier");
      const closedOpenFilesPullReport = await server.request("textDocument/diagnostic", { textDocument: { uri: closedUri } });
      expect(diagnosticItems(closedOpenFilesPullReport.result)).toEqual([]);

      server.setConfiguration({ diagnostics: { mode: "workspace" } });
      const configurationRefresh = server.waitForNextConfigurationRequest();
      server.notify("workspace/didChangeConfiguration", { settings: {} });
      await configurationRefresh;

      const workspaceReport = await server.request("workspace/diagnostic", { previousResultIds: [] });
      expect(workspaceDiagnosticUris(workspaceReport.result)).toContain(openUri);
      expect(workspaceDiagnosticUris(workspaceReport.result)).toContain(closedUri);
      expect(workspaceDiagnosticItem(workspaceReport.result, closedUri)).toMatchObject({ kind: "full" });
      const closedWorkspacePullReport = await server.request("textDocument/diagnostic", { textDocument: { uri: closedUri } });
      expect(diagnosticCodes(closedWorkspacePullReport.result)).toContain("vela.sem.unknownIdentifier");
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("streams workspace diagnostic partial results with work-done progress", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-diagnostic-progress-"));
    const sourcePath = join(tempRoot, "diagnostics.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, "module diagnostics { I16 main() { ret missingDiagnostic; } }");
      server.setConfiguration({ diagnostics: { mode: "workspace" } });
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();

      const workToken = "workspace-diagnostic-work";
      const partialToken = "workspace-diagnostic-partial";
      const begin = server.waitForNotification("$/progress", (message) =>
        message.params?.token === workToken && message.params?.value?.kind === "begin");
      const partial = server.waitForNotification("$/progress", (message) =>
        message.params?.token === partialToken
        && Array.isArray(message.params?.value?.items)
        && workspaceDiagnosticUris(message.params.value).includes(sourceUri));
      const end = server.waitForNotification("$/progress", (message) =>
        message.params?.token === workToken && message.params?.value?.kind === "end");

      const response = await server.request("workspace/diagnostic", {
        previousResultIds: [],
        workDoneToken: workToken,
        partialResultToken: partialToken,
      });
      expect(response.result).toEqual({ items: [] });
      await begin;
      await partial;
      await end;
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("streams workspace symbol partial results with work-done progress", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-progress-"));
    const sourcePath = join(tempRoot, "symbols.vl");
    const sourceUri = pathToFileURL(sourcePath).toString();
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, `module symbols {
    I16 ProgressProbe() {
        ret 1;
    }
}`);
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();

      const workToken = "workspace-symbol-work";
      const partialToken = "workspace-symbol-partial";
      const begin = server.waitForNotification("$/progress", (message) =>
        message.params?.token === workToken && message.params?.value?.kind === "begin");
      const partial = server.waitForNotification("$/progress", (message) =>
        message.params?.token === partialToken
        && Array.isArray(message.params?.value)
        && symbolUris(message.params.value).includes(sourceUri));
      const end = server.waitForNotification("$/progress", (message) =>
        message.params?.token === workToken && message.params?.value?.kind === "end");

      const response = await server.request("workspace/symbol", {
        query: "ProgressProbe",
        workDoneToken: workToken,
        partialResultToken: partialToken,
      });
      expect(response.result).toEqual([]);
      await begin;
      await partial;
      await end;
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("honors cancellation before costly streamed requests start", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-cancel-"));
    const sourcePath = join(tempRoot, "cancel.vl");
    const source = `module cancel {
    type Drawable {
        skeleton U0 Draw();
    }

    class Sprite : Drawable {
        U0 Draw() {
            ret;
        }
    }

    I16 helper() {
        ret 1;
    }

    I16 main() {
        ret helper();
    }
}`;
    const sourceUri = pathToFileURL(sourcePath).toString();
    const server = new ServerProcess(root);

    try {
      writeFileSync(sourcePath, source);
      server.setConfiguration({ diagnostics: { mode: "workspace" } });
      await server.initialize(tempRoot);
      server.notify("initialized", {});
      await server.waitForConfigurationRequest();
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: sourceUri,
          languageId: "vela",
          version: 1,
          text: source,
        },
      });

      const symbols = await server.requestAndCancel("workspace/symbol", { query: "helper" });
      expect(symbols.result).toEqual([]);

      const diagnostics = await server.requestAndCancel("workspace/diagnostic", { previousResultIds: [] });
      expect(diagnostics.result).toEqual({ items: [] });

      const references = await server.requestAndCancel("textDocument/references", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "helper();"),
        context: { includeDeclaration: true },
      });
      expect(references.result).toEqual([]);

      const hierarchy = await server.request("textDocument/prepareTypeHierarchy", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "Drawable {"),
      });
      expect(itemNames(hierarchy.result)).toContain("Drawable");
      const subtypesResult = await server.requestAndCancel("typeHierarchy/subtypes", { item: hierarchy.result[0] });
      expect(subtypesResult.result).toEqual([]);

      const spriteHierarchy = await server.request("textDocument/prepareTypeHierarchy", {
        textDocument: { uri: sourceUri },
        position: positionIn(source, "Sprite :"),
      });
      expect(itemNames(spriteHierarchy.result)).toContain("Sprite");
      const supertypesResult = await server.requestAndCancel("typeHierarchy/supertypes", { item: spriteHierarchy.result[0] });
      expect(supertypesResult.result).toEqual([]);
    } finally {
      await server.shutdown();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

function symbolUris(symbols: unknown): string[] {
  return Array.isArray(symbols)
    ? symbols.map((symbol) => (symbol as { location?: { uri?: string } }).location?.uri).filter((uri): uri is string => !!uri)
    : [];
}

function completionLabels(result: unknown): string[] {
  const items = Array.isArray(result) ? result : (result as { items?: unknown[] } | undefined)?.items ?? [];
  return items.map((item) => String((item as { label?: unknown }).label ?? ""));
}

function completionAdditionalEditTexts(result: unknown, label: string): string[] {
  const items = Array.isArray(result) ? result : (result as { items?: unknown[] } | undefined)?.items ?? [];
  const item = items.find((candidate) => (candidate as { label?: unknown }).label === label) as { additionalTextEdits?: { newText?: unknown }[] } | undefined;
  return item?.additionalTextEdits?.map((edit) => String(edit.newText ?? "")) ?? [];
}

function locationUris(result: unknown): string[] {
  return locations(result).map((location) => location.uri);
}

function locationRanges(result: unknown): { start: { line: number; character: number }; end: { line: number; character: number } }[] {
  return locations(result).map((location) => location.range);
}

function locations(result: unknown): { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }[] {
  if (!result) {
    return [];
  }
  const items = Array.isArray(result) ? result : [result];
  return items.filter((item): item is { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } } =>
    typeof (item as { uri?: unknown }).uri === "string" && !!(item as { range?: unknown }).range);
}

function documentSymbolNames(result: unknown): string[] {
  const names: string[] = [];
  const visit = (items: unknown[]) => {
    for (const item of items) {
      const symbol = item as { name?: unknown; children?: unknown[] };
      if (typeof symbol.name === "string") {
        names.push(symbol.name);
      }
      if (Array.isArray(symbol.children)) {
        visit(symbol.children);
      }
    }
  };
  if (Array.isArray(result)) {
    visit(result);
  }
  return names;
}

function inlayHintLabels(result: unknown): string[] {
  return Array.isArray(result)
    ? result.map((hint) => String((hint as { label?: unknown }).label ?? ""))
    : [];
}

function inlayHintLabelAt(result: unknown, position: { line: number; character: number }): string | undefined {
  if (!Array.isArray(result)) {
    return undefined;
  }
  const hint = result.find((item) => {
    const candidate = item as { position?: { line?: unknown; character?: unknown } };
    return candidate.position?.line === position.line && candidate.position.character === position.character;
  }) as { label?: unknown } | undefined;
  return typeof hint?.label === "string" ? hint.label : undefined;
}

function signatureLabel(result: unknown): string | undefined {
  const signature = (result as { signatures?: { label?: unknown }[] } | undefined)?.signatures?.[0];
  return typeof signature?.label === "string" ? signature.label : undefined;
}

function itemNames(result: unknown): string[] {
  return Array.isArray(result)
    ? result.map((item) => String((item as { name?: unknown }).name ?? ""))
    : [];
}

function callFromNames(result: unknown): string[] {
  return Array.isArray(result)
    ? result.map((call) => String((call as { from?: { name?: unknown } }).from?.name ?? ""))
    : [];
}

function callToNames(result: unknown): string[] {
  return Array.isArray(result)
    ? result.map((call) => String((call as { to?: { name?: unknown } }).to?.name ?? ""))
    : [];
}

async function resolvedDocumentLinkTargets(server: ServerProcess, result: unknown): Promise<string[]> {
  if (!Array.isArray(result)) {
    return [];
  }
  const resolved = await Promise.all(result.map((link) => server.request("documentLink/resolve", link)));
  return resolved.map((message) => String(message.result?.target ?? ""));
}

function editTexts(result: unknown, uri: string): string[] {
  const edits = Array.isArray(result)
    ? result
    : ((result as { changes?: Record<string, { newText?: string }[]> } | undefined)?.changes?.[uri] ?? []);
  return edits.map((edit) => String((edit as { newText?: unknown }).newText ?? ""));
}

function codeActionTitles(result: unknown): string[] {
  return Array.isArray(result)
    ? result.map((action) => String((action as { title?: unknown }).title ?? ""))
    : [];
}

function codeActionKinds(result: unknown): string[] {
  return Array.isArray(result)
    ? result.map((action) => String((action as { kind?: unknown }).kind ?? ""))
    : [];
}

function codeActionEditTexts(result: unknown, title: string, uri: string): string[] {
  if (!Array.isArray(result)) {
    return [];
  }
  const action = result.find((candidate) => (candidate as { title?: unknown }).title === title) as { edit?: { changes?: Record<string, { newText?: unknown }[]> } } | undefined;
  return action?.edit?.changes?.[uri]?.map((edit) => String(edit.newText ?? "")) ?? [];
}

function markupText(contents: unknown): string {
  if (typeof contents === "string") {
    return contents;
  }
  if (Array.isArray(contents)) {
    return contents.map(markupText).join("\n");
  }
  return String((contents as { value?: unknown } | undefined)?.value ?? "");
}

function tracePayload(message: JsonRpcMessage): Record<string, unknown> {
  const raw = String(message.params?.message ?? "{}");
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function traceEvent(message: JsonRpcMessage): string | undefined {
  try {
    const event = tracePayload(message).event;
    return typeof event === "string" ? event : undefined;
  } catch {
    return undefined;
  }
}

function diagnosticCodes(report: unknown): string[] {
  return diagnosticItems(report).map((diagnostic) => String(diagnostic.code ?? ""));
}

function diagnosticItems(report: unknown): { code?: unknown; message?: unknown; range?: unknown }[] {
  return ((report as { items?: unknown[]; diagnostics?: unknown[] } | undefined)?.items
    ?? (report as { diagnostics?: unknown[] } | undefined)?.diagnostics
    ?? []) as { code?: unknown; message?: unknown; range?: unknown }[];
}

function diagnosticMessage(diagnostic: { message?: unknown }): string {
  return String(diagnostic.message ?? "");
}

function workspaceDiagnosticUris(report: unknown): string[] {
  const items = (report as { items?: unknown[] } | undefined)?.items ?? [];
  return items.map((item) => (item as { uri?: string }).uri).filter((uri): uri is string => !!uri);
}

function workspaceDiagnosticItem(report: unknown, uri: string): { uri?: string; kind?: string; resultId?: string; items?: unknown[] } | undefined {
  const items = (report as { items?: unknown[] } | undefined)?.items ?? [];
  return items.find((item) => (item as { uri?: string }).uri === uri) as { uri?: string; kind?: string; resultId?: string; items?: unknown[] } | undefined;
}

function positionIn(text: string, needle: string, delta = 0): { line: number; character: number } {
  const offset = text.indexOf(needle);
  if (offset < 0) {
    throw new Error(`missing test needle: ${needle}`);
  }
  return positionAtOffset(text, offset + delta);
}

function lineOf(text: string, needle: string): number {
  return positionIn(text, needle).line;
}

function positionAtOffset(text: string, offset: number): { line: number; character: number } {
  const prefix = text.slice(0, offset);
  const lines = prefix.split(/\r?\n/u);
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function fullRange(text: string): { start: { line: number; character: number }; end: { line: number; character: number } } {
  return { start: { line: 0, character: 0 }, end: positionAtOffset(text, text.length) };
}

function textForLspRange(text: string, range: unknown): string {
  const candidate = (range as { start?: { line: number; character: number }; end?: { line: number; character: number } } | undefined);
  if (!candidate?.start || !candidate.end) {
    return "";
  }
  return text.slice(offsetAtPosition(text, candidate.start), offsetAtPosition(text, candidate.end));
}

function offsetAtPosition(text: string, position: { line: number; character: number }): number {
  const lines = text.split(/\r?\n/u);
  let offset = 0;
  for (let line = 0; line < position.line; line++) {
    offset += (lines[line]?.length ?? 0) + 1;
  }
  return offset + position.character;
}

class ServerProcess {
  private readonly child;
  private buffer = Buffer.alloc(0);
  private stderr = "";
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, { resolve: (message: JsonRpcMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly notificationWaiters: {
    method: string;
    predicate: (message: JsonRpcMessage) => boolean;
    resolve: (message: JsonRpcMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];
  private readonly exitPromise: Promise<number | null>;
  private configuration: unknown = {};
  private workspaceFolderResponse: { uri: string; name: string }[] | null = null;
  private configurationRequestCount = 0;
  private configurationWaiters: { target: number; resolve: () => void }[] = [];
  private exitCode: number | null | undefined;

  constructor(private readonly root: string) {
    this.child = spawn(process.execPath, [resolve(this.root, "dist", "server.js"), "--stdio"], {
      cwd: this.root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exitPromise = new Promise((resolvePromise) => {
      this.child.on("exit", (code) => {
        this.exitCode = code;
        resolvePromise(code);
      });
    });
    this.child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.on("error", (error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  initialize(
    workspaceRoot?: string,
    options: {
      workspaceFolders?: boolean;
      workspaceFolderRoots?: string[];
      configuration?: boolean;
      diagnosticRefresh?: boolean;
      inlayHintRefresh?: boolean;
      semanticTokensRefresh?: boolean;
      foldingRangeRefresh?: boolean;
      workspaceSymbolResolve?: boolean;
      fileOperations?: boolean;
      textDocumentContent?: boolean;
    } = {},
  ): Promise<JsonRpcMessage> {
    const rootUri = workspaceRoot ? pathToFileURL(workspaceRoot).toString() : null;
    const workspaceFolderRoots = options.workspaceFolderRoots ?? (workspaceRoot ? [workspaceRoot] : []);
    const includeWorkspaceFolders = workspaceFolderRoots.length > 0 && options.workspaceFolders !== false;
    const configuration = options.configuration !== false;
    return this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: includeWorkspaceFolders
        ? workspaceFolderRoots.map((folder, index) => ({ uri: pathToFileURL(folder).toString(), name: `test-${index}` }))
        : undefined,
      capabilities: {
        window: { showDocument: { support: true }, workDoneProgress: true },
        workspace: {
          configuration,
          symbol: options.workspaceSymbolResolve ? { resolveSupport: { properties: ["location.range"] } } : undefined,
          diagnostics: options.diagnosticRefresh ? { refreshSupport: true } : undefined,
          inlayHint: options.inlayHintRefresh ? { refreshSupport: true } : undefined,
          semanticTokens: options.semanticTokensRefresh ? { refreshSupport: true } : undefined,
          foldingRange: options.foldingRangeRefresh ? { refreshSupport: true } : undefined,
          textDocumentContent: options.textDocumentContent === false ? undefined : {},
          workspaceFolders: true,
          fileOperations: options.fileOperations === false ? undefined : {
            didCreate: true,
            willRename: true,
            didRename: true,
            willDelete: true,
            didDelete: true,
          },
        },
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            didSave: true,
          },
        },
      },
    });
  }

  setConfiguration(configuration: unknown): void {
    this.configuration = configuration;
  }

  setWorkspaceFolders(folders: { uri: string; name: string }[] | null): void {
    this.workspaceFolderResponse = folders;
  }

  configurationRequests(): number {
    return this.configurationRequestCount;
  }

  waitForConfigurationRequest(timeoutMs = 5000): Promise<void> {
    return this.waitForConfigurationCount(1, timeoutMs);
  }

  waitForNextConfigurationRequest(timeoutMs = 5000): Promise<void> {
    return this.waitForConfigurationCount(this.configurationRequestCount + 1, timeoutMs);
  }

  private waitForConfigurationCount(target: number, timeoutMs = 5000): Promise<void> {
    if (this.configurationRequestCount >= target) {
      return Promise.resolve();
    }
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`workspace/configuration timeout${this.stderr.trim() ? ` stderr=${this.stderr.trim()}` : ""}`));
      }, timeoutMs);
      this.configurationWaiters.push({ target, resolve: () => {
        clearTimeout(timer);
        resolvePromise();
      } });
    });
  }

  request(method: string, params: unknown, timeoutMs = 5000): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<JsonRpcMessage>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.child.kill();
        reject(new Error(`${method} timeout${this.stderr.trim() ? ` stderr=${this.stderr.trim()}` : ""}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
    });
    this.send(message);
    return promise;
  }

  requestAndCancel(method: string, params: unknown, timeoutMs = 5000): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<JsonRpcMessage>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.child.kill();
        reject(new Error(`${method} cancellation timeout${this.stderr.trim() ? ` stderr=${this.stderr.trim()}` : ""}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
    });
    this.child.stdin.write(`${encode(message)}${encode({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } })}`);
    return promise;
  }

  requestAndCancelAfter(method: string, params: unknown, delayMs: number, timeoutMs = 5000): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<JsonRpcMessage>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.child.kill();
        reject(new Error(`${method} delayed cancellation timeout${this.stderr.trim() ? ` stderr=${this.stderr.trim()}` : ""}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
    });
    this.send(message);
    setTimeout(() => {
      this.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
    }, delayMs);
    return promise;
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  waitForNotification(method: string, predicate: (message: JsonRpcMessage) => boolean = () => true, timeoutMs = 5000): Promise<JsonRpcMessage> {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.removeNotificationWaiter(method, reject);
        reject(new Error(`${method} notification timeout${this.stderr.trim() ? ` stderr=${this.stderr.trim()}` : ""}`));
      }, timeoutMs);
      this.notificationWaiters.push({ method, predicate, resolve: resolvePromise, reject, timer });
    });
  }

  async shutdown(): Promise<void> {
    if (this.exitCode !== undefined) {
      return;
    }
    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
      const code = await this.exitPromise;
      expect(code).toBe(0);
    } catch (error) {
      this.child.kill();
      throw error;
    }
  }

  private send(message: unknown): void {
    this.child.stdin.write(encode(message));
  }

  private pump(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const match = /Content-Length: *(\d+)/i.exec(header);
      if (!match) {
        this.rejectAll(new Error("missing Content-Length header"));
        this.child.kill();
        return;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) {
        return;
      }
      const message = JSON.parse(this.buffer.slice(start, start + length).toString("utf8")) as JsonRpcMessage;
      this.buffer = this.buffer.slice(start + length);
      this.handle(message);
    }
  }

  private handle(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.method) {
      this.respondToServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message);
      return;
    }
    if (message.method) {
      this.resolveNotificationWaiters(message);
    }
  }

  private respondToServerRequest(message: JsonRpcMessage): void {
    this.resolveNotificationWaiters(message);
    if (message.method === "workspace/configuration") {
      const items = Array.isArray(message.params?.items) ? message.params.items : [{}];
      this.configurationRequestCount++;
      this.send({ jsonrpc: "2.0", id: message.id, result: items.map(() => this.configuration) });
      const pending = this.configurationWaiters.splice(0);
      for (const waiter of pending) {
        if (this.configurationRequestCount >= waiter.target) {
          waiter.resolve();
        } else {
          this.configurationWaiters.push(waiter);
        }
      }
      return;
    }
    if (message.method === "workspace/workspaceFolders") {
      this.send({ jsonrpc: "2.0", id: message.id, result: this.workspaceFolderResponse });
      return;
    }
    if (message.method === "window/workDoneProgress/create") {
      this.send({ jsonrpc: "2.0", id: message.id, result: null });
      return;
    }
    if (message.method === "window/showDocument") {
      this.send({ jsonrpc: "2.0", id: message.id, result: { success: true } });
      return;
    }
    this.send({ jsonrpc: "2.0", id: message.id, result: null });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private resolveNotificationWaiters(message: JsonRpcMessage): void {
    for (let i = 0; i < this.notificationWaiters.length; i++) {
      const waiter = this.notificationWaiters[i]!;
      if (waiter.method !== message.method || !waiter.predicate(message)) {
        continue;
      }
      this.notificationWaiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
  }

  private removeNotificationWaiter(method: string, reject: (error: Error) => void): void {
    const index = this.notificationWaiters.findIndex((waiter) => waiter.method === method && waiter.reject === reject);
    if (index >= 0) {
      this.notificationWaiters.splice(index, 1);
    }
  }
}
