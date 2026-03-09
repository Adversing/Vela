from __future__ import annotations

from src.errors import ParseError, SourceLocation
from src.lexer.tokens import Token, TokenKind
from src.parser.ast_nodes import (
    AddressOfExpr, AliasDecl, AsmBinding, AsmBlock, Assignment,
    BinaryExpr, BoolLiteral, CallExpr, CastExpr, CharLiteral,
    ClassDecl, DerefExpr, Expr, ExprStmt, FieldAccessExpr,
    FloatLiteral, ForStmt, FreeStmt, FunctionDecl, IdentifierExpr,
    IfStmt, ImportDecl, IndexExpr, InitExpr, IntLiteral,
    MallocExpr, MethodCallExpr, ModuleDecl, MultiDispatchExpr,
    NamedType, NullLiteral, ParamDecl, PrintStmt, Program,
    PtrType, ReturnStmt, SizeOfExpr, Stmt, StringLiteral,
    TypeDecl, TypeExpr, UnaryExpr, VarDecl, WhileStmt,
)


class Parser:
    """Parses a list of Vela tokens into an AST."""

    def __init__(self, tokens: list[Token], filename: str = "<stdin>") -> None:
        self._tokens = tokens
        self._pos = 0
        self._file = filename
        self._uid = 0

    def _next_uid(self) -> int:
        self._uid += 1
        return self._uid

    def _cur(self) -> Token:
        if self._pos < len(self._tokens):
            return self._tokens[self._pos]
        return self._tokens[-1]  # EOF

    def _peek(self, offset: int = 0) -> Token:
        idx = self._pos + offset
        if idx < len(self._tokens):
            return self._tokens[idx]
        return self._tokens[-1]

    def _at(self, *kinds: TokenKind) -> bool:
        return self._cur().kind in kinds

    def _advance(self) -> Token:
        tok = self._cur()
        if self._pos < len(self._tokens) - 1:
            self._pos += 1
        return tok

    def _expect(self, kind: TokenKind, msg: str = "") -> Token:
        if not self._at(kind):
            token = self._cur()
            detail = msg or f"expected {kind.name}, got {token.kind.name} ({token.value!r})"
            raise ParseError(detail, token.location)
        return self._advance()

    def _match(self, *kinds: TokenKind) -> Token | None:
        if self._at(*kinds):
            return self._advance()
        return None

    def _loc(self) -> SourceLocation:
        return self._cur().location

    def parse(self) -> Program:
        prog = Program(modules=[], location=self._loc())
        while not self._at(TokenKind.EOF):
            prog.modules.append(self._parse_module())
        return prog

    def _parse_module(self) -> ModuleDecl:
        loc = self._loc()
        self._expect(TokenKind.KW_MODULE)
        name = self._expect(TokenKind.IDENTIFIER).value
        self._expect(TokenKind.LBRACE)
        mod = ModuleDecl(name=name, imports=[], body=[], location=loc)
        while not self._at(TokenKind.RBRACE, TokenKind.EOF):
            if self._at(TokenKind.KW_IMPORT):
                mod.imports.append(self._parse_import())
            else:
                mod.body.append(self._parse_top_level_decl())
        self._expect(TokenKind.RBRACE)
        return mod

    def _parse_import(self) -> ImportDecl:
        loc = self._loc()
        self._expect(TokenKind.KW_IMPORT)
        # parse package path: pkg1::pkg2::...::pkgN::{modules}
        path_segments: list[str] = [self._expect(TokenKind.IDENTIFIER).value]
        self._expect(TokenKind.DOUBLE_COLON)
        while not self._at(TokenKind.LBRACE, TokenKind.EOF):
            path_segments.append(self._expect(TokenKind.IDENTIFIER).value)
            self._expect(TokenKind.DOUBLE_COLON)
        self._expect(TokenKind.LBRACE)
        modules: list[str] = []
        if self._match(TokenKind.STAR):
            modules.append("*")
        else:
            while not self._at(TokenKind.RBRACE, TokenKind.EOF):
                modules.append(self._expect(TokenKind.IDENTIFIER).value)
                if not self._match(TokenKind.COMMA):
                    break
        self._expect(TokenKind.RBRACE)
        self._expect(TokenKind.SEMICOLON)
        return ImportDecl(package=path_segments, modules=modules, location=loc)


    def _parse_top_level_decl(self):
        if self._at(TokenKind.KW_ALIAS):
            return self._parse_alias()
        if self._at(TokenKind.KW_CLASS):
            return self._parse_class()
        if self._at(TokenKind.KW_TYPE):
            return self._parse_type_decl()
        if self._at(TokenKind.TAG_OPEN):
            tags = self._parse_tags()
            return self._parse_var_decl_with_tags(tags)
        # function or global variable: starts with a type
        return self._parse_func_or_var()

    def _parse_tags(self) -> list[str]:
        self._expect(TokenKind.TAG_OPEN)
        tags: list[str] = []
        while not self._at(TokenKind.TAG_CLOSE, TokenKind.EOF):
            tags.append(self._expect(TokenKind.IDENTIFIER).value)
            self._match(TokenKind.COMMA)
        self._expect(TokenKind.TAG_CLOSE)
        return tags

    def _parse_alias(self) -> AliasDecl:
        loc = self._loc()
        self._expect(TokenKind.KW_ALIAS)
        name = self._expect(TokenKind.IDENTIFIER).value
        self._expect(TokenKind.ARROW)
        ty = self._parse_type_expr()
        self._expect(TokenKind.SEMICOLON)
        return AliasDecl(name=name, target_type=ty, location=loc)

    def _parse_class(self) -> ClassDecl:
        loc = self._loc()
        self._expect(TokenKind.KW_CLASS)
        name = self._expect(TokenKind.IDENTIFIER).value
        parent = None
        if self._match(TokenKind.COLON):
            parent = self._expect(TokenKind.IDENTIFIER).value
        self._expect(TokenKind.LBRACE)
        cls = ClassDecl(name=name, parent=parent, fields=[], methods=[], location=loc)
        while not self._at(TokenKind.RBRACE, TokenKind.EOF):
            self._parse_class_member(cls)
        self._expect(TokenKind.RBRACE)
        return cls

    def _parse_class_member(self, cls: ClassDecl) -> None:
        tags: list[str] = []
        if self._at(TokenKind.TAG_OPEN):
            tags = self._parse_tags()

        if self._at(TokenKind.KW_ONALLOC):
            cls.on_alloc = self._parse_on_alloc()
            return
        if self._at(TokenKind.KW_ONFREE):
            cls.on_free = self._parse_on_free()
            return

        # method or field: peek ahead to distinguish
        # if it's a type followed by name followed by '(' → method
        if self._is_type_start():
            saved = self._pos
            ty = self._parse_type_expr()
            if self._at(TokenKind.IDENTIFIER):
                name_tok = self._peek()
                if self._peek(1).kind == TokenKind.LPAREN:
                    # method
                    name = self._advance().value
                    meth = self._parse_function_body(ty, name)
                    meth.location = ty.location
                    cls.methods.append(meth)
                    return
                else:
                    # field
                    name = self._advance().value
                    init = None
                    if self._match(TokenKind.ASSIGN):
                        init = self._parse_expr()
                    self._expect(TokenKind.SEMICOLON)
                    cls.fields.append(VarDecl(type_expr=ty, name=name, initializer=init, tags=tags, location=ty.location))
                    return
            # fallback: rewind
            self._pos = saved

        raise ParseError(f"unexpected token in class body: {self._cur().value!r}", self._loc())

    def _parse_on_alloc(self) -> FunctionDecl:
        loc = self._loc()
        self._expect(TokenKind.KW_ONALLOC)
        self._expect(TokenKind.LPAREN)
        params = self._parse_param_list()
        self._expect(TokenKind.RPAREN)
        body = self._parse_block()
        return FunctionDecl(return_type=NamedType(name="U0"), name="OnAlloc", params=params, body=body, location=loc)

    def _parse_on_free(self) -> FunctionDecl:
        loc = self._loc()
        self._expect(TokenKind.KW_ONFREE)
        body = self._parse_block()
        return FunctionDecl(return_type=NamedType(name="U0"), name="OnFree", params=[], body=body, location=loc)

    def _parse_type_decl(self) -> TypeDecl:
        loc = self._loc()
        self._expect(TokenKind.KW_TYPE)
        name = self._expect(TokenKind.IDENTIFIER).value
        parent = None
        if self._match(TokenKind.COLON):
            parent = self._expect(TokenKind.IDENTIFIER).value
        self._expect(TokenKind.LBRACE)
        td = TypeDecl(name=name, parent=parent, methods=[], location=loc)
        while not self._at(TokenKind.RBRACE, TokenKind.EOF):
            is_skel = bool(self._match(TokenKind.KW_SKELETON))
            ty = self._parse_type_expr()
            n = self._expect(TokenKind.IDENTIFIER).value
            meth = self._parse_function_body(ty, n)
            meth.is_skeleton = is_skel
            td.methods.append(meth)
        self._expect(TokenKind.RBRACE)
        return td

    def _is_type_start(self) -> bool:
        return self._at(
            TokenKind.TY_U0, TokenKind.TY_U8, TokenKind.TY_I8,
            TokenKind.TY_U16, TokenKind.TY_I16, TokenKind.TY_F16,
            TokenKind.TY_PTR, TokenKind.IDENTIFIER,
        )

    def _parse_func_or_var(self):
        loc = self._loc()
        ty = self._parse_type_expr()
        name = self._expect(TokenKind.IDENTIFIER).value

        if self._at(TokenKind.LPAREN):
            fn = self._parse_function_body(ty, name)
            fn.location = loc
            return fn

        # variable declaration
        init = None
        if self._match(TokenKind.ASSIGN):
            init = self._parse_expr()
        self._expect(TokenKind.SEMICOLON)
        return VarDecl(type_expr=ty, name=name, initializer=init, location=loc)

    def _parse_var_decl_with_tags(self, tags: list[str]):
        loc = self._loc()
        ty = self._parse_type_expr()
        name = self._expect(TokenKind.IDENTIFIER).value
        init = None
        if self._match(TokenKind.ASSIGN):
            init = self._parse_expr()
        self._expect(TokenKind.SEMICOLON)
        return VarDecl(type_expr=ty, name=name, initializer=init, tags=tags, location=loc)

    def _parse_function_body(self, ret_type: TypeExpr, name: str) -> FunctionDecl:
        self._expect(TokenKind.LPAREN)
        params = self._parse_param_list()
        self._expect(TokenKind.RPAREN)
        if self._at(TokenKind.SEMICOLON):
            # skeleton declaration with no body
            self._advance()
            return FunctionDecl(return_type=ret_type, name=name, params=params, body=[], is_skeleton=True)
        body = self._parse_block()
        return FunctionDecl(return_type=ret_type, name=name, params=params, body=body)

    def _parse_param_list(self) -> list[ParamDecl]:
        params: list[ParamDecl] = []
        if self._at(TokenKind.RPAREN):
            return params
        params.append(self._parse_param())
        while self._match(TokenKind.COMMA):
            params.append(self._parse_param())
        return params

    def _parse_param(self) -> ParamDecl:
        loc = self._loc()
        ty = self._parse_type_expr()
        name = self._expect(TokenKind.IDENTIFIER).value
        return ParamDecl(type_expr=ty, name=name, location=loc)

    def _parse_type_expr(self) -> TypeExpr:
        loc = self._loc()
        if self._match(TokenKind.TY_PTR):
            self._expect(TokenKind.LT)
            inner = self._parse_type_expr()
            self._expect(TokenKind.GT)
            return PtrType(inner=inner, location=loc)
        tok = self._advance()
        type_map = {
            TokenKind.TY_U0: "U0", TokenKind.TY_U8: "U8", TokenKind.TY_I8: "I8",
            TokenKind.TY_U16: "U16", TokenKind.TY_I16: "I16", TokenKind.TY_F16: "F16",
            TokenKind.IDENTIFIER: tok.value,
        }
        if tok.kind in type_map:
            return NamedType(name=type_map[tok.kind], location=loc)
        raise ParseError(f"expected type, got {tok.kind.name} ({tok.value!r})", loc)

    def _parse_block(self) -> list[Stmt]:
        self._expect(TokenKind.LBRACE)
        stmts: list[Stmt] = []
        while not self._at(TokenKind.RBRACE, TokenKind.EOF):
            stmts.append(self._parse_stmt())
        self._expect(TokenKind.RBRACE)
        return stmts

    def _parse_stmt(self) -> Stmt:
        if self._at(TokenKind.KW_RET):
            return self._parse_return()
        if self._at(TokenKind.KW_IF):
            return self._parse_if()
        if self._at(TokenKind.KW_FOR):
            return self._parse_for()
        if self._at(TokenKind.KW_WHILE):
            return self._parse_while()
        if self._at(TokenKind.KW_ASM):
            return self._parse_asm()
        if self._at(TokenKind.BI_FREE):
            return self._parse_free_stmt()
        if self._at(TokenKind.BI_PRINT):
            return self._parse_print_stmt()

        # variable declaration inside function body
        if self._is_type_start() and self._is_local_var_decl():
            return self._parse_local_var_decl()

        # expression or assignment statement
        return self._parse_expr_or_assign()

    def _is_local_var_decl(self) -> bool:
        """Lookahead to determine if this is a local var decl (type name =|;)."""
        saved = self._pos
        try:
            self._parse_type_expr()
            result = self._at(TokenKind.IDENTIFIER)
            if result:
                self._advance()
                result = self._at(TokenKind.ASSIGN, TokenKind.SEMICOLON)
            return result
        except ParseError:
            return False
        finally:
            self._pos = saved

    def _parse_local_var_decl(self) -> VarDecl:
        loc = self._loc()
        ty = self._parse_type_expr()
        name = self._expect(TokenKind.IDENTIFIER).value
        init = None
        if self._match(TokenKind.ASSIGN):
            init = self._parse_expr()
        self._expect(TokenKind.SEMICOLON)
        return VarDecl(type_expr=ty, name=name, initializer=init, location=loc)

    def _parse_return(self) -> ReturnStmt:
        loc = self._loc()
        self._expect(TokenKind.KW_RET)
        value = None
        if not self._at(TokenKind.SEMICOLON):
            value = self._parse_expr()
        self._expect(TokenKind.SEMICOLON)
        return ReturnStmt(value=value, location=loc)

    def _parse_if(self) -> IfStmt:
        loc = self._loc()
        self._expect(TokenKind.KW_IF)
        self._expect(TokenKind.LPAREN)
        cond = self._parse_expr()
        self._expect(TokenKind.RPAREN)
        then_body = self._parse_block()
        else_body: list[Stmt] = []
        if self._match(TokenKind.KW_ELSE):
            if self._at(TokenKind.KW_IF):
                else_body = [self._parse_if()]
            else:
                else_body = self._parse_block()
        return IfStmt(condition=cond, then_body=then_body, else_body=else_body, location=loc)

    def _parse_for(self) -> ForStmt:
        loc = self._loc()
        self._expect(TokenKind.KW_FOR)
        self._expect(TokenKind.LPAREN)
        init = self._parse_for_init()
        cond = self._parse_expr()
        self._expect(TokenKind.SEMICOLON)
        update = self._parse_for_update()
        self._expect(TokenKind.RPAREN)
        body = self._parse_block()
        return ForStmt(init=init, condition=cond, update=update, body=body, location=loc)

    def _parse_for_init(self) -> Stmt:
        if self._is_type_start() and self._is_local_var_decl():
            return self._parse_local_var_decl()
        return self._parse_expr_or_assign()

    def _parse_for_update(self) -> Stmt:
        expr = self._parse_expr()
        # handle i++ / i-- as expression statements
        return ExprStmt(expr=expr, location=expr.location)

    def _parse_while(self) -> WhileStmt:
        loc = self._loc()
        self._expect(TokenKind.KW_WHILE)
        self._expect(TokenKind.LPAREN)
        cond = self._parse_expr()
        self._expect(TokenKind.RPAREN)
        body = self._parse_block()
        return WhileStmt(condition=cond, body=body, location=loc)

    def _parse_free_stmt(self) -> FreeStmt:
        loc = self._loc()
        self._expect(TokenKind.BI_FREE)
        self._expect(TokenKind.LPAREN)
        expr = self._parse_expr()
        self._expect(TokenKind.RPAREN)
        self._expect(TokenKind.SEMICOLON)
        return FreeStmt(expr=expr, location=loc)

    def _parse_print_stmt(self) -> PrintStmt:
        loc = self._loc()
        self._expect(TokenKind.BI_PRINT)
        self._expect(TokenKind.LPAREN)
        val = self._parse_expr()
        fmt = None
        if self._match(TokenKind.COMMA):
            fmt = self._parse_expr()
        self._expect(TokenKind.RPAREN)
        self._expect(TokenKind.SEMICOLON)
        return PrintStmt(value=val, fmt=fmt, location=loc)

    def _parse_asm(self) -> AsmBlock:
        loc = self._loc()
        self._expect(TokenKind.KW_ASM)
        self._expect(TokenKind.LPAREN)
        inputs: list[AsmBinding] = []
        outputs: list[AsmBinding] = []
        while not self._at(TokenKind.RPAREN, TokenKind.EOF):
            tags = self._parse_tags()
            reg = self._expect(TokenKind.IDENTIFIER).value
            self._expect(TokenKind.ASSIGN)
            var = self._expect(TokenKind.IDENTIFIER).value
            binding = AsmBinding(register=reg, variable=var, location=self._loc())
            if "in" in tags:
                inputs.append(binding)
            if "out" in tags:
                outputs.append(binding)
            self._match(TokenKind.SEMICOLON)
        self._expect(TokenKind.RPAREN)
        self._expect(TokenKind.LBRACE)
        # here I collect raw assembly lines, grouping tokens by source line number
        body_lines: list[str] = []
        current_line = -1
        current_tokens: list[str] = []
        while not self._at(TokenKind.RBRACE, TokenKind.EOF):
            tok = self._advance()
            tok_line = tok.location.line if tok.location else -1
            if tok_line != current_line and current_tokens:
                body_lines.append(" ".join(current_tokens))
                current_tokens = []
            current_line = tok_line
            current_tokens.append(tok.value)
        if current_tokens:
            body_lines.append(" ".join(current_tokens))
        self._expect(TokenKind.RBRACE)
        return AsmBlock(inputs=inputs, outputs=outputs, body=body_lines, location=loc)

    def _parse_expr_or_assign(self) -> Stmt:
        loc = self._loc()
        expr = self._parse_expr()

        assign_ops = {
            TokenKind.ASSIGN: "=",
            TokenKind.PLUS_EQ: "+=",
            TokenKind.MINUS_EQ: "-=",
            TokenKind.STAR_EQ: "*=",
            TokenKind.SLASH_EQ: "/=",
        }

        for tok_kind, op_str in assign_ops.items():
            if self._match(tok_kind):
                value = self._parse_expr()
                self._expect(TokenKind.SEMICOLON)
                return Assignment(target=expr, value=value, op=op_str, location=loc)

        self._expect(TokenKind.SEMICOLON)
        return ExprStmt(expr=expr, location=loc)

    def _parse_expr(self) -> Expr:
        return self._parse_or()

    def _parse_or(self) -> Expr:
        left = self._parse_and()
        while self._at(TokenKind.OR):
            op = self._advance().value
            right = self._parse_and()
            left = BinaryExpr(op=op, left=left, right=right, location=left.location)
        return left

    def _parse_and(self) -> Expr:
        left = self._parse_equality()
        while self._at(TokenKind.AND):
            op = self._advance().value
            right = self._parse_equality()
            left = BinaryExpr(op=op, left=left, right=right, location=left.location)
        return left

    def _parse_equality(self) -> Expr:
        left = self._parse_comparison()
        while self._at(TokenKind.EQ, TokenKind.NEQ):
            op = self._advance().value
            right = self._parse_comparison()
            left = BinaryExpr(op=op, left=left, right=right, location=left.location)
        return left

    def _parse_comparison(self) -> Expr:
        left = self._parse_additive()
        while self._at(TokenKind.LT, TokenKind.GT, TokenKind.LTE, TokenKind.GTE):
            op = self._advance().value
            right = self._parse_additive()
            left = BinaryExpr(op=op, left=left, right=right, location=left.location)
        return left

    def _parse_additive(self) -> Expr:
        left = self._parse_multiplicative()
        while self._at(TokenKind.PLUS, TokenKind.MINUS):
            op = self._advance().value
            right = self._parse_multiplicative()
            left = BinaryExpr(op=op, left=left, right=right, location=left.location)
        return left

    def _parse_multiplicative(self) -> Expr:
        left = self._parse_unary()
        while self._at(TokenKind.STAR, TokenKind.SLASH, TokenKind.PERCENT):
            op = self._advance().value
            right = self._parse_unary()
            left = BinaryExpr(op=op, left=left, right=right, location=left.location)
        return left

    def _parse_unary(self) -> Expr:
        if self._at(TokenKind.NOT):
            loc = self._loc()
            op = self._advance().value
            operand = self._parse_unary()
            return UnaryExpr(op=op, operand=operand, location=loc)
        if self._at(TokenKind.MINUS):
            loc = self._loc()
            op = self._advance().value
            operand = self._parse_unary()
            return UnaryExpr(op=op, operand=operand, location=loc)
        if self._at(TokenKind.STAR):
            loc = self._loc()
            self._advance()
            operand = self._parse_unary()
            return DerefExpr(operand=operand, location=loc)
        if self._at(TokenKind.AMPERSAND):
            loc = self._loc()
            self._advance()
            operand = self._parse_unary()
            return AddressOfExpr(operand=operand, location=loc)
        return self._parse_postfix()

    def _parse_postfix(self) -> Expr:
        expr = self._parse_primary()
        while True:
            if self._at(TokenKind.DOT):
                self._advance()
                name = self._expect(TokenKind.IDENTIFIER).value
                if self._at(TokenKind.LPAREN):
                    self._advance()
                    args = self._parse_arg_list()
                    self._expect(TokenKind.RPAREN)
                    expr = MethodCallExpr(obj=expr, method=name, args=args, location=expr.location)
                else:
                    expr = FieldAccessExpr(obj=expr, field_name=name, location=expr.location)
            elif self._at(TokenKind.LBRACKET):
                self._advance()
                idx = self._parse_expr()
                self._expect(TokenKind.RBRACKET)
                expr = IndexExpr(obj=expr, index=idx, location=expr.location)
            elif self._at(TokenKind.PLUS_PLUS):
                loc = self._loc()
                self._advance()
                expr = UnaryExpr(op="post++", operand=expr, location=loc)
            elif self._at(TokenKind.MINUS_MINUS):
                loc = self._loc()
                self._advance()
                expr = UnaryExpr(op="post--", operand=expr, location=loc)
            else:
                break
        return expr

    def _parse_primary(self) -> Expr:
        loc = self._loc()

        if self._at(TokenKind.INT_LITERAL):
            tok = self._advance()
            val_str = tok.value.replace("_", "")
            if val_str.startswith(("0x", "0X")):
                val = int(val_str, 16)
            elif val_str.startswith(("0b", "0B")):
                val = int(val_str, 2)
            else:
                val = int(val_str)
            return IntLiteral(value=val, location=loc)

        if self._at(TokenKind.FLOAT_LITERAL):
            tok = self._advance()
            return FloatLiteral(value=float(tok.value.replace("_", "")), location=loc)

        if self._at(TokenKind.STRING_LITERAL):
            return StringLiteral(value=self._advance().value, location=loc)

        if self._at(TokenKind.CHAR_LITERAL):
            return CharLiteral(value=self._advance().value, location=loc)

        if self._at(TokenKind.BOOL_TRUE):
            self._advance()
            return BoolLiteral(value=True, location=loc)

        if self._at(TokenKind.BOOL_FALSE):
            self._advance()
            return BoolLiteral(value=False, location=loc)

        if self._at(TokenKind.NULL_LITERAL):
            self._advance()
            return NullLiteral(location=loc)

        # multi-dispatch: {a, b}.method(args)
        if self._at(TokenKind.LBRACE):
            return self._parse_multi_dispatch_or_set()

        # Init<T>(...)
        if self._at(TokenKind.BI_INIT):
            return self._parse_init_expr()

        # Malloc(size)
        if self._at(TokenKind.BI_MALLOC):
            return self._parse_malloc_expr()

        # SizeOf(T)
        if self._at(TokenKind.BI_SIZEOF):
            return self._parse_sizeof_expr()

        # Identifier or function call
        if self._at(TokenKind.IDENTIFIER):
            tok = self._advance()
            if self._at(TokenKind.LPAREN):
                self._advance()
                args = self._parse_arg_list()
                self._expect(TokenKind.RPAREN)
                return CallExpr(callee=IdentifierExpr(name=tok.value, location=loc), args=args, location=loc)
            return IdentifierExpr(name=tok.value, location=loc)

        # Parenthesized expr
        if self._at(TokenKind.LPAREN):
            self._advance()
            expr = self._parse_expr()
            self._expect(TokenKind.RPAREN)
            return expr

        raise ParseError(f"unexpected token in expression: {self._cur().kind.name} ({self._cur().value!r})", loc)

    def _parse_init_expr(self) -> InitExpr:
        loc = self._loc()
        self._expect(TokenKind.BI_INIT)
        self._expect(TokenKind.LT)
        class_name = self._expect(TokenKind.IDENTIFIER).value
        self._expect(TokenKind.GT)
        self._expect(TokenKind.LPAREN)
        kwargs: list[tuple[str, Expr]] = []
        while not self._at(TokenKind.RPAREN, TokenKind.EOF):
            key = self._expect(TokenKind.IDENTIFIER).value
            self._expect(TokenKind.COLON)
            val = self._parse_expr()
            kwargs.append((key, val))
            if not self._match(TokenKind.COMMA):
                break
        self._expect(TokenKind.RPAREN)
        return InitExpr(class_name=class_name, kwargs=kwargs, location=loc)

    def _parse_malloc_expr(self) -> MallocExpr:
        loc = self._loc()
        self._expect(TokenKind.BI_MALLOC)
        self._expect(TokenKind.LPAREN)
        size = self._parse_expr()
        self._expect(TokenKind.RPAREN)
        return MallocExpr(size=size, location=loc)

    def _parse_sizeof_expr(self) -> SizeOfExpr:
        loc = self._loc()
        self._expect(TokenKind.BI_SIZEOF)
        self._expect(TokenKind.LPAREN)
        ty = self._parse_type_expr()
        self._expect(TokenKind.RPAREN)
        return SizeOfExpr(target_type=ty, location=loc)

    def _parse_multi_dispatch_or_set(self) -> Expr:
        loc = self._loc()
        self._expect(TokenKind.LBRACE)
        targets: list[Expr] = []
        while not self._at(TokenKind.RBRACE, TokenKind.EOF):
            targets.append(self._parse_expr())
            if not self._match(TokenKind.COMMA):
                break
        self._expect(TokenKind.RBRACE)
        self._expect(TokenKind.DOT)
        method = self._expect(TokenKind.IDENTIFIER).value
        self._expect(TokenKind.LPAREN)
        args = self._parse_arg_list()
        self._expect(TokenKind.RPAREN)
        return MultiDispatchExpr(targets=targets, method=method, args=args, location=loc)

    def _parse_arg_list(self) -> list[Expr]:
        args: list[Expr] = []
        if self._at(TokenKind.RPAREN):
            return args
        args.append(self._parse_expr())
        while self._match(TokenKind.COMMA):
            args.append(self._parse_expr())
        return args
