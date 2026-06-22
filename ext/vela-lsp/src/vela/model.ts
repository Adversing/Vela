import {
  Diagnostic,
  DiagnosticRelatedInformation,
  DiagnosticSeverity,
  Location,
  MarkupKind,
  Position,
  Range,
} from "vscode-languageserver/node";

export interface VelaPosition {
  line: number;
  column: number;
  offset: number;
}

export interface VelaRange {
  uri: string;
  start: VelaPosition;
  end: VelaPosition;
}

export function makePosition(line: number, column: number, offset: number): VelaPosition {
  return { line, column, offset };
}

export function makeRange(uri: string, start: VelaPosition, end: VelaPosition): VelaRange {
  const normalizedEnd =
    end.line === start.line && end.column <= start.column
      ? { ...end, column: start.column + 1, offset: Math.max(end.offset, start.offset + 1) }
      : end;
  return { uri, start, end: normalizedEnd };
}

export function lspPosition(position: VelaPosition): Position {
  return Position.create(Math.max(0, position.line - 1), Math.max(0, position.column - 1));
}

export function lspRange(range: VelaRange | undefined): Range {
  if (!range) {
    return Range.create(0, 0, 0, 1);
  }
  return Range.create(lspPosition(range.start), lspPosition(range.end));
}

export function locationFromRange(range: VelaRange): Location {
  return Location.create(range.uri, lspRange(range));
}

export function containsOffset(range: VelaRange | undefined, offset: number): boolean {
  return !!range && range.start.offset <= offset && offset <= range.end.offset;
}

export function rangeLength(range: VelaRange | undefined): number {
  return range ? Math.max(1, range.end.offset - range.start.offset) : 1;
}

export function offsetToVelaPosition(text: string, offset: number): VelaPosition {
  const target = Math.max(0, Math.min(text.length, offset));
  let line = 1;
  let column = 1;
  for (let i = 0; i < target; i++) {
    const ch = text[i];
    if (ch === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column, offset: target };
}

export function lspPositionToOffset(text: string, position: Position): number {
  const targetLine = Math.max(0, position.line);
  const targetColumn = Math.max(0, position.character);
  let line = 0;
  let column = 0;
  for (let i = 0; i < text.length; i++) {
    if (line === targetLine && column === targetColumn) {
      return i;
    }
    const ch = text[i];
    if (ch === "\n") {
      if (line === targetLine) {
        return i;
      }
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return text.length;
}

export enum TokenKind {
  IntLiteral = "INT_LITERAL",
  FloatLiteral = "FLOAT_LITERAL",
  StringLiteral = "STRING_LITERAL",
  CharLiteral = "CHAR_LITERAL",
  BoolTrue = "BOOL_TRUE",
  BoolFalse = "BOOL_FALSE",
  NullLiteral = "NULL_LITERAL",
  KwClass = "KW_CLASS",
  KwType = "KW_TYPE",
  KwSkeleton = "KW_SKELETON",
  KwAlias = "KW_ALIAS",
  KwIf = "KW_IF",
  KwElse = "KW_ELSE",
  KwFor = "KW_FOR",
  KwWhile = "KW_WHILE",
  KwRet = "KW_RET",
  KwImport = "KW_IMPORT",
  KwModule = "KW_MODULE",
  KwAsm = "KW_ASM",
  KwOnAlloc = "KW_ONALLOC",
  KwOnFree = "KW_ONFREE",
  TyU0 = "TY_U0",
  TyU8 = "TY_U8",
  TyI8 = "TY_I8",
  TyU16 = "TY_U16",
  TyI16 = "TY_I16",
  TyF16 = "TY_F16",
  TyPtr = "TY_PTR",
  BiMalloc = "BI_MALLOC",
  BiFree = "BI_FREE",
  BiInit = "BI_INIT",
  BiSizeOf = "BI_SIZEOF",
  BiCast = "BI_CAST",
  BiPrint = "BI_PRINT",
  Identifier = "IDENTIFIER",
  Plus = "PLUS",
  Minus = "MINUS",
  Star = "STAR",
  Slash = "SLASH",
  Percent = "PERCENT",
  Eq = "EQ",
  Neq = "NEQ",
  Lt = "LT",
  Gt = "GT",
  Lte = "LTE",
  Gte = "GTE",
  And = "AND",
  Or = "OR",
  Not = "NOT",
  Ampersand = "AMPERSAND",
  Assign = "ASSIGN",
  PlusPlus = "PLUS_PLUS",
  MinusMinus = "MINUS_MINUS",
  PlusEq = "PLUS_EQ",
  MinusEq = "MINUS_EQ",
  StarEq = "STAR_EQ",
  SlashEq = "SLASH_EQ",
  Arrow = "ARROW",
  LParen = "LPAREN",
  RParen = "RPAREN",
  LBrace = "LBRACE",
  RBrace = "RBRACE",
  LBracket = "LBRACKET",
  RBracket = "RBRACKET",
  Semicolon = "SEMICOLON",
  Comma = "COMMA",
  Colon = "COLON",
  Dot = "DOT",
  DoubleColon = "DOUBLE_COLON",
  TagOpen = "TAG_OPEN",
  TagClose = "TAG_CLOSE",
  Comment = "COMMENT",
  Eof = "EOF",
}

export const KEYWORDS: Record<string, TokenKind> = {
  alias: TokenKind.KwAlias,
  class: TokenKind.KwClass,
  else: TokenKind.KwElse,
  for: TokenKind.KwFor,
  if: TokenKind.KwIf,
  import: TokenKind.KwImport,
  module: TokenKind.KwModule,
  OnAlloc: TokenKind.KwOnAlloc,
  OnFree: TokenKind.KwOnFree,
  ret: TokenKind.KwRet,
  skeleton: TokenKind.KwSkeleton,
  type: TokenKind.KwType,
  while: TokenKind.KwWhile,
  ASM: TokenKind.KwAsm,
  U0: TokenKind.TyU0,
  U8: TokenKind.TyU8,
  I8: TokenKind.TyI8,
  U16: TokenKind.TyU16,
  I16: TokenKind.TyI16,
  F16: TokenKind.TyF16,
  Ptr: TokenKind.TyPtr,
  Malloc: TokenKind.BiMalloc,
  Free: TokenKind.BiFree,
  Init: TokenKind.BiInit,
  SizeOf: TokenKind.BiSizeOf,
  Cast: TokenKind.BiCast,
  Print: TokenKind.BiPrint,
  true: TokenKind.BoolTrue,
  false: TokenKind.BoolFalse,
  null: TokenKind.NullLiteral,
};

export const PRIMITIVE_TOKEN_NAMES: Partial<Record<TokenKind, string>> = {
  [TokenKind.TyU0]: "U0",
  [TokenKind.TyU8]: "U8",
  [TokenKind.TyI8]: "I8",
  [TokenKind.TyU16]: "U16",
  [TokenKind.TyI16]: "I16",
  [TokenKind.TyF16]: "F16",
};

export const BUILTIN_NAMES = ["Malloc", "Free", "Init", "SizeOf", "Cast", "Print"] as const;
export const KEYWORD_NAMES = [
  "alias",
  "class",
  "else",
  "for",
  "if",
  "import",
  "module",
  "OnAlloc",
  "OnFree",
  "ret",
  "skeleton",
  "type",
  "while",
  "ASM",
] as const;
export const PRIMITIVE_NAMES = ["U0", "U8", "I8", "U16", "I16", "F16", "Ptr"] as const;
export const TAG_NAMES = ["get", "set", "visible"] as const;
export const ASM_TAG_NAMES = ["in", "out"] as const;
export const ASM_REGISTER_NAMES = ["R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"] as const;

export interface Token {
  kind: TokenKind;
  value: string;
  lexeme: string;
  range: VelaRange;
}

export interface VelaDiagnostic {
  code: string;
  message: string;
  severity: DiagnosticSeverity;
  range: VelaRange;
  source?: string;
  hint?: string;
  related?: { message: string; range: VelaRange }[];
}

export function toLspDiagnostic(diagnostic: VelaDiagnostic): Diagnostic {
  return Diagnostic.create(
    lspRange(diagnostic.range),
    diagnostic.hint ? `${diagnostic.message}\n${diagnostic.hint}` : diagnostic.message,
    diagnostic.severity,
    diagnostic.code,
    diagnostic.source ?? "vela",
    diagnostic.related?.map((item): DiagnosticRelatedInformation =>
      DiagnosticRelatedInformation.create(locationFromRange(item.range), item.message),
    ),
  );
}

export interface BaseNode {
  kind: string;
  range: VelaRange;
}

export interface ProgramNode extends BaseNode {
  kind: "Program";
  modules: ModuleDeclNode[];
}

export interface ModuleDeclNode extends BaseNode {
  kind: "ModuleDecl";
  name: string;
  nameRange: VelaRange;
  imports: ImportDeclNode[];
  body: DeclNode[];
}

export interface ImportDeclNode extends BaseNode {
  kind: "ImportDecl";
  package: string[];
  packageRanges: VelaRange[];
  modules: string[];
  moduleRanges: VelaRange[];
  wildcard: boolean;
}

export interface AliasDeclNode extends BaseNode {
  kind: "AliasDecl";
  name: string;
  nameRange: VelaRange;
  targetType: TypeExprNode;
}

export interface VarDeclNode extends BaseNode {
  kind: "VarDecl";
  typeExpr: TypeExprNode;
  name: string;
  nameRange: VelaRange;
  initializer?: ExprNode;
  tags: string[];
  tagRanges: VelaRange[];
  generated?: boolean;
}

export interface FunctionDeclNode extends BaseNode {
  kind: "FunctionDecl";
  returnType: TypeExprNode;
  name: string;
  nameRange: VelaRange;
  params: ParamDeclNode[];
  body: StmtNode[];
  bodyBlock?: BlockStmtNode;
  isSkeleton: boolean;
  generated?: boolean;
}

export interface ParamDeclNode extends BaseNode {
  kind: "ParamDecl";
  typeExpr: TypeExprNode;
  name: string;
  nameRange: VelaRange;
}

export interface ClassDeclNode extends BaseNode {
  kind: "ClassDecl";
  name: string;
  nameRange: VelaRange;
  parent?: string;
  parentRange?: VelaRange;
  fields: VarDeclNode[];
  methods: FunctionDeclNode[];
  onAlloc?: FunctionDeclNode;
  onFree?: FunctionDeclNode;
}

export interface TypeDeclNode extends BaseNode {
  kind: "TypeDecl";
  name: string;
  nameRange: VelaRange;
  parent?: string;
  parentRange?: VelaRange;
  methods: FunctionDeclNode[];
}

export type DeclNode =
  | ImportDeclNode
  | AliasDeclNode
  | VarDeclNode
  | FunctionDeclNode
  | ClassDeclNode
  | TypeDeclNode;

export type TypeExprNode = NamedTypeNode | PtrTypeNode | MissingTypeNode;

export interface NamedTypeNode extends BaseNode {
  kind: "NamedType";
  name: string;
  nameRange: VelaRange;
}

export interface PtrTypeNode extends BaseNode {
  kind: "PtrType";
  inner: TypeExprNode;
}

export interface MissingTypeNode extends BaseNode {
  kind: "MissingType";
  name: "<missing>";
}

export type StmtNode =
  | VarDeclNode
  | ExprStmtNode
  | ReturnStmtNode
  | IfStmtNode
  | ForStmtNode
  | WhileStmtNode
  | AssignmentStmtNode
  | FreeStmtNode
  | PrintStmtNode
  | AsmBlockNode
  | BlockStmtNode;

export interface BlockStmtNode extends BaseNode {
  kind: "BlockStmt";
  body: StmtNode[];
}

export interface ExprStmtNode extends BaseNode {
  kind: "ExprStmt";
  expr: ExprNode;
}

export interface ReturnStmtNode extends BaseNode {
  kind: "ReturnStmt";
  value?: ExprNode;
}

export interface IfStmtNode extends BaseNode {
  kind: "IfStmt";
  condition: ExprNode;
  thenBlock: BlockStmtNode;
  thenBody: StmtNode[];
  elseBlock?: BlockStmtNode;
  elseBody: StmtNode[];
}

export interface ForStmtNode extends BaseNode {
  kind: "ForStmt";
  init?: StmtNode;
  condition?: ExprNode;
  update?: StmtNode;
  bodyBlock: BlockStmtNode;
  body: StmtNode[];
}

export interface WhileStmtNode extends BaseNode {
  kind: "WhileStmt";
  condition: ExprNode;
  bodyBlock: BlockStmtNode;
  body: StmtNode[];
}

export interface AssignmentStmtNode extends BaseNode {
  kind: "Assignment";
  target: ExprNode;
  value: ExprNode;
  op: string;
}

export interface FreeStmtNode extends BaseNode {
  kind: "FreeStmt";
  expr: ExprNode;
}

export interface PrintStmtNode extends BaseNode {
  kind: "PrintStmt";
  value: ExprNode;
  fmt?: ExprNode;
}

export interface AsmBlockNode extends BaseNode {
  kind: "AsmBlock";
  bindings: AsmBindingNode[];
  inputs: AsmBindingNode[];
  outputs: AsmBindingNode[];
  body: string[];
}

export interface AsmBindingNode extends BaseNode {
  kind: "AsmBinding";
  direction: "in" | "out";
  tags: string[];
  tagRanges: VelaRange[];
  register: string;
  registerRange: VelaRange;
  variable: string;
  variableRange: VelaRange;
}

export interface BaseExprNode extends BaseNode {
  inferredType?: VelaType;
}

export type ExprNode =
  | IntLiteralNode
  | FloatLiteralNode
  | StringLiteralNode
  | CharLiteralNode
  | BoolLiteralNode
  | NullLiteralNode
  | IdentifierExprNode
  | BinaryExprNode
  | UnaryExprNode
  | CallExprNode
  | MethodCallExprNode
  | FieldAccessExprNode
  | IndexExprNode
  | DerefExprNode
  | AddressOfExprNode
  | CastExprNode
  | InitExprNode
  | MallocExprNode
  | SizeOfExprNode
  | MultiDispatchExprNode
  | MissingExprNode;

export interface IntLiteralNode extends BaseExprNode {
  kind: "IntLiteral";
  value: number;
}

export interface FloatLiteralNode extends BaseExprNode {
  kind: "FloatLiteral";
  value: number;
}

export interface StringLiteralNode extends BaseExprNode {
  kind: "StringLiteral";
  value: string;
}

export interface CharLiteralNode extends BaseExprNode {
  kind: "CharLiteral";
  value: string;
}

export interface BoolLiteralNode extends BaseExprNode {
  kind: "BoolLiteral";
  value: boolean;
}

export interface NullLiteralNode extends BaseExprNode {
  kind: "NullLiteral";
}

export interface IdentifierExprNode extends BaseExprNode {
  kind: "IdentifierExpr";
  name: string;
  nameRange: VelaRange;
}

export interface BinaryExprNode extends BaseExprNode {
  kind: "BinaryExpr";
  op: string;
  left: ExprNode;
  right: ExprNode;
  operatorRange: VelaRange;
}

export interface UnaryExprNode extends BaseExprNode {
  kind: "UnaryExpr";
  op: string;
  operand: ExprNode;
  operatorRange: VelaRange;
}

export interface CallExprNode extends BaseExprNode {
  kind: "CallExpr";
  callee: IdentifierExprNode | ExprNode;
  args: ExprNode[];
}

export interface MethodCallExprNode extends BaseExprNode {
  kind: "MethodCallExpr";
  obj: ExprNode;
  method: string;
  methodRange: VelaRange;
  args: ExprNode[];
}

export interface FieldAccessExprNode extends BaseExprNode {
  kind: "FieldAccessExpr";
  obj: ExprNode;
  fieldName: string;
  fieldRange: VelaRange;
}

export interface IndexExprNode extends BaseExprNode {
  kind: "IndexExpr";
  obj: ExprNode;
  index: ExprNode;
}

export interface DerefExprNode extends BaseExprNode {
  kind: "DerefExpr";
  operand: ExprNode;
  operatorRange: VelaRange;
}

export interface AddressOfExprNode extends BaseExprNode {
  kind: "AddressOfExpr";
  operand: ExprNode;
  operatorRange: VelaRange;
}

export interface CastExprNode extends BaseExprNode {
  kind: "CastExpr";
  targetType: TypeExprNode;
  operand: ExprNode;
}

export interface InitExprNode extends BaseExprNode {
  kind: "InitExpr";
  className: string;
  classNameRange: VelaRange;
  kwargs: { name: string; nameRange: VelaRange; value: ExprNode }[];
}

export interface MallocExprNode extends BaseExprNode {
  kind: "MallocExpr";
  size: ExprNode;
}

export interface SizeOfExprNode extends BaseExprNode {
  kind: "SizeOfExpr";
  targetType: TypeExprNode;
}

export interface MultiDispatchExprNode extends BaseExprNode {
  kind: "MultiDispatchExpr";
  targets: ExprNode[];
  method: string;
  methodRange: VelaRange;
  args: ExprNode[];
}

export interface MissingExprNode extends BaseExprNode {
  kind: "MissingExpr";
}

export type VelaType =
  | { kind: "void" }
  | { kind: "int"; bits: 8 | 16; signed: boolean }
  | { kind: "float"; bits: 16 }
  | { kind: "bool" }
  | { kind: "ptr"; inner: VelaType }
  | { kind: "class"; name: string; parent?: string; fields: ClassFieldInfo[]; methods: string[]; size: number; vtable: Record<string, number> }
  | { kind: "interface"; name: string; methods: string[] }
  | { kind: "unknown"; name: string };

export interface ClassFieldInfo {
  name: string;
  type: VelaType;
  range: VelaRange;
  offset?: number;
}

export const U0: VelaType = { kind: "void" };
export const U8: VelaType = { kind: "int", bits: 8, signed: false };
export const I8: VelaType = { kind: "int", bits: 8, signed: true };
export const U16: VelaType = { kind: "int", bits: 16, signed: false };
export const I16: VelaType = { kind: "int", bits: 16, signed: true };
export const F16: VelaType = { kind: "float", bits: 16 };
export const BOOL: VelaType = { kind: "bool" };
export const NULL_PTR: VelaType = { kind: "ptr", inner: U0 };
export const UNKNOWN: VelaType = { kind: "unknown", name: "<unknown>" };

export const PRIMITIVE_TYPES: Record<string, VelaType> = {
  U0,
  U8,
  I8,
  U16,
  I16,
  F16,
};

export function typeToString(type: VelaType | undefined): string {
  if (!type) {
    return "<unknown>";
  }
  switch (type.kind) {
    case "void":
      return "U0";
    case "int":
      return `${type.signed ? "I" : "U"}${type.bits}`;
    case "float":
      return `F${type.bits}`;
    case "bool":
      return "Bool";
    case "ptr":
      return `Ptr<${typeToString(type.inner)}>`;
    case "class":
      return type.name;
    case "interface":
      return type.name;
    case "unknown":
      return type.name;
  }
}

export function typeSize(type: VelaType): number {
  switch (type.kind) {
    case "void":
      return 0;
    case "int":
      return type.bits / 8;
    case "float":
      return 2;
    case "bool":
      return 1;
    case "ptr":
      return 2;
    case "class":
      return type.size;
    case "interface":
      return 2;
    case "unknown":
      return 1;
  }
}

export function isNumeric(type: VelaType): boolean {
  return type.kind === "int" || type.kind === "float";
}

export function isFloat(type: VelaType): boolean {
  return type.kind === "float";
}

export function isInteger(type: VelaType): boolean {
  return type.kind === "int";
}

export function isBoolLike(type: VelaType): boolean {
  if (type.kind === "bool") {
    return true;
  }
  if (type.kind === "class" && type.name === "Bool") {
    return true;
  }
  return type.kind === "ptr" && type.inner.kind === "class" && type.inner.name === "Bool";
}

export function typeEquals(left: VelaType, right: VelaType): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "void":
    case "bool":
      return true;
    case "int":
      return right.kind === "int" && left.bits === right.bits && left.signed === right.signed;
    case "float":
      return right.kind === "float" && left.bits === right.bits;
    case "ptr":
      return right.kind === "ptr" && typeEquals(left.inner, right.inner);
    case "class":
      return right.kind === "class" && left.name === right.name;
    case "interface":
      return right.kind === "interface" && left.name === right.name;
    case "unknown":
      return right.kind === "unknown";
  }
}

export function typesCompatible(target: VelaType, source: VelaType): boolean {
  if (target.kind === "unknown" || source.kind === "unknown") {
    return true;
  }
  if (typeEquals(target, source)) {
    return true;
  }
  if (target.kind === "int" && source.kind === "int") {
    if (target.signed === source.signed) {
      return target.bits >= source.bits;
    }
    if (target.signed && !source.signed) {
      return target.bits > source.bits;
    }
    return false;
  }
  if (target.kind === "float" && source.kind === "float") {
    return true;
  }
  if (target.kind === "ptr" && source.kind === "ptr") {
    if (target.inner.kind === "void" || source.inner.kind === "void") {
      return true;
    }
    return typeEquals(target.inner, source.inner);
  }
  return false;
}

export function markdown(value: string): { kind: MarkupKind; value: string } {
  return { kind: MarkupKind.Markdown, value };
}

export type SymbolKindName =
  | "module"
  | "import"
  | "alias"
  | "class"
  | "type"
  | "field"
  | "method"
  | "function"
  | "global"
  | "local"
  | "param"
  | "builtin"
  | "keyword"
  | "tag"
  | "register";

export interface VelaSymbol {
  id: string;
  name: string;
  kind: SymbolKindName;
  type: VelaType;
  uri: string;
  range: VelaRange;
  selectionRange: VelaRange;
  moduleName?: string;
  className?: string;
  params?: { name: string; type: VelaType; range: VelaRange }[];
  returnType?: VelaType;
  defaultLibrary?: boolean;
  generated?: boolean;
  documentation?: string;
  decl?: DeclNode | ParamDeclNode | VarDeclNode | FunctionDeclNode | ClassDeclNode | TypeDeclNode;
}

export interface VelaReference {
  symbolId: string;
  name: string;
  range: VelaRange;
  uri: string;
  write?: boolean;
}

export interface AnalysisResult {
  uri: string;
  diagnostics: VelaDiagnostic[];
  symbols: VelaSymbol[];
  references: VelaReference[];
  expressionTypes: { range: VelaRange; type: VelaType }[];
  visibleSymbols: VelaSymbol[];
  callEdges: { from: VelaSymbol; to: VelaSymbol; range: VelaRange }[];
}

export interface ParseResult {
  uri: string;
  text: string;
  tokens: Token[];
  allTokens: Token[];
  diagnostics: VelaDiagnostic[];
  program: ProgramNode;
}
