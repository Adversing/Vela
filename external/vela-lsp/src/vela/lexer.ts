import { DiagnosticSeverity } from "vscode-languageserver/node";
import {
  KEYWORDS,
  Token,
  TokenKind,
  VelaDiagnostic,
  VelaPosition,
  makePosition,
  makeRange,
} from "./model.js";

const TWO_CHAR_TOKENS: Record<string, TokenKind> = {
  "[[": TokenKind.TagOpen,
  "]]": TokenKind.TagClose,
  "==": TokenKind.Eq,
  "!=": TokenKind.Neq,
  "<=": TokenKind.Lte,
  ">=": TokenKind.Gte,
  "&&": TokenKind.And,
  "||": TokenKind.Or,
  "++": TokenKind.PlusPlus,
  "--": TokenKind.MinusMinus,
  "+=": TokenKind.PlusEq,
  "-=": TokenKind.MinusEq,
  "*=": TokenKind.StarEq,
  "/=": TokenKind.SlashEq,
  "<-": TokenKind.Arrow,
  "::": TokenKind.DoubleColon,
};

const ONE_CHAR_TOKENS: Record<string, TokenKind> = {
  "+": TokenKind.Plus,
  "-": TokenKind.Minus,
  "*": TokenKind.Star,
  "/": TokenKind.Slash,
  "%": TokenKind.Percent,
  "!": TokenKind.Not,
  "&": TokenKind.Ampersand,
  "=": TokenKind.Assign,
  "<": TokenKind.Lt,
  ">": TokenKind.Gt,
  "(": TokenKind.LParen,
  ")": TokenKind.RParen,
  "{": TokenKind.LBrace,
  "}": TokenKind.RBrace,
  "[": TokenKind.LBracket,
  "]": TokenKind.RBracket,
  ";": TokenKind.Semicolon,
  ",": TokenKind.Comma,
  ":": TokenKind.Colon,
  ".": TokenKind.Dot,
};

export interface LexResult {
  tokens: Token[];
  allTokens: Token[];
  diagnostics: VelaDiagnostic[];
}

export class Lexer {
  private pos = 0;
  private line = 1;
  private column = 1;
  private readonly tokens: Token[] = [];
  private readonly allTokens: Token[] = [];
  private readonly diagnostics: VelaDiagnostic[] = [];

  constructor(
    private readonly text: string,
    private readonly uri: string,
  ) {}

  tokenize(): LexResult {
    while (!this.atEnd()) {
      const consumedTrivia = this.skipWhitespaceAndComments();
      if (consumedTrivia && this.atEnd()) {
        break;
      }
      if (this.atEnd()) {
        break;
      }
      this.scanToken();
    }
    const eofPos = this.currentPosition();
    const eof = this.makeToken(TokenKind.Eof, "", "", eofPos, eofPos);
    this.tokens.push(eof);
    this.allTokens.push(eof);
    return {
      tokens: this.tokens,
      allTokens: this.allTokens,
      diagnostics: this.diagnostics,
    };
  }

  private atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  private peek(offset = 0): string {
    return this.text[this.pos + offset] ?? "\0";
  }

  private currentPosition(): VelaPosition {
    return makePosition(this.line, this.column, this.pos);
  }

  private advance(): string {
    const ch = this.text[this.pos] ?? "\0";
    this.pos += 1;
    if (ch === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return ch;
  }

  private makeToken(kind: TokenKind, value: string, lexeme: string, start: VelaPosition, end?: VelaPosition): Token {
    return {
      kind,
      value,
      lexeme,
      range: makeRange(this.uri, start, end ?? this.currentPosition()),
    };
  }

  private pushToken(kind: TokenKind, value: string, lexeme: string, start: VelaPosition): void {
    const token = this.makeToken(kind, value, lexeme, start);
    this.tokens.push(token);
    this.allTokens.push(token);
  }

  private pushTrivia(kind: TokenKind, value: string, lexeme: string, start: VelaPosition): void {
    this.allTokens.push(this.makeToken(kind, value, lexeme, start));
  }

  private addDiagnostic(code: string, message: string, start: VelaPosition, hint?: string): void {
    this.diagnostics.push({
      code,
      message,
      hint,
      severity: DiagnosticSeverity.Error,
      range: makeRange(this.uri, start, this.currentPosition()),
      source: "vela-lsp",
    });
  }

  private skipWhitespaceAndComments(): boolean {
    let consumed = false;
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        consumed = true;
        this.advance();
        continue;
      }
      if (ch === "/" && this.peek(1) === "/") {
        consumed = true;
        const start = this.currentPosition();
        let lexeme = "";
        while (!this.atEnd() && this.peek() !== "\n") {
          lexeme += this.advance();
        }
        this.pushTrivia(TokenKind.Comment, lexeme, lexeme, start);
        continue;
      }
      if (ch === "#") {
        consumed = true;
        const start = this.currentPosition();
        let lexeme = "";
        while (!this.atEnd() && this.peek() !== "\n") {
          lexeme += this.advance();
        }
        this.pushTrivia(TokenKind.Comment, lexeme, lexeme, start);
        continue;
      }
      break;
    }
    return consumed;
  }

  private scanToken(): void {
    const start = this.currentPosition();
    const two = `${this.peek()}${this.peek(1)}`;
    const twoKind = TWO_CHAR_TOKENS[two];
    if (twoKind) {
      this.advance();
      this.advance();
      this.pushToken(twoKind, two, two, start);
      return;
    }

    const one = this.peek();
    const oneKind = ONE_CHAR_TOKENS[one];
    if (oneKind) {
      this.advance();
      this.pushToken(oneKind, one, one, start);
      return;
    }

    if (one === '"') {
      this.scanString(start);
      return;
    }
    if (one === "'") {
      this.scanChar(start);
      return;
    }
    if (isDigit(one)) {
      this.scanNumber(start);
      return;
    }
    if (isIdentifierStart(one)) {
      this.scanIdentifier(start);
      return;
    }

    const unexpected = this.advance();
    this.addDiagnostic(
      "vela.lex.unexpectedCharacter",
      `unexpected character ${JSON.stringify(unexpected)}`,
      start,
      "remove the character or replace it with a valid Vela token",
    );
  }

  private scanString(start: VelaPosition): void {
    let lexeme = this.advance();
    let value = "";
    while (!this.atEnd() && this.peek() !== '"') {
      if (this.peek() === "\n") {
        this.addDiagnostic(
          "vela.lex.unterminatedString",
          "unterminated string literal",
          start,
          "close the string literal before the end of the line",
        );
        this.pushToken(TokenKind.StringLiteral, value, lexeme, start);
        return;
      }
      if (this.peek() === "\\") {
        lexeme += this.advance();
        if (this.atEnd()) {
          this.addDiagnostic(
            "vela.lex.unterminatedString",
            "unterminated string literal",
            start,
            "complete the escape sequence and close the string literal",
          );
          this.pushToken(TokenKind.StringLiteral, value, lexeme, start);
          return;
        }
        const esc = this.advance();
        lexeme += esc;
        value += decodeEscape(esc, '"');
      } else {
        const ch = this.advance();
        lexeme += ch;
        value += ch;
      }
    }
    if (this.atEnd()) {
      this.addDiagnostic(
        "vela.lex.unterminatedString",
        "unterminated string literal",
        start,
        "close the string literal with a double quote",
      );
      this.pushToken(TokenKind.StringLiteral, value, lexeme, start);
      return;
    }
    lexeme += this.advance();
    this.pushToken(TokenKind.StringLiteral, value, lexeme, start);
  }

  private scanChar(start: VelaPosition): void {
    let lexeme = this.advance();
    let value = "";
    if (this.atEnd() || this.peek() === "'") {
      this.addDiagnostic(
        "vela.lex.emptyChar",
        "empty char literal",
        start,
        "provide exactly one character or escape sequence",
      );
      if (!this.atEnd() && this.peek() === "'") {
        lexeme += this.advance();
      }
      this.pushToken(TokenKind.CharLiteral, value, lexeme, start);
      return;
    }
    if (this.peek() === "\\") {
      lexeme += this.advance();
      if (this.atEnd()) {
        this.addDiagnostic(
          "vela.lex.unterminatedChar",
          "unterminated char literal",
          start,
          "complete the escape sequence and close the character literal",
        );
        this.pushToken(TokenKind.CharLiteral, value, lexeme, start);
        return;
      }
      const esc = this.advance();
      lexeme += esc;
      value = decodeEscape(esc, "'");
    } else {
      if (this.peek() === "\n") {
        this.addDiagnostic(
          "vela.lex.unterminatedChar",
          "unterminated char literal",
          start,
          "close the character literal before the end of the line",
        );
        this.pushToken(TokenKind.CharLiteral, value, lexeme, start);
        return;
      }
      const ch = this.advance();
      lexeme += ch;
      value = ch;
    }
    if (this.atEnd() || this.peek() !== "'") {
      this.addDiagnostic(
        "vela.lex.unterminatedChar",
        "unterminated char literal",
        start,
        "close the character literal with a single quote",
      );
      this.pushToken(TokenKind.CharLiteral, value, lexeme, start);
      return;
    }
    lexeme += this.advance();
    if (value.codePointAt(0) !== undefined && value.codePointAt(0)! > 0xff) {
      this.addDiagnostic(
        "vela.lex.charOutOfRange",
        `char literal U+${value.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} is outside the U8 range`,
        start,
        "Char is U8; use a character with codepoint 0..255",
      );
    }
    this.pushToken(TokenKind.CharLiteral, value, lexeme, start);
  }

  private scanNumber(start: VelaPosition): void {
    const begin = this.pos;
    if (this.peek() === "0" && (this.peek(1) === "x" || this.peek(1) === "X")) {
      this.advance();
      this.advance();
      while (!this.atEnd() && /[0-9a-fA-F_]/.test(this.peek())) {
        this.advance();
      }
      const lexeme = this.text.slice(begin, this.pos);
      this.appendNumber(TokenKind.IntLiteral, lexeme, start, validHexInteger(lexeme));
      return;
    }
    if (this.peek() === "0" && (this.peek(1) === "b" || this.peek(1) === "B")) {
      this.advance();
      this.advance();
      while (!this.atEnd() && /[01_]/.test(this.peek())) {
        this.advance();
      }
      const lexeme = this.text.slice(begin, this.pos);
      this.appendNumber(TokenKind.IntLiteral, lexeme, start, validBinaryInteger(lexeme));
      return;
    }

    while (!this.atEnd() && /[0-9_]/.test(this.peek())) {
      this.advance();
    }
    let isFloatLiteral = false;
    if (!this.atEnd() && this.peek() === "." && this.peek(1) !== ".") {
      isFloatLiteral = true;
      this.advance();
      while (!this.atEnd() && /[0-9_]/.test(this.peek())) {
        this.advance();
      }
    }
    if (!this.atEnd() && (this.peek() === "e" || this.peek() === "E")) {
      isFloatLiteral = true;
      this.advance();
      if (!this.atEnd() && (this.peek() === "+" || this.peek() === "-")) {
        this.advance();
      }
      while (!this.atEnd() && /[0-9_]/.test(this.peek())) {
        this.advance();
      }
    }

    const lexeme = this.text.slice(begin, this.pos);
    if (isFloatLiteral) {
      this.appendNumber(TokenKind.FloatLiteral, lexeme, start, validFloat(lexeme));
    } else {
      this.appendNumber(TokenKind.IntLiteral, lexeme, start, validDecimalInteger(lexeme));
    }
  }

  private appendNumber(kind: TokenKind.IntLiteral | TokenKind.FloatLiteral, lexeme: string, start: VelaPosition, valid: boolean): void {
    if (!valid) {
      this.addDiagnostic(
        "vela.lex.invalidNumber",
        `invalid numeric literal ${JSON.stringify(lexeme)}`,
        start,
        "check the digits, prefix, exponent, and underscore separators",
      );
    }
    const normalized = lexeme.replaceAll("_", "");
    if (kind === TokenKind.IntLiteral && valid) {
      const value = parseInteger(normalized);
      if (value > 0xffff) {
        this.addDiagnostic(
          "vela.lex.integerOutOfRange",
          `integer literal ${value} is outside the 16-bit range`,
          start,
          "use a value between 0 and 65535",
        );
      }
    }
    this.pushToken(kind, lexeme, lexeme, start);
  }

  private scanIdentifier(start: VelaPosition): void {
    const begin = this.pos;
    while (!this.atEnd() && isIdentifierContinue(this.peek())) {
      this.advance();
    }
    const text = this.text.slice(begin, this.pos);
    this.pushToken(KEYWORDS[text] ?? TokenKind.Identifier, text, text, start);
  }
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentifierContinue(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function decodeEscape(ch: string, quote: '"' | "'"): string {
  const escapes: Record<string, string> = {
    n: "\n",
    t: "\t",
    "\\": "\\",
    "0": "\0",
  };
  escapes[quote] = quote;
  return escapes[ch] ?? ch;
}

function validUnderscoreDigits(text: string, digitPattern: string): boolean {
  return new RegExp(`^[${digitPattern}]+(?:_[${digitPattern}]+)*$`).test(text);
}

function validDecimalInteger(text: string): boolean {
  return validUnderscoreDigits(text, "0-9");
}

function validHexInteger(text: string): boolean {
  return /^0[xX]/.test(text) && validUnderscoreDigits(text.slice(2), "0-9a-fA-F");
}

function validBinaryInteger(text: string): boolean {
  return /^0[bB]/.test(text) && validUnderscoreDigits(text.slice(2), "01");
}

function validFloat(text: string): boolean {
  const dec = String.raw`\d+(?:_\d+)*`;
  const body = new RegExp(String.raw`^(?:${dec}\.${dec}?|${dec}?\.${dec})(?:[eE][+-]?${dec})?$`);
  const expOnly = new RegExp(String.raw`^${dec}[eE][+-]?${dec}$`);
  return (body.test(text) || expOnly.test(text)) && Number.isFinite(Number(text.replaceAll("_", "")));
}

function parseInteger(normalized: string): number {
  if (normalized.startsWith("0x") || normalized.startsWith("0X")) {
    return Number.parseInt(normalized.slice(2), 16);
  }
  if (normalized.startsWith("0b") || normalized.startsWith("0B")) {
    return Number.parseInt(normalized.slice(2), 2);
  }
  return Number.parseInt(normalized, 10);
}
