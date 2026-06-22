import { DiagnosticSeverity } from "vscode-languageserver/node";
import {
  AliasDeclNode,
  AsmBindingNode,
  AsmBlockNode,
  AssignmentStmtNode,
  BinaryExprNode,
  BlockStmtNode,
  BoolLiteralNode,
  CallExprNode,
  CastExprNode,
  CharLiteralNode,
  ClassDeclNode,
  DeclNode,
  ExprNode,
  ExprStmtNode,
  FieldAccessExprNode,
  FloatLiteralNode,
  ForStmtNode,
  FreeStmtNode,
  FunctionDeclNode,
  IdentifierExprNode,
  IfStmtNode,
  ImportDeclNode,
  IndexExprNode,
  InitExprNode,
  IntLiteralNode,
  MallocExprNode,
  MethodCallExprNode,
  MissingExprNode,
  MissingTypeNode,
  ModuleDeclNode,
  MultiDispatchExprNode,
  NamedTypeNode,
  NullLiteralNode,
  ParamDeclNode,
  ParseResult,
  PrintStmtNode,
  ProgramNode,
  PtrTypeNode,
  ReturnStmtNode,
  SizeOfExprNode,
  StmtNode,
  StringLiteralNode,
  Token,
  TokenKind,
  TypeDeclNode,
  TypeExprNode,
  UnaryExprNode,
  VarDeclNode,
  VelaDiagnostic,
  VelaRange,
  WhileStmtNode,
  makeRange,
} from "./model.js";

const DECL_SYNC = new Set<TokenKind>([
  TokenKind.KwImport,
  TokenKind.KwAlias,
  TokenKind.KwClass,
  TokenKind.KwType,
  TokenKind.TagOpen,
  TokenKind.TyU0,
  TokenKind.TyU8,
  TokenKind.TyI8,
  TokenKind.TyU16,
  TokenKind.TyI16,
  TokenKind.TyF16,
  TokenKind.TyPtr,
  TokenKind.Identifier,
  TokenKind.RBrace,
  TokenKind.Eof,
]);

const STMT_SYNC = new Set<TokenKind>([
  TokenKind.Semicolon,
  TokenKind.RBrace,
  TokenKind.KwRet,
  TokenKind.KwIf,
  TokenKind.KwFor,
  TokenKind.KwWhile,
  TokenKind.KwAsm,
  TokenKind.BiFree,
  TokenKind.BiPrint,
  TokenKind.Eof,
]);

const ASSIGNMENT_OPS: Partial<Record<TokenKind, string>> = {
  [TokenKind.Assign]: "=",
  [TokenKind.PlusEq]: "+=",
  [TokenKind.MinusEq]: "-=",
  [TokenKind.StarEq]: "*=",
  [TokenKind.SlashEq]: "/=",
};

export class Parser {
  private pos = 0;
  private readonly diagnostics: VelaDiagnostic[];

  constructor(
    private readonly tokens: Token[],
    diagnostics: VelaDiagnostic[] = [],
    private readonly uri: string = tokens[0]?.range.uri ?? "",
    private readonly text = "",
  ) {
    this.diagnostics = [...diagnostics];
  }

  parse(): ParseResult {
    const start = this.current().range.start;
    const modules: ModuleDeclNode[] = [];
    while (!this.at(TokenKind.Eof)) {
      if (this.at(TokenKind.KwModule)) {
        modules.push(this.parseModule());
      } else {
        this.error(this.current(), "vela.parse.expectedModule", "expected 'module' declaration", "a Vela source file starts with module name { ... }");
        const body: DeclNode[] = [];
        while (!this.at(TokenKind.Eof)) {
          const decl = this.parseTopLevelDecl();
          if (decl) {
            body.push(decl);
          } else {
            this.advance();
          }
        }
        modules.push({
          kind: "ModuleDecl",
          name: "<global>",
          nameRange: this.current().range,
          imports: body.filter((node): node is ImportDeclNode => node.kind === "ImportDecl"),
          body: body.filter((node) => node.kind !== "ImportDecl"),
          range: makeRange(this.uri, start, this.current().range.end),
        });
      }
    }
    const end = this.current().range.end;
    const program: ProgramNode = {
      kind: "Program",
      modules,
      range: makeRange(this.uri, start, end),
    };
    return {
      uri: this.uri,
      text: this.text,
      tokens: this.tokens,
      allTokens: this.tokens,
      diagnostics: this.diagnostics,
      program,
    };
  }

  private current(): Token {
    return this.tokens[Math.min(this.pos, this.tokens.length - 1)]!;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private at(...kinds: TokenKind[]): boolean {
    return kinds.includes(this.current().kind);
  }

  private advance(): Token {
    const token = this.current();
    if (this.pos < this.tokens.length - 1) {
      this.pos += 1;
    }
    return token;
  }

  private match(...kinds: TokenKind[]): Token | undefined {
    if (!this.at(...kinds)) {
      return undefined;
    }
    return this.advance();
  }

  private expect(kind: TokenKind, message?: string): Token {
    if (this.at(kind)) {
      return this.advance();
    }
    const token = this.current();
    this.error(token, "vela.parse.expectedToken", message ?? `expected ${this.kindLabel(kind)}, got ${this.tokenLabel(token)}`, this.expectedHint(kind, token));
    return token;
  }

  private expectName(message: string): Token {
    if (this.at(TokenKind.Identifier, TokenKind.NullLiteral, TokenKind.BoolTrue, TokenKind.BoolFalse)) {
      return this.advance();
    }
    return this.expect(TokenKind.Identifier, message);
  }

  private error(token: Token, code: string, message: string, hint?: string): void {
    this.diagnostics.push({
      code,
      message,
      hint,
      severity: DiagnosticSeverity.Error,
      range: token.range,
      source: "vela-lsp",
    });
  }

  private kindLabel(kind: TokenKind): string {
    const labels: Partial<Record<TokenKind, string>> = {
      [TokenKind.Semicolon]: "';'",
      [TokenKind.LBrace]: "'{'",
      [TokenKind.RBrace]: "'}'",
      [TokenKind.LParen]: "'('",
      [TokenKind.RParen]: "')'",
      [TokenKind.Identifier]: "identifier",
      [TokenKind.KwModule]: "'module'",
      [TokenKind.Eof]: "end of file",
    };
    return labels[kind] ?? kind;
  }

  private tokenLabel(token: Token): string {
    return token.kind === TokenKind.Eof ? "end of file" : `${token.kind} ${JSON.stringify(token.lexeme)}`;
  }

  private expectedHint(kind: TokenKind, token: Token): string | undefined {
    if (kind === TokenKind.Semicolon) {
      return "statements and declarations must end with ';'";
    }
    if (kind === TokenKind.RBrace && token.kind === TokenKind.Eof) {
      return "close the block with '}'";
    }
    if (kind === TokenKind.RParen) {
      return "close the argument list or condition with ')'";
    }
    if (kind === TokenKind.Identifier) {
      return "insert a valid name here";
    }
    return undefined;
  }

  private parseModule(): ModuleDeclNode {
    const start = this.expect(TokenKind.KwModule);
    const nameToken = this.expectName("expected module name");
    this.expect(TokenKind.LBrace);
    const imports: ImportDeclNode[] = [];
    const body: DeclNode[] = [];
    while (!this.at(TokenKind.RBrace, TokenKind.Eof)) {
      const before = this.pos;
      if (this.at(TokenKind.KwImport)) {
        imports.push(this.parseImport());
      } else {
        const decl = this.parseTopLevelDecl();
        if (decl) {
          body.push(decl);
        }
      }
      if (this.pos === before) {
        this.advance();
      }
    }
    const end = this.expect(TokenKind.RBrace);
    return {
      kind: "ModuleDecl",
      name: nameToken.value || "<missing>",
      nameRange: nameToken.range,
      imports,
      body,
      range: combineRanges(start.range, end.range),
    };
  }

  private parseImport(): ImportDeclNode {
    const start = this.expect(TokenKind.KwImport);
    const packageSegments: string[] = [];
    const packageRanges: VelaRange[] = [];
    const first = this.expectName("expected import package segment");
    packageSegments.push(first.value);
    packageRanges.push(first.range);
    this.expect(TokenKind.DoubleColon, "expected '::' in import path");
    while (!this.at(TokenKind.LBrace, TokenKind.Eof)) {
      const segment = this.expectName("expected import package segment");
      packageSegments.push(segment.value);
      packageRanges.push(segment.range);
      this.expect(TokenKind.DoubleColon, "expected '::' before import list");
    }
    this.expect(TokenKind.LBrace);
    const modules: string[] = [];
    const moduleRanges: VelaRange[] = [];
    let wildcard = false;
    if (this.match(TokenKind.Star)) {
      wildcard = true;
      modules.push("*");
      moduleRanges.push(this.peek(-1).range);
    } else {
      while (!this.at(TokenKind.RBrace, TokenKind.Eof)) {
        const moduleToken = this.expectName("expected imported module name");
        modules.push(moduleToken.value);
        moduleRanges.push(moduleToken.range);
        if (!this.match(TokenKind.Comma)) {
          break;
        }
      }
    }
    this.expect(TokenKind.RBrace);
    const semi = this.expect(TokenKind.Semicolon);
    return {
      kind: "ImportDecl",
      package: packageSegments,
      packageRanges,
      modules,
      moduleRanges,
      wildcard,
      range: combineRanges(start.range, semi.range),
    };
  }

  private parseTopLevelDecl(): DeclNode | undefined {
    try {
      if (this.at(TokenKind.KwAlias)) {
        return this.parseAlias();
      }
      if (this.at(TokenKind.KwClass)) {
        return this.parseClass();
      }
      if (this.at(TokenKind.KwType)) {
        return this.parseTypeDecl();
      }
      if (this.at(TokenKind.TagOpen)) {
        const parsed = this.parseTags();
        return this.parseVarDeclWithTags(parsed.tags, parsed.ranges);
      }
      if (this.isTypeStart()) {
        return this.parseFuncOrVar();
      }
      this.error(this.current(), "vela.parse.unexpectedTopLevel", `unexpected token at module top level: ${this.tokenLabel(this.current())}`, "module bodies contain imports, aliases, globals, functions, classes, and types");
      this.synchronize(DECL_SYNC);
      return undefined;
    } catch {
      this.synchronize(DECL_SYNC);
      return undefined;
    }
  }

  private parseTags(): { tags: string[]; ranges: VelaRange[] } {
    this.expect(TokenKind.TagOpen);
    const tags: string[] = [];
    const ranges: VelaRange[] = [];
    while (!this.at(TokenKind.TagClose, TokenKind.Eof)) {
      const tag = this.expect(TokenKind.Identifier, "expected tag name");
      tags.push(tag.value);
      ranges.push(tag.range);
      if (!this.match(TokenKind.Comma)) {
        break;
      }
    }
    this.expect(TokenKind.TagClose);
    return { tags, ranges };
  }

  private parseAlias(): AliasDeclNode {
    const start = this.expect(TokenKind.KwAlias);
    const name = this.expect(TokenKind.Identifier, "expected alias name");
    this.expect(TokenKind.Arrow, "expected '<-' in alias declaration");
    const targetType = this.parseTypeExpr();
    const end = this.expect(TokenKind.Semicolon);
    return {
      kind: "AliasDecl",
      name: name.value,
      nameRange: name.range,
      targetType,
      range: combineRanges(start.range, end.range),
    };
  }

  private parseClass(): ClassDeclNode {
    const start = this.expect(TokenKind.KwClass);
    const name = this.expect(TokenKind.Identifier, "expected class name");
    let parent: string | undefined;
    let parentRange: VelaRange | undefined;
    if (this.match(TokenKind.Colon)) {
      const parentToken = this.expect(TokenKind.Identifier, "expected parent class or type name");
      parent = parentToken.value;
      parentRange = parentToken.range;
    }
    this.expect(TokenKind.LBrace);
    const cls: ClassDeclNode = {
      kind: "ClassDecl",
      name: name.value,
      nameRange: name.range,
      parent,
      parentRange,
      fields: [],
      methods: [],
      range: start.range,
    };
    while (!this.at(TokenKind.RBrace, TokenKind.Eof)) {
      const before = this.pos;
      this.parseClassMember(cls);
      if (before === this.pos) {
        this.advance();
      }
    }
    const end = this.expect(TokenKind.RBrace);
    cls.range = combineRanges(start.range, end.range);
    return cls;
  }

  private parseClassMember(cls: ClassDeclNode): void {
    const parsedTags = this.at(TokenKind.TagOpen) ? this.parseTags() : { tags: [], ranges: [] };
    if (this.at(TokenKind.KwOnAlloc)) {
      if (cls.onAlloc) {
        this.error(this.current(), "vela.parse.duplicateOnAlloc", `class '${cls.name}' has duplicate OnAlloc`, "a class can define OnAlloc only once");
      }
      cls.onAlloc = this.parseOnAlloc();
      return;
    }
    if (this.at(TokenKind.KwOnFree)) {
      if (cls.onFree) {
        this.error(this.current(), "vela.parse.duplicateOnFree", `class '${cls.name}' has duplicate OnFree`, "a class can define OnFree only once");
      }
      cls.onFree = this.parseOnFree();
      return;
    }
    if (this.isTypeStart()) {
      const ty = this.parseTypeExpr();
      const name = this.expect(TokenKind.Identifier, "expected field or method name");
      if (this.at(TokenKind.LParen)) {
        cls.methods.push(this.parseFunctionBody(ty, name, false));
      } else {
        let initializer: ExprNode | undefined;
        if (this.match(TokenKind.Assign)) {
          initializer = this.parseExpr();
        }
        const end = this.expect(TokenKind.Semicolon);
        cls.fields.push({
          kind: "VarDecl",
          typeExpr: ty,
          name: name.value,
          nameRange: name.range,
          initializer,
          tags: parsedTags.tags,
          tagRanges: parsedTags.ranges,
          range: combineRanges(ty.range, end.range),
        });
      }
      return;
    }
    this.error(this.current(), "vela.parse.unexpectedClassMember", `unexpected token in class body: ${this.tokenLabel(this.current())}`, "class bodies contain fields, methods, OnAlloc, and OnFree");
    this.synchronize(STMT_SYNC);
  }

  private parseOnAlloc(): FunctionDeclNode {
    const start = this.expect(TokenKind.KwOnAlloc);
    this.expect(TokenKind.LParen);
    const params = this.parseParamList();
    this.expect(TokenKind.RParen);
    const body = this.parseBlockBody();
    return {
      kind: "FunctionDecl",
      returnType: namedType("U0", start.range),
      name: "OnAlloc",
      nameRange: start.range,
      params,
      body: body.body,
      bodyBlock: body,
      isSkeleton: false,
      range: combineRanges(start.range, body.range),
    };
  }

  private parseOnFree(): FunctionDeclNode {
    const start = this.expect(TokenKind.KwOnFree);
    if (this.match(TokenKind.LParen)) {
      this.expect(TokenKind.RParen);
    }
    const body = this.parseBlockBody();
    return {
      kind: "FunctionDecl",
      returnType: namedType("U0", start.range),
      name: "OnFree",
      nameRange: start.range,
      params: [],
      body: body.body,
      bodyBlock: body,
      isSkeleton: false,
      range: combineRanges(start.range, body.range),
    };
  }

  private parseTypeDecl(): TypeDeclNode {
    const start = this.expect(TokenKind.KwType);
    const name = this.expect(TokenKind.Identifier, "expected type name");
    let parent: string | undefined;
    let parentRange: VelaRange | undefined;
    if (this.match(TokenKind.Colon)) {
      const parentToken = this.expect(TokenKind.Identifier, "expected parent type name");
      parent = parentToken.value;
      parentRange = parentToken.range;
    }
    this.expect(TokenKind.LBrace);
    const methods: FunctionDeclNode[] = [];
    while (!this.at(TokenKind.RBrace, TokenKind.Eof)) {
      const skeletonToken = this.match(TokenKind.KwSkeleton);
      const ret = this.parseTypeExpr();
      const methodName = this.expect(TokenKind.Identifier, "expected skeleton method name");
      const method = this.parseFunctionBody(ret, methodName, true);
      method.isSkeleton = true;
      method.range = combineRanges(skeletonToken?.range ?? ret.range, method.range);
      methods.push(method);
    }
    const end = this.expect(TokenKind.RBrace);
    return {
      kind: "TypeDecl",
      name: name.value,
      nameRange: name.range,
      parent,
      parentRange,
      methods,
      range: combineRanges(start.range, end.range),
    };
  }

  private isTypeStart(): boolean {
    return this.at(
      TokenKind.TyU0,
      TokenKind.TyU8,
      TokenKind.TyI8,
      TokenKind.TyU16,
      TokenKind.TyI16,
      TokenKind.TyF16,
      TokenKind.TyPtr,
      TokenKind.Identifier,
    );
  }

  private parseFuncOrVar(): VarDeclNode | FunctionDeclNode {
    const ty = this.parseTypeExpr();
    const name = this.expect(TokenKind.Identifier, "expected declaration name");
    if (this.at(TokenKind.LParen)) {
      return this.parseFunctionBody(ty, name, false);
    }
    let initializer: ExprNode | undefined;
    if (this.match(TokenKind.Assign)) {
      initializer = this.parseExpr();
    }
    const end = this.expect(TokenKind.Semicolon);
    return {
      kind: "VarDecl",
      typeExpr: ty,
      name: name.value,
      nameRange: name.range,
      initializer,
      tags: [],
      tagRanges: [],
      range: combineRanges(ty.range, end.range),
    };
  }

  private parseVarDeclWithTags(tags: string[], tagRanges: VelaRange[]): VarDeclNode {
    const ty = this.parseTypeExpr();
    const name = this.expect(TokenKind.Identifier, "expected variable name");
    let initializer: ExprNode | undefined;
    if (this.match(TokenKind.Assign)) {
      initializer = this.parseExpr();
    }
    const end = this.expect(TokenKind.Semicolon);
    return {
      kind: "VarDecl",
      typeExpr: ty,
      name: name.value,
      nameRange: name.range,
      initializer,
      tags,
      tagRanges,
      range: combineRanges(ty.range, end.range),
    };
  }

  private parseFunctionBody(retType: TypeExprNode, nameToken: Token, forceSkeleton: boolean): FunctionDeclNode {
    this.expect(TokenKind.LParen);
    const params = this.parseParamList();
    this.expect(TokenKind.RParen);
    if (this.match(TokenKind.Semicolon)) {
      const end = this.peek(-1);
      return {
        kind: "FunctionDecl",
        returnType: retType,
        name: nameToken.value,
        nameRange: nameToken.range,
        params,
        body: [],
        isSkeleton: true,
        range: combineRanges(retType.range, end.range),
      };
    }
    if (forceSkeleton) {
      return {
        kind: "FunctionDecl",
        returnType: retType,
        name: nameToken.value,
        nameRange: nameToken.range,
        params,
        body: [],
        isSkeleton: true,
        range: combineRanges(retType.range, nameToken.range),
      };
    }
    const body = this.parseBlockBody();
    return {
      kind: "FunctionDecl",
      returnType: retType,
      name: nameToken.value,
      nameRange: nameToken.range,
      params,
      body: body.body,
      bodyBlock: body,
      isSkeleton: false,
      range: combineRanges(retType.range, body.range),
    };
  }

  private parseParamList(): ParamDeclNode[] {
    const params: ParamDeclNode[] = [];
    if (this.at(TokenKind.RParen, TokenKind.Eof)) {
      return params;
    }
    params.push(this.parseParam());
    while (this.match(TokenKind.Comma)) {
      if (this.at(TokenKind.RParen, TokenKind.Eof)) {
        break;
      }
      params.push(this.parseParam());
    }
    return params;
  }

  private parseParam(): ParamDeclNode {
    const ty = this.parseTypeExpr();
    const name = this.expect(TokenKind.Identifier, "expected parameter name");
    return {
      kind: "ParamDecl",
      typeExpr: ty,
      name: name.value,
      nameRange: name.range,
      range: combineRanges(ty.range, name.range),
    };
  }

  private parseTypeExpr(): TypeExprNode {
    const start = this.current();
    if (this.match(TokenKind.TyPtr)) {
      this.expect(TokenKind.Lt, "expected '<' after Ptr");
      const inner = this.parseTypeExpr();
      const end = this.expect(TokenKind.Gt, "expected '>' to close Ptr<T>");
      return {
        kind: "PtrType",
        inner,
        range: combineRanges(start.range, end.range),
      } satisfies PtrTypeNode;
    }
    const primitiveNames: Partial<Record<TokenKind, string>> = {
      [TokenKind.TyU0]: "U0",
      [TokenKind.TyU8]: "U8",
      [TokenKind.TyI8]: "I8",
      [TokenKind.TyU16]: "U16",
      [TokenKind.TyI16]: "I16",
      [TokenKind.TyF16]: "F16",
    };
    if (this.at(TokenKind.Identifier) || primitiveNames[this.current().kind]) {
      const token = this.advance();
      return namedType(primitiveNames[token.kind] ?? token.value, token.range);
    }
    this.error(this.current(), "vela.parse.expectedType", `expected type, got ${this.tokenLabel(this.current())}`, "use a primitive type, class name, alias, type declaration, or Ptr<T>");
    const token = this.advance();
    return {
      kind: "MissingType",
      name: "<missing>",
      range: token.range,
    } satisfies MissingTypeNode;
  }

  private parseBlockBody(): BlockStmtNode {
    const start = this.expect(TokenKind.LBrace);
    const body: StmtNode[] = [];
    while (!this.at(TokenKind.RBrace, TokenKind.Eof)) {
      const before = this.pos;
      body.push(this.parseStmt());
      if (before === this.pos) {
        this.advance();
      }
    }
    const end = this.expect(TokenKind.RBrace);
    return {
      kind: "BlockStmt",
      body,
      range: combineRanges(start.range, end.range),
    };
  }

  private parseStmt(): StmtNode {
    try {
      if (this.at(TokenKind.LBrace) && !this.isMultiDispatchStatementStart()) {
        return this.parseBlockBody();
      }
      if (this.at(TokenKind.KwRet)) {
        return this.parseReturn();
      }
      if (this.at(TokenKind.KwIf)) {
        return this.parseIf();
      }
      if (this.at(TokenKind.KwFor)) {
        return this.parseFor();
      }
      if (this.at(TokenKind.KwWhile)) {
        return this.parseWhile();
      }
      if (this.at(TokenKind.KwAsm)) {
        return this.parseAsm();
      }
      if (this.at(TokenKind.BiFree)) {
        return this.parseFreeStmt();
      }
      if (this.at(TokenKind.BiPrint)) {
        return this.parsePrintStmt();
      }
      if (this.isTypeStart() && this.isLocalVarDecl()) {
        return this.parseLocalVarDecl();
      }
      return this.parseExprOrAssign();
    } catch {
      const token = this.current();
      this.synchronize(STMT_SYNC);
      return {
        kind: "ExprStmt",
        expr: missingExpr(token.range),
        range: token.range,
      };
    }
  }

  private isMultiDispatchStatementStart(): boolean {
    let braceDepth = 0;
    for (let offset = 0; ; offset++) {
      const token = this.peek(offset);
      if (token.kind === TokenKind.Eof) {
        return false;
      }
      if (token.kind === TokenKind.LBrace) {
        braceDepth += 1;
        continue;
      }
      if (token.kind === TokenKind.RBrace) {
        braceDepth -= 1;
        if (braceDepth === 0) {
          return this.peek(offset + 1).kind === TokenKind.Dot;
        }
        if (braceDepth < 0) {
          return false;
        }
      }
    }
  }

  private isLocalVarDecl(): boolean {
    const saved = this.pos;
    const savedDiagnostics = this.diagnostics.length;
    try {
      this.parseTypeExpr();
      const result = this.at(TokenKind.Identifier) && (this.peek(1).kind === TokenKind.Assign || this.peek(1).kind === TokenKind.Semicolon);
      return result;
    } finally {
      this.pos = saved;
      this.diagnostics.length = savedDiagnostics;
    }
  }

  private parseLocalVarDecl(): VarDeclNode {
    const ty = this.parseTypeExpr();
    const name = this.expect(TokenKind.Identifier, "expected local variable name");
    let initializer: ExprNode | undefined;
    if (this.match(TokenKind.Assign)) {
      initializer = this.parseExpr();
    }
    const end = this.expect(TokenKind.Semicolon);
    return {
      kind: "VarDecl",
      typeExpr: ty,
      name: name.value,
      nameRange: name.range,
      initializer,
      tags: [],
      tagRanges: [],
      range: combineRanges(ty.range, end.range),
    };
  }

  private parseReturn(): ReturnStmtNode {
    const start = this.expect(TokenKind.KwRet);
    const value = this.at(TokenKind.Semicolon, TokenKind.Eof) ? undefined : this.parseExpr();
    const end = this.expect(TokenKind.Semicolon);
    return {
      kind: "ReturnStmt",
      value,
      range: combineRanges(start.range, end.range),
    };
  }

  private parseIf(): IfStmtNode {
    const start = this.expect(TokenKind.KwIf);
    this.expect(TokenKind.LParen);
    const condition = this.parseExpr();
    this.expect(TokenKind.RParen);
    const thenBody = this.parseBlockBody();
    let elseBody: StmtNode[] = [];
    let elseBlock: BlockStmtNode | undefined;
    let endRange = thenBody.range;
    if (this.match(TokenKind.KwElse)) {
      if (this.at(TokenKind.KwIf)) {
        const nested = this.parseIf();
        elseBody = [nested];
        endRange = nested.range;
      } else {
        const block = this.parseBlockBody();
        elseBlock = block;
        elseBody = block.body;
        endRange = block.range;
      }
    }
    return {
      kind: "IfStmt",
      condition,
      thenBlock: thenBody,
      thenBody: thenBody.body,
      elseBlock,
      elseBody,
      range: combineRanges(start.range, endRange),
    };
  }

  private parseFor(): ForStmtNode {
    const start = this.expect(TokenKind.KwFor);
    this.expect(TokenKind.LParen);
    const init = this.at(TokenKind.Semicolon) ? undefined : this.parseForInit();
    if (!init) {
      this.expect(TokenKind.Semicolon);
    }
    const condition = this.at(TokenKind.Semicolon) ? undefined : this.parseExpr();
    this.expect(TokenKind.Semicolon);
    const update = this.at(TokenKind.RParen) ? undefined : this.parseForUpdate();
    this.expect(TokenKind.RParen);
    const body = this.parseBlockBody();
    return {
      kind: "ForStmt",
      init,
      condition,
      update,
      bodyBlock: body,
      body: body.body,
      range: combineRanges(start.range, body.range),
    };
  }

  private parseForInit(): StmtNode {
    if (this.isTypeStart() && this.isLocalVarDecl()) {
      return this.parseLocalVarDecl();
    }
    return this.parseExprOrAssign();
  }

  private parseForUpdate(): StmtNode {
    const expr = this.parseExpr();
    const op = ASSIGNMENT_OPS[this.current().kind];
    if (op) {
      const operator = this.advance();
      this.error(
        operator,
        "vela.parse.forUpdateAssignment",
        "for update must be an expression; assignment updates are not supported by Vela syntax",
        "use i++ or i--, or move the assignment into the loop body",
      );
      const value = this.parseExpr();
      return {
        kind: "Assignment",
        target: expr,
        value,
        op,
        range: combineRanges(expr.range, value.range),
      } satisfies AssignmentStmtNode;
    }
    return {
      kind: "ExprStmt",
      expr,
      range: expr.range,
    };
  }

  private parseWhile(): WhileStmtNode {
    const start = this.expect(TokenKind.KwWhile);
    this.expect(TokenKind.LParen);
    const condition = this.parseExpr();
    this.expect(TokenKind.RParen);
    const body = this.parseBlockBody();
    return {
      kind: "WhileStmt",
      condition,
      bodyBlock: body,
      body: body.body,
      range: combineRanges(start.range, body.range),
    };
  }

  private parseFreeStmt(): FreeStmtNode {
    const start = this.expect(TokenKind.BiFree);
    this.expect(TokenKind.LParen);
    const expr = this.parseExpr();
    this.expect(TokenKind.RParen);
    const end = this.expect(TokenKind.Semicolon);
    return {
      kind: "FreeStmt",
      expr,
      range: combineRanges(start.range, end.range),
    };
  }

  private parsePrintStmt(): PrintStmtNode {
    const start = this.expect(TokenKind.BiPrint);
    this.expect(TokenKind.LParen);
    const value = this.parseExpr();
    let fmt: ExprNode | undefined;
    if (this.match(TokenKind.Comma)) {
      fmt = this.parseExpr();
    }
    this.expect(TokenKind.RParen);
    const end = this.expect(TokenKind.Semicolon);
    return {
      kind: "PrintStmt",
      value,
      fmt,
      range: combineRanges(start.range, end.range),
    };
  }

  private parseAsm(): AsmBlockNode {
    const start = this.expect(TokenKind.KwAsm);
    this.expect(TokenKind.LParen);
    const bindings: AsmBindingNode[] = [];
    const inputs: AsmBindingNode[] = [];
    const outputs: AsmBindingNode[] = [];
    while (!this.at(TokenKind.RParen, TokenKind.Eof)) {
      const parsedTags = this.parseTags();
      const reg = this.expect(TokenKind.Identifier, "expected ASM register");
      this.expect(TokenKind.Assign);
      const variable = this.expect(TokenKind.Identifier, "expected ASM binding variable");
      const direction = parsedTags.tags.includes("out") ? "out" : "in";
      const binding: AsmBindingNode = {
        kind: "AsmBinding",
        direction,
        tags: parsedTags.tags,
        tagRanges: parsedTags.ranges,
        register: reg.value,
        registerRange: reg.range,
        variable: variable.value,
        variableRange: variable.range,
        range: combineRanges(parsedTags.ranges[0] ?? reg.range, variable.range),
      };
      bindings.push(binding);
      if (parsedTags.tags.includes("in")) {
        inputs.push({ ...binding, direction: "in" });
      }
      if (parsedTags.tags.includes("out")) {
        outputs.push({ ...binding, direction: "out" });
      }
      this.match(TokenKind.Semicolon);
    }
    this.expect(TokenKind.RParen);
    this.expect(TokenKind.LBrace);
    const body: string[] = [];
    let currentLine = -1;
    let currentTokens: string[] = [];
    while (!this.at(TokenKind.RBrace, TokenKind.Eof)) {
      const token = this.advance();
      const line = token.range.start.line;
      if (currentLine !== -1 && line !== currentLine && currentTokens.length > 0) {
        body.push(currentTokens.join(" "));
        currentTokens = [];
      }
      currentLine = line;
      currentTokens.push(token.lexeme);
    }
    if (currentTokens.length > 0) {
      body.push(currentTokens.join(" "));
    }
    const end = this.expect(TokenKind.RBrace);
    return {
      kind: "AsmBlock",
      bindings,
      inputs,
      outputs,
      body,
      range: combineRanges(start.range, end.range),
    };
  }

  private parseExprOrAssign(): StmtNode {
    const expr = this.parseExpr();
    const op = ASSIGNMENT_OPS[this.current().kind];
    if (op) {
      this.advance();
      const value = this.parseExpr();
      const end = this.expect(TokenKind.Semicolon);
      return {
        kind: "Assignment",
        target: expr,
        value,
        op,
        range: combineRanges(expr.range, end.range),
      } satisfies AssignmentStmtNode;
    }
    const end = this.expect(TokenKind.Semicolon);
    return {
      kind: "ExprStmt",
      expr,
      range: combineRanges(expr.range, end.range),
    } satisfies ExprStmtNode;
  }

  private parseExpr(): ExprNode {
    return this.parseOr();
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd();
    while (this.at(TokenKind.Or)) {
      left = this.parseBinary(left, this.advance(), this.parseAnd());
    }
    return left;
  }

  private parseAnd(): ExprNode {
    let left = this.parseEquality();
    while (this.at(TokenKind.And)) {
      left = this.parseBinary(left, this.advance(), this.parseEquality());
    }
    return left;
  }

  private parseEquality(): ExprNode {
    let left = this.parseComparison();
    while (this.at(TokenKind.Eq, TokenKind.Neq)) {
      left = this.parseBinary(left, this.advance(), this.parseComparison());
    }
    return left;
  }

  private parseComparison(): ExprNode {
    let left = this.parseAdditive();
    while (this.at(TokenKind.Lt, TokenKind.Gt, TokenKind.Lte, TokenKind.Gte)) {
      left = this.parseBinary(left, this.advance(), this.parseAdditive());
    }
    return left;
  }

  private parseAdditive(): ExprNode {
    let left = this.parseMultiplicative();
    while (this.at(TokenKind.Plus, TokenKind.Minus)) {
      left = this.parseBinary(left, this.advance(), this.parseMultiplicative());
    }
    return left;
  }

  private parseMultiplicative(): ExprNode {
    let left = this.parseUnary();
    while (this.at(TokenKind.Star, TokenKind.Slash, TokenKind.Percent)) {
      left = this.parseBinary(left, this.advance(), this.parseUnary());
    }
    return left;
  }

  private parseBinary(left: ExprNode, operator: Token, right: ExprNode): BinaryExprNode {
    return {
      kind: "BinaryExpr",
      op: operator.lexeme,
      left,
      right,
      operatorRange: operator.range,
      range: combineRanges(left.range, right.range),
    };
  }

  private parseUnary(): ExprNode {
    if (this.at(TokenKind.Not, TokenKind.Minus)) {
      const operator = this.advance();
      const operand = this.parseUnary();
      return {
        kind: "UnaryExpr",
        op: operator.lexeme,
        operand,
        operatorRange: operator.range,
        range: combineRanges(operator.range, operand.range),
      } satisfies UnaryExprNode;
    }
    if (this.at(TokenKind.Star)) {
      const operator = this.advance();
      const operand = this.parseUnary();
      return {
        kind: "DerefExpr",
        operand,
        operatorRange: operator.range,
        range: combineRanges(operator.range, operand.range),
      };
    }
    if (this.at(TokenKind.Ampersand)) {
      const operator = this.advance();
      const operand = this.parseUnary();
      return {
        kind: "AddressOfExpr",
        operand,
        operatorRange: operator.range,
        range: combineRanges(operator.range, operand.range),
      };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ExprNode {
    let expr = this.parsePrimary();
    while (true) {
      if (this.match(TokenKind.Dot)) {
        const name = this.expect(TokenKind.Identifier, "expected field or method name after '.'");
        if (this.match(TokenKind.LParen)) {
          const args = this.parseArgList();
          const end = this.expect(TokenKind.RParen);
          expr = {
            kind: "MethodCallExpr",
            obj: expr,
            method: name.value,
            methodRange: name.range,
            args,
            range: combineRanges(expr.range, end.range),
          } satisfies MethodCallExprNode;
        } else {
          expr = {
            kind: "FieldAccessExpr",
            obj: expr,
            fieldName: name.value,
            fieldRange: name.range,
            range: combineRanges(expr.range, name.range),
          } satisfies FieldAccessExprNode;
        }
        continue;
      }
      if (this.match(TokenKind.LBracket)) {
        const index = this.parseExpr();
        const end = this.expect(TokenKind.RBracket);
        expr = {
          kind: "IndexExpr",
          obj: expr,
          index,
          range: combineRanges(expr.range, end.range),
        } satisfies IndexExprNode;
        continue;
      }
      if (this.at(TokenKind.PlusPlus, TokenKind.MinusMinus)) {
        const operator = this.advance();
        expr = {
          kind: "UnaryExpr",
          op: operator.kind === TokenKind.PlusPlus ? "post++" : "post--",
          operand: expr,
          operatorRange: operator.range,
          range: combineRanges(expr.range, operator.range),
        } satisfies UnaryExprNode;
        continue;
      }
      break;
    }
    return expr;
  }

  private parsePrimary(): ExprNode {
    const token = this.current();
    if (this.at(TokenKind.IntLiteral)) {
      this.advance();
      return {
        kind: "IntLiteral",
        value: parseIntegerToken(token.value),
        range: token.range,
      } satisfies IntLiteralNode;
    }
    if (this.at(TokenKind.FloatLiteral)) {
      this.advance();
      return {
        kind: "FloatLiteral",
        value: Number(token.value.replaceAll("_", "")),
        range: token.range,
      } satisfies FloatLiteralNode;
    }
    if (this.at(TokenKind.StringLiteral)) {
      this.advance();
      return {
        kind: "StringLiteral",
        value: token.value,
        range: token.range,
      } satisfies StringLiteralNode;
    }
    if (this.at(TokenKind.CharLiteral)) {
      this.advance();
      return {
        kind: "CharLiteral",
        value: token.value,
        range: token.range,
      } satisfies CharLiteralNode;
    }
    if (this.at(TokenKind.BoolTrue, TokenKind.BoolFalse)) {
      this.advance();
      return {
        kind: "BoolLiteral",
        value: token.kind === TokenKind.BoolTrue,
        range: token.range,
      } satisfies BoolLiteralNode;
    }
    if (this.at(TokenKind.NullLiteral)) {
      this.advance();
      return {
        kind: "NullLiteral",
        range: token.range,
      } satisfies NullLiteralNode;
    }
    if (this.at(TokenKind.LBrace)) {
      return this.parseMultiDispatch();
    }
    if (this.at(TokenKind.BiInit)) {
      return this.parseInitExpr();
    }
    if (this.at(TokenKind.BiMalloc)) {
      return this.parseMallocExpr();
    }
    if (this.at(TokenKind.BiSizeOf)) {
      return this.parseSizeOfExpr();
    }
    if (this.at(TokenKind.BiCast)) {
      return this.parseCastExpr();
    }
    if (this.at(TokenKind.Identifier)) {
      const name = this.advance();
      const id: IdentifierExprNode = {
        kind: "IdentifierExpr",
        name: name.value,
        nameRange: name.range,
        range: name.range,
      };
      if (this.match(TokenKind.LParen)) {
        const args = this.parseArgList();
        const end = this.expect(TokenKind.RParen);
        return {
          kind: "CallExpr",
          callee: id,
          args,
          range: combineRanges(id.range, end.range),
        } satisfies CallExprNode;
      }
      return id;
    }
    if (this.match(TokenKind.LParen)) {
      const expr = this.parseExpr();
      this.expect(TokenKind.RParen);
      return expr;
    }
    this.error(token, "vela.parse.unexpectedExpression", `unexpected token in expression: ${this.tokenLabel(token)}`, "expected a literal, identifier, call, built-in, or parenthesized expression");
    this.advance();
    return missingExpr(token.range);
  }

  private parseInitExpr(): InitExprNode {
    const start = this.expect(TokenKind.BiInit);
    this.expect(TokenKind.Lt);
    const className = this.expect(TokenKind.Identifier, "expected class name in Init<T>");
    this.expect(TokenKind.Gt);
    this.expect(TokenKind.LParen);
    const kwargs: InitExprNode["kwargs"] = [];
    while (!this.at(TokenKind.RParen, TokenKind.Eof)) {
      const key = this.expect(TokenKind.Identifier, "expected Init<T> argument name");
      this.expect(TokenKind.Colon);
      const value = this.parseExpr();
      kwargs.push({ name: key.value, nameRange: key.range, value });
      if (!this.match(TokenKind.Comma)) {
        break;
      }
    }
    const end = this.expect(TokenKind.RParen);
    return {
      kind: "InitExpr",
      className: className.value,
      classNameRange: className.range,
      kwargs,
      range: combineRanges(start.range, end.range),
    };
  }

  private parseMallocExpr(): MallocExprNode {
    const start = this.expect(TokenKind.BiMalloc);
    this.expect(TokenKind.LParen);
    const size = this.parseExpr();
    const end = this.expect(TokenKind.RParen);
    return {
      kind: "MallocExpr",
      size,
      range: combineRanges(start.range, end.range),
    };
  }

  private parseSizeOfExpr(): SizeOfExprNode {
    const start = this.expect(TokenKind.BiSizeOf);
    this.expect(TokenKind.LParen);
    const targetType = this.parseTypeExpr();
    const end = this.expect(TokenKind.RParen);
    return {
      kind: "SizeOfExpr",
      targetType,
      range: combineRanges(start.range, end.range),
    };
  }

  private parseCastExpr(): CastExprNode {
    const start = this.expect(TokenKind.BiCast);
    this.expect(TokenKind.Lt);
    const targetType = this.parseTypeExpr();
    this.expect(TokenKind.Gt);
    this.expect(TokenKind.LParen);
    const operand = this.parseExpr();
    const end = this.expect(TokenKind.RParen);
    return {
      kind: "CastExpr",
      targetType,
      operand,
      range: combineRanges(start.range, end.range),
    };
  }

  private parseMultiDispatch(): MultiDispatchExprNode {
    const start = this.expect(TokenKind.LBrace);
    const targets: ExprNode[] = [];
    while (!this.at(TokenKind.RBrace, TokenKind.Eof)) {
      targets.push(this.parseExpr());
      if (!this.match(TokenKind.Comma)) {
        break;
      }
    }
    this.expect(TokenKind.RBrace);
    this.expect(TokenKind.Dot);
    const method = this.expect(TokenKind.Identifier, "expected multi-dispatch method name");
    this.expect(TokenKind.LParen);
    const args = this.parseArgList();
    const end = this.expect(TokenKind.RParen);
    return {
      kind: "MultiDispatchExpr",
      targets,
      method: method.value,
      methodRange: method.range,
      args,
      range: combineRanges(start.range, end.range),
    };
  }

  private parseArgList(): ExprNode[] {
    const args: ExprNode[] = [];
    if (this.at(TokenKind.RParen, TokenKind.Eof)) {
      return args;
    }
    args.push(this.parseExpr());
    while (this.match(TokenKind.Comma)) {
      if (this.at(TokenKind.RParen, TokenKind.Eof)) {
        break;
      }
      args.push(this.parseExpr());
    }
    return args;
  }

  private synchronize(sync: Set<TokenKind>): void {
    while (!this.at(TokenKind.Eof) && !sync.has(this.current().kind)) {
      this.advance();
    }
    if (this.at(TokenKind.Semicolon)) {
      this.advance();
    }
  }
}

export function parseVela(text: string, uri: string, tokens: Token[], diagnostics: VelaDiagnostic[]): ParseResult {
  const parser = new Parser(tokens, diagnostics, uri, text);
  const result = parser.parse();
  return { ...result, text };
}

function namedType(name: string, range: VelaRange): NamedTypeNode {
  return {
    kind: "NamedType",
    name,
    nameRange: range,
    range,
  };
}

function missingExpr(range: VelaRange): MissingExprNode {
  return {
    kind: "MissingExpr",
    range,
  };
}

function combineRanges(start: VelaRange, end: VelaRange): VelaRange {
  return makeRange(start.uri, start.start, end.end);
}

function parseIntegerToken(value: string): number {
  const normalized = value.replaceAll("_", "");
  if (normalized.startsWith("0x") || normalized.startsWith("0X")) {
    return Number.parseInt(normalized.slice(2), 16);
  }
  if (normalized.startsWith("0b") || normalized.startsWith("0B")) {
    return Number.parseInt(normalized.slice(2), 2);
  }
  return Number.parseInt(normalized, 10);
}
