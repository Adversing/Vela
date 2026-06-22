import {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  CodeActionKind,
  CompletionItem,
  CompletionItemKind,
  Diagnostic,
  DocumentHighlight,
  DocumentHighlightKind,
  DocumentLink,
  DocumentSymbol,
  FoldingRange,
  FoldingRangeKind,
  Hover,
  InlayHint,
  InlayHintKind,
  InsertTextFormat,
  Location,
  MarkupContent,
  Moniker,
  MonikerKind,
  PrepareRenameResult,
  Range,
  RenameParams,
  SelectionRange,
  SemanticTokenModifiers,
  SemanticTokenTypes,
  SemanticTokens,
  SemanticTokensBuilder,
  SignatureHelp,
  SignatureInformation,
  SymbolInformation,
  SymbolKind,
  TextDocumentEdit,
  TextEdit,
  TypeHierarchyItem,
  WorkspaceSymbol,
  WorkspaceEdit,
} from "vscode-languageserver/node";
import {
  ASM_REGISTER_NAMES,
  ASM_TAG_NAMES,
  AddressOfExprNode,
  AsmBlockNode,
  AsmBindingNode,
  BUILTIN_NAMES,
  KEYWORD_NAMES,
  PRIMITIVE_NAMES,
  TAG_NAMES,
  BaseNode,
  BlockStmtNode,
  CallExprNode,
  ClassDeclNode,
  CastExprNode,
  DeclNode,
  DerefExprNode,
  ExprNode,
  FieldAccessExprNode,
  FreeStmtNode,
  FunctionDeclNode,
  ImportDeclNode,
  InitExprNode,
  MallocExprNode,
  MethodCallExprNode,
  ModuleDeclNode,
  ParseResult,
  PrintStmtNode,
  SizeOfExprNode,
  StmtNode,
  Token,
  TokenKind,
  TypeDeclNode,
  TypeExprNode,
  UnaryExprNode,
  VarDeclNode,
  VelaRange,
  VelaSymbol,
  VelaType,
  containsOffset,
  lspPosition,
  lspPositionToOffset,
  lspRange,
  markdown,
  offsetToVelaPosition,
  typeToString,
} from "../vela/model.js";
import { FileState, WorkspaceIndex } from "../workspace/workspaceIndex.js";

export const semanticTokenTypes = [
  SemanticTokenTypes.namespace,
  SemanticTokenTypes.class,
  SemanticTokenTypes.interface,
  SemanticTokenTypes.type,
  SemanticTokenTypes.function,
  SemanticTokenTypes.method,
  SemanticTokenTypes.property,
  SemanticTokenTypes.variable,
  SemanticTokenTypes.parameter,
  SemanticTokenTypes.keyword,
  SemanticTokenTypes.operator,
  SemanticTokenTypes.number,
  SemanticTokenTypes.string,
  SemanticTokenTypes.comment,
  SemanticTokenTypes.macro,
  SemanticTokenTypes.enumMember,
];

export const semanticTokenModifiers = [
  SemanticTokenModifiers.declaration,
  SemanticTokenModifiers.definition,
  SemanticTokenModifiers.readonly,
  SemanticTokenModifiers.static,
  SemanticTokenModifiers.defaultLibrary,
];

const RESERVED_LITERAL_NAMES = ["true", "false", "null"] as const;
export const BUILTIN_VIRTUAL_URI = "vela-builtin:/builtins.vl";

const BUILTIN_DEFINITION_SIGNATURES: Record<string, string> = {
  Malloc: "Malloc(I16 size) -> Ptr<U0>",
  Free: "Free(Ptr<T> value) -> U0",
  Init: "Init<Class>(name: value, ...) -> Ptr<Class>",
  SizeOf: "SizeOf(Type) -> U16",
  Cast: "Cast<T>(expr) -> T",
  Print: "Print(value) -> U0",
};

export function builtinVirtualText(): string {
  return [
    "// Vela built-in definitions",
    ...BUILTIN_NAMES.map((name) => `// ${BUILTIN_DEFINITION_SIGNATURES[name] ?? name}`),
    "",
  ].join("\n");
}

export function completions(index: WorkspaceIndex, uri: string, position: { line: number; character: number }): CompletionItem[] {
  const state = index.get(uri);
  if (!state) {
    return [];
  }
  const offset = lspPositionToOffset(state.text, position);
  const token = tokenBefore(state.parse.allTokens, offset);
  const importDecl = findImportAt(state.parse, offset);
  if (importDecl) {
    return importCompletions(index, state.parse.allTokens, importDecl, offset);
  }
  const initExpr = innermostNodeAt<InitExprNode>(state.parse.program, offset, "InitExpr");
  if (initExpr && offset > initExpr.classNameRange.end.offset) {
    const context = initNamedArgContext(state.parse.allTokens, initExpr, offset);
    if (context) {
      return initNamedArgCompletions(index, state, initExpr, context.activeName);
    }
  }
  if (insideTag(state.parse.allTokens, offset)) {
    const inAsm = nodesAtOffset(state.parse.program, offset).some((node) => node.kind === "AsmBlock");
    return (inAsm ? ASM_TAG_NAMES : TAG_NAMES).map((label) => tagCompletion(label, inAsm));
  }
  const memberDotOffset = memberCompletionDotOffset(state.parse.allTokens, offset);
  if (memberDotOffset !== undefined) {
    return memberCompletions(index, state, memberDotOffset);
  }
  if (nodesAtOffset(state.parse.program, offset).some((node) => node.kind === "AsmBlock")) {
    return [
      ...ASM_REGISTER_NAMES.map(asmRegisterCompletion),
      ...visibleValueCompletions(index, state, offset),
    ];
  }
  const items: CompletionItem[] = [
    ...classBodyCompletions(index, state, offset),
    ...KEYWORD_NAMES.map(keywordCompletion),
    ...PRIMITIVE_NAMES.map(primitiveCompletion),
    ...BUILTIN_NAMES.map(builtinCompletion),
    ...visibleSymbolCompletions(index, state, offset),
  ];
  return dedupeCompletions(items);
}

export function hover(index: WorkspaceIndex, uri: string, position: { line: number; character: number }): Hover | null {
  const state = index.get(uri);
  const offset = state ? lspPositionToOffset(state.text, position) : undefined;
  if (state) {
    const importTarget = importTargetsAtOffset(index, state, offset!);
    if (importTarget && importTarget.targets.length > 0) {
      return {
        contents: markdown(importTargetMarkdown(importTarget.targets)),
        range: lspRange(importTarget.range),
      };
    }
  }
  const token = state && offset !== undefined ? tokenAtOffset(state.parse.allTokens, offset) : index.tokenAt(uri, position);
  if (!token) {
    return null;
  }
  if (BUILTIN_NAMES.includes(token.value as (typeof BUILTIN_NAMES)[number])) {
    return { contents: markdown(builtinMarkdown(token.value)), range: lspRange(token.range) };
  }
  const asmHover = state ? asmHoverForToken(state, token) : undefined;
  if (asmHover) {
    return { contents: markdown(asmHover), range: lspRange(token.range) };
  }
  if (isSymbolHoverToken(token)) {
    const symbols = symbolsAtPosition(index, uri, position);
    if (symbols.length > 0) {
      return { contents: markdown(symbolHoverMarkdown(index, symbols)), range: lspRange(token.range) };
    }
  }
  const expressionType = state ? expressionTypeAtOffset(state, offset ?? token.range.start.offset) : undefined;
  if (expressionType) {
    return { contents: markdown(`\`${typeToString(expressionType.type)}\``), range: lspRange(expressionType.range) };
  }
  if (token.kind === TokenKind.IntLiteral || token.kind === TokenKind.FloatLiteral || token.kind === TokenKind.CharLiteral || token.kind === TokenKind.StringLiteral) {
    return { contents: markdown(`\`${literalType(token)}\``), range: lspRange(token.range) };
  }
  return null;
}

export function signatureHelp(index: WorkspaceIndex, uri: string, position: { line: number; character: number }): SignatureHelp | null {
  const state = index.get(uri);
  if (!state) {
    return null;
  }
  const offset = lspPositionToOffset(state.text, position);
  const call = nearestCall(state.parse.program, state.parse.allTokens, offset);
  if (call) {
    const signature = signatureForCall(index, state, call.node);
    if (signature) {
      return {
        signatures: [signature.info],
        activeSignature: 0,
        activeParameter: boundedActiveParameter(signature.params, state.parse.allTokens, call.openParenOffset, offset),
      };
    }
  }
  const declaration = nearestSignatureDeclaration(state.parse.program, state.parse.allTokens, offset);
  const signature = declaration ? signatureForDeclaration(declaration.node) : undefined;
  return declaration
    ? {
        signatures: [signature!.info],
        activeSignature: 0,
        activeParameter: boundedActiveParameter(signature!.params, state.parse.allTokens, declaration.openParenOffset, offset),
      }
    : null;
}

export function definition(index: WorkspaceIndex, uri: string, position: { line: number; character: number }): Location[] {
  const state = index.get(uri);
  const offset = state ? lspPositionToOffset(state.text, position) : undefined;
  if (state) {
    const importTarget = importTargetsAtOffset(index, state, offset!);
    if (importTarget && importTarget.targets.length > 0) {
      return importTarget.targets.map((target) => Location.create(target.uri, lspRange(target.parse.program.modules[0]?.nameRange ?? target.parse.program.range)));
    }
    const token = tokenAtOffset(state.parse.allTokens, offset!);
    if (token && BUILTIN_NAMES.includes(token.value as (typeof BUILTIN_NAMES)[number])) {
      const location = builtinDefinitionLocation(token.value);
      return location ? [location] : [];
    }
  }
  const symbols = symbolsAtPosition(index, uri, position);
  return symbols.map((symbol) => Location.create(symbol.uri, lspRange(symbol.selectionRange)));
}

export function declaration(index: WorkspaceIndex, uri: string, position: { line: number; character: number }): Location[] {
  const declarations = uniqueLocations(symbolsAtPosition(index, uri, position).flatMap((symbol) => declarationTargets(index, symbol)));
  return declarations.length > 0 ? declarations : definition(index, uri, position);
}

export function typeDefinition(index: WorkspaceIndex, uri: string, position: { line: number; character: number }): Location[] {
  const symbol = index.findSymbolAt(uri, position);
  if (symbol) {
    const declaredType = declaredTypeSymbol(index, uri, symbol, position);
    if (declaredType) {
      return [Location.create(declaredType.uri, lspRange(declaredType.selectionRange))];
    }
    const typeName = symbol.type.kind === "ptr" && symbol.type.inner.kind === "class"
      ? symbol.type.inner.name
      : symbol.type.kind === "class" || symbol.type.kind === "interface"
        ? symbol.type.name
        : undefined;
    if (!typeName) {
      return [];
    }
    const typeSymbol = typeSymbolByName(index, uri, typeName, position);
    return typeSymbol ? [Location.create(typeSymbol.uri, lspRange(typeSymbol.selectionRange))] : [];
  }
  const token = index.tokenAt(uri, position);
  if (token?.kind === TokenKind.Identifier) {
    const tokenTypeSymbol = typeSymbolByName(index, uri, token.value, position);
    if (tokenTypeSymbol) {
      return [Location.create(tokenTypeSymbol.uri, lspRange(tokenTypeSymbol.selectionRange))];
    }
  }
  return [];
}

export function implementation(index: WorkspaceIndex, uri: string, position: { line: number; character: number }): Location[] {
  const typeMethod = typeMethodAtPosition(index, uri, position);
  if (typeMethod) {
    return index
      .allSymbols()
      .filter((candidate) => candidate.kind === "class" && parentIsSymbol(index, candidate, typeMethod.typeSymbol))
      .flatMap((cls) => methodSymbolsForClassSymbol(index, cls).filter((candidate) => candidate.name === typeMethod.method.name))
      .map((candidate) => Location.create(candidate.uri, lspRange(candidate.selectionRange)));
  }
  const symbol = index.findSymbolAt(uri, position);
  if (!symbol || !["class", "type"].includes(symbol.kind)) {
    return [];
  }
  return index
    .allSymbols()
    .filter((candidate) => candidate.kind === "class" && parentIsSymbol(index, candidate, symbol))
    .map((candidate) => Location.create(candidate.uri, lspRange(candidate.selectionRange)));
}

function declaredTypeSymbol(index: WorkspaceIndex, uri: string, symbol: VelaSymbol, position?: { line: number; character: number }): VelaSymbol | undefined {
  if (["alias", "class", "type"].includes(symbol.kind)) {
    return symbol;
  }
  const typeName = typeExprReferenceName(typeExprForSymbol(symbol));
  return typeName ? typeSymbolByName(index, uri, typeName, position) : undefined;
}

function typeExprForSymbol(symbol: VelaSymbol): TypeExprNode | undefined {
  const decl = symbol.decl;
  if (!decl) {
    return undefined;
  }
  if (decl.kind === "VarDecl" || decl.kind === "ParamDecl") {
    return decl.typeExpr;
  }
  if (decl.kind === "FunctionDecl") {
    return decl.returnType;
  }
  if (decl.kind === "AliasDecl") {
    return decl.targetType;
  }
  return undefined;
}

function typeExprReferenceName(typeExpr: TypeExprNode | undefined): string | undefined {
  if (!typeExpr) {
    return undefined;
  }
  if (typeExpr.kind === "PtrType") {
    return typeExprReferenceName(typeExpr.inner);
  }
  return typeExpr.kind === "NamedType" && !PRIMITIVE_NAMES.includes(typeExpr.name as (typeof PRIMITIVE_NAMES)[number]) ? typeExpr.name : undefined;
}

function typeSymbolByName(index: WorkspaceIndex, uri: string, name: string, position?: { line: number; character: number }): VelaSymbol | undefined {
  const state = index.get(uri);
  if (state && position) {
    const module = moduleAtOffset(state, lspPositionToOffset(state.text, position));
    return visibleTopLevelSymbolByName(index, state, module, name, new Set(["alias", "class", "type"]));
  }
  return index.visibleSymbols(uri).find((symbol) => ["alias", "class", "type"].includes(symbol.kind) && symbol.name === name)
    ?? index.allSymbols().find((symbol) => ["alias", "class", "type"].includes(symbol.kind) && symbol.name === name);
}

function typeMethodAtPosition(index: WorkspaceIndex, uri: string, position: { line: number; character: number }): { type: TypeDeclNode; typeSymbol: VelaSymbol; method: FunctionDeclNode } | undefined {
  const state = index.get(uri);
  if (!state) {
    return undefined;
  }
  const offset = lspPositionToOffset(state.text, position);
  for (const node of allNodes(state.parse.program).filter((candidate): candidate is TypeDeclNode => candidate.kind === "TypeDecl")) {
    const method = node.methods.find((candidate) => containsOffset(candidate.nameRange, offset));
    const typeSymbol = method
      ? state.analysis.symbols.find((symbol) =>
        symbol.kind === "type"
        && symbol.uri === state.uri
        && symbol.selectionRange.start.offset === node.nameRange.start.offset
        && symbol.selectionRange.end.offset === node.nameRange.end.offset)
      : undefined;
    if (method && typeSymbol) {
      return { type: node, typeSymbol, method };
    }
  }
  return undefined;
}

function declarationTargets(index: WorkspaceIndex, symbol: VelaSymbol): Location[] {
  if (symbol.kind !== "method" || !symbol.className) {
    return [];
  }
  const owner = classSymbolForMemberSymbol(index, symbol);
  const parent = owner ? parentSymbolFor(index, owner) : undefined;
  if (!parent) {
    return [];
  }
  if (parent.kind === "type" && parent.decl?.kind === "TypeDecl") {
    const method = parent.decl.methods.find((candidate) => candidate.name === symbol.name);
    return method ? [Location.create(parent.uri, lspRange(method.nameRange))] : [];
  }
  if (parent.kind === "class") {
    const method = methodSymbolInHierarchy(index, parent, symbol.name);
    return method ? [Location.create(method.uri, lspRange(method.selectionRange))] : [];
  }
  return [];
}

function methodSymbolInHierarchy(index: WorkspaceIndex, classSymbol: VelaSymbol, methodName: string): VelaSymbol | undefined {
  for (const cls of classHierarchySymbolsForSymbol(index, classSymbol)) {
    const method = index.allSymbols().find((symbol) => symbol.kind === "method" && symbol.className === cls.name && symbol.uri === cls.uri && symbol.moduleName === cls.moduleName && symbol.name === methodName);
    if (method) {
      return method;
    }
  }
  return undefined;
}

function uniqueLocations(locations: Location[]): Location[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.uri}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function references(index: WorkspaceIndex, uri: string, position: { line: number; character: number }, includeDeclaration: boolean): Location[] {
  const locations = symbolsAtPosition(index, uri, position)
    .flatMap((symbol) => referenceSymbolsForSymbol(index, symbol))
    .flatMap((symbol) => index.referencesFor(symbol.id, includeDeclaration))
    .map((ref) => Location.create(ref.uri, lspRange(ref.range)));
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.uri}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function symbolsAtPosition(index: WorkspaceIndex, uri: string, position: { line: number; character: number }): VelaSymbol[] {
  const state = index.get(uri);
  if (!state) {
    const symbol = index.findSymbolAt(uri, position);
    return symbol ? [symbol] : [];
  }
  const offset = lspPositionToOffset(state.text, position);
  const symbols = new Map<string, VelaSymbol>();
  for (const ref of state.analysis.references.filter((item) => containsOffset(item.range, offset))) {
    const symbol = index.symbolById(ref.symbolId);
    if (symbol) {
      symbols.set(symbol.id, symbol);
    }
  }
  if (symbols.size > 0) {
    return [...symbols.values()];
  }
  const symbol = index.findSymbolAt(uri, position);
  return symbol ? [symbol] : [];
}

export function highlights(index: WorkspaceIndex, uri: string, position: { line: number; character: number }): DocumentHighlight[] {
  const highlights = symbolsAtPosition(index, uri, position)
    .flatMap((symbol) => referenceSymbolsForSymbol(index, symbol))
    .flatMap((symbol) => index.referencesFor(symbol.id, true))
    .filter((ref) => ref.uri === uri)
    .map((ref) => DocumentHighlight.create(lspRange(ref.range), ref.write ? DocumentHighlightKind.Write : DocumentHighlightKind.Read));
  const seen = new Set<string>();
  return highlights.filter((highlight) => {
    const key = `${highlight.range.start.line}:${highlight.range.start.character}:${highlight.range.end.line}:${highlight.range.end.character}:${highlight.kind ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function documentSymbols(state: FileState): DocumentSymbol[] {
  return state.parse.program.modules.map(moduleSymbol);
}

export function workspaceSymbols(index: WorkspaceIndex, query: string): SymbolInformation[] {
  return matchingWorkspaceSymbols(index, query)
    .map((symbol) => SymbolInformation.create(symbol.name, lspSymbolKind(symbol.kind), lspRange(symbol.selectionRange), symbol.uri, workspaceSymbolContainer(symbol)));
}

export function resolvableWorkspaceSymbols(index: WorkspaceIndex, query: string): WorkspaceSymbol[] {
  return matchingWorkspaceSymbols(index, query)
    .map((symbol) => workspaceSymbolFor(symbol, false));
}

export function resolveWorkspaceSymbol(index: WorkspaceIndex, item: WorkspaceSymbol): WorkspaceSymbol {
  const data = workspaceSymbolData(item);
  const symbol = data?.symbolId
    ? index.symbolById(data.symbolId)
    : workspaceSymbolFallback(index, item);
  if (!symbol) {
    return item;
  }
  const resolved = workspaceSymbolFor(symbol, true);
  return { ...resolved, data: item.data ?? resolved.data };
}

function matchingWorkspaceSymbols(index: WorkspaceIndex, query: string): VelaSymbol[] {
  const lowered = query.trim().toLowerCase();
  return index
    .allSymbols()
    .filter((symbol) => !lowered || symbol.name.toLowerCase().includes(lowered))
    .filter((symbol) => !["local", "param"].includes(symbol.kind))
    .sort((left, right) =>
      workspaceSymbolRank(left, lowered) - workspaceSymbolRank(right, lowered)
      || Number(Boolean(left.defaultLibrary)) - Number(Boolean(right.defaultLibrary))
      || left.name.localeCompare(right.name)
      || (left.className ?? left.moduleName ?? "").localeCompare(right.className ?? right.moduleName ?? "")
      || left.uri.localeCompare(right.uri));
}

function workspaceSymbolRank(symbol: VelaSymbol, loweredQuery: string): number {
  if (!loweredQuery) {
    return 0;
  }
  const loweredName = symbol.name.toLowerCase();
  if (loweredName === loweredQuery) {
    return 0;
  }
  return loweredName.startsWith(loweredQuery) ? 1 : 2;
}

function workspaceSymbolFor(symbol: VelaSymbol, resolved: boolean): WorkspaceSymbol {
  return {
    name: symbol.name,
    kind: lspSymbolKind(symbol.kind),
    containerName: workspaceSymbolContainer(symbol),
    location: resolved ? Location.create(symbol.uri, lspRange(symbol.selectionRange)) : { uri: symbol.uri },
    data: { symbolId: symbol.id },
  };
}

function workspaceSymbolContainer(symbol: VelaSymbol): string | undefined {
  return symbol.className ?? symbol.moduleName;
}

function workspaceSymbolData(item: WorkspaceSymbol): { symbolId?: string } | undefined {
  const data = item.data as { symbolId?: unknown } | undefined;
  return typeof data?.symbolId === "string" ? { symbolId: data.symbolId } : undefined;
}

function workspaceSymbolFallback(index: WorkspaceIndex, item: WorkspaceSymbol): VelaSymbol | undefined {
  const uri = typeof item.location?.uri === "string" ? item.location.uri : undefined;
  return index.allSymbols().find((symbol) =>
    symbol.name === item.name
    && lspSymbolKind(symbol.kind) === item.kind
    && (!uri || symbol.uri === uri)
    && (!item.containerName || workspaceSymbolContainer(symbol) === item.containerName));
}

export function documentLinks(index: WorkspaceIndex, state: FileState): DocumentLink[] {
  const links: DocumentLink[] = [];
  for (const module of state.parse.program.modules) {
    for (const imp of module.imports) {
      for (let i = 0; i < imp.modules.length; i++) {
        const moduleName = imp.modules[i];
        if (!moduleName) {
          continue;
        }
        const range = imp.moduleRanges[i] ?? imp.range;
        const targets = moduleName === "*" ? index.filesForImport(imp) : [index.moduleForImport(imp, moduleName)].filter((target): target is FileState => !!target);
        for (const target of targets.sort((a, b) => a.path.localeCompare(b.path))) {
          const targetUri = index.stdlibVirtualUriForUri(target.uri) ?? target.uri;
          links.push({
            range: lspRange(range),
            data: {
              targetUri,
              sourceUri: target.uri,
              tooltip: documentLinkTooltip(target, moduleName),
            },
          });
        }
      }
    }
  }
  return links;
}

export function resolveDocumentLink(index: WorkspaceIndex, link: DocumentLink): DocumentLink {
  const data = link.data as { targetUri?: string; sourceUri?: string; tooltip?: string } | undefined;
  if (!data?.targetUri) {
    return link;
  }
  const target = index.get(data.sourceUri ?? data.targetUri);
  return {
    ...link,
    target: data.targetUri,
    tooltip: data.tooltip ?? (target ? documentLinkTooltip(target, "import") : undefined),
  };
}

export interface FileRenameEditInput {
  oldUri: string;
  newUri: string;
}

export interface FileDeleteEditInput {
  uri: string;
}

export function fileRenameImportEdit(index: WorkspaceIndex, files: FileRenameEditInput[]): WorkspaceEdit | null {
  const changes: Record<string, TextEdit[]> = {};
  for (const file of files) {
    const oldImport = index.importPathForUri(file.oldUri);
    const newImport = index.importPathForUri(file.newUri);
    if (!oldImport || !newImport || (sameStringArray(oldImport.package, newImport.package) && oldImport.moduleName === newImport.moduleName)) {
      continue;
    }
    const renamedState = index.get(file.oldUri);
    if (renamedState && !renamedState.defaultLibrary) {
      const edits = moduleDeclarationRenameEditsForState(renamedState, oldImport.moduleName, newImport.moduleName);
      if (edits.length > 0) {
        changes[renamedState.uri] = [...(changes[renamedState.uri] ?? []), ...edits];
      }
    }
    for (const state of index.allFiles()) {
      if (state.defaultLibrary) {
        continue;
      }
      const edits = importRenameEditsForState(state, oldImport, newImport);
      if (edits.length > 0) {
        changes[state.uri] = [...(changes[state.uri] ?? []), ...edits];
      }
    }
  }
  return Object.keys(changes).length > 0 ? { changes } : null;
}

export function fileDeleteImportEdit(index: WorkspaceIndex, files: FileDeleteEditInput[]): WorkspaceEdit | null {
  const deletedImports = files
    .map((file) => index.importPathForUri(file.uri))
    .filter((item): item is { package: string[]; moduleName: string } => !!item);
  if (deletedImports.length === 0) {
    return null;
  }
  const deletedUris = new Set(files.map((file) => file.uri));
  const changes: Record<string, TextEdit[]> = {};
  for (const state of index.allFiles()) {
    if (state.defaultLibrary || deletedUris.has(state.uri)) {
      continue;
    }
    const edits = importDeleteEditsForState(state, deletedImports);
    if (edits.length > 0) {
      changes[state.uri] = edits;
    }
  }
  return Object.keys(changes).length > 0 ? { changes } : null;
}

export function moniker(index: WorkspaceIndex, uri: string, position: { line: number; character: number }): Moniker[] {
  return symbolsAtPosition(index, uri, position)
    .map(monikerForSymbol);
}

function monikerForSymbol(symbol: VelaSymbol): Moniker {
  const local = symbol.kind === "local" || symbol.kind === "param";
  return {
    scheme: "vela",
    identifier: symbol.id,
    unique: local ? "document" : "global",
    kind: local ? MonikerKind.local : MonikerKind.$export,
  };
}

export function semanticTokens(state: FileState, range?: Range): SemanticTokens {
  const builder = new SemanticTokensBuilder();
  const startOffset = range ? lspPositionToOffset(state.text, range.start) : 0;
  const endOffset = range ? lspPositionToOffset(state.text, range.end) : Number.MAX_SAFE_INTEGER;
  for (const token of state.parse.allTokens) {
    if (token.kind === TokenKind.Eof) {
      continue;
    }
    if (token.range.start.offset < startOffset || token.range.start.offset >= endOffset) {
      continue;
    }
    const line = token.range.start.line - 1;
    const tokenType = semanticTypeForToken(state, token);
    if (!tokenType) {
      continue;
    }
    const modifiers = semanticModifiersForToken(state, token);
    builder.push(line, token.range.start.column - 1, Math.max(1, token.lexeme.length), semanticTokenTypes.indexOf(tokenType), modifiers);
  }
  return builder.build();
}

export function formatting(state: FileState, range?: Range): TextEdit[] {
  const nodes = allNodes(state.parse.program);
  const formatted = formatTokens(
    state.text,
    state.parse.allTokens,
    nodes.filter((node): node is AsmBlockNode => node.kind === "AsmBlock").map((node) => node.range),
    prefixOperatorOffsets(nodes),
  );
  if (!range) {
    const fullRange = fullDocumentRange(state.text);
    return formatted === state.text ? [] : [TextEdit.replace(fullRange, formatted)];
  }
  const edit = rangeFormattingEdit(state.text, formatted, range);
  return edit ? [edit] : [];
}

export function codeActions(index: WorkspaceIndex, state: FileState, diagnostics: Diagnostic[]): CodeAction[] {
  const actions: CodeAction[] = [];
  const organize = organizeImportsAction(state);
  if (organize) {
    actions.push(organize);
  }
  actions.push(...importRefactorActions(index, state));
  actions.push(...unusedImportActions(index, state));
  actions.push(...overrideMethodActions(index, state));
  actions.push(...fieldTagActions(state));
  for (const diagnostic of diagnostics) {
    const message = diagnosticMessage(diagnostic.message);
    if (diagnostic.code === "vela.sem.unknownIdentifier") {
      const name = extractQuotedName(message);
      if (name) {
        actions.push(...missingImportActions(index, state, name, diagnostic));
        if (/function/.test(message)) {
          actions.push(createFunctionAction(state, name, diagnostic.range, diagnostic));
        }
      }
    }
    if (diagnostic.code === "vela.sem.unknownType") {
      const name = extractQuotedName(message);
      if (name) {
        actions.push(...missingImportActions(index, state, name, diagnostic));
        actions.push(createAliasAction(state, name, diagnostic));
        actions.push(createClassAction(state, name, diagnostic));
        actions.push(createTypeAction(state, name, diagnostic));
      }
    }
    if (diagnostic.code === "vela.sem.unknownParent") {
      const name = /unknown class or type '([^']+)'/.exec(message)?.[1];
      if (name) {
        actions.push(...missingImportActions(index, state, name, diagnostic));
        actions.push(createClassAction(state, name, diagnostic));
        actions.push(createTypeAction(state, name, diagnostic));
      }
    }
    const renameAction = renameConflictingDeclarationAction(index, state, diagnostic);
    if (renameAction) {
      actions.push(renameAction);
    }
    if (diagnostic.code === "vela.sem.printArity") {
      const action = removePrintFormatAction(state, diagnostic);
      if (action) {
        actions.push(action);
      }
    }
    if (diagnostic.code === "vela.sem.initArgName") {
      actions.push(...fixInitArgumentActions(index, state, diagnostic));
    }
    if (diagnostic.code === "vela.sem.missingSkeleton") {
      const action = implementSkeletonAction(index, state, diagnostic);
      if (action) {
        actions.push(action);
      }
    }
    if (diagnostic.code === "vela.sem.missingReturn" || diagnostic.code === "vela.sem.returnMissingValue") {
      actions.push(...missingReturnActions(state, diagnostic));
    }
    const castAction = castExpressionAction(state, diagnostic);
    if (castAction) {
      actions.push(castAction);
    }
    const boxedAction = boxedPrimitiveMethodAction(index, state, diagnostic);
    if (boxedAction) {
      actions.push(boxedAction);
    }
    const conditionAction = integerConditionAction(state, diagnostic);
    if (conditionAction) {
      actions.push(conditionAction);
    }
  }
  return actions;
}

export function prepareRename(index: WorkspaceIndex, uri: string, position: { line: number; character: number }): PrepareRenameResult | null {
  const symbol = singleSymbolAtPosition(index, uri, position);
  if (!symbol || symbol.kind === "builtin" || symbol.kind === "module" || symbol.defaultLibrary) {
    return null;
  }
  if (symbol.generated && !isGeneratedAccessorMethod(index, symbol)) {
    return null;
  }
  return { range: renameRangeAtPosition(index, uri, position, symbol), placeholder: symbol.name };
}

export function rename(index: WorkspaceIndex, params: RenameParams): WorkspaceEdit {
  if (!validIdentifier(params.newName)) {
    return {};
  }
  const symbol = singleSymbolAtPosition(index, params.textDocument.uri, params.position);
  if (!symbol || symbol.kind === "module" || symbol.defaultLibrary) {
    return {};
  }
  if (symbol.generated) {
    return generatedAccessorRenameEdit(index, symbol, params.newName) ?? {};
  }
  if (symbol.kind === "builtin") {
    return {};
  }
  if (!canRenameTo(index, symbol, params.newName)) {
    return {};
  }
  const taggedFieldEdit = taggedFieldRenameEdit(index, symbol, params.newName);
  if (taggedFieldEdit) {
    return taggedFieldEdit;
  }
  const changes: Record<string, TextEdit[]> = {};
  const seen = new Set<string>();
  for (const target of renameSymbolsForSymbol(index, symbol)) {
    for (const ref of index.referencesFor(target.id, true)) {
      const key = `${ref.uri}:${ref.range.start.offset}:${ref.range.end.offset}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      changes[ref.uri] ??= [];
      changes[ref.uri]!.push(TextEdit.replace(lspRange(ref.range), params.newName));
    }
  }
  return { changes };
}

function singleSymbolAtPosition(index: WorkspaceIndex, uri: string, position: { line: number; character: number }): VelaSymbol | undefined {
  const symbols = symbolsAtPosition(index, uri, position);
  return symbols.length === 1 ? symbols[0] : undefined;
}

function renameRangeAtPosition(index: WorkspaceIndex, uri: string, position: { line: number; character: number }, symbol: VelaSymbol): Range {
  const state = index.get(uri);
  const offset = state ? lspPositionToOffset(state.text, position) : undefined;
  const ref = state && offset !== undefined
    ? state.analysis.references.find((item) => item.symbolId === symbol.id && containsOffset(item.range, offset))
    : undefined;
  return lspRange(ref?.range ?? symbol.selectionRange);
}

function referenceSymbolsForSymbol(index: WorkspaceIndex, symbol: VelaSymbol): VelaSymbol[] {
  return renameSymbolsForSymbol(index, symbol);
}

export function inlayHints(index: WorkspaceIndex, state: FileState): InlayHint[] {
  const settings = index.settingsSnapshot().inlayHints;
  const hints: InlayHint[] = [];
  if (settings.parameterNames) {
    for (const item of callNodes(state.parse.program)) {
      const signature = signatureForCall(index, state, item);
      if (!signature) {
        continue;
      }
      item.args.forEach((arg, index) => {
        const param = signature.params[index];
        if (param && !argumentAlreadyNamed(item, param.name)) {
          hints.push(InlayHint.create(lspRange(arg.range).start, `${param.name}:`, InlayHintKind.Parameter));
        }
      });
    }
    for (const item of allNodes(state.parse.program).filter((node): node is InitExprNode => node.kind === "InitExpr")) {
      const signature = signatureForCall(index, state, item);
      if (!signature) {
        continue;
      }
      item.kwargs.forEach((arg, index) => {
        const param = signature.params[index];
        if (param && arg.name !== param.name) {
          hints.push(InlayHint.create(lspRange(arg.value.range).start, `${param.name}:`, InlayHintKind.Parameter));
        }
      });
    }
    for (const item of allNodes(state.parse.program)) {
      if (item.kind === "MallocExpr") {
        hints.push(InlayHint.create(lspRange((item as MallocExprNode).size.range).start, "size:", InlayHintKind.Parameter));
      } else if (item.kind === "SizeOfExpr") {
        hints.push(InlayHint.create(lspRange((item as SizeOfExprNode).targetType.range).start, "type:", InlayHintKind.Parameter));
      } else if (item.kind === "CastExpr") {
        hints.push(InlayHint.create(lspRange((item as CastExprNode).operand.range).start, "expr:", InlayHintKind.Parameter));
      } else if (item.kind === "FreeStmt") {
        hints.push(InlayHint.create(lspRange((item as FreeStmtNode).expr.range).start, "value:", InlayHintKind.Parameter));
      } else if (item.kind === "PrintStmt") {
        hints.push(InlayHint.create(lspRange((item as PrintStmtNode).value.range).start, "value:", InlayHintKind.Parameter));
      }
    }
  }
  if (settings.inferredTypes) {
    for (const item of state.analysis.expressionTypes) {
      if (!isUsefulInlayType(item.type)) {
        continue;
      }
      hints.push(InlayHint.create(lspRange(item.range).end, `: ${typeToString(item.type)}`, InlayHintKind.Type));
    }
  }
  if (settings.layout) {
    for (const symbol of state.analysis.symbols.filter((symbol) => symbol.uri === state.uri)) {
      if (symbol.kind === "class" && symbol.type.kind === "class") {
        hints.push(InlayHint.create(lspRange(symbol.selectionRange).end, ` size ${symbol.type.size}`, InlayHintKind.Type));
      }
      if (symbol.kind === "field" && symbol.type && symbol.decl?.kind === "VarDecl") {
        const owner = state.analysis.symbols.find((candidate) =>
          candidate.kind === "class"
          && candidate.uri === symbol.uri
          && candidate.moduleName === symbol.moduleName
          && candidate.name === symbol.className);
        const field = owner?.type.kind === "class" ? owner.type.fields.find((candidate) => candidate.name === symbol.name) : undefined;
        if (field?.offset !== undefined) {
          hints.push(InlayHint.create(lspRange(symbol.selectionRange).end, ` @${field.offset}`, InlayHintKind.Type));
        }
      }
      if (symbol.kind === "method" && symbol.className) {
        const owner = state.analysis.symbols.find((candidate) =>
          candidate.kind === "class"
          && candidate.uri === symbol.uri
          && candidate.moduleName === symbol.moduleName
          && candidate.name === symbol.className);
        const slot = owner?.type.kind === "class" ? owner.type.vtable[symbol.name] : undefined;
        if (slot !== undefined) {
          hints.push(InlayHint.create(lspRange(symbol.selectionRange).end, ` vslot ${slot}`, InlayHintKind.Type));
        }
      }
    }
  }
  return hints;
}

function isUsefulInlayType(type: VelaType | undefined): boolean {
  if (!type || type.kind === "unknown" || type.kind === "void") {
    return false;
  }
  return type.kind !== "ptr" || type.inner.kind !== "unknown";
}

export function foldingRanges(state: FileState): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  for (const node of allNodes(state.parse.program)) {
    if (["ModuleDecl", "ClassDecl", "TypeDecl", "FunctionDecl", "BlockStmt", "AsmBlock"].includes(node.kind) && node.range.end.line > node.range.start.line) {
      ranges.push(FoldingRange.create(node.range.start.line - 1, node.range.end.line - 1, node.range.start.column - 1, node.range.end.column - 1, node.kind === "AsmBlock" ? FoldingRangeKind.Region : undefined));
    }
  }
  for (const module of state.parse.program.modules) {
    if (module.imports.length > 1) {
      ranges.push(FoldingRange.create(module.imports[0]!.range.start.line - 1, module.imports.at(-1)!.range.end.line - 1, undefined, undefined, FoldingRangeKind.Imports));
    }
  }
  ranges.push(...commentFoldingRanges(state));
  return ranges;
}

function commentFoldingRanges(state: FileState): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  const comments = state.parse.allTokens
    .filter((token) => token.kind === TokenKind.Comment)
    .sort((left, right) => left.range.start.offset - right.range.start.offset);
  let groupStart: Token | undefined;
  let previous: Token | undefined;
  for (const token of comments) {
    if (!groupStart) {
      groupStart = token;
      previous = token;
      continue;
    }
    if (previous && token.range.start.line === previous.range.start.line + 1) {
      previous = token;
      continue;
    }
    if (previous && previous.range.start.line > groupStart.range.start.line) {
      ranges.push(FoldingRange.create(groupStart.range.start.line - 1, previous.range.start.line - 1, undefined, undefined, FoldingRangeKind.Comment));
    }
    groupStart = token;
    previous = token;
  }
  if (groupStart && previous && previous.range.start.line > groupStart.range.start.line) {
    ranges.push(FoldingRange.create(groupStart.range.start.line - 1, previous.range.start.line - 1, undefined, undefined, FoldingRangeKind.Comment));
  }
  return ranges;
}

export function selectionRanges(state: FileState, positions: { line: number; character: number }[]): SelectionRange[] {
  return positions.map((position) => {
    const offset = lspPositionToOffset(state.text, position);
    const token = state.parse.allTokens.find((item) => containsOffset(item.range, offset));
    const ranges = distinctRanges([
      ...(token ? [lspRange(token.range)] : []),
      ...nodesAtOffset(state.parse.program, offset)
        .filter((node) => node.kind !== "Program")
        .sort((a, b) => (a.range.end.offset - a.range.start.offset) - (b.range.end.offset - b.range.start.offset))
        .map((node) => lspRange(node.range)),
    ]);
    return ranges.reduceRight<SelectionRange | undefined>((parent, range) => SelectionRange.create(range, parent), undefined) ?? SelectionRange.create(emptySelectionRange(state.text, position));
  });
}

function distinctRanges(ranges: Range[]): Range[] {
  const seen = new Set<string>();
  return ranges.filter((range) => {
    const key = `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function emptySelectionRange(text: string, position: { line: number; character: number }): Range {
  const lines = text.split(/\r?\n/u);
  const line = Math.max(0, Math.min(position.line, Math.max(0, lines.length - 1)));
  const character = Math.max(0, Math.min(position.character, lines[line]?.length ?? 0));
  return Range.create(line, character, line, character);
}

export function prepareCallHierarchy(index: WorkspaceIndex, uri: string, position: { line: number; character: number }): CallHierarchyItem[] {
  return symbolsAtPosition(index, uri, position)
    .filter((symbol) => ["function", "method"].includes(symbol.kind))
    .map(callHierarchyItem);
}

export function incomingCalls(index: WorkspaceIndex, item: CallHierarchyItem): CallHierarchyIncomingCall[] {
  const symbol = symbolForCallHierarchyItem(index, item);
  if (!symbol) {
    return [];
  }
  const incoming = new Map<string, { from: VelaSymbol; ranges: Range[] }>();
  for (const state of index.allFiles()) {
    for (const edge of state.analysis.callEdges.filter((edge) => edge.to.id === symbol.id)) {
      const key = edge.from.id;
      const existing = incoming.get(key) ?? { from: edge.from, ranges: [] };
      existing.ranges.push(lspRange(edge.range));
      incoming.set(key, existing);
    }
  }
  return [...incoming.values()].map((entry) => ({
    from: callHierarchyItem(entry.from),
    fromRanges: entry.ranges,
  }));
}

export function outgoingCalls(index: WorkspaceIndex, item: CallHierarchyItem): CallHierarchyOutgoingCall[] {
  const symbol = symbolForCallHierarchyItem(index, item);
  if (!symbol) {
    return [];
  }
  const outgoing = new Map<string, { to: VelaSymbol; ranges: Range[] }>();
  for (const state of index.allFiles()) {
    for (const edge of state.analysis.callEdges.filter((edge) => edge.from.id === symbol.id)) {
      const existing = outgoing.get(edge.to.id) ?? { to: edge.to, ranges: [] };
      existing.ranges.push(lspRange(edge.range));
      outgoing.set(edge.to.id, existing);
    }
  }
  return [...outgoing.values()].map((entry) => ({
    to: callHierarchyItem(entry.to),
    fromRanges: entry.ranges,
  }));
}

function symbolForCallHierarchyItem(index: WorkspaceIndex, item: CallHierarchyItem): VelaSymbol | undefined {
  const byId = item.data !== undefined ? index.symbolById(String(item.data)) : undefined;
  return byId ?? index.allSymbols().find((candidate) => candidate.uri === item.uri && candidate.name === item.name);
}

export function prepareTypeHierarchy(index: WorkspaceIndex, uri: string, position: { line: number; character: number }): TypeHierarchyItem[] {
  const symbol = index.findSymbolAt(uri, position);
  if (!symbol || !["class", "type"].includes(symbol.kind)) {
    return [];
  }
  return [typeHierarchyItem(symbol)];
}

export function supertypes(index: WorkspaceIndex, item: TypeHierarchyItem): TypeHierarchyItem[] {
  const symbol = index.symbolById(String(item.data));
  if (!symbol || !["class", "type"].includes(symbol.kind)) {
    return [];
  }
  const parent = parentSymbolFor(index, symbol);
  return parent ? [typeHierarchyItem(parent)] : [];
}

export function subtypes(index: WorkspaceIndex, item: TypeHierarchyItem): TypeHierarchyItem[] {
  const symbol = index.symbolById(String(item.data));
  if (!symbol) {
    return [];
  }
  return index.allSymbols()
    .filter((candidate) => candidate.kind === "class" && parentIsSymbol(index, candidate, symbol))
    .map(typeHierarchyItem);
}

function keywordCompletion(label: string): CompletionItem {
  const snippets: Record<string, string> = {
    module: "module ${1:name} {\n    $0\n}",
    class: "class ${1:Name} {\n    $0\n}",
    type: "type ${1:Name} {\n    skeleton ${2:I16} ${3:Method}($0);\n}",
    if: "if (${1:condition}) {\n    $0\n}",
    for: "for (${1:I16 i = 0}; ${2:i < n}; ${3:i++}) {\n    $0\n}",
    while: "while (${1:condition}) {\n    $0\n}",
    ASM: "ASM(\n    [[in]] R0 = ${1:value};\n) {\n    $0\n}",
    OnAlloc: "OnAlloc($1) {\n    $0\n}",
    OnFree: "OnFree() {\n    $0\n}",
    ret: "ret $0;",
  };
  return {
    label,
    kind: CompletionItemKind.Keyword,
    insertText: snippets[label] ?? label,
    insertTextFormat: snippets[label] ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
    sortText: `0_${label}`,
  };
}

function primitiveCompletion(label: string): CompletionItem {
  if (label === "Ptr") {
    return {
      label,
      kind: CompletionItemKind.TypeParameter,
      detail: "Vela pointer type",
      insertText: "Ptr<${1:I16}>",
      insertTextFormat: InsertTextFormat.Snippet,
      sortText: "1_Ptr",
      commitCharacters: ["<"],
    };
  }
  return {
    label,
    kind: CompletionItemKind.TypeParameter,
    detail: "Vela primitive type",
    sortText: `1_${label}`,
    commitCharacters: [" ", ",", ")", "]", ";"],
  };
}

function builtinCompletion(label: string): CompletionItem {
  const detail: Record<string, string> = {
    Malloc: "Ptr<U0> Malloc(integer-size)",
    Free: "Free(pointer-expression)",
    Init: "Init<Class>(name: value, ...)",
    SizeOf: "U16 SizeOf(Type)",
    Cast: "Cast<T>(expr)",
    Print: "Print(value)",
  };
  const snippets: Record<string, string> = {
    Malloc: "Malloc(${1:size})",
    Free: "Free(${1:pointer})",
    Init: "Init<${1:Class}>(${2:name}: ${3:value})",
    SizeOf: "SizeOf(${1:I16})",
    Cast: "Cast<${1:I16}>(${2:expr})",
    Print: "Print(${1:value})",
  };
  return {
    label,
    kind: CompletionItemKind.Function,
    detail: detail[label],
    documentation: builtinMarkdown(label),
    sortText: `1_${label}`,
    insertText: snippets[label],
    insertTextFormat: InsertTextFormat.Snippet,
    commitCharacters: ["("],
  };
}

function tagCompletion(label: string, asm: boolean): CompletionItem {
  const docs: Record<string, string> = {
    get: "Generates a getter method for the field.",
    set: "Generates a setter method for the field.",
    visible: "Marks the field as visible metadata without generating methods.",
    in: "Binds a visible Vela value as an ASM input register.",
    out: "Binds a visible Vela variable or field as an ASM output register.",
  };
  return {
    label,
    kind: CompletionItemKind.EnumMember,
    detail: asm ? "ASM binding tag" : "Vela field tag",
    documentation: docs[label],
    sortText: `0_${label}`,
    commitCharacters: ["]", ","],
  };
}

function asmRegisterCompletion(label: string): CompletionItem {
  return {
    label,
    kind: CompletionItemKind.EnumMember,
    detail: "ASM register",
    documentation: "General-purpose CPU register usable in ASM bindings.",
    sortText: `0_${label.padStart(2, "0")}`,
    commitCharacters: [" ", "=", ";"],
  };
}

function visibleSymbolCompletions(index: WorkspaceIndex, state: FileState, offset: number): CompletionItem[] {
  return completionVisibleSymbols(index, state, offset, false).map((symbol) => {
    const item: CompletionItem = {
      label: symbol.name,
      kind: completionKind(symbol.kind),
      detail: symbolDetail(symbol),
      documentation: symbol.documentation,
      sortText: `${symbol.defaultLibrary ? "4" : "2"}_${symbol.name}`,
      commitCharacters: symbolCompletionCommitCharacters(symbol.kind),
    };
    if (symbol.defaultLibrary) {
      const importDecl = index.stdlibImportForSymbol(symbol.name);
      const importEdit = importDecl ? importEditIfMissing(state, importDecl, moduleAtOffset(state, offset)) : undefined;
      if (importEdit) {
        item.additionalTextEdits = [importEdit];
      }
    }
    return item;
  });
}

function visibleValueCompletions(index: WorkspaceIndex, state: FileState, offset: number): CompletionItem[] {
  return completionVisibleSymbols(index, state, offset, true).map((symbol) => ({
    label: symbol.name,
    kind: completionKind(symbol.kind),
    detail: symbolDetail(symbol),
    documentation: symbol.documentation,
    sortText: `${symbol.kind === "field" ? "2" : "1"}_${symbol.name}`,
    commitCharacters: symbolCompletionCommitCharacters(symbol.kind),
  }));
}

function completionVisibleSymbols(index: WorkspaceIndex, state: FileState, offset: number, valuesOnly: boolean): VelaSymbol[] {
  const currentFn = functionAtOffset(state, offset);
  const currentClass = classAtOffset(state, offset);
  const currentModule = moduleAtOffset(state, offset);
  const visibleTopLevelIds = topLevelSymbolIdsVisibleFromModule(index, state, currentModule);
  const currentClassSymbol = currentClass ? classSymbolVisibleAtOffset(index, state, currentClass.name, offset) : undefined;
  const currentClassHierarchy = currentClassSymbol
    ? new Set(classHierarchySymbolsForSymbol(index, currentClassSymbol).map(classSymbolKey))
    : new Set<string>();
  const result: VelaSymbol[] = [];
  const seen = new Set<string>();
  for (const symbol of index.visibleSymbols(state.uri)) {
    if (seen.has(symbol.id) || !isCompletionVisibleSymbol(symbol, state, offset, currentFn, currentClass, currentClassHierarchy, visibleTopLevelIds, valuesOnly)) {
      continue;
    }
    seen.add(symbol.id);
    result.push(symbol);
  }
  return result;
}

function isCompletionVisibleSymbol(
  symbol: VelaSymbol,
  state: FileState,
  offset: number,
  currentFn: FunctionDeclNode | undefined,
  currentClass: ClassDeclNode | undefined,
  currentClassHierarchy: Set<string>,
  visibleTopLevelIds: Set<string>,
  valuesOnly: boolean,
): boolean {
  if (symbol.kind === "global") {
    return visibleTopLevelIds.has(symbol.id) || Boolean(symbol.defaultLibrary);
  }
  if (symbol.kind === "local" || symbol.kind === "param") {
    if (symbol.generated && symbol.name === "this") {
      return !!currentFn && !!currentClass && symbol.className === currentClass.name;
    }
    return !!currentFn
      && containsOffset(currentFn.range, symbol.selectionRange.start.offset)
      && symbol.selectionRange.start.offset <= offset;
  }
  if (symbol.kind === "field") {
    return !!currentClass && !!symbol.className && currentClassHierarchy.has(symbolOwnerClassKey(symbol));
  }
  if (valuesOnly) {
    return false;
  }
  return ["alias", "class", "type", "function"].includes(symbol.kind)
    && (visibleTopLevelIds.has(symbol.id) || Boolean(symbol.defaultLibrary));
}

function topLevelSymbolIdsVisibleFromModule(index: WorkspaceIndex, state: FileState, module: ModuleDeclNode | undefined): Set<string> {
  const visible = new Set<string>();
  if (!module) {
    return visible;
  }
  for (const symbol of state.analysis.symbols) {
    if (symbol.uri === state.uri && symbol.moduleName === module.name && isTopLevelSymbol(symbol)) {
      visible.add(symbol.id);
    }
  }
  for (const imp of module.imports) {
    const targets = imp.wildcard || imp.modules.includes("*")
      ? index.filesForImport(imp)
      : imp.modules.flatMap((moduleName) => {
        const target = index.moduleForImport(imp, moduleName);
        return target ? [target] : [];
      });
    for (const target of targets) {
      const importedModuleName = target.parse.program.modules[0]?.name;
      for (const symbol of target.analysis.symbols) {
        if (symbol.uri === target.uri && symbol.moduleName === importedModuleName && isTopLevelSymbol(symbol)) {
          visible.add(symbol.id);
        }
      }
    }
  }
  return visible;
}

function visibleTopLevelSymbolByName(
  index: WorkspaceIndex,
  state: FileState,
  module: ModuleDeclNode | undefined,
  name: string,
  kinds: Set<string>,
): VelaSymbol | undefined {
  const ids = topLevelSymbolIdsVisibleFromModule(index, state, module);
  return index.allSymbols().find((symbol) => ids.has(symbol.id) && symbol.name === name && kinds.has(symbol.kind));
}

function visibleClassSymbolForInit(index: WorkspaceIndex, state: FileState, initExpr: InitExprNode): VelaSymbol | undefined {
  return visibleTopLevelSymbolByName(index, state, moduleAtOffset(state, initExpr.range.start.offset), initExpr.className, new Set(["class"]));
}

function visibleOnAllocSymbolForInit(index: WorkspaceIndex, state: FileState, initExpr: InitExprNode): VelaSymbol | undefined {
  const cls = visibleClassSymbolForInit(index, state, initExpr);
  return cls ? methodSymbolsForClassSymbol(index, cls).find((symbol) => symbol.name === "OnAlloc") : undefined;
}

function classBodyCompletions(index: WorkspaceIndex, state: FileState, offset: number): CompletionItem[] {
  const cls = classBodyAtOffset(state, offset);
  if (!cls?.parent) {
    return [];
  }
  const parent = visibleTopLevelSymbolByName(index, state, moduleAtOffset(state, offset), cls.parent, new Set(["class", "type"]));
  const implemented = new Set([
    ...cls.methods.map((method) => method.name),
    ...(cls.onAlloc ? [cls.onAlloc.name] : []),
    ...(cls.onFree ? [cls.onFree.name] : []),
  ]);
  if (parent?.kind === "type" && parent.decl?.kind === "TypeDecl") {
    return parent.decl.methods
      .filter((method) => !implemented.has(method.name))
      .map((method) => ({
        label: method.name,
        kind: CompletionItemKind.Method,
        detail: `Implement skeleton ${methodSignatureFromDecl(method)}`,
        insertText: methodSnippetFromDecl(method),
        insertTextFormat: InsertTextFormat.Snippet,
        sortText: `0_skeleton_${method.name}`,
      }));
  }
  if (parent?.kind === "class") {
    return methodSymbolsForClassSymbol(index, parent)
      .filter((method) => !implemented.has(method.name) && method.name !== "OnAlloc" && method.name !== "OnFree")
      .map((method) => ({
        label: method.name,
        kind: CompletionItemKind.Method,
        detail: `Override ${symbolDetail(method)}`,
        insertText: methodSnippetFromSymbol(method),
        insertTextFormat: InsertTextFormat.Snippet,
        sortText: `0_override_${method.name}`,
      }));
  }
  return [];
}

function classBodyAtOffset(state: FileState, offset: number): ClassDeclNode | undefined {
  const cls = classAtOffset(state, offset);
  if (!cls || offset <= cls.nameRange.end.offset) {
    return undefined;
  }
  const insideMethod = allNodes(cls).some((node) => node.kind === "FunctionDecl" && containsOffset(node.range, offset));
  return insideMethod ? undefined : cls;
}

function classAtOffset(state: FileState, offset: number): ClassDeclNode | undefined {
  return allNodes(state.parse.program)
    .filter((node): node is ClassDeclNode => node.kind === "ClassDecl" && containsOffset(node.range, offset))
    .sort((left, right) => (left.range.end.offset - left.range.start.offset) - (right.range.end.offset - right.range.start.offset))[0];
}

function memberCompletions(index: WorkspaceIndex, state: FileState, dotOffset: number): CompletionItem[] {
  const receiverType = memberReceiverTypeAtDot(index, state, dotOffset);
  const actual = receiverType?.kind === "ptr" ? receiverType.inner : receiverType;
  if (!actual || actual.kind !== "class") {
    return [];
  }
  const classSymbol = classSymbolVisibleAtOffset(index, state, actual.name, dotOffset);
  const fields = actual.fields.map((field) => {
    const symbol = classSymbol ? fieldSymbolForClassSymbol(index, classSymbol, field.name) : undefined;
    return {
      label: field.name,
      kind: CompletionItemKind.Field,
      detail: symbol ? symbolDetail(symbol) : typeToString(field.type),
      documentation: symbol?.documentation,
      sortText: `1_${field.name}`,
      commitCharacters: [".", ",", ";", ")", "]"],
    };
  });
  const methods = (classSymbol ? methodSymbolsForClassSymbol(index, classSymbol) : methodSymbolsForClass(index, actual.name))
    .map((method) => ({ label: method.name, kind: CompletionItemKind.Method, detail: symbolDetail(method), documentation: method.documentation, sortText: `2_${method.name}`, commitCharacters: ["("] }));
  return [...fields, ...methods];
}

function memberCompletionDotOffset(tokens: Token[], offset: number): number | undefined {
  const token = tokenBefore(tokens, offset);
  if (token?.kind === TokenKind.Dot) {
    return token.range.start.offset;
  }
  if (token?.kind !== TokenKind.Identifier) {
    return undefined;
  }
  const beforeIdentifier = tokenBefore(tokens, token.range.start.offset);
  return beforeIdentifier?.kind === TokenKind.Dot ? beforeIdentifier.range.start.offset : undefined;
}

function memberReceiverTypeAtDot(index: WorkspaceIndex, state: FileState, dotOffset: number): VelaType | undefined {
  const memberAccess = allNodes(state.parse.program)
    .filter((node): node is FieldAccessExprNode | MethodCallExprNode => node.kind === "FieldAccessExpr" || node.kind === "MethodCallExpr")
    .filter((node) => node.obj.range.end.offset <= dotOffset && containsOffset(node.range, dotOffset))
    .sort((left, right) => (left.range.end.offset - left.range.start.offset) - (right.range.end.offset - right.range.start.offset))[0];
  if (memberAccess?.obj.inferredType) {
    return memberAccess.obj.inferredType;
  }
  const objectToken = [...state.parse.allTokens].reverse().find((token) => token.range.end.offset <= dotOffset && token.kind === TokenKind.Identifier);
  if (!objectToken) {
    return undefined;
  }
  const [symbol] = symbolsAtPosition(index, state.uri, lspPosition(objectToken.range.start));
  return symbol && ["local", "param", "global", "field"].includes(symbol.kind) ? symbol.type : undefined;
}

function methodSymbolsForClass(index: WorkspaceIndex, className: string): VelaSymbol[] {
  const cls = classSymbolForName(index, className);
  return cls ? methodSymbolsForClassSymbol(index, cls) : [];
}

function methodSymbolsForClassSymbol(index: WorkspaceIndex, classSymbol: VelaSymbol): VelaSymbol[] {
  const symbols = index.allSymbols();
  const methods = new Map<string, VelaSymbol>();
  for (const cls of classHierarchySymbolsForSymbol(index, classSymbol)) {
    for (const method of symbols.filter((symbol) => symbol.kind === "method" && symbol.className === cls.name && symbol.uri === cls.uri && symbol.moduleName === cls.moduleName)) {
      if (!methods.has(method.name)) {
        methods.set(method.name, method);
      }
    }
  }
  return [...methods.values()];
}

function fieldSymbolForClassSymbol(index: WorkspaceIndex, classSymbol: VelaSymbol, fieldName: string): VelaSymbol | undefined {
  return classHierarchySymbolsForSymbol(index, classSymbol)
    .flatMap((cls) => index.allSymbols().filter((symbol) =>
      symbol.kind === "field"
      && symbol.className === cls.name
      && symbol.uri === cls.uri
      && symbol.moduleName === cls.moduleName
      && symbol.name === fieldName))
    [0];
}

function classHierarchySymbols(index: WorkspaceIndex, className: string): VelaSymbol[] {
  const cls = classSymbolForName(index, className);
  return cls ? classHierarchySymbolsForSymbol(index, cls) : [];
}

function classHierarchySymbolsForSymbol(index: WorkspaceIndex, classSymbol: VelaSymbol): VelaSymbol[] {
  const result: VelaSymbol[] = [];
  const seen = new Set<string>();
  let current: VelaSymbol | undefined = classSymbol;
  while (current && !seen.has(current.id)) {
    result.push(current);
    seen.add(current.id);
    const parent = parentSymbolFor(index, current);
    current = parent?.kind === "class" ? parent : undefined;
  }
  return result;
}

function parentSymbolFor(index: WorkspaceIndex, symbol: VelaSymbol): VelaSymbol | undefined {
  const parentName = parentNameFor(symbol);
  if (!parentName) {
    return undefined;
  }
  const state = index.get(symbol.uri);
  if (state) {
    const module = moduleAtOffset(state, symbol.selectionRange.start.offset);
    const visibleParent = visibleTopLevelSymbolByName(index, state, module, parentName, new Set(["class", "type"]));
    if (visibleParent) {
      return visibleParent;
    }
  }
  return index.allSymbols().find((candidate) => ["class", "type"].includes(candidate.kind) && candidate.name === parentName);
}

function parentIsSymbol(index: WorkspaceIndex, child: VelaSymbol, parent: VelaSymbol): boolean {
  return parentSymbolFor(index, child)?.id === parent.id;
}

function parentNameFor(symbol: VelaSymbol): string | undefined {
  if (symbol.type.kind === "class") {
    return symbol.type.parent;
  }
  if (symbol.decl?.kind === "TypeDecl") {
    return symbol.decl.parent;
  }
  return undefined;
}

function classSymbolForName(index: WorkspaceIndex, className: string): VelaSymbol | undefined {
  return index.allSymbols().find((symbol) => symbol.kind === "class" && symbol.name === className);
}

function classSymbolVisibleAtOffset(index: WorkspaceIndex, state: FileState, className: string, offset: number): VelaSymbol | undefined {
  return visibleTopLevelSymbolByName(index, state, moduleAtOffset(state, offset), className, new Set(["class"]));
}

function classSymbolKey(symbol: VelaSymbol): string {
  return `${symbol.uri}:${symbol.moduleName ?? ""}:${symbol.name}`;
}

function symbolOwnerClassKey(symbol: VelaSymbol): string {
  return `${symbol.uri}:${symbol.moduleName ?? ""}:${symbol.className ?? symbol.name}`;
}

function initNamedArgContext(tokens: Token[], initExpr: InitExprNode, offset: number): { activeName?: string } | undefined {
  const activeArg = initExpr.kwargs.find((arg) => containsOffset(arg.nameRange, offset));
  if (activeArg) {
    return { activeName: activeArg.name };
  }
  const previous = tokenBefore(tokens, offset);
  if (!previous || previous.range.start.offset < initExpr.range.start.offset || previous.range.start.offset > initExpr.range.end.offset) {
    return undefined;
  }
  if (previous.kind === TokenKind.LParen || previous.kind === TokenKind.Comma) {
    return {};
  }
  return undefined;
}

function initNamedArgCompletions(index: WorkspaceIndex, state: FileState, initExpr: InitExprNode, activeName?: string): CompletionItem[] {
  const onAlloc = visibleOnAllocSymbolForInit(index, state, initExpr);
  const used = new Set(initExpr.kwargs.map((arg) => arg.name));
  return (onAlloc?.params ?? [])
    .filter((param) => !used.has(param.name) || param.name === activeName)
    .map((param, order) => ({
      label: param.name,
      kind: CompletionItemKind.Property,
      detail: `${typeToString(param.type)} ${param.name}`,
      insertText: `${param.name}: $0`,
      insertTextFormat: InsertTextFormat.Snippet,
      sortText: `0_${order}_${param.name}`,
      commitCharacters: [":"],
    }));
}

function importCompletions(index: WorkspaceIndex, tokens: Token[], imp: ImportDeclNode, offset: number): CompletionItem[] {
  const context = importCompletionContext(tokens, imp, offset);
  const prefix = context === "module" ? imp.package : importPackagePrefixAtOffset(imp, offset);
  const items: CompletionItem[] = index.importPackageSegments(prefix, context === "module" ? "module" : "directory").map((label) => ({
    label,
    kind: CompletionItemKind.Module,
    detail: context === "module" ? "Vela import module" : "Vela import package segment",
    documentation: context === "module"
      ? "Module file available from the workspace or bundled stdlib."
      : "Package segment available from the workspace or bundled stdlib.",
    sortText: `1_${label}`,
    commitCharacters: context === "module" ? [",", "}"] : [":"],
  }));
  if (context === "module") {
    items.unshift({
      label: "*",
      kind: CompletionItemKind.Module,
      detail: "Wildcard import all modules in package",
      commitCharacters: ["}"],
      sortText: "0_*",
    });
  }
  return items;
}

function importCompletionContext(tokens: Token[], imp: ImportDeclNode, offset: number): "package" | "module" {
  const importTokens = tokens.filter((token) =>
    token.kind !== TokenKind.Comment
    && token.range.start.offset >= imp.range.start.offset
    && token.range.end.offset <= imp.range.end.offset);
  const listOpen = importTokens.find((token) => token.kind === TokenKind.LBrace);
  const listClose = importTokens.find((token) => token.kind === TokenKind.RBrace && (!listOpen || token.range.start.offset > listOpen.range.start.offset));
  return listOpen && offset >= listOpen.range.end.offset && (!listClose || offset <= listClose.range.start.offset)
    ? "module"
    : "package";
}

function importPackagePrefixAtOffset(imp: ImportDeclNode, offset: number): string[] {
  for (let index = 0; index < imp.packageRanges.length; index++) {
    const range = imp.packageRanges[index]!;
    if (offset <= range.end.offset) {
      return imp.package.slice(0, index);
    }
  }
  return imp.package;
}

function dedupeCompletions(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.label)) {
      return false;
    }
    seen.add(item.label);
    return true;
  });
}

function completionKind(kind: string): CompletionItemKind {
  switch (kind) {
    case "class":
      return CompletionItemKind.Class;
    case "type":
      return CompletionItemKind.Interface;
    case "function":
    case "method":
      return CompletionItemKind.Function;
    case "field":
      return CompletionItemKind.Field;
    case "alias":
      return CompletionItemKind.TypeParameter;
    case "param":
      return CompletionItemKind.Variable;
    default:
      return CompletionItemKind.Variable;
  }
}

function symbolCompletionCommitCharacters(kind: string): string[] | undefined {
  if (kind === "function" || kind === "method") {
    return ["("];
  }
  if (kind === "field" || kind === "local" || kind === "param" || kind === "global") {
    return [".", ",", ";", ")", "]"];
  }
  if (kind === "class" || kind === "type" || kind === "alias") {
    return [" ", ",", ")", "]", ";"];
  }
  return undefined;
}

function symbolDetail(symbol: VelaSymbol): string {
  if (symbol.kind === "function" || symbol.kind === "method") {
    return `${typeToString(symbol.returnType ?? symbol.type)} ${symbol.name}(${symbol.params?.map((param) => `${typeToString(param.type)} ${param.name}`).join(", ") ?? ""})`;
  }
  return `${symbol.kind} ${symbol.name}: ${typeToString(symbol.type)}`;
}

function symbolMarkdown(index: WorkspaceIndex, symbol: VelaSymbol): string {
  const docs = symbol.documentation ? `\n\n${symbol.documentation}` : "";
  if (symbol.kind === "class" && symbol.type.kind === "class") {
    const parent = symbol.type.parent ? ` : ${symbol.type.parent}` : "";
    const lines = [`class ${symbol.name}${parent} // size ${symbol.type.size}`];
    for (const field of symbol.type.fields) {
      const offset = field.offset === undefined ? "" : ` // offset ${field.offset}`;
      lines.push(`field ${typeToString(field.type)} ${field.name}${offset}`);
    }
    for (const method of methodSymbolsForClassSymbol(index, symbol)) {
      const slot = symbol.type.vtable[method.name];
      const slotText = slot === undefined ? "" : ` // vtable slot ${slot}`;
      lines.push(`${symbolDetail(method)}${slotText}`);
    }
    return `\`\`\`vl\n${lines.join("\n")}\n\`\`\`${docs}`;
  }
  if (symbol.kind === "function" || symbol.kind === "method") {
    return `\`\`\`vl\n${symbolDetail(symbol)}\n\`\`\`${docs}`;
  }
  return `\`\`\`vl\n${symbolDetail(symbol)}\n\`\`\`${docs}`;
}

function symbolHoverMarkdown(index: WorkspaceIndex, symbols: VelaSymbol[]): string {
  return symbols.map((symbol) => {
    const owner = symbols.length > 1 && symbol.className ? `**${symbol.className}.${symbol.name}**\n\n` : "";
    return `${owner}${symbolMarkdown(index, symbol)}`;
  }).join("\n\n---\n\n");
}

function isSymbolHoverToken(token: Token): boolean {
  return token.kind === TokenKind.Identifier || token.kind === TokenKind.KwOnAlloc || token.kind === TokenKind.KwOnFree;
}

function expressionTypeAtOffset(state: FileState, offset: number): { range: VelaRange; type: VelaType } | undefined {
  return state.analysis.expressionTypes
    .filter((item) => containsOffset(item.range, offset))
    .sort((left, right) => (left.range.end.offset - left.range.start.offset) - (right.range.end.offset - right.range.start.offset))[0];
}

function builtinMarkdown(name: string): string {
  const docs: Record<string, string> = {
    Malloc: "Allocates a byte count and returns `Ptr<U0>`.",
    Free: "Frees a pointer. Class pointers call `OnFree` where applicable. `Free(null)` is valid.",
    Init: "Allocates a class object and calls its `OnAlloc` with named arguments in parameter order.",
    SizeOf: "Returns the static byte size of a Vela type as `U16`.",
    Cast: "Performs explicit integer/pointer casts; casts to or from `F16` are rejected by the backend.",
    Print: "Emits the current one-argument runtime print syscall.",
  };
  return docs[name] ?? name;
}

function asmHoverForToken(state: FileState, token: Token): string | undefined {
  if (isAsmRegisterToken(state, token)) {
    return `\`${token.value}\`\n\nASM register. Vela validates binding registers as \`R0\`..\`R9\`; assembly body registers are tokenized for navigation and highlighting.`;
  }
  if (isAsmLabelDefinitionToken(state, token)) {
    return `\`${token.value}:\`\n\nASM label definition local to this inline assembly block.`;
  }
  if (isAsmBranchTargetToken(state, token)) {
    return `\`${token.value}\`\n\nASM branch target label reference.`;
  }
  if (isAsmInstructionToken(state, token)) {
    return `\`${token.value}\`\n\nASM instruction mnemonic. The language server highlights inline assembly but leaves instruction semantics to the assembler/backend.`;
  }
  return undefined;
}

function literalType(token: Token): string {
  if (token.kind === TokenKind.FloatLiteral) {
    return "F16";
  }
  if (token.kind === TokenKind.CharLiteral) {
    return "U8";
  }
  if (token.kind === TokenKind.StringLiteral) {
    return "Ptr<U8>";
  }
  return "I16 | U16";
}

function lspSymbolKind(kind: string): SymbolKind {
  switch (kind) {
    case "module":
      return SymbolKind.Module;
    case "class":
      return SymbolKind.Class;
    case "type":
      return SymbolKind.Interface;
    case "function":
      return SymbolKind.Function;
    case "method":
      return SymbolKind.Method;
    case "field":
      return SymbolKind.Field;
    case "alias":
      return SymbolKind.TypeParameter;
    case "param":
      return SymbolKind.Variable;
    default:
      return SymbolKind.Variable;
  }
}

function moduleSymbol(module: ModuleDeclNode): DocumentSymbol {
  return {
    name: module.name,
    kind: SymbolKind.Module,
    range: lspRange(module.range),
    selectionRange: lspRange(module.nameRange),
    children: module.body.map(declSymbol),
  };
}

function declSymbol(node: DeclNode): DocumentSymbol {
  if (node.kind === "ClassDecl") {
    return {
      name: node.name,
      kind: SymbolKind.Class,
      range: lspRange(node.range),
      selectionRange: lspRange(node.nameRange),
      children: [...node.fields.map((field) => ({
        name: field.name,
        kind: SymbolKind.Field,
        range: lspRange(field.range),
        selectionRange: lspRange(field.nameRange),
      })), ...node.methods.map((method) => functionSymbol(method, SymbolKind.Method)), ...(node.onAlloc ? [functionSymbol(node.onAlloc, SymbolKind.Method)] : []), ...(node.onFree ? [functionSymbol(node.onFree, SymbolKind.Method)] : [])],
    };
  }
  if (node.kind === "TypeDecl") {
    return {
      name: node.name,
      kind: SymbolKind.Interface,
      range: lspRange(node.range),
      selectionRange: lspRange(node.nameRange),
      children: node.methods.map((method) => functionSymbol(method, SymbolKind.Method)),
    };
  }
  if (node.kind === "FunctionDecl") {
    return functionSymbol(node);
  }
  return {
    name: "name" in node ? node.name : node.kind,
    kind: node.kind === "AliasDecl" ? SymbolKind.TypeParameter : SymbolKind.Variable,
    range: lspRange(node.range),
    selectionRange: "nameRange" in node ? lspRange(node.nameRange) : lspRange(node.range),
  };
}

function functionSymbol(fn: FunctionDeclNode, kind: SymbolKind = fn.isSkeleton ? SymbolKind.Interface : SymbolKind.Function): DocumentSymbol {
  const children = [
    ...fn.params.map((param) => ({ order: param.range.start.offset, symbol: paramSymbol(param) })),
    ...localVarSymbols(fn).map((local) => ({ order: local.range.start.offset, symbol: varSymbol(local) })),
  ]
    .sort((left, right) => left.order - right.order)
    .map((item) => item.symbol);
  return {
    name: fn.name,
    kind,
    range: lspRange(fn.range),
    selectionRange: lspRange(fn.nameRange),
    children,
  };
}

function paramSymbol(param: FunctionDeclNode["params"][number]): DocumentSymbol {
  return {
    name: param.name,
    kind: SymbolKind.Variable,
    range: lspRange(param.range),
    selectionRange: lspRange(param.nameRange),
  };
}

function varSymbol(node: VarDeclNode): DocumentSymbol {
  return {
    name: node.name,
    kind: SymbolKind.Variable,
    range: lspRange(node.range),
    selectionRange: lspRange(node.nameRange),
  };
}

function localVarSymbols(fn: FunctionDeclNode): VarDeclNode[] {
  return allNodes(fn).filter((node): node is VarDeclNode => node.kind === "VarDecl");
}

function semanticTypeForToken(state: FileState, token: Token): SemanticTokenTypes | undefined {
  if (token.kind === TokenKind.Comment) {
    return SemanticTokenTypes.comment;
  }
  if ([TokenKind.IntLiteral, TokenKind.FloatLiteral].includes(token.kind)) {
    return SemanticTokenTypes.number;
  }
  if ([TokenKind.StringLiteral, TokenKind.CharLiteral].includes(token.kind)) {
    return SemanticTokenTypes.string;
  }
  if (token.kind.toString().startsWith("KW_")) {
    return SemanticTokenTypes.keyword;
  }
  if ([TokenKind.BoolTrue, TokenKind.BoolFalse, TokenKind.NullLiteral].includes(token.kind)) {
    return SemanticTokenTypes.keyword;
  }
  if (token.kind.toString().startsWith("TY_")) {
    return SemanticTokenTypes.type;
  }
  if (token.kind.toString().startsWith("BI_")) {
    return SemanticTokenTypes.macro;
  }
  if ([TokenKind.Plus, TokenKind.Minus, TokenKind.Star, TokenKind.Slash, TokenKind.Percent, TokenKind.Eq, TokenKind.Neq, TokenKind.Lt, TokenKind.Gt, TokenKind.Lte, TokenKind.Gte, TokenKind.And, TokenKind.Or, TokenKind.Not, TokenKind.Ampersand, TokenKind.Assign, TokenKind.PlusEq, TokenKind.MinusEq, TokenKind.StarEq, TokenKind.SlashEq, TokenKind.PlusPlus, TokenKind.MinusMinus, TokenKind.Arrow].includes(token.kind)) {
    return SemanticTokenTypes.operator;
  }
  if (token.kind === TokenKind.Identifier) {
    if (isTagNameToken(state, token)) {
      return SemanticTokenTypes.enumMember;
    }
    if (isAsmRegisterToken(state, token)) {
      return SemanticTokenTypes.enumMember;
    }
    if (isAsmLabelToken(state, token)) {
      return SemanticTokenTypes.function;
    }
    if (isAsmInstructionToken(state, token)) {
      return SemanticTokenTypes.macro;
    }
    if (isImportPathToken(state, token)) {
      return SemanticTokenTypes.namespace;
    }
    const symbol = semanticSymbolForToken(state, token);
    if (symbol?.kind === "module") return SemanticTokenTypes.namespace;
    if (symbol?.kind === "alias") return SemanticTokenTypes.type;
    if (symbol?.kind === "class") return SemanticTokenTypes.class;
    if (symbol?.kind === "type") return SemanticTokenTypes.interface;
    if (symbol?.kind === "function") return SemanticTokenTypes.function;
    if (symbol?.kind === "method") return SemanticTokenTypes.method;
    if (symbol?.kind === "field") return SemanticTokenTypes.property;
    if (symbol?.kind === "param") return SemanticTokenTypes.parameter;
    return SemanticTokenTypes.variable;
  }
  return undefined;
}

function semanticModifiersForToken(state: FileState, token: Token): number {
  let mask = 0;
  const symbol = semanticSymbolForToken(state, token);
  if (symbol) {
    if (containsOffset(symbol.selectionRange, token.range.start.offset)) {
      mask |= 1 << semanticTokenModifiers.indexOf(SemanticTokenModifiers.declaration);
      mask |= 1 << semanticTokenModifiers.indexOf(SemanticTokenModifiers.definition);
    }
    if (symbol.defaultLibrary) {
      mask |= 1 << semanticTokenModifiers.indexOf(SemanticTokenModifiers.defaultLibrary);
      mask |= 1 << semanticTokenModifiers.indexOf(SemanticTokenModifiers.readonly);
    }
    if (["function", "global"].includes(symbol.kind)) {
      mask |= 1 << semanticTokenModifiers.indexOf(SemanticTokenModifiers.static);
    }
  }
  if (token.kind.toString().startsWith("BI_")) {
    mask |= 1 << semanticTokenModifiers.indexOf(SemanticTokenModifiers.readonly);
  }
  if (isDefaultLibraryImportToken(state, token)) {
    mask |= 1 << semanticTokenModifiers.indexOf(SemanticTokenModifiers.defaultLibrary);
    mask |= 1 << semanticTokenModifiers.indexOf(SemanticTokenModifiers.readonly);
  }
  if (isAsmLabelDefinitionToken(state, token)) {
    mask |= 1 << semanticTokenModifiers.indexOf(SemanticTokenModifiers.declaration);
    mask |= 1 << semanticTokenModifiers.indexOf(SemanticTokenModifiers.definition);
  }
  return mask;
}

function semanticSymbolForToken(state: FileState, token: Token): VelaSymbol | undefined {
  const declaration = state.analysis.symbols.find((candidate) => candidate.uri === state.uri && containsOffset(candidate.selectionRange, token.range.start.offset));
  if (declaration) {
    return declaration;
  }
  const ref = state.analysis.references.find((candidate) => candidate.uri === state.uri && containsOffset(candidate.range, token.range.start.offset));
  return ref ? state.analysis.symbols.find((candidate) => candidate.id === ref.symbolId) : undefined;
}

function isImportPathToken(state: FileState, token: Token): boolean {
  return allNodes(state.parse.program)
    .filter((node): node is ImportDeclNode => node.kind === "ImportDecl")
    .some((imp) => [...imp.packageRanges, ...imp.moduleRanges].some((range) => containsOffset(range, token.range.start.offset)));
}

function isDefaultLibraryImportToken(state: FileState, token: Token): boolean {
  return allNodes(state.parse.program)
    .filter((node): node is ImportDeclNode => node.kind === "ImportDecl" && containsOffset(node.range, token.range.start.offset))
    .some((imp) => {
      const packageToken = imp.packageRanges.some((range) => containsOffset(range, token.range.start.offset));
      const moduleToken = imp.moduleRanges.some((range) => containsOffset(range, token.range.start.offset));
      if (!packageToken && !moduleToken) {
        return false;
      }
      return imp.package[0] === "stdlib";
    });
}

function isAsmRegisterToken(state: FileState, token: Token): boolean {
  return ASM_REGISTER_NAMES.includes(token.value as (typeof ASM_REGISTER_NAMES)[number])
    && (isAsmBodyToken(state, token)
      || allNodes(state.parse.program)
      .filter((node): node is AsmBindingNode => node.kind === "AsmBinding")
      .some((node) => containsOffset(node.registerRange, token.range.start.offset)));
}

function isAsmLabelToken(state: FileState, token: Token): boolean {
  return isAsmLabelDefinitionToken(state, token) || isAsmBranchTargetToken(state, token);
}

function isAsmLabelDefinitionToken(state: FileState, token: Token): boolean {
  if (token.kind !== TokenKind.Identifier || !isAsmBodyToken(state, token)) {
    return false;
  }
  const next = nextAsmBodyTokenOnLine(state, token);
  return next?.kind === TokenKind.Colon;
}

function isAsmBranchTargetToken(state: FileState, token: Token): boolean {
  if (token.kind !== TokenKind.Identifier || !isAsmBodyToken(state, token) || isAsmLabelDefinitionToken(state, token)) {
    return false;
  }
  const previous = previousAsmBodyTokenOnLine(state, token);
  return previous?.kind === TokenKind.Identifier && isAsmBranchMnemonic(previous.value);
}

function isAsmInstructionToken(state: FileState, token: Token): boolean {
  if (token.kind !== TokenKind.Identifier || !isAsmBodyToken(state, token) || isAsmRegisterToken(state, token) || isAsmLabelToken(state, token)) {
    return false;
  }
  const previous = previousAsmBodyTokenOnLine(state, token);
  return !previous || previous.kind === TokenKind.Colon;
}

function isAsmBranchMnemonic(value: string): boolean {
  return /^(B|BL|BEQ|BNE|BLT|BGT|BLE|BGE|BMI|BPL|BCS|BCC|BHI|BLS)$/u.test(value);
}

function isAsmBodyToken(state: FileState, token: Token): boolean {
  const bounds = asmBodyBoundsForToken(state, token);
  return !!bounds && token.range.start.offset >= bounds.start && token.range.end.offset <= bounds.end;
}

function previousAsmBodyTokenOnLine(state: FileState, token: Token): Token | undefined {
  const bounds = asmBodyBoundsForToken(state, token);
  if (!bounds) {
    return undefined;
  }
  return state.parse.allTokens
    .filter((candidate) => candidate.kind !== TokenKind.Eof
      && candidate.kind !== TokenKind.Comment
      && candidate.range.start.offset >= bounds.start
      && candidate.range.end.offset <= bounds.end
      && candidate.range.end.offset <= token.range.start.offset
      && candidate.range.start.line === token.range.start.line)
    .at(-1);
}

function nextAsmBodyTokenOnLine(state: FileState, token: Token): Token | undefined {
  const bounds = asmBodyBoundsForToken(state, token);
  if (!bounds) {
    return undefined;
  }
  return state.parse.allTokens.find((candidate) => candidate.kind !== TokenKind.Eof
    && candidate.kind !== TokenKind.Comment
    && candidate.range.start.offset >= bounds.start
    && candidate.range.end.offset <= bounds.end
    && candidate.range.start.offset >= token.range.end.offset
    && candidate.range.start.line === token.range.start.line);
}

function asmBodyBoundsForToken(state: FileState, token: Token): { start: number; end: number } | undefined {
  const block = allNodes(state.parse.program)
    .find((node): node is AsmBlockNode => node.kind === "AsmBlock" && containsOffset(node.range, token.range.start.offset));
  if (!block) {
    return undefined;
  }
  const blockTokens = state.parse.allTokens.filter((candidate) => candidate.range.start.offset >= block.range.start.offset && candidate.range.end.offset <= block.range.end.offset);
  const open = blockTokens.find((candidate) => candidate.kind === TokenKind.LBrace);
  const close = [...blockTokens].reverse().find((candidate) => candidate.kind === TokenKind.RBrace);
  return open && close && open.range.end.offset <= close.range.start.offset
    ? { start: open.range.end.offset, end: close.range.start.offset }
    : undefined;
}

function isTagNameToken(state: FileState, token: Token): boolean {
  const knownTag = TAG_NAMES.includes(token.value as (typeof TAG_NAMES)[number])
    || ASM_TAG_NAMES.includes(token.value as (typeof ASM_TAG_NAMES)[number]);
  if (!knownTag) {
    return false;
  }
  return allNodes(state.parse.program).some((node) => {
    if (node.kind === "VarDecl") {
      return (node as VarDeclNode).tagRanges.some((range) => containsOffset(range, token.range.start.offset));
    }
    if (node.kind === "AsmBinding") {
      return (node as AsmBindingNode).tagRanges.some((range) => containsOffset(range, token.range.start.offset));
    }
    return false;
  });
}

function callHierarchyItem(symbol: VelaSymbol): CallHierarchyItem {
  return {
    name: symbol.name,
    kind: lspSymbolKind(symbol.kind),
    detail: symbol.className ?? symbol.moduleName ?? "",
    uri: symbol.uri,
    range: lspRange(symbol.range),
    selectionRange: lspRange(symbol.selectionRange),
    data: symbol.id,
  };
}

function typeHierarchyItem(symbol: VelaSymbol): TypeHierarchyItem {
  return {
    name: symbol.name,
    kind: lspSymbolKind(symbol.kind),
    detail: symbol.moduleName ?? "",
    uri: symbol.uri,
    range: lspRange(symbol.range),
    selectionRange: lspRange(symbol.selectionRange),
    data: symbol.id,
  };
}

function prefixOperatorOffsets(nodes: BaseNode[]): Set<number> {
  return new Set(nodes
    .filter((node): node is UnaryExprNode | DerefExprNode | AddressOfExprNode => ["UnaryExpr", "DerefExpr", "AddressOfExpr"].includes(node.kind))
    .filter((node) => !(node.kind === "UnaryExpr" && node.op.startsWith("post")))
    .map((node) => node.operatorRange.start.offset));
}

function formatTokens(text: string, tokens: Token[], preservedRanges: VelaRange[] = [], prefixOperators = new Set<number>()): string {
  let result = "";
  let indent = 0;
  let parenDepth = 0;
  let angleDepth = 0;
  let forHeaderDepth: number | undefined;
  let lineStart = true;
  let previous: Token | undefined;
  const filteredTokens = tokens.filter((item) => item.kind !== TokenKind.Eof);
  const preservedByStart = new Map(preservedRanges.map((range) => [range.start.offset, range]));
  const write = (text: string) => {
    if (lineStart && text.trim()) {
      result += " ".repeat(indent * 4);
      lineStart = false;
    }
    result += text;
  };
  const trimRight = () => {
    result = result.replace(/[ \t]+$/u, "");
  };
  const newline = () => {
    trimRight();
    if (!result.endsWith("\n")) {
      result += "\n";
    }
    lineStart = true;
  };
  for (let index = 0; index < filteredTokens.length; index++) {
    const token = filteredTokens[index]!;
    const preserved = preservedByStart.get(token.range.start.offset);
    if (preserved) {
      if (!lineStart) {
        newline();
      }
      write(text.slice(preserved.start.offset, preserved.end.offset));
      while (index + 1 < filteredTokens.length && filteredTokens[index + 1]!.range.start.offset < preserved.end.offset) {
        index++;
      }
      previous = filteredTokens[index];
      newline();
      continue;
    }
    if (previous?.kind === TokenKind.RBrace && token.kind !== TokenKind.KwElse && !lineStart) {
      newline();
    }
    if (token.kind === TokenKind.Comment) {
      const trailing = previous && previous.range.end.line === token.range.start.line && !lineStart;
      if (!trailing) {
        newline();
      } else if (!result.endsWith(" ")) {
        write(" ");
      }
      write(token.lexeme);
      newline();
      previous = token;
      continue;
    }
    if (token.kind === TokenKind.RBrace) {
      newline();
      indent = Math.max(0, indent - 1);
      write("}");
      previous = token;
      continue;
    }
    if (token.kind === TokenKind.LBrace) {
      if (!lineStart && !result.endsWith(" ")) write(" ");
      write("{");
      indent += 1;
      newline();
      previous = token;
      continue;
    }
    if (token.kind === TokenKind.Semicolon) {
      trimRight();
      write(";");
      if (forHeaderDepth !== undefined && parenDepth === forHeaderDepth) {
        write(" ");
        previous = token;
        continue;
      }
      const next = filteredTokens[index + 1];
      if (!(next?.kind === TokenKind.Comment && next.range.start.line === token.range.end.line)) {
        newline();
      }
      previous = token;
      continue;
    }
    if (token.kind === TokenKind.Comma) {
      trimRight();
      write(", ");
      previous = token;
      continue;
    }
    if (token.kind === TokenKind.TagClose) {
      trimRight();
      write(token.lexeme);
      previous = token;
      continue;
    }
    if (token.kind === TokenKind.Lt && previous && isGenericAngleStart(previous)) {
      trimRight();
      write("<");
      angleDepth += 1;
      previous = token;
      continue;
    }
    if (token.kind === TokenKind.Gt && angleDepth > 0) {
      trimRight();
      write(">");
      angleDepth = Math.max(0, angleDepth - 1);
      previous = token;
      continue;
    }
    if (token.kind === TokenKind.Dot || token.kind === TokenKind.DoubleColon) {
      trimRight();
      write(token.lexeme);
      previous = token;
      continue;
    }
    if (token.kind === TokenKind.LParen || token.kind === TokenKind.LBracket) {
      if (previous && [TokenKind.KwIf, TokenKind.KwFor, TokenKind.KwWhile, TokenKind.KwAsm].includes(previous.kind)) {
        if (!result.endsWith(" ")) write(" ");
      } else {
        trimRight();
      }
      write(token.lexeme);
      if (token.kind === TokenKind.LParen) {
        parenDepth += 1;
        if (previous?.kind === TokenKind.KwFor) {
          forHeaderDepth = parenDepth;
        }
      }
      previous = token;
      continue;
    }
    if (token.kind === TokenKind.RParen || token.kind === TokenKind.RBracket) {
      trimRight();
      write(token.lexeme);
      if (token.kind === TokenKind.RParen) {
        if (forHeaderDepth === parenDepth) {
          forHeaderDepth = undefined;
        }
        parenDepth = Math.max(0, parenDepth - 1);
      }
      previous = token;
      continue;
    }
    if (token.kind === TokenKind.PlusPlus || token.kind === TokenKind.MinusMinus) {
      trimRight();
      write(token.lexeme);
      previous = token;
      continue;
    }
    if (prefixOperators.has(token.range.start.offset)) {
      if (!lineStart && !result.endsWith(" ") && previous && ![TokenKind.LParen, TokenKind.LBracket, TokenKind.TagOpen, TokenKind.Lt].includes(previous.kind) && !prefixOperators.has(previous.range.start.offset)) {
        write(" ");
      }
      write(token.lexeme);
      previous = token;
      continue;
    }
    if ([TokenKind.Assign, TokenKind.PlusEq, TokenKind.MinusEq, TokenKind.StarEq, TokenKind.SlashEq, TokenKind.Arrow, TokenKind.Eq, TokenKind.Neq, TokenKind.Lt, TokenKind.Gt, TokenKind.Lte, TokenKind.Gte, TokenKind.And, TokenKind.Or, TokenKind.Plus, TokenKind.Minus, TokenKind.Star, TokenKind.Slash, TokenKind.Percent].includes(token.kind)) {
      trimRight();
      write(` ${token.lexeme} `);
      previous = token;
      continue;
    }
    if (token.kind === TokenKind.Colon) {
      trimRight();
      write(": ");
      previous = token;
      continue;
    }
    if (!lineStart && !result.endsWith(" ") && previous && ![TokenKind.Dot, TokenKind.DoubleColon, TokenKind.LParen, TokenKind.LBracket, TokenKind.TagOpen, TokenKind.Lt].includes(previous.kind) && !prefixOperators.has(previous.range.start.offset)) {
      write(" ");
    }
    write(token.lexeme);
    previous = token;
  }
  return result.trimEnd() + "\n";
}

function isGenericAngleStart(token: Token): boolean {
  return token.kind === TokenKind.TyPtr || token.kind === TokenKind.BiInit || token.kind === TokenKind.BiCast;
}

function organizeImportsAction(state: FileState): CodeAction | undefined {
  const edits: TextEdit[] = [];
  for (const module of state.parse.program.modules) {
    const imports = module.imports;
    if (imports.length === 0) {
      continue;
    }
    const normalized = imports.map(sortImportModules);
    const sorted = [...normalized].sort((a, b) => formatImportStatement(a, "").localeCompare(formatImportStatement(b, "")));
    if (imports.map((imp) => formatImportStatement(imp, "")).join("\n") === sorted.map((imp) => formatImportStatement(imp, "")).join("\n")) {
      continue;
    }
    edits.push(...sorted.map((imp, index) => TextEdit.replace(lspRange(imports[index]!.range), formatImportStatement(imp, ""))));
  }
  return edits.length > 0 ? CodeAction.create("Sort imports", { changes: { [state.uri]: edits } }, CodeActionKind.SourceOrganizeImports) : undefined;
}

function sortImportModules(imp: ImportDeclNode): ImportDeclNode {
  return imp.wildcard || imp.modules.includes("*")
    ? imp
    : { ...imp, modules: [...imp.modules].sort((a, b) => a.localeCompare(b)) };
}

function importRefactorActions(index: WorkspaceIndex, state: FileState): CodeAction[] {
  const actions: CodeAction[] = [];
  for (const imp of state.parse.program.modules.flatMap((module) => module.imports)) {
    const modules = wildcardModuleNames(index, imp);
    if (modules.length === 0) {
      continue;
    }
    if (imp.wildcard || imp.modules.includes("*")) {
      const expanded = { ...imp, modules, wildcard: false };
      actions.push(CodeAction.create(
        `Expand wildcard import ${imp.package.join("::")}::{*}`,
        { changes: { [state.uri]: [TextEdit.replace(lspRange(imp.range), formatImportStatement(expanded, ""))] } },
        CodeActionKind.RefactorRewrite,
      ));
      continue;
    }
    if (sameStringSet(imp.modules, modules)) {
      const wildcard = { ...imp, modules: ["*"], wildcard: true };
      actions.push(CodeAction.create(
        `Convert import list to wildcard ${imp.package.join("::")}::{*}`,
        { changes: { [state.uri]: [TextEdit.replace(lspRange(imp.range), formatImportStatement(wildcard, ""))] } },
        CodeActionKind.RefactorRewrite,
      ));
    }
  }
  return actions;
}

function wildcardModuleNames(index: WorkspaceIndex, imp: ImportDeclNode): string[] {
  const wildcard = { ...imp, modules: ["*"], wildcard: true };
  const names = new Set<string>();
  for (const state of index.filesForImport(wildcard)) {
    const name = moduleFileName(state.path);
    if (name) {
      names.add(name);
    }
  }
  return [...names].sort();
}

function moduleFileName(path: string): string | undefined {
  const file = path.replace(/\\/g, "/").split("/").at(-1);
  return file?.endsWith(".vl") ? file.slice(0, -3) : undefined;
}

function importRenameEditsForState(
  state: FileState,
  oldImport: { package: string[]; moduleName: string },
  newImport: { package: string[]; moduleName: string },
): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const imp of state.parse.program.modules.flatMap((module) => module.imports)) {
    if (imp.wildcard || imp.modules.includes("*") || !sameStringArray(imp.package, oldImport.package)) {
      continue;
    }
    const moduleIndex = imp.modules.indexOf(oldImport.moduleName);
    if (moduleIndex < 0) {
      continue;
    }
    if (sameStringArray(oldImport.package, newImport.package)) {
      const range = imp.moduleRanges[moduleIndex];
      if (range) {
        edits.push(TextEdit.replace(lspRange(range), newImport.moduleName));
      }
      continue;
    }
    const newImportDecl = importDeclForPath(newImport, imp.range);
    if (imp.modules.length === 1) {
      const addEdit = mergeImportEdit(state, newImportDecl, moduleAtOffset(state, imp.range.start.offset));
      if (addEdit) {
        edits.push(TextEdit.replace(lspRange(importLineRange(state, imp)), ""));
        edits.push(addEdit);
      } else {
        edits.push(TextEdit.replace(lspRange(imp.range), formatImportStatement(newImportDecl, "")));
      }
      continue;
    }
    edits.push(removeImportModuleEdit(state, imp, moduleIndex));
    const addEdit = importEditIfMissing(state, newImportDecl, moduleAtOffset(state, imp.range.start.offset));
    if (addEdit) {
      edits.push(addEdit);
    }
  }
  return edits;
}

function moduleDeclarationRenameEditsForState(state: FileState, oldModuleName: string, newModuleName: string): TextEdit[] {
  if (!validModuleName(newModuleName)) {
    return [];
  }
  return state.parse.program.modules
    .filter((module) => module.name === oldModuleName)
    .map((module) => TextEdit.replace(lspRange(module.nameRange), newModuleName));
}

function importDeleteEditsForState(state: FileState, deletedImports: { package: string[]; moduleName: string }[]): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const imp of state.parse.program.modules.flatMap((module) => module.imports)) {
    if (imp.wildcard || imp.modules.includes("*")) {
      continue;
    }
    const deletedNames = new Set(deletedImports
      .filter((deleted) => sameStringArray(deleted.package, imp.package))
      .map((deleted) => deleted.moduleName));
    if (deletedNames.size === 0) {
      continue;
    }
    const remaining = imp.modules.filter((moduleName) => !deletedNames.has(moduleName));
    if (remaining.length === imp.modules.length) {
      continue;
    }
    if (remaining.length === 0) {
      edits.push(TextEdit.replace(lspRange(importLineRange(state, imp)), ""));
    } else {
      edits.push(TextEdit.replace(lspRange(imp.range), formatImportStatement({ ...imp, modules: remaining, wildcard: false }, "")));
    }
  }
  return edits;
}

function importDeclForPath(importPath: { package: string[]; moduleName: string }, range: VelaRange): ImportDeclNode {
  return {
    kind: "ImportDecl",
    package: importPath.package,
    packageRanges: [],
    modules: [importPath.moduleName],
    moduleRanges: [],
    wildcard: false,
    range,
  };
}

function sameStringSet(left: string[], right: string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((item, index) => item === normalizedRight[index]);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function unusedImportActions(index: WorkspaceIndex, state: FileState): CodeAction[] {
  const actions: CodeAction[] = [];
  for (const module of state.parse.program.modules) {
    const usedSymbolIds = new Set(state.analysis.references
      .filter((ref) => ref.uri === state.uri && containsOffset(module.range, ref.range.start.offset))
      .map((ref) => ref.symbolId));
    for (const imp of module.imports) {
      if (imp.wildcard || imp.modules.includes("*")) {
        const targets = index.filesForImport(imp);
        if (targets.length === 0) {
          continue;
        }
        const exportedIds = targets.flatMap((target) => importedExportSymbols(state, target.uri).map((symbol) => symbol.id));
        const used = exportedIds.some((id) => usedSymbolIds.has(id));
        if (!used) {
          actions.push(CodeAction.create(
            `Remove unused import ${imp.package.join("::")}::{*}`,
            { changes: { [state.uri]: [TextEdit.replace(lspRange(importLineRange(state, imp)), "")] } },
            CodeActionKind.SourceOrganizeImports,
          ));
        }
        continue;
      }
      for (let i = 0; i < imp.modules.length; i++) {
        const moduleName = imp.modules[i];
        if (!moduleName) {
          continue;
        }
        const target = index.moduleForImport(imp, moduleName);
        if (!target) {
          continue;
        }
        const exportedIds = importedExportSymbols(state, target.uri).map((symbol) => symbol.id);
        const used = exportedIds.some((id) => usedSymbolIds.has(id));
        if (!used) {
          actions.push(CodeAction.create(
            `Remove unused import '${moduleName}'`,
            { changes: { [state.uri]: [removeImportModuleEdit(state, imp, i)] } },
            CodeActionKind.SourceOrganizeImports,
          ));
        }
      }
    }
  }
  return actions;
}

function importedExportSymbols(state: FileState, targetUri: string): VelaSymbol[] {
  return state.analysis.symbols.filter((symbol) => symbol.uri === targetUri && ["alias", "class", "type", "function", "global"].includes(symbol.kind));
}

function removeImportModuleEdit(state: FileState, imp: ImportDeclNode, moduleIndex: number): TextEdit {
  if (imp.modules.length <= 1) {
    return TextEdit.replace(lspRange(importLineRange(state, imp)), "");
  }
  const current = imp.moduleRanges[moduleIndex];
  if (!current) {
    return TextEdit.replace(lspRange(imp.range), formatImportStatement(imp, ""));
  }
  if (moduleIndex < imp.modules.length - 1) {
    const next = imp.moduleRanges[moduleIndex + 1];
    const end = next?.start.offset ?? current.end.offset;
    return TextEdit.replace(lspRange(rangeBetween(state.text, state.uri, current.start.offset, end)), "");
  }
  const previous = imp.moduleRanges[moduleIndex - 1];
  const start = previous?.end.offset ?? current.start.offset;
  return TextEdit.replace(lspRange(rangeBetween(state.text, state.uri, start, current.end.offset)), "");
}

function importLineRange(state: FileState, imp: ImportDeclNode): VelaRange {
  const start = lineStartOffset(state.text, imp.range.start.offset);
  let end = imp.range.end.offset;
  if (state.text.slice(end, end + 2) === "\r\n") {
    end += 2;
  } else if (state.text[end] === "\n") {
    end += 1;
  }
  return rangeBetween(state.text, state.uri, start, end);
}

function lineStartOffset(text: string, offset: number): number {
  return text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

function overrideMethodActions(index: WorkspaceIndex, state: FileState): CodeAction[] {
  const actions: CodeAction[] = [];
  for (const cls of state.parse.program.modules.flatMap((module) => module.body).filter((node): node is ClassDeclNode => node.kind === "ClassDecl" && !!node.parent)) {
    const parent = visibleTopLevelSymbolByName(index, state, moduleAtOffset(state, cls.nameRange.start.offset), cls.parent!, new Set(["class"]));
    if (!parent) {
      continue;
    }
    const missing = missingOverrideMethods(index, cls, parent);
    if (missing.length === 0) {
      continue;
    }
    const edit = TextEdit.insert(classBodyInsertPosition(state, cls), missing.map((method) => methodStubTextFromSymbol(state, cls, method)).join(""));
    actions.push(CodeAction.create(`Generate overrides for class '${cls.name}'`, { changes: { [state.uri]: [edit] } }, CodeActionKind.RefactorRewrite));
  }
  return actions;
}

function missingOverrideMethods(index: WorkspaceIndex, cls: ClassDeclNode, parent: VelaSymbol): VelaSymbol[] {
  const implemented = new Set([
    ...cls.methods.map((method) => method.name),
    ...(cls.onAlloc ? [cls.onAlloc.name] : []),
    ...(cls.onFree ? [cls.onFree.name] : []),
  ]);
  return methodSymbolsForClassSymbol(index, parent)
    .filter((method) => !implemented.has(method.name) && method.name !== "OnAlloc" && method.name !== "OnFree");
}

function fieldTagActions(state: FileState): CodeAction[] {
  const actions: CodeAction[] = [];
  for (const cls of state.parse.program.modules.flatMap((module) => module.body).filter((node): node is ClassDeclNode => node.kind === "ClassDecl")) {
    for (const field of cls.fields) {
      const missing = ["get", "set"].filter((tag) => !field.tags.includes(tag));
      if (missing.length === 0) {
        continue;
      }
      actions.push(CodeAction.create(
        `Generate get/set tags for field '${field.name}'`,
        { changes: { [state.uri]: [fieldTagEdit(state, field, missing)] } },
        CodeActionKind.RefactorRewrite,
      ));
    }
  }
  return actions;
}

function fieldTagEdit(state: FileState, field: VarDeclNode, missing: string[]): TextEdit {
  if (field.tagRanges.length === 0) {
    return TextEdit.insert(lspRange(field.range).start, `[[${missing.join(", ")}]] `);
  }
  const tags = [...field.tags, ...missing];
  const first = field.tagRanges[0]!;
  const last = field.tagRanges.at(-1)!;
  return TextEdit.replace(lspRange(rangeBetween(state.text, state.uri, first.start.offset, last.end.offset)), tags.join(", "));
}

function renameConflictingDeclarationAction(index: WorkspaceIndex, state: FileState, diagnostic: Diagnostic): CodeAction | undefined {
  const code = String(diagnostic.code ?? "");
  if (!["vela.sem.reservedName", "vela.sem.duplicateTopLevel", "vela.sem.includedTopLevelCollision", "vela.sem.flatAssemblyCollision"].includes(code)) {
    return undefined;
  }
  const oldName = textForRange(state.text, diagnostic.range).trim();
  const base = suggestedDeclarationName(oldName);
  const symbol = index.findSymbolAt(state.uri, diagnostic.range.start);
  if (!symbol || symbol.generated || symbol.defaultLibrary || symbol.kind === "builtin") {
    return renameConflictingRangeAction(state, diagnostic, oldName, base);
  }
  if (symbol.kind === "module" && symbol.name !== oldName) {
    return renameConflictingRangeAction(state, diagnostic, oldName, base);
  }
  const newName = uniqueRenameCandidate(index, symbol, base);
  if (!newName) {
    return undefined;
  }
  const edit = rename(index, { textDocument: { uri: state.uri }, position: diagnostic.range.start, newName });
  if (!edit.changes || Object.keys(edit.changes).length === 0) {
    return undefined;
  }
  const action = CodeAction.create(`Rename '${oldName}' to '${newName}'`, edit, CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  return action;
}

function renameConflictingRangeAction(state: FileState, diagnostic: Diagnostic, oldName: string, base: string): CodeAction | undefined {
  const newName = uniqueRangeRenameCandidate(state, oldName, base);
  if (!newName) {
    return undefined;
  }
  const action = CodeAction.create(`Rename '${oldName}' to '${newName}'`, { changes: { [state.uri]: [TextEdit.replace(diagnostic.range, newName)] } }, CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  return action;
}

function suggestedDeclarationName(oldName: string): string {
  let candidate = oldName.replace(/^_+/, "").replace(/[^A-Za-z0-9_]/g, "");
  if (!candidate) {
    candidate = "renamed";
  }
  if (!/^[A-Za-z_]/.test(candidate)) {
    candidate = `renamed${candidate}`;
  }
  if (candidate === "main" || candidate === "space" || candidate.startsWith("__") || !validIdentifier(candidate)) {
    candidate = `${candidate.replace(/^_+/, "") || "renamed"}Value`;
  }
  return candidate;
}

function uniqueRangeRenameCandidate(state: FileState, oldName: string, base: string): string | undefined {
  let candidate = base;
  for (let suffix = 2; suffix < 100; suffix++) {
    if (candidate !== oldName && validIdentifier(candidate) && !topLevelNameTaken(state, candidate) && candidate !== "space" && !candidate.startsWith("__")) {
      return candidate;
    }
    candidate = `${base}${suffix}`;
  }
  return undefined;
}

function topLevelNameTaken(state: FileState, name: string): boolean {
  return state.analysis.symbols.some((symbol) => symbol.uri === state.uri && isTopLevelSymbol(symbol) && symbol.name === name);
}

function uniqueRenameCandidate(index: WorkspaceIndex, symbol: VelaSymbol, base: string): string | undefined {
  let candidate = base;
  for (let suffix = 2; suffix < 100; suffix++) {
    if (candidate !== symbol.name && validIdentifier(candidate) && canRenameTo(index, symbol, candidate)) {
      return candidate;
    }
    candidate = `${base}${suffix}`;
  }
  return undefined;
}

function missingImportActions(index: WorkspaceIndex, state: FileState, name: string, diagnostic: Diagnostic): CodeAction[] {
  const candidates = [
    ...index.workspaceImportsForSymbol(name, state.uri),
    ...[index.stdlibImportForSymbol(name)].filter((item): item is ImportDeclNode => !!item),
  ];
  const seen = new Set<string>();
  const actions: CodeAction[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.package.join("::")}::{${candidate.modules.join(", ")}}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const action = addImportAction(state, name, candidate, diagnostic);
    if (action) {
      actions.push(action);
    }
  }
  return actions;
}

function addImportAction(state: FileState, name: string, imp: ImportDeclNode, diagnostic: Diagnostic): CodeAction | undefined {
  const edit = importEditIfMissing(state, imp, moduleForRange(state, diagnostic.range));
  if (!edit) {
    return undefined;
  }
  const action = CodeAction.create(`Import '${name}' from ${imp.package.join("::")}::{${imp.modules.join(", ")}}`, { changes: { [state.uri]: [edit] } }, CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  return action;
}

function removePrintFormatAction(state: FileState, diagnostic: Diagnostic): CodeAction | undefined {
  const offset = lspPositionToOffset(state.text, diagnostic.range.start);
  const print = allNodes(state.parse.program)
    .filter((node): node is PrintStmtNode => node.kind === "PrintStmt")
    .find((node) => !!node.fmt && containsOffset(node.fmt.range, offset));
  if (!print?.fmt) {
    return undefined;
  }
  const comma = state.parse.allTokens
    .filter((token) => token.kind === TokenKind.Comma && token.range.start.offset >= print.value.range.end.offset && token.range.start.offset < print.fmt!.range.start.offset)
    .at(-1);
  const range = comma ? rangeBetween(state.text, state.uri, comma.range.start.offset, print.fmt.range.end.offset) : print.fmt.range;
  const action = CodeAction.create("Remove unsupported Print format argument", { changes: { [state.uri]: [TextEdit.replace(lspRange(range), "")] } }, CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  return action;
}

function fixInitArgumentActions(index: WorkspaceIndex, state: FileState, diagnostic: Diagnostic): CodeAction[] {
  return [
    fixInitArgumentNameAction(state, diagnostic),
    reorderInitArgumentsAction(index, state, diagnostic),
  ].filter((action): action is CodeAction => !!action);
}

function fixInitArgumentNameAction(state: FileState, diagnostic: Diagnostic): CodeAction | undefined {
  const expected = /expected '([^']+)'/.exec(diagnosticMessage(diagnostic.message))?.[1];
  if (!expected) {
    return undefined;
  }
  const action = CodeAction.create(`Rename Init argument to '${expected}'`, { changes: { [state.uri]: [TextEdit.replace(diagnostic.range, expected)] } }, CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  return action;
}

function reorderInitArgumentsAction(index: WorkspaceIndex, state: FileState, diagnostic: Diagnostic): CodeAction | undefined {
  const offset = lspPositionToOffset(state.text, diagnostic.range.start);
  const init = innermostNodeAt<InitExprNode>(state.parse.program, offset, "InitExpr");
  if (!init || init.kwargs.length < 2) {
    return undefined;
  }
  const expectedNames = visibleOnAllocSymbolForInit(index, state, init)?.params?.map((param) => param.name) ?? [];
  if (expectedNames.length !== init.kwargs.length) {
    return undefined;
  }
  const actualNames = init.kwargs.map((arg) => arg.name);
  if (new Set(actualNames).size !== actualNames.length || new Set(expectedNames).size !== expectedNames.length) {
    return undefined;
  }
  if (!sameStringSet(actualNames, expectedNames) || sameStringArray(actualNames, expectedNames)) {
    return undefined;
  }
  const segments = new Map<string, string>();
  for (const arg of init.kwargs) {
    const segment = state.text.slice(arg.nameRange.start.offset, arg.value.range.end.offset);
    if (segment.includes("\n") || segment.includes("\r")) {
      return undefined;
    }
    segments.set(arg.name, segment);
  }
  if (expectedNames.some((name) => !segments.has(name))) {
    return undefined;
  }
  const replacement = expectedNames.map((name) => segments.get(name)).join(", ");
  const first = init.kwargs[0]!;
  const last = init.kwargs[init.kwargs.length - 1]!;
  const range = rangeBetween(state.text, state.uri, first.nameRange.start.offset, last.value.range.end.offset);
  const action = CodeAction.create(`Reorder Init<${init.className}> arguments to match OnAlloc`, { changes: { [state.uri]: [TextEdit.replace(lspRange(range), replacement)] } }, CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  return action;
}

function missingReturnActions(state: FileState, diagnostic: Diagnostic): CodeAction[] {
  const offset = lspPositionToOffset(state.text, diagnostic.range.start);
  const fn = functionAtOffset(state, offset);
  if (!fn || fn.isSkeleton || typeExprText(fn.returnType) === "U0") {
    return [];
  }
  const returnEdit = TextEdit.insert(functionBodyInsertPosition(state, fn), missingReturnText(state, fn));
  const addReturn = CodeAction.create("Add missing return statement", { changes: { [state.uri]: [returnEdit] } }, CodeActionKind.QuickFix);
  addReturn.diagnostics = [diagnostic];

  const changeReturn = CodeAction.create("Change return type to U0", { changes: { [state.uri]: [TextEdit.replace(lspRange(fn.returnType.range), "U0")] } }, CodeActionKind.QuickFix);
  changeReturn.diagnostics = [diagnostic];
  return [addReturn, changeReturn];
}

function castExpressionAction(state: FileState, diagnostic: Diagnostic): CodeAction | undefined {
  const code = String(diagnostic.code ?? "");
  if (code === "vela.sem.derefVoidPointer" || code === "vela.sem.indexVoidPointer") {
    return wrapWithCastAction(state, diagnostic, "Ptr<I16>", "Cast Ptr<U0> to Ptr<I16>");
  }
  const target = castTargetFromDiagnostic(diagnostic);
  if (!target) {
    return undefined;
  }
  return wrapWithCastAction(state, diagnostic, target, `Cast expression to ${target}`);
}

function integerConditionAction(state: FileState, diagnostic: Diagnostic): CodeAction | undefined {
  const message = diagnosticMessage(diagnostic.message);
  if (!/condition must be Bool/.test(message) || !/got [IU](8|16)\b/.test(message)) {
    return undefined;
  }
  const text = textForRange(state.text, diagnostic.range).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    return undefined;
  }
  const action = CodeAction.create("Compare integer condition with zero", { changes: { [state.uri]: [TextEdit.replace(diagnostic.range, `${text} != 0`)] } }, CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  return action;
}

function castTargetFromDiagnostic(diagnostic: Diagnostic): string | undefined {
  const message = diagnosticMessage(diagnostic.message).split(/\r?\n/)[0] ?? "";
  const code = String(diagnostic.code ?? "");
  let match: RegExpMatchArray | null = null;
  if (code === "vela.sem.incompatibleAssignment") {
    match = message.match(/^cannot assign (.+) to (.+)$/);
    return castTargetIfSupported(match?.[2], match?.[1]);
  }
  if (code === "vela.sem.incompatibleInitializer") {
    match = message.match(/^cannot initialise (.+) from (.+)$/);
    return castTargetIfSupported(match?.[1], match?.[2]);
  }
  if (code === "vela.sem.argumentType") {
    match = message.match(/^argument \d+ of .+ expects (.+), got (.+)$/);
    return castTargetIfSupported(match?.[1], match?.[2]);
  }
  if (code === "vela.sem.incompatibleReturn") {
    match = message.match(/^function '.+' returns (.+), got (.+)$/);
    return castTargetIfSupported(match?.[1], match?.[2]);
  }
  return undefined;
}

function castTargetIfSupported(target: string | undefined, source: string | undefined): string | undefined {
  const cleanTarget = target?.trim();
  const cleanSource = source?.trim();
  if (!cleanTarget || !cleanSource || cleanTarget === cleanSource) {
    return undefined;
  }
  if (cleanTarget === "Bool" || cleanSource === "Bool" || cleanTarget === "F16" || cleanSource === "F16") {
    return undefined;
  }
  return cleanTarget;
}

function wrapWithCastAction(state: FileState, diagnostic: Diagnostic, target: string, title: string): CodeAction | undefined {
  const expression = textForRange(state.text, diagnostic.range).trim();
  if (!expression || expression.startsWith("Cast<")) {
    return undefined;
  }
  const action = CodeAction.create(title, { changes: { [state.uri]: [TextEdit.replace(diagnostic.range, `Cast<${target}>(${expression})`)] } }, CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  return action;
}

function boxedPrimitiveMethodAction(index: WorkspaceIndex, state: FileState, diagnostic: Diagnostic): CodeAction | undefined {
  if (diagnostic.code !== "vela.sem.primitiveMethod") {
    return undefined;
  }
  const boxed = /boxed type '([^']+)'/.exec(diagnosticMessage(diagnostic.message))?.[1];
  if (!boxed) {
    return undefined;
  }
  const boxedClass = defaultLibraryClassSymbol(index, boxed);
  if (!boxedClass) {
    return undefined;
  }
  const offset = lspPositionToOffset(state.text, diagnostic.range.start);
  const methodCall = allNodes(state.parse.program)
    .filter((node): node is MethodCallExprNode => node.kind === "MethodCallExpr")
    .filter((node) => containsOffset(node.methodRange, offset))
    .sort((left, right) => (left.range.end.offset - left.range.start.offset) - (right.range.end.offset - right.range.start.offset))[0];
  if (!methodCall || !methodSymbolsForClassSymbol(index, boxedClass).some((method) => method.name === methodCall.method)) {
    return undefined;
  }
  const onAlloc = methodSymbolsForClassSymbol(index, boxedClass).find((symbol) => symbol.name === "OnAlloc");
  const firstParam = onAlloc?.params?.[0]?.name;
  if (!firstParam) {
    return undefined;
  }
  const receiver = textForRange(state.text, lspRange(methodCall.obj.range)).trim();
  if (!receiver) {
    return undefined;
  }
  const edits = [TextEdit.replace(lspRange(methodCall.obj.range), `Init<${boxed}>(${firstParam}: ${receiver})`)];
  const importDecl = index.stdlibImportForSymbol(boxed);
  const importEdit = importDecl ? importEditIfMissing(state, importDecl, moduleForRange(state, diagnostic.range)) : undefined;
  if (importEdit) {
    edits.unshift(importEdit);
  }
  const action = CodeAction.create(`Box primitive receiver as ${boxed}`, { changes: { [state.uri]: edits } }, CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  return action;
}

function defaultLibraryClassSymbol(index: WorkspaceIndex, className: string): VelaSymbol | undefined {
  return index.allSymbols().find((symbol) => symbol.kind === "class" && symbol.defaultLibrary && symbol.name === className);
}

function functionAtOffset(state: FileState, offset: number): FunctionDeclNode | undefined {
  return allNodes(state.parse.program)
    .filter((node): node is FunctionDeclNode => node.kind === "FunctionDecl" && containsOffset(node.range, offset))
    .sort((left, right) => (left.range.end.offset - left.range.start.offset) - (right.range.end.offset - right.range.start.offset))[0];
}

function functionBodyInsertPosition(state: FileState, fn: FunctionDeclNode): { line: number; character: number } {
  const line = Math.max(0, fn.range.end.line - 1);
  return { line, character: 0 };
}

function missingReturnText(state: FileState, fn: FunctionDeclNode): string {
  const insert = functionBodyInsertPosition(state, fn);
  const lines = state.text.split(/\r?\n/);
  const closingIndent = (lines[insert.line] ?? "").match(/^\s*/)?.[0] ?? "    ";
  return `${closingIndent}    ${defaultReturnStatement(fn.returnType)}\n`;
}

function implementSkeletonAction(index: WorkspaceIndex, state: FileState, diagnostic: Diagnostic): CodeAction | undefined {
  const match = /class '([^']+)' must implement skeleton method '([^']+)' from type '([^']+)'/.exec(diagnosticMessage(diagnostic.message));
  if (!match) {
    return undefined;
  }
  const className = match[1]!;
  const methodName = match[2]!;
  const typeName = match[3]!;
  const cls = state.parse.program.modules.flatMap((module) => module.body).find((node): node is ClassDeclNode => node.kind === "ClassDecl" && node.name === className);
  const typeSymbol = visibleTopLevelSymbolByName(index, state, cls ? moduleAtOffset(state, cls.nameRange.start.offset) : moduleForRange(state, diagnostic.range), typeName, new Set(["type"]));
  const skeleton = typeSymbol?.decl?.kind === "TypeDecl" ? typeSymbol.decl.methods.find((method) => method.name === methodName) : undefined;
  if (!cls || !skeleton) {
    return undefined;
  }
  const insert = classBodyInsertPosition(state, cls);
  const edit = TextEdit.insert(insert, skeletonStubText(state, cls, skeleton));
  const action = CodeAction.create(`Implement skeleton method '${methodName}'`, { changes: { [state.uri]: [edit] } }, CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  return action;
}

function rangeBetween(text: string, uri: string, startOffset: number, endOffset: number): VelaRange {
  return {
    uri,
    start: offsetToVelaPosition(text, startOffset),
    end: offsetToVelaPosition(text, endOffset),
  };
}

function classBodyInsertPosition(state: FileState, cls: ClassDeclNode): { line: number; character: number } {
  const line = Math.max(0, cls.range.end.line - 1);
  return { line, character: 0 };
}

function skeletonStubText(state: FileState, cls: ClassDeclNode, skeleton: FunctionDeclNode): string {
  const insert = classBodyInsertPosition(state, cls);
  const lines = state.text.split(/\r?\n/);
  const closingIndent = (lines[insert.line] ?? "").match(/^\s*/)?.[0] ?? "    ";
  const memberIndent = `${closingIndent}    `;
  const bodyIndent = `${memberIndent}    `;
  const params = skeleton.params.map((param) => `${typeExprText(param.typeExpr)} ${param.name}`).join(", ");
  return [
    `${memberIndent}${typeExprText(skeleton.returnType)} ${skeleton.name}(${params}) {`,
    `${bodyIndent}${defaultReturnStatement(skeleton.returnType)}`,
    `${memberIndent}}`,
    "",
  ].join("\n");
}

function methodSignatureFromDecl(method: FunctionDeclNode): string {
  const params = method.params.map((param) => `${typeExprText(param.typeExpr)} ${param.name}`).join(", ");
  return `${typeExprText(method.returnType)} ${method.name}(${params})`;
}

function methodSnippetFromDecl(method: FunctionDeclNode): string {
  return `${methodSignatureFromDecl(method)} {\n    ${defaultReturnStatement(method.returnType)}\n}`;
}

function methodSnippetFromSymbol(method: VelaSymbol): string {
  const returnType = typeToString(method.returnType ?? method.type);
  const params = method.params?.map((param) => `${typeToString(param.type)} ${param.name}`).join(", ") ?? "";
  return `${returnType} ${method.name}(${params}) {\n    ${defaultReturnStatementForTypeText(returnType)}\n}`;
}

function methodStubTextFromSymbol(state: FileState, cls: ClassDeclNode, method: VelaSymbol): string {
  const insert = classBodyInsertPosition(state, cls);
  const lines = state.text.split(/\r?\n/);
  const closingIndent = (lines[insert.line] ?? "").match(/^\s*/)?.[0] ?? "    ";
  const memberIndent = `${closingIndent}    `;
  const bodyIndent = `${memberIndent}    `;
  const returnType = typeToString(method.returnType ?? method.type);
  const params = method.params?.map((param) => `${typeToString(param.type)} ${param.name}`).join(", ") ?? "";
  return [
    `${memberIndent}${returnType} ${method.name}(${params}) {`,
    `${bodyIndent}${defaultReturnStatementForTypeText(returnType)}`,
    `${memberIndent}}`,
    "",
  ].join("\n");
}

function typeExprText(typeExpr: TypeExprNode): string {
  if (typeExpr.kind === "NamedType") {
    return typeExpr.name;
  }
  if (typeExpr.kind === "PtrType") {
    return `Ptr<${typeExprText(typeExpr.inner)}>`;
  }
  return "I16";
}

function defaultReturnStatement(typeExpr: TypeExprNode): string {
  const text = typeExprText(typeExpr);
  if (text === "U0") {
    return "ret;";
  }
  if (text.startsWith("Ptr<")) {
    return "ret null;";
  }
  if (text === "F16") {
    return "ret 0.0;";
  }
  return "ret 0;";
}

function defaultReturnStatementForTypeText(typeName: string): string {
  if (typeName === "U0") {
    return "ret;";
  }
  if (typeName.startsWith("Ptr<")) {
    return "ret null;";
  }
  if (typeName === "F16") {
    return "ret 0.0;";
  }
  return "ret 0;";
}

function createFunctionAction(state: FileState, name: string, range: Range, diagnostic: Diagnostic): CodeAction {
  const insert = moduleForRange(state, range)?.range.end ?? state.parse.program.modules[0]?.range.end ?? state.parse.program.range.end;
  const params = missingFunctionParams(state, name, range);
  const action = CodeAction.create(`Create function '${name}'`, { changes: { [state.uri]: [TextEdit.insert({ line: Math.max(0, insert.line - 2), character: 0 }, `\n    I16 ${name}(${params}) {\n        ret 0;\n    }\n`)] } }, CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  return action;
}

function missingFunctionParams(state: FileState, name: string, range: Range): string {
  const offset = lspPositionToOffset(state.text, range.start);
  const call = innermostNodeAt<CallExprNode>(state.parse.program, offset, "CallExpr");
  if (!call || call.callee.kind !== "IdentifierExpr" || call.callee.name !== name) {
    return "";
  }
  return call.args.map((arg, index) => `${parameterTypeText(arg.inferredType)} arg${index + 1}`).join(", ");
}

function parameterTypeText(type: VelaType | undefined): string {
  if (!type || type.kind === "unknown" || type.kind === "void") {
    return "I16";
  }
  return type.kind === "bool" ? "I8" : typeToString(type);
}

function createAliasAction(state: FileState, name: string, diagnostic: Diagnostic): CodeAction {
  const action = CodeAction.create(`Create alias '${name}'`, { changes: { [state.uri]: [TextEdit.insert(topLevelInsertPosition(state, moduleForRange(state, diagnostic.range)), `    alias ${name} <- I16;\n\n`)] } }, CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  return action;
}

function createClassAction(state: FileState, name: string, diagnostic: Diagnostic): CodeAction {
  const action = CodeAction.create(`Create class '${name}'`, { changes: { [state.uri]: [TextEdit.insert(topLevelInsertPosition(state, moduleForRange(state, diagnostic.range)), `    class ${name} {\n    }\n\n`)] } }, CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  return action;
}

function createTypeAction(state: FileState, name: string, diagnostic: Diagnostic): CodeAction {
  const action = CodeAction.create(`Create type '${name}'`, { changes: { [state.uri]: [TextEdit.insert(topLevelInsertPosition(state, moduleForRange(state, diagnostic.range)), `    type ${name} {\n    }\n\n`)] } }, CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  return action;
}

function topLevelInsertPosition(state: FileState, module = state.parse.program.modules[0]): { line: number; character: number } {
  if (!module) {
    return { line: 0, character: 0 };
  }
  const lastImport = module.imports.at(-1);
  if (lastImport) {
    return { line: lastImport.range.end.line, character: 0 };
  }
  return { line: module.nameRange.end.line, character: 0 };
}

function importInsertPosition(state: FileState, module = state.parse.program.modules[0]): { line: number; character: number } {
  return topLevelInsertPosition(state, module);
}

function importEditIfMissing(state: FileState, imp: ImportDeclNode, module = state.parse.program.modules[0]): TextEdit | undefined {
  return hasCoveringImport(module, imp)
    ? undefined
    : mergeImportEdit(state, imp, module) ?? TextEdit.insert(importInsertPosition(state, module), `${formatImportStatement(imp)}\n`);
}

function hasCoveringImport(module: ModuleDeclNode | undefined, requested: ImportDeclNode): boolean {
  return !!module
    && module.imports.some((existing) => sameStringArray(existing.package, requested.package)
      && (existing.wildcard || existing.modules.includes("*") || requested.modules.every((moduleName) => existing.modules.includes(moduleName))));
}

function mergeImportEdit(state: FileState, requested: ImportDeclNode, module = state.parse.program.modules[0]): TextEdit | undefined {
  if (requested.wildcard || requested.modules.includes("*")) {
    return undefined;
  }
  const existing = module?.imports.find((candidate) => sameStringArray(candidate.package, requested.package) && !candidate.wildcard && !candidate.modules.includes("*"));
  if (!existing) {
    return undefined;
  }
  const missing = requested.modules.filter((moduleName) => !existing.modules.includes(moduleName));
  if (missing.length === 0) {
    return undefined;
  }
  const lastModule = existing.moduleRanges.at(-1);
  if (lastModule) {
    return TextEdit.insert(lspRange(lastModule).end, `, ${missing.join(", ")}`);
  }
  return TextEdit.replace(lspRange(existing.range), formatImportStatement({ ...existing, modules: [...existing.modules, ...missing], wildcard: false }));
}

function moduleForRange(state: FileState, range: Range): ModuleDeclNode | undefined {
  return moduleAtOffset(state, lspPositionToOffset(state.text, range.start));
}

function moduleAtOffset(state: FileState, offset: number): ModuleDeclNode | undefined {
  return state.parse.program.modules.find((module) => containsOffset(module.range, offset)) ?? state.parse.program.modules[0];
}

function formatImportStatement(imp: ImportDeclNode, indent = "    "): string {
  return `${indent}import ${imp.package.join("::")}::{${imp.modules.join(", ")}};`;
}

function extractQuotedName(message: string): string | undefined {
  return /'([^']+)'/.exec(message)?.[1];
}

function validIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    && !KEYWORD_NAMES.includes(name as (typeof KEYWORD_NAMES)[number])
    && !BUILTIN_NAMES.includes(name as (typeof BUILTIN_NAMES)[number])
    && !PRIMITIVE_NAMES.includes(name as (typeof PRIMITIVE_NAMES)[number])
    && !RESERVED_LITERAL_NAMES.includes(name as (typeof RESERVED_LITERAL_NAMES)[number]);
}

function validModuleName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    && !KEYWORD_NAMES.includes(name as (typeof KEYWORD_NAMES)[number])
    && !BUILTIN_NAMES.includes(name as (typeof BUILTIN_NAMES)[number])
    && !PRIMITIVE_NAMES.includes(name as (typeof PRIMITIVE_NAMES)[number]);
}

function canRenameTo(index: WorkspaceIndex, symbol: VelaSymbol, newName: string): boolean {
  if (symbol.name === newName) {
    return true;
  }
  return renameSymbolsForSymbol(index, symbol).every((target) => canRenameSingleSymbolTo(index, target, newName));
}

function canRenameSingleSymbolTo(index: WorkspaceIndex, symbol: VelaSymbol, newName: string): boolean {
  if (!canRenameFlatAssemblyTo(index, symbol, newName)) {
    return false;
  }
  if (isTopLevelSymbol(symbol)) {
    return canRenameTopLevelTo(index, symbol, newName);
  }
  if (symbol.kind === "field" || symbol.kind === "method") {
    return canRenameMemberTo(index, symbol, newName);
  }
  if (symbol.kind === "local" || symbol.kind === "param") {
    return canRenameLocalTo(index, symbol, newName);
  }
  return true;
}

function renameSymbolsForSymbol(index: WorkspaceIndex, symbol: VelaSymbol): VelaSymbol[] {
  if (symbol.kind !== "method" || !symbol.className) {
    return [symbol];
  }
  const ownerType = typeSymbolForMethodOwner(index, symbol);
  if (ownerType) {
    return skeletonMethodRenameSymbols(index, ownerType, symbol.name);
  }
  const ownerClass = classSymbolForMemberSymbol(index, symbol);
  const parent = ownerClass ? parentSymbolFor(index, ownerClass) : undefined;
  if (parent?.kind === "type" && parent.decl?.kind === "TypeDecl" && parent.decl.methods.some((method) => method.name === symbol.name)) {
    return skeletonMethodRenameSymbols(index, parent, symbol.name);
  }
  return [symbol];
}

function skeletonMethodRenameSymbols(index: WorkspaceIndex, typeSymbol: VelaSymbol, methodName: string): VelaSymbol[] {
  return uniqueSymbols([
    ...index.allSymbols().filter((symbol) => symbol.kind === "method" && symbol.className === typeSymbol.name && symbol.uri === typeSymbol.uri && symbol.name === methodName),
    ...index.allSymbols()
      .filter((symbol) => symbol.kind === "class" && parentIsSymbol(index, symbol, typeSymbol))
      .flatMap((cls) => methodSymbolsForClassSymbol(index, cls).filter((symbol) => symbol.name === methodName)),
  ]);
}

function uniqueSymbols(symbols: VelaSymbol[]): VelaSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    if (seen.has(symbol.id)) {
      return false;
    }
    seen.add(symbol.id);
    return true;
  });
}

function typeSymbolForMethodOwner(index: WorkspaceIndex, symbol: VelaSymbol): VelaSymbol | undefined {
  return index.allSymbols().find((candidate) =>
    candidate.kind === "type"
    && candidate.name === symbol.className
    && candidate.uri === symbol.uri
    && candidate.moduleName === symbol.moduleName);
}

function classSymbolForMemberSymbol(index: WorkspaceIndex, symbol: VelaSymbol): VelaSymbol | undefined {
  return index.allSymbols().find((candidate) =>
    candidate.kind === "class"
    && candidate.name === symbol.className
    && candidate.uri === symbol.uri
    && candidate.moduleName === symbol.moduleName);
}

function canRenameFlatAssemblyTo(index: WorkspaceIndex, symbol: VelaSymbol, newName: string): boolean {
  const proposed = proposedFlatAssemblyLabels(index, symbol, newName);
  if (proposed.size === 0) {
    return true;
  }
  const ignored = ignoredFlatAssemblySymbolIds(index, symbol);
  for (const candidate of flatAssemblyCollisionSymbols(index, symbol)) {
    if (ignored.has(candidate.id)) {
      continue;
    }
    for (const label of flatAssemblyLabelsForSymbol(index, candidate)) {
      if (proposed.has(label)) {
        return false;
      }
    }
  }
  return true;
}

function flatAssemblyCollisionSymbols(index: WorkspaceIndex, symbol: VelaSymbol): VelaSymbol[] {
  const state = index.get(symbol.uri);
  return state?.analysis.symbols ?? index.allSymbols().filter((candidate) => candidate.uri === symbol.uri && candidate.moduleName === symbol.moduleName);
}

function proposedFlatAssemblyLabels(index: WorkspaceIndex, symbol: VelaSymbol, newName: string): Set<string> {
  if (symbol.kind === "function" || symbol.kind === "global") {
    return new Set([newName]);
  }
  if (isTypeMethodSymbol(index, symbol)) {
    return new Set();
  }
  if (symbol.kind === "method" && symbol.className) {
    return new Set([`${symbol.className}_${newName}`]);
  }
  if (symbol.kind !== "class") {
    return new Set();
  }
  const labels = new Set([`__vtable_${newName}`, `${newName}_OnFree`]);
  for (const method of index.allSymbols().filter((candidate) =>
    candidate.kind === "method"
    && candidate.uri === symbol.uri
    && candidate.moduleName === symbol.moduleName
    && candidate.className === symbol.name)) {
    labels.add(`${newName}_${method.name}`);
  }
  return labels;
}

function flatAssemblyLabelsForSymbol(index: WorkspaceIndex, symbol: VelaSymbol): string[] {
  if (symbol.kind === "function" || symbol.kind === "global") {
    return [symbol.name];
  }
  if (isTypeMethodSymbol(index, symbol)) {
    return [];
  }
  if (symbol.kind === "method" && symbol.className) {
    return [`${symbol.className}_${symbol.name}`];
  }
  if (symbol.kind === "class") {
    return [`__vtable_${symbol.name}`, `${symbol.name}_OnFree`];
  }
  return [];
}

function isTypeMethodSymbol(index: WorkspaceIndex, symbol: VelaSymbol): boolean {
  return symbol.kind === "method" && !!typeSymbolForMethodOwner(index, symbol);
}

function ignoredFlatAssemblySymbolIds(index: WorkspaceIndex, symbol: VelaSymbol): Set<string> {
  const ids = new Set([symbol.id]);
  if (symbol.kind === "class") {
    for (const candidate of index.allSymbols()) {
      if (candidate.uri === symbol.uri && candidate.moduleName === symbol.moduleName && candidate.className === symbol.name) {
        ids.add(candidate.id);
      }
    }
  }
  return ids;
}

function isTopLevelSymbol(symbol: VelaSymbol): boolean {
  return ["alias", "class", "type", "function", "global"].includes(symbol.kind);
}

function canRenameTopLevelTo(index: WorkspaceIndex, symbol: VelaSymbol, newName: string): boolean {
  if (newName.startsWith("__") || newName === "space") {
    return false;
  }
  if (newName === "main" && symbol.kind !== "function") {
    return false;
  }
  const includedCollision = index.get(symbol.uri)?.analysis.symbols.some((candidate) =>
    candidate.id !== symbol.id
    && isTopLevelSymbol(candidate)
    && candidate.name === newName
  );
  if (includedCollision) {
    return false;
  }
  return !index.allSymbols().some((candidate) =>
    candidate.id !== symbol.id
    && isTopLevelSymbol(candidate)
    && candidate.uri === symbol.uri
    && candidate.moduleName === symbol.moduleName
    && candidate.name === newName
  );
}

function canRenameMemberTo(index: WorkspaceIndex, symbol: VelaSymbol, newName: string): boolean {
  const directCollision = index.allSymbols().some((candidate) =>
    candidate.id !== symbol.id
    && candidate.kind === symbol.kind
    && candidate.uri === symbol.uri
    && candidate.moduleName === symbol.moduleName
    && candidate.className === symbol.className
    && candidate.name === newName
  );
  if (directCollision) {
    return false;
  }
  if (symbol.kind === "field") {
    return canRenameFieldTo(index, symbol, newName);
  }
  return true;
}

function canRenameFieldTo(index: WorkspaceIndex, symbol: VelaSymbol, newName: string): boolean {
  if (!symbol.className) {
    return true;
  }
  const ownerClass = classSymbolForMemberSymbol(index, symbol);
  if (!ownerClass) {
    return true;
  }
  const relatedClasses = [
    ...classHierarchySymbolsForSymbol(index, ownerClass).filter((candidate) => candidate.id !== ownerClass.id),
    ...descendantClassSymbols(index, ownerClass),
  ];
  return !relatedClasses.some((cls) => index.allSymbols().some((candidate) =>
    candidate.kind === "field"
    && candidate.className === cls.name
    && candidate.uri === cls.uri
    && candidate.moduleName === cls.moduleName
    && candidate.name === newName
  )) && canRenameGeneratedAccessorsTo(index, symbol, newName);
}

function taggedFieldRenameEdit(index: WorkspaceIndex, symbol: VelaSymbol, newName: string): WorkspaceEdit | undefined {
  const accessors = generatedAccessorRenames(index, symbol, newName);
  if (accessors.length === 0) {
    return undefined;
  }
  const changes: Record<string, TextEdit[]> = {};
  const seen = new Set<string>();
  const addEdit = (uri: string, range: VelaRange, replacement: string) => {
    const key = `${uri}:${range.start.offset}:${range.end.offset}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    changes[uri] ??= [];
    changes[uri]!.push(TextEdit.replace(lspRange(range), replacement));
  };
  for (const ref of index.referencesFor(symbol.id, true)) {
    addEdit(ref.uri, ref.range, newName);
  }
  for (const accessor of accessors) {
    for (const ref of index.referencesFor(accessor.symbol.id, false)) {
      addEdit(ref.uri, ref.range, accessor.newName);
    }
  }
  return Object.keys(changes).length > 0 ? { changes } : undefined;
}

function generatedAccessorRenameEdit(index: WorkspaceIndex, symbol: VelaSymbol, newAccessorName: string): WorkspaceEdit | undefined {
  const field = fieldSymbolForGeneratedAccessor(index, symbol);
  const prefix = generatedAccessorPrefix(symbol.name);
  const newFieldName = prefix ? fieldNameFromAccessorName(prefix, newAccessorName) : undefined;
  if (!field || !newFieldName || !validIdentifier(newFieldName) || !canRenameTo(index, field, newFieldName)) {
    return undefined;
  }
  return taggedFieldRenameEdit(index, field, newFieldName);
}

function isGeneratedAccessorMethod(index: WorkspaceIndex, symbol: VelaSymbol): boolean {
  return !!fieldSymbolForGeneratedAccessor(index, symbol);
}

function canRenameGeneratedAccessorsTo(index: WorkspaceIndex, symbol: VelaSymbol, newFieldName: string): boolean {
  const accessors = generatedAccessorRenames(index, symbol, newFieldName);
  if (accessors.length === 0 || !symbol.className) {
    return true;
  }
  const oldAccessorIds = new Set(accessors.map((accessor) => accessor.symbol.id));
  for (const accessor of accessors) {
    const memberCollision = index.allSymbols().some((candidate) =>
      candidate.kind === "method"
      && candidate.uri === symbol.uri
      && candidate.moduleName === symbol.moduleName
      && candidate.className === symbol.className
      && candidate.name === accessor.newName
      && !oldAccessorIds.has(candidate.id)
    );
    if (memberCollision) {
      return false;
    }
    const proposedLabel = `${symbol.className}_${accessor.newName}`;
    for (const candidate of flatAssemblyCollisionSymbols(index, symbol)) {
      if (oldAccessorIds.has(candidate.id)) {
        continue;
      }
      if (flatAssemblyLabelsForSymbol(index, candidate).includes(proposedLabel)) {
        return false;
      }
    }
  }
  return true;
}

function generatedAccessorRenames(index: WorkspaceIndex, symbol: VelaSymbol, newFieldName: string): { symbol: VelaSymbol; newName: string }[] {
  if (symbol.kind !== "field" || symbol.decl?.kind !== "VarDecl" || !symbol.className) {
    return [];
  }
  const accessors: { oldName: string; newName: string }[] = [];
  if (symbol.decl.tags.includes("get")) {
    accessors.push({ oldName: fieldAccessorName("Get", symbol.name), newName: fieldAccessorName("Get", newFieldName) });
  }
  if (symbol.decl.tags.includes("set")) {
    accessors.push({ oldName: fieldAccessorName("Set", symbol.name), newName: fieldAccessorName("Set", newFieldName) });
  }
  return accessors.flatMap((accessor) => {
    const method = index.allSymbols().find((candidate) =>
      candidate.kind === "method"
      && candidate.uri === symbol.uri
      && candidate.moduleName === symbol.moduleName
      && candidate.className === symbol.className
      && candidate.name === accessor.oldName
      && candidate.generated
      && candidate.selectionRange.start.offset === symbol.selectionRange.start.offset
      && candidate.selectionRange.end.offset === symbol.selectionRange.end.offset
    );
    return method ? [{ symbol: method, newName: accessor.newName }] : [];
  });
}

function fieldSymbolForGeneratedAccessor(index: WorkspaceIndex, symbol: VelaSymbol): VelaSymbol | undefined {
  if (symbol.kind !== "method" || !symbol.generated || !symbol.className || !generatedAccessorPrefix(symbol.name)) {
    return undefined;
  }
  return index.allSymbols().find((candidate) =>
    candidate.kind === "field"
    && candidate.uri === symbol.uri
    && candidate.moduleName === symbol.moduleName
    && candidate.className === symbol.className
    && candidate.selectionRange.start.offset === symbol.selectionRange.start.offset
    && candidate.selectionRange.end.offset === symbol.selectionRange.end.offset
  );
}

function generatedAccessorPrefix(name: string): "Get" | "Set" | undefined {
  if (name.startsWith("Get") && name.length > "Get".length) {
    return "Get";
  }
  if (name.startsWith("Set") && name.length > "Set".length) {
    return "Set";
  }
  return undefined;
}

function fieldNameFromAccessorName(prefix: "Get" | "Set", accessorName: string): string | undefined {
  if (!accessorName.startsWith(prefix) || accessorName.length <= prefix.length) {
    return undefined;
  }
  const suffix = accessorName.slice(prefix.length);
  const fieldName = `${suffix.charAt(0).toLowerCase()}${suffix.slice(1)}`;
  return fieldAccessorName(prefix, fieldName) === accessorName ? fieldName : undefined;
}

function fieldAccessorName(prefix: "Get" | "Set", fieldName: string): string {
  return `${prefix}${fieldName.charAt(0).toUpperCase()}${fieldName.slice(1)}`;
}

function descendantClassSymbols(index: WorkspaceIndex, classSymbol: VelaSymbol): VelaSymbol[] {
  const result: VelaSymbol[] = [];
  const queue = index.allSymbols().filter((symbol) => symbol.kind === "class" && parentIsSymbol(index, symbol, classSymbol));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.id)) {
      continue;
    }
    seen.add(current.id);
    result.push(current);
    queue.push(...index.allSymbols().filter((symbol) => symbol.kind === "class" && parentIsSymbol(index, symbol, current)));
  }
  return result;
}

function canRenameLocalTo(index: WorkspaceIndex, symbol: VelaSymbol, newName: string): boolean {
  const state = index.get(symbol.uri);
  if (!state) {
    return true;
  }
  const fn = functionAtOffset(state, symbol.selectionRange.start.offset);
  if (!fn) {
    return true;
  }
  return !state.analysis.symbols.some((candidate) =>
    candidate.id !== symbol.id
    && (candidate.kind === "local" || candidate.kind === "param")
    && candidate.name === newName
    && containsOffset(fn.range, candidate.selectionRange.start.offset)
  );
}

function textForRange(text: string, range: Range): string {
  const start = lspPositionToOffset(text, range.start);
  const end = lspPositionToOffset(text, range.end);
  return text.slice(start, end);
}

function fullDocumentRange(text: string): Range {
  const lines = text.split(/\r?\n/u);
  const lastLine = Math.max(0, lines.length - 1);
  return Range.create(0, 0, lastLine, lines[lastLine]?.length ?? 0);
}

function rangeFormattingEdit(original: string, formatted: string, requested: Range): TextEdit | undefined {
  const originalLines = original.split(/\r?\n/u);
  const formattedLines = formatted.split(/\r?\n/u);
  const startLine = Math.max(0, Math.min(requested.start.line, Math.max(0, originalLines.length - 1)));
  const endLine = Math.max(startLine, Math.min(requested.end.line, Math.max(0, originalLines.length - 1)));
  const endCharacter = endLine < originalLines.length - 1 ? 0 : originalLines[endLine]?.length ?? 0;
  const editRange = Range.create(startLine, 0, endLine < originalLines.length - 1 ? endLine + 1 : endLine, endCharacter);
  const replacementLines = formattedLines.slice(startLine, endLine + 1);
  const newText = `${replacementLines.join("\n")}${endLine < originalLines.length - 1 ? "\n" : ""}`;
  return textForRange(original, editRange) === newText ? undefined : TextEdit.replace(editRange, newText);
}

function tokenBefore(tokens: Token[], offset: number): Token | undefined {
  return [...tokens].reverse().find((token) => token.range.end.offset <= offset && token.kind !== TokenKind.Eof && token.kind !== TokenKind.Comment);
}

function tokenAtOffset(tokens: Token[], offset: number): Token | undefined {
  return tokens
    .filter((token) => token.kind !== TokenKind.Eof && token.range.start.offset <= offset && offset <= token.range.end.offset)
    .sort((left, right) =>
      right.range.start.offset - left.range.start.offset
      || (left.range.end.offset - left.range.start.offset) - (right.range.end.offset - right.range.start.offset))[0];
}

function insideTag(tokens: Token[], offset: number): boolean {
  const before = tokens.filter((token) => token.range.start.offset < offset);
  const open = lastWhere(before, (token) => token.kind === TokenKind.TagOpen);
  const close = lastWhere(before, (token) => token.kind === TokenKind.TagClose);
  return !!open && (!close || close.range.start.offset < open.range.start.offset);
}

function lastWhere<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (predicate(item)) {
      return item;
    }
  }
  return undefined;
}

function findImportAt(parse: ParseResult, offset: number): ImportDeclNode | undefined {
  for (const module of parse.program.modules) {
    const imp = module.imports.find((item) => containsOffset(item.range, offset));
    if (imp) {
      return imp;
    }
  }
  return undefined;
}

function importTargetsAtOffset(index: WorkspaceIndex, state: FileState, offset: number): { range: VelaRange; targets: FileState[] } | undefined {
  for (const module of state.parse.program.modules) {
    for (const imp of module.imports) {
      for (let i = 0; i < imp.modules.length; i++) {
        const range = imp.moduleRanges[i];
        if (!range || !containsOffset(range, offset)) {
          continue;
        }
        const moduleName = imp.modules[i];
        if (!moduleName) {
          continue;
        }
        const targets = moduleName === "*" ? index.filesForImport(imp) : [index.moduleForImport(imp, moduleName)].filter((target): target is FileState => !!target);
        return { range, targets };
      }
    }
  }
  return undefined;
}

function importTargetMarkdown(targets: FileState[]): string {
  if (targets.length === 1) {
    return `Import target:\n\n\`${targets[0]!.path}\``;
  }
  return `Import targets:\n\n${targets.map((target) => `- \`${target.path}\``).join("\n")}`;
}

function builtinDefinitionLocation(name: string): Location | undefined {
  const lines = builtinVirtualText().split("\n");
  const line = lines.findIndex((item) => item.includes(name));
  if (line < 0) {
    return undefined;
  }
  const character = lines[line]!.indexOf(name);
  return Location.create(BUILTIN_VIRTUAL_URI, Range.create(line, character, line, character + name.length));
}

function documentLinkTooltip(target: FileState, fallbackModuleName: string): string {
  return `Open ${target.parse.program.modules[0]?.name ?? fallbackModuleName}.vl`;
}

type CallableNode =
  | CallExprNode
  | MethodCallExprNode
  | InitExprNode
  | MallocExprNode
  | SizeOfExprNode
  | CastExprNode
  | FreeStmtNode
  | PrintStmtNode;

function nearestCall(program: BaseNode, tokens: Token[], offset: number): { node: CallableNode; openParenOffset: number } | undefined {
  return callableNodes(program)
    .filter((call) => containsOffset(call.range, offset))
    .map((node) => ({ node, openParenOffset: openParenOffset(tokens, node) }))
    .filter((call) => call.openParenOffset <= offset)
    .sort((a, b) => (a.node.range.end.offset - a.node.range.start.offset) - (b.node.range.end.offset - b.node.range.start.offset))[0];
}

function nearestSignatureDeclaration(program: BaseNode, tokens: Token[], offset: number): { node: FunctionDeclNode; openParenOffset: number } | undefined {
  return allNodes(program)
    .filter((node): node is FunctionDeclNode => node.kind === "FunctionDecl")
    .map((node) => {
      const open = declarationOpenParenOffset(tokens, node);
      return open === undefined ? undefined : { node, openParenOffset: open };
    })
    .filter((decl): decl is { node: FunctionDeclNode; openParenOffset: number } => !!decl)
    .filter((decl) => {
      const openToken = tokens.find((token) => token.kind === TokenKind.LParen && token.range.start.offset === decl.openParenOffset);
      if (!openToken || decl.openParenOffset > offset) {
        return false;
      }
      const closeOffset = matchingCloseParenOffset(tokens, decl.openParenOffset) ?? decl.node.range.end.offset;
      return offset <= closeOffset;
    })
    .sort((a, b) => (a.node.range.end.offset - a.node.range.start.offset) - (b.node.range.end.offset - b.node.range.start.offset))[0];
}

function declarationOpenParenOffset(tokens: Token[], node: FunctionDeclNode): number | undefined {
  const headerEnd = node.body[0]?.range.start.offset ?? node.range.end.offset;
  return tokens.find((token) =>
    token.kind === TokenKind.LParen
    && token.range.start.offset >= node.nameRange.end.offset
    && token.range.start.offset <= headerEnd)?.range.start.offset;
}

function openParenOffset(tokens: Token[], node: BaseNode): number {
  return tokens.find((token) => token.kind === TokenKind.LParen && token.range.start.offset >= node.range.start.offset && token.range.start.offset <= node.range.end.offset)?.range.start.offset ?? node.range.start.offset;
}

function matchingCloseParenOffset(tokens: Token[], openOffset: number): number | undefined {
  let depth = 0;
  for (const token of tokens) {
    if (token.range.start.offset < openOffset) {
      continue;
    }
    if (token.kind === TokenKind.LParen) {
      depth += 1;
    } else if (token.kind === TokenKind.RParen) {
      depth -= 1;
      if (depth === 0) {
        return token.range.start.offset;
      }
    }
  }
  return undefined;
}

function signatureForCall(index: WorkspaceIndex, state: FileState, call: CallableNode) {
  let symbol: VelaSymbol | undefined;
  if (call.kind === "CallExpr") {
    const callee = call.callee;
    if (callee.kind === "IdentifierExpr") {
      symbol = visibleTopLevelSymbolByName(index, state, moduleAtOffset(state, call.range.start.offset), callee.name, new Set(["function"]));
    }
  } else if (call.kind === "MethodCallExpr") {
    symbol = methodSymbolForCall(index, state, call);
  } else if (call.kind === "InitExpr") {
    const cls = visibleClassSymbolForInit(index, state, call);
    if (!cls) {
      return undefined;
    }
    const onAlloc = visibleOnAllocSymbolForInit(index, state, call);
    const params = onAlloc?.params ?? [];
    return signatureFromParts(
      `Ptr<${cls.name}> Init<${cls.name}>(${params.map((param) => `${param.name}: ${typeToString(param.type)}`).join(", ")})`,
      params,
      onAlloc?.documentation,
    );
  } else if (call.kind === "MallocExpr") {
    return builtinSignature("Ptr<U0> Malloc(I16 size)", [{ name: "size", detail: "I16 size" }], builtinMarkdown("Malloc"));
  } else if (call.kind === "SizeOfExpr") {
    return builtinSignature("U16 SizeOf(Type)", [{ name: "type", detail: "Type" }], builtinMarkdown("SizeOf"));
  } else if (call.kind === "CastExpr") {
    return builtinSignature("T Cast<T>(expr)", [{ name: "expr", detail: "expr" }], builtinMarkdown("Cast"));
  } else if (call.kind === "FreeStmt") {
    return builtinSignature("U0 Free(Ptr<T> value)", [{ name: "value", detail: "Ptr<T> value" }], builtinMarkdown("Free"));
  } else if (call.kind === "PrintStmt") {
    return builtinSignature("U0 Print(value)", [{ name: "value", detail: "value" }], builtinMarkdown("Print"));
  }
  if (!symbol) {
    return undefined;
  }
  const params = symbol.params ?? [];
  const owner = symbol.kind === "method" && symbol.className ? `${symbol.className}.` : "";
  return signatureFromParts(
    `${typeToString(symbol.returnType ?? symbol.type)} ${owner}${symbol.name}(${params.map((param) => `${typeToString(param.type)} ${param.name}`).join(", ")})`,
    params,
    symbol.documentation,
  );
}

function signatureForDeclaration(decl: FunctionDeclNode) {
  const params = decl.params.map((param) => ({ name: param.name, detail: `${typeExprText(param.typeExpr)} ${param.name}` }));
  return signatureFromParts(
    `${typeExprText(decl.returnType)} ${decl.name}(${params.map((param) => param.detail).join(", ")})`,
    params,
  );
}

function methodSymbolForCall(index: WorkspaceIndex, state: FileState, call: MethodCallExprNode): VelaSymbol | undefined {
  const receiverType = call.obj.inferredType;
  const actual = receiverType?.kind === "ptr" ? receiverType.inner : receiverType;
  if (!actual || actual.kind !== "class") {
    return undefined;
  }
  const classSymbol = classSymbolVisibleAtOffset(index, state, actual.name, call.methodRange.start.offset);
  return (classSymbol ? methodSymbolsForClassSymbol(index, classSymbol) : methodSymbolsForClass(index, actual.name))
    .find((method) => method.name === call.method);
}

type SignatureParam = { name: string; type?: VelaType; detail?: string };

function signatureFromParts(label: string, params: SignatureParam[], documentation?: string) {
  return {
    params,
    info: SignatureInformation.create(label, documentation, ...params.map((param) => ({ label: param.detail ?? `${typeToString(param.type)} ${param.name}` }))),
  };
}

function builtinSignature(label: string, params: SignatureParam[], documentation?: string) {
  return {
    params,
    info: SignatureInformation.create(label, documentation, ...params.map((param) => ({ label: param.detail ?? param.name }))),
  };
}

function activeParameter(tokens: Token[], startOffset: number, offset: number): number {
  let depth = 0;
  let active = 0;
  for (const token of tokens) {
    if (token.range.start.offset < startOffset || token.range.start.offset >= offset) {
      continue;
    }
    if (token.kind === TokenKind.LParen) depth += 1;
    if (token.kind === TokenKind.RParen) depth = Math.max(0, depth - 1);
    if (token.kind === TokenKind.Comma && depth <= 1) active += 1;
  }
  return active;
}

function boundedActiveParameter(params: SignatureParam[], tokens: Token[], startOffset: number, offset: number): number {
  const active = activeParameter(tokens, startOffset, offset);
  return params.length > 0 ? Math.min(active, params.length - 1) : 0;
}

function callNodes(node: BaseNode): (CallExprNode | MethodCallExprNode)[] {
  return allNodes(node).filter((item): item is CallExprNode | MethodCallExprNode => item.kind === "CallExpr" || item.kind === "MethodCallExpr");
}

function callableNodes(node: BaseNode): CallableNode[] {
  return allNodes(node).filter((item): item is CallableNode =>
    item.kind === "CallExpr"
    || item.kind === "MethodCallExpr"
    || item.kind === "InitExpr"
    || item.kind === "MallocExpr"
    || item.kind === "SizeOfExpr"
    || item.kind === "CastExpr"
    || item.kind === "FreeStmt"
    || item.kind === "PrintStmt",
  );
}

function argumentAlreadyNamed(call: CallExprNode | MethodCallExprNode, name: string): boolean {
  return call.kind === "CallExpr" && call.callee.kind === "IdentifierExpr" && call.callee.name === "Init" && call.args.some((arg) => arg.kind === "IdentifierExpr" && arg.name === name);
}

function diagnosticMessage(message: string | MarkupContent): string {
  return typeof message === "string" ? message : message.value;
}

function nodesAtOffset(node: BaseNode, offset: number): BaseNode[] {
  return allNodes(node).filter((item) => containsOffset(item.range, offset));
}

function innermostNodeAt<T extends BaseNode>(node: BaseNode, offset: number, kind: T["kind"]): T | undefined {
  return nodesAtOffset(node, offset)
    .filter((item): item is T => item.kind === kind)
    .sort((left, right) => (left.range.end.offset - left.range.start.offset) - (right.range.end.offset - right.range.start.offset))[0];
}

function allNodes(node: BaseNode): BaseNode[] {
  const result: BaseNode[] = [node];
  const visit = (child: BaseNode | undefined) => {
    if (child) result.push(...allNodes(child));
  };
  const visitMany = (children: BaseNode[] | undefined) => children?.forEach(visit);
  switch (node.kind) {
    case "Program":
      visitMany((node as ParseResult["program"]).modules);
      break;
    case "ModuleDecl":
      visitMany((node as ModuleDeclNode).imports);
      visitMany((node as ModuleDeclNode).body);
      break;
    case "ClassDecl":
      visitMany((node as ClassDeclNode).fields);
      visitMany((node as ClassDeclNode).methods);
      visit((node as ClassDeclNode).onAlloc);
      visit((node as ClassDeclNode).onFree);
      break;
    case "TypeDecl":
      visitMany((node as TypeDeclNode).methods);
      break;
    case "FunctionDecl":
      {
        const fn = node as FunctionDeclNode;
        visitMany(fn.params);
        if (fn.bodyBlock) {
          visit(fn.bodyBlock);
        } else {
          visitMany(fn.body);
        }
      }
      break;
    case "VarDecl":
      visit((node as VarDeclNode).typeExpr);
      visit((node as VarDeclNode).initializer);
      break;
    case "BlockStmt":
      visitMany((node as BlockStmtNode).body);
      break;
    case "IfStmt":
      visit((node as any).condition);
      visit((node as any).thenBlock);
      if ((node as any).elseBlock) {
        visit((node as any).elseBlock);
      } else {
        visitMany((node as any).elseBody);
      }
      break;
    case "ForStmt":
      visit((node as any).init);
      visit((node as any).condition);
      visit((node as any).update);
      visit((node as any).bodyBlock);
      break;
    case "WhileStmt":
      visit((node as any).condition);
      visit((node as any).bodyBlock);
      break;
    case "ReturnStmt":
      visit((node as any).value);
      break;
    case "Assignment":
      visit((node as any).target);
      visit((node as any).value);
      break;
    case "ExprStmt":
    case "FreeStmt":
      visit((node as any).expr);
      break;
    case "PrintStmt":
      visit((node as any).value);
      visit((node as any).fmt);
      break;
    case "AsmBlock":
      visitMany((node as any).bindings);
      break;
    case "BinaryExpr":
      visit((node as any).left);
      visit((node as any).right);
      break;
    case "UnaryExpr":
    case "DerefExpr":
    case "AddressOfExpr":
      visit((node as any).operand);
      break;
    case "CallExpr":
      visit((node as any).callee);
      visitMany((node as any).args);
      break;
    case "MethodCallExpr":
      visit((node as any).obj);
      visitMany((node as any).args);
      break;
    case "FieldAccessExpr":
      visit((node as any).obj);
      break;
    case "IndexExpr":
      visit((node as any).obj);
      visit((node as any).index);
      break;
    case "CastExpr":
      visit((node as any).targetType);
      visit((node as any).operand);
      break;
    case "InitExpr":
      visitMany((node as any).kwargs?.map((arg: any) => arg.value));
      break;
    case "MallocExpr":
      visit((node as any).size);
      break;
    case "SizeOfExpr":
      visit((node as any).targetType);
      break;
    case "MultiDispatchExpr":
      visitMany((node as any).targets);
      visitMany((node as any).args);
      break;
  }
  return result;
}
