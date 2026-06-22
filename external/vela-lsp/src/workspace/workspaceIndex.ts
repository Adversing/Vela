import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative as pathRelative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Position } from "vscode-languageserver/node";
import { Lexer } from "../vela/lexer.js";
import {
  AnalysisResult,
  ImportDeclNode,
  ModuleDeclNode,
  ParseResult,
  TokenKind,
  VelaDiagnostic,
  VelaReference,
  VelaSymbol,
  containsOffset,
  lspPositionToOffset,
  toLspDiagnostic,
} from "../vela/model.js";
import { parseVela } from "../vela/parser.js";
import { SemanticEnvironment, analyzeVela } from "../vela/semantic.js";

export interface VelaSettings {
  projectRoot?: string;
  stdlibPath?: string;
  requireMainDiagnostic: "off" | "currentFile" | "workspaceEntry";
  workspaceEntry?: string;
  diagnosticsMode: "openFiles" | "workspace";
  traceServer: boolean;
  inlayHints: {
    parameterNames: boolean;
    inferredTypes: boolean;
    layout: boolean;
  };
  formatting: {
    enabled: boolean;
  };
  devCommands: {
    dumpSymbolIndex: boolean;
  };
  cpuSimulatorPath?: string;
}

export const DEFAULT_SETTINGS: VelaSettings = {
  requireMainDiagnostic: "off",
  diagnosticsMode: "openFiles",
  traceServer: false,
  inlayHints: {
    parameterNames: true,
    inferredTypes: false,
    layout: false,
  },
  formatting: {
    enabled: true,
  },
  devCommands: {
    dumpSymbolIndex: false,
  },
};

export interface FileState {
  uri: string;
  path: string;
  text: string;
  version?: number;
  open: boolean;
  defaultLibrary: boolean;
  parse: ParseResult;
  analysis: AnalysisResult;
}

interface ImportDependencySet {
  paths: Set<string>;
  directories: Set<string>;
}

export interface WorkspaceIndexConfigureOptions {
  useRepoRootFallback?: boolean;
}

export class WorkspaceIndex {
  private readonly files = new Map<string, FileState>();
  private readonly pathToUri = new Map<string, string>();
  private readonly moduleToUri = new Map<ModuleDeclNode, string>();
  private readonly importedPathToUris = new Map<string, Set<string>>();
  private readonly wildcardImportDirToUris = new Map<string, Set<string>>();
  private readonly importDependenciesByUri = new Map<string, ImportDependencySet>();
  private readonly symbolsById = new Map<string, VelaSymbol>();
  private readonly symbolIdsByUri = new Map<string, Set<string>>();
  private readonly referencesBySymbolId = new Map<string, VelaReference[]>();
  private readonly referenceSymbolIdsByUri = new Map<string, Set<string>>();
  private workspaceFolders: string[] = [];
  private settings: VelaSettings = DEFAULT_SETTINGS;
  private stdlibDocs = "";
  private repoRoot: string;
  private projectRootPath: string;
  private useRepoRootFallback = true;

  constructor(private readonly serverRoot: string) {
    this.repoRoot = resolve(serverRoot, "..", "..");
    this.projectRootPath = this.repoRoot;
    this.loadStdlibDocs();
  }

  configure(workspaceFolders: string[], settings: Partial<VelaSettings>, options: WorkspaceIndexConfigureOptions = {}): void {
    this.workspaceFolders = workspaceFolders.map((folder) => normalize(folder));
    this.useRepoRootFallback = options.useRepoRootFallback ?? true;
    this.settings = mergeSettings(DEFAULT_SETTINGS, settings);
    this.repoRoot = this.findRepoRoot();
    this.projectRootPath = this.settings.projectRoot
      ? this.resolveSettingPath(this.settings.projectRoot)
      : (this.workspaceFolders[0] ?? this.repoRoot);
    this.loadStdlibDocs();
    this.rebuildImportDependencyMappings();
  }

  indexWorkspace(): void {
    const paths = new Set<string>();
    for (const root of this.workspaceRoots()) {
      if (existsSync(root)) {
        for (const file of collectVelaFiles(root)) {
          paths.add(file);
        }
      }
    }
    const stdlibRoot = this.stdlibDirectory();
    if (existsSync(stdlibRoot)) {
      for (const file of collectVelaFiles(stdlibRoot)) {
        paths.add(file);
      }
    }
    this.pruneClosedFilesOutside(paths);
    for (const file of paths) {
      const uri = pathToFileURL(file).toString();
      if (!this.files.has(uri)) {
        this.parseDiskFile(file, false);
      }
    }
    for (const uri of [...this.files.keys()]) {
      this.analyzeFile(uri);
    }
  }

  updateOpenDocument(uri: string, text: string, version?: number): FileState {
    const path = uriToPath(uri);
    const state = this.parseText(uri, path, text, true, version);
    this.files.set(uri, state);
    this.pathToUri.set(normalize(path), uri);
    this.analyzeAffectedFiles([uri]);
    return this.files.get(uri)!;
  }

  closeDocument(uri: string): void {
    const state = this.files.get(uri);
    if (state) {
      state.open = false;
      if (existsSync(state.path)) {
        this.refreshDiskFile(state.path);
      } else {
        this.removeFile(uri);
      }
    }
  }

  removeFile(uri: string, reanalyze = true): void {
    const state = this.files.get(uri);
    const dependents = state && reanalyze ? this.importerUrisFor(state) : [];
    if (state) {
      this.pathToUri.delete(normalize(state.path));
    }
    this.removeModuleMappings(uri);
    this.removeImportDependencyMappings(uri);
    this.removeAnalysisMappings(uri);
    this.files.delete(uri);
    if (reanalyze) {
      this.analyzeAffectedFiles(dependents);
    }
  }

  get(uri: string): FileState | undefined {
    return this.files.get(uri);
  }

  ensureFileByPath(path: string): FileState | undefined {
    const normalized = normalize(path);
    const existingUri = this.pathToUri.get(normalized);
    if (existingUri) {
      return this.files.get(existingUri);
    }
    if (!existsSync(normalized)) {
      return undefined;
    }
    return this.parseDiskFile(normalized, false);
  }

  refreshDiskFile(path: string): FileState | undefined {
    const normalized = normalize(path);
    const existingUri = this.pathToUri.get(normalized);
    const existing = existingUri ? this.files.get(existingUri) : undefined;
    if (existing?.open) {
      return existing;
    }
    if (!existsSync(normalized)) {
      if (existingUri) {
        this.removeFile(existingUri);
      }
      return undefined;
    }
    const refreshed = this.parseDiskFile(normalized, false);
    this.analyzeAffectedFiles([refreshed.uri]);
    return this.files.get(refreshed.uri);
  }

  allFiles(): FileState[] {
    return [...this.files.values()];
  }

  diagnostics(uri: string): VelaDiagnostic[] {
    return this.files.get(uri)?.analysis.diagnostics ?? this.files.get(uri)?.parse.diagnostics ?? [];
  }

  lspDiagnostics(uri: string) {
    return this.diagnostics(uri).map(toLspDiagnostic);
  }

  allSymbols(): VelaSymbol[] {
    return [...this.symbolsById.values()];
  }

  visibleSymbols(uri: string): VelaSymbol[] {
    const state = this.files.get(uri);
    if (!state) {
      return this.allSymbols().filter((symbol) => symbol.defaultLibrary);
    }
    const local = state.analysis.symbols;
    const defaults = this.allSymbols().filter((symbol) => symbol.defaultLibrary && !local.some((item) => item.id === symbol.id));
    return [...state.analysis.visibleSymbols, ...local, ...defaults];
  }

  findSymbolAt(uri: string, position: Position, options: { includeEnclosing?: boolean } = {}): VelaSymbol | undefined {
    const state = this.files.get(uri);
    if (!state) {
      return undefined;
    }
    const offset = lspPositionToOffset(state.text, position);
    const ref = state.analysis.references.find((item) => containsOffset(item.range, offset));
    if (ref) {
      return this.symbolById(ref.symbolId);
    }
    const symbolAtSelection = state.analysis.symbols
      .filter((symbol) => containsOffset(symbol.selectionRange, offset))
      .sort((left, right) => (left.selectionRange.end.offset - left.selectionRange.start.offset) - (right.selectionRange.end.offset - right.selectionRange.start.offset))[0];
    if (symbolAtSelection) {
      return symbolAtSelection;
    }
    if (!options.includeEnclosing) {
      return undefined;
    }
    return state.analysis.symbols
      .filter((symbol) => containsOffset(symbol.range, offset))
      .sort((left, right) => (left.range.end.offset - left.range.start.offset) - (right.range.end.offset - right.range.start.offset))[0];
  }

  referencesFor(symbolId: string, includeDeclaration = true): VelaReference[] {
    const refs: VelaReference[] = [];
    const symbol = this.symbolById(symbolId);
    if (includeDeclaration && symbol) {
      refs.push({ symbolId, name: symbol.name, uri: symbol.uri, range: symbol.selectionRange });
    }
    refs.push(...(this.referencesBySymbolId.get(symbolId) ?? []));
    return refs;
  }

  symbolById(symbolId: string): VelaSymbol | undefined {
    return this.symbolsById.get(symbolId);
  }

  tokenAt(uri: string, position: Position) {
    const state = this.files.get(uri);
    if (!state) {
      return undefined;
    }
    const offset = lspPositionToOffset(state.text, position);
    return state.parse.allTokens.find((token) => token.range.start.offset <= offset && offset <= token.range.end.offset && token.kind !== TokenKind.Eof);
  }

  moduleForImport(imp: ImportDeclNode, moduleName: string): FileState | undefined {
    for (const path of this.importCandidatePaths(imp.package, moduleName)) {
      const state = this.ensureFileByPath(path);
      if (state) {
        return state;
      }
    }
    return undefined;
  }

  filesForImport(imp: ImportDeclNode): FileState[] {
    const files: FileState[] = [];
    const seen = new Set<string>();
    for (const module of this.resolveImport(imp)) {
      const uri = this.moduleToUri.get(module);
      const state = uri ? this.files.get(uri) : undefined;
      if (state && !seen.has(state.uri)) {
        seen.add(state.uri);
        files.push(state);
      }
    }
    return files;
  }

  importPackageSegments(packagePrefix: string[], kind: "any" | "directory" | "module" = "any"): string[] {
    const result = new Set<string>();
    for (const root of this.importRoots(packagePrefix)) {
      let base = root;
      for (const segment of packagePrefix) {
        base = join(base, segment);
      }
      if (!existsSync(base) || !statSync(base).isDirectory()) {
        continue;
      }
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && kind !== "module") {
          result.add(entry.name);
        } else if (entry.isFile() && entry.name.endsWith(".vl") && kind !== "directory") {
          result.add(entry.name.slice(0, -3));
        }
      }
    }
    return [...result].sort();
  }

  stdlibImportForSymbol(name: string): ImportDeclNode | undefined {
    for (const state of this.files.values()) {
      if (!state.defaultLibrary) {
        continue;
      }
      const symbol = state.analysis.symbols.find((candidate) => candidate.name === name && ["function", "class", "type", "alias", "global"].includes(candidate.kind));
      if (!symbol) {
        continue;
      }
      const rel = relativePath(this.repoRoot, state.path).replaceAll("\\", "/");
      const parts = rel.replace(/\.vl$/, "").split("/");
      if (parts[0] !== "stdlib") {
        continue;
      }
      const moduleName = parts.at(-1)!;
      const packageSegments = parts.slice(0, -1);
      const range = symbol.selectionRange;
      return {
        kind: "ImportDecl",
        package: packageSegments,
        packageRanges: [],
        modules: [moduleName],
        moduleRanges: [],
        wildcard: false,
        range,
      };
    }
    return undefined;
  }

  workspaceImportsForSymbol(name: string, requesterUri?: string): ImportDeclNode[] {
    const imports: ImportDeclNode[] = [];
    const seen = new Set<string>();
    for (const state of this.files.values()) {
      if (state.defaultLibrary || state.uri === requesterUri) {
        continue;
      }
      const importedModuleName = state.parse.program.modules[0]?.name;
      const symbol = state.analysis.symbols.find((candidate) =>
        candidate.name === name
        && candidate.moduleName === importedModuleName
        && ["function", "class", "type", "alias", "global"].includes(candidate.kind));
      if (!symbol) {
        continue;
      }
      const importPath = this.importPathForUri(state.uri);
      if (!importPath) {
        continue;
      }
      const key = `${importPath.package.join("::")}::${importPath.moduleName}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      imports.push({
        kind: "ImportDecl",
        package: importPath.package,
        packageRanges: [],
        modules: [importPath.moduleName],
        moduleRanges: [],
        wildcard: false,
        range: symbol.selectionRange,
      });
    }
    return imports.sort((left, right) =>
      left.package.join("::").localeCompare(right.package.join("::"))
      || left.modules.join(",").localeCompare(right.modules.join(",")));
  }

  projectRoot(): string {
    return this.projectRootPath;
  }

  stdlibDirectory(): string {
    if (this.settings.stdlibPath) {
      const configured = this.resolveSettingPath(this.settings.stdlibPath, this.projectRootPath);
      if (configured.endsWith(`${sep}stdlib`) || configured.endsWith("/stdlib")) {
        return configured;
      }
      return join(configured, "stdlib");
    }
    return join(this.repoRoot, "stdlib");
  }

  importPathForUri(uri: string): { package: string[]; moduleName: string } | undefined {
    const path = uriToPath(uri);
    if (!path.toLowerCase().endsWith(".vl")) {
      return undefined;
    }
    for (const root of this.importBaseRoots()) {
      const rel = relativePath(root, path);
      if (isAbsolute(rel) || rel.startsWith("..")) {
        continue;
      }
      const parts = rel.replaceAll("\\", "/").replace(/\.vl$/i, "").split("/").filter(Boolean);
      const moduleName = parts.at(-1);
      if (moduleName) {
        return { package: parts.slice(0, -1), moduleName };
      }
    }
    return undefined;
  }

  stdlibVirtualUriForUri(uri: string): string | undefined {
    const state = this.files.get(uri);
    if (!state?.defaultLibrary) {
      return undefined;
    }
    const stdlib = normalize(this.stdlibDirectory());
    const rel = pathRelative(stdlib, normalize(state.path));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      return undefined;
    }
    return `vela-stdlib:/${rel.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/")}`;
  }

  stdlibPathFromVirtualUri(uri: string): string | undefined {
    const prefix = "vela-stdlib:/";
    if (!uri.startsWith(prefix)) {
      return undefined;
    }
    let segments: string[];
    try {
      segments = uri.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return undefined;
    }
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\") || segment.includes("/"))) {
      return undefined;
    }
    const stdlib = normalize(this.stdlibDirectory());
    const path = normalize(join(stdlib, ...segments));
    if (!path.toLowerCase().endsWith(".vl") || (path !== stdlib && !path.startsWith(`${stdlib}${sep}`))) {
      return undefined;
    }
    return path;
  }

  settingsSnapshot(): VelaSettings {
    return this.settings;
  }

  dumpSymbolIndex(): unknown {
    return this.allSymbols().map((symbol) => ({
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      uri: symbol.uri,
      moduleName: symbol.moduleName,
      className: symbol.className,
      defaultLibrary: symbol.defaultLibrary,
    }));
  }

  private parseDiskFile(path: string, open: boolean): FileState {
    const text = readFileSync(path, "utf8");
    const uri = pathToFileURL(path).toString();
    const state = this.parseText(uri, path, text, open);
    this.files.set(uri, state);
    this.pathToUri.set(normalize(path), uri);
    return state;
  }

  private parseText(uri: string, path: string, text: string, open: boolean, version?: number): FileState {
    this.removeModuleMappings(uri);
    this.removeImportDependencyMappings(uri);
    const lexer = new Lexer(text, uri);
    const lexed = lexer.tokenize();
    const parsed = parseVela(text, uri, lexed.tokens, lexed.diagnostics);
    const parse: ParseResult = { ...parsed, allTokens: lexed.allTokens };
    for (const module of parse.program.modules) {
      this.moduleToUri.set(module, uri);
    }
    const state: FileState = {
      uri,
      path,
      text,
      version,
      open,
      defaultLibrary: this.isDefaultLibraryPath(path),
      parse,
      analysis: {
        uri,
        diagnostics: parse.diagnostics,
        symbols: [],
        references: [],
        expressionTypes: [],
        visibleSymbols: [],
        callEdges: [],
      },
    };
    this.registerImportDependencyMappings(state);
    return state;
  }

  private pruneClosedFilesOutside(indexedPaths: Set<string>): void {
    const normalizedIndexed = new Set([...indexedPaths].map((path) => normalize(path)));
    for (const [uri, state] of [...this.files]) {
      if (!state.open && !normalizedIndexed.has(normalize(state.path))) {
        this.removeFile(uri, false);
      }
    }
  }

  private removeModuleMappings(uri: string): void {
    for (const [module, moduleUri] of [...this.moduleToUri]) {
      if (moduleUri === uri) {
        this.moduleToUri.delete(module);
      }
    }
  }

  private rebuildImportDependencyMappings(): void {
    this.importedPathToUris.clear();
    this.wildcardImportDirToUris.clear();
    this.importDependenciesByUri.clear();
    for (const state of this.files.values()) {
      this.registerImportDependencyMappings(state);
    }
  }

  private registerImportDependencyMappings(state: FileState): void {
    const dependencies = this.importDependenciesFor(state);
    this.importDependenciesByUri.set(state.uri, dependencies);
    for (const path of dependencies.paths) {
      addToSetMap(this.importedPathToUris, path, state.uri);
    }
    for (const directory of dependencies.directories) {
      addToSetMap(this.wildcardImportDirToUris, directory, state.uri);
    }
  }

  private removeImportDependencyMappings(uri: string): void {
    const dependencies = this.importDependenciesByUri.get(uri);
    if (!dependencies) {
      return;
    }
    for (const path of dependencies.paths) {
      removeFromSetMap(this.importedPathToUris, path, uri);
    }
    for (const directory of dependencies.directories) {
      removeFromSetMap(this.wildcardImportDirToUris, directory, uri);
    }
    this.importDependenciesByUri.delete(uri);
  }

  private importDependenciesFor(state: FileState): ImportDependencySet {
    const dependencies: ImportDependencySet = { paths: new Set<string>(), directories: new Set<string>() };
    for (const module of state.parse.program.modules) {
      for (const imp of module.imports) {
        if (imp.wildcard || imp.modules.includes("*")) {
          for (const directory of this.importPackageDirectories(imp.package)) {
            dependencies.directories.add(normalize(directory));
          }
        } else {
          for (const moduleName of imp.modules) {
            for (const path of this.importCandidatePaths(imp.package, moduleName)) {
              dependencies.paths.add(normalize(path));
            }
          }
        }
      }
      if (this.moduleNeedsImplicitStoreable(module)) {
        for (const path of this.importCandidatePaths(["stdlib", "core"], "storeable")) {
          dependencies.paths.add(normalize(path));
        }
      }
    }
    return dependencies;
  }

  private analyzeFile(uri: string): void {
    const state = this.files.get(uri);
    if (!state) {
      return;
    }
    this.removeAnalysisMappings(uri);
    const env: SemanticEnvironment = {
      resolveImport: (imp) => this.resolveImport(imp),
      moduleUri: (module) => this.moduleToUri.get(module),
      isDefaultLibraryUri: (candidateUri) => {
        const path = uriToPath(candidateUri);
        return this.isDefaultLibraryPath(path);
      },
      documentationFor: (symbol) => this.documentationFor(symbol),
      requireMainDiagnostic: this.requireMainDiagnosticFor(state),
    };
    state.analysis = analyzeVela(state.parse, env);
    this.registerAnalysisMappings(state);
  }

  private registerAnalysisMappings(state: FileState): void {
    const symbolIds = new Set<string>();
    for (const symbol of state.analysis.symbols) {
      this.symbolsById.set(symbol.id, symbol);
      symbolIds.add(symbol.id);
    }
    this.symbolIdsByUri.set(state.uri, symbolIds);

    const referenceSymbolIds = new Set<string>();
    for (const ref of state.analysis.references) {
      const refs = this.referencesBySymbolId.get(ref.symbolId) ?? [];
      refs.push(ref);
      this.referencesBySymbolId.set(ref.symbolId, refs);
      referenceSymbolIds.add(ref.symbolId);
    }
    this.referenceSymbolIdsByUri.set(state.uri, referenceSymbolIds);
  }

  private removeAnalysisMappings(uri: string): void {
    for (const symbolId of this.symbolIdsByUri.get(uri) ?? []) {
      this.symbolsById.delete(symbolId);
    }
    this.symbolIdsByUri.delete(uri);

    for (const symbolId of this.referenceSymbolIdsByUri.get(uri) ?? []) {
      const refs = (this.referencesBySymbolId.get(symbolId) ?? []).filter((ref) => ref.uri !== uri);
      if (refs.length > 0) {
        this.referencesBySymbolId.set(symbolId, refs);
      } else {
        this.referencesBySymbolId.delete(symbolId);
      }
    }
    this.referenceSymbolIdsByUri.delete(uri);
  }

  private analyzeAllFiles(): void {
    for (const uri of [...this.files.keys()]) {
      this.analyzeFile(uri);
    }
  }

  private analyzeAffectedFiles(changedUris: Iterable<string>): void {
    const queue = [...new Set(changedUris)].filter((uri) => this.files.has(uri));
    const seen = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
      const uri = queue[index]!;
      if (seen.has(uri) || !this.files.has(uri)) {
        continue;
      }
      seen.add(uri);
      this.analyzeFile(uri);
      const state = this.files.get(uri);
      if (!state) {
        continue;
      }
      for (const importerUri of this.importerUrisFor(state)) {
        if (!seen.has(importerUri)) {
          queue.push(importerUri);
        }
      }
    }
  }

  private importerUrisFor(target: FileState): string[] {
    const targetPath = normalize(target.path);
    const targetDir = normalize(dirname(targetPath));
    const result = new Set<string>();
    for (const uri of this.importedPathToUris.get(targetPath) ?? []) {
      if (uri !== target.uri && this.files.has(uri)) {
        result.add(uri);
      }
    }
    for (const uri of this.wildcardImportDirToUris.get(targetDir) ?? []) {
      if (uri !== target.uri && this.files.has(uri)) {
        result.add(uri);
      }
    }
    return [...result];
  }

  private moduleNeedsImplicitStoreable(module: ModuleDeclNode): boolean {
    return module.body.some((node) => node.kind === "ClassDecl" && !node.parent && node.name !== "Storeable")
      && !module.body.some((node) => node.kind === "ClassDecl" && node.name === "Storeable");
  }

  private requireMainDiagnosticFor(state: FileState): VelaSettings["requireMainDiagnostic"] {
    if (this.settings.requireMainDiagnostic === "off") {
      return "off";
    }
    if (this.settings.requireMainDiagnostic === "currentFile") {
      return state.open ? "currentFile" : "off";
    }
    if (!this.settings.workspaceEntry) {
      return "off";
    }
    return normalize(state.path) === normalize(resolve(this.projectRoot(), this.settings.workspaceEntry)) ? "workspaceEntry" : "off";
  }

  private resolveImport(imp: ImportDeclNode): ModuleDeclNode[] {
    if (imp.wildcard || imp.modules.includes("*")) {
      const result: ModuleDeclNode[] = [];
      for (const root of this.importRoots(imp.package)) {
        let dir = root;
        for (const segment of imp.package) {
          dir = join(dir, segment);
        }
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          continue;
        }
        for (const file of collectVelaFiles(dir, false)) {
          const state = this.ensureFileByPath(file);
          const module = state?.parse.program.modules[0];
          if (module) {
            result.push(module);
          }
        }
      }
      return result;
    }
    const result: ModuleDeclNode[] = [];
    for (const moduleName of imp.modules) {
      const state = this.moduleForImport(imp, moduleName);
      const module = state?.parse.program.modules[0];
      if (module) {
        result.push(module);
      }
    }
    return result;
  }

  private importCandidatePaths(packageSegments: string[], moduleName: string): string[] {
    return this.importPackageDirectories(packageSegments).map((path) => join(path, `${moduleName}.vl`));
  }

  private importPackageDirectories(packageSegments: string[]): string[] {
    return this.importRoots(packageSegments).map((root) => {
      let path = root;
      for (const segment of packageSegments) {
        path = join(path, segment);
      }
      return normalize(path);
    });
  }

  private importRoots(packageSegments: string[]): string[] {
    const roots = new Set<string>(this.workspaceRoots());
    if (packageSegments.length === 0 || packageSegments[0] === "stdlib") {
      roots.add(dirname(this.stdlibDirectory()));
    }
    return [...roots];
  }

  private importBaseRoots(): string[] {
    return [...new Set([...this.workspaceRoots(), dirname(this.stdlibDirectory())])].sort((a, b) => b.length - a.length);
  }

  private workspaceRoots(): string[] {
    if (this.settings.projectRoot) {
      return [this.projectRootPath];
    }
    if (this.workspaceFolders.length > 0) {
      return this.workspaceFolders;
    }
    return this.useRepoRootFallback ? [this.repoRoot] : [];
  }

  private resolveSettingPath(path: string, base = this.workspaceFolders[0] ?? this.repoRoot): string {
    return normalize(isAbsolute(path) ? path : resolve(base, path));
  }

  private findRepoRoot(): string {
    for (const folder of this.workspaceFolders) {
      if (existsSync(join(folder, "src", "lexer", "lexer.py")) && existsSync(join(folder, "stdlib"))) {
        return folder;
      }
    }
    if (existsSync(join(this.serverRoot, "..", "..", "src", "lexer", "lexer.py"))) {
      return resolve(this.serverRoot, "..", "..");
    }
    return this.workspaceFolders[0] ?? resolve(this.serverRoot, "..", "..");
  }

  private isDefaultLibraryPath(path: string): boolean {
    const normalized = normalize(path);
    const stdlib = normalize(this.stdlibDirectory());
    return normalized === stdlib || normalized.startsWith(`${stdlib}${sep}`);
  }

  private loadStdlibDocs(): void {
    const docsPath = join(this.repoRoot, "docs", "stdlib.md");
    this.stdlibDocs = existsSync(docsPath) ? readFileSync(docsPath, "utf8") : "";
  }

  private documentationFor(symbol: VelaSymbol): string | undefined {
    if (!symbol.defaultLibrary || !this.stdlibDocs) {
      return undefined;
    }
    const names = [symbol.className, symbol.name, symbol.moduleName].filter((name): name is string => !!name);
    const section = names.map((name) => extractMarkdownSection(this.stdlibDocs, name)).find((candidate): candidate is string => !!candidate);
    if (section) {
      const synopsis = findSynopsisLine(section, symbol.name);
      return synopsis ? `\`\`\`vl\n${synopsis}\n\`\`\`` : section.slice(0, 1200);
    }
    return undefined;
  }
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  set.add(value);
}

function removeFromSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (!set) {
    return;
  }
  set.delete(value);
  if (set.size === 0) {
    map.delete(key);
  }
}

function mergeSettings(base: VelaSettings, patch: Partial<VelaSettings>): VelaSettings {
  return {
    ...base,
    ...patch,
    inlayHints: { ...base.inlayHints, ...patch.inlayHints },
    formatting: { ...base.formatting, ...patch.formatting },
    devCommands: { ...base.devCommands, ...patch.devCommands },
  };
}

function collectVelaFiles(root: string, recursive = true): string[] {
  const result: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git" || entry.name === ".venv" || entry.name === ".pytest_cache") {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory() && recursive) {
      result.push(...collectVelaFiles(path, true));
    } else if (entry.isFile() && entry.name.endsWith(".vl")) {
      result.push(normalize(path));
    }
  }
  return result;
}

export function uriToPath(uri: string): string {
  if (uri.startsWith("file:")) {
    return normalize(fileURLToPath(uri));
  }
  return normalize(isAbsolute(uri) ? uri : resolve(uri));
}

function relativePath(root: string, path: string): string {
  const normalizedRoot = normalize(root);
  const normalizedPath = normalize(path);
  const rel = pathRelative(normalizedRoot, normalizedPath);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : normalizedPath;
}

function extractMarkdownSection(markdown: string, name: string): string | undefined {
  const escaped = escapeRegExp(name);
  const heading = /^##\s+\d+\.\s+(.+)$/u;
  const namePattern = new RegExp(`\\b${escaped}\\b`, "iu");
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => {
    const match = heading.exec(line);
    return !!match && namePattern.test(match[1] ?? "");
  });
  if (start < 0) {
    return undefined;
  }
  let end = start + 1;
  while (end < lines.length && !heading.test(lines[end] ?? "")) {
    end++;
  }
  return lines.slice(start, end).join("\n").trim();
}

function findSynopsisLine(section: string, name: string): string | undefined {
  const lines = section.split(/\r?\n/);
  return lines.find((line) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(line) && /[();{}]/.test(line))?.trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
