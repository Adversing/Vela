# Vela Language Server

This package implements a TypeScript Language Server Protocol backend for Vela
`.vl` files. It runs over stdio.

## Setup

```bash
npm install
npm run build
npm test
node dist/server.js --stdio
```

The server indexes open `.vl` documents, workspace `.vl` files, and the bundled
`stdlib/` tree from the repository root. It derives syntax and semantic data
from the Vela compiler sources and keeps LSP protocol code separate from the
Vela frontend and workspace index.

## VS Code Extension Integration

A VS Code extension should launch the built server over stdio and register it
for Vela source documents:

```ts
import { ExtensionContext } from "vscode";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";

export function activate(context: ExtensionContext) {
  const serverModule = context.asAbsolutePath("ext/vela-lsp/dist/server.js");
  const client = new LanguageClient("vela", "Vela", {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: { module: serverModule, transport: TransportKind.stdio },
  }, {
    documentSelector: [{ language: "vela", scheme: "file" }],
    synchronize: {
      fileEvents: [
        "**/*.vl",
      ],
    },
  });

  context.subscriptions.push(client.start());
}
```

The extension should contribute a `vela` language for `*.vl` files and forward
the `vela.*` settings listed below through normal workspace configuration.

When initialization omits workspace folder data, the server requests
`workspace/workspaceFolders` from clients that advertise the capability before
loading configuration and indexing project files.

Semantic tokens are served for full documents, ranges, and delta requests. The
server also refreshes client-side diagnostics, inlay hints, semantic tokens, and
folding ranges after configuration changes when the client advertises the
corresponding refresh capability.

Long-running streamed requests and compile/run commands honor LSP cancellation,
including cancellation of spawned compiler or CPU simulator processes.

Workspace symbol requests use `workspaceSymbol/resolve` when the client
advertises symbol resolve support, returning URI-only matches first and resolving
precise ranges on demand.

Workspace file operations keep import declarations in sync for Vela source
renames and deletes when the client sends `workspace/willRenameFiles` or
`workspace/willDeleteFiles`.

Read-only virtual documents are exposed through `workspace/textDocumentContent`
for `vela-stdlib:/...` stdlib import links, `vela-builtin:/builtins.vl`
built-in definitions, and `vela-asm:...` assembly output created by
`vela.showAssembly`. Regenerated assembly documents send
`workspace/textDocumentContent/refresh` so open virtual documents stay current.

## Configuration

Supported settings:

- `vela.projectRoot`: project root used for workspace import resolution.
- `vela.stdlibPath`: path to the repository `stdlib` directory or its parent.
- `vela.requireMainDiagnostic`: `off`, `currentFile`, or `workspaceEntry`.
- `vela.workspaceEntry`: entry file for workspace compile diagnostics/command.
- `vela.diagnostics.mode`: `openFiles` or `workspace`.
- `vela.inlayHints.parameterNames`: enable call parameter hints.
- `vela.inlayHints.inferredTypes`: enable inferred expression type hints.
- `vela.inlayHints.layout`: enable field offset and class size hints.
- `vela.formatting.enabled`: enable formatter handlers.
- `vela.trace.server`: enable structured trace logging.
- `vela.devCommands.dumpSymbolIndex`: enable the development-only symbol index dump command.
- `vela.cpuSimulatorPath`: optional path used by run-oriented integrations.

## Commands

- `vela.compileCurrentFile`: compile a file URI, using open editor contents when
  available.
- `vela.compileWorkspaceEntry`: compile `vela.workspaceEntry`.
- `vela.showAssembly`: compile and open a read-only `vela-asm:` document.
- `vela.runCurrentProgram`: compile the current file and run the generated
  `.de1` with `python run.py <file.de1>`. This command is disabled until
  `vela.cpuSimulatorPath` points to the CPU repository directory or its `run.py`.
- `vela.restartServer`: report that the client should restart the server.
- `vela.dumpSymbolIndex`: development-only index dump, gated by
  `vela.devCommands.dumpSymbolIndex`.

The server intentionally does not advertise:

- `documentColorProvider`, because Vela has no color literal syntax.
- `inlineValueProvider`, because the server has no runtime/debug value source.
- `linkedEditingRangeProvider`, because Vela currently has no paired editable
  syntax whose linked edits are safer than normal rename/prepareRename.
