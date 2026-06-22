#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CodeAction,
  CodeActionKind,
  CancellationToken,
  CreateFilesParams,
  DeleteFilesParams,
  DidChangeConfigurationParams,
  Diagnostic,
  DidChangeWorkspaceFoldersParams,
  DocumentDiagnosticReportKind,
  FileChangeType,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  Range,
  RenameFilesParams,
  ResultProgressReporter,
  TextDocumentSyncKind,
  TextDocuments,
  WorkDoneProgressReporter,
  WorkspaceSymbol,
  createConnection,
} from "vscode-languageserver/node";
import type { DocumentDiagnosticReport, WorkspaceDocumentDiagnosticReport } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  BUILTIN_VIRTUAL_URI,
  builtinVirtualText,
  codeActions,
  completions,
  declaration,
  definition,
  documentLinks,
  documentSymbols,
  fileDeleteImportEdit,
  fileRenameImportEdit,
  foldingRanges,
  formatting,
  highlights,
  hover,
  implementation,
  incomingCalls,
  inlayHints,
  moniker,
  outgoingCalls,
  prepareCallHierarchy,
  prepareRename,
  prepareTypeHierarchy,
  references,
  rename,
  resolvableWorkspaceSymbols,
  resolveDocumentLink,
  resolveWorkspaceSymbol,
  selectionRanges,
  semanticTokenModifiers,
  semanticTokenTypes,
  semanticTokens,
  signatureHelp,
  subtypes,
  supertypes,
  typeDefinition,
  workspaceSymbols,
} from "./lsp/features.js";
import { runCompiler } from "./compilerRunner.js";
import { runCpuSimulator } from "./cpuRunner.js";
import { DEFAULT_SETTINGS, VelaSettings, WorkspaceIndex, uriToPath } from "./workspace/workspaceIndex.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compilerRoot = resolve(extensionRoot, "..", "..");
const index = new WorkspaceIndex(extensionRoot);
const diagnosticTimers = new Map<string, NodeJS.Timeout>();
const virtualDocuments = new Map<string, { text: string; language: string; sourcePath: string }>();
const semanticTokenCache = new Map<string, { uri: string; data: number[] }>();
const diagnosticResultCache = new Map<string, { signature: string; resultId: string }>();
const MAX_SEMANTIC_TOKEN_CACHE_ENTRIES = 32;
const MAX_DIAGNOSTIC_RESULT_CACHE_ENTRIES = 512;
const MAX_VIRTUAL_DOCUMENT_CACHE_ENTRIES = 16;

let workspaceFolders: string[] = [];
let initialized = false;
let configurationWarningSignature = "";
let showDocumentSupported = false;
let configurationSupported = false;
let workspaceFoldersSupported = false;
let workspaceSymbolResolveSupported = false;
let fileOperationsSupported = false;
let textDocumentContentSupported = false;
let foldingRangeRefreshSupported = false;
let diagnosticRefreshSupported = false;
let inlayHintRefreshSupported = false;
let semanticTokensRefreshSupported = false;
let workspaceFolderChangeSubscriptionRegistered = false;
let repoRootFallbackEnabled = true;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  workspaceFolders = initializeWorkspaceFolders(params);
  showDocumentSupported = params.capabilities.window?.showDocument?.support === true;
  configurationSupported = params.capabilities.workspace?.configuration === true;
  workspaceFoldersSupported = params.capabilities.workspace?.workspaceFolders === true;
  workspaceSymbolResolveSupported = params.capabilities.workspace?.symbol?.resolveSupport !== undefined;
  fileOperationsSupported = params.capabilities.workspace?.fileOperations !== undefined;
  textDocumentContentSupported = params.capabilities.workspace?.textDocumentContent !== undefined;
  foldingRangeRefreshSupported = params.capabilities.workspace?.foldingRange?.refreshSupport === true;
  diagnosticRefreshSupported = params.capabilities.workspace?.diagnostics?.refreshSupport === true;
  inlayHintRefreshSupported = params.capabilities.workspace?.inlayHint?.refreshSupport === true;
  semanticTokensRefreshSupported = params.capabilities.workspace?.semanticTokens?.refreshSupport === true;
  repoRootFallbackEnabled = workspaceFolders.length === 0 && !workspaceFoldersSupported;
  configureIndex(DEFAULT_SETTINGS);
  index.indexWorkspace();
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: [".", ":", "{", "[", "<", "(", ","],
      },
      hoverProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ["(", ","],
        retriggerCharacters: [","],
      },
      declarationProvider: true,
      definitionProvider: true,
      typeDefinitionProvider: true,
      implementationProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: {
        resolveProvider: workspaceSymbolResolveSupported,
      },
      documentLinkProvider: {
        resolveProvider: true,
      },
      monikerProvider: true,
      semanticTokensProvider: {
        legend: {
          tokenTypes: semanticTokenTypes,
          tokenModifiers: semanticTokenModifiers,
        },
        full: { delta: true },
        range: true,
      },
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      documentOnTypeFormattingProvider: {
        firstTriggerCharacter: ";",
        moreTriggerCharacter: ["}", "\n", ")"],
      },
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.SourceOrganizeImports, CodeActionKind.RefactorRewrite],
        resolveProvider: false,
      },
      renameProvider: {
        prepareProvider: true,
      },
      inlayHintProvider: {
        resolveProvider: false,
      },
      foldingRangeProvider: true,
      selectionRangeProvider: true,
      callHierarchyProvider: true,
      typeHierarchyProvider: true,
      diagnosticProvider: {
        interFileDependencies: true,
        workspaceDiagnostics: true,
      },
      executeCommandProvider: {
        commands: [
          "vela.compileCurrentFile",
          "vela.compileWorkspaceEntry",
          "vela.showAssembly",
          "vela.runCurrentProgram",
          "vela.restartServer",
          "vela.dumpSymbolIndex",
        ],
      },
      workspace: {
        workspaceFolders: {
          supported: true,
          changeNotifications: true,
        },
        ...(fileOperationsSupported ? { fileOperations: {
          didCreate: { filters: [{ pattern: { glob: "**/*.vl" } }] },
          willRename: { filters: [{ pattern: { glob: "**/*.vl" } }] },
          didRename: { filters: [{ pattern: { glob: "**/*.vl" } }] },
          willDelete: { filters: [{ pattern: { glob: "**/*.vl" } }] },
          didDelete: { filters: [{ pattern: { glob: "**/*.vl" } }] },
        } } : {}),
        ...(textDocumentContentSupported ? { textDocumentContent: {
          schemes: ["vela-asm", "vela-stdlib", "vela-builtin"],
        } } : {}),
      },
    },
  };
});

function initializeWorkspaceFolders(params: InitializeParams): string[] {
  const folders = (params.workspaceFolders ?? [])
    .map((folder) => fileUriPath(folder.uri))
    .filter((path): path is string => !!path);
  if (folders.length > 0) {
    return uniqueWorkspaceFolders(folders);
  }
  const rootUriPath = params.rootUri ? fileUriPath(params.rootUri) : undefined;
  if (rootUriPath) {
    return [normalizeWorkspaceFolder(rootUriPath)];
  }
  const rootPath = (params as InitializeParams & { rootPath?: string | null }).rootPath;
  return rootPath ? [normalizeWorkspaceFolder(rootPath)] : [];
}

function fileUriPath(uri: string): string | undefined {
  if (!uri.startsWith("file:")) {
    return undefined;
  }
  try {
    return normalizeWorkspaceFolder(uriToPath(uri));
  } catch {
    return undefined;
  }
}

function isFileVelaUri(uri: string): boolean {
  return !!fileUriPath(uri) && uri.toLowerCase().endsWith(".vl");
}

function uriFiles(params: unknown): { uri: string }[] {
  return arraySetting(params, "files")
    .map((file) => objectSetting(file))
    .filter((file): file is { uri: string } => typeof file.uri === "string");
}

function renamedFiles(params: unknown): { oldUri: string; newUri: string }[] {
  return arraySetting(params, "files")
    .map((file) => objectSetting(file))
    .filter((file): file is { oldUri: string; newUri: string } =>
      typeof file.oldUri === "string" && typeof file.newUri === "string");
}

function watchedFileChanges(params: unknown): { uri: string; type: FileChangeType }[] {
  return arraySetting(params, "changes")
    .map((change) => objectSetting(change))
    .filter((change): change is { uri: string; type: FileChangeType } =>
      typeof change.uri === "string"
      && (change.type === FileChangeType.Created || change.type === FileChangeType.Changed || change.type === FileChangeType.Deleted));
}

function workspaceFolderUris(params: unknown, key: "added" | "removed"): string[] {
  const event = objectSetting(objectSetting(params).event);
  return arraySetting(event, key)
    .map((folder) => objectSetting(folder).uri)
    .filter((uri): uri is string => typeof uri === "string");
}

function workspaceFolderPaths(folders: readonly { uri: string }[] | null | undefined): string[] {
  return uniqueWorkspaceFolders((folders ?? [])
    .map((folder) => fileUriPath(folder.uri))
    .filter((path): path is string => !!path));
}

function normalizeWorkspaceFolder(path: string): string {
  return resolve(path);
}

function workspaceFolderKey(path: string): string {
  const normalized = normalizeWorkspaceFolder(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function uniqueWorkspaceFolders(paths: string[]): string[] {
  const unique = new Map<string, string>();
  for (const path of paths) {
    unique.set(workspaceFolderKey(path), normalizeWorkspaceFolder(path));
  }
  return [...unique.values()];
}

function arraySetting(value: unknown, key: string): unknown[] {
  const array = objectSetting(value)[key];
  return Array.isArray(array) ? array : [];
}

function statForPath(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

connection.onInitialized(async () => {
  initialized = true;
  registerWorkspaceFolderChangeHandler();
  await refreshWorkspaceFoldersFromClient();
  await refreshConfiguration();
  index.indexWorkspace();
  traceLog("workspace.reindexed", { reason: "initialized", files: index.allFiles().length });
  for (const document of openVelaDocuments()) {
    reindexDocument(document);
    publishDiagnostics(document.uri);
  }
});

connection.onShutdown(() => {
  for (const timer of diagnosticTimers.values()) {
    clearTimeout(timer);
  }
  diagnosticTimers.clear();
});

connection.onExit(() => {
  process.exit(0);
});

connection.onDidChangeConfiguration(async (params: DidChangeConfigurationParams) => {
  await refreshConfiguration(configurationFromDidChange(params.settings));
  index.indexWorkspace();
  traceLog("workspace.reindexed", { reason: "configuration", files: index.allFiles().length });
  for (const document of openVelaDocuments()) {
    reindexDocument(document);
    publishDiagnostics(document.uri);
  }
  refreshClientDerivedState();
});

function registerWorkspaceFolderChangeHandler(): void {
  if (!workspaceFoldersSupported || workspaceFolderChangeSubscriptionRegistered) {
    return;
  }
  workspaceFolderChangeSubscriptionRegistered = true;
  connection.workspace.onDidChangeWorkspaceFolders((event) => {
    handleWorkspaceFolderChange({ event });
  });
}

function handleWorkspaceFolderChange(params: DidChangeWorkspaceFoldersParams): void {
  let changed = false;
  const removedFolders = workspaceFolderUris(params, "removed");
  const addedFolders = workspaceFolderUris(params, "added");
  for (const uri of removedFolders) {
    const path = fileUriPath(uri);
    if (path) {
      const removedKey = workspaceFolderKey(path);
      workspaceFolders = workspaceFolders.filter((folder) => workspaceFolderKey(folder) !== removedKey);
      changed = true;
    }
  }
  for (const uri of addedFolders) {
    const path = fileUriPath(uri);
    if (path) {
      workspaceFolders.push(normalizeWorkspaceFolder(path));
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  workspaceFolders = uniqueWorkspaceFolders(workspaceFolders);
  repoRootFallbackEnabled = false;
  configureIndex(index.settingsSnapshot());
  index.indexWorkspace();
  traceLog("workspace.foldersChanged", { added: addedFolders.length, removed: removedFolders.length, folders: workspaceFolders.length, files: index.allFiles().length });
  publishOpenDiagnostics();
}

connection.onDidChangeWatchedFiles((params) => {
  let handled = 0;
  for (const change of watchedFileChanges(params)) {
    if (!isFileVelaUri(change.uri)) {
      continue;
    }
    handled++;
    if (change.type === FileChangeType.Deleted) {
      removeFileSnapshot(change.uri);
    } else {
      refreshFileSnapshot(change.uri);
    }
  }
  if (handled === 0) {
    return;
  }
  index.indexWorkspace();
  traceLog("workspace.watchedFilesChanged", { changes: handled, files: index.allFiles().length });
  publishOpenDiagnostics();
});

connection.onNotification("workspace/didCreateFiles", (params: CreateFilesParams) => {
  let created = 0;
  for (const file of uriFiles(params)) {
    if (isFileVelaUri(file.uri)) {
      created++;
      refreshFileSnapshot(file.uri);
    }
  }
  if (created === 0) {
    return;
  }
  index.indexWorkspace();
  traceLog("workspace.filesCreated", { files: created, indexedFiles: index.allFiles().length });
  publishOpenDiagnostics();
});

connection.workspace.onWillRenameFiles((params: RenameFilesParams, token) => {
  if (token.isCancellationRequested) {
    return null;
  }
  const renameEvents = renamedFiles(params);
  const files = renameEvents.filter((file) => isFileVelaUri(file.oldUri) && isFileVelaUri(file.newUri));
  const edit = files.length > 0 ? fileRenameImportEdit(index, files) : null;
  traceLog("workspace.filesWillRename", { files: renameEvents.length, edits: workspaceEditSize(edit) });
  return edit;
});

connection.workspace.onWillDeleteFiles((params: DeleteFilesParams, token) => {
  if (token.isCancellationRequested) {
    return null;
  }
  const files = uriFiles(params).filter((file) => isFileVelaUri(file.uri));
  const edit = files.length > 0 ? fileDeleteImportEdit(index, files) : null;
  traceLog("workspace.filesWillDelete", { files: uriFiles(params).length, edits: workspaceEditSize(edit) });
  return edit;
});

connection.workspace.textDocumentContent.on((params) => virtualDocumentContent(params.uri));

connection.onNotification("workspace/didRenameFiles", (params: { files: { oldUri: string; newUri: string }[] }) => {
  let renamed = 0;
  for (const file of renamedFiles(params)) {
    let handled = false;
    if (isFileVelaUri(file.oldUri)) {
      handled = true;
      removeFileSnapshot(file.oldUri);
    }
    if (isFileVelaUri(file.newUri)) {
      handled = true;
      refreshFileSnapshot(file.newUri);
    }
    if (handled) {
      renamed++;
    }
  }
  if (renamed === 0) {
    return;
  }
  index.indexWorkspace();
  traceLog("workspace.filesRenamed", { files: renamed, indexedFiles: index.allFiles().length });
  publishOpenDiagnostics();
});

connection.onNotification("workspace/didDeleteFiles", (params: { files: { uri: string }[] }) => {
  let deleted = 0;
  for (const file of uriFiles(params)) {
    if (isFileVelaUri(file.uri)) {
      deleted++;
      removeFileSnapshot(file.uri);
    }
  }
  if (deleted === 0) {
    return;
  }
  index.indexWorkspace();
  traceLog("workspace.filesDeleted", { files: deleted, indexedFiles: index.allFiles().length });
  publishOpenDiagnostics();
});

documents.onDidOpen((event) => {
  if (!isFileVelaUri(event.document.uri)) {
    return;
  }
  reindexDocument(event.document);
  scheduleOpenDiagnostics();
});

documents.onDidChangeContent((event) => {
  if (!isFileVelaUri(event.document.uri)) {
    return;
  }
  reindexDocument(event.document);
  scheduleOpenDiagnostics();
});

documents.onDidSave((event) => {
  if (!isFileVelaUri(event.document.uri)) {
    return;
  }
  cancelDiagnostics(event.document.uri);
  reindexDocument(event.document);
  publishOpenDiagnostics();
});

documents.onDidClose((event) => {
  if (!isFileVelaUri(event.document.uri)) {
    return;
  }
  cancelDiagnostics(event.document.uri);
  index.closeDocument(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  publishOpenDiagnostics();
});

connection.languages.diagnostics.on((params) =>
  safeResult("textDocument/diagnostic", emptyDocumentDiagnosticReport(), () =>
    documentDiagnosticReport(params.textDocument.uri, params.previousResultId)));

connection.languages.diagnostics.onWorkspace((params, token, workDoneProgress, resultProgress) => {
  return safeResult("workspace/diagnostic", { items: [] }, () => {
    if (token.isCancellationRequested) {
      return { items: [] };
    }
    const previous = new Map((params.previousResultIds ?? []).map((item) => [item.uri, item.value]));
    return withWorkDone(workDoneProgress, "Computing Vela workspace diagnostics", token, { items: [] }, async () =>
      reportPartialItems(workspaceDiagnosticReports(previous), resultProgress, token));
  });
});

connection.onCompletion((params, token) => {
  return safeResult("textDocument/completion", [], () => {
    if (token.isCancellationRequested) {
      return [];
    }
    return completions(index, params.textDocument.uri, params.position);
  });
});

connection.onHover((params, token) => {
  return safeResult("textDocument/hover", null, () => {
    if (token.isCancellationRequested) {
      return null;
    }
    return hover(index, params.textDocument.uri, params.position);
  });
});

connection.onSignatureHelp((params, token) => safeResult("textDocument/signatureHelp", null, () => token.isCancellationRequested ? null : signatureHelp(index, params.textDocument.uri, params.position)));
connection.onDeclaration((params, token) => safeResult("textDocument/declaration", [], () => token.isCancellationRequested ? [] : declaration(index, params.textDocument.uri, params.position)));
connection.onDefinition((params, token) => safeResult("textDocument/definition", [], () => token.isCancellationRequested ? [] : definition(index, params.textDocument.uri, params.position)));
connection.onTypeDefinition((params, token) => safeResult("textDocument/typeDefinition", [], () => token.isCancellationRequested ? [] : typeDefinition(index, params.textDocument.uri, params.position)));
connection.onImplementation((params, token) => safeResult("textDocument/implementation", [], () => token.isCancellationRequested ? [] : implementation(index, params.textDocument.uri, params.position)));
connection.onReferences((params, token, workDoneProgress, resultProgress) => {
  return safeResult("textDocument/references", [], () => {
    if (token.isCancellationRequested) {
      return [];
    }
    return withWorkDone(workDoneProgress, "Finding Vela references", token, [], async () =>
      reportPartialArray(references(index, params.textDocument.uri, params.position, params.context.includeDeclaration), resultProgress, token));
  });
});
connection.onDocumentHighlight((params, token) => safeResult("textDocument/documentHighlight", [], () => token.isCancellationRequested ? [] : highlights(index, params.textDocument.uri, params.position)));

connection.onDocumentSymbol((params, token) => {
  return safeResult("textDocument/documentSymbol", [], () => {
    const state = index.get(params.textDocument.uri);
    return !state || token.isCancellationRequested ? [] : documentSymbols(state);
  });
});

connection.onWorkspaceSymbol((params, token, workDoneProgress, resultProgress) => {
  return safeResult("workspace/symbol", [], () => {
    if (token.isCancellationRequested) {
      return [];
    }
    if (workspaceSymbolResolveSupported) {
      return withWorkDone(workDoneProgress, "Searching Vela workspace symbols", token, [], async () =>
        reportPartialArray(resolvableWorkspaceSymbols(index, params.query), resultProgress as ResultProgressReporter<WorkspaceSymbol[]> | undefined, token));
    }
    return withWorkDone(workDoneProgress, "Searching Vela workspace symbols", token, [], async () =>
      reportPartialArray(workspaceSymbols(index, params.query), resultProgress, token));
  });
});

connection.onWorkspaceSymbolResolve((symbol, token) => safeResult("workspaceSymbol/resolve", symbol, () => token.isCancellationRequested ? symbol : resolveWorkspaceSymbol(index, symbol)));

connection.onDocumentLinks((params, token) => {
  return safeResult("textDocument/documentLink", [], () => {
    const state = index.get(params.textDocument.uri);
    return !state || token.isCancellationRequested ? [] : documentLinks(index, state);
  });
});
connection.onDocumentLinkResolve((link) => safeResult("documentLink/resolve", link, () => resolveDocumentLink(index, link)));

connection.languages.moniker.on((params, token) => safeResult("textDocument/moniker", [], () => token.isCancellationRequested ? [] : moniker(index, params.textDocument.uri, params.position)));

connection.languages.semanticTokens.on((params, token) => {
  return safeResult("textDocument/semanticTokens/full", { data: [] }, () => {
    const state = index.get(params.textDocument.uri);
    if (!state || token.isCancellationRequested) {
      return { data: [] };
    }
    const tokens = semanticTokens(state);
    cacheSemanticTokens(state.uri, tokens);
    return tokens;
  });
});
connection.languages.semanticTokens.onDelta((params, token) => {
  return safeResult("textDocument/semanticTokens/full/delta", { data: [] }, () => {
    const state = index.get(params.textDocument.uri);
    if (!state || token.isCancellationRequested) {
      return { data: [] };
    }
    const previous = semanticTokenCache.get(params.previousResultId);
    const tokens = semanticTokens(state);
    cacheSemanticTokens(state.uri, tokens);
    return previous && previous.uri === state.uri
      ? { resultId: tokens.resultId, edits: semanticTokenEdits(previous.data, tokens.data) }
      : tokens;
  });
});
connection.languages.semanticTokens.onRange((params, token) => {
  return safeResult("textDocument/semanticTokens/range", { data: [] }, () => {
    const state = index.get(params.textDocument.uri);
    return !state || token.isCancellationRequested ? { data: [] } : semanticTokens(state, params.range);
  });
});

connection.onDocumentFormatting((params, token) => {
  return safeResult("textDocument/formatting", [], () => {
    const state = index.get(params.textDocument.uri);
    return !state || token.isCancellationRequested || !index.settingsSnapshot().formatting.enabled ? [] : formatting(state);
  });
});
connection.onDocumentRangeFormatting((params, token) => {
  return safeResult("textDocument/rangeFormatting", [], () => {
    const state = index.get(params.textDocument.uri);
    return !state || token.isCancellationRequested || !index.settingsSnapshot().formatting.enabled ? [] : formatting(state, params.range);
  });
});
connection.onDocumentOnTypeFormatting((params, token) => {
  return safeResult("textDocument/onTypeFormatting", [], () => {
    const state = index.get(params.textDocument.uri);
    const line = params.ch === "\n" ? Math.max(0, params.position.line - 1) : params.position.line;
    return !state || token.isCancellationRequested || !index.settingsSnapshot().formatting.enabled ? [] : formatting(state, documentLineRange(state.text, line));
  });
});

connection.onCodeAction((params, token) => {
  return safeResult("textDocument/codeAction", [], () => {
    const state = index.get(params.textDocument.uri);
    return !state || token.isCancellationRequested ? [] : filterCodeActions(codeActions(index, state, params.context.diagnostics), params.context.only);
  });
});

connection.onPrepareRename((params, token) => safeResult("textDocument/prepareRename", null, () => token.isCancellationRequested ? null : prepareRename(index, params.textDocument.uri, params.position)));
connection.onRenameRequest((params, token) => safeResult("textDocument/rename", {}, () => token.isCancellationRequested ? {} : rename(index, params)));

connection.languages.inlayHint.on((params, token) => {
  return safeResult("textDocument/inlayHint", [], () => {
    const state = index.get(params.textDocument.uri);
    return !state || token.isCancellationRequested ? [] : inlayHints(index, state).filter((hint) => rangeContains(params.range, hint.position));
  });
});

connection.onFoldingRanges((params, token) => {
  return safeResult("textDocument/foldingRange", [], () => {
    const state = index.get(params.textDocument.uri);
    return !state || token.isCancellationRequested ? [] : foldingRanges(state);
  });
});

connection.onSelectionRanges((params, token) => {
  return safeResult("textDocument/selectionRange", [], () => {
    const state = index.get(params.textDocument.uri);
    return !state || token.isCancellationRequested ? [] : selectionRanges(state, params.positions);
  });
});

connection.languages.callHierarchy.onPrepare((params, token) => safeResult("textDocument/prepareCallHierarchy", [], () => token.isCancellationRequested ? [] : prepareCallHierarchy(index, params.textDocument.uri, params.position)));
connection.languages.callHierarchy.onIncomingCalls((params, token, workDoneProgress, resultProgress) => {
  return safeResult("callHierarchy/incomingCalls", [], () => {
    if (token.isCancellationRequested) {
      return [];
    }
    return withWorkDone(workDoneProgress, "Resolving Vela incoming calls", token, [], async () =>
      reportPartialArray(incomingCalls(index, params.item), resultProgress, token));
  });
});
connection.languages.callHierarchy.onOutgoingCalls((params, token, workDoneProgress, resultProgress) => {
  return safeResult("callHierarchy/outgoingCalls", [], () => {
    if (token.isCancellationRequested) {
      return [];
    }
    return withWorkDone(workDoneProgress, "Resolving Vela outgoing calls", token, [], async () =>
      reportPartialArray(outgoingCalls(index, params.item), resultProgress, token));
  });
});

connection.languages.typeHierarchy.onPrepare((params, token) => safeResult("textDocument/prepareTypeHierarchy", [], () => token.isCancellationRequested ? [] : prepareTypeHierarchy(index, params.textDocument.uri, params.position)));
connection.languages.typeHierarchy.onSupertypes((params, token, workDoneProgress, resultProgress) => {
  return safeResult("typeHierarchy/supertypes", [], () => {
    if (token.isCancellationRequested) {
      return [];
    }
    return withWorkDone(workDoneProgress, "Resolving Vela supertypes", token, [], async () =>
      reportPartialArray(supertypes(index, params.item), resultProgress, token));
  });
});
connection.languages.typeHierarchy.onSubtypes((params, token, workDoneProgress, resultProgress) => {
  return safeResult("typeHierarchy/subtypes", [], () => {
    if (token.isCancellationRequested) {
      return [];
    }
    return withWorkDone(workDoneProgress, "Resolving Vela subtypes", token, [], async () =>
      reportPartialArray(subtypes(index, params.item), resultProgress, token));
  });
});

connection.onExecuteCommand((params, token) => safeResult("workspace/executeCommand", { error: "Vela command failed" }, async () => {
  if (token.isCancellationRequested) {
    return { cancelled: true };
  }
  traceLog("command.execute", { command: params.command });
  switch (params.command) {
    case "vela.compileCurrentFile":
      return compileUri(String(params.arguments?.[0] ?? activeDocumentUri()), token);
    case "vela.compileWorkspaceEntry":
      return compileWorkspaceEntry(token);
    case "vela.showAssembly":
      return showAssembly(String(params.arguments?.[0] ?? activeDocumentUri()), token);
    case "vela.runCurrentProgram":
      return runCurrentProgram(String(params.arguments?.[0] ?? activeDocumentUri()), token);
    case "vela.restartServer":
      return { restartRequired: true };
    case "vela.dumpSymbolIndex":
      if (!index.settingsSnapshot().devCommands.dumpSymbolIndex) {
        return { error: "vela.dumpSymbolIndex is disabled by vela.devCommands.dumpSymbolIndex" };
      }
      return index.dumpSymbolIndex();
    default:
      return { error: `unknown Vela command ${params.command}` };
  }
}));

documents.listen(connection);
connection.listen();

async function refreshConfiguration(fallbackRaw: unknown = {}): Promise<void> {
  if (!initialized) {
    return;
  }
  let raw: any = objectSetting(fallbackRaw);
  if (configurationSupported) {
    try {
      raw = objectSetting(await connection.workspace.getConfiguration("vela"));
    } catch {
      raw = {};
    }
  }
  const warnings: string[] = [];
  const projectRoot = stringSetting(raw.projectRoot, "vela.projectRoot", warnings);
  const stdlibPath = stringSetting(raw.stdlibPath, "vela.stdlibPath", warnings);
  const workspaceEntry = stringSetting(raw.workspaceEntry, "vela.workspaceEntry", warnings);
  const cpuSimulatorPath = stringSetting(raw.cpuSimulatorPath, "vela.cpuSimulatorPath", warnings);
  const settings: Partial<VelaSettings> = {
    projectRoot,
    stdlibPath,
    requireMainDiagnostic: enumSetting(raw.requireMainDiagnostic, "vela.requireMainDiagnostic", ["off", "currentFile", "workspaceEntry"] as const, DEFAULT_SETTINGS.requireMainDiagnostic, warnings),
    workspaceEntry,
    diagnosticsMode: enumSetting(raw.diagnostics?.mode, "vela.diagnostics.mode", ["openFiles", "workspace"] as const, DEFAULT_SETTINGS.diagnosticsMode, warnings),
    traceServer: booleanSetting(raw.trace?.server, "vela.trace.server", DEFAULT_SETTINGS.traceServer, warnings),
    cpuSimulatorPath,
    inlayHints: {
      parameterNames: booleanSetting(raw.inlayHints?.parameterNames, "vela.inlayHints.parameterNames", DEFAULT_SETTINGS.inlayHints.parameterNames, warnings),
      inferredTypes: booleanSetting(raw.inlayHints?.inferredTypes, "vela.inlayHints.inferredTypes", DEFAULT_SETTINGS.inlayHints.inferredTypes, warnings),
      layout: booleanSetting(raw.inlayHints?.layout, "vela.inlayHints.layout", DEFAULT_SETTINGS.inlayHints.layout, warnings),
    },
    formatting: {
      enabled: booleanSetting(raw.formatting?.enabled, "vela.formatting.enabled", DEFAULT_SETTINGS.formatting.enabled, warnings),
    },
    devCommands: {
      dumpSymbolIndex: booleanSetting(raw.devCommands?.dumpSymbolIndex, "vela.devCommands.dumpSymbolIndex", DEFAULT_SETTINGS.devCommands.dumpSymbolIndex, warnings),
    },
  };
  configureIndex(settings);
  validatePathSettings(projectRoot, stdlibPath, workspaceEntry, cpuSimulatorPath, warnings);
  publishConfigurationWarnings(warnings);
  traceLog("configuration.refreshed", {
    diagnosticsMode: settings.diagnosticsMode,
    requireMainDiagnostic: settings.requireMainDiagnostic,
    workspaceFolders: workspaceFolders.length,
    warnings: warnings.length,
  });
}

function configurationFromDidChange(settings: unknown): Record<string, unknown> {
  const root = objectSetting(settings);
  const vela = root.vela;
  return objectSetting(vela && typeof vela === "object" && !Array.isArray(vela) ? vela : root);
}

function objectSetting(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function reindexDocument(document: TextDocument): void {
  index.updateOpenDocument(document.uri, document.getText(), document.version);
}

function refreshFileSnapshot(uri: string): void {
  const document = documents.get(uri);
  if (document && isFileVelaUri(document.uri)) {
    reindexDocument(document);
    return;
  }
  index.refreshDiskFile(uriToPath(uri));
}

function removeFileSnapshot(uri: string): void {
  const document = documents.get(uri);
  if (document && isFileVelaUri(document.uri)) {
    reindexDocument(document);
    return;
  }
  index.removeFile(uri);
}

function openVelaDocuments(): TextDocument[] {
  return documents.all().filter((document) => isFileVelaUri(document.uri));
}

function scheduleDiagnostics(uri: string): void {
  const existing = diagnosticTimers.get(uri);
  if (existing) {
    clearTimeout(existing);
  }
  diagnosticTimers.set(uri, setTimeout(() => publishDiagnostics(uri), 150));
}

function cancelDiagnostics(uri: string): void {
  const existing = diagnosticTimers.get(uri);
  if (!existing) {
    return;
  }
  clearTimeout(existing);
  diagnosticTimers.delete(uri);
}

function scheduleOpenDiagnostics(): void {
  for (const document of openVelaDocuments()) {
    scheduleDiagnostics(document.uri);
  }
}

function publishDiagnostics(uri: string): void {
  diagnosticTimers.delete(uri);
  connection.sendDiagnostics({ uri, diagnostics: index.lspDiagnostics(uri) });
}

function publishOpenDiagnostics(): void {
  for (const document of openVelaDocuments()) {
    publishDiagnostics(document.uri);
  }
}

function documentDiagnosticItems(uri: string): Diagnostic[] {
  const state = index.get(uri);
  if (!state) {
    return [];
  }
  if (index.settingsSnapshot().diagnosticsMode !== "workspace" && !state.open) {
    return [];
  }
  return index.lspDiagnostics(uri);
}

function refreshClientDerivedState(): void {
  requestRefresh("diagnostic", diagnosticRefreshSupported, () => connection.languages.diagnostics.refresh());
  requestRefresh("inlayHint", inlayHintRefreshSupported, () => connection.languages.inlayHint.refresh());
  requestRefresh("semanticTokens", semanticTokensRefreshSupported, () => connection.languages.semanticTokens.refresh());
  requestRefresh("foldingRange", foldingRangeRefreshSupported, () => connection.languages.foldingRange.refresh());
}

function requestRefresh(name: string, supported: boolean, refresh: () => Promise<void>): void {
  if (!supported) {
    return;
  }
  void refresh()
    .then(() => traceLog(`${name}.refreshed`))
    .catch((error) => traceLog(`${name}.refreshFailed`, { error: error instanceof Error ? error.message : String(error) }));
}

function refreshVirtualDocument(uri: string): void {
  if (!textDocumentContentSupported) {
    return;
  }
  void connection.workspace.textDocumentContent.refresh(uri)
    .then(() => traceLog("virtualDocument.refreshed", { uri }))
    .catch((error) => traceLog("virtualDocument.refreshFailed", { uri, error: error instanceof Error ? error.message : String(error) }));
}

function filterCodeActions(actions: CodeAction[], only: readonly string[] | undefined): CodeAction[] {
  if (!only || only.length === 0) {
    return actions;
  }
  return actions.filter((action) =>
    !!action.kind && only.some((requested) => action.kind === requested || action.kind?.startsWith(`${requested}.`)));
}

async function refreshWorkspaceFoldersFromClient(): Promise<void> {
  if (!workspaceFoldersSupported || workspaceFolders.length > 0) {
    return;
  }
  try {
    const folders = await connection.workspace.getWorkspaceFolders();
    const paths = [...new Set(workspaceFolderPaths(folders))];
    if (paths.length === 0) {
      repoRootFallbackEnabled = false;
      configureIndex(index.settingsSnapshot());
      index.indexWorkspace();
      traceLog("workspace.foldersRequested", { folders: 0 });
      return;
    }
    workspaceFolders = paths;
    repoRootFallbackEnabled = false;
    configureIndex(index.settingsSnapshot());
    index.indexWorkspace();
    traceLog("workspace.foldersRequested", { folders: workspaceFolders.length, files: index.allFiles().length });
  } catch (error) {
    traceLog("workspace.foldersRequestFailed", { error: error instanceof Error ? error.message : String(error) });
  }
}

function traceLog(event: string, fields: Record<string, unknown> = {}): void {
  if (!index.settingsSnapshot().traceServer) {
    return;
  }
  connection.console.log(JSON.stringify({ source: "vela-lsp", event, ...fields }));
}

function configureIndex(settings: Partial<VelaSettings>): void {
  index.configure(workspaceFolders, settings, { useRepoRootFallback: repoRootFallbackEnabled });
}

function workspaceEditSize(edit: { changes?: Record<string, unknown[]> } | null): number {
  return Object.values(edit?.changes ?? {}).reduce((total, edits) => total + edits.length, 0);
}

function documentLineRange(text: string, line: number): Range {
  const lines = text.split(/\r?\n/u);
  const clamped = Math.max(0, Math.min(line, Math.max(0, lines.length - 1)));
  return Range.create(clamped, 0, clamped, lines[clamped]?.length ?? 0);
}

function safeResult<T>(handler: string, fallback: T, run: () => T | Promise<T>): T | Promise<T> {
  try {
    const result = run();
    if (isPromiseLike(result)) {
      return result.catch((error: unknown) => {
        traceLog("handler.failed", { handler, error: errorMessage(error) });
        return fallback;
      });
    }
    return result;
  } catch (error) {
    traceLog("handler.failed", { handler, error: errorMessage(error) });
    return fallback;
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyDocumentDiagnosticReport(): DocumentDiagnosticReport {
  return {
    kind: DocumentDiagnosticReportKind.Full,
    resultId: "vela-diag-empty",
    items: [],
  };
}

async function withWorkDone<T>(
  progress: WorkDoneProgressReporter,
  title: string,
  token: CancellationToken,
  cancelled: T,
  run: () => T | Promise<T>,
): Promise<T> {
  progress.begin(title, undefined, undefined, true);
  try {
    if (!await continueAfterCancellationTurn(token)) {
      return cancelled;
    }
    const result = await run();
    return token.isCancellationRequested ? cancelled : result;
  } finally {
    progress.done();
  }
}

async function reportPartialArray<T>(items: T[], resultProgress: ResultProgressReporter<T[]> | undefined, token: CancellationToken): Promise<T[]> {
  if (!resultProgress) {
    return token.isCancellationRequested ? [] : items;
  }
  for (const chunk of chunks(items)) {
    if (token.isCancellationRequested) {
      return [];
    }
    resultProgress.report(chunk);
    if (!await continueAfterCancellationTurn(token)) {
      return [];
    }
  }
  return [];
}

async function reportPartialItems<T>(items: T[], resultProgress: ResultProgressReporter<{ items: T[] }> | undefined, token: CancellationToken): Promise<{ items: T[] }> {
  if (!resultProgress) {
    return { items: token.isCancellationRequested ? [] : items };
  }
  for (const chunk of chunks(items)) {
    if (token.isCancellationRequested) {
      return { items: [] };
    }
    resultProgress.report({ items: chunk });
    if (!await continueAfterCancellationTurn(token)) {
      return { items: [] };
    }
  }
  return { items: [] };
}

function continueAfterCancellationTurn(token: CancellationToken): Promise<boolean> {
  if (token.isCancellationRequested) {
    return Promise.resolve(false);
  }
  return new Promise((resolvePromise) => {
    setImmediate(() => resolvePromise(!token.isCancellationRequested));
  });
}

function cacheSemanticTokens(uri: string, tokens: { resultId?: string; data: number[] }): void {
  if (!tokens.resultId) {
    return;
  }
  semanticTokenCache.delete(tokens.resultId);
  semanticTokenCache.set(tokens.resultId, { uri, data: [...tokens.data] });
  pruneMap(semanticTokenCache, MAX_SEMANTIC_TOKEN_CACHE_ENTRIES);
}

function semanticTokenEdits(previous: number[], next: number[]): { start: number; deleteCount: number; data?: number[] }[] {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) {
    start++;
  }
  if (start === previous.length && start === next.length) {
    return [];
  }
  let previousEnd = previous.length - 1;
  let nextEnd = next.length - 1;
  while (previousEnd >= start && nextEnd >= start && previous[previousEnd] === next[nextEnd]) {
    previousEnd--;
    nextEnd--;
  }
  const deleteCount = previousEnd - start + 1;
  const data = next.slice(start, nextEnd + 1);
  return data.length > 0 ? [{ start, deleteCount, data }] : [{ start, deleteCount }];
}

function chunks<T>(items: T[], size = 64): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function workspaceDiagnosticStates() {
  const states = index.allFiles();
  return index.settingsSnapshot().diagnosticsMode === "workspace" ? states : states.filter((state) => state.open);
}

function workspaceDiagnosticReports(previousResultIds = new Map<string, string>()): WorkspaceDocumentDiagnosticReport[] {
  return workspaceDiagnosticStates().map((state) => ({
    uri: state.uri,
    version: state.version ?? null,
    ...documentDiagnosticReport(state.uri, previousResultIds.get(state.uri)),
  }));
}

function documentDiagnosticReport(uri: string, previousResultId?: string): DocumentDiagnosticReport {
  const items = documentDiagnosticItems(uri);
  const state = index.get(uri);
  const signature = diagnosticSignature(uri, state?.version ?? null, index.settingsSnapshot().diagnosticsMode, items);
  const current = cachedDiagnosticResultId(uri, signature);
  if (previousResultId && previousResultId === current.resultId) {
    return {
      kind: DocumentDiagnosticReportKind.Unchanged,
      resultId: current.resultId,
    };
  }
  return {
    kind: DocumentDiagnosticReportKind.Full,
    resultId: current.resultId,
    items,
  };
}

function cachedDiagnosticResultId(uri: string, signature: string): { resultId: string } {
  const existing = diagnosticResultCache.get(uri);
  if (existing?.signature === signature) {
    diagnosticResultCache.delete(uri);
    diagnosticResultCache.set(uri, existing);
    return { resultId: existing.resultId };
  }
  const resultId = `vela-diag-${createHash("sha1").update(signature).digest("hex")}`;
  diagnosticResultCache.delete(uri);
  diagnosticResultCache.set(uri, { signature, resultId });
  pruneMap(diagnosticResultCache, MAX_DIAGNOSTIC_RESULT_CACHE_ENTRIES);
  return { resultId };
}

function diagnosticSignature(uri: string, version: number | null, mode: string, items: Diagnostic[]): string {
  return JSON.stringify({
    uri,
    version,
    mode,
    items: items.map((item) => ({
      code: item.code,
      severity: item.severity,
      message: item.message,
      range: item.range,
      source: item.source,
      relatedInformation: item.relatedInformation,
    })),
  });
}

function activeDocumentUri(): string {
  return openVelaDocuments()[0]?.uri ?? "";
}

async function compileWorkspaceEntry(token?: CancellationToken): Promise<unknown> {
  const entry = index.settingsSnapshot().workspaceEntry;
  if (!entry) {
    return { error: "vela.workspaceEntry is not configured" };
  }
  const root = index.projectRoot();
  const path = resolve(root, entry);
  if (!path.toLowerCase().endsWith(".vl")) {
    return { ok: false, error: `vela.workspaceEntry must point to a .vl file: ${entry}` };
  }
  if (!isPathInside(root, path)) {
    return { ok: false, error: `vela.workspaceEntry must stay under project root: ${entry}` };
  }
  const uri = pathToFileURL(path).toString();
  return compilePath(path, documents.get(uri)?.getText(), token);
}

async function compileUri(uri: string, token?: CancellationToken): Promise<unknown> {
  if (!uri) {
    return { error: "no current Vela document" };
  }
  if (!isFileVelaUri(uri)) {
    return { ok: false, error: `Vela compile commands require a file:// .vl document URI, got ${uri}` };
  }
  return compilePath(uriToPath(uri), documents.get(uri)?.getText(), token);
}

async function showAssembly(uri: string, token?: CancellationToken): Promise<unknown> {
  const compiled = await compileUri(uri, token) as { ok?: boolean; output?: string; error?: string; cancelled?: boolean };
  if (compiled.cancelled || token?.isCancellationRequested) {
    return { cancelled: true };
  }
  if (!compiled.ok || !compiled.output || !existsSync(compiled.output)) {
    return compiled;
  }
  const content = readFileSync(compiled.output, "utf8");
  const virtualUri = assemblyVirtualUri(compiled.output);
  cacheVirtualDocument(virtualUri, { text: content, language: "vela-asm", sourcePath: compiled.output });
  traceLog("virtualDocument.created", { uri: virtualUri, bytes: content.length });
  refreshVirtualDocument(virtualUri);
  const open = await showVirtualDocument(virtualUri);
  return {
    uri: virtualUri,
    language: "vela-asm",
    content,
    opened: open?.success,
  };
}

async function runCurrentProgram(uri: string, token?: CancellationToken): Promise<unknown> {
  const simulator = resolveCpuSimulator();
  if ("error" in simulator) {
    return { ok: false, error: simulator.error };
  }
  const compiled = await compileUri(uri, token) as { ok?: boolean; output?: string; error?: string; cancelled?: boolean };
  if (compiled.cancelled || token?.isCancellationRequested) {
    return { cancelled: true };
  }
  if (!compiled.ok || !compiled.output) {
    return compiled;
  }
  const result = await runCpuSimulator(simulator.scriptPath, compiled.output, simulator.cwd, 60_000, token);
  if (result.cancelled || token?.isCancellationRequested) {
    return { cancelled: true };
  }
  return { ...result, assembly: compiled.output };
}

function cacheVirtualDocument(uri: string, document: { text: string; language: string; sourcePath: string }): void {
  virtualDocuments.delete(uri);
  virtualDocuments.set(uri, document);
  pruneMap(virtualDocuments, MAX_VIRTUAL_DOCUMENT_CACHE_ENTRIES);
}

function pruneMap<K, V>(map: Map<K, V>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}

function resolveCpuSimulator(): { scriptPath: string; cwd: string } | { error: string } {
  const configured = index.settingsSnapshot().cpuSimulatorPath;
  if (!configured) {
    return { error: "vela.cpuSimulatorPath must be configured before running the CPU simulator" };
  }
  const configuredPath = resolve(index.projectRoot(), configured);
  if (!existsSync(configuredPath)) {
    return { error: `vela.cpuSimulatorPath does not exist: ${configured}` };
  }
  const stats = statForPath(configuredPath);
  if (!stats) {
    return { error: `could not inspect vela.cpuSimulatorPath: ${configured}` };
  }
  const scriptPath = stats.isDirectory() ? resolve(configuredPath, "run.py") : configuredPath;
  if (!existsSync(scriptPath)) {
    return { error: `CPU simulator entrypoint not found at ${scriptPath}; set vela.cpuSimulatorPath to the CPU repository directory or run.py` };
  }
  if (!scriptPath.toLowerCase().endsWith(".py")) {
    return { error: `vela.cpuSimulatorPath must point to the CPU repository directory or a Python run.py entrypoint: ${configured}` };
  }
  return { scriptPath, cwd: stats.isDirectory() ? configuredPath : dirname(scriptPath) };
}

async function showVirtualDocument(uri: string): Promise<{ success: boolean } | undefined> {
  if (!showDocumentSupported) {
    return undefined;
  }
  try {
    const result = await connection.window.showDocument({ uri, external: false, takeFocus: true });
    traceLog("virtualDocument.opened", { uri, success: result.success });
    return result;
  } catch (error) {
    traceLog("virtualDocument.openFailed", { uri, error: error instanceof Error ? error.message : String(error) });
    return { success: false };
  }
}

function virtualDocumentContent(uri: unknown): { text: string } | null {
  if (typeof uri !== "string") {
    return null;
  }
  const cached = virtualDocuments.get(uri);
  if (cached) {
    return { text: cached.text };
  }
  if (uri === BUILTIN_VIRTUAL_URI) {
    return { text: builtinVirtualText() };
  }
  const stdlibPath = index.stdlibPathFromVirtualUri(uri);
  if (stdlibPath && existsSync(stdlibPath)) {
    return { text: readFileSync(stdlibPath, "utf8") };
  }
  return null;
}

function assemblyVirtualUri(path: string): string {
  return `vela-asm:${path.replaceAll("\\", "/")}`;
}

async function compilePath(path: string, sourceText?: string, token?: CancellationToken): Promise<unknown> {
  if (!path || (sourceText === undefined && !existsSync(path))) {
    return { ok: false, error: `Vela source file not found: ${path}` };
  }
  if (token?.isCancellationRequested) {
    return { cancelled: true };
  }
  const output = path.replace(/\.vl$/i, ".de1");
  const progress = await createProgress("Compiling Vela");
  progress?.report(10, path);
  try {
    const result = await runCompiler(path, output, index.projectRoot(), compilerRoot, sourceText, token);
    progress?.report(100, "done");
    if (result.cancelled || token?.isCancellationRequested) {
      return { cancelled: true };
    }
    return result;
  } finally {
    progress?.done();
  }
}

async function createProgress(title: string): Promise<WorkDoneProgressReporter | undefined> {
  try {
    const progress = await connection.window.createWorkDoneProgress();
    progress.begin(title, 0, "starting", true);
    return progress;
  } catch {
    return undefined;
  }
}

function rangeContains(range: Range, position: { line: number; character: number }): boolean {
  if (position.line < range.start.line || position.line > range.end.line) {
    return false;
  }
  if (position.line === range.start.line && position.character < range.start.character) {
    return false;
  }
  return !(position.line === range.end.line && position.character >= range.end.character);
}

function stringSetting(value: unknown, key: string, warnings: string[]): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    warnings.push(`${key} must be a string; ignoring configured value.`);
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    warnings.push(`${key} must not be empty; ignoring configured value.`);
    return undefined;
  }
  return trimmed;
}

function enumSetting<T extends string>(value: unknown, key: string, allowed: readonly T[], fallback: T, warnings: string[]): T {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "string" && allowed.includes(value as T)) {
    return value as T;
  }
  warnings.push(`${key} must be one of: ${allowed.join(", ")}; using ${fallback}.`);
  return fallback;
}

function booleanSetting(value: unknown, key: string, fallback: boolean, warnings: string[]): boolean {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  warnings.push(`${key} must be true or false; using ${fallback}.`);
  return fallback;
}

function validatePathSettings(projectRoot: string | undefined, stdlibPath: string | undefined, workspaceEntry: string | undefined, cpuSimulatorPath: string | undefined, warnings: string[]): void {
  if (projectRoot && !existsSync(index.projectRoot())) {
    warnings.push(`vela.projectRoot does not exist: ${projectRoot}`);
  }
  if (stdlibPath) {
    if (!existsSync(index.stdlibDirectory())) {
      warnings.push(`vela.stdlibPath does not point to an existing stdlib directory or parent: ${stdlibPath}`);
    }
  }
  if (workspaceEntry && !workspaceEntry.toLowerCase().endsWith(".vl")) {
    warnings.push(`vela.workspaceEntry must point to a .vl file: ${workspaceEntry}`);
  } else if (workspaceEntry && !isPathInside(index.projectRoot(), resolve(index.projectRoot(), workspaceEntry))) {
    warnings.push(`vela.workspaceEntry must stay under project root: ${workspaceEntry}`);
  } else if (workspaceEntry && !existsSync(resolve(index.projectRoot(), workspaceEntry))) {
    warnings.push(`vela.workspaceEntry was not found under project root: ${workspaceEntry}`);
  }
  if (cpuSimulatorPath) {
    const resolved = resolve(index.projectRoot(), cpuSimulatorPath);
    if (!existsSync(resolved)) {
      warnings.push(`vela.cpuSimulatorPath does not exist: ${cpuSimulatorPath}`);
    } else {
      const stats = statForPath(resolved);
      if (!stats) {
        warnings.push(`could not inspect vela.cpuSimulatorPath: ${cpuSimulatorPath}`);
        return;
      }
      const scriptPath = stats.isDirectory() ? resolve(resolved, "run.py") : resolved;
      if (!existsSync(scriptPath)) {
        warnings.push(`vela.cpuSimulatorPath must point to the CPU repository directory containing run.py or to run.py: ${cpuSimulatorPath}`);
      } else if (!scriptPath.toLowerCase().endsWith(".py")) {
        warnings.push(`vela.cpuSimulatorPath must point to a Python run.py entrypoint: ${cpuSimulatorPath}`);
      }
    }
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function publishConfigurationWarnings(warnings: string[]): void {
  const unique = [...new Set(warnings)];
  const signature = unique.join("\n");
  if (signature === configurationWarningSignature) {
    return;
  }
  configurationWarningSignature = signature;
  for (const warning of unique) {
    void connection.window.showWarningMessage(warning);
  }
}
