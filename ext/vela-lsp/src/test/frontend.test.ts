import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DocumentHighlightKind, InsertTextFormat, SymbolKind } from "vscode-languageserver/node";
import { Lexer } from "../vela/lexer.js";
import { TokenKind, lspPositionToOffset, typeToString, type VelaSymbol } from "../vela/model.js";
import { parseVela } from "../vela/parser.js";
import { WorkspaceIndex } from "../workspace/workspaceIndex.js";
import { BUILTIN_VIRTUAL_URI, builtinVirtualText, codeActions, completions, declaration, definition, documentLinks, documentSymbols, fileDeleteImportEdit, fileRenameImportEdit, foldingRanges, formatting, highlights, hover, implementation, inlayHints, incomingCalls, moniker, outgoingCalls, prepareCallHierarchy, prepareRename, prepareTypeHierarchy, references, rename, resolvableWorkspaceSymbols, resolveDocumentLink, resolveWorkspaceSymbol, selectionRanges, semanticTokenModifiers, semanticTokens, semanticTokenTypes, signatureHelp, subtypes, supertypes, typeDefinition, workspaceSymbols } from "../lsp/features.js";
import { runCompiler } from "../compilerRunner.js";

function parseText(source: string, uri = "file:///test.vl") {
  const lexed = new Lexer(source, uri).tokenize();
  return parseVela(source, uri, lexed.tokens, lexed.diagnostics);
}

function fixtureIndex(source: string) {
  const uri = pathToFileURL(resolve("fixture.vl")).toString();
  const index = new WorkspaceIndex(resolve("."));
  index.configure([resolve("..", "..")], { requireMainDiagnostic: "off" });
  index.updateOpenDocument(uri, source);
  return { index, uri, state: index.get(uri)! };
}

function workspaceFixtureIndex(source: string) {
  const uri = pathToFileURL(resolve("workspace-fixture.vl")).toString();
  const index = new WorkspaceIndex(resolve("."));
  index.configure([resolve("..", "..")], { requireMainDiagnostic: "off" });
  index.indexWorkspace();
  index.updateOpenDocument(uri, source);
  return { index, uri, state: index.get(uri)! };
}

function positionAt(source: string, needle: string, offset = 0) {
  const absolute = source.indexOf(needle) + offset;
  if (absolute < offset) {
    throw new Error(`needle not found: ${needle}`);
  }
  const lines = source.slice(0, absolute).split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

function applyEdit(text: string, edit: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }) {
  const start = lspPositionToOffset(text, edit.range.start);
  const end = lspPositionToOffset(text, edit.range.end);
  return `${text.slice(0, start)}${edit.newText}${text.slice(end)}`;
}

function rangeText(text: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }) {
  return text.slice(lspPositionToOffset(text, range.start), lspPositionToOffset(text, range.end));
}

function applyEdits(text: string, edits: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[]) {
  return [...edits]
    .sort((left, right) => lspPositionToOffset(text, right.range.start) - lspPositionToOffset(text, left.range.start))
    .reduce((current, edit) => applyEdit(current, edit), text);
}

function formatSource(source: string, uri = pathToFileURL(resolve("format-fixture.vl")).toString()) {
  const index = new WorkspaceIndex(resolve("."));
  index.configure([resolve("..", "..")], { requireMainDiagnostic: "off" });
  const state = index.updateOpenDocument(uri, source);
  const [edit] = formatting(state);
  return edit ? applyEdit(source, edit) : source;
}

function velaCodeBlocksFromMarkdown(path: string) {
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(/```vl\r?\n([\s\S]*?)```/gu)]
    .map((match, index) => ({
      label: `${path.replaceAll("\\", "/")}#vl-block-${index + 1}`,
      source: match[1]!.replace(/\r\n/gu, "\n"),
    }))
    .filter((block) => block.source.trim().length > 0);
}

function selectionRangeChain(range: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; parent?: any } | undefined) {
  const chain = [];
  for (let current = range; current; current = current.parent) {
    chain.push(current.range);
  }
  return chain;
}

function decodedSemanticTokens(source: string, data: number[]) {
  const lines = source.split("\n");
  let line = 0;
  let character = 0;
  const tokens: { line: number; character: number; text: string; tokenType: string; tokenModifiers: string[] }[] = [];
  for (let i = 0; i < data.length; i += 5) {
    line += data[i]!;
    character = data[i] === 0 ? character + data[i + 1]! : data[i + 1]!;
    const length = data[i + 2]!;
    const modifierMask = data[i + 4]!;
    tokens.push({
      line,
      character,
      text: lines[line]!.slice(character, character + length),
      tokenType: semanticTokenTypes[data[i + 3]!]!,
      tokenModifiers: semanticTokenModifiers.filter((_, index) => (modifierMask & (1 << index)) !== 0),
    });
  }
  return tokens;
}

const classFixture = `module app {
    class Box {
        I16 value;
        OnAlloc(I16 initial, I16 step) {
            value = initial + step;
        }
        OnFree {}
        I16 Inc(I16 amount) {
            ret value + amount;
        }
    }

    I16 main() {
        Box b = Init<Box>(initial: 1, step: 2);
        Print(b.Inc(1));
        Free(b);
        ret 0;
    }
}`;

describe("Vela lexer", () => {
  it("tokenizes keywords, builtins, tags, literals, comments, and operators", () => {
    const result = new Lexer("module m { [[get, set]] I16 x = 0x10; // c\nPrint(x); }", "file:///test.vl").tokenize();
    expect(result.tokens.map((token) => token.kind)).toContain(TokenKind.KwModule);
    expect(result.tokens.map((token) => token.kind)).toContain(TokenKind.TagOpen);
    expect(result.tokens.map((token) => token.kind)).toContain(TokenKind.BiPrint);
    expect(result.tokens.map((token) => token.kind)).toContain(TokenKind.IntLiteral);
    expect(result.allTokens.map((token) => token.kind)).toContain(TokenKind.Comment);
  });

  it("tokenizes the full prompt keyword, builtin, operator, and punctuation inventory", () => {
    const source = [
      "alias class else for if import module OnAlloc OnFree ret skeleton type while ASM",
      "U0 U8 I8 U16 I16 F16 Ptr Malloc Free Init SizeOf Cast Print true false null ident_123",
      "+ - * / % == != < > <= >= && || ! & = ++ -- += -= *= /= <-",
      "( ) { } [ ] ; , : . :: [[ ]]",
      "// slash comment",
      "# hash comment",
    ].join("\n");
    const result = new Lexer(source, "file:///tokens.vl").tokenize();
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens.map((token) => token.kind)).toEqual([
      TokenKind.KwAlias,
      TokenKind.KwClass,
      TokenKind.KwElse,
      TokenKind.KwFor,
      TokenKind.KwIf,
      TokenKind.KwImport,
      TokenKind.KwModule,
      TokenKind.KwOnAlloc,
      TokenKind.KwOnFree,
      TokenKind.KwRet,
      TokenKind.KwSkeleton,
      TokenKind.KwType,
      TokenKind.KwWhile,
      TokenKind.KwAsm,
      TokenKind.TyU0,
      TokenKind.TyU8,
      TokenKind.TyI8,
      TokenKind.TyU16,
      TokenKind.TyI16,
      TokenKind.TyF16,
      TokenKind.TyPtr,
      TokenKind.BiMalloc,
      TokenKind.BiFree,
      TokenKind.BiInit,
      TokenKind.BiSizeOf,
      TokenKind.BiCast,
      TokenKind.BiPrint,
      TokenKind.BoolTrue,
      TokenKind.BoolFalse,
      TokenKind.NullLiteral,
      TokenKind.Identifier,
      TokenKind.Plus,
      TokenKind.Minus,
      TokenKind.Star,
      TokenKind.Slash,
      TokenKind.Percent,
      TokenKind.Eq,
      TokenKind.Neq,
      TokenKind.Lt,
      TokenKind.Gt,
      TokenKind.Lte,
      TokenKind.Gte,
      TokenKind.And,
      TokenKind.Or,
      TokenKind.Not,
      TokenKind.Ampersand,
      TokenKind.Assign,
      TokenKind.PlusPlus,
      TokenKind.MinusMinus,
      TokenKind.PlusEq,
      TokenKind.MinusEq,
      TokenKind.StarEq,
      TokenKind.SlashEq,
      TokenKind.Arrow,
      TokenKind.LParen,
      TokenKind.RParen,
      TokenKind.LBrace,
      TokenKind.RBrace,
      TokenKind.LBracket,
      TokenKind.RBracket,
      TokenKind.Semicolon,
      TokenKind.Comma,
      TokenKind.Colon,
      TokenKind.Dot,
      TokenKind.DoubleColon,
      TokenKind.TagOpen,
      TokenKind.TagClose,
      TokenKind.Eof,
    ]);
    expect(result.allTokens.filter((token) => token.kind === TokenKind.Comment).map((token) => token.lexeme)).toEqual([
      "// slash comment",
      "# hash comment",
    ]);
  });

  it("tokenizes decimal, hex, binary, and float literal forms", () => {
    const result = new Lexer("0 65_535 0xCA_FE 0b1010_0101 1.0 1_2.3_4 1e-2 6.5E+1", "file:///numbers.vl").tokenize();
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens.map((token) => [token.kind, token.lexeme])).toEqual([
      [TokenKind.IntLiteral, "0"],
      [TokenKind.IntLiteral, "65_535"],
      [TokenKind.IntLiteral, "0xCA_FE"],
      [TokenKind.IntLiteral, "0b1010_0101"],
      [TokenKind.FloatLiteral, "1.0"],
      [TokenKind.FloatLiteral, "1_2.3_4"],
      [TokenKind.FloatLiteral, "1e-2"],
      [TokenKind.FloatLiteral, "6.5E+1"],
      [TokenKind.Eof, ""],
    ]);
  });

  it("reports invalid numeric literals without aborting tokenization", () => {
    const result = new Lexer("module m { I16 x = 0x; I16 y = 1; }", "file:///test.vl").tokenize();
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "vela.lex.invalidNumber")).toBe(true);
    expect(result.tokens.at(-1)?.kind).toBe(TokenKind.Eof);
  });

  it("reports the prompt-listed recoverable lexical diagnostics", () => {
    const cases = [
      { source: "@", code: "vela.lex.unexpectedCharacter" },
      { source: "\"unterminated", code: "vela.lex.unterminatedString" },
      { source: "'x", code: "vela.lex.unterminatedChar" },
      { source: "''", code: "vela.lex.emptyChar" },
      { source: "1__2", code: "vela.lex.invalidNumber" },
      { source: "70000", code: "vela.lex.integerOutOfRange" },
      { source: "'Ā'", code: "vela.lex.charOutOfRange" },
    ];
    for (const { source, code } of cases) {
      const result = new Lexer(source, `file:///${code}.vl`).tokenize();
      expect(result.diagnostics.map((diagnostic) => diagnostic.code), source).toContain(code);
      expect(result.tokens.at(-1)?.kind, source).toBe(TokenKind.Eof);
    }
  });

  it("covers hash comments, escapes, empty chars, and char range diagnostics", () => {
    const result = new Lexer("module m { # hash\nU8 c = '\\n'; Ptr<U8> s = \"a\\t\\\\\\\"\\0\"; U8 empty = ''; U8 wide = 'Ā'; }", "file:///test.vl").tokenize();
    const comments = result.allTokens.filter((token) => token.kind === TokenKind.Comment);
    expect(comments.map((token) => token.lexeme)).toContain("# hash");
    expect(result.tokens.find((token) => token.kind === TokenKind.CharLiteral && token.lexeme === "'\\n'")?.value).toBe("\n");
    expect(result.tokens.find((token) => token.kind === TokenKind.StringLiteral)?.value).toBe("a\t\\\"\0");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      "vela.lex.emptyChar",
      "vela.lex.charOutOfRange",
    ]));
    expect(result.tokens.at(-1)?.kind).toBe(TokenKind.Eof);
  });
});

describe("Vela parser", () => {
  it("parses imports, classes, tags, methods, and builtin expressions", () => {
    const parsed = parseText(`
      module app {
        import stdlib::types::{int};
        class Box {
          [[get, set]] I16 value;
          OnAlloc(I16 v) { value = v; }
          I16 Inc() { value++; ret value; }
        }
        I16 main() {
          Box b = Init<Box>(v: 1);
          ret b.Inc();
        }
      }
    `);
    const module = parsed.program.modules[0]!;
    expect(module.imports[0]?.package).toEqual(["stdlib", "types"]);
    expect(module.body.some((node) => node.kind === "ClassDecl")).toBe(true);
    expect(parsed.diagnostics).toEqual([]);
  });

  it("parses the prompt-listed declaration, statement, expression, and ASM forms", () => {
    const source = `module app {
    import stdlib::{math};
    import stdlib::types::{*};

    alias Word <- Ptr<Ptr<I16>>;
    I16 global = 1;

    type Drawable {
        skeleton U0 Draw(I16 color);
    }

    class Actor : Drawable {
        [[get, set, visible]] I16 value;

        OnAlloc(I16 initial) {
            value = initial;
        }

        OnFree() {
            Free(null);
        }

        U0 Draw(I16 color) {
            ret;
        }
    }

    class Plain {
        OnFree {
            ret;
        }
    }

    I16 helper(I16 a, I16 b) {
        ret a + b;
    }

    I16 main() {
        I16 total = 0;
        Ptr<I16> ptr = &global;
        Actor a = Init<Actor>(initial: 1);
        Actor b = Init<Actor>(initial: helper(1, 2));
        total = -total + *ptr;
        total += a.value;
        total -= b.value;
        total *= 2;
        total /= 1;
        if (!(total == 0) && true || false) {
            total++;
        } else if (total < 10) {
            total--;
        } else {
            total = Cast<I16>(SizeOf(Ptr<I16>));
        }
        while (total <= 20) {
            total = total + 1;
        }
        for (I16 i = 0; i < 3; i++) {
            ptr[i] = total % 2;
        }
        Print(total, "fmt");
        ASM(
            [[in]] R0 = total;
            [[out]] R1 = total;
        ) {
            MOV R1, R0
        }
        {a, b}.Draw(total);
        Free(a);
        ret Malloc(2)[0];
    }
}`;
    const parsed = parseText(source);
    expect(parsed.diagnostics).toEqual([]);
    const [module] = parsed.program.modules;
    expect(module?.imports).toHaveLength(2);
    expect(module?.imports[1]?.wildcard).toBe(true);

    const alias = module?.body.find((node) => node.kind === "AliasDecl") as any;
    expect(alias?.targetType.kind).toBe("PtrType");
    expect(alias?.targetType.inner.kind).toBe("PtrType");

    const drawable = module?.body.find((node) => node.kind === "TypeDecl" && node.name === "Drawable") as any;
    expect(drawable?.methods[0]).toMatchObject({ kind: "FunctionDecl", name: "Draw", isSkeleton: true });

    const actor = module?.body.find((node) => node.kind === "ClassDecl" && node.name === "Actor") as any;
    expect(actor?.parent).toBe("Drawable");
    expect(actor?.fields[0]?.tags).toEqual(["get", "set", "visible"]);
    expect(actor?.onAlloc?.params.map((param: any) => param.name)).toEqual(["initial"]);
    expect(actor?.onFree?.name).toBe("OnFree");
    expect(actor?.methods.map((method: any) => method.name)).toContain("Draw");

    const plain = module?.body.find((node) => node.kind === "ClassDecl" && node.name === "Plain") as any;
    expect(plain?.onFree?.body[0]?.kind).toBe("ReturnStmt");

    const main = module?.body.find((node) => node.kind === "FunctionDecl" && node.name === "main") as any;
    const statements = main?.body ?? [];
    expect(statements.map((stmt: any) => stmt.kind)).toEqual(expect.arrayContaining([
      "VarDecl",
      "Assignment",
      "IfStmt",
      "WhileStmt",
      "ForStmt",
      "PrintStmt",
      "AsmBlock",
      "ExprStmt",
      "FreeStmt",
      "ReturnStmt",
    ]));
    const assignments = statements.filter((stmt: any) => stmt.kind === "Assignment");
    expect(assignments.map((stmt: any) => stmt.op)).toEqual(["=", "+=", "-=", "*=", "/="]);

    const ptrDecl = statements.find((stmt: any) => stmt.kind === "VarDecl" && stmt.name === "ptr");
    expect(ptrDecl?.initializer?.kind).toBe("AddressOfExpr");
    const actorInit = statements.find((stmt: any) => stmt.kind === "VarDecl" && stmt.name === "a");
    expect(actorInit?.initializer).toMatchObject({ kind: "InitExpr", className: "Actor", kwargs: [{ name: "initial" }] });

    expect(assignments[0]?.value.kind).toBe("BinaryExpr");
    const ifStmt = statements.find((stmt: any) => stmt.kind === "IfStmt");
    expect(ifStmt?.elseBody[0]?.kind).toBe("IfStmt");
    const forStmt = statements.find((stmt: any) => stmt.kind === "ForStmt");
    expect(forStmt?.init?.kind).toBe("VarDecl");
    expect(forStmt?.update?.kind).toBe("ExprStmt");
    expect(forStmt?.body[0]).toMatchObject({ kind: "Assignment", target: { kind: "IndexExpr" } });
    const printStmt = statements.find((stmt: any) => stmt.kind === "PrintStmt");
    expect(printStmt?.fmt?.kind).toBe("StringLiteral");
    const asm = statements.find((stmt: any) => stmt.kind === "AsmBlock");
    expect(asm?.bindings.map((binding: any) => [binding.direction, binding.register, binding.variable])).toEqual([
      ["in", "R0", "total"],
      ["out", "R1", "total"],
    ]);
    expect(asm?.body.join("\n")).toContain("MOV R1 , R0");
    const multiDispatch = statements.find((stmt: any) => stmt.kind === "ExprStmt" && stmt.expr.kind === "MultiDispatchExpr");
    expect(multiDispatch?.expr).toMatchObject({ kind: "MultiDispatchExpr", method: "Draw" });
    const ret = statements.at(-1);
    expect(ret?.kind).toBe("ReturnStmt");
    expect(ret?.value?.kind).toBe("IndexExpr");
  });

  it("recovers enough structure from partial files", () => {
    const parsed = parseText("module app { I16 main() { I16 x = ; ret x; }");
    expect(parsed.program.modules[0]?.body.length).toBeGreaterThan(0);
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
  });

  it("recovers from assignment-style for updates without cascading diagnostics", () => {
    const source = "module app { I16 main() { I16 total = 0; for (I16 i = 0; i < 3; i = i + 1) { total += i; } ret total; } }";
    const parsed = parseText(source);
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["vela.parse.forUpdateAssignment"]);

    const { index, state } = fixtureIndex(source);
    const diagnostics = index.lspDiagnostics(state.uri);
    expect(diagnostics.filter((diagnostic) => diagnostic.code === "vela.parse.forUpdateAssignment")).toHaveLength(1);
    expect(diagnostics.some((diagnostic) => diagnostic.code === "vela.parse.expectedToken")).toBe(false);
    expect(diagnostics.some((diagnostic) => diagnostic.code === "vela.sem.missingReturn")).toBe(false);
  });

  it("accepts reserved literal spelling in module and import module positions", () => {
    const parsed = parseText("module null { alias NULL <- Ptr<U0>; } module app { import stdlib::types::{null}; }");
    expect(parsed.program.modules.map((module) => module.name)).toEqual(["null", "app"]);
    expect(parsed.program.modules[1]?.imports[0]?.modules).toEqual(["null"]);
    expect(parsed.diagnostics).toEqual([]);
  });
});

describe("Workspace index and LSP features", () => {
  it("indexes examples and provides symbols, hover, references, and completions", () => {
    const root = resolve("..", "..");
    const index = new WorkspaceIndex(resolve("."));
    index.configure([root], { requireMainDiagnostic: "off" });
    index.indexWorkspace();
    const uri = `file:///${resolve(root, "examples", "hello.vl").replaceAll("\\", "/")}`;
    const state = index.get(uri) ?? index.ensureFileByPath(resolve(root, "examples", "hello.vl"));
    expect(state).toBeDefined();
    expect(state!.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    expect(documentSymbols(state!).some((symbol) => symbol.name === "hello")).toBe(true);
    const topLevelCompletions = completions(index, uri, { line: 2, character: 8 });
    expect(topLevelCompletions.some((item) => item.label === "Print")).toBe(true);
    const print = topLevelCompletions.find((item) => item.label === "Print");
    expect(print?.commitCharacters).toContain("(");
    expect(print?.insertText).toBe("Print(${1:value})");
    expect(print?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    const builtinSnippets = new Map([
      ["Malloc", "Malloc(${1:size})"],
      ["Free", "Free(${1:pointer})"],
      ["Init", "Init<${1:Class}>(${2:name}: ${3:value})"],
      ["SizeOf", "SizeOf(${1:I16})"],
      ["Cast", "Cast<${1:I16}>(${2:expr})"],
      ["Print", "Print(${1:value})"],
    ]);
    for (const [label, snippet] of builtinSnippets) {
      const item = topLevelCompletions.find((candidate) => candidate.label === label);
      expect(item?.insertText, label).toBe(snippet);
      expect(item?.insertTextFormat, label).toBe(InsertTextFormat.Snippet);
    }
    expect(topLevelCompletions.find((item) => item.label === "Ptr")?.insertText).toBe("Ptr<${1:I16}>");
    expect(topLevelCompletions.find((item) => item.label === "OnFree")?.insertText).toBe("OnFree() {\n    $0\n}");
    expect(hover(index, uri, { line: 2, character: 12 })?.contents).toBeDefined();
    const refLocations = references(index, uri, { line: 2, character: 12 }, true);
    expect(refLocations.length).toBeGreaterThan(0);
  });

  it("adds stdlib auto-import completion edits only when the import is missing", () => {
    const missingImport = `module app {
    I16 main() {
        In
    }
}`;
    const missing = workspaceFixtureIndex(missingImport);
    const missingInt = completions(missing.index, missing.uri, positionAt(missingImport, "In", "In".length)).find((item) => item.label === "Int");
    expect(missingInt?.additionalTextEdits?.[0]?.newText).toBe("    import stdlib::types::{int};\n");

    const samePackageImport = `module app {
    import stdlib::types::{int};

    I16 main() {
        Bo
    }
}`;
    const samePackage = workspaceFixtureIndex(samePackageImport);
    const samePackageBool = completions(samePackage.index, samePackage.uri, positionAt(samePackageImport, "Bo", "Bo".length)).find((item) => item.label === "Bool");
    expect(samePackageBool?.additionalTextEdits?.[0]?.newText).toBe(", bool");
    expect(applyEdit(samePackage.state.text, samePackageBool?.additionalTextEdits?.[0]!)).toContain("    import stdlib::types::{int, bool};");

    const wildcardImport = `module app {
    import stdlib::types::{*};

    I16 main() {
        In
    }
}`;
    const wildcard = workspaceFixtureIndex(wildcardImport);
    const wildcardInt = completions(wildcard.index, wildcard.uri, positionAt(wildcardImport, "In", "In".length)).find((item) => item.label === "Int");
    expect(wildcardInt).toBeDefined();
    expect(wildcardInt?.additionalTextEdits).toBeUndefined();

    const explicitImport = `module app {
    import stdlib::types::{ int };

    I16 main() {
        In
    }
}`;
    const explicit = workspaceFixtureIndex(explicitImport);
    const explicitInt = completions(explicit.index, explicit.uri, positionAt(explicitImport, "In", "In".length)).find((item) => item.label === "Int");
    expect(explicitInt).toBeDefined();
    expect(explicitInt?.additionalTextEdits).toBeUndefined();
  });

  it("scopes local and field completion candidates to the current function and class", () => {
    const source = `module app {
    class A {
        I16 onlyA;
    }

    class B {
        I16 own;

        I16 Read() {
            o
            ret own;
        }
    }

    I16 first() {
        I16 secret = 1;
        ret secret;
    }

    I16 main() {
        I16 local = 0;
        lo
        ret local;
    }
}`;
    const { index, uri } = fixtureIndex(source);
    const mainLabels = completions(index, uri, positionAt(source, "lo\n        ret local", "lo".length)).map((item) => item.label);
    expect(mainLabels).toContain("local");
    expect(mainLabels).not.toContain("secret");
    expect(mainLabels).not.toContain("onlyA");
    expect(mainLabels).not.toContain("own");

    const methodLabels = completions(index, uri, positionAt(source, "o\n            ret own", "o".length)).map((item) => item.label);
    expect(methodLabels).toContain("own");
    expect(methodLabels).not.toContain("onlyA");
    expect(methodLabels).not.toContain("secret");
  });

  it("does not leak top-level completions across modules in the same file", () => {
    const source = `module first {
    class Hidden {
    }

    I16 hidden() {
        ret 1;
    }
}

module second {
    I16 visible() {
        ret 2;
    }

    I16 main() {

        ret visible();
    }
}`;
    const { index, uri } = fixtureIndex(source);
    const labels = completions(index, uri, positionAt(source, "ret visible")).map((item) => item.label);
    expect(labels).toContain("visible");
    expect(labels).not.toContain("hidden");
    expect(labels).not.toContain("Hidden");
  });

  it("reports class, skeleton, and tag-generated methods as document symbols", () => {
    const source = `module app {
    type Shape {
        skeleton U0 Draw();
    }

    class Box : Shape {
        [[get, set]] I16 value;

        U0 Draw() {
            ret;
        }
    }

    I16 main(I16 seed) {
        I16 total = seed;
        {
            I16 inner = total;
        }
        for (I16 i = 0; i < 2; i++) {
            I16 loopValue = i;
        }
        ret total;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const [module] = documentSymbols(state);
    const shape = module?.children?.find((symbol) => symbol.name === "Shape");
    expect(shape?.children?.find((symbol) => symbol.name === "Draw")?.kind).toBe(SymbolKind.Method);

    const box = module?.children?.find((symbol) => symbol.name === "Box");
    const children = box?.children ?? [];
    expect(children.find((symbol) => symbol.name === "Draw")?.kind).toBe(SymbolKind.Method);
    expect(children.find((symbol) => symbol.name === "GetValue")?.kind).toBe(SymbolKind.Method);
    expect(children.find((symbol) => symbol.name === "SetValue")?.kind).toBe(SymbolKind.Method);
    expect(children.find((symbol) => symbol.name === "value")?.kind).toBe(SymbolKind.Field);

    const main = module?.children?.find((symbol) => symbol.name === "main");
    expect(main?.children?.map((symbol) => symbol.name)).toEqual(["seed", "total", "inner", "i", "loopValue"]);
    expect(main?.children?.every((symbol) => symbol.kind === SymbolKind.Variable)).toBe(true);
  });

  it("orders workspace symbols by match quality", () => {
    const source = `module app {
    I16 SpriteRender() {
        ret 0;
    }

    I16 RenderSprite() {
        ret 0;
    }

    I16 Render() {
        ret 0;
    }
}`;
    const { index, uri } = fixtureIndex(source);
    const names = workspaceSymbols(index, "Render")
      .filter((symbol) => symbol.location.uri === uri)
      .map((symbol) => symbol.name);
    expect(names).toEqual(["Render", "RenderSprite", "SpriteRender"]);
  });

  it("returns resolvable workspace symbols with stable data and resolved ranges", () => {
    const source = `module app {
    I16 Render() {
        ret 0;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    const [symbol] = resolvableWorkspaceSymbols(index, "Render").filter((item) => item.location.uri === uri);
    expect(symbol?.name).toBe("Render");
    expect("range" in symbol!.location).toBe(false);
    expect(symbol?.data).toMatchObject({ symbolId: expect.any(String) });

    const resolved = resolveWorkspaceSymbol(index, symbol!);
    expect(resolved.location.uri).toBe(uri);
    expect("range" in resolved.location).toBe(true);
    expect(rangeText(state.text, (resolved.location as { range: { start: { line: number; character: number }; end: { line: number; character: number } } }).range)).toBe("Render");
  });

  it("refreshes closed disk files without replacing open document snapshots", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-"));
    const filePath = join(tempRoot, "lib.vl");
    const uri = pathToFileURL(filePath).toString();
    const index = new WorkspaceIndex(resolve("."));
    index.configure([tempRoot], { requireMainDiagnostic: "off" });

    try {
      writeFileSync(filePath, "module app { I16 value() { ret 1; } }");
      index.refreshDiskFile(filePath);
      expect(workspaceSymbols(index, "value").some((symbol) => symbol.name === "value")).toBe(true);

      writeFileSync(filePath, "module app { I16 changed() { ret 2; } }");
      index.refreshDiskFile(filePath);
      expect(workspaceSymbols(index, "changed").some((symbol) => symbol.name === "changed")).toBe(true);
      expect(workspaceSymbols(index, "value").some((symbol) => symbol.name === "value")).toBe(false);

      index.updateOpenDocument(uri, "module app { I16 openName() { ret 3; } }");
      writeFileSync(filePath, "module app { I16 diskName() { ret 4; } }");
      index.refreshDiskFile(filePath);
      expect(index.get(uri)?.text).toContain("openName");
      expect(index.get(uri)?.text).not.toContain("diskName");

      index.closeDocument(uri);
      expect(index.get(uri)?.text).toContain("diskName");
      expect(workspaceSymbols(index, "diskName").some((symbol) => symbol.name === "diskName")).toBe(true);
      expect(workspaceSymbols(index, "openName").some((symbol) => symbol.name === "openName")).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reanalyzes importers when an imported file changes", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-deps-"));
    const libRoot = join(tempRoot, "lib");
    const helperPath = join(libRoot, "helpers.vl");
    const appPath = join(tempRoot, "app.vl");
    const index = new WorkspaceIndex(resolve("."));
    index.configure([tempRoot], { requireMainDiagnostic: "off" });

    try {
      mkdirSync(libRoot, { recursive: true });
      writeFileSync(helperPath, "module helpers { I16 Helper() { ret 1; } }");
      writeFileSync(appPath, "module app { import lib::{helpers}; I16 main() { ret Helper(); } }");
      index.indexWorkspace();
      const appUri = pathToFileURL(appPath).toString();
      const helperUri = pathToFileURL(helperPath).toString();
      expect(index.lspDiagnostics(appUri).filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

      index.updateOpenDocument(helperUri, "module helpers { I16 Renamed() { ret 1; } }");
      expect(index.lspDiagnostics(appUri).some((diagnostic) =>
        diagnostic.code === "vela.sem.unknownIdentifier"
        && typeof diagnostic.message === "string"
        && diagnostic.message.includes("'Helper'"))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("updates importer dependency mappings when open document imports change", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-dep-map-"));
    const libRoot = join(tempRoot, "lib");
    const helperPath = join(libRoot, "helpers.vl");
    const otherPath = join(libRoot, "other.vl");
    const appPath = join(tempRoot, "app.vl");
    const index = new WorkspaceIndex(resolve("."));
    index.configure([tempRoot], { requireMainDiagnostic: "off" });

    try {
      mkdirSync(libRoot, { recursive: true });
      writeFileSync(helperPath, "module helpers { I16 Helper() { ret 1; } }");
      writeFileSync(otherPath, "module other { I16 Other() { ret 2; } }");
      writeFileSync(appPath, "module app { import lib::{helpers}; I16 main() { ret Helper(); } }");
      index.indexWorkspace();

      const appUri = pathToFileURL(appPath).toString();
      const otherUri = pathToFileURL(otherPath).toString();
      const internals = index as unknown as { importedPathToUris: Map<string, Set<string>> };
      expect(internals.importedPathToUris.get(helperPath)?.has(appUri)).toBe(true);
      expect(internals.importedPathToUris.get(otherPath)?.has(appUri)).not.toBe(true);

      index.updateOpenDocument(appUri, "module app { import lib::{other}; I16 main() { ret Other(); } }");
      expect(index.lspDiagnostics(appUri).filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
      expect(internals.importedPathToUris.get(helperPath)?.has(appUri)).not.toBe(true);
      expect(internals.importedPathToUris.get(otherPath)?.has(appUri)).toBe(true);

      rmSync(otherPath, { force: true });
      index.removeFile(otherUri);
      expect(index.lspDiagnostics(appUri).some((diagnostic) => diagnostic.code === "vela.import.unresolved")).toBe(true);
      expect(index.lspDiagnostics(appUri).some((diagnostic) =>
        diagnostic.code === "vela.sem.unknownIdentifier"
        && typeof diagnostic.message === "string"
        && diagnostic.message.includes("'Other'"))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("updates symbol and reference indexes when open documents change", () => {
    const uri = pathToFileURL(resolve("reference-index.vl")).toString();
    const index = new WorkspaceIndex(resolve("."));
    index.configure([resolve("..", "..")], { requireMainDiagnostic: "off" });
    index.updateOpenDocument(uri, `module app {
    I16 Helper() {
        ret 1;
    }

    I16 main() {
        ret Helper();
    }
}`);

    let helper = index.allSymbols().find((symbol) => symbol.kind === "function" && symbol.name === "Helper");
    expect(helper).toBeDefined();
    const helperId = helper!.id;
    expect(index.symbolById(helperId)?.name).toBe("Helper");
    expect(index.referencesFor(helperId, true)).toHaveLength(2);
    expect(index.referencesFor(helperId, false)).toHaveLength(1);

    index.updateOpenDocument(uri, `module app {
    I16 Helper() {
        ret 1;
    }

    I16 main() {
        ret 0;
    }
}`);
    helper = index.allSymbols().find((symbol) => symbol.kind === "function" && symbol.name === "Helper");
    expect(helper).toBeDefined();
    expect(index.referencesFor(helper!.id, true)).toHaveLength(1);
    expect(index.referencesFor(helper!.id, false)).toEqual([]);

    index.updateOpenDocument(uri, "module app { I16 main() { ret 0; } }");
    expect(index.symbolById(helperId)).toBeUndefined();
    expect(index.allSymbols().some((symbol) => symbol.id === helperId || symbol.name === "Helper")).toBe(false);
  });

  it("reanalyzes importers when an imported file is removed", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-remove-"));
    const libRoot = join(tempRoot, "lib");
    const helperPath = join(libRoot, "helpers.vl");
    const appPath = join(tempRoot, "app.vl");
    const index = new WorkspaceIndex(resolve("."));
    index.configure([tempRoot], { requireMainDiagnostic: "off" });

    try {
      mkdirSync(libRoot, { recursive: true });
      writeFileSync(helperPath, "module helpers { I16 Helper() { ret 1; } }");
      writeFileSync(appPath, "module app { import lib::{helpers}; I16 main() { ret Helper(); } }");
      index.indexWorkspace();
      const appUri = pathToFileURL(appPath).toString();
      const helperUri = pathToFileURL(helperPath).toString();
      expect(index.lspDiagnostics(appUri).filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

      rmSync(helperPath, { force: true });
      index.removeFile(helperUri);
      expect(index.lspDiagnostics(appUri).some((diagnostic) => diagnostic.code === "vela.import.unresolved")).toBe(true);
      expect(index.lspDiagnostics(appUri).some((diagnostic) =>
        diagnostic.code === "vela.sem.unknownIdentifier"
        && typeof diagnostic.message === "string"
        && diagnostic.message.includes("'Helper'"))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reanalyzes wildcard importers when an imported file is removed", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-wildcard-remove-"));
    const libRoot = join(tempRoot, "lib");
    const helperPath = join(libRoot, "helpers.vl");
    const appPath = join(tempRoot, "app.vl");
    const index = new WorkspaceIndex(resolve("."));
    index.configure([tempRoot], { requireMainDiagnostic: "off" });

    try {
      mkdirSync(libRoot, { recursive: true });
      writeFileSync(helperPath, "module helpers { I16 Helper() { ret 1; } }");
      writeFileSync(appPath, "module app { import lib::{*}; I16 main() { ret Helper(); } }");
      index.indexWorkspace();
      const appUri = pathToFileURL(appPath).toString();
      const helperUri = pathToFileURL(helperPath).toString();
      expect(index.lspDiagnostics(appUri).filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

      rmSync(helperPath, { force: true });
      index.removeFile(helperUri);
      expect(index.lspDiagnostics(appUri).some((diagnostic) => diagnostic.code === "vela.import.unresolved")).toBe(true);
      expect(index.lspDiagnostics(appUri).some((diagnostic) =>
        diagnostic.code === "vela.sem.unknownIdentifier"
        && typeof diagnostic.message === "string"
        && diagnostic.message.includes("'Helper'"))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("prunes closed files from removed workspace roots while keeping open documents", () => {
    const leftRoot = mkdtempSync(join(tmpdir(), "vela-lsp-left-"));
    const rightRoot = mkdtempSync(join(tmpdir(), "vela-lsp-right-"));
    const leftPath = join(leftRoot, "left.vl");
    const rightPath = join(rightRoot, "right.vl");
    const index = new WorkspaceIndex(resolve("."));

    try {
      writeFileSync(leftPath, "module left { I16 closedLeft() { ret 1; } }");
      writeFileSync(rightPath, "module right { I16 rightOnly() { ret 2; } }");
      index.configure([leftRoot, rightRoot], { requireMainDiagnostic: "off" });
      index.indexWorkspace();
      expect(workspaceSymbols(index, "closedLeft").some((symbol) => symbol.name === "closedLeft")).toBe(true);
      expect(workspaceSymbols(index, "rightOnly").some((symbol) => symbol.name === "rightOnly")).toBe(true);

      index.configure([rightRoot], index.settingsSnapshot());
      index.indexWorkspace();
      expect(workspaceSymbols(index, "closedLeft").some((symbol) => symbol.name === "closedLeft")).toBe(false);
      expect(workspaceSymbols(index, "rightOnly").some((symbol) => symbol.name === "rightOnly")).toBe(true);

      const leftUri = pathToFileURL(leftPath).toString();
      index.updateOpenDocument(leftUri, "module left { I16 openLeft() { ret 3; } }");
      index.indexWorkspace();
      expect(workspaceSymbols(index, "openLeft").some((symbol) => symbol.name === "openLeft")).toBe(true);
    } finally {
      rmSync(leftRoot, { recursive: true, force: true });
      rmSync(rightRoot, { recursive: true, force: true });
    }
  });

  it("uses the workspace folder as project root while keeping bundled stdlib", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-root-"));
    try {
      const index = new WorkspaceIndex(resolve("."));
      index.configure([tempRoot], { requireMainDiagnostic: "off" });
      expect(index.projectRoot()).toBe(resolve(tempRoot));
      expect(index.stdlibDirectory().replaceAll("\\", "/")).toContain("/stdlib");
      expect(index.stdlibDirectory().replaceAll("\\", "/")).not.toContain(tempRoot.replaceAll("\\", "/"));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolves relative projectRoot and stdlibPath settings from the workspace", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-relative-settings-"));
    const projectRoot = join(tempRoot, "project");
    const customStdlib = join(projectRoot, "vendor", "stdlib");
    try {
      mkdirSync(customStdlib, { recursive: true });
      const index = new WorkspaceIndex(resolve("."));
      index.configure([tempRoot], {
        projectRoot: "project",
        stdlibPath: "vendor",
        requireMainDiagnostic: "off",
      });
      expect(index.projectRoot()).toBe(resolve(projectRoot));
      expect(index.stdlibDirectory()).toBe(resolve(customStdlib));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps development commands disabled unless explicitly enabled", () => {
    const index = new WorkspaceIndex(resolve("."));
    index.configure([resolve("..", "..")], { requireMainDiagnostic: "off" });
    expect(index.settingsSnapshot().devCommands.dumpSymbolIndex).toBe(false);

    index.configure([resolve("..", "..")], { requireMainDiagnostic: "off", devCommands: { dumpSymbolIndex: true } });
    expect(index.settingsSnapshot().devCommands.dumpSymbolIndex).toBe(true);
  });

  it("offers Init<T> named argument completions from OnAlloc", () => {
    const source = classFixture.replace("Init<Box>(initial: 1, step: 2)", "Init<Box>()");
    const { index, uri } = fixtureIndex(source);
    const items = completions(index, uri, positionAt(source, "Init<Box>(", "Init<Box>(".length));
    expect(items.find((item) => item.label === "initial")?.insertText).toBe("initial: $0");
    expect(items.find((item) => item.label === "initial")?.commitCharacters).toContain(":");
    expect(items.find((item) => item.label === "step")?.insertText).toBe("step: $0");

    const populated = fixtureIndex(classFixture);
    const editing = completions(populated.index, populated.uri, positionAt(classFixture, "initial: 1", "initial".length));
    expect(editing.some((item) => item.label === "initial")).toBe(true);
    expect(editing.some((item) => item.label === "step")).toBe(false);

    const valueSource = classFixture.replace("Init<Box>(initial: 1, step: 2)", "Init<Box>(initial: local, step: 2)").replace("Box b =", "I16 local = 1;\n        Box b =");
    const valueFixture = fixtureIndex(valueSource);
    const valueItems = completions(valueFixture.index, valueFixture.uri, positionAt(valueSource, "initial: local", "initial: lo".length));
    expect(valueItems.some((item) => item.label === "local")).toBe(true);
    expect(valueItems.some((item) => item.label === "initial" && item.insertText === "initial: $0")).toBe(false);
  });

  it("returns signature help for Init<T> and builtins", () => {
    const { index, uri } = fixtureIndex(classFixture);
    const firstInitHelp = signatureHelp(index, uri, positionAt(classFixture, "initial: 1", "initial: ".length));
    expect(firstInitHelp?.signatures[0]?.label).toContain("Ptr<Box> Init<Box>(initial: I16, step: I16)");
    expect(firstInitHelp?.signatures[0]?.parameters?.map((param) => param.label)).toEqual(["I16 initial", "I16 step"]);
    expect(firstInitHelp?.activeParameter).toBe(0);

    const initHelp = signatureHelp(index, uri, positionAt(classFixture, "step: 2"));
    expect(initHelp?.signatures[0]?.label).toContain("Ptr<Box> Init<Box>");
    expect(initHelp?.activeParameter).toBe(1);

    const nestedSource = classFixture
      .replace("    I16 main()", "    I16 helper(I16 left, I16 right) {\n        ret left + right;\n    }\n\n    I16 main()")
      .replace("step: 2", "step: helper(1, 2)");
    const nested = fixtureIndex(nestedSource);
    const nestedInitHelp = signatureHelp(nested.index, nested.uri, positionAt(nestedSource, "step: helper(1, 2)", "step: helper(1, ".length));
    expect(nestedInitHelp?.signatures[0]?.label).toBe("I16 helper(I16 left, I16 right)");
    expect(nestedInitHelp?.activeParameter).toBe(1);

    const printHelp = signatureHelp(index, uri, positionAt(classFixture, "Print(", "Print(".length));
    expect(printHelp?.signatures[0]?.label).toBe("U0 Print(value)");
  });

  it("resolves built-in definitions to a virtual builtins document", () => {
    const source = `module app {
    I16 main() {
        Print(SizeOf(I16));
        ret 0;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const [printDefinition] = definition(index, uri, positionAt(source, "Print("));
    expect(printDefinition?.uri).toBe(BUILTIN_VIRTUAL_URI);
    expect(rangeText(builtinVirtualText(), printDefinition!.range)).toBe("Print");
    const [sizeOfDefinition] = definition(index, uri, positionAt(source, "SizeOf("));
    expect(sizeOfDefinition?.uri).toBe(BUILTIN_VIRTUAL_URI);
    expect(rangeText(builtinVirtualText(), sizeOfDefinition!.range)).toBe("SizeOf");
  });

  it("does not fall back to enclosing declarations for built-in or non-symbol positions", () => {
    const source = `module app {
    I16 helper() {
        ret 1;
    }

    I16 main() {
        Print(helper());
        ret helper();
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

    const printPosition = positionAt(source, "Print(");
    const [printDefinition] = definition(index, uri, printPosition);
    expect(printDefinition?.uri).toBe(BUILTIN_VIRTUAL_URI);
    expect(moniker(index, uri, printPosition)).toEqual([]);
    expect(references(index, uri, printPosition, true)).toEqual([]);
    expect(highlights(index, uri, printPosition)).toEqual([]);
    expect(prepareRename(index, uri, printPosition)).toBeNull();
    expect(rename(index, { textDocument: { uri }, position: printPosition, newName: "Other" })).toEqual({});

    const literalPosition = positionAt(source, "ret 1", "ret ".length);
    expect(moniker(index, uri, literalPosition)).toEqual([]);
    expect(references(index, uri, literalPosition, true)).toEqual([]);
    expect(prepareRename(index, uri, literalPosition)).toBeNull();
  });

  it("scopes monikers according to symbol visibility", () => {
    const source = `module app {
    I16 helper(I16 value) {
        I16 local = value;
        ret local;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

    expect(moniker(index, uri, positionAt(source, "helper(I16"))[0]).toMatchObject({
      kind: "export",
      unique: "global",
    });
    expect(moniker(index, uri, positionAt(source, "value)"))[0]).toMatchObject({
      kind: "local",
      unique: "document",
    });
    expect(moniker(index, uri, positionAt(source, "ret local", "ret ".length))[0]).toMatchObject({
      kind: "local",
      unique: "document",
    });
  });

  it("returns signature help inside function and method declarations", () => {
    const source = `module app {
    class Box {
        OnAlloc(I16 initial, I16 step) {
        }

        OnFree() {
        }

        I16 Inc(I16 amount, I16 delta) {
            ret amount + delta;
        }
    }

    I16 helper(I16 left, I16 right) {
        ret left + right;
    }

    I16 main() {
        ret helper(1, 2);
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

    const onAllocHelp = signatureHelp(index, uri, positionAt(source, "step)"));
    expect(onAllocHelp?.signatures[0]?.label).toBe("U0 OnAlloc(I16 initial, I16 step)");
    expect(onAllocHelp?.activeParameter).toBe(1);

    const onFreeHelp = signatureHelp(index, uri, positionAt(source, "OnFree(", "OnFree(".length));
    expect(onFreeHelp?.signatures[0]?.label).toBe("U0 OnFree()");

    const methodHelp = signatureHelp(index, uri, positionAt(source, "delta)"));
    expect(methodHelp?.signatures[0]?.label).toBe("I16 Inc(I16 amount, I16 delta)");
    expect(methodHelp?.activeParameter).toBe(1);

    const functionHelp = signatureHelp(index, uri, positionAt(source, "right)"));
    expect(functionHelp?.signatures[0]?.label).toBe("I16 helper(I16 left, I16 right)");
    expect(functionHelp?.activeParameter).toBe(1);
  });

  it("resolves method signature help from the receiver type", () => {
    const source = `module app {
    class A {
        I16 Run(I16 only) {
            ret only;
        }
    }

    class B {
        U16 Run(U16 left, U16 right) {
            ret left;
        }
    }

    I16 main() {
        B b;
        U16 value = b.Run(1, 2);
        ret Cast<I16>(value);
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const help = signatureHelp(index, uri, positionAt(source, "2);"));
    expect(help?.signatures[0]?.label).toBe("U16 B.Run(U16 left, U16 right)");
    expect(help?.activeParameter).toBe(1);
  });

  it("uses the innermost nested call for signature help", () => {
    const source = `module app {
    I16 first() {
        ret 1;
    }

    I16 second(I16 left, I16 right) {
        ret left + right;
    }

    I16 outer(I16 left, I16 right) {
        ret left + right;
    }

    I16 main() {
        ret outer(second(1, 2), first());
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

    const inner = signatureHelp(index, uri, positionAt(source, "2),"));
    expect(inner?.signatures[0]?.label).toBe("I16 second(I16 left, I16 right)");
    expect(inner?.activeParameter).toBe(1);

    const outer = signatureHelp(index, uri, positionAt(source, "second(1, 2),", "second(1, 2),".length));
    expect(outer?.signatures[0]?.label).toBe("I16 outer(I16 left, I16 right)");
    expect(outer?.activeParameter).toBe(1);
  });

  it("keeps signature help active parameter within known parameters", () => {
    const source = `module app {
    I16 helper(I16 left, I16 right) {
        ret left + right;
    }

    I16 main() {
        ret helper(1, 2, 3);
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.some((diagnostic) => diagnostic.code === "vela.sem.arity")).toBe(true);
    const help = signatureHelp(index, uri, positionAt(source, "3);"));
    expect(help?.signatures[0]?.label).toBe("I16 helper(I16 left, I16 right)");
    expect(help?.signatures[0]?.parameters).toHaveLength(2);
    expect(help?.activeParameter).toBe(1);
  });

  it("does not guess method signature help when receiver type is unresolved", () => {
    const source = `module app {
    class A {
        I16 Run(I16 only) {
            ret only;
        }
    }

    class B {
        U16 Run(U16 left, U16 right) {
            ret left;
        }
    }

    I16 main() {
        ret missing.Run(1);
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.some((diagnostic) => diagnostic.code === "vela.sem.unknownIdentifier")).toBe(true);
    expect(signatureHelp(index, uri, positionAt(source, "1);"))).toBeNull();
  });

  it("provides parameter inlay hints for calls and Init<T> arguments", () => {
    const source = `module app {
    class Box {
        OnAlloc(I16 initial, I16 step) {
        }
    }

    U0 Take(I16 amount) {
        ret;
    }

    I16 main() {
        Take(1);
        Ptr<U0> raw = Malloc(2);
        Print(Cast<I16>(SizeOf(I16)));
        Free(raw);
        Ptr<Box> b = Init<Box>(value: 1, step: 2);
        ret 0;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const hints = inlayHints(index, state);
    expect(hints.some((hint) => hint.label === "amount:" && hint.position.line === positionAt(source, "Take(1", "Take(".length).line)).toBe(true);
    expect(hints.some((hint) => hint.label === "size:" && hint.position.line === positionAt(source, "Malloc(2", "Malloc(".length).line)).toBe(true);
    expect(hints.some((hint) => hint.label === "value:" && hint.position.line === positionAt(source, "Print(Cast", "Print(".length).line)).toBe(true);
    expect(hints.some((hint) => hint.label === "expr:" && hint.position.line === positionAt(source, "Cast<I16>(SizeOf", "Cast<I16>(".length).line)).toBe(true);
    expect(hints.some((hint) => hint.label === "type:" && hint.position.line === positionAt(source, "SizeOf(I16", "SizeOf(".length).line)).toBe(true);
    expect(hints.some((hint) => hint.label === "value:" && hint.position.line === positionAt(source, "Free(raw", "Free(".length).line)).toBe(true);
    expect(hints.some((hint) => hint.label === "initial:" && hint.position.line === positionAt(source, "value: 1", "value: ".length).line)).toBe(true);
    expect(hints.some((hint) => hint.label === "step:")).toBe(false);
  });

  it("provides useful inferred type inlay hints without unknown error noise", () => {
    const source = `module app {
    I16 main() {
        Ptr<U0> raw = null;
        I16 value = 1 + 2;
        if (value == 3) {
            returnMissing;
        }
        ret value;
    }
}`;
    const uri = pathToFileURL(resolve("inferred-hints.vl")).toString();
    const index = new WorkspaceIndex(resolve("."));
    index.configure([resolve("..", "..")], {
      requireMainDiagnostic: "off",
      inlayHints: { parameterNames: false, inferredTypes: true, layout: false },
    });
    const state = index.updateOpenDocument(uri, source);
    expect(state.analysis.diagnostics.some((diagnostic) => diagnostic.code === "vela.sem.unknownIdentifier")).toBe(true);

    const hints = inlayHints(index, state);
    expect(hints.some((hint) => hint.label === ": Ptr<U0>" && hint.position.line === positionAt(source, "null").line)).toBe(true);
    expect(hints.some((hint) => hint.label === ": I16" && hint.position.line === positionAt(source, "1 + 2").line)).toBe(true);
    expect(hints.some((hint) => hint.label === ": Bool" && hint.position.line === positionAt(source, "value == 3").line)).toBe(true);
    expect(hints.some((hint) => String(hint.label).includes("unknown") || String(hint.label).includes("Missing"))).toBe(false);
  });

  it("provides layout inlay hints for class size, field offsets, and vtable slots", () => {
    const source = `module app {
    class Base {
        I16 root;

        I16 Foo() {
            ret root;
        }
    }

    class Child : Base {
        U8 leaf;

        I16 Foo() {
            ret 1;
        }

        U0 Reset() {
            ret;
        }
    }

    I16 main() {
        ret 0;
    }
}`;
    const uri = pathToFileURL(resolve("layout-hints.vl")).toString();
    const index = new WorkspaceIndex(resolve("."));
    index.configure([resolve("..", "..")], {
      requireMainDiagnostic: "off",
      inlayHints: { parameterNames: false, inferredTypes: false, layout: true },
    });
    const state = index.updateOpenDocument(uri, source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const hints = inlayHints(index, state);
    expect(hints.some((hint) => hint.label === " size 5" && hint.position.line === positionAt(source, "Child :").line)).toBe(true);
    expect(hints.some((hint) => hint.label === " @4" && hint.position.line === positionAt(source, "leaf;").line)).toBe(true);
    expect(hints.some((hint) => hint.label === " vslot 3" && hint.position.line === positionAt(source, "Foo() {\n            ret 1").line)).toBe(true);
    expect(hints.some((hint) => hint.label === " vslot 4" && hint.position.line === positionAt(source, "Reset()").line)).toBe(true);
    expect(hints.some((hint) => hint.label === " size 2")).toBe(false);
    expect(hints.every((hint) => hint.position.line >= 0 && hint.position.line < source.split("\n").length)).toBe(true);
  });

  it("records outgoing call hierarchy edges for Init, method calls, and Free", () => {
    const { index, uri } = fixtureIndex(classFixture);
    const [main] = prepareCallHierarchy(index, uri, positionAt(classFixture, "main"));
    expect(main).toBeDefined();
    const names = outgoingCalls(index, main!).map((call) => call.to.name);
    expect(names).toEqual(expect.arrayContaining(["OnAlloc", "Inc", "OnFree"]));
  });

  it("disambiguates call hierarchy items for duplicate method names", () => {
    const source = `module app {
    class A {
        I16 Run() {
            ret 1;
        }
    }

    class B {
        I16 Run() {
            ret 2;
        }
    }

    I16 main() {
        B b;
        ret b.Run();
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const [aRun] = prepareCallHierarchy(index, uri, positionAt(source, "Run()"));
    const [bRun] = prepareCallHierarchy(index, uri, positionAt(source, "Run() {\n            ret 2"));
    expect(aRun?.data).not.toBe(bRun?.data);
    expect(incomingCalls(index, aRun!)).toEqual([]);
    expect(incomingCalls(index, bRun!).map((call) => call.from.name)).toEqual(["main"]);
  });

  it("resolves all target methods for multi-dispatch navigation", () => {
    const source = `module app {
    class A {
        U0 Ping() {
            ret;
        }
    }

    class B {
        U0 Ping() {
            ret;
        }
    }

    I16 main() {
        A a;
        B b;
        {a, b}.Ping();
        ret 0;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const callPosition = positionAt(source, "{a, b}.Ping", "{a, b}.".length);
    const targetLines = definition(index, uri, callPosition).map((location) => location.range.start.line).sort((a, b) => a - b);
    const expectedLines = [
      positionAt(source, "class A {\n        U0 Ping", "class A {\n        U0 ".length).line,
      positionAt(source, "class B {\n        U0 Ping", "class B {\n        U0 ".length).line,
    ];
    expect(targetLines).toEqual(expectedLines);

    const [main] = prepareCallHierarchy(index, uri, positionAt(source, "main()"));
    const outgoingPingLines = outgoingCalls(index, main!)
      .filter((call) => call.to.name === "Ping")
      .map((call) => call.to.selectionRange.start.line)
      .sort((a, b) => a - b);
    expect(outgoingPingLines).toEqual(expectedLines);
    const preparedPingLines = prepareCallHierarchy(index, uri, callPosition)
      .map((item) => item.selectionRange.start.line)
      .sort((a, b) => a - b);
    expect(preparedPingLines).toEqual(expectedLines);
    const referenceLines = references(index, uri, callPosition, true)
      .map((location) => location.range.start.line)
      .sort((a, b) => a - b);
    expect(referenceLines).toEqual([...expectedLines, callPosition.line]);
    const highlightLines = highlights(index, uri, callPosition)
      .map((highlight) => highlight.range.start.line)
      .sort((a, b) => a - b);
    expect(highlightLines).toEqual([...expectedLines, callPosition.line]);
    expect(highlights(index, uri, callPosition).filter((highlight) => highlight.range.start.line === callPosition.line)).toHaveLength(1);
    expect(prepareRename(index, uri, callPosition)).toBeNull();
    expect(rename(index, { textDocument: { uri }, position: callPosition, newName: "Pong" })).toEqual({});
    const pingMonikers = moniker(index, uri, callPosition).map((item) => item.identifier).sort();
    expect(pingMonikers).toHaveLength(2);
    expect(pingMonikers).toEqual([expect.stringContaining("#A.method.Ping"), expect.stringContaining("#B.method.Ping")]);
    const pingHover = hover(index, uri, callPosition);
    expect((pingHover?.contents as { value?: string } | undefined)?.value).toContain("A.Ping");
    expect((pingHover?.contents as { value?: string } | undefined)?.value).toContain("B.Ping");
    expect(pingHover?.range).toEqual({ start: callPosition, end: { line: callPosition.line, character: callPosition.character + "Ping".length } });

    const tokens = decodedSemanticTokens(source, semanticTokens(state).data);
    const callToken = tokens.find((token) => token.line === callPosition.line && token.character === callPosition.character);
    expect(callToken).toMatchObject({ text: "Ping", tokenType: "method" });
  });

  it("keeps same-file member references separated by module", () => {
    const source = `module first {
    class Box {
        I16 Read() {
            ret 1;
        }
    }

    I16 firstUse() {
        Box firstBox;
        ret firstBox.Read();
    }
}

module second {
    class Box {
        I16 Read() {
            ret 2;
        }
    }

    I16 main() {
        Box secondBox;
        ret secondBox.Read();
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.some((diagnostic) => diagnostic.code === "vela.sem.flatAssemblyCollision")).toBe(true);

    const firstRead = positionAt(source, "I16 Read() {\n            ret 1", "I16 ".length);
    const secondRead = positionAt(source, "I16 Read() {\n            ret 2", "I16 ".length);
    const secondCall = positionAt(source, "secondBox.Read", "secondBox.".length);
    const referenceLines = references(index, uri, secondCall, true)
      .map((location) => location.range.start.line)
      .sort((a, b) => a - b);
    expect(referenceLines).toEqual([secondRead.line, secondCall.line].sort((a, b) => a - b));
    expect(referenceLines).not.toContain(firstRead.line);
  });

  it("binds imported receiver members when another module has a same-named class", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-receiver-owner-"));
    try {
      const libDir = join(tempRoot, "lib");
      mkdirSync(libDir, { recursive: true });
      const boxSource = `module box {
    class Box {
        I16 value;

        OnFree() {
        }

        I16 Read() {
            ret value;
        }
    }
}
`;
      const boxPath = join(libDir, "box.vl");
      writeFileSync(boxPath, boxSource);
      const source = `module hidden {
    class Box {
        I16 value;

        OnFree() {
        }

        I16 Read() {
            ret 1;
        }
    }
}

module app {
    import lib::{box};

    I16 main() {
        Box box;
        Free(box);
        ret box.Read() + box.value;
    }
}`;
      const uri = pathToFileURL(join(tempRoot, "app.vl")).toString();
      const boxUri = pathToFileURL(boxPath).toString();
      const index = new WorkspaceIndex(resolve("."));
      index.configure([tempRoot], { projectRoot: tempRoot, requireMainDiagnostic: "off" });
      index.indexWorkspace();
      const state = index.updateOpenDocument(uri, source);
      expect(state.analysis.diagnostics.some((diagnostic) => diagnostic.code === "vela.sem.unknownIdentifier")).toBe(false);

      const [methodTarget] = definition(index, uri, positionAt(source, "Read() +"));
      expect(methodTarget?.uri).toBe(boxUri);
      expect(rangeText(boxSource, methodTarget!.range)).toBe("Read");

      const [fieldTarget] = definition(index, uri, positionAt(source, "box.value", "box.".length));
      expect(fieldTarget?.uri).toBe(boxUri);
      expect(rangeText(boxSource, fieldTarget!.range)).toBe("value");

      const [main] = prepareCallHierarchy(index, uri, positionAt(source, "main()"));
      const onFreeTargets = outgoingCalls(index, main!).filter((call) => call.to.name === "OnFree");
      expect(onFreeTargets).toHaveLength(1);
      expect(onFreeTargets[0]?.to.uri).toBe(boxUri);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolves stdlib import modules for definition, hover, and document links", () => {
    const source = `module app {
    import stdlib::types::{int};

    I16 main() {
        ret 0;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    const importPosition = positionAt(source, "int};");
    const [target] = definition(index, uri, importPosition);
    expect(target?.uri).toContain("/stdlib/types/int.vl");

    const importHover = hover(index, uri, importPosition)?.contents as { value?: string } | undefined;
    expect(importHover?.value).toContain("stdlib");
    expect(importHover?.value).toContain("int.vl");

    const [link] = documentLinks(index, state);
    expect(link?.target).toBeUndefined();
    const resolvedLink = resolveDocumentLink(index, link!);
    expect(resolvedLink.target).toBe("vela-stdlib:/types/int.vl");
    expect(index.stdlibPathFromVirtualUri(resolvedLink.target!)?.replaceAll("\\", "/")).toContain("stdlib/types/int.vl");
  });

  it("exposes document links for wildcard import targets", () => {
    const source = `module app {
    import stdlib::types::{*};

    I16 main() {
        ret 0;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const targets = documentLinks(index, state).map((link) => resolveDocumentLink(index, link).target ?? "");
    expect(targets).toContain("vela-stdlib:/types/int.vl");
    expect(targets).toContain("vela-stdlib:/types/string.vl");
  });

  it("diagnoses unresolved modules inside partially resolved import lists", () => {
    const source = `module app {
    import stdlib::types::{int, missing};

    I16 main() {
        ret 0;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    const [target] = definition(index, uri, positionAt(source, "int,"));
    expect(target?.uri).toContain("/stdlib/types/int.vl");
    const diagnostic = index.lspDiagnostics(state.uri).find((item) => item.code === "vela.import.unresolved");
    expect(diagnostic?.message).toContain("missing");
    expect(source.slice(lspPositionToOffset(source, diagnostic!.range.start), lspPositionToOffset(source, diagnostic!.range.end))).toBe("missing");
    expect(diagnostic?.relatedInformation?.[0]?.message).toBe("import package path");
  });

  it("uses stdlib reference docs for module functions and implicit Storeable methods", () => {
    const mathSource = `module app {
    import stdlib::{math};

    I16 main() {
        ret Abs(-2);
    }
}`;
    const { index, uri } = workspaceFixtureIndex(mathSource);
    const absHover = hover(index, uri, positionAt(mathSource, "Abs("))?.contents as { value?: string } | undefined;
    expect(absHover?.value).toContain("I16 Abs(I16 x);");
    const absCompletion = completions(index, uri, positionAt(mathSource, "ret Abs", "ret ".length)).find((item) => item.label === "Abs");
    expect(String(absCompletion?.documentation)).toContain("I16 Abs(I16 x);");

    const storeableSource = `module app {
    class Box {
    }

    I16 main() {
        Box b;
        ret b.GetSize();
    }
}`;
    const { index: storeableIndex, uri: storeableUri } = fixtureIndex(storeableSource);
    const sizeHover = hover(storeableIndex, storeableUri, positionAt(storeableSource, "GetSize"))?.contents as { value?: string } | undefined;
    expect(sizeHover?.value).toContain("I16 GetSize();");
    const storeableCompletions = completions(storeableIndex, storeableUri, positionAt(storeableSource, "b.GetSize", "b.".length));
    expect(String(storeableCompletions.find((item) => item.label === "GetSize")?.documentation)).toContain("I16 GetSize();");

    const intSource = `module app {
    import stdlib::types::{int};

    I16 main() {
        Int i = Init<Int>(val: 1);
        ret i.GetValue();
    }
}`;
    const { index: intIndex, uri: intUri } = workspaceFixtureIndex(intSource);
    const intCompletions = completions(intIndex, intUri, positionAt(intSource, "i.GetValue", "i.".length));
    expect(String(intCompletions.find((item) => item.label === "GetValue")?.documentation)).toContain("I16 GetValue();");
    const valueCompletion = intCompletions.find((item) => item.label === "value");
    expect(valueCompletion?.detail).toBe("field value: I16");
    expect(String(valueCompletion?.documentation)).toContain("`Int` wraps an `I16` value.");
  });

  it("indexes the prompt-listed stdlib API from real stdlib sources", () => {
    type ExpectedCallable = {
      name: string;
      returns: string;
      params: string[];
    };
    type ExpectedClass = {
      module: string;
      className: string;
      methods: ExpectedCallable[];
    };
    const root = resolve("..", "..");
    const source = `module app {
    I16 main() {
        ret 0;
    }
}`;
    const { index, uri } = workspaceFixtureIndex(source);
    const symbols = index.allSymbols().filter((symbol) => symbol.defaultLibrary);
    const findStdlibSymbol = (moduleName: string, kind: string, name: string, className?: string): VelaSymbol | undefined =>
      symbols.find((symbol) =>
        symbol.moduleName === moduleName
        && symbol.kind === kind
        && symbol.name === name
        && symbol.className === className);
    const expectDocFor = (symbol: VelaSymbol, expectedName: string) => {
      const normalized = (symbol.documentation ?? "").replace(/\s+/gu, " ");
      expect(normalized, `${symbol.id} should have stdlib docs`).toContain(expectedName);
    };
    const expectCallable = (moduleName: string, expected: ExpectedCallable, className?: string) => {
      const symbol = findStdlibSymbol(moduleName, className ? "method" : "function", expected.name, className);
      expect(symbol, `${className ? `${className}.` : ""}${expected.name}`).toBeDefined();
      expect(typeToString(symbol!.returnType ?? symbol!.type)).toBe(expected.returns);
      expect(symbol!.params?.map((param) => `${typeToString(param.type)} ${param.name}`) ?? []).toEqual(expected.params);
      expectDocFor(symbol!, expected.name);
    };
    const expectImport = (name: string, packageSegments: string[], moduleName: string) => {
      const imp = index.stdlibImportForSymbol(name);
      expect(imp?.package, `${name} import package`).toEqual(packageSegments);
      expect(imp?.modules, `${name} import modules`).toEqual([moduleName]);
      const completion = completions(index, uri, positionAt(source, "ret 0", "ret ".length)).find((item) => item.label === name);
      expect(completion, `${name} completion`).toBeDefined();
      expect(completion?.additionalTextEdits, `${name} completion should add a missing import`).toBeDefined();
    };
    const mathFunctions: ExpectedCallable[] = [
      { name: "Abs", returns: "I16", params: ["I16 x"] },
      { name: "Min", returns: "I16", params: ["I16 a", "I16 b"] },
      { name: "Max", returns: "I16", params: ["I16 a", "I16 b"] },
      { name: "Square", returns: "I16", params: ["I16 x"] },
      { name: "Cube", returns: "I16", params: ["I16 x"] },
      { name: "IsEven", returns: "I8", params: ["I16 x"] },
      { name: "IsOdd", returns: "I8", params: ["I16 x"] },
      { name: "AbsDiff", returns: "I16", params: ["I16 a", "I16 b"] },
      { name: "InRange", returns: "I8", params: ["I16 x", "I16 lo", "I16 hi"] },
      { name: "Clamp", returns: "I16", params: ["I16 x", "I16 lo", "I16 hi"] },
      { name: "Pow", returns: "I16", params: ["I16 base", "I16 exp"] },
      { name: "Gcd", returns: "I16", params: ["I16 a", "I16 b"] },
      { name: "Sign", returns: "I16", params: ["I16 x"] },
    ];
    const classes: ExpectedClass[] = [
      {
        module: "storeable",
        className: "Storeable",
        methods: [
          { name: "OnAlloc", returns: "U0", params: [] },
          { name: "OnFree", returns: "U0", params: [] },
          { name: "GetSize", returns: "I16", params: [] },
          { name: "Pointer", returns: "I16", params: [] },
          { name: "Reference", returns: "I16", params: [] },
        ],
      },
      {
        module: "int",
        className: "Int",
        methods: [
          { name: "OnAlloc", returns: "U0", params: ["I16 val"] },
          { name: "GetValue", returns: "I16", params: [] },
          { name: "Abs", returns: "I16", params: [] },
          { name: "Negate", returns: "I16", params: [] },
          { name: "IsPositive", returns: "I8", params: [] },
          { name: "IsNegative", returns: "I8", params: [] },
          { name: "IsZero", returns: "I8", params: [] },
          { name: "Add", returns: "I16", params: ["I16 other"] },
          { name: "Sub", returns: "I16", params: ["I16 other"] },
          { name: "Mul", returns: "I16", params: ["I16 other"] },
          { name: "Div", returns: "I16", params: ["I16 other"] },
          { name: "Mod", returns: "I16", params: ["I16 other"] },
          { name: "Square", returns: "I16", params: [] },
          { name: "IsEven", returns: "I8", params: [] },
          { name: "IsOdd", returns: "I8", params: [] },
          { name: "Equals", returns: "I8", params: ["I16 other"] },
          { name: "LessThan", returns: "I8", params: ["I16 other"] },
          { name: "GreaterThan", returns: "I8", params: ["I16 other"] },
          { name: "Compare", returns: "I16", params: ["I16 other"] },
          { name: "AbsDiff", returns: "I16", params: ["I16 other"] },
          { name: "MinWith", returns: "I16", params: ["I16 other"] },
          { name: "MaxWith", returns: "I16", params: ["I16 other"] },
          { name: "Clamp", returns: "I16", params: ["I16 lo", "I16 hi"] },
          { name: "Between", returns: "I8", params: ["I16 lo", "I16 hi"] },
          { name: "GcdWith", returns: "I16", params: ["I16 other"] },
        ],
      },
      {
        module: "float",
        className: "Float",
        methods: [
          { name: "OnAlloc", returns: "U0", params: ["F16 val"] },
          { name: "GetValue", returns: "F16", params: [] },
          { name: "IsPositive", returns: "I8", params: [] },
          { name: "IsNegative", returns: "I8", params: [] },
          { name: "IsZero", returns: "I8", params: [] },
          { name: "Abs", returns: "F16", params: [] },
          { name: "Negate", returns: "F16", params: [] },
          { name: "Add", returns: "F16", params: ["F16 other"] },
          { name: "Sub", returns: "F16", params: ["F16 other"] },
          { name: "Mul", returns: "F16", params: ["F16 other"] },
          { name: "Div", returns: "F16", params: ["F16 other"] },
          { name: "Equals", returns: "I8", params: ["F16 other"] },
          { name: "GreaterThan", returns: "I8", params: ["F16 other"] },
          { name: "LessThan", returns: "I8", params: ["F16 other"] },
          { name: "GreaterOrEqual", returns: "I8", params: ["F16 other"] },
          { name: "LessOrEqual", returns: "I8", params: ["F16 other"] },
          { name: "MinWith", returns: "F16", params: ["F16 other"] },
          { name: "MaxWith", returns: "F16", params: ["F16 other"] },
          { name: "Clamp", returns: "F16", params: ["F16 lo", "F16 hi"] },
        ],
      },
      {
        module: "bool",
        className: "Bool",
        methods: [
          { name: "OnAlloc", returns: "U0", params: ["I8 val"] },
          { name: "GetValue", returns: "I8", params: [] },
          { name: "Not", returns: "I8", params: [] },
          { name: "IsTrue", returns: "I8", params: [] },
          { name: "IsFalse", returns: "I8", params: [] },
          { name: "Normalize", returns: "I8", params: [] },
          { name: "And", returns: "I8", params: ["I8 other"] },
          { name: "Or", returns: "I8", params: ["I8 other"] },
          { name: "Xor", returns: "I8", params: ["I8 other"] },
          { name: "Nand", returns: "I8", params: ["I8 other"] },
          { name: "Nor", returns: "I8", params: ["I8 other"] },
          { name: "Implies", returns: "I8", params: ["I8 other"] },
          { name: "ToInt", returns: "I16", params: [] },
          { name: "Equals", returns: "I8", params: ["I8 other"] },
        ],
      },
      {
        module: "char",
        className: "Char",
        methods: [
          { name: "OnAlloc", returns: "U0", params: ["U8 val"] },
          { name: "GetValue", returns: "U8", params: [] },
          { name: "IsAlpha", returns: "I8", params: [] },
          { name: "IsDigit", returns: "I8", params: [] },
          { name: "IsAlnum", returns: "I8", params: [] },
          { name: "IsHexDigit", returns: "I8", params: [] },
          { name: "IsUpper", returns: "I8", params: [] },
          { name: "IsLower", returns: "I8", params: [] },
          { name: "IsSpace", returns: "I8", params: [] },
          { name: "IsWhitespace", returns: "I8", params: [] },
          { name: "IsAscii", returns: "I8", params: [] },
          { name: "IsControl", returns: "I8", params: [] },
          { name: "IsPrintable", returns: "I8", params: [] },
          { name: "ToUpper", returns: "U8", params: [] },
          { name: "ToLower", returns: "U8", params: [] },
          { name: "ToInt", returns: "I16", params: [] },
          { name: "HexValue", returns: "I16", params: [] },
          { name: "Equals", returns: "I8", params: ["U8 other"] },
        ],
      },
      {
        module: "string",
        className: "String",
        methods: [
          { name: "OnAlloc", returns: "U0", params: ["Ptr<U8> p", "I16 length"] },
          { name: "GetPtr", returns: "Ptr<U8>", params: [] },
          { name: "GetLen", returns: "I16", params: [] },
          { name: "IsEmpty", returns: "I8", params: [] },
          { name: "CharAt", returns: "U8", params: ["I16 index"] },
          { name: "First", returns: "U8", params: [] },
          { name: "Last", returns: "U8", params: [] },
          { name: "Equals", returns: "I8", params: ["Ptr<U8> otherPtr", "I16 otherLen"] },
          { name: "StartsWith", returns: "I8", params: ["Ptr<U8> otherPtr", "I16 otherLen"] },
          { name: "EndsWith", returns: "I8", params: ["Ptr<U8> otherPtr", "I16 otherLen"] },
          { name: "Contains", returns: "I8", params: ["U8 ch"] },
          { name: "Count", returns: "I16", params: ["U8 ch"] },
          { name: "IndexOf", returns: "I16", params: ["U8 ch"] },
          { name: "IndexOfFrom", returns: "I16", params: ["U8 ch", "I16 start"] },
          { name: "LastIndexOf", returns: "I16", params: ["U8 ch"] },
          { name: "CopyTo", returns: "I16", params: ["Ptr<U8> dest", "I16 maxLen"] },
        ],
      },
      {
        module: "array",
        className: "Array",
        methods: [
          { name: "OnAlloc", returns: "U0", params: ["I16 cap"] },
          { name: "OnFree", returns: "U0", params: [] },
          { name: "GetLength", returns: "I16", params: [] },
          { name: "Get", returns: "I16", params: ["I16 index"] },
          { name: "Capacity", returns: "I16", params: [] },
          { name: "Remaining", returns: "I16", params: [] },
          { name: "Set", returns: "U0", params: ["I16 index", "I16 value"] },
          { name: "Push", returns: "U0", params: ["I16 value"] },
          { name: "TryPush", returns: "I8", params: ["I16 value"] },
          { name: "Pop", returns: "I16", params: [] },
          { name: "TryPop", returns: "I8", params: ["Ptr<I16> dest"] },
          { name: "IsEmpty", returns: "I8", params: [] },
          { name: "IsFull", returns: "I8", params: [] },
          { name: "First", returns: "I16", params: [] },
          { name: "Last", returns: "I16", params: [] },
          { name: "Contains", returns: "I8", params: ["I16 value"] },
          { name: "Count", returns: "I16", params: ["I16 value"] },
          { name: "IndexOf", returns: "I16", params: ["I16 value"] },
          { name: "LastIndexOf", returns: "I16", params: ["I16 value"] },
          { name: "Fill", returns: "U0", params: ["I16 value"] },
          { name: "Clear", returns: "U0", params: [] },
          { name: "Swap", returns: "U0", params: ["I16 a", "I16 b"] },
          { name: "Reverse", returns: "U0", params: [] },
          { name: "Insert", returns: "I8", params: ["I16 index", "I16 value"] },
          { name: "RemoveAt", returns: "I8", params: ["I16 index"] },
          { name: "Min", returns: "I16", params: [] },
          { name: "Max", returns: "I16", params: [] },
          { name: "Sum", returns: "I16", params: [] },
        ],
      },
      {
        module: "matrix",
        className: "Matrix",
        methods: [
          { name: "OnAlloc", returns: "U0", params: ["I16 r", "I16 c"] },
          { name: "OnFree", returns: "U0", params: [] },
          { name: "GetRows", returns: "I16", params: [] },
          { name: "GetCols", returns: "I16", params: [] },
          { name: "Get", returns: "I16", params: ["I16 row", "I16 col"] },
          { name: "Set", returns: "U0", params: ["I16 row", "I16 col", "I16 value"] },
          { name: "Size", returns: "I16", params: [] },
          { name: "IsSquare", returns: "I8", params: [] },
          { name: "Fill", returns: "U0", params: ["I16 value"] },
          { name: "Sum", returns: "I16", params: [] },
          { name: "MulWith", returns: "I16", params: ["I16 otherData", "I16 otherRows", "I16 otherCols"] },
          { name: "Trace", returns: "I16", params: [] },
          { name: "AddScalar", returns: "U0", params: ["I16 value"] },
          { name: "Scale", returns: "U0", params: ["I16 factor"] },
        ],
      },
    ];

    expect(index.stdlibDirectory()).toBe(resolve(root, "stdlib"));
    for (const expected of mathFunctions) {
      expectCallable("math", expected);
      expectImport(expected.name, ["stdlib"], "math");
    }
    for (const expected of classes) {
      const classSymbol = findStdlibSymbol(expected.module, "class", expected.className);
      expect(classSymbol, expected.className).toBeDefined();
      expectDocFor(classSymbol!, expected.className);
      expectImport(expected.className, expected.module === "storeable" ? ["stdlib", "core"] : ["stdlib", "types"], expected.module);
      for (const method of expected.methods) {
        expectCallable(expected.module, method, expected.className);
      }
    }
    const nullAlias = findStdlibSymbol("null", "alias", "NULL");
    expect(nullAlias).toBeDefined();
    expect(typeToString(nullAlias!.type)).toBe("Ptr<U0>");
    expectDocFor(nullAlias!, "NULL");
    expectImport("NULL", ["stdlib", "types"], "null");
  });

  it("folds import groups and consecutive comment blocks", () => {
    const source = `// first
// second
module app {
    import stdlib::types::{int};
    import stdlib::types::{string};

    # one
    # two
    I16 main() {
        ret 0;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    const ranges = foldingRanges(state);
    expect(ranges.some((range) => range.kind === "comment" && range.startLine === 0 && range.endLine === 1)).toBe(true);
    expect(ranges.some((range) => range.kind === "comment" && range.startLine === 6 && range.endLine === 7)).toBe(true);
    expect(ranges.some((range) => range.kind === "imports" && range.startLine === 3 && range.endLine === 4)).toBe(true);
  });

  it("builds distinct selection ranges from token to enclosing module", () => {
    const source = `module app {
    I16 main() {
        I16 count = 1;
        ret count;
    }
}`;
    const { state } = fixtureIndex(source);
    const [selection] = selectionRanges(state, [positionAt(source, "count =")]);
    const chain = selectionRangeChain(selection);
    const keys = chain.map((range) => `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`);
    expect(new Set(keys).size).toBe(chain.length);
    expect(rangeText(source, chain[0]!)).toBe("count");
    expect(chain.some((range) => rangeText(source, range).includes("I16 count = 1;"))).toBe(true);
    expect(chain.at(-1)?.start).toEqual({ line: 0, character: 0 });
    expect(chain.at(-1)?.end).toEqual({ line: 5, character: 1 });
  });

  it("includes braced block levels in selection ranges", () => {
    const source = `module app {
    I16 main() {
        if (true) {
            ret count;
        } else {
            ret 0;
        }
    }
}`;
    const { state } = fixtureIndex(source);
    const [selection] = selectionRanges(state, [positionAt(source, "ret count", "ret ".length)]);
    const texts = selectionRangeChain(selection).map((range) => rangeText(source, range));
    expect(texts).toEqual(expect.arrayContaining([
      "count",
      "ret count;",
      "{\n            ret count;\n        }",
      "if (true) {\n            ret count;\n        } else {\n            ret 0;\n        }",
      "{\n        if (true) {\n            ret count;\n        } else {\n            ret 0;\n        }\n    }",
    ]));
  });

  it("formats documents with a valid full-document range", () => {
    const source = `module app{I16 main(){I16 x=1+2;ret x;}}`;
    const { state } = fixtureIndex(source);
    const [edit] = formatting(state);
    expect(edit?.range).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: source.length } });
    expect(edit?.newText).toContain("module app {");
    expect(edit?.newText).toContain("I16 x = 1 + 2;");
    expect(edit?.newText).toContain("ret x;");
  });

  it("preserves trailing comments, tag closes, and raw ASM body while formatting", () => {
    const source = `module app {
    class Box {
        [[get,set]] I16 value;

        I16 Run() {
            I16 x=1+2; // keep x
            ASM(
                [[in]] R0 = x;
                [[out]] R1 = x;
            ) {
                MOV R1, R0
                ADD R1, 1
            }
            ret x;
        }
    }
}`;
    const { state } = fixtureIndex(source);
    const [edit] = formatting(state);
    expect(edit?.newText).toContain("[[get, set]] I16 value;");
    expect(edit?.newText).toContain("I16 x = 1 + 2; // keep x");
    expect(edit?.newText).toContain("                MOV R1, R0\n                ADD R1, 1");
    expect(edit?.newText).toContain("            }\n            ret x;");
    expect(edit?.newText).not.toContain("[[get, set ]]");
    expect(edit?.newText).not.toContain("MOV R1, R0 ADD R1, 1");
  });

  it("formats for-loop headers without splitting semicolon clauses", () => {
    const source = `module app{I16 main(){I16 total=0;for(I16 i=0;i<3;i++){total+=i;}ret total;}}`;
    const { state } = fixtureIndex(source);
    const [edit] = formatting(state);
    expect(edit?.newText).toContain("for (I16 i = 0; i < 3; i++) {");
    expect(edit?.newText).toContain("total += i;");
    expect(edit?.newText).not.toContain("for (I16 i = 0;\n");
    expect(edit?.newText).not.toContain("i ++");
  });

  it("formats generic type brackets and prefix unary operators without extra spaces", () => {
    const source = `module app{I16 g;I16 main(){Ptr<I16> p=&g;if(!false){I16 x=*p;ret -x;}ret 0;}}`;
    const { state } = fixtureIndex(source);
    const [edit] = formatting(state);
    expect(edit?.newText).toContain("Ptr<I16> p = &g;");
    expect(edit?.newText).toContain("if (!false) {");
    expect(edit?.newText).toContain("I16 x = *p;");
    expect(edit?.newText).toContain("ret -x;");
    expect(edit?.newText).not.toContain("Ptr < I16 >");
    expect(edit?.newText).not.toContain("& g");
    expect(edit?.newText).not.toContain("* p");
  });

  it("range-formats only the requested line span", () => {
    const source = `module app {
    I16 main() {
        I16 x=1+2;
        I16 y=3+4;
        ret x+y;
    }
}`;
    const { state } = fixtureIndex(source);
    const [edit] = formatting(state, { start: { line: 2, character: 0 }, end: { line: 2, character: 18 } });
    expect(edit?.range).toEqual({ start: { line: 2, character: 0 }, end: { line: 3, character: 0 } });
    const updated = applyEdit(state.text, edit!);
    expect(updated).toContain("        I16 x = 1 + 2;\n");
    expect(updated).toContain("        I16 y=3+4;\n");
    expect(updated).toContain("        ret x+y;");
  });

  it("formats bundled examples and stdlib idempotently", () => {
    const root = resolve("..", "..");
    const index = new WorkspaceIndex(resolve("."));
    index.configure([root], { requireMainDiagnostic: "off" });
    index.indexWorkspace();
    const unstable = index.allFiles()
      .filter((state) => /[\\/](examples|stdlib)[\\/].*\.vl$/.test(state.path))
      .filter((state) => {
        const [edit] = formatting(state);
        const formatted = edit ? applyEdit(state.text, edit) : state.text;
        const formattedIndex = new WorkspaceIndex(resolve("."));
        formattedIndex.configure([root], { requireMainDiagnostic: "off" });
        const formattedState = formattedIndex.updateOpenDocument(state.uri, formatted);
        return formatting(formattedState).length > 0;
      })
      .map((state) => state.path);
    expect(unstable).toEqual([]);
  });

  it("formats documented Vela code blocks idempotently", () => {
    const root = resolve("..", "..");
    const blocks = [
      ...velaCodeBlocksFromMarkdown(resolve(root, "docs", "language.md")),
      ...velaCodeBlocksFromMarkdown(resolve(root, "docs", "stdlib.md")),
    ];
    const unstable = blocks.filter((block) => {
      const formatted = formatSource(block.source, pathToFileURL(resolve(`${block.label.replace(/[^A-Za-z0-9_-]/gu, "_")}.vl`)).toString());
      const reformatted = formatSource(formatted, pathToFileURL(resolve(`${block.label.replace(/[^A-Za-z0-9_-]/gu, "_")}.formatted.vl`)).toString());
      return formatted !== reformatted;
    }).map((block) => block.label);

    expect(blocks.length).toBeGreaterThan(0);
    expect(unstable).toEqual([]);
  });

  it("offers wildcard completion for import module lists", () => {
    const source = `module app {
    import stdlib::types::{int};

    I16 main() {
        ret 0;
    }
}`;
    const { index, uri } = fixtureIndex(source);
    const moduleItems = completions(index, uri, positionAt(source, "{int", 1));
    expect(moduleItems.map((item) => item.label)).toEqual(expect.arrayContaining(["*", "bool", "int", "string"]));
    expect(moduleItems.find((item) => item.label === "*")?.detail).toBe("Wildcard import all modules in package");
    expect(moduleItems.find((item) => item.label === "int")?.commitCharacters).toEqual([",", "}"]);
    expect(moduleItems.find((item) => item.label === "int")?.sortText).toBe("1_int");
    expect(moduleItems.find((item) => item.label === "int")?.documentation).toContain("workspace or bundled stdlib");
    expect(moduleItems.find((item) => item.label === "*")?.commitCharacters).toEqual(["}"]);

    const packageItems = completions(index, uri, positionAt(source, "types::{"));
    expect(packageItems.some((item) => item.label === "*")).toBe(false);
  });

  it("separates import package segment and module completions from workspace and stdlib", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-import-completion-"));
    try {
      mkdirSync(join(tempRoot, "lib", "math"), { recursive: true });
      mkdirSync(join(tempRoot, "lib", "io"), { recursive: true });
      writeFileSync(join(tempRoot, "lib", "math", "arith.vl"), "module arith { I16 Add(I16 a, I16 b) { ret a + b; } }");
      writeFileSync(join(tempRoot, "lib", "io", "console.vl"), "module console { U0 Flush() { ret; } }");
      writeFileSync(join(tempRoot, "main.vl"), "");
      const source = `module app {
    import lib::math::{arith};
    import stdlib::types::{int};
    import stdlib::{math};

    I16 main() {
        ret 0;
    }
}`;
      const uri = pathToFileURL(join(tempRoot, "main.vl")).toString();
      const index = new WorkspaceIndex(resolve("."));
      index.configure([tempRoot], { projectRoot: tempRoot, requireMainDiagnostic: "off" });
      index.indexWorkspace();
      index.updateOpenDocument(uri, source);

      const topPackages = completions(index, uri, positionAt(source, "lib::", "li".length)).map((item) => item.label);
      expect(topPackages).toEqual(expect.arrayContaining(["lib", "stdlib"]));
      expect(topPackages).not.toContain("main");

      const libPackages = completions(index, uri, positionAt(source, "math::{")).map((item) => item.label);
      expect(libPackages).toEqual(expect.arrayContaining(["io", "math"]));
      expect(libPackages).not.toContain("arith");
      expect(libPackages).not.toContain("*");

      const workspaceModules = completions(index, uri, positionAt(source, "{arith", 1));
      expect(workspaceModules.map((item) => item.label)).toEqual(expect.arrayContaining(["*", "arith"]));
      expect(workspaceModules.map((item) => item.label)).not.toContain("io");
      expect(workspaceModules.find((item) => item.label === "arith")?.detail).toBe("Vela import module");
      expect(workspaceModules.find((item) => item.label === "arith")?.commitCharacters).toEqual([",", "}"]);

      const stdlibPackages = completions(index, uri, positionAt(source, "types::{"));
      expect(stdlibPackages.map((item) => item.label)).toEqual(expect.arrayContaining(["core", "types"]));
      expect(stdlibPackages.map((item) => item.label)).not.toContain("math");
      expect(stdlibPackages.find((item) => item.label === "types")?.detail).toBe("Vela import package segment");
      expect(stdlibPackages.find((item) => item.label === "types")?.commitCharacters).toEqual([":"]);

      const stdlibModules = completions(index, uri, positionAt(source, "{math", 1));
      expect(stdlibModules.map((item) => item.label)).toEqual(expect.arrayContaining(["*", "math"]));
      expect(stdlibModules.map((item) => item.label)).not.toContain("types");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("offers safe refactors between explicit and wildcard imports", () => {
    const explicit = `module app {
    import stdlib::types::{array, bool, char, float, int, matrix, null, string};

    I16 main() {
        ret 0;
    }
}`;
    const { index: explicitIndex, state: explicitState } = fixtureIndex(explicit);
    const collapse = codeActions(explicitIndex, explicitState, []).find((item) => item.title === "Convert import list to wildcard stdlib::types::{*}");
    const collapseEdit = collapse?.edit?.changes?.[explicitState.uri]?.[0];
    expect(collapse?.kind).toBe("refactor.rewrite");
    expect(applyEdit(explicitState.text, collapseEdit!)).toContain("    import stdlib::types::{*};");

    const wildcard = `module app {
    import stdlib::types::{*};

    I16 main() {
        ret 0;
    }
}`;
    const { index: wildcardIndex, state: wildcardState } = fixtureIndex(wildcard);
    const expand = codeActions(wildcardIndex, wildcardState, []).find((item) => item.title === "Expand wildcard import stdlib::types::{*}");
    const expandEdit = expand?.edit?.changes?.[wildcardState.uri]?.[0];
    expect(applyEdit(wildcardState.text, expandEdit!)).toContain("    import stdlib::types::{array, bool, char, float, int, matrix, null, string};");

    const partial = `module app {
    import stdlib::types::{int, string};

    I16 main() {
        ret 0;
    }
}`;
    const { index: partialIndex, state: partialState } = fixtureIndex(partial);
    expect(codeActions(partialIndex, partialState, []).some((item) => item.title === "Convert import list to wildcard stdlib::types::{*}")).toBe(false);
  });

  it("updates explicit imports when a workspace file is renamed", () => {
    const source = `module app {
    import lib::{math, util};

    I16 main() {
        ret 0;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const oldUri = pathToFileURL(resolve("..", "..", "lib", "math.vl")).toString();
    index.updateOpenDocument(oldUri, `module math {
    I16 Add() {
        ret 1;
    }
}`);
    const edit = fileRenameImportEdit(index, [{
      oldUri,
      newUri: pathToFileURL(resolve("..", "..", "lib", "arith.vl")).toString(),
    }]);
    const updated = applyEdits(state.text, edit?.changes?.[state.uri] ?? []);
    expect(updated).toContain("    import lib::{arith, util};");
    const renamedModule = applyEdits(index.get(oldUri)!.text, edit?.changes?.[oldUri] ?? []);
    expect(renamedModule).toContain("module arith {");

    const movedSource = `module app {
    import lib::{math, util};
    import core::{io};

    I16 main() {
        ret 0;
    }
}`;
    const { index: movedIndex, state: movedState } = fixtureIndex(movedSource);
    const movedEdit = fileRenameImportEdit(movedIndex, [{
      oldUri: pathToFileURL(resolve("..", "..", "lib", "math.vl")).toString(),
      newUri: pathToFileURL(resolve("..", "..", "core", "arith.vl")).toString(),
    }]);
    const movedUpdated = applyEdits(movedState.text, movedEdit?.changes?.[movedState.uri] ?? []);
    expect(movedUpdated).toContain("    import lib::{util};");
    expect(movedUpdated).toContain("    import core::{io, arith};");
    expect(movedUpdated).not.toContain("lib::{math");

    const literalSource = `module app {
    import lib::{maybe};

    I16 main() {
        ret 0;
    }
}`;
    const { index: literalIndex, state: literalState } = fixtureIndex(literalSource);
    const literalOldUri = pathToFileURL(resolve("..", "..", "lib", "maybe.vl")).toString();
    literalIndex.updateOpenDocument(literalOldUri, `module maybe {
    alias Maybe <- Ptr<U0>;
}`);
    const literalEdit = fileRenameImportEdit(literalIndex, [{
      oldUri: literalOldUri,
      newUri: pathToFileURL(resolve("..", "..", "lib", "null.vl")).toString(),
    }]);
    expect(applyEdits(literalState.text, literalEdit?.changes?.[literalState.uri] ?? [])).toContain("    import lib::{null};");
    expect(applyEdits(literalIndex.get(literalOldUri)!.text, literalEdit?.changes?.[literalOldUri] ?? [])).toContain("module null {");
  });

  it("removes explicit imports when workspace files are deleted", () => {
    const source = `module app {
    import lib::{math, util, vector};
    import core::{io};

    I16 main() {
        ret 0;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const deleteEdit = fileDeleteImportEdit(index, [{
      uri: pathToFileURL(resolve("..", "..", "lib", "math.vl")).toString(),
    }]);
    const updated = applyEdits(state.text, deleteEdit?.changes?.[state.uri] ?? []);
    expect(updated).toContain("    import lib::{util, vector};");
    expect(updated).toContain("    import core::{io};");

    const multiDeleteEdit = fileDeleteImportEdit(index, [
      { uri: pathToFileURL(resolve("..", "..", "lib", "math.vl")).toString() },
      { uri: pathToFileURL(resolve("..", "..", "lib", "util.vl")).toString() },
    ]);
    const multiUpdated = applyEdits(state.text, multiDeleteEdit?.changes?.[state.uri] ?? []);
    expect(multiUpdated).toContain("    import lib::{vector};");

    const singleSource = `module app {
    import lib::{math};

    I16 main() {
        ret 0;
    }
}`;
    const { index: singleIndex, state: singleState } = fixtureIndex(singleSource);
    const removeLineEdit = fileDeleteImportEdit(singleIndex, [{
      uri: pathToFileURL(resolve("..", "..", "lib", "math.vl")).toString(),
    }]);
    expect(applyEdits(singleState.text, removeLineEdit?.changes?.[singleState.uri] ?? [])).not.toContain("import lib");
  });

  it("offers quick fixes to import missing workspace symbols", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-import-"));
    try {
      const libDir = join(tempRoot, "lib");
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, "helpers.vl"), `module helpers {
    type Drawable {
        skeleton U0 Draw();
    }

    class Widget {
    }

    I16 Seed = 3;

    I16 Double(I16 value) {
        ret value + value;
    }
}
`);
      const appPath = join(tempRoot, "app.vl");
      const source = `module app {
    class Sprite : Drawable {
    }

    I16 main() {
        Widget w = null;
        ret Double(Seed);
    }
}`;
      writeFileSync(appPath, source);
      const uri = pathToFileURL(appPath).toString();
      const index = new WorkspaceIndex(resolve("."));
      index.configure([tempRoot], { projectRoot: tempRoot, requireMainDiagnostic: "off" });
      index.indexWorkspace();
      const state = index.updateOpenDocument(uri, source);
      const diagnostics = index.lspDiagnostics(state.uri);

      const doubleDiagnostic = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.unknownIdentifier" && typeof diagnostic.message === "string" && diagnostic.message.includes("'Double'"));
      expect(doubleDiagnostic).toBeDefined();
      const doubleAction = codeActions(index, state, [doubleDiagnostic!]).find((item) => item.title === "Import 'Double' from lib::{helpers}");
      expect(doubleAction?.diagnostics).toEqual([doubleDiagnostic]);
      expect(applyEdit(state.text, doubleAction?.edit?.changes?.[state.uri]?.[0]!)).toContain("    import lib::{helpers};\n");

      const widgetDiagnostic = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.unknownType" && typeof diagnostic.message === "string" && diagnostic.message.includes("'Widget'"));
      expect(widgetDiagnostic).toBeDefined();
      const widgetAction = codeActions(index, state, [widgetDiagnostic!]).find((item) => item.title === "Import 'Widget' from lib::{helpers}");
      expect(widgetAction?.edit?.changes?.[state.uri]?.[0]?.newText).toBe("    import lib::{helpers};\n");

      const seedDiagnostic = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.unknownIdentifier" && typeof diagnostic.message === "string" && diagnostic.message.includes("'Seed'"));
      expect(seedDiagnostic).toBeDefined();
      const seedAction = codeActions(index, state, [seedDiagnostic!]).find((item) => item.title === "Import 'Seed' from lib::{helpers}");
      expect(seedAction?.edit?.changes?.[state.uri]?.[0]?.newText).toBe("    import lib::{helpers};\n");

      const parentDiagnostic = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.unknownParent" && typeof diagnostic.message === "string" && diagnostic.message.includes("'Drawable'"));
      expect(parentDiagnostic).toBeDefined();
      const parentAction = codeActions(index, state, [parentDiagnostic!]).find((item) => item.title === "Import 'Drawable' from lib::{helpers}");
      expect(parentAction?.edit?.changes?.[state.uri]?.[0]?.newText).toBe("    import lib::{helpers};\n");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("suggests workspace imports only for symbols exported by the importable first module", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-multi-import-"));
    try {
      const libDir = join(tempRoot, "lib");
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, "multi.vl"), `module public {
    I16 Visible() {
        ret 1;
    }
}

module private {
    I16 Hidden() {
        ret 2;
    }
}
`);
      const appPath = join(tempRoot, "app.vl");
      const source = `module app {
    I16 main() {
        ret Hidden();
    }
}`;
      writeFileSync(appPath, source);
      const uri = pathToFileURL(appPath).toString();
      const index = new WorkspaceIndex(resolve("."));
      index.configure([tempRoot], { projectRoot: tempRoot, requireMainDiagnostic: "off" });
      index.indexWorkspace();
      const state = index.updateOpenDocument(uri, source);
      const diagnostic = index.lspDiagnostics(state.uri).find((item) => item.code === "vela.sem.unknownIdentifier" && typeof item.message === "string" && item.message.includes("'Hidden'"));
      expect(diagnostic).toBeDefined();
      const actions = codeActions(index, state, [diagnostic!]);
      expect(actions.some((item) => item.title === "Import 'Hidden' from lib::{multi}")).toBe(false);
      expect(index.workspaceImportsForSymbol("Visible", state.uri).map((imp) => imp.modules[0])).toContain("multi");
      expect(index.workspaceImportsForSymbol("Hidden", state.uri)).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("merges missing imports into existing same-package import lists", () => {
    const source = `module app {
    import stdlib::types::{int};

    I16 main() {
        Bool flag = null;
        ret 0;
    }
}`;
    const { index, state } = workspaceFixtureIndex(source);
    const diagnostic = index.lspDiagnostics(state.uri).find((item) => item.code === "vela.sem.unknownType" && typeof item.message === "string" && item.message.includes("'Bool'"));
    expect(diagnostic).toBeDefined();
    const action = codeActions(index, state, [diagnostic!]).find((item) => item.title === "Import 'Bool' from stdlib::types::{bool}");
    const edit = action?.edit?.changes?.[state.uri]?.[0];
    expect(edit?.newText).toBe(", bool");
    const updated = applyEdit(state.text, edit!);
    expect(updated).toContain("    import stdlib::types::{int, bool};");
    expect(updated).not.toContain("import stdlib::types::{bool};");
  });

  it("sorts imports without changing line indentation", () => {
    const source = `module app {
    import stdlib::types::{string};
    import stdlib::types::{int};

    I16 main() {
        ret 0;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const sort = codeActions(index, state, []).find((item) => item.title === "Sort imports");
    const edits = sort?.edit?.changes?.[state.uri] ?? [];
    const organized = applyEdits(state.text, edits);
    expect(organized).toContain("    import stdlib::types::{int};\n    import stdlib::types::{string};");
    expect(organized).not.toContain("        import stdlib");

    const unsortedModules = `module app {
    import stdlib::types::{string, int};

    I16 main() {
        ret 0;
    }
}`;
    const { index: moduleIndex, state: moduleState } = fixtureIndex(unsortedModules);
    const moduleSort = codeActions(moduleIndex, moduleState, []).find((item) => item.title === "Sort imports");
    const moduleOrganized = applyEdits(moduleState.text, moduleSort?.edit?.changes?.[moduleState.uri] ?? []);
    expect(moduleOrganized).toContain("    import stdlib::types::{int, string};");
  });

  it("removes unused explicit import modules", () => {
    const source = `module app {
    import stdlib::types::{int, string};

    I16 main() {
        Int value = null;
        ret 0;
    }
}`;
    const { index, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const removeString = codeActions(index, state, []).find((item) => item.title === "Remove unused import 'string'");
    expect(removeString?.kind).toBe("source.organizeImports");
    const removeStringEdit = removeString?.edit?.changes?.[state.uri]?.[0];
    const withoutString = applyEdit(state.text, removeStringEdit!);
    expect(withoutString).toContain("    import stdlib::types::{int};");
    expect(withoutString).toContain("Int value");
    expect(codeActions(index, state, []).some((item) => item.title === "Remove unused import 'int'")).toBe(false);

    const onlyUnused = `module app {
    import stdlib::types::{string};

    I16 main() {
        ret 0;
    }
}`;
    const { index: onlyIndex, state: onlyState } = fixtureIndex(onlyUnused);
    const removeOnly = codeActions(onlyIndex, onlyState, []).find((item) => item.title === "Remove unused import 'string'");
    const removeOnlyEdit = removeOnly?.edit?.changes?.[onlyState.uri]?.[0];
    const withoutImport = applyEdit(onlyState.text, removeOnlyEdit!);
    expect(withoutImport).not.toContain("import stdlib::types::{string};");
    expect(withoutImport).toContain("    I16 main()");
  });

  it("removes unused wildcard imports only when no covered exports are referenced", () => {
    const unused = `module app {
    import stdlib::types::{*};

    I16 main() {
        ret 0;
    }
}`;
    const { index, state } = fixtureIndex(unused);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const removeWildcard = codeActions(index, state, []).find((item) => item.title === "Remove unused import stdlib::types::{*}");
    expect(removeWildcard?.kind).toBe("source.organizeImports");
    const withoutWildcard = applyEdit(state.text, removeWildcard?.edit?.changes?.[state.uri]?.[0]!);
    expect(withoutWildcard).not.toContain("import stdlib::types::{*};");
    expect(withoutWildcard).toContain("    I16 main()");

    const used = `module app {
    import stdlib::types::{*};

    I16 main() {
        Int value = null;
        ret value.GetValue();
    }
}`;
    const { index: usedIndex, state: usedState } = fixtureIndex(used);
    expect(usedState.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    expect(codeActions(usedIndex, usedState, []).some((item) => item.title === "Remove unused import stdlib::types::{*}")).toBe(false);
  });

  it("scopes unused import removal to the module that owns the import", () => {
    const source = `module first {
    import stdlib::types::{int};

    I16 first() {
        ret 0;
    }
}

module second {
    import stdlib::types::{int};

    I16 main() {
        Int value = null;
        ret value.GetValue();
    }
}`;
    const { index, state } = workspaceFixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const remove = codeActions(index, state, []).find((item) => item.title === "Remove unused import 'int'");
    const updated = applyEdit(state.text, remove?.edit?.changes?.[state.uri]?.[0]!);
    expect(updated).toContain("module first {\n\n    I16 first()");
    expect(updated).toContain("module second {\n    import stdlib::types::{int};");
  });

  it("resolves type definitions for aliases, interfaces, and class-typed values", () => {
    const source = `module app {
    alias Word <- I16;

    type Drawable {
        skeleton U0 Draw();
    }

    class Sprite : Drawable {
        U0 Draw() {
            ret;
        }
    }

    I16 main() {
        Word w = 0;
        Sprite s;
        ret 0;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const [aliasTarget] = typeDefinition(index, uri, positionAt(source, "Word w"));
    expect(aliasTarget?.range.start.line).toBe(positionAt(source, "Word <-").line);

    const [typeTarget] = typeDefinition(index, uri, positionAt(source, "Drawable {"));
    expect(typeTarget?.range.start.line).toBe(positionAt(source, "Drawable {\n        skeleton").line);

    const [classTarget] = typeDefinition(index, uri, positionAt(source, "s;\n        ret"));
    expect(classTarget?.range.start.line).toBe(positionAt(source, "Sprite :").line);
    const spriteReferenceLines = references(index, uri, positionAt(source, "Sprite :"), true).map((location) => location.range.start.line);
    expect(spriteReferenceLines).toContain(positionAt(source, "Sprite :").line);
    expect(spriteReferenceLines).toContain(positionAt(source, "Sprite s").line);

    const shadowSource = `module app {
    import stdlib::types::{int};

    I16 main() {
        I16 Int = 0;
        ret Int;
    }
}`;
    const shadow = workspaceFixtureIndex(shadowSource);
    expect(shadow.state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    expect(typeDefinition(shadow.index, shadow.uri, positionAt(shadowSource, "ret Int", "ret ".length))).toEqual([]);

    const scopedSource = `module first {
    class Hidden {
    }
}

module second {
    I16 main() {
        Hidden value = null;
        ret 0;
    }
}`;
    const scoped = fixtureIndex(scopedSource);
    expect(scoped.index.lspDiagnostics(scoped.uri).some((diagnostic) => diagnostic.code === "vela.sem.unknownType")).toBe(true);
    expect(typeDefinition(scoped.index, scoped.uri, positionAt(scopedSource, "Hidden value"))).toEqual([]);

    const initScopedSource = `module first {
    class Hidden {
        OnAlloc(I16 secret) {
        }
    }
}

module second {
    I16 main() {
        Init<Hidden>();
        ret 0;
    }
}`;
    const initScoped = fixtureIndex(initScopedSource);
    const initHidden = initScoped.index.lspDiagnostics(initScoped.uri).find((diagnostic) => diagnostic.code === "vela.sem.unknownIdentifier" && typeof diagnostic.message === "string" && diagnostic.message.includes("class 'Hidden'"));
    expect(initHidden).toBeDefined();
    const hiddenInitPosition = positionAt(initScopedSource, "Init<Hidden>(", "Init<Hidden>(".length);
    expect(completions(initScoped.index, initScoped.uri, hiddenInitPosition).some((item) => item.label === "secret")).toBe(false);
    expect(signatureHelp(initScoped.index, initScoped.uri, hiddenInitPosition)).toBeNull();
  });

  it("does not inherit members or skeleton requirements from invisible parents", () => {
    const source = `module first {
    type HiddenShape {
        skeleton I16 Draw();
    }

    class HiddenBase {
        I16 Leak() {
            ret 1;
        }
    }
}

module second {
    class Child : HiddenShape {
    }

    class Other : HiddenBase {
    }

    I16 main() {
        Other other;
        ret other.Leak();
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    const diagnostics = index.lspDiagnostics(state.uri);
    expect(diagnostics.filter((diagnostic) => diagnostic.code === "vela.sem.unknownParent")).toHaveLength(2);
    expect(diagnostics.some((diagnostic) => diagnostic.code === "vela.sem.missingSkeleton")).toBe(false);
    expect(diagnostics.some((diagnostic) => diagnostic.code === "vela.sem.unknownIdentifier" && typeof diagnostic.message === "string" && diagnostic.message.includes("method 'Leak'"))).toBe(true);
    expect(definition(index, uri, positionAt(source, "Leak();"))).toEqual([]);
    const [other] = prepareTypeHierarchy(index, uri, positionAt(source, "Other :"));
    expect(supertypes(index, other!)).toEqual([]);
    const [hiddenBase] = prepareTypeHierarchy(index, uri, positionAt(source, "HiddenBase {"));
    expect(subtypes(index, hiddenBase!).map((item) => item.name)).not.toContain("Other");
  });

  it("uses the visible imported parent when hidden workspace classes share its name", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-parent-visibility-"));
    try {
      const hiddenSource = `module hidden {
    class Base {
        I16 HiddenOnly() {
            ret 1;
        }
    }

    class HiddenChild : Base {
        I16 taken;
    }
}
`;
      const hiddenPath = join(tempRoot, "aaa-hidden.vl");
      writeFileSync(hiddenPath, hiddenSource);
      const libDir = join(tempRoot, "lib");
      mkdirSync(libDir, { recursive: true });
      const baseSource = `module base {
    class Base {
        I16 value;

        I16 VisibleOnly() {
            ret 2;
        }
    }
}
`;
      const basePath = join(libDir, "base.vl");
      writeFileSync(basePath, baseSource);
      const source = `module app {
    import lib::{base};

    class Child : Base {
    }

    I16 main() {
        Child child;
        ret child.VisibleOnly();
    }
}`;
      const uri = pathToFileURL(join(tempRoot, "app.vl")).toString();
      const index = new WorkspaceIndex(resolve("."));
      index.configure([tempRoot], { projectRoot: tempRoot, requireMainDiagnostic: "off" });
      index.indexWorkspace();
      const state = index.updateOpenDocument(uri, source);
      expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

      const memberLabels = completions(index, uri, positionAt(source, "child.", "child.".length)).map((item) => item.label);
      expect(memberLabels).toContain("VisibleOnly");
      expect(memberLabels).not.toContain("HiddenOnly");

      const [child] = prepareTypeHierarchy(index, uri, positionAt(source, "Child :"));
      const [parent] = supertypes(index, child!);
      expect(parent?.name).toBe("Base");
      expect(parent?.uri.replaceAll("\\", "/")).toContain("/lib/base.vl");

      const hiddenUri = pathToFileURL(hiddenPath).toString();
      const baseUri = pathToFileURL(basePath).toString();
      const [hiddenBase] = prepareTypeHierarchy(index, hiddenUri, positionAt(hiddenSource, "Base {"));
      const [visibleBase] = prepareTypeHierarchy(index, baseUri, positionAt(baseSource, "Base {"));
      expect(subtypes(index, hiddenBase!).map((item) => item.name)).not.toContain("Child");
      expect(subtypes(index, visibleBase!).map((item) => item.name)).toContain("Child");
      expect(implementation(index, hiddenUri, positionAt(hiddenSource, "Base {")).map((location) => location.uri)).not.toContain(uri);
      expect(implementation(index, baseUri, positionAt(baseSource, "Base {")).map((location) => location.uri)).toContain(uri);
      expect(signatureHelp(index, uri, positionAt(source, "VisibleOnly(", "VisibleOnly(".length))?.signatures[0]?.label).toBe("I16 Base.VisibleOnly()");
      const baseHover = hover(index, baseUri, positionAt(baseSource, "Base {"))?.contents as { value?: string } | undefined;
      expect(baseHover?.value).toContain("VisibleOnly");
      expect(baseHover?.value).not.toContain("HiddenOnly");
      const fieldRename = rename(index, { textDocument: { uri: baseUri }, position: positionAt(baseSource, "value;"), newName: "taken" });
      expect(applyEdit(baseSource, fieldRename.changes?.[baseUri]?.[0]!)).toContain("I16 taken;");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the visible imported type when hidden workspace types share its name", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-type-visibility-"));
    try {
      const hiddenSource = `module hidden {
    type Shape {
        skeleton U0 Draw();
    }

    class HiddenSprite : Shape {
        U0 Draw() {
            ret;
        }
    }
}
`;
      const hiddenPath = join(tempRoot, "aaa-hidden.vl");
      writeFileSync(hiddenPath, hiddenSource);
      const libDir = join(tempRoot, "lib");
      mkdirSync(libDir, { recursive: true });
      const shapeSource = `module shape {
    type Shape {
        skeleton U0 Draw();
    }
}
`;
      const shapePath = join(libDir, "shape.vl");
      writeFileSync(shapePath, shapeSource);
      const source = `module app {
    import lib::{shape};

    class Sprite : Shape {
        U0 Draw() {
            ret;
        }
    }

    I16 main() {
        ret 0;
    }
}`;
      const uri = pathToFileURL(join(tempRoot, "app.vl")).toString();
      const index = new WorkspaceIndex(resolve("."));
      index.configure([tempRoot], { projectRoot: tempRoot, requireMainDiagnostic: "off" });
      index.indexWorkspace();
      const state = index.updateOpenDocument(uri, source);
      expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

      const hiddenUri = pathToFileURL(hiddenPath).toString();
      const shapeUri = pathToFileURL(shapePath).toString();
      const [hiddenShape] = prepareTypeHierarchy(index, hiddenUri, positionAt(hiddenSource, "Shape {"));
      const [visibleShape] = prepareTypeHierarchy(index, shapeUri, positionAt(shapeSource, "Shape {"));
      expect(subtypes(index, hiddenShape!).map((item) => item.name)).not.toContain("Sprite");
      expect(subtypes(index, visibleShape!).map((item) => item.name)).toContain("Sprite");
      expect(implementation(index, hiddenUri, positionAt(hiddenSource, "skeleton U0 Draw", "skeleton U0 ".length)).map((location) => location.uri)).not.toContain(uri);
      expect(implementation(index, shapeUri, positionAt(shapeSource, "skeleton U0 Draw", "skeleton U0 ".length)).map((location) => location.uri)).toContain(uri);
      const [drawDeclaration] = declaration(index, uri, positionAt(source, "Draw() {\n            ret;"));
      expect(drawDeclaration?.uri).toBe(shapeUri);
      expect(rangeText(shapeSource, drawDeclaration!.range)).toBe("Draw");
      const skeletonRename = rename(index, { textDocument: { uri: shapeUri }, position: positionAt(shapeSource, "skeleton U0 Draw", "skeleton U0 ".length), newName: "Render" });
      expect(Object.keys(skeletonRename.changes ?? {})).not.toContain(hiddenUri);
      expect(applyEdits(shapeSource, skeletonRename.changes?.[shapeUri] ?? [])).toContain("skeleton U0 Render();");
      expect(applyEdits(source, skeletonRename.changes?.[uri] ?? [])).toContain("U0 Render() {");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolves this and bare field references inside methods", () => {
    const source = `module app {
    class Box {
        I16 value;

        I16 Read() {
            this.value = value + this.value;
            ret value;
        }
    }

    I16 main() {
        Box b;
        ret b.Read();
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

    const thisPosition = positionAt(source, "this.value");
    const [thisDefinition] = definition(index, uri, thisPosition);
    expect(thisDefinition?.range.start.line).toBe(positionAt(source, "Box {").line);
    const [thisType] = typeDefinition(index, uri, thisPosition);
    expect(thisType?.range.start.line).toBe(positionAt(source, "Box {").line);
    expect(prepareRename(index, uri, thisPosition)).toBeNull();

    const fieldPosition = positionAt(source, "ret value", "ret ".length);
    const [fieldDefinition] = definition(index, uri, fieldPosition);
    expect(fieldDefinition?.range.start.line).toBe(positionAt(source, "value;").line);
    const fieldReferences = references(index, uri, fieldPosition, true)
      .map((location) => rangeText(source, location.range))
      .filter((text) => text === "value");
    expect(fieldReferences).toHaveLength(5);
    const tokens = decodedSemanticTokens(source, semanticTokens(state).data);
    const retValueToken = tokens.find((token) => token.line === fieldPosition.line && token.character === fieldPosition.character);
    expect(retValueToken).toMatchObject({ text: "value", tokenType: "property" });

    const selfSource = source.replace("this.value;\n            ret value;", "self.value;\n            ret value;");
    const selfFixture = fixtureIndex(selfSource);
    expect(selfFixture.index.lspDiagnostics(selfFixture.state.uri).some((diagnostic) =>
      diagnostic.code === "vela.sem.unknownIdentifier"
      && typeof diagnostic.message === "string"
      && diagnostic.message.includes("'self'"))).toBe(true);
  });

  it("marks document highlight reads and writes for locals, fields, and ASM bindings", () => {
    const source = `module app {
    class Box {
        I16 value;

        I16 Read() {
            I16 x = 1;
            x = x + 1;
            value = x;
            this.value = value + x;
            ASM(
                [[in]] R0 = x;
                [[out]] R1 = x;
            ) {
                MOV R1, R0
            }
            ret x;
        }
    }

    I16 main() {
        ret 0;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

    const localHighlights = highlights(index, uri, positionAt(source, "ret x", "ret ".length));
    const localWriteRanges = localHighlights
      .filter((highlight) => highlight.kind === DocumentHighlightKind.Write)
      .map((highlight) => rangeText(source, highlight.range));
    expect(localHighlights.filter((highlight) => highlight.kind === DocumentHighlightKind.Read)).toHaveLength(6);
    expect(localWriteRanges).toEqual(["x", "x"]);
    expect(rangeText(source, localHighlights.find((highlight) => highlight.range.start.line === positionAt(source, "I16 x").line)!.range)).toBe("x");

    const fieldHighlights = highlights(index, uri, positionAt(source, "this.value", "this.".length));
    const fieldWriteLines = fieldHighlights
      .filter((highlight) => highlight.kind === DocumentHighlightKind.Write)
      .map((highlight) => highlight.range.start.line)
      .sort((a, b) => a - b);
    expect(fieldHighlights.filter((highlight) => highlight.kind === DocumentHighlightKind.Read)).toHaveLength(2);
    expect(fieldWriteLines).toEqual([
      positionAt(source, "value = x").line,
      positionAt(source, "this.value").line,
    ]);
  });

  it("keeps field references distinct from shadowing parameters during rename", () => {
    const source = `module app {
    class Box {
        I16 value;

        I16 Read(I16 value) {
            this.value = this.value;
            value = value + 1;
            ret value;
        }
    }

    I16 main() {
        Box b;
        ret b.Read(0);
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

    const fieldPosition = positionAt(source, "this.value", "this.".length);
    const paramPosition = positionAt(source, "I16 value)", "I16 ".length);
    const [fieldDefinition] = definition(index, uri, fieldPosition);
    const [paramDefinition] = definition(index, uri, positionAt(source, "ret value", "ret ".length));
    expect(fieldDefinition?.range.start.line).toBe(positionAt(source, "value;").line);
    expect(paramDefinition?.range.start.line).toBe(positionAt(source, "I16 value)").line);

    const fieldEdit = rename(index, { textDocument: { uri }, position: fieldPosition, newName: "count" });
    const fieldUpdated = applyEdits(source, fieldEdit.changes?.[uri] ?? []);
    expect(fieldUpdated).toContain("I16 count;");
    expect(fieldUpdated).toContain("this.count = this.count;");
    expect(fieldUpdated).toContain("I16 Read(I16 value)");
    expect(fieldUpdated).toContain("ret value;");

    const paramEdit = rename(index, { textDocument: { uri }, position: paramPosition, newName: "amount" });
    const paramUpdated = applyEdits(source, paramEdit.changes?.[uri] ?? []);
    expect(paramUpdated).toContain("I16 value;");
    expect(paramUpdated).toContain("this.value = this.value;");
    expect(paramUpdated).toContain("I16 Read(I16 amount)");
    expect(paramUpdated).toContain("amount = amount + 1;");
    expect(paramUpdated).toContain("ret amount;");
  });

  it("finds implementations for type declarations and class bases", () => {
    const source = `module app {
    type Drawable {
        skeleton U0 Draw();
    }

    class Base {
        I16 Value() {
            ret 1;
        }
    }

    class Sprite : Drawable {
        U0 Draw() {
            ret;
        }
    }

    class Child : Base {
    }

    I16 main() {
        ret 0;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const typeImpls = implementation(index, uri, positionAt(source, "Drawable {")).map((location) => location.range.start.line);
    expect(typeImpls).toContain(positionAt(source, "Sprite :").line);
    const skeletonImpls = implementation(index, uri, positionAt(source, "skeleton U0 Draw", "skeleton U0 ".length)).map((location) => location.range.start.line);
    expect(skeletonImpls).toContain(positionAt(source, "Draw() {\n            ret;").line);
    const classImpls = implementation(index, uri, positionAt(source, "Base {")).map((location) => location.range.start.line);
    expect(classImpls).toContain(positionAt(source, "Child :").line);
  });

  it("resolves method declarations to overridden parents and skeletons", () => {
    const source = `module app {
    type Drawable {
        skeleton U0 Draw();
    }

    class Base {
        I16 Value() {
            ret 1;
        }
    }

    class Child : Base {
        I16 Value() {
            ret 2;
        }
    }

    class Sprite : Drawable {
        U0 Draw() {
            ret;
        }
    }

    I16 main() {
        Child c;
        Sprite s;
        c.Value();
        s.Draw();
        ret 0;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

    const childValue = positionAt(source, "Value() {\n            ret 2");
    const [valueDeclaration] = declaration(index, uri, childValue);
    expect(valueDeclaration?.range.start.line).toBe(positionAt(source, "Value() {\n            ret 1").line);
    const [valueDefinition] = definition(index, uri, childValue);
    expect(valueDefinition?.range.start.line).toBe(childValue.line);

    const spriteDraw = positionAt(source, "Draw() {\n            ret;");
    const [drawDeclaration] = declaration(index, uri, spriteDraw);
    expect(drawDeclaration?.range.start.line).toBe(positionAt(source, "skeleton U0 Draw").line);

    const drawCall = positionAt(source, "s.Draw", "s.".length);
    const [callDeclaration] = declaration(index, uri, drawCall);
    expect(callDeclaration?.range.start.line).toBe(positionAt(source, "skeleton U0 Draw").line);

    const skeletonDraw = positionAt(source, "skeleton U0 Draw", "skeleton U0 ".length);
    const [skeletonDefinition] = definition(index, uri, skeletonDraw);
    expect(skeletonDefinition?.range.start.line).toBe(skeletonDraw.line);
    const skeletonHover = hover(index, uri, skeletonDraw)?.contents as { value?: string } | undefined;
    expect(skeletonHover?.value).toContain("U0 Draw()");
    const skeletonToken = decodedSemanticTokens(source, semanticTokens(state).data)
      .find((token) => token.line === skeletonDraw.line && token.character === skeletonDraw.character);
    expect(skeletonToken).toMatchObject({ text: "Draw", tokenType: "method" });
    expect(skeletonToken?.tokenModifiers).toEqual(expect.arrayContaining(["declaration", "definition"]));
    const familyReferenceLines = references(index, uri, skeletonDraw, true)
      .map((location) => location.range.start.line)
      .sort((a, b) => a - b);
    expect(familyReferenceLines).toEqual([skeletonDraw.line, spriteDraw.line, drawCall.line].sort((a, b) => a - b));
    const familyHighlightLines = highlights(index, uri, drawCall)
      .map((highlight) => highlight.range.start.line)
      .sort((a, b) => a - b);
    expect(familyHighlightLines).toEqual([skeletonDraw.line, spriteDraw.line, drawCall.line].sort((a, b) => a - b));

    expect(prepareRename(index, uri, skeletonDraw)).toMatchObject({ placeholder: "Draw" });
    const skeletonRename = applyEdits(source, rename(index, { textDocument: { uri }, position: skeletonDraw, newName: "Render" }).changes?.[uri] ?? []);
    expect(skeletonRename).toContain("skeleton U0 Render();");
    expect(skeletonRename).toContain("U0 Render() {\n            ret;");
    expect(skeletonRename).toContain("s.Render();");

    const implementationRename = applyEdits(source, rename(index, { textDocument: { uri }, position: spriteDraw, newName: "Paint" }).changes?.[uri] ?? []);
    expect(implementationRename).toContain("skeleton U0 Paint();");
    expect(implementationRename).toContain("U0 Paint() {\n            ret;");
    expect(implementationRename).toContain("s.Paint();");
  });

  it("renames tagged fields together with generated accessor calls", () => {
    const source = `module app {
    class Box {
        [[get, set]] I16 value;
    }

    I16 main() {
        Box box;
        box.SetValue(2);
        ret box.GetValue();
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(prepareRename(index, uri, positionAt(source, "value;"))).toMatchObject({ placeholder: "value" });
    const edit = rename(index, { textDocument: { uri }, position: positionAt(source, "value;"), newName: "amount" });
    const renamed = applyEdits(state.text, edit.changes?.[uri] ?? []);
    expect(renamed).toContain("[[get, set]] I16 amount;");
    expect(renamed).toContain("box.SetAmount(2);");
    expect(renamed).toContain("ret box.GetAmount();");
    expect(renamed).not.toContain("GetValue");
    expect(renamed).not.toContain("SetValue");

    const getPosition = positionAt(source, "GetValue");
    const accessorPrepare = prepareRename(index, uri, getPosition) as { range: { start: { line: number; character: number }; end: { line: number; character: number } }; placeholder: string } | null;
    expect(accessorPrepare?.placeholder).toBe("GetValue");
    expect(rangeText(source, accessorPrepare!.range)).toBe("GetValue");
    const accessorEdit = rename(index, { textDocument: { uri }, position: getPosition, newName: "GetAmount" });
    const accessorRenamed = applyEdits(state.text, accessorEdit.changes?.[uri] ?? []);
    expect(accessorRenamed).toContain("[[get, set]] I16 amount;");
    expect(accessorRenamed).toContain("box.SetAmount(2);");
    expect(accessorRenamed).toContain("ret box.GetAmount();");
    expect(rename(index, { textDocument: { uri }, position: getPosition, newName: "FetchAmount" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: getPosition, newName: "GetTrue" })).toEqual({});
  });

  it("renames generated accessors for the selected class when hidden classes share its name", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-accessor-visibility-"));
    try {
      const hiddenSource = `module hidden {
    class Box {
        [[get, set]] I16 value;
    }

    I16 hiddenUse() {
        Box box;
        box.SetValue(1);
        ret box.GetValue();
    }
}
`;
      const hiddenPath = join(tempRoot, "aaa-hidden.vl");
      writeFileSync(hiddenPath, hiddenSource);

      const source = `module app {
    class Box {
        [[get, set]] I16 value;
    }

    I16 main() {
        Box box;
        box.SetValue(2);
        ret box.GetValue();
    }
}`;
      const uri = pathToFileURL(join(tempRoot, "app.vl")).toString();
      const index = new WorkspaceIndex(resolve("."));
      index.configure([tempRoot], { projectRoot: tempRoot, requireMainDiagnostic: "off" });
      index.indexWorkspace();
      const state = index.updateOpenDocument(uri, source);
      expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

      const hiddenUri = pathToFileURL(hiddenPath).toString();
      const edit = rename(index, { textDocument: { uri }, position: positionAt(source, "value;"), newName: "amount" });
      expect(Object.keys(edit.changes ?? {})).not.toContain(hiddenUri);
      const renamed = applyEdits(state.text, edit.changes?.[uri] ?? []);
      expect(renamed).toContain("[[get, set]] I16 amount;");
      expect(renamed).toContain("box.SetAmount(2);");
      expect(renamed).toContain("ret box.GetAmount();");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("diagnoses collisions with implicitly included Storeable declarations", () => {
    const topLevelCollision = `module app {
    I16 Storeable() {
        ret 1;
    }

    class Box {
        OnAlloc() {}
    }

    I16 main() {
        ret 0;
    }
}`;
    const topLevel = fixtureIndex(topLevelCollision);
    expect(topLevel.state.analysis.diagnostics.map((diagnostic) => diagnostic.code)).toContain("vela.sem.includedTopLevelCollision");

    const assemblyCollision = `module app {
    I16 Storeable_OnFree() {
        ret 1;
    }

    class Box {
        OnAlloc() {}
    }

    I16 main() {
        ret 0;
    }
}`;
    const assembly = fixtureIndex(assemblyCollision);
    expect(assembly.state.analysis.diagnostics.map((diagnostic) => diagnostic.code)).toContain("vela.sem.flatAssemblyCollision");

    const crossModuleTopLevel = `module first {
    I16 helper() {
        ret 1;
    }
}

module second {
    I16 helper() {
        ret 2;
    }

    I16 main() {
        ret helper();
    }
}`;
    const crossModule = fixtureIndex(crossModuleTopLevel);
    expect(crossModule.state.analysis.diagnostics.map((diagnostic) => diagnostic.code)).toContain("vela.sem.includedTopLevelCollision");

    const crossModuleAssembly = `module first {
    class Box {
        OnAlloc() {}
    }
}

module second {
    I16 Box_OnFree() {
        ret 1;
    }

    I16 main() {
        ret 0;
    }
}`;
    const crossModuleAsm = fixtureIndex(crossModuleAssembly);
    expect(crossModuleAsm.state.analysis.diagnostics.map((diagnostic) => diagnostic.code)).toContain("vela.sem.flatAssemblyCollision");
  });

  it("rejects rename edits that would collide in the target scope", () => {
    const source = `module app {
    class Box {
        I16 value;
        I16 other;

        I16 Read() {
            ret value;
        }
    }

    class Base {
        I16 inherited;
    }

    class Child : Base {
        I16 childOnly;
    }

    I16 helper() {
        ret 1;
    }

    I16 Box_Process() {
        ret 2;
    }

    I16 main() {
        I16 count = helper();
        I16 total = count;
        ret total;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

    const modulePosition = positionAt(source, "module app", "module ".length);
    expect(prepareRename(index, uri, modulePosition)).toBeNull();
    expect(rename(index, { textDocument: { uri }, position: modulePosition, newName: "renamed" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "helper() {"), newName: "main" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "helper() {"), newName: "Box_Read" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "helper() {"), newName: "Box_OnFree" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "helper() {"), newName: "Storeable" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "helper() {"), newName: "Storeable_OnFree" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "Box {"), newName: "main" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "helper() {"), newName: "space" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "helper() {"), newName: "__helper" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "Read() {"), newName: "Process" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "value;"), newName: "other" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "childOnly;"), newName: "inherited" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "inherited;"), newName: "childOnly" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "count ="), newName: "total" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "count ="), newName: "if" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "count ="), newName: "Print" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "count ="), newName: "I16" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "count ="), newName: "true" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "count ="), newName: "false" })).toEqual({});
    expect(rename(index, { textDocument: { uri }, position: positionAt(source, "count ="), newName: "null" })).toEqual({});

    const validRename = rename(index, { textDocument: { uri }, position: positionAt(source, "helper() {"), newName: "calculate" });
    const edits = validRename.changes?.[uri] ?? [];
    const renamed = applyEdits(state.text, edits);
    expect(renamed).toContain("I16 calculate()");
    expect(renamed).toContain("I16 count = calculate();");
  });

  it("rejects flat assembly rename collisions when hidden types share a class name", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-assembly-visibility-"));
    try {
      writeFileSync(join(tempRoot, "aaa-hidden.vl"), `module hidden {
    type Box {
        skeleton I16 Read();
    }
}
`);
      const source = `module app {
    class Box {
        I16 Read() {
            ret 1;
        }
    }

    I16 helper() {
        ret 2;
    }

    I16 main() {
        Box box;
        ret box.Read();
    }
}`;
      const uri = pathToFileURL(join(tempRoot, "app.vl")).toString();
      const index = new WorkspaceIndex(resolve("."));
      index.configure([tempRoot], { projectRoot: tempRoot, requireMainDiagnostic: "off" });
      index.indexWorkspace();
      const state = index.updateOpenDocument(uri, source);
      expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

      expect(rename(index, { textDocument: { uri }, position: positionAt(source, "helper() {"), newName: "Box_Read" })).toEqual({});
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("offers quick fixes to rename reserved or conflicting declarations", () => {
    const reservedSource = `module app {
    I16 __helper() {
        ret 1;
    }

    I16 main() {
        ret __helper();
    }
}`;
    const { index: reservedIndex, state: reservedState } = fixtureIndex(reservedSource);
    const reserved = reservedIndex.lspDiagnostics(reservedState.uri).find((diagnostic) => diagnostic.code === "vela.sem.reservedName");
    expect(reserved).toBeDefined();
    const reservedAction = codeActions(reservedIndex, reservedState, [reserved!]).find((item) => item.title === "Rename '__helper' to 'helper'");
    const reservedText = applyEdits(reservedState.text, reservedAction?.edit?.changes?.[reservedState.uri] ?? []);
    expect(reservedText).toContain("I16 helper()");
    expect(reservedText).toContain("ret helper();");

    const duplicateSource = `module app {
    I16 helper() {
        ret 1;
    }

    I16 helper() {
        ret 2;
    }

    I16 main() {
        ret helper();
    }
}`;
    const { index: duplicateIndex, state: duplicateState } = fixtureIndex(duplicateSource);
    const duplicate = duplicateIndex.lspDiagnostics(duplicateState.uri).find((diagnostic) => diagnostic.code === "vela.sem.duplicateTopLevel");
    expect(duplicate).toBeDefined();
    const duplicateAction = codeActions(duplicateIndex, duplicateState, [duplicate!]).find((item) => item.title === "Rename 'helper' to 'helper2'");
    const duplicateText = applyEdits(duplicateState.text, duplicateAction?.edit?.changes?.[duplicateState.uri] ?? []);
    expect(duplicateText).toContain("I16 helper2() {\n        ret 2;");
  });

  it("reports related information for duplicate parameters", () => {
    const source = `module app {
    I16 helper(I16 value, I16 value) {
        ret value;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const duplicate = index.lspDiagnostics(state.uri).find((diagnostic) => diagnostic.code === "vela.sem.duplicateParameter");
    expect(duplicate).toBeDefined();
    expect(duplicate?.relatedInformation?.[0]?.message).toBe("previous parameter");
    expect(duplicate?.relatedInformation?.[0]?.location.range.start.character).toBeLessThan(duplicate!.range.start.character);
  });

  it("reports related information for duplicate members and locals", () => {
    const source = `module app {
    type Shape {
        skeleton U0 Draw();
        skeleton U0 Draw();
    }

    class Base {
        I16 inherited;
    }

    class Box : Base {
        I16 inherited;
        I16 value;
        I16 value;

        I16 Run() {
            ret 1;
        }

        I16 Run() {
            ret 2;
        }
    }

    I16 helper() {
        I16 local;
        I16 local;
        ret local;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const diagnostics = index.lspDiagnostics(state.uri);
    expect(diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.duplicateTypeMethod")?.relatedInformation?.[0]?.message).toBe("previous type method");
    expect(diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.inheritedFieldDuplicate")?.relatedInformation?.[0]?.message).toBe("inherited field");
    expect(diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.duplicateField")?.relatedInformation?.[0]?.message).toBe("previous field");
    expect(diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.duplicateMethod")?.relatedInformation?.[0]?.message).toBe("previous method");
    expect(diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.duplicateLocal")?.relatedInformation?.[0]?.message).toBe("previous declaration in this scope");
  });

  it("reports related information for tag-generated method collisions", () => {
    const source = `module app {
    class Box {
        [[get]] I16 value;

        I16 GetValue() {
            ret value;
        }
    }
}`;
    const { index, state } = fixtureIndex(source);
    const collision = index.lspDiagnostics(state.uri).find((diagnostic) => diagnostic.code === "vela.sem.tagMethodCollision");
    expect(collision).toBeDefined();
    expect(collision?.relatedInformation?.[0]?.message).toBe("explicit method");
  });

  it("reports unknown field tags at the precise tag range", () => {
    const source = `module app {
    class Box {
        [[get, exposed]] I16 value;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const diagnostic = index.lspDiagnostics(state.uri).find((item) => item.code === "vela.sem.unknownTag");
    expect(diagnostic?.message).toContain("exposed");
    expect(source.slice(lspPositionToOffset(source, diagnostic!.range.start), lspPositionToOffset(source, diagnostic!.range.end))).toBe("exposed");
  });

  it("does not add same-type compatibility noise for out-of-range integer literals", () => {
    const source = `module app {
    class Box {
        OnAlloc(I16 value) {
        }
    }

    I16 global = -32769;

    U0 Take(I16 value) {
        ret;
    }

    I16 main() {
        I16 local = 0;
        local = -32769;
        Take(-32769);
        Box box = Init<Box>(value: -32769);
        ret -32769;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const diagnostics = index.lspDiagnostics(state.uri);
    expect(diagnostics.filter((diagnostic) => diagnostic.code === "vela.sem.integerOutOfRange")).toHaveLength(5);
    expect(diagnostics.some((diagnostic) => [
      "vela.sem.incompatibleInitializer",
      "vela.sem.incompatibleAssignment",
      "vela.sem.incompatibleReturn",
      "vela.sem.argumentType",
      "vela.sem.initArgType",
    ].includes(String(diagnostic.code)))).toBe(false);
  });

  it("enforces static global initializer rules", () => {
    const source = `module app {
    I16 dynamic = 1 + 2;
    Ptr<U8> text = "Hi";
    Ptr<I16> ptr = null;
    U8 letter = 'A';
    F16 ratio = 1.5;

    I16 main() {
        ret letter;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const diagnostics = index.lspDiagnostics(state.uri);
    const dynamicInitializers = diagnostics.filter((diagnostic) => diagnostic.code === "vela.sem.dynamicGlobalInitializer");
    expect(dynamicInitializers).toHaveLength(2);
    expect(dynamicInitializers.map((diagnostic) => rangeText(source, diagnostic.range))).toEqual(["1 + 2", "\"Hi\""]);
    expect(diagnostics.some((diagnostic) => diagnostic.code === "vela.sem.incompatibleInitializer")).toBe(false);
    expect(diagnostics.some((diagnostic) => diagnostic.code === "vela.sem.voidStorage")).toBe(false);
  });

  it("rejects address-of for locals that shadow addressable fields", () => {
    const source = `module app {
    class Box {
        I16 value;

        I16 Read() {
            I16 value = 1;
            Ptr<I16> localPointer = &value;
            Ptr<I16> fieldPointer = &this.value;
            ret value;
        }
    }

    I16 main() {
        ret 0;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const diagnostics = index.lspDiagnostics(state.uri);
    const localAddress = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.addressOfLocal");
    expect(localAddress).toBeDefined();
    expect(rangeText(source, localAddress!.range)).toBe("&value");
    expect(diagnostics.filter((diagnostic) => diagnostic.code === "vela.sem.addressOfNonAddressable")).toEqual([]);
  });

  it("allows pointer-compatible stdlib Bool values without allowing integer Bool coercion", () => {
    const pointerCompatible = `module app {
    import stdlib::types::{bool};

    U0 Take(Bool flag) {
        ret;
    }

    I16 main() {
        Bool flag = null;
        Bool other = Init<Bool>(val: 1);
        flag = null;
        Take(null);
        if (flag && true) {
            ret other.GetValue();
        }
        ret 0;
    }
}`;
    const ok = workspaceFixtureIndex(pointerCompatible);
    expect(ok.state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

    const integerCoercion = `module app {
    import stdlib::types::{bool};

    I16 main() {
        Bool flag = 1;
        flag = 1;
        ret 0;
    }
}`;
    const rejected = workspaceFixtureIndex(integerCoercion);
    const diagnostics = rejected.index.lspDiagnostics(rejected.state.uri);
    expect(diagnostics.some((diagnostic) => diagnostic.code === "vela.sem.boolInitializer")).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.code === "vela.sem.boolAssignment")).toBe(true);
  });

  it("suggests close matches for unknown type and parent diagnostics", () => {
    const source = `module app {
    type Drawable {
        skeleton U0 Draw();
    }

    class Widget {
        I16 Value() {
            ret 0;
        }
    }

    alias Word <- I16;

    class Sprite : Drawble {
        U0 Draw() {
            ret;
        }
    }

    I16 main() {
        Widgit item;
        Wrod count = 1;
        ret count;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const diagnostics = index.lspDiagnostics(state.uri);
    const parent = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.unknownParent");
    expect(parent?.message).toContain("did you mean 'Drawable'?");
    const widget = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.unknownType" && typeof diagnostic.message === "string" && diagnostic.message.includes("'Widgit'"));
    expect(widget?.message).toContain("did you mean 'Widget'?");
    const word = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.unknownType" && typeof diagnostic.message === "string" && diagnostic.message.includes("'Wrod'"));
    expect(word?.message).toContain("did you mean 'Word'?");
  });

  it("shows inferred hover types for operators and non-numeric literals", () => {
    const source = `module app {
    I16 main() {
        Ptr<U0> p = null;
        if (true && false) {
        }
        ret 0;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const boolHover = hover(index, uri, positionAt(source, "&&"))?.contents as { value?: string } | undefined;
    expect(boolHover?.value).toContain("Bool");
    const nullHover = hover(index, uri, positionAt(source, "null"))?.contents as { value?: string } | undefined;
    expect(nullHover?.value).toContain("Ptr<U0>");
  });

  it("shows class hover details for fields, methods, size, and layout", () => {
    const source = `module app {
    class Box {
        I16 value;

        I16 Read() {
            ret value;
        }
    }

    I16 main() {
        Box b;
        ret b.Read();
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const classHover = hover(index, uri, positionAt(source, "Box {"))?.contents as { value?: string } | undefined;
    expect(classHover?.value).toContain("class Box");
    expect(classHover?.value).toContain("size");
    expect(classHover?.value).toContain("field I16 value");
    expect(classHover?.value).toContain("offset");
    expect(classHover?.value).toContain("I16 Read()");
    expect(classHover?.value).toContain("vtable slot");
  });

  it("classifies semantic tokens from the symbol at each identifier reference", () => {
    const source = `module app {
    class Box {
        I16 Inc(I16 amount) {
            ret amount;
        }
    }

    I16 main() {
        Box b;
        ret b.Inc(1);
    }
}`;
    const { state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const tokens = decodedSemanticTokens(source, semanticTokens(state).data);
    const incPosition = positionAt(source, "b.Inc", "b.".length);
    const incCall = tokens.find((token) => token.line === incPosition.line && token.character === incPosition.character);
    expect(incCall).toMatchObject({ text: "Inc", tokenType: "method" });

    const amountPosition = positionAt(source, "ret amount", "ret ".length);
    const amountRef = tokens.find((token) => token.line === amountPosition.line && token.character === amountPosition.character);
    expect(amountRef).toMatchObject({ text: "amount", tokenType: "parameter" });
    const incDefinition = tokens.find((token) => token.text === "Inc" && token.line === positionAt(source, "Inc(I16").line);
    expect(incDefinition?.tokenModifiers).toEqual(expect.arrayContaining(["declaration", "definition"]));
  });

  it("classifies module, import, and alias semantic tokens precisely", () => {
    const source = `module app {
    import stdlib::types::{int};
    alias Word <- I16;

    I16 main() {
        Word value = 0;
        Ptr<U0> raw = null;
        if (true) {
        }
        ret value;
    }
}`;
    const { index, state } = workspaceFixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const tokens = decodedSemanticTokens(source, semanticTokens(state).data);

    const appPosition = positionAt(source, "app {");
    expect(tokens.find((token) => token.line === appPosition.line && token.character === appPosition.character)).toMatchObject({ text: "app", tokenType: "namespace" });

    for (const text of ["stdlib", "types", "int"]) {
      const position = positionAt(source, text);
      const token = tokens.find((item) => item.line === position.line && item.character === position.character);
      expect(token).toMatchObject({ text, tokenType: "namespace" });
      expect(token?.tokenModifiers).toEqual(expect.arrayContaining(["readonly", "defaultLibrary"]));
    }

    const aliasDecl = positionAt(source, "Word <-");
    const aliasUse = positionAt(source, "Word value");
    expect(tokens.find((token) => token.line === aliasDecl.line && token.character === aliasDecl.character)).toMatchObject({ text: "Word", tokenType: "type" });
    expect(tokens.find((token) => token.line === aliasUse.line && token.character === aliasUse.character)).toMatchObject({ text: "Word", tokenType: "type" });

    const nullPosition = positionAt(source, "null");
    const truePosition = positionAt(source, "true");
    expect(tokens.find((token) => token.line === nullPosition.line && token.character === nullPosition.character)).toMatchObject({ text: "null", tokenType: "keyword" });
    expect(tokens.find((token) => token.line === truePosition.line && token.character === truePosition.character)).toMatchObject({ text: "true", tokenType: "keyword" });

    const intState = index.allFiles().find((file) => file.path.replaceAll("\\", "/").endsWith("stdlib/types/int.vl"));
    expect(intState).toBeDefined();
    const intTokens = decodedSemanticTokens(intState!.text, semanticTokens(intState!).data);
    const intModule = intTokens.find((token) => token.text === "int" && token.line === 0);
    expect(intModule).toMatchObject({ text: "int", tokenType: "namespace" });
    expect(intModule?.tokenModifiers).toEqual(expect.arrayContaining(["readonly", "defaultLibrary"]));
  });

  it("classifies compound, postfix, address-of, and alias-arrow tokens as operators", () => {
    const source = `module app {
    alias Word <- I16;
    I16 global = 0;

    I16 main() {
        I16 count = 1;
        count += 2;
        count++;
        Ptr<I16> pointer = &global;
        ret count;
    }
}`;
    const { state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const tokens = decodedSemanticTokens(source, semanticTokens(state).data);
    for (const [text, position] of [
      ["<-", positionAt(source, "<-")],
      ["+=", positionAt(source, "+=")],
      ["++", positionAt(source, "++")],
      ["&", positionAt(source, "&global")],
    ] as const) {
      expect(tokens.find((token) => token.line === position.line && token.character === position.character)).toMatchObject({ text, tokenType: "operator" });
    }
  });

  it("limits range semantic tokens to the requested character span", () => {
    const source = `module app {
    I16 one = 1; I16 two = 2;
}`;
    const { state } = fixtureIndex(source);
    const start = positionAt(source, "one =");
    const tokens = decodedSemanticTokens(source, semanticTokens(state, {
      start,
      end: { line: start.line, character: start.character + "one".length },
    }).data);
    expect(tokens.map((token) => token.text)).toEqual(["one"]);
  });

  it("marks stdlib semantic tokens as readonly default library symbols", () => {
    const source = `module app {
    import stdlib::types::{int};

    I16 main() {
        Int value = 1;
        ret value.GetValue();
    }
}`;
    const { state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const tokens = decodedSemanticTokens(source, semanticTokens(state).data);
    const intPosition = positionAt(source, "Int value");
    const intToken = tokens.find((token) => token.line === intPosition.line && token.character === intPosition.character);
    expect(intToken).toMatchObject({ text: "Int", tokenType: "class" });
    expect(intToken?.tokenModifiers).toEqual(expect.arrayContaining(["readonly", "defaultLibrary"]));

    const methodPosition = positionAt(source, "GetValue");
    const methodToken = tokens.find((token) => token.line === methodPosition.line && token.character === methodPosition.character);
    expect(methodToken).toMatchObject({ text: "GetValue", tokenType: "method" });
    expect(methodToken?.tokenModifiers).toEqual(expect.arrayContaining(["readonly", "defaultLibrary"]));
  });

  it("classifies ASM binding registers as enum members", () => {
    const source = `module app {
    class Box {
        [[get, visible]] I16 value;
    }

    I16 main() {
        I16 input = 1;
        I16 output = 0;
        ASM(
            [[in]] R0 = input;
            [[out]] R1 = output;
        ) {
start:
            MOV R1, R0
            B start
        }
        ret output;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const tokens = decodedSemanticTokens(source, semanticTokens(state).data);
    for (const register of ["R0", "R1"]) {
      const position = positionAt(source, `${register} =`);
      const token = tokens.find((item) => item.line === position.line && item.character === position.character);
      expect(token).toMatchObject({ text: register, tokenType: "enumMember" });
    }
    const bodyRegisterPosition = positionAt(source, "R1, R0", "R1, ".length);
    expect(tokens.find((item) => item.line === bodyRegisterPosition.line && item.character === bodyRegisterPosition.character)).toMatchObject({ text: "R0", tokenType: "enumMember" });
    expect((hover(index, uri, bodyRegisterPosition)?.contents as { value?: string } | undefined)?.value).toContain("ASM register");
    const instructionPosition = positionAt(source, "MOV R1");
    expect(tokens.find((item) => item.line === instructionPosition.line && item.character === instructionPosition.character)).toMatchObject({ text: "MOV", tokenType: "macro" });
    expect((hover(index, uri, instructionPosition)?.contents as { value?: string } | undefined)?.value).toContain("ASM instruction mnemonic");
    const labelDefinitionPosition = positionAt(source, "start:");
    const labelDefinition = tokens.find((item) => item.line === labelDefinitionPosition.line && item.character === labelDefinitionPosition.character);
    expect(labelDefinition).toMatchObject({ text: "start", tokenType: "function" });
    expect(labelDefinition?.tokenModifiers).toContain("declaration");
    expect(labelDefinition?.tokenModifiers).toContain("definition");
    expect((hover(index, uri, labelDefinitionPosition)?.contents as { value?: string } | undefined)?.value).toContain("ASM label definition");
    const labelReferencePosition = positionAt(source, "B start", "B ".length);
    expect(tokens.find((item) => item.line === labelReferencePosition.line && item.character === labelReferencePosition.character)).toMatchObject({ text: "start", tokenType: "function" });
    expect((hover(index, uri, labelReferencePosition)?.contents as { value?: string } | undefined)?.value).toContain("ASM branch target");
    const tagPositions = [
      ["get", positionAt(source, "[[get", 2)],
      ["visible", positionAt(source, "visible")],
      ["in", positionAt(source, "[[in", 2)],
      ["out", positionAt(source, "[[out", 2)],
    ] as const;
    for (const [tag, position] of tagPositions) {
      const token = tokens.find((item) => item.line === position.line && item.character === position.character);
      expect(token).toMatchObject({ text: tag, tokenType: "enumMember" });
    }
  });

  it("offers compiler-valid value completions inside ASM bindings", () => {
    const source = `module app {
    I16 global = 1;

    class Box {
        I16 value;

        I16 Abs(I16 input) {
            I16 result = 0;
            ASM(
                [[in]] R0 = input;
                [[out]] R1 = result;
            ) {
                MOV R1, R0
            }
            ret result;
        }
    }

    I16 main() {
        Box b;
        ret b.Abs(1);
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const items = completions(index, uri, positionAt(source, "R0 = input", "R0 = ".length));
    const labels = items.map((item) => item.label);
    expect(labels).toEqual(expect.arrayContaining(["R0", "R9", "global", "value", "input", "result", "this"]));
    expect(items.find((item) => item.label === "R0")).toMatchObject({
      detail: "ASM register",
      documentation: "General-purpose CPU register usable in ASM bindings.",
      sortText: "0_R0",
      commitCharacters: [" ", "=", ";"],
    });
    expect(items.find((item) => item.label === "result")?.sortText).toBe("1_result");
    expect(items.find((item) => item.label === "value")?.sortText).toBe("2_value");
    expect(labels).not.toContain("self");
  });

  it("adds metadata to field and ASM tag completions", () => {
    const source = `module app {
    class Box {
        [[g]] I16 value;

        U0 Load(I16 input) {
            ASM(
                [[i]] R0 = input;
            ) {
                MOV R0, R0
            }
            ret;
        }
    }
}`;
    const { index, uri } = fixtureIndex(source);
    const fieldTags = completions(index, uri, positionAt(source, "[[g", 2));
    expect(fieldTags.find((item) => item.label === "get")).toMatchObject({
      detail: "Vela field tag",
      documentation: "Generates a getter method for the field.",
      sortText: "0_get",
      commitCharacters: ["]", ","],
    });
    expect(fieldTags.map((item) => item.label)).toEqual(expect.arrayContaining(["get", "set", "visible"]));

    const asmTags = completions(index, uri, positionAt(source, "[[i", 2));
    expect(asmTags.find((item) => item.label === "in")).toMatchObject({
      detail: "ASM binding tag",
      documentation: "Binds a visible Vela value as an ASM input register.",
      sortText: "0_in",
      commitCharacters: ["]", ","],
    });
    expect(asmTags.map((item) => item.label)).toEqual(expect.arrayContaining(["in", "out"]));
  });

  it("diagnoses invalid ASM binding tags", () => {
    const source = `module app {
    I16 main() {
        I16 input = 1;
        ASM(
            [[bad]] R0 = input;
        ) {
            MOV R0, R0
        }
        ret input;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const diagnostic = index.lspDiagnostics(state.uri).find((item) => item.code === "vela.sem.invalidAsmTag");
    expect(diagnostic?.message).toContain("bad");
    expect(source.slice(lspPositionToOffset(source, diagnostic!.range.start), lspPositionToOffset(source, diagnostic!.range.end))).toBe("bad");
  });

  it("completes inherited class and implicit Storeable members", () => {
    const source = `module app {
    class Base {
        I16 root;
        I16 Foo() {
            ret root;
        }
    }

    class Child : Base {
        I16 leaf;
    }

    I16 main() {
        Child c;
        ret c.GetSize();
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const memberItems = completions(index, uri, positionAt(source, "c.GetSize", "c.".length));
    const labels = memberItems.map((item) => item.label);
    expect(labels).toEqual(expect.arrayContaining(["root", "leaf", "Foo", "GetSize", "Pointer", "Reference"]));
    expect(memberItems.find((item) => item.label === "GetSize")?.commitCharacters).toContain("(");

    const typeReceiverSource = source.replace("ret c.GetSize();", "Child.\n        ret c.GetSize();");
    const { index: typeIndex, uri: typeUri } = fixtureIndex(typeReceiverSource);
    const typeReceiverLabels = completions(typeIndex, typeUri, positionAt(typeReceiverSource, "Child.\n", "Child.".length)).map((item) => item.label);
    expect(typeReceiverLabels).not.toContain("GetSize");
    expect(typeReceiverLabels).not.toContain("leaf");
  });

  it("offers member completions for class-valued receiver expressions", () => {
    const source = `module app {
    class Box {
        I16 value;

        I16 Read() {
            ret value;
        }
    }

    Box make() {
        ret Init<Box>();
    }

    I16 main() {
        make().;
        make().Re;
        Init<Box>().;
        ret 0;
    }
}`;
    const { index, uri } = fixtureIndex(source);
    const callLabels = completions(index, uri, positionAt(source, "make().", "make().".length)).map((item) => item.label);
    expect(callLabels).toEqual(expect.arrayContaining(["value", "Read"]));

    const partialLabels = completions(index, uri, positionAt(source, "make().Re", "make().Re".length)).map((item) => item.label);
    expect(partialLabels).toEqual(expect.arrayContaining(["value", "Read"]));

    const initLabels = completions(index, uri, positionAt(source, "Init<Box>().", "Init<Box>().".length)).map((item) => item.label);
    expect(initLabels).toEqual(expect.arrayContaining(["value", "Read"]));
  });

  it("offers class-body completions for skeleton implementations and overrides", () => {
    const source = `module app {
    type Drawable {
        skeleton U0 Draw(I16 color);
    }

    class Base {
        I16 Foo(I16 x) {
            ret x;
        }
    }

    class Sprite : Drawable {
    }

    class Child : Base {
    }

    I16 main() {
        ret 0;
    }
}`;
    const { index, uri } = fixtureIndex(source);
    const skeletonItems = completions(index, uri, positionAt(source, "class Sprite : Drawable {\n", "class Sprite : Drawable {\n".length));
    const draw = skeletonItems.find((item) => item.label === "Draw");
    expect(draw?.detail).toContain("Implement skeleton");
    expect(draw?.insertText).toContain("U0 Draw(I16 color)");
    expect(draw?.insertText).toContain("ret;");

    const overrideItems = completions(index, uri, positionAt(source, "class Child : Base {\n", "class Child : Base {\n".length));
    const foo = overrideItems.find((item) => item.label === "Foo");
    expect(foo?.detail).toContain("Override I16 Foo(I16 x)");
    expect(foo?.insertText).toContain("I16 Foo(I16 x)");
    expect(foo?.insertText).toContain("ret 0;");
  });

  it("offers a refactor to generate missing parent override stubs", () => {
    const source = `module app {
    class Base {
        I16 Foo(I16 x) {
            ret x;
        }

        U0 Reset() {
            ret;
        }
    }

    class Child : Base {
        I16 Foo(I16 x) {
            ret x;
        }
    }

    I16 main() {
        ret 0;
    }
}`;
    const { index, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);

    const action = codeActions(index, state, []).find((item) => item.title === "Generate overrides for class 'Child'");
    expect(action?.kind).toBe("refactor.rewrite");
    const edit = action?.edit?.changes?.[state.uri]?.[0];
    const updated = applyEdit(state.text, edit!);
    expect(updated).toContain("        U0 Reset() {\n            ret;\n        }\n    }\n");
    expect(updated.match(/I16 Foo\(I16 x\)/g)?.length).toBe(2);
  });

  it("offers refactors to generate get/set field tags", () => {
    const source = `module app {
    class Box {
        I16 value;
        [[visible]] I16 count;
        [[get, set]] I16 ready;
    }

    I16 main() {
        ret 0;
    }
}`;
    const { index, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const actions = codeActions(index, state, []);

    const valueAction = actions.find((item) => item.title === "Generate get/set tags for field 'value'");
    const valueEdit = valueAction?.edit?.changes?.[state.uri]?.[0];
    expect(valueAction?.kind).toBe("refactor.rewrite");
    expect(applyEdit(state.text, valueEdit!)).toContain("[[get, set]] I16 value;");

    const countAction = actions.find((item) => item.title === "Generate get/set tags for field 'count'");
    const countEdit = countAction?.edit?.changes?.[state.uri]?.[0];
    expect(applyEdit(state.text, countEdit!)).toContain("[[visible, get, set]] I16 count;");

    expect(actions.some((item) => item.title === "Generate get/set tags for field 'ready'")).toBe(false);
  });

  it("reports explicit and implicit type hierarchy relationships", () => {
    const source = `module app {
    type Drawable {
        skeleton U0 Draw();
    }

    class Plain {
        I16 Value() {
            ret 0;
        }
    }

    class Sprite : Drawable {
        U0 Draw() {
            ret;
        }
    }

    I16 main() {
        ret 0;
    }
}`;
    const { index, uri, state } = fixtureIndex(source);
    expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
    const [drawable] = prepareTypeHierarchy(index, uri, positionAt(source, "Drawable {"));
    expect(drawable).toBeDefined();
    expect(subtypes(index, drawable!).map((item) => item.name)).toContain("Sprite");
    const [plain] = prepareTypeHierarchy(index, uri, positionAt(source, "Plain"));
    expect(plain).toBeDefined();
    expect(supertypes(index, plain!).map((item) => item.name)).toContain("Storeable");
    const [storeable] = supertypes(index, plain!);
    expect(subtypes(index, storeable!).map((item) => item.name)).toContain("Plain");
  });

  it("offers a quick fix to implement missing skeleton methods", () => {
    const source = `module app {
    type Drawable {
        skeleton U0 Draw(I16 color);
    }

    class Sprite : Drawable {
    }

    I16 main() {
        ret 0;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const [missing] = index.lspDiagnostics(state.uri).filter((diagnostic) => diagnostic.code === "vela.sem.missingSkeleton");
    expect(missing).toBeDefined();
    const action = codeActions(index, state, [missing!]).find((item) => item.title === "Implement skeleton method 'Draw'");
    const edit = action?.edit?.changes?.[state.uri]?.[0];
    expect(edit?.newText).toContain("U0 Draw(I16 color)");
    expect(edit?.newText).toContain("ret;");
  });

  it("offers quick fixes to create missing class or type declarations", () => {
    const source = `module app {
    I16 main() {
        Missing value = null;
        ret 0;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const unknownType = index.lspDiagnostics(state.uri).find((diagnostic) => diagnostic.code === "vela.sem.unknownType");
    expect(unknownType).toBeDefined();
    const actions = codeActions(index, state, [unknownType!]);

    const createAlias = actions.find((item) => item.title === "Create alias 'Missing'");
    const aliasEdit = createAlias?.edit?.changes?.[state.uri]?.[0];
    expect(createAlias?.diagnostics).toEqual([unknownType]);
    expect(applyEdit(state.text, aliasEdit!)).toContain("    alias Missing <- I16;\n\n    I16 main()");

    const createClass = actions.find((item) => item.title === "Create class 'Missing'");
    const classEdit = createClass?.edit?.changes?.[state.uri]?.[0];
    expect(createClass?.diagnostics).toEqual([unknownType]);
    expect(applyEdit(state.text, classEdit!)).toContain("    class Missing {\n    }\n\n    I16 main()");

    const createType = actions.find((item) => item.title === "Create type 'Missing'");
    const typeEdit = createType?.edit?.changes?.[state.uri]?.[0];
    expect(applyEdit(state.text, typeEdit!)).toContain("    type Missing {\n    }\n\n    I16 main()");
  });

  it("offers quick fixes to create missing parent declarations", () => {
    const source = `module first {
}

module second {
    class Child : MissingParent {
    }

    I16 main() {
        ret 0;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const unknownParent = index.lspDiagnostics(state.uri).find((diagnostic) => diagnostic.code === "vela.sem.unknownParent");
    expect(unknownParent).toBeDefined();
    const actions = codeActions(index, state, [unknownParent!]);

    const createClass = actions.find((item) => item.title === "Create class 'MissingParent'");
    expect(createClass?.diagnostics).toEqual([unknownParent]);
    const withClass = applyEdit(state.text, createClass?.edit?.changes?.[state.uri]?.[0]!);
    expect(withClass).toContain("module first {\n}\n\nmodule second {\n    class MissingParent {\n    }\n\n    class Child");

    const createType = actions.find((item) => item.title === "Create type 'MissingParent'");
    expect(createType?.diagnostics).toEqual([unknownParent]);
    const withType = applyEdit(state.text, createType?.edit?.changes?.[state.uri]?.[0]!);
    expect(withType).toContain("module first {\n}\n\nmodule second {\n    type MissingParent {\n    }\n\n    class Child");
  });

  it("creates missing function skeletons with inferred parameters", () => {
    const source = `module app {
    I16 main() {
        I16 value = 1;
        ret Combine(value, 2);
    }
}`;
    const { index, state } = fixtureIndex(source);
    const diagnostic = index.lspDiagnostics(state.uri).find((item) => item.code === "vela.sem.unknownIdentifier" && typeof item.message === "string" && item.message.includes("'Combine'"));
    expect(diagnostic).toBeDefined();
    const action = codeActions(index, state, [diagnostic!]).find((item) => item.title === "Create function 'Combine'");
    const updated = applyEdit(state.text, action?.edit?.changes?.[state.uri]?.[0]!);
    expect(updated).toContain("    I16 Combine(I16 arg1, I16 arg2) {\n        ret 0;\n    }");
  });

  it("places create-declaration quick fixes in the module containing the diagnostic", () => {
    const source = `module first {
}

module second {
    I16 main() {
        Missing value = null;
        ret Combine(1);
    }
}`;
    const { index, state } = fixtureIndex(source);
    const diagnostics = index.lspDiagnostics(state.uri);
    const unknownType = diagnostics.find((item) => item.code === "vela.sem.unknownType" && typeof item.message === "string" && item.message.includes("'Missing'"));
    expect(unknownType).toBeDefined();
    const classAction = codeActions(index, state, [unknownType!]).find((item) => item.title === "Create class 'Missing'");
    const withClass = applyEdit(state.text, classAction?.edit?.changes?.[state.uri]?.[0]!);
    expect(withClass).toContain("module first {\n}\n\nmodule second {\n    class Missing");

    const unknownFunction = diagnostics.find((item) => item.code === "vela.sem.unknownIdentifier" && typeof item.message === "string" && item.message.includes("'Combine'"));
    expect(unknownFunction).toBeDefined();
    const functionAction = codeActions(index, state, [unknownFunction!]).find((item) => item.title === "Create function 'Combine'");
    const withFunction = applyEdit(state.text, functionAction?.edit?.changes?.[state.uri]?.[0]!);
    expect(withFunction.indexOf("    I16 Combine(I16 arg1)")).toBeGreaterThan(withFunction.indexOf("module second"));
  });

  it("scopes missing-import quick fixes to the module containing the diagnostic", () => {
    const source = `module first {
    import stdlib::types::{bool};
}

module second {
    I16 main() {
        Bool flag = null;
        ret 0;
    }
}`;
    const { index, state } = workspaceFixtureIndex(source);
    const diagnostic = index.lspDiagnostics(state.uri).find((item) => item.code === "vela.sem.unknownType" && typeof item.message === "string" && item.message.includes("'Bool'"));
    expect(diagnostic).toBeDefined();
    const action = codeActions(index, state, [diagnostic!]).find((item) => item.title === "Import 'Bool' from stdlib::types::{bool}");
    const updated = applyEdit(state.text, action?.edit?.changes?.[state.uri]?.[0]!);
    expect(updated).toContain("module second {\n    import stdlib::types::{bool};\n    I16 main()");
  });

  it("offers precise quick fixes for unsupported Print format arguments and Init argument names", () => {
    const source = `module app {
    class Box {
        OnAlloc(I16 value) {
        }
    }

    I16 main() {
        Ptr<Box> b = Init<Box>(valeu: 1);
        Print(42, "hex");
        ret 0;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const diagnostics = index.lspDiagnostics(state.uri);

    const printDiagnostic = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.printArity");
    expect(printDiagnostic).toBeDefined();
    const printAction = codeActions(index, state, [printDiagnostic!]).find((item) => item.title === "Remove unsupported Print format argument");
    const printEdit = printAction?.edit?.changes?.[state.uri]?.[0];
    expect(printEdit?.newText).toBe("");
    expect(applyEdit(state.text, printEdit!)).toContain("Print(42);");

    const initDiagnostic = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.initArgName");
    expect(initDiagnostic).toBeDefined();
    const initAction = codeActions(index, state, [initDiagnostic!]).find((item) => item.title === "Rename Init argument to 'value'");
    expect(initAction?.edit?.changes?.[state.uri]?.[0]?.newText).toBe("value");
  });

  it("offers a quick fix to reorder Init arguments to match OnAlloc", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-init-reorder-"));
    try {
      writeFileSync(join(tempRoot, "aaa-hidden.vl"), `module hidden {
    class Box {
        OnAlloc(I16 step, I16 initial) {
        }
    }
}
`);

      const source = `module app {
    class Box {
        OnAlloc(I16 initial, I16 step) {
        }
    }

    I16 main() {
        Box b = Init<Box>(step: 2, initial: 1);
        ret 0;
    }
}`;
      const uri = pathToFileURL(join(tempRoot, "app.vl")).toString();
      const index = new WorkspaceIndex(resolve("."));
      index.configure([tempRoot], { projectRoot: tempRoot, requireMainDiagnostic: "off" });
      index.indexWorkspace();
      const state = index.updateOpenDocument(uri, source);
      const diagnostics = index.lspDiagnostics(state.uri).filter((diagnostic) => diagnostic.code === "vela.sem.initArgName");
      expect(diagnostics).toHaveLength(2);
      const action = codeActions(index, state, [diagnostics[0]!]).find((item) => item.title === "Reorder Init<Box> arguments to match OnAlloc");
      expect(action?.diagnostics).toEqual([diagnostics[0]]);
      const edit = action?.edit?.changes?.[state.uri]?.[0];
      expect(applyEdit(state.text, edit!)).toContain("Init<Box>(initial: 1, step: 2)");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("offers cast quick fixes for explicit conversions and Ptr<U0> access", () => {
    const source = `module app {
    U0 Take(I16 value) {
        ret;
    }

    I16 main() {
        U16 wide = 65535;
        I16 narrow = wide;
        Ptr<U0> raw = null;
        I16 derefed = *raw;
        I16 indexed = raw[0];
        Take(wide);
        ret narrow + derefed + indexed;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const diagnostics = index.lspDiagnostics(state.uri);

    const initializer = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.incompatibleInitializer");
    expect(initializer).toBeDefined();
    const initializerAction = codeActions(index, state, [initializer!]).find((item) => item.title === "Cast expression to I16");
    expect(applyEdit(state.text, initializerAction?.edit?.changes?.[state.uri]?.[0]!)).toContain("I16 narrow = Cast<I16>(wide);");

    const argument = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.argumentType");
    expect(argument).toBeDefined();
    const argumentAction = codeActions(index, state, [argument!]).find((item) => item.title === "Cast expression to I16");
    expect(applyEdit(state.text, argumentAction?.edit?.changes?.[state.uri]?.[0]!)).toContain("Take(Cast<I16>(wide));");

    const deref = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.derefVoidPointer");
    expect(deref).toBeDefined();
    const derefAction = codeActions(index, state, [deref!]).find((item) => item.title === "Cast Ptr<U0> to Ptr<I16>");
    expect(applyEdit(state.text, derefAction?.edit?.changes?.[state.uri]?.[0]!)).toContain("I16 derefed = *Cast<Ptr<I16>>(raw);");

    const indexDiagnostic = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.indexVoidPointer");
    expect(indexDiagnostic).toBeDefined();
    const indexAction = codeActions(index, state, [indexDiagnostic!]).find((item) => item.title === "Cast Ptr<U0> to Ptr<I16>");
    expect(applyEdit(state.text, indexAction?.edit?.changes?.[state.uri]?.[0]!)).toContain("I16 indexed = Cast<Ptr<I16>>(raw)[0];");
  });

  it("offers integer condition comparison quick fixes only for integer conditions", () => {
    const source = `module app {
    I16 main() {
        I16 count = 1;
        Ptr<U0> raw = null;
        if (count) {
            count = count + 1;
        }
        while (raw) {
            ret count;
        }
        ret count;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const diagnostics = index.lspDiagnostics(state.uri);
    const integerCondition = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.ifCondition");
    expect(integerCondition).toBeDefined();
    const integerAction = codeActions(index, state, [integerCondition!]).find((item) => item.title === "Compare integer condition with zero");
    expect(integerAction?.diagnostics).toEqual([integerCondition]);
    expect(applyEdit(state.text, integerAction?.edit?.changes?.[state.uri]?.[0]!)).toContain("if (count != 0) {");

    const pointerCondition = diagnostics.find((diagnostic) => diagnostic.code === "vela.sem.whileCondition");
    expect(pointerCondition).toBeDefined();
    expect(codeActions(index, state, [pointerCondition!]).some((item) => item.title === "Compare integer condition with zero")).toBe(false);
  });

  it("offers a boxed receiver quick fix for primitive method access", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-boxed-"));
    try {
      writeFileSync(join(tempRoot, "aaa-hidden-int.vl"), `module hidden {
    class Int {
        OnAlloc(I16 other) {
        }
    }
}
`);
      const source = `module app {
    I16 main() {
        I16 value = 5;
        ret value.Abs();
    }
}`;
      const uri = pathToFileURL(join(tempRoot, "primitive-boxed.vl")).toString();
      const index = new WorkspaceIndex(resolve("."));
      index.configure([tempRoot], { projectRoot: tempRoot, requireMainDiagnostic: "off" });
      index.indexWorkspace();
      const state = index.updateOpenDocument(uri, source);

      const primitiveMethod = index.lspDiagnostics(state.uri).find((diagnostic) => diagnostic.code === "vela.sem.primitiveMethod");
      expect(primitiveMethod).toBeDefined();
      const action = codeActions(index, state, [primitiveMethod!]).find((item) => item.title === "Box primitive receiver as Int");
      expect(action?.diagnostics).toEqual([primitiveMethod]);
      const updated = applyEdits(state.text, action?.edit?.changes?.[state.uri] ?? []);
      expect(updated).toContain("    import stdlib::types::{int};");
      expect(updated).toContain("ret Init<Int>(val: value).Abs();");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("offers quick fixes for missing function returns", () => {
    const source = `module app {
    I16 main() {
        I16 x = 1;
    }
}`;
    const { index, state } = fixtureIndex(source);
    const missingReturn = index.lspDiagnostics(state.uri).find((diagnostic) => diagnostic.code === "vela.sem.missingReturn");
    expect(missingReturn).toBeDefined();
    const actions = codeActions(index, state, [missingReturn!]);

    const addReturn = actions.find((item) => item.title === "Add missing return statement");
    const addEdit = addReturn?.edit?.changes?.[state.uri]?.[0];
    expect(addEdit?.newText).toBe("        ret 0;\n");
    expect(applyEdit(state.text, addEdit!)).toContain("ret 0;\n    }");

    const changeReturn = actions.find((item) => item.title === "Change return type to U0");
    const changeEdit = changeReturn?.edit?.changes?.[state.uri]?.[0];
    expect(changeEdit?.newText).toBe("U0");
    expect(applyEdit(state.text, changeEdit!)).toContain("U0 main()");
  });

  it("scopes missing-main diagnostics to current files or workspace entry", () => {
    const root = resolve(".");
    const source = `module lib {
    I16 helper() {
        ret 1;
    }
}`;

    const currentIndex = new WorkspaceIndex(root);
    currentIndex.configure([root], { requireMainDiagnostic: "currentFile" });
    const currentUri = pathToFileURL(resolve("current.vl")).toString();
    currentIndex.updateOpenDocument(currentUri, source);
    expect(currentIndex.lspDiagnostics(currentUri).some((diagnostic) => diagnostic.code === "vela.sem.missingMain")).toBe(true);

    const entryIndex = new WorkspaceIndex(root);
    entryIndex.configure([root], { projectRoot: root, requireMainDiagnostic: "workspaceEntry", workspaceEntry: "entry.vl" });
    const entryUri = pathToFileURL(resolve("entry.vl")).toString();
    const libraryUri = pathToFileURL(resolve("library.vl")).toString();
    entryIndex.updateOpenDocument(entryUri, source);
    entryIndex.updateOpenDocument(libraryUri, source);
    expect(entryIndex.lspDiagnostics(entryUri).some((diagnostic) => diagnostic.code === "vela.sem.missingMain")).toBe(true);
    expect(entryIndex.lspDiagnostics(libraryUri).some((diagnostic) => diagnostic.code === "vela.sem.missingMain")).toBe(false);
  });

  it("analyzes bundled examples and stdlib without false-positive errors", () => {
    const root = resolve("..", "..");
    const index = new WorkspaceIndex(resolve("."));
    index.configure([root], { requireMainDiagnostic: "off" });
    index.indexWorkspace();
    const bundledErrors = index.allFiles()
      .filter((state) => /[\\/](examples|stdlib)[\\/].*\.vl$/.test(state.path))
      .flatMap((state) => state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1));
    expect(bundledErrors).toEqual([]);
  });

  it("matches compiler acceptance for bundled examples", async () => {
    const root = resolve("..", "..");
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-compiler-parity-"));
    const index = new WorkspaceIndex(resolve("."));
    index.configure([root], { requireMainDiagnostic: "off" });
    index.indexWorkspace();

    try {
      const examples = index.allFiles()
        .filter((state) => /[\\/]examples[\\/][^\\/]+\.vl$/.test(state.path))
        .sort((left, right) => left.path.localeCompare(right.path));
      expect(examples.map((state) => state.path.replaceAll("\\", "/").split("/").at(-1))).toEqual([
        "boxed_values.vl",
        "factorial.vl",
        "hello.vl",
        "linked_list.vl",
        "polymorphism.vl",
      ]);

      for (const state of examples) {
        const output = join(tempRoot, `${state.path.replace(/[^A-Za-z0-9_.-]/g, "_")}.de1`);
        const compiled = await runCompiler(state.path, output, root, root);
        expect(compiled.ok, compiled.stderr).toBe(true);
        expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("matches compiler rejection for representative semantic errors", async () => {
    const root = resolve("..", "..");
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-negative-parity-"));
    const cases = [
      {
        name: "unknown identifier",
        code: "vela.sem.unknownIdentifier",
        source: "module app { I16 main() { ret missing; } }",
      },
      {
        name: "duplicate field",
        code: "vela.sem.duplicateField",
        source: "module app { class Box { I16 value; I16 value; } I16 main() { ret 0; } }",
      },
      {
        name: "incompatible initializer",
        code: "vela.sem.incompatibleInitializer",
        source: "module app { I16 main() { Ptr<U0> ptr = 1; ret 0; } }",
      },
      {
        name: "invalid Print arity",
        code: "vela.sem.printArity",
        source: "module app { I16 main() { Print(42, \"hex\"); ret 0; } }",
      },
      {
        name: "invalid Init argument",
        code: "vela.sem.initArgName",
        source: "module app { class Box { OnAlloc(I16 value) { } } I16 main() { Box box = Init<Box>(valeu: 1); ret 0; } }",
      },
      {
        name: "address of local",
        code: "vela.sem.addressOfLocal",
        source: "module app { I16 main() { I16 value = 1; Ptr<I16> ptr = &value; ret value; } }",
      },
      {
        name: "unknown parent",
        code: "vela.sem.unknownParent",
        source: "module app { class Child : Missing { } I16 main() { ret 0; } }",
      },
      {
        name: "self alias unsupported by compiler",
        code: "vela.sem.unknownIdentifier",
        source: "module app { class Box { I16 value; I16 Read() { ret self.value; } } I16 main() { ret 0; } }",
      },
    ];

    try {
      for (const item of cases) {
        const path = join(tempRoot, `${item.name.replaceAll(" ", "-")}.vl`);
        const output = path.replace(/\.vl$/u, ".de1");
        const compiled = await runCompiler(path, output, root, root, item.source);
        expect(compiled.ok, `${item.name} unexpectedly compiled`).toBe(false);

        const index = new WorkspaceIndex(resolve("."));
        index.configure([root], { requireMainDiagnostic: "off" });
        const uri = pathToFileURL(path).toString();
        const state = index.updateOpenDocument(uri, item.source);
        const errorCodes = state.analysis.diagnostics
          .filter((diagnostic) => diagnostic.severity === 1)
          .map((diagnostic) => diagnostic.code);
        expect(errorCodes, `${item.name}: ${compiled.stderr}`).toContain(item.code);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("matches representative Python semantic test corpus cases", async () => {
    const root = resolve("..", "..");
    const tempRoot = mkdtempSync(join(tmpdir(), "vela-lsp-python-corpus-"));
    const accepted = [
      {
        name: "test_negative_i16_min_literal_stays_signed_in_expression",
        source: "module app { I16 main() { ret -32768 + 1; } }",
      },
      {
        name: "test_negative_literal_can_initialise_signed_byte",
        source: "module app { I16 main() { I8 x = -128; ret x; } }",
      },
      {
        name: "test_unsigned_byte_variable_can_widen_to_signed_word",
        source: "module app { I16 main() { U8 x = 255; I16 y = x; ret y; } }",
      },
      {
        name: "test_pointer_equality_with_null_allowed",
        source: "module app { I16 main() { Ptr<I16> p = null; if (p == null) { ret 1; } ret 0; } }",
      },
      {
        name: "test_alias_resolves_in_same_module",
        source: "module app { alias Word <- I16; Word answer = 42; I16 main() { ret answer; } }",
      },
      {
        name: "test_unsigned_byte_arithmetic_can_widen_to_signed_word",
        source: "module app { I16 main() { U8 u = 1; I16 s = 2; ret u + s; } }",
      },
      {
        name: "test_unsigned_word_comparison_with_fitting_literal_allowed",
        source: "module app { I16 main() { U16 u = 40000; if (u < 50000) { ret 1; } ret 0; } }",
      },
      {
        name: "test_null_pointer_global_initializer_allowed",
        source: "module app { Ptr<I16> p = null; I16 main() { if (p == null) { ret 1; } ret 0; } }",
      },
      {
        name: "test_function_can_reference_later_class_type_and_global_variable",
        source: "module app { Ptr<Foo> make() { ret null; } I16 read() { ret value; } I16 value = 7; class Foo { OnAlloc() {} } I16 main() { Ptr<Foo> p = make(); Free(p); ret read(); } }",
      },
      {
        name: "test_wrapper_autobox_initializer_allowed",
        source: "module app { class Box { I16 value; OnAlloc(I16 v) { value = v; } } I16 main() { Box box = 7; I16 result = box.GetSize(); Free(box); ret result; } }",
      },
      {
        name: "test_multi_dispatch_checks_method_arguments_allowed",
        source: "module app { class A { OnAlloc() {} U0 M(I16 x) { ret; } } class B { OnAlloc() {} U0 M(I16 x) { ret; } } I16 main() { A a = Init<A>(); B b = Init<B>(); {a, b}.M(1); Free(a); Free(b); ret 0; } }",
      },
      {
        name: "test_asm_binding_global_allowed",
        source: "module app { I16 global = 1; I16 main() { ASM([[in]] R0 = global;) { MOV R0, R0 } ret 0; } }",
      },
      {
        name: "test_asm_binding_field_and_this_allowed",
        source: "module app { class Box { I16 value; I16 Read() { ASM([[in]] R0 = value; [[in]] R1 = this;) { MOV R0, R0 } ret value; } } I16 main() { Box b; ret b.Read(); } }",
      },
      {
        name: "test_class_skeleton_signature_exact_match_allowed",
        source: "module app { type I { skeleton I16 M(I16 x); } class A : I { OnAlloc() {} I16 M(I16 x) { ret x; } } I16 main() { ret 0; } }",
      },
      {
        name: "test_class_method_override_signature_exact_match_allowed",
        source: "module app { class Base { OnAlloc() {} I16 M(I16 x) { ret x; } } class Child : Base { OnAlloc() {} I16 M(I16 x) { ret x + 1; } } I16 main() { ret 0; } }",
      },
      {
        name: "test_non_void_if_else_returns_on_all_paths",
        source: "module app { I16 f() { if (true) { ret 1; } else { ret 2; } } I16 main() { ret f(); } }",
      },
      {
        name: "test_non_void_literal_infinite_loop_with_return_is_definite",
        source: "module app { I16 f() { while (true) { ret 1; } } I16 main() { ret f(); } }",
      },
      {
        name: "test_free_accepts_raw_pointer",
        source: "module app { I16 main() { Ptr<I16> p = Malloc(2); Free(p); ret 0; } }",
      },
      {
        name: "test_free_accepts_null_pointer",
        source: "module app { I16 main() { Free(null); ret 0; } }",
      },
    ];
    const rejected = [
      {
        name: "test_unsigned_word_variable_cannot_implicitly_become_signed_word",
        code: "vela.sem.incompatibleInitializer",
        source: "module app { I16 main() { U16 x = 40000; I16 y = x; ret y; } }",
      },
      {
        name: "test_alias_does_not_leak_between_modules_without_import",
        code: "vela.sem.unknownType",
        source: "module a { alias Word <- I16; } module app { I16 main() { Word x = 1; ret 0; } }",
      },
      {
        name: "test_class_type_does_not_leak_between_modules_without_import",
        code: "vela.sem.unknownType",
        source: "module a { class Foo { OnAlloc() {} } } module app { I16 main() { Ptr<Foo> x = null; ret 0; } }",
      },
      {
        name: "test_type_decl_does_not_leak_between_modules_without_import",
        code: "vela.sem.unknownType",
        source: "module a { type Shape { skeleton I16 area(); } } module app { I16 main() { Ptr<Shape> x = null; ret 0; } }",
      },
      {
        name: "test_duplicate_module_declarations_in_same_file_rejected",
        code: "vela.sem.duplicateModule",
        source: "module app { I16 helper() { ret 1; } } module app { I16 main() { ret helper(); } }",
      },
      {
        name: "test_duplicate_global_name_rejected",
        code: "vela.sem.duplicateTopLevel",
        source: "module app { I16 x = 1; I16 x = 2; I16 main() { ret x; } }",
      },
      {
        name: "test_duplicate_function_name_rejected",
        code: "vela.sem.duplicateTopLevel",
        source: "module app { I16 f() { ret 1; } I16 f() { ret 2; } I16 main() { ret f(); } }",
      },
      {
        name: "test_reserved_internal_top_level_prefix_rejected",
        code: "vela.sem.reservedName",
        source: "module app { I16 __malloc = 0; I16 main() { ret 0; } }",
      },
      {
        name: "test_storeable_class_name_is_reserved_for_implicit_base",
        code: "vela.sem.reservedStoreable",
        source: "module app { class Storeable { OnAlloc() {} } I16 main() { ret 0; } }",
      },
      {
        name: "test_global_main_label_conflicts_with_program_entry",
        code: "vela.sem.flatAssemblyCollision",
        source: "module app { I16 main = 0; }",
      },
      {
        name: "test_space_label_conflicts_with_data_section",
        code: "vela.sem.flatAssemblyCollision",
        source: "module app { I16 space() { ret 0; } I16 main() { ret 0; } }",
      },
      {
        name: "test_class_method_mangle_conflicting_with_function_label_rejected",
        code: "vela.sem.flatAssemblyCollision",
        source: "module app { I16 Box_Get() { ret 1; } class Box { OnAlloc() {} I16 Get() { ret 2; } } I16 main() { ret 0; } }",
      },
      {
        name: "test_duplicate_local_name_rejected",
        code: "vela.sem.duplicateLocal",
        source: "module app { I16 main() { I16 x = 1; I16 x = 2; ret x; } }",
      },
      {
        name: "test_duplicate_parameter_name_rejected",
        code: "vela.sem.duplicateParameter",
        source: "module app { I16 f(I16 x, I16 x) { ret x; } I16 main() { ret f(1, 2); } }",
      },
      {
        name: "test_duplicate_class_method_name_rejected",
        code: "vela.sem.duplicateMethod",
        source: "module app { class Dup { OnAlloc() {} I16 M() { ret 1; } I16 M() { ret 2; } } I16 main() { ret 0; } }",
      },
      {
        name: "test_duplicate_field_name",
        code: "vela.sem.duplicateField",
        source: "module app { class Box { I16 x; I16 x; } I16 main() { ret 0; } }",
      },
      {
        name: "test_inherited_duplicate_field_name_rejected",
        code: "vela.sem.inheritedFieldDuplicate",
        source: "module app { class Base { I16 x; } class Child : Base { I16 x; } I16 main() { ret 0; } }",
      },
      {
        name: "test_duplicate_type_method_name_rejected",
        code: "vela.sem.duplicateTypeMethod",
        source: "module app { type I { skeleton I16 M(); skeleton I16 M(); } I16 main() { ret 0; } }",
      },
      {
        name: "test_class_skeleton_wrong_arity_rejected",
        code: "vela.sem.invalidSkeletonSignature",
        source: "module app { type I { skeleton I16 M(I16 x); } class A : I { OnAlloc() {} I16 M() { ret 1; } } I16 main() { ret 0; } }",
      },
      {
        name: "test_class_skeleton_wrong_parameter_type_rejected",
        code: "vela.sem.invalidSkeletonSignature",
        source: "module app { type I { skeleton I16 M(I16 x); } class A : I { OnAlloc() {} I16 M(U16 x) { ret 1; } } I16 main() { ret 0; } }",
      },
      {
        name: "test_class_method_override_wrong_return_rejected",
        code: "vela.sem.invalidOverride",
        source: "module app { class Base { OnAlloc() {} I16 M(I16 x) { ret x; } } class Child : Base { OnAlloc() {} U0 M(I16 x) { ret; } } I16 main() { ret 0; } }",
      },
      {
        name: "test_class_method_override_wrong_arity_rejected",
        code: "vela.sem.invalidOverride",
        source: "module app { class Base { OnAlloc() {} I16 M(I16 x) { ret x; } } class Child : Base { OnAlloc() {} I16 M() { ret 1; } } I16 main() { ret 0; } }",
      },
      {
        name: "test_class_method_override_wrong_parameter_type_rejected",
        code: "vela.sem.invalidOverride",
        source: "module app { class Base { OnAlloc() {} I16 M(I16 x) { ret x; } } class Child : Base { OnAlloc() {} I16 M(U16 x) { ret 1; } } I16 main() { ret 0; } }",
      },
      {
        name: "test_explicit_storeable_inheritance",
        code: "vela.sem.explicitStoreable",
        source: "module app { class Bad : Storeable { OnAlloc() {} } I16 main() { ret 0; } }",
      },
      {
        name: "test_class_inheritance_cycle_rejected",
        code: "vela.sem.inheritanceCycle",
        source: "module app { class A : B { OnAlloc() {} } class B : A { OnAlloc() {} } I16 main() { ret 0; } }",
      },
      {
        name: "test_void_global_variable_rejected",
        code: "vela.sem.voidStorage",
        source: "module app { U0 x; I16 main() { ret 0; } }",
      },
      {
        name: "test_void_local_variable_rejected",
        code: "vela.sem.voidStorage",
        source: "module app { U0 main() { U0 x; ret; } }",
      },
      {
        name: "test_void_parameter_rejected",
        code: "vela.sem.voidStorage",
        source: "module app { I16 f(U0 x) { ret 0; } I16 main() { ret f(); } }",
      },
      {
        name: "test_void_class_field_rejected",
        code: "vela.sem.voidStorage",
        source: "module app { class Bad { U0 x; } I16 main() { ret 0; } }",
      },
      {
        name: "test_dynamic_global_initializer_rejected",
        code: "vela.sem.dynamicGlobalInitializer",
        source: "module app { I16 x = 1 + 2; I16 main() { ret x; } }",
      },
      {
        name: "test_string_pointer_global_initializer_rejected",
        code: "vela.sem.dynamicGlobalInitializer",
        source: "module app { Ptr<U8> p = \"Hi\"; I16 main() { ret 0; } }",
      },
      {
        name: "test_negative_i16_literal_below_min_rejected_in_expression",
        code: "vela.sem.integerOutOfRange",
        source: "module app { I16 main() { ret -32769 + 1; } }",
      },
      {
        name: "test_negative_literal_must_fit_signed_byte",
        code: "vela.sem.incompatibleInitializer",
        source: "module app { I16 main() { I8 x = -129; ret x; } }",
      },
      {
        name: "test_negative_literal_rejected_for_unsigned_byte",
        code: "vela.sem.incompatibleInitializer",
        source: "module app { I16 main() { U8 x = -1; ret x; } }",
      },
      {
        name: "test_integer_literal_above_u16_rejected_even_in_expression",
        code: "vela.sem.integerOutOfRange",
        source: "module app { I16 main() { ret 70000 + 1; } }",
      },
      {
        name: "test_char_literal_must_fit_u8_even_when_widened",
        code: "vela.sem.charOutOfRange",
        source: "module app { I16 main() { I16 c = 'Ā'; ret c; } }",
      },
      {
        name: "test_signed_byte_variable_cannot_implicitly_become_unsigned_byte",
        code: "vela.sem.incompatibleInitializer",
        source: "module app { I16 main() { I8 x = -1; U8 y = x; ret y; } }",
      },
      {
        name: "test_int_literal_cannot_initialise_float",
        code: "vela.sem.incompatibleInitializer",
        source: "module app { F16 main() { F16 x = 1; ret x; } }",
      },
      {
        name: "test_int_literal_cannot_pass_as_float_argument",
        code: "vela.sem.argumentType",
        source: "module app { F16 id(F16 x) { ret x; } F16 main() { ret id(1); } }",
      },
      {
        name: "test_int_to_float_cast_rejected",
        code: "vela.sem.floatCast",
        source: "module app { F16 main() { ret Cast<F16>(1); } }",
      },
      {
        name: "test_float_to_int_cast_rejected",
        code: "vela.sem.floatCast",
        source: "module app { I16 main() { F16 x = 1.0; ret Cast<I16>(x); } }",
      },
      {
        name: "test_mixed_same_width_signed_unsigned_arithmetic_rejected",
        code: "vela.sem.incompatibleNumericOperands",
        source: "module app { I16 main() { I16 s = -1; U16 u = 1; ret s + u; } }",
      },
      {
        name: "test_mixed_int_float_comparison_rejected",
        code: "vela.sem.comparisonOperands",
        source: "module app { I16 main() { if (1.0 < 2) { ret 1; } ret 0; } }",
      },
      {
        name: "test_bare_function_name_is_not_a_value",
        code: "vela.sem.notAValue",
        source: "module app { I16 f() { ret 7; } I16 main() { ret f; } }",
      },
      {
        name: "test_bare_class_name_is_not_a_value",
        code: "vela.sem.notAValue",
        source: "module app { class Box { I16 value; } I16 main() { ret Box; } }",
      },
      {
        name: "test_incompatible_assignment_rejected",
        code: "vela.sem.incompatibleAssignment",
        source: "module app { I16 main() { I16 value = 0; value = null; ret value; } }",
      },
      {
        name: "test_different_ptr_incompatible",
        code: "vela.sem.incompatibleInitializer",
        source: "module app { I16 main() { Ptr<U8> bytes = null; Ptr<I16> words = bytes; ret 0; } }",
      },
      {
        name: "test_malloc_size_must_be_integer",
        code: "vela.sem.mallocSize",
        source: "module app { I16 main() { Ptr<I16> p = Malloc(null); ret 0; } }",
      },
      {
        name: "test_malloc_negative_size_rejected",
        code: "vela.sem.mallocNegative",
        source: "module app { I16 main() { Ptr<I16> p = Malloc(-1); ret 0; } }",
      },
      {
        name: "test_free_rejects_non_pointer",
        code: "vela.sem.freeNonPointer",
        source: "module app { I16 main() { Free(123); ret 0; } }",
      },
      {
        name: "test_indexing_requires_pointer",
        code: "vela.sem.indexNonPointer",
        source: "module app { I16 main() { I16 x = 3; ret x[0]; } }",
      },
      {
        name: "test_pointer_index_must_be_integer",
        code: "vela.sem.pointerIndexType",
        source: "module app { I16 main() { Ptr<I16> p = Malloc(2); I16 x = p[null]; Free(p); ret x; } }",
      },
      {
        name: "test_deref_requires_pointer",
        code: "vela.sem.derefNonPointer",
        source: "module app { I16 main() { I16 x = 3; ret *x; } }",
      },
      {
        name: "test_cannot_deref_void_pointer",
        code: "vela.sem.derefVoidPointer",
        source: "module app { I16 main() { Ptr<U0> p = Malloc(2); I16 x = *p; Free(p); ret x; } }",
      },
      {
        name: "test_field_access_requires_class_pointer",
        code: "vela.sem.fieldNonClass",
        source: "module app { I16 main() { ret null.value; } }",
      },
      {
        name: "test_method_call_requires_class_pointer",
        code: "vela.sem.methodNonClass",
        source: "module app { I16 main() { ret null.Value(); } }",
      },
      {
        name: "test_arithmetic_rejects_bool_operand",
        code: "vela.sem.arithmeticOperand",
        source: "module app { I16 main() { ret true + 1; } }",
      },
      {
        name: "test_modulo_rejects_float_operands",
        code: "vela.sem.moduloFloat",
        source: "module app { F16 f() { ret 3.5 % 2.0; } F16 main() { ret f(); } }",
      },
      {
        name: "test_ordered_comparison_rejects_pointers",
        code: "vela.sem.comparisonOperands",
        source: "module app { I16 main() { Ptr<I16> p = Malloc(2); if (p < null) { ret 1; } Free(p); ret 0; } }",
      },
      {
        name: "test_multi_dispatch_target_must_be_class",
        code: "vela.sem.multiDispatchTarget",
        source: "module app { I16 main() { I16 x = 1; {x}.M(); ret 0; } }",
      },
      {
        name: "test_unary_minus_requires_numeric_operand",
        code: "vela.sem.unaryMinus",
        source: "module app { I16 main() { ret -null; } }",
      },
      {
        name: "test_post_increment_requires_assignable_target",
        code: "vela.sem.incrementTarget",
        source: "module app { I16 main() { 5++; ret 0; } }",
      },
      {
        name: "test_assignment_to_literal_rejected",
        code: "vela.sem.invalidAssignmentTarget",
        source: "module app { I16 main() { 1 = 2; ret 0; } }",
      },
      {
        name: "test_asm_binding_unknown_variable_rejected",
        code: "vela.sem.unknownIdentifier",
        source: "module app { I16 main() { ASM([[in]] R0 = missing;) { MOV R0, R0 } ret 0; } }",
      },
      {
        name: "test_asm_binding_invalid_register_rejected",
        code: "vela.sem.invalidAsmRegister",
        source: "module app { I16 main() { I16 x = 1; ASM([[in]] SP = x;) { } ret x; } }",
      },
      {
        name: "test_post_increment_requires_integer_target",
        code: "vela.sem.incrementInteger",
        source: "module app { I16 main() { F16 x = 1.0; x++; ret 0; } }",
      },
      {
        name: "test_function_must_return_on_all_paths",
        code: "vela.sem.missingReturn",
        source: "module app { I16 f() { I16 x = 1; } I16 main() { ret 0; } }",
      },
      {
        name: "test_void_function_must_not_return_value",
        code: "vela.sem.returnValueInVoid",
        source: "module app { U0 f() { ret 1; } I16 main() { ret 0; } }",
      },
      {
        name: "test_non_void_return_requires_value",
        code: "vela.sem.returnMissingValue",
        source: "module app { I16 f() { ret; } I16 main() { ret 0; } }",
      },
      {
        name: "test_sizeof_unknown_type_rejected",
        code: "vela.sem.unknownType",
        source: "module app { I16 main() { ret SizeOf(Missing); } }",
      },
      {
        name: "test_logical_and_requires_bool_operands",
        code: "vela.sem.logicalOperand",
        source: "module app { I16 main() { if (1 && true) { ret 1; } ret 0; } }",
      },
      {
        name: "test_not_requires_bool_operand",
        code: "vela.sem.notOperand",
        source: "module app { I16 main() { if (!1) { ret 1; } ret 0; } }",
      },
      {
        name: "test_bool_equality_rejects_integer",
        code: "vela.sem.equalityOperands",
        source: "module app { I16 main() { if (true == 1) { ret 1; } ret 0; } }",
      },
      {
        name: "test_init_arity_rejected",
        code: "vela.sem.arity",
        source: "module app { class Box { OnAlloc(I16 value) {} } I16 main() { Box box = Init<Box>(); Free(box); ret 0; } }",
      },
      {
        name: "test_init_argument_type_rejected",
        code: "vela.sem.initArgType",
        source: "module app { class Box { OnAlloc(I16 value) {} } I16 main() { Box box = Init<Box>(value: null); Free(box); ret 0; } }",
      },
      {
        name: "test_init_unknown_class_rejected",
        code: "vela.sem.unknownIdentifier",
        source: "module app { I16 main() { Init<Missing>(); ret 0; } }",
      },
    ];

    try {
      for (const item of accepted) {
        const path = join(tempRoot, `${item.name}.vl`);
        const compiled = await runCompiler(path, path.replace(/\.vl$/u, ".de1"), root, root, item.source);
        expect(compiled.ok, `${item.name}: ${compiled.stderr}`).toBe(true);

        const index = new WorkspaceIndex(resolve("."));
        index.configure([root], { requireMainDiagnostic: "off" });
        const state = index.updateOpenDocument(pathToFileURL(path).toString(), item.source);
        expect(state.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 1), item.name).toEqual([]);
      }

      for (const item of rejected) {
        const path = join(tempRoot, `${item.name}.vl`);
        const compiled = await runCompiler(path, path.replace(/\.vl$/u, ".de1"), root, root, item.source);
        expect(compiled.ok, `${item.name} unexpectedly compiled`).toBe(false);

        const index = new WorkspaceIndex(resolve("."));
        index.configure([root], { requireMainDiagnostic: "off" });
        const state = index.updateOpenDocument(pathToFileURL(path).toString(), item.source);
        const errorCodes = state.analysis.diagnostics
          .filter((diagnostic) => diagnostic.severity === 1)
          .map((diagnostic) => diagnostic.code);
        expect(errorCodes, `${item.name}: ${compiled.stderr}`).toContain(item.code);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30000);
});
