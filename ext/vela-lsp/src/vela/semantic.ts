import { DiagnosticSeverity } from "vscode-languageserver/node";
import {
  ASM_REGISTER_NAMES,
  ASM_TAG_NAMES,
  AliasDeclNode,
  AnalysisResult,
  AsmBlockNode,
  AssignmentStmtNode,
  BOOL,
  BinaryExprNode,
  BlockStmtNode,
  CallExprNode,
  CastExprNode,
  ClassDeclNode,
  ClassFieldInfo,
  DeclNode,
  ExprNode,
  F16,
  FieldAccessExprNode,
  ForStmtNode,
  FunctionDeclNode,
  I16,
  I8,
  IfStmtNode,
  ImportDeclNode,
  InitExprNode,
  MallocExprNode,
  MethodCallExprNode,
  ModuleDeclNode,
  MultiDispatchExprNode,
  NULL_PTR,
  PRIMITIVE_TYPES,
  ParamDeclNode,
  ParseResult,
  PtrTypeNode,
  ReturnStmtNode,
  StmtNode,
  TypeDeclNode,
  TypeExprNode,
  U0,
  U16,
  U8,
  UNKNOWN,
  UnaryExprNode,
  VarDeclNode,
  VelaDiagnostic,
  VelaRange,
  VelaReference,
  VelaSymbol,
  VelaType,
  isBoolLike,
  isFloat,
  isInteger,
  isNumeric,
  rangeLength,
  typeSize,
  typeToString,
} from "./model.js";

const PRIMITIVE_TO_BOXED: Record<string, string> = {
  I16: "Int",
  U16: "Int",
  I8: "Int",
  U8: "Char",
  F16: "Float",
  Bool: "Bool",
};

export interface SemanticEnvironment {
  resolveImport(importDecl: ImportDeclNode, fromUri: string): ModuleDeclNode[];
  moduleUri(module: ModuleDeclNode): string | undefined;
  isDefaultLibraryUri(uri: string): boolean;
  documentationFor(symbol: VelaSymbol): string | undefined;
  requireMainDiagnostic: "off" | "currentFile" | "workspaceEntry";
}

interface Scope {
  name: string;
  parent?: Scope;
  symbols: Map<string, VelaSymbol>;
}

interface FunctionSignature {
  name: string;
  returnType: VelaType;
  params: { name: string; type: VelaType; range: VelaRange }[];
  decl: FunctionDeclNode;
  symbol: VelaSymbol;
}

interface IncludedEntry {
  moduleKey: string;
  description: string;
  range: VelaRange;
}

export function analyzeVela(parse: ParseResult, env: SemanticEnvironment): AnalysisResult {
  return new Analyzer(parse, env).analyze();
}

class Analyzer {
  private readonly diagnostics: VelaDiagnostic[] = [];
  private readonly symbols: VelaSymbol[] = [];
  private readonly references: VelaReference[] = [];
  private readonly expressionTypes: { range: VelaRange; type: VelaType }[] = [];
  private readonly callEdges: { from: VelaSymbol; to: VelaSymbol; range: VelaRange }[] = [];
  private readonly moduleScopes = new Map<ModuleDeclNode, Scope>();
  private readonly classDecls = new Map<string, ClassDeclNode>();
  private readonly classDeclsByModule = new Map<string, ClassDeclNode>();
  private readonly classModules = new WeakMap<ClassDeclNode, ModuleDeclNode>();
  private readonly classUris = new Map<string, string>();
  private readonly typeDecls = new Map<string, TypeDeclNode>();
  private readonly aliases = new Map<string, VelaType>();
  private readonly classTypes = new Map<string, VelaType>();
  private readonly classTypeSymbols = new WeakMap<VelaType, VelaSymbol>();
  private readonly functions = new Map<string, FunctionSignature>();
  private readonly processedTags = new WeakSet<ClassDeclNode>();
  private readonly includedTopLevelNames = new Map<string, IncludedEntry>();
  private readonly includedAssemblyLabels = new Map<string, IncludedEntry>();
  private currentScope: Scope = { name: "global", symbols: new Map() };
  private currentFunction?: FunctionDeclNode;
  private currentFunctionSymbol?: VelaSymbol;
  private currentClass?: ClassDeclNode;
  private currentModule?: ModuleDeclNode;

  constructor(
    private readonly parse: ParseResult,
    private readonly env: SemanticEnvironment,
  ) {
    this.diagnostics.push(...parse.diagnostics);
  }

  analyze(): AnalysisResult {
    this.checkDuplicateModules();
    for (const module of this.parse.program.modules) {
      this.checkModule(module);
    }
    return {
      uri: this.parse.uri,
      diagnostics: this.diagnostics,
      symbols: this.symbols,
      references: this.references,
      expressionTypes: this.expressionTypes,
      visibleSymbols: [...this.currentScope.symbols.values(), ...this.symbols.filter((symbol) => symbol.kind !== "local" && symbol.kind !== "param")],
      callEdges: this.callEdges,
    };
  }

  private checkDuplicateModules(): void {
    const seen = new Map<string, ModuleDeclNode>();
    for (const module of this.parse.program.modules) {
      const previous = seen.get(module.name);
      if (previous) {
        this.addDiagnostic(
          "vela.sem.duplicateModule",
          `duplicate module '${module.name}' in the same source file`,
          module.nameRange,
          "rename one module; modules in the same file must have distinct names",
          [{ message: "first module declaration", range: previous.nameRange }],
        );
      } else {
        seen.set(module.name, module);
      }
    }
  }

  private checkModule(module: ModuleDeclNode): void {
    this.currentModule = module;
    const scope: Scope = { name: module.name, parent: undefined, symbols: new Map() };
    this.currentScope = scope;
    this.moduleScopes.set(module, scope);
    this.addModuleSymbol(module);

    const importedModules = this.resolveImports(module);
    for (const imported of importedModules) {
      this.registerModuleDeclarations(imported, true);
    }
    this.registerModuleDeclarations(module, false);
    this.validateTopLevel(module, importedModules);
    this.expandTags(module);
    this.buildClassTypes(module);
    this.validateInheritance(module);
    this.defineAliases(module);
    this.defineValues(module);
    this.checkTopLevelBodies(module);
    if (this.env.requireMainDiagnostic !== "off") {
      this.checkMain(module);
    }
  }

  private resolveImports(module: ModuleDeclNode): ModuleDeclNode[] {
    const imported: ModuleDeclNode[] = [];
    for (const imp of module.imports) {
      if (!imp.wildcard && !imp.modules.includes("*")) {
        for (let i = 0; i < imp.modules.length; i++) {
          const moduleName = imp.modules[i];
          if (!moduleName) {
            continue;
          }
          const singleImport = { ...imp, modules: [moduleName], moduleRanges: imp.moduleRanges[i] ? [imp.moduleRanges[i]!] : [], wildcard: false };
          const modules = this.env.resolveImport(singleImport, this.parse.uri);
          if (modules.length === 0) {
            this.addDiagnostic(
              "vela.import.unresolved",
              `cannot resolve import module '${moduleName}' from ${imp.package.join("::")}`,
              imp.moduleRanges[i] ?? imp.range,
              "check the package path, module name, workspace root, and stdlib path",
              importPackageRelatedInfo(imp),
            );
            continue;
          }
          imported.push(...modules);
        }
        continue;
      }
      const modules = this.env.resolveImport(imp, this.parse.uri);
      if (modules.length === 0) {
        this.addDiagnostic(
          "vela.import.unresolved",
          `cannot resolve import ${formatImport(imp)}`,
          imp.range,
          "check the package path, module name, workspace root, and stdlib path",
          importPackageRelatedInfo(imp),
        );
      }
      for (const importedModule of modules) {
        imported.push(importedModule);
      }
    }
    if (this.needsImplicitStoreable(module, imported)) {
      const storeableImport: ImportDeclNode = {
        kind: "ImportDecl",
        package: ["stdlib", "core"],
        packageRanges: [],
        modules: ["storeable"],
        moduleRanges: [],
        wildcard: false,
        range: module.nameRange,
      };
      for (const importedModule of this.env.resolveImport(storeableImport, this.parse.uri)) {
        if (!imported.includes(importedModule)) {
          imported.push(importedModule);
        }
      }
    }
    return imported;
  }

  private needsImplicitStoreable(module: ModuleDeclNode, imported: ModuleDeclNode[]): boolean {
    const hasParentlessClass = module.body.some((node) => node.kind === "ClassDecl" && !node.parent && node.name !== "Storeable");
    if (!hasParentlessClass) {
      return false;
    }
    return !module.body.some((node) => node.kind === "ClassDecl" && node.name === "Storeable")
      && !imported.some((importedModule) => importedModule.body.some((node) => node.kind === "ClassDecl" && node.name === "Storeable"));
  }

  private registerModuleDeclarations(module: ModuleDeclNode, imported: boolean): void {
    this.expandTags(module);
    const moduleUri = this.env.moduleUri(module) ?? this.parse.uri;
    const defaultLibrary = this.env.isDefaultLibraryUri(moduleUri);

    for (const node of module.body) {
      if (node.kind === "ClassDecl") {
        this.classDecls.set(node.name, node);
        this.classDeclsByModule.set(classDeclKey(module.name, node.name), node);
        this.classModules.set(node, module);
        this.classUris.set(node.name, moduleUri);
        const symbol = this.addSymbol({
          id: topLevelId(moduleUri, module.name, "class", node.name),
          name: node.name,
          kind: "class",
          type: { kind: "class", name: node.name, parent: node.parent, fields: [], methods: [], size: 2, vtable: {} },
          uri: moduleUri,
          range: node.range,
          selectionRange: node.nameRange,
          moduleName: module.name,
          defaultLibrary,
          decl: node,
        });
        this.define(node.name, symbol, imported);
      } else if (node.kind === "TypeDecl") {
        this.typeDecls.set(node.name, node);
        const symbol = this.addSymbol({
          id: topLevelId(moduleUri, module.name, "type", node.name),
          name: node.name,
          kind: "type",
          type: { kind: "interface", name: node.name, methods: node.methods.map((method) => method.name) },
          uri: moduleUri,
          range: node.range,
          selectionRange: node.nameRange,
          moduleName: module.name,
          defaultLibrary,
          decl: node,
        });
        this.define(node.name, symbol, imported);
        for (const method of node.methods) {
          const signature = this.signatureFor(method);
          this.addSymbol({
            id: memberId(moduleUri, node.name, "method", method.name, module.name),
            name: method.name,
            kind: "method",
            type: signature.returnType,
            uri: moduleUri,
            range: method.range,
            selectionRange: method.nameRange,
            className: node.name,
            moduleName: module.name,
            params: signature.params,
            returnType: signature.returnType,
            defaultLibrary,
            decl: method,
          });
        }
      }
    }

    for (const node of module.body) {
      if (node.kind === "AliasDecl") {
        const target = this.resolveType(node.targetType);
        this.aliases.set(node.name, target);
        const symbol = this.addSymbol({
          id: topLevelId(moduleUri, module.name, "alias", node.name),
          name: node.name,
          kind: "alias",
          type: target,
          uri: moduleUri,
          range: node.range,
          selectionRange: node.nameRange,
          moduleName: module.name,
          defaultLibrary,
          decl: node,
        });
        this.define(node.name, symbol, imported);
      } else if (node.kind === "FunctionDecl" && !node.isSkeleton) {
        const signature = this.signatureFor(node);
        const symbol = this.addSymbol({
          id: topLevelId(moduleUri, module.name, "function", node.name),
          name: node.name,
          kind: "function",
          type: signature.returnType,
          uri: moduleUri,
          range: node.range,
          selectionRange: node.nameRange,
          moduleName: module.name,
          params: signature.params,
          returnType: signature.returnType,
          defaultLibrary,
          decl: node,
        });
        this.define(node.name, symbol, imported);
      } else if (node.kind === "VarDecl") {
        const type = this.resolveType(node.typeExpr);
        const symbol = this.addSymbol({
          id: topLevelId(moduleUri, module.name, "global", node.name),
          name: node.name,
          kind: "global",
          type,
          uri: moduleUri,
          range: node.range,
          selectionRange: node.nameRange,
          moduleName: module.name,
          defaultLibrary,
          decl: node,
        });
        this.define(node.name, symbol, imported);
      }
    }
  }

  private validateTopLevel(module: ModuleDeclNode, importedModules: ModuleDeclNode[] = []): void {
    this.rememberImportedDeclarations(module, importedModules);
    const localNames = new Map<string, DeclNode>();
    const assemblyLabels = new Map<string, DeclNode>();
    for (const node of module.body) {
      if (!hasName(node)) {
        continue;
      }
      if (node.name.startsWith("__")) {
        this.addDiagnostic(
          "vela.sem.reservedName",
          `top-level declaration '${node.name}' uses reserved internal prefix '__'`,
          node.nameRange,
          "rename the declaration; labels beginning with '__' are reserved for generated CPU code",
        );
      }
      if (node.kind === "ClassDecl" && node.name === "Storeable" && !this.isBuiltinStoreable(module)) {
        this.addDiagnostic(
          "vela.sem.reservedStoreable",
          "class 'Storeable' conflicts with the implicit Storeable base class",
          node.nameRange,
          "rename the class; Storeable is provided by stdlib/core/storeable.vl",
        );
      }
      const includedName = this.includedTopLevelNames.get(node.name);
      if (includedName && !sameIncludedEntry(includedName, this.includedEntry(module, declKindDescription(node), node.nameRange))) {
        this.addDiagnostic(
          "vela.sem.includedTopLevelCollision",
          `top-level declaration '${node.name}' conflicts with included ${includedName.description}`,
          node.nameRange,
          "Vela currently emits a flat program namespace; rename one declaration or compile it separately",
          [{ message: "included declaration", range: includedName.range }],
        );
      }
      const previous = localNames.get(node.name);
      if (previous) {
        this.addDiagnostic(
          "vela.sem.duplicateTopLevel",
          `duplicate top-level declaration '${node.name}'`,
          node.nameRange,
          `'${node.name}' was already declared as a ${previous.kind}`,
          [{ message: "previous declaration", range: previous.range }],
        );
      } else {
        localNames.set(node.name, node);
      }
      for (const label of assemblyLabelsFor(node)) {
        if (label.name === "main" && !(node.kind === "FunctionDecl" && node.name === "main")) {
          this.addDiagnostic("vela.sem.flatAssemblyCollision", `assembly label 'main' for ${label.description} conflicts with the program entry label`, label.range, "rename the declaration");
        }
        if (label.name === "space") {
          this.addDiagnostic("vela.sem.flatAssemblyCollision", `assembly label 'space' for ${label.description} conflicts with the data section label`, label.range, "rename the declaration");
        }
        const includedLabel = this.includedAssemblyLabels.get(label.name);
        if (includedLabel && !sameIncludedEntry(includedLabel, this.includedEntry(module, label.description, label.range))) {
          this.addDiagnostic(
            "vela.sem.flatAssemblyCollision",
            `assembly label '${label.name}' for ${label.description} conflicts with included ${includedLabel.description}`,
            label.range,
            "Vela currently emits flat CPU labels; rename one declaration to avoid the collision",
            [{ message: "included declaration", range: includedLabel.range }],
          );
        }
        const previousLabel = assemblyLabels.get(label.name);
        if (previousLabel) {
          this.addDiagnostic(
            "vela.sem.flatAssemblyCollision",
            `assembly label '${label.name}' for ${label.description} conflicts with another declaration`,
            label.range,
            "Vela currently emits flat CPU labels; rename one declaration to avoid the collision",
            [{ message: "conflicting declaration", range: previousLabel.range }],
          );
        } else {
          assemblyLabels.set(label.name, node);
        }
      }
    }
    for (const node of module.body) {
      if (hasName(node)) {
        this.rememberIncludedTopLevel(node.name, this.includedEntry(module, declKindDescription(node), node.nameRange));
        for (const label of assemblyLabelsFor(node)) {
          this.rememberIncludedAssemblyLabel(label.name, this.includedEntry(module, label.description, label.range));
        }
      }
    }
  }

  private rememberImportedDeclarations(module: ModuleDeclNode, importedModules: ModuleDeclNode[]): void {
    for (const imported of importedModules) {
      for (const node of imported.body) {
        if (!hasName(node)) {
          continue;
        }
        const entry = this.includedEntry(imported, declKindDescription(node), node.nameRange);
        const previous = this.includedTopLevelNames.get(node.name);
        if (previous && !sameIncludedEntry(previous, entry)) {
          this.addDiagnostic(
            "vela.sem.includedTopLevelCollision",
            `included ${entry.description} conflicts with included ${previous.description}`,
            module.nameRange,
            "Vela currently emits a flat program namespace; rename one declaration or compile it separately",
            [
              { message: "previous included declaration", range: previous.range },
              { message: "conflicting included declaration", range: entry.range },
            ],
          );
        }
        this.rememberIncludedTopLevel(node.name, entry);
        for (const label of assemblyLabelsFor(node)) {
          const labelEntry = this.includedEntry(imported, label.description, label.range);
          const previousLabel = this.includedAssemblyLabels.get(label.name);
          if (previousLabel && !sameIncludedEntry(previousLabel, labelEntry)) {
            this.addDiagnostic(
              "vela.sem.flatAssemblyCollision",
              `included assembly label '${label.name}' for ${label.description} conflicts with included ${previousLabel.description}`,
              module.nameRange,
              "Vela currently emits flat CPU labels; rename one declaration to avoid the collision",
              [
                { message: "previous included declaration", range: previousLabel.range },
                { message: "conflicting included declaration", range: labelEntry.range },
              ],
            );
          }
          this.rememberIncludedAssemblyLabel(label.name, labelEntry);
        }
      }
    }
  }

  private includedEntry(module: ModuleDeclNode, description: string, range: VelaRange): IncludedEntry {
    return { moduleKey: `${this.env.moduleUri(module) ?? this.parse.uri}#${module.name}`, description, range };
  }

  private rememberIncludedTopLevel(name: string, entry: IncludedEntry): void {
    const previous = this.includedTopLevelNames.get(name);
    if (!previous) {
      this.includedTopLevelNames.set(name, entry);
    }
  }

  private rememberIncludedAssemblyLabel(name: string, entry: IncludedEntry): void {
    const previous = this.includedAssemblyLabels.get(name);
    if (!previous) {
      this.includedAssemblyLabels.set(name, entry);
    }
  }

  private expandTags(module: ModuleDeclNode): void {
    for (const node of module.body) {
      if (node.kind !== "ClassDecl" || this.processedTags.has(node)) {
        continue;
      }
      this.processedTags.add(node);
      const explicit = new Map(node.methods.filter((method) => !method.generated).map((method) => [method.name, method]));
      const generatedNames = new Set(node.methods.filter((method) => method.generated).map((method) => method.name));
      const generated: FunctionDeclNode[] = [];
      for (const field of node.fields) {
        for (let tagIndex = 0; tagIndex < field.tags.length; tagIndex++) {
          const tag = field.tags[tagIndex]!;
          if (tag !== "get" && tag !== "set" && tag !== "visible") {
            this.addDiagnostic("vela.sem.unknownTag", `unknown field tag '${tag}'`, field.tagRanges[tagIndex] ?? field.range, "supported tags are get, set, and visible");
            continue;
          }
          if (tag === "get") {
            const name = pascal("Get", field.name);
            const explicitMethod = explicit.get(name);
            if (explicitMethod) {
              this.addDiagnostic(
                "vela.sem.tagMethodCollision",
                `class '${node.name}': tag [[get]] on field '${field.name}' generates method '${name}()' which is already explicitly defined`,
                field.nameRange,
                undefined,
                [{ message: "explicit method", range: explicitMethod.nameRange }],
              );
              continue;
            }
            if (generatedNames.has(name)) {
              continue;
            }
            generatedNames.add(name);
            generated.push(makeGeneratedGetter(field, name));
          }
          if (tag === "set") {
            const name = pascal("Set", field.name);
            const explicitMethod = explicit.get(name);
            if (explicitMethod) {
              this.addDiagnostic(
                "vela.sem.tagMethodCollision",
                `class '${node.name}': tag [[set]] on field '${field.name}' generates method '${name}()' which is already explicitly defined`,
                field.nameRange,
                undefined,
                [{ message: "explicit method", range: explicitMethod.nameRange }],
              );
              continue;
            }
            if (generatedNames.has(name)) {
              continue;
            }
            generatedNames.add(name);
            generated.push(makeGeneratedSetter(field, name));
          }
        }
      }
      node.methods.push(...generated);
    }
  }

  private buildClassTypes(module: ModuleDeclNode): void {
    for (const node of module.body) {
      if (node.kind === "ClassDecl") {
        const clsType = this.ensureClassType(node.name, new Set(), node);
        const symbol = this.lookup(node.name, new Set(["class"]));
        if (symbol) {
          symbol.type = clsType;
        }
      }
    }
  }

  private ensureClassType(className: string, stack: Set<string>, knownDecl?: ClassDeclNode): VelaType {
    const cls = knownDecl ?? this.classDeclForName(className);
    const key = cls ? this.classTypeKey(cls) : className;
    if (!cls) {
      return { kind: "class", name: className, fields: [], methods: [], size: 2, vtable: {} };
    }
    if (stack.has(key)) {
      this.addDiagnostic("vela.sem.inheritanceCycle", `inheritance cycle detected involving '${className}'`, cls.nameRange);
      return { kind: "class", name: className, fields: [], methods: [], size: 2, vtable: {} };
    }
    const existing = this.classTypes.get(key);
    if (existing) {
      return existing;
    }
    stack.add(key);
    const parentName = this.effectiveClassParent(cls);
    const provisionalClassType: VelaType = {
      kind: "class",
      name: cls.name,
      parent: parentName,
      fields: [],
      methods: [],
      size: 2,
      vtable: {},
    };
    this.classTypes.set(key, provisionalClassType);
    const classModule = this.classModules.get(cls);
    const classUri = (classModule ? this.env.moduleUri(classModule) : undefined) ?? this.classUris.get(cls.name) ?? this.parse.uri;
    const defaultLibrary = this.env.isDefaultLibraryUri(classUri);
    const classSymbol = this.classSymbolForDecl(cls);
    if (classSymbol) {
      this.classTypeSymbols.set(provisionalClassType, classSymbol);
    }
    const fields: ClassFieldInfo[] = [];
    let offset = 2;
    const vtable: Record<string, number> = {};
    const methodNames: string[] = [];
    if (parentName && this.classDeclForName(parentName)) {
      const parentSymbol = this.parentSymbolForClassDecl(cls, new Set(["class"]));
      const parentType = parentSymbol?.decl?.kind === "ClassDecl"
        ? this.ensureClassType(parentSymbol.name, stack, parentSymbol.decl)
        : this.ensureClassType(parentName, stack);
      if (parentType.kind === "class") {
        for (const field of parentType.fields) {
          fields.push(field);
        }
        offset = parentType.size;
        Object.assign(vtable, parentType.vtable);
        methodNames.push(...parentType.methods);
      }
    }
    const seenLocalFields = new Map<string, VarDeclNode>();
    for (const field of cls.fields) {
      const fieldType = this.resolveType(field.typeExpr);
      this.checkValueStorageType(fieldType, `field '${field.name}'`, field.nameRange);
      const previousLocalField = seenLocalFields.get(field.name);
      if (previousLocalField) {
        this.addDiagnostic(
          "vela.sem.duplicateField",
          `class '${cls.name}': duplicate field '${field.name}'`,
          field.nameRange,
          undefined,
          [{ message: "previous field", range: previousLocalField.nameRange }],
        );
      } else {
        seenLocalFields.set(field.name, field);
      }
      const inheritedField = fields.find((item) => item.name === field.name);
      if (inheritedField) {
        this.addDiagnostic(
          "vela.sem.inheritedFieldDuplicate",
          `class '${cls.name}': field '${field.name}' duplicates inherited field`,
          field.nameRange,
          "use a distinct field name; inherited fields are already present",
          [{ message: "inherited field", range: inheritedField.range }],
        );
      }
      fields.push({ name: field.name, type: fieldType, range: field.nameRange, offset });
      offset += Math.max(1, typeSize(fieldType));
      this.addSymbol({
        id: memberId(classUri, cls.name, "field", field.name, classModule?.name),
        name: field.name,
        kind: "field",
        type: fieldType,
        uri: classUri,
        range: field.range,
        selectionRange: field.nameRange,
        className: cls.name,
        moduleName: classModule?.name,
        defaultLibrary,
        generated: field.generated,
        decl: field,
      });
    }
    const seenMethods = new Map<string, FunctionDeclNode>();
    for (const lifecycle of [cls.onAlloc, cls.onFree]) {
      if (!lifecycle) {
        continue;
      }
      const signature = this.signatureFor(lifecycle);
      this.addSymbol({
        id: memberId(classUri, cls.name, "method", lifecycle.name, classModule?.name),
        name: lifecycle.name,
        kind: "method",
        type: signature.returnType,
        uri: classUri,
        range: lifecycle.range,
        selectionRange: lifecycle.nameRange,
        className: cls.name,
        moduleName: classModule?.name,
        params: signature.params,
        returnType: signature.returnType,
        defaultLibrary,
        decl: lifecycle,
      });
    }
    for (const method of cls.methods) {
      const previousMethod = seenMethods.get(method.name);
      if (previousMethod) {
        this.addDiagnostic(
          "vela.sem.duplicateMethod",
          `class '${cls.name}': duplicate method '${method.name}'`,
          method.nameRange,
          undefined,
          [{ message: "previous method", range: previousMethod.nameRange }],
        );
      } else {
        seenMethods.set(method.name, method);
      }
      const inheritedSlot = vtable[method.name];
      vtable[method.name] = inheritedSlot ?? Object.keys(vtable).length;
      if (!methodNames.includes(method.name)) {
        methodNames.push(method.name);
      }
      const signature = this.signatureFor(method);
      this.addSymbol({
        id: memberId(classUri, cls.name, "method", method.name, classModule?.name),
        name: method.name,
        kind: "method",
        type: signature.returnType,
        uri: classUri,
        range: method.range,
        selectionRange: method.nameRange,
        className: cls.name,
        moduleName: classModule?.name,
        params: signature.params,
        returnType: signature.returnType,
        defaultLibrary,
        generated: method.generated,
        decl: method,
      });
    }
    const classType: VelaType = {
      kind: "class",
      name: cls.name,
      parent: parentName,
      fields,
      methods: methodNames,
      size: offset,
      vtable,
    };
    this.classTypes.set(key, classType);
    if (classSymbol) {
      this.classTypeSymbols.set(classType, classSymbol);
    }
    stack.delete(key);
    return classType;
  }

  private validateInheritance(module: ModuleDeclNode): void {
    for (const node of module.body) {
      if (node.kind !== "ClassDecl") {
        continue;
      }
      if (node.parent === "Storeable") {
        this.addDiagnostic("vela.sem.explicitStoreable", `class '${node.name}' must not explicitly extend Storeable; all classes inherit Storeable implicitly`, node.parentRange ?? node.nameRange);
      }
      const parentSymbol = node.parent ? this.lookup(node.parent, new Set(["class", "type"])) : undefined;
      const hasVisibleParent = !node.parent || !!parentSymbol;
      if (node.parent && !hasVisibleParent) {
        this.addDiagnostic(
          "vela.sem.unknownParent",
          `class '${node.name}' extends unknown class or type '${node.parent}'`,
          node.parentRange ?? node.nameRange,
          didYouMean(node.parent, this.inheritableTypeNames()) ?? "use an existing class or type declaration as the parent",
        );
      }
      if (hasVisibleParent) {
        this.validateOverrides(node, parentSymbol);
        this.validateSkeletons(node, parentSymbol);
      }
    }
    for (const node of module.body) {
      if (node.kind === "TypeDecl") {
        const seen = new Map<string, FunctionDeclNode>();
        for (const method of node.methods) {
          const previousMethod = seen.get(method.name);
          if (previousMethod) {
            this.addDiagnostic(
              "vela.sem.duplicateTypeMethod",
              `type '${node.name}': duplicate method '${method.name}'`,
              method.nameRange,
              undefined,
              [{ message: "previous type method", range: previousMethod.nameRange }],
            );
          } else {
            seen.set(method.name, method);
          }
          this.checkSignatureValueTypes(method);
        }
      }
    }
  }

  private validateOverrides(cls: ClassDeclNode, parentSymbol: VelaSymbol | undefined): void {
    if (!cls.parent || parentSymbol?.kind !== "class") {
      return;
    }
    for (const method of cls.methods) {
      const parentMethod = this.findMethodDeclForClassSymbol(parentSymbol, method.name);
      if (!parentMethod) {
        continue;
      }
      if (this.sameSignature(this.signatureFor(method), this.signatureFor(parentMethod))) {
        continue;
      }
      const expected = this.signatureFor(parentMethod);
      this.addDiagnostic(
        "vela.sem.invalidOverride",
        `class '${cls.name}' method '${method.name}' must match inherited signature ${typeToString(expected.returnType)}(${expected.params.map((param) => typeToString(param.type)).join(", ")})`,
        method.nameRange,
        "overridden methods must keep the same return type and parameter types",
      );
    }
  }

  private validateSkeletons(cls: ClassDeclNode, parentSymbol: VelaSymbol | undefined): void {
    if (!cls.parent || parentSymbol?.kind !== "type" || parentSymbol.decl?.kind !== "TypeDecl") {
      return;
    }
    const parent = parentSymbol.decl;
    const methods = new Map(cls.methods.map((method) => [method.name, method]));
    for (const skeleton of parent.methods) {
      const impl = methods.get(skeleton.name);
      if (!impl) {
        this.addDiagnostic("vela.sem.missingSkeleton", `class '${cls.name}' must implement skeleton method '${skeleton.name}' from type '${parent.name}'`, cls.nameRange);
        continue;
      }
      if (!this.sameSignature(this.signatureFor(impl), this.signatureFor(skeleton))) {
        const expected = this.signatureFor(skeleton);
        this.addDiagnostic(
          "vela.sem.invalidSkeletonSignature",
          `class '${cls.name}' method '${impl.name}' must match skeleton signature ${typeToString(expected.returnType)}(${expected.params.map((param) => typeToString(param.type)).join(", ")}) from type '${parent.name}'`,
          impl.nameRange,
          "use the same return type and parameter types as the skeleton method",
        );
      }
    }
  }

  private defineAliases(module: ModuleDeclNode): void {
    for (const node of module.body) {
      if (node.kind !== "AliasDecl") {
        continue;
      }
      const target = this.resolveType(node.targetType);
      this.aliases.set(node.name, target);
      const symbol = this.addSymbol({
        id: topLevelId(this.parse.uri, module.name, "alias", node.name),
        name: node.name,
        kind: "alias",
        type: target,
        uri: this.parse.uri,
        range: node.range,
        selectionRange: node.nameRange,
        moduleName: module.name,
        decl: node,
      });
      this.define(node.name, symbol);
    }
  }

  private defineValues(module: ModuleDeclNode): void {
    for (const node of module.body) {
      if (node.kind === "VarDecl") {
        const type = this.resolveType(node.typeExpr);
        this.checkValueStorageType(type, `global variable '${node.name}'`, node.nameRange);
        const symbol = this.addSymbol({
          id: topLevelId(this.parse.uri, module.name, "global", node.name),
          name: node.name,
          kind: "global",
          type,
          uri: this.parse.uri,
          range: node.range,
          selectionRange: node.nameRange,
          moduleName: module.name,
          decl: node,
        });
        this.define(node.name, symbol);
      } else if (node.kind === "FunctionDecl") {
        const signature = this.signatureFor(node);
        const symbol = this.addSymbol({
          id: topLevelId(this.parse.uri, module.name, "function", node.name),
          name: node.name,
          kind: "function",
          type: signature.returnType,
          uri: this.parse.uri,
          range: node.range,
          selectionRange: node.nameRange,
          moduleName: module.name,
          params: signature.params,
          returnType: signature.returnType,
          decl: node,
        });
        this.functions.set(node.name, { ...signature, symbol });
        this.define(node.name, symbol);
      }
    }
  }

  private checkTopLevelBodies(module: ModuleDeclNode): void {
    for (const node of module.body) {
      if (node.kind === "VarDecl") {
        this.checkGlobalVar(node);
      } else if (node.kind === "FunctionDecl") {
        this.checkFunction(node, this.lookup(node.name, new Set(["function"])));
      } else if (node.kind === "ClassDecl") {
        this.checkClass(node);
      }
    }
  }

  private checkGlobalVar(node: VarDeclNode): void {
    const type = this.resolveType(node.typeExpr);
    if (node.initializer) {
      const initType = this.checkExpr(node.initializer);
      this.checkInitializerCompatible(type, initType, node.initializer);
      if (!this.isStaticGlobalInitializer(type, node.initializer)) {
        this.addDiagnostic(
          "vela.sem.dynamicGlobalInitializer",
          `global initializer for '${node.name}' must be a static literal`,
          node.initializer.range,
          "use an integer, char, float, or null literal; initialize dynamic values in a function",
        );
      }
    }
  }

  private checkClass(cls: ClassDeclNode): void {
    this.currentClass = cls;
    this.pushScope(cls.name);
    const classType = this.ensureClassType(cls.name, new Set(), cls);
    if (classType.kind === "class") {
      this.define("this", this.syntheticClassSymbol(cls, "this", { kind: "ptr", inner: classType }));
      for (const field of classType.fields) {
        const fieldSymbol = this.symbolForClassField(cls.name, field.name) ?? makeLocalSymbol(field.name, "field", field.type, field.range, this.parse.uri);
        this.define(field.name, fieldSymbol);
      }
    }
    if (cls.onAlloc) {
      this.checkFunction(cls.onAlloc, this.symbolForClassMethod(cls.name, "OnAlloc"));
    }
    if (cls.onFree) {
      this.checkFunction(cls.onFree, this.symbolForClassMethod(cls.name, "OnFree"));
    }
    for (const method of cls.methods) {
      if (method.generated) {
        continue;
      }
      this.checkFunction(method, this.symbolForClassMethod(cls.name, method.name));
    }
    this.popScope();
    this.currentClass = undefined;
  }

  private checkFunction(fn: FunctionDeclNode, symbol?: VelaSymbol): void {
    if (fn.isSkeleton) {
      return;
    }
    this.currentFunction = fn;
    this.currentFunctionSymbol = symbol;
    this.pushScope(fn.name);
    const seenParams = new Map<string, ParamDeclNode>();
    for (const param of fn.params) {
      const paramType = this.resolveType(param.typeExpr);
      this.checkValueStorageType(paramType, `parameter '${param.name}'`, param.nameRange);
      const previous = seenParams.get(param.name);
      if (previous) {
        this.addDiagnostic(
          "vela.sem.duplicateParameter",
          `function '${fn.name}': duplicate parameter '${param.name}'`,
          param.nameRange,
          undefined,
          [{ message: "previous parameter", range: previous.nameRange }],
        );
      } else {
        seenParams.set(param.name, param);
      }
      const paramSymbol = this.addSymbol({
        id: localId(this.parse.uri, fn.name, "param", param.name, param.nameRange.start.offset),
        name: param.name,
        kind: "param",
        type: paramType,
        uri: this.parse.uri,
        range: param.range,
        selectionRange: param.nameRange,
        moduleName: this.currentModule?.name,
        className: this.currentClass?.name,
        decl: param,
      });
      this.define(param.name, paramSymbol);
    }
    for (const stmt of fn.body) {
      this.checkStmt(stmt);
    }
    const returnType = this.resolveType(fn.returnType);
    if (returnType.kind !== "void" && !this.blockAlwaysReturns(fn.body)) {
      this.addDiagnostic(
        "vela.sem.missingReturn",
        `function '${fn.name}' must return ${typeToString(returnType)} on all paths`,
        fn.nameRange,
        "add a return statement or change the function return type to U0",
      );
    }
    this.popScope();
    this.currentFunction = undefined;
    this.currentFunctionSymbol = undefined;
  }

  private checkStmt(stmt: StmtNode): void {
    switch (stmt.kind) {
      case "VarDecl":
        this.checkLocalVar(stmt);
        break;
      case "Assignment":
        this.checkAssignment(stmt);
        break;
      case "ReturnStmt":
        this.checkReturn(stmt);
        break;
      case "IfStmt":
        this.checkCondition("if", stmt.condition);
        this.pushScope("if");
        stmt.thenBody.forEach((child) => this.checkStmt(child));
        this.popScope();
        if (stmt.elseBody.length > 0) {
          this.pushScope("else");
          stmt.elseBody.forEach((child) => this.checkStmt(child));
          this.popScope();
        }
        break;
      case "ForStmt":
        this.pushScope("for");
        if (stmt.init) {
          this.checkStmt(stmt.init);
        }
        if (stmt.condition) {
          this.checkCondition("for", stmt.condition);
        }
        if (stmt.update) {
          this.checkStmt(stmt.update);
        }
        stmt.body.forEach((child) => this.checkStmt(child));
        this.popScope();
        break;
      case "WhileStmt":
        this.checkCondition("while", stmt.condition);
        this.pushScope("while");
        stmt.body.forEach((child) => this.checkStmt(child));
        this.popScope();
        break;
      case "ExprStmt":
        this.checkExpr(stmt.expr);
        break;
      case "FreeStmt": {
        const type = this.checkExpr(stmt.expr);
        if (type.kind !== "ptr") {
          this.addDiagnostic("vela.sem.freeNonPointer", `Free expects a pointer, got ${typeToString(type)}`, stmt.expr.range, "only values returned by Malloc, Init<T>, null, or pointer expressions can be freed");
        } else if (type.inner.kind === "class") {
          const classSymbol = this.classSymbolForType(type.inner);
          const onFree = classSymbol ? this.symbolForClassMethodSymbol(classSymbol, "OnFree") : this.symbolForClassMethod(type.inner.name, "OnFree");
          if (onFree) {
            this.addCallEdge(onFree, stmt.range);
          }
        }
        break;
      }
      case "PrintStmt":
        if (stmt.fmt) {
          this.addDiagnostic("vela.sem.printArity", "Print expects 1 argument, got 2", stmt.fmt.range, "Print currently supports only Print(value)");
        }
        this.checkExpr(stmt.value);
        break;
      case "AsmBlock":
        this.checkAsm(stmt);
        break;
      case "BlockStmt":
        this.pushScope("block");
        stmt.body.forEach((child) => this.checkStmt(child));
        this.popScope();
        break;
    }
  }

  private checkLocalVar(node: VarDeclNode): void {
    const type = this.resolveType(node.typeExpr);
    this.checkValueStorageType(type, `local variable '${node.name}'`, node.nameRange);
    const previous = this.currentScope.symbols.get(node.name);
    if (previous) {
      this.addDiagnostic(
        "vela.sem.duplicateLocal",
        `duplicate local declaration '${node.name}'`,
        node.nameRange,
        `'${node.name}' is already declared in this scope`,
        [{ message: "previous declaration in this scope", range: previous.selectionRange }],
      );
    }
    if (node.initializer) {
      const initType = this.checkExpr(node.initializer);
      if (isBoolLike(type) && !isBoolLike(initType) && !this.typesCompatible(type, initType)) {
        this.addDiagnostic("vela.sem.boolInitializer", `cannot initialise Bool from ${typeToString(initType)}; use true, false, or a comparison`, node.initializer.range);
      } else if (initType.kind === "bool" && !isBoolLike(type)) {
        this.addDiagnostic("vela.sem.boolAssignment", `cannot assign Bool to ${typeToString(type)}`, node.initializer.range);
      } else {
        this.checkInitializerCompatible(type, initType, node.initializer);
      }
    }
    const symbol = this.addSymbol({
      id: localId(this.parse.uri, this.currentFunction?.name ?? "<module>", "local", node.name, node.nameRange.start.offset),
      name: node.name,
      kind: "local",
      type,
      uri: this.parse.uri,
      range: node.range,
      selectionRange: node.nameRange,
      moduleName: this.currentModule?.name,
      className: this.currentClass?.name,
      decl: node,
    });
    this.define(node.name, symbol);
  }

  private checkAssignment(stmt: AssignmentStmtNode): void {
    if (!isLvalue(stmt.target)) {
      this.addDiagnostic("vela.sem.invalidAssignmentTarget", `assignment '${stmt.op}' requires an assignable target`, stmt.target.range, "assign to a variable, field, pointer dereference, or indexed pointer element");
    }
    const targetType = this.checkExpr(stmt.target, true);
    const valueType = this.checkExpr(stmt.value);
    if (isBoolLike(targetType) && !isBoolLike(valueType) && !this.typesCompatible(targetType, valueType)) {
      this.addDiagnostic("vela.sem.boolAssignment", `cannot assign ${typeToString(valueType)} to Bool; use true, false, or a comparison`, stmt.value.range);
      return;
    }
    if (valueType.kind === "bool" && !isBoolLike(targetType)) {
      this.addDiagnostic("vela.sem.boolAssignment", `cannot assign Bool to ${typeToString(targetType)}`, stmt.value.range);
      return;
    }
    if (this.hasOutOfRangeLiteralForSameIntType(targetType, valueType, stmt.value)) {
      return;
    }
    if (!this.argumentCompatible(targetType, valueType, stmt.value)) {
      this.addDiagnostic("vela.sem.incompatibleAssignment", `cannot assign ${typeToString(valueType)} to ${typeToString(targetType)}`, stmt.value.range, "use Cast<T>(expr) only when the conversion is intentional");
    }
  }

  private checkReturn(stmt: ReturnStmtNode): void {
    const expected = this.currentFunction ? this.resolveType(this.currentFunction.returnType) : U0;
    if (stmt.value) {
      const actual = this.checkExpr(stmt.value);
      if (expected.kind === "void") {
        this.addDiagnostic("vela.sem.returnValueInVoid", `function '${this.currentFunction?.name ?? "<unknown>"}' returns U0 and must not return a value`, stmt.value.range, "use 'ret;' or change the function return type");
      } else if (this.hasOutOfRangeLiteralForSameIntType(expected, actual, stmt.value)) {
        return;
      } else if (!this.argumentCompatible(expected, actual, stmt.value)) {
        this.addDiagnostic("vela.sem.incompatibleReturn", `function '${this.currentFunction?.name ?? "<unknown>"}' returns ${typeToString(expected)}, got ${typeToString(actual)}`, stmt.value.range, "return a value compatible with the function declaration");
      }
    } else if (expected.kind !== "void") {
      this.addDiagnostic("vela.sem.returnMissingValue", `function '${this.currentFunction?.name ?? "<unknown>"}' must return ${typeToString(expected)}`, stmt.range, "return a value or change the function return type to U0");
    }
  }

  private checkCondition(kind: "if" | "while" | "for", expr: ExprNode): void {
    const type = this.checkExpr(expr);
    if (!isBoolLike(type)) {
      this.addDiagnostic(`vela.sem.${kind}Condition`, `${kind} condition must be Bool, got ${typeToString(type)}; use a comparison (e.g. x != 0)`, expr.range);
    }
  }

  private checkAsm(stmt: AsmBlockNode): void {
    for (const binding of stmt.bindings) {
      binding.tags.forEach((tag, index) => {
        if (!ASM_TAG_NAMES.includes(tag as (typeof ASM_TAG_NAMES)[number])) {
          this.addDiagnostic("vela.sem.invalidAsmTag", `ASM binding tag must be 'in' or 'out', got '${tag}'`, binding.tagRanges[index] ?? binding.range, "use [[in]] for input bindings and [[out]] for output bindings");
        }
      });
      if (!ASM_REGISTER_NAMES.includes(binding.register as (typeof ASM_REGISTER_NAMES)[number])) {
        this.addDiagnostic("vela.sem.invalidAsmRegister", `ASM binding register must be R0..R9, got '${binding.register}'`, binding.registerRange, "use a concrete general-purpose register such as R0 or R1");
      }
      const symbol = this.lookup(binding.variable, new Set(["local", "param", "global", "field"]));
      if (!symbol) {
        this.undefined("ASM binding variable", binding.variable, binding.variableRange, this.visibleNames(new Set(["local", "param", "global", "field"])));
      } else {
        this.addReference(symbol, binding.variable, binding.variableRange, binding.direction === "out");
      }
    }
  }

  private checkExpr(expr: ExprNode, write = false): VelaType {
    let type: VelaType = UNKNOWN;
    switch (expr.kind) {
      case "IntLiteral":
        if (expr.value < 0 || expr.value > 0xffff) {
          this.addDiagnostic("vela.sem.integerOutOfRange", `integer literal ${expr.value} is outside the 16-bit range`, expr.range, "use a value between 0 and 65535");
        }
        type = expr.value <= 0x7fff ? I16 : U16;
        break;
      case "FloatLiteral":
        type = F16;
        break;
      case "StringLiteral":
        type = { kind: "ptr", inner: U8 };
        break;
      case "CharLiteral":
        if ((expr.value.codePointAt(0) ?? 0) > 0xff) {
          this.addDiagnostic("vela.sem.charOutOfRange", `char literal is outside the U8 range`, expr.range, "Char is U8; use a character with codepoint 0..255");
        }
        type = U8;
        break;
      case "BoolLiteral":
        type = BOOL;
        break;
      case "NullLiteral":
        type = NULL_PTR;
        break;
      case "IdentifierExpr": {
        const symbol = this.lookup(expr.name, new Set(["local", "param", "global", "field"]));
        if (!symbol) {
          const other = this.lookup(expr.name);
          if (other) {
            this.addDiagnostic("vela.sem.notAValue", `'${expr.name}' is a ${other.kind}, not a value`, expr.nameRange, "use variables, parameters, fields, or call functions with parentheses");
          } else {
            this.undefined("identifier", expr.name, expr.nameRange, this.visibleNames());
          }
          type = UNKNOWN;
        } else {
          this.addReference(symbol, expr.name, expr.nameRange, write);
          type = symbol.type;
        }
        break;
      }
      case "BinaryExpr":
        type = this.checkBinary(expr);
        break;
      case "UnaryExpr":
        type = this.checkUnary(expr, write);
        break;
      case "CallExpr":
        type = this.checkCall(expr);
        break;
      case "MethodCallExpr":
        type = this.checkMethodCall(expr);
        break;
      case "FieldAccessExpr":
        type = this.checkFieldAccess(expr, write);
        break;
      case "IndexExpr": {
        const objectType = this.checkExpr(expr.obj);
        const indexType = this.checkExpr(expr.index);
        if (objectType.kind !== "ptr") {
          this.addDiagnostic("vela.sem.indexNonPointer", `indexing requires a pointer, got ${typeToString(objectType)}`, expr.obj.range, "index only Ptr<T> values");
          type = UNKNOWN;
        } else if (objectType.inner.kind === "void") {
          this.addDiagnostic("vela.sem.indexVoidPointer", "cannot index Ptr<U0>", expr.obj.range, "cast the pointer to Ptr<T> with a concrete element type first");
          type = UNKNOWN;
        } else {
          type = objectType.inner;
        }
        if (!isInteger(indexType)) {
          this.addDiagnostic("vela.sem.pointerIndexType", `pointer index must be an integer, got ${typeToString(indexType)}`, expr.index.range);
        }
        break;
      }
      case "DerefExpr": {
        const operandType = this.checkExpr(expr.operand);
        if (operandType.kind !== "ptr") {
          this.addDiagnostic("vela.sem.derefNonPointer", `dereference requires a pointer, got ${typeToString(operandType)}`, expr.operand.range, "use '*' only on Ptr<T> values");
          type = UNKNOWN;
        } else if (operandType.inner.kind === "void") {
          this.addDiagnostic("vela.sem.derefVoidPointer", "cannot dereference Ptr<U0>", expr.operand.range, "cast the pointer to Ptr<T> with a concrete element type first");
          type = UNKNOWN;
        } else {
          type = operandType.inner;
        }
        break;
      }
      case "AddressOfExpr": {
        const operandType = this.checkExpr(expr.operand);
        const operand = expr.operand;
        if (operand.kind === "IdentifierExpr") {
          const symbol = this.lookup(operand.name);
          if (symbol && symbol.kind !== "global" && symbol.kind !== "field") {
            this.addDiagnostic("vela.sem.addressOfLocal", `cannot take address of local or parameter '${operand.name}'; only globals, fields, dereferences and indexed pointers are addressable`, expr.range);
          }
        } else if (!["DerefExpr", "FieldAccessExpr", "IndexExpr"].includes(operand.kind)) {
          this.addDiagnostic("vela.sem.addressOfNonAddressable", "address-of requires an addressable expression", expr.range);
        }
        type = { kind: "ptr", inner: operandType };
        break;
      }
      case "InitExpr":
        type = this.checkInit(expr);
        break;
      case "MallocExpr":
        type = this.checkMalloc(expr);
        break;
      case "SizeOfExpr":
        this.resolveType(expr.targetType);
        type = U16;
        break;
      case "CastExpr":
        type = this.checkCast(expr);
        break;
      case "MultiDispatchExpr":
        type = this.checkMultiDispatch(expr);
        break;
      case "MissingExpr":
        type = UNKNOWN;
        break;
    }
    expr.inferredType = type;
    this.expressionTypes.push({ range: expr.range, type });
    return type;
  }

  private checkBinary(expr: BinaryExprNode): VelaType {
    const left = this.checkExpr(expr.left);
    const right = this.checkExpr(expr.right);
    if (["==", "!=", "<", ">", "<=", ">="].includes(expr.op)) {
      this.checkComparison(expr.op, left, right, expr);
      return BOOL;
    }
    if (expr.op === "&&" || expr.op === "||") {
      if (!isBoolLike(left)) {
        this.addDiagnostic("vela.sem.logicalOperand", `left operand of '${expr.op}' must be Bool, got ${typeToString(left)}`, expr.left.range);
      }
      if (!isBoolLike(right)) {
        this.addDiagnostic("vela.sem.logicalOperand", `right operand of '${expr.op}' must be Bool, got ${typeToString(right)}`, expr.right.range);
      }
      return BOOL;
    }
    if (["+", "-", "*", "/", "%"].includes(expr.op)) {
      if (!isNumeric(left) || !isNumeric(right)) {
        this.addDiagnostic("vela.sem.arithmeticOperand", `operator '${expr.op}' requires numeric operands, got ${typeToString(left)} and ${typeToString(right)}`, expr.range, "use arithmetic only with integer or F16 values");
        return UNKNOWN;
      }
      if (expr.op === "%" && (isFloat(left) || isFloat(right))) {
        this.addDiagnostic("vela.sem.moduloFloat", "operator '%' requires integer operands", expr.range, "use '/' for F16 division; modulo is integer-only");
        return UNKNOWN;
      }
      const common = this.numericCommonType(left, right, expr.left, expr.right);
      if (!common) {
        this.addDiagnostic("vela.sem.incompatibleNumericOperands", `operator '${expr.op}' requires compatible numeric operands, got ${typeToString(left)} and ${typeToString(right)}`, expr.range, "use Cast<T>(expr) when signedness conversion is intentional");
        return UNKNOWN;
      }
      return common;
    }
    return left;
  }

  private checkUnary(expr: UnaryExprNode, write: boolean): VelaType {
    const operand = this.checkExpr(expr.operand, write || expr.op.startsWith("post"));
    if (expr.op === "!") {
      if (!isBoolLike(operand)) {
        this.addDiagnostic("vela.sem.notOperand", `operand of '!' must be Bool, got ${typeToString(operand)}`, expr.operand.range);
      }
      return BOOL;
    }
    if (expr.op === "post++" || expr.op === "post--") {
      if (!isLvalue(expr.operand)) {
        this.addDiagnostic("vela.sem.incrementTarget", `operator '${expr.op.slice(-2)}' requires an assignable target`, expr.operand.range, "use increment or decrement on variables, fields, dereferences, or indexed elements");
      }
      if (!isInteger(operand)) {
        this.addDiagnostic("vela.sem.incrementInteger", `operator '${expr.op.slice(-2)}' requires an integer target, got ${typeToString(operand)}`, expr.operand.range);
      }
      return operand;
    }
    if (expr.op === "-") {
      if (!isNumeric(operand)) {
        this.addDiagnostic("vela.sem.unaryMinus", `operator '-' requires a numeric operand, got ${typeToString(operand)}`, expr.operand.range);
      }
      const literal = intLiteralValue(expr);
      if (literal !== undefined && !intFits(literal, I16)) {
        this.addDiagnostic("vela.sem.integerOutOfRange", `integer literal ${literal} is outside the I16 range`, expr.range, "use a value between -32768 and 32767");
      }
      return literal !== undefined ? I16 : operand;
    }
    return operand;
  }

  private checkCall(expr: CallExprNode): VelaType {
    if (expr.callee.kind !== "IdentifierExpr") {
      this.addDiagnostic("vela.sem.nonIdentifierCall", "call target must be a function name", expr.callee.range);
      return UNKNOWN;
    }
    const symbol = this.lookup(expr.callee.name, new Set(["function"]));
    const argTypes = expr.args.map((arg) => this.checkExpr(arg));
    if (!symbol) {
      const other = this.lookup(expr.callee.name);
      if (other) {
        this.addDiagnostic("vela.sem.notFunction", `'${expr.callee.name}' is a ${other.kind}, not a function`, expr.callee.nameRange);
      } else {
        this.undefined("function", expr.callee.name, expr.callee.nameRange, this.visibleNames(new Set(["function"])));
      }
      return UNKNOWN;
    }
    this.addReference(symbol, expr.callee.name, expr.callee.nameRange);
    this.addCallEdge(symbol, expr.callee.nameRange);
    this.checkArity(symbol.name, symbol.params?.length ?? 0, expr.args.length, expr.range);
    this.checkArgumentTypes(symbol.name, symbol.params?.map((param) => param.type) ?? [], argTypes, expr.args);
    return symbol.returnType ?? symbol.type;
  }

  private checkMethodCall(expr: MethodCallExprNode): VelaType {
    const objectType = this.checkExpr(expr.obj);
    for (const arg of expr.args) {
      this.checkExpr(arg);
    }
    const actual = objectType.kind === "ptr" ? objectType.inner : objectType;
    const boxed = primitiveBoxedSuggestion(actual);
    if (boxed) {
      this.addDiagnostic("vela.sem.primitiveMethod", `primitive type '${typeToString(actual)}' has no methods; use the boxed type '${boxed}' instead`, expr.methodRange);
      return UNKNOWN;
    }
    if (actual.kind !== "class") {
      this.addDiagnostic("vela.sem.methodNonClass", `method call requires a class instance, got ${typeToString(objectType)}`, expr.obj.range, "use methods only on class values or Ptr<Class> values");
      return UNKNOWN;
    }
    const classSymbol = this.classSymbolForType(actual);
    const method = classSymbol ? this.findMethodDeclForClassSymbol(classSymbol, expr.method) : this.findMethodDecl(actual.name, expr.method);
    if (!method) {
      this.undefined("method", expr.method, expr.methodRange, this.classMethodNames(actual.name), `type '${actual.name}'`);
      return UNKNOWN;
    }
    const signature = this.signatureFor(method);
    const methodSymbol = classSymbol ? this.symbolForClassMethodSymbol(classSymbol, method.name) : this.symbolForClassMethod(actual.name, method.name);
    if (methodSymbol) {
      this.addReference(methodSymbol, expr.method, expr.methodRange);
      this.addCallEdge(methodSymbol, expr.methodRange);
    }
    const argTypes = expr.args.map((arg) => arg.inferredType ?? this.checkExpr(arg));
    this.checkArity(`${actual.name}.${expr.method}`, signature.params.length, expr.args.length, expr.range);
    this.checkArgumentTypes(`${actual.name}.${expr.method}`, signature.params.map((param) => param.type), argTypes, expr.args);
    return signature.returnType;
  }

  private checkFieldAccess(expr: FieldAccessExprNode, write: boolean): VelaType {
    const objectType = this.checkExpr(expr.obj);
    const actual = objectType.kind === "ptr" ? objectType.inner : objectType;
    const boxed = primitiveBoxedSuggestion(actual);
    if (boxed) {
      this.addDiagnostic("vela.sem.primitiveField", `primitive type '${typeToString(actual)}' has no fields; use the boxed type '${boxed}' instead`, expr.fieldRange);
      return UNKNOWN;
    }
    if (actual.kind !== "class") {
      this.addDiagnostic("vela.sem.fieldNonClass", `field access requires a class instance, got ${typeToString(objectType)}`, expr.obj.range, "use fields only on class values or Ptr<Class> values");
      return UNKNOWN;
    }
    const field = actual.fields.find((item) => item.name === expr.fieldName);
    if (!field) {
      this.undefined("field", expr.fieldName, expr.fieldRange, actual.fields.map((item) => item.name), `type '${actual.name}'`);
      return UNKNOWN;
    }
    const classSymbol = this.classSymbolForType(actual);
    const symbol = classSymbol ? this.symbolForClassFieldSymbol(classSymbol, field.name) : this.symbolForClassField(actual.name, field.name);
    if (symbol) {
      this.addReference(symbol, expr.fieldName, expr.fieldRange, write);
    }
    return field.type;
  }

  private checkInit(expr: InitExprNode): VelaType {
    const classSymbol = this.lookup(expr.className, new Set(["class"]));
    if (!classSymbol) {
      this.undefined("class", expr.className, expr.classNameRange, this.visibleNames(new Set(["class"])));
      return UNKNOWN;
    }
    const classType = classSymbol.decl?.kind === "ClassDecl"
      ? this.ensureClassType(expr.className, new Set(), classSymbol.decl)
      : this.ensureClassType(expr.className, new Set());
    if (classType.kind !== "class" || classSymbol.decl?.kind !== "ClassDecl") {
      this.undefined("class", expr.className, expr.classNameRange, this.visibleNames(new Set(["class"])));
      return UNKNOWN;
    }
    this.addReference(classSymbol, expr.className, expr.classNameRange);
    const onAlloc = this.symbolForClassMethodSymbol(classSymbol, "OnAlloc");
    if (onAlloc) {
      this.addCallEdge(onAlloc, expr.classNameRange);
    }
    const params = this.findMethodDeclForClassSymbol(classSymbol, "OnAlloc")?.params ?? [];
    this.checkArity(`Init<${expr.className}>`, params.length, expr.kwargs.length, expr.range);
    const expectedNames = params.map((param) => param.name);
    expr.kwargs.forEach((arg, index) => {
      const param = params[index];
      if (!param) {
        this.checkExpr(arg.value);
        return;
      }
      if (arg.name !== param.name) {
        this.addDiagnostic("vela.sem.initArgName", `argument ${index + 1} of Init<${expr.className}> is named '${arg.name}', expected '${param.name}'`, arg.nameRange, didYouMean(arg.name, expectedNames) ?? "Init<T> arguments are named but lowered in OnAlloc parameter order");
      }
      const actual = this.checkExpr(arg.value);
      const expected = this.resolveType(param.typeExpr);
      if (!this.argumentCompatible(expected, actual, arg.value)) {
        if (this.hasOutOfRangeLiteralForSameIntType(expected, actual, arg.value)) {
          return;
        }
        this.addDiagnostic("vela.sem.initArgType", `argument '${arg.name}' of Init<${expr.className}> expects ${typeToString(expected)}, got ${typeToString(actual)}`, arg.value.range);
      }
    });
    return { kind: "ptr", inner: classType };
  }

  private checkMalloc(expr: MallocExprNode): VelaType {
    const sizeType = this.checkExpr(expr.size);
    if (!isInteger(sizeType)) {
      this.addDiagnostic("vela.sem.mallocSize", `Malloc size must be an integer, got ${typeToString(sizeType)}`, expr.size.range, "pass the allocation size in bytes as an integer expression");
    }
    const literal = intLiteralValue(expr.size);
    if (literal !== undefined && literal < 0) {
      this.addDiagnostic("vela.sem.mallocNegative", `Malloc size must be non-negative, got ${literal}`, expr.size.range);
    }
    return NULL_PTR;
  }

  private checkCast(expr: CastExprNode): VelaType {
    const source = this.checkExpr(expr.operand);
    const target = this.resolveType(expr.targetType);
    if (source.kind === "float" !== (target.kind === "float")) {
      this.addDiagnostic("vela.sem.floatCast", `cannot cast ${typeToString(source)} to ${typeToString(target)}`, expr.range, "integer and pointer conversions to or from F16 are not supported by the CPU backend");
    }
    return target;
  }

  private checkMultiDispatch(expr: MultiDispatchExprNode): VelaType {
    const argTypes = expr.args.map((arg) => this.checkExpr(arg));
    for (const target of expr.targets) {
      const targetType = this.checkExpr(target);
      const actual = targetType.kind === "ptr" ? targetType.inner : targetType;
      if (actual.kind !== "class") {
        this.addDiagnostic("vela.sem.multiDispatchTarget", `multi-dispatch target must be a class instance, got ${typeToString(targetType)}`, target.range);
        continue;
      }
      const classSymbol = this.classSymbolForType(actual);
      const method = classSymbol ? this.findMethodDeclForClassSymbol(classSymbol, expr.method) : this.findMethodDecl(actual.name, expr.method);
      if (!method) {
        this.undefined("method", expr.method, expr.methodRange, this.classMethodNames(actual.name), `type '${actual.name}'`);
        continue;
      }
      const signature = this.signatureFor(method);
      const methodSymbol = classSymbol ? this.symbolForClassMethodSymbol(classSymbol, method.name) : this.symbolForClassMethod(actual.name, method.name);
      if (methodSymbol) {
        this.addReference(methodSymbol, expr.method, expr.methodRange);
        this.addCallEdge(methodSymbol, expr.methodRange);
      }
      this.checkArity(`${actual.name}.${expr.method}`, signature.params.length, expr.args.length, expr.range);
      this.checkArgumentTypes(`${actual.name}.${expr.method}`, signature.params.map((param) => param.type), argTypes, expr.args);
    }
    return U0;
  }

  private resolveType(typeExpr: TypeExprNode | undefined): VelaType {
    if (!typeExpr) {
      return U0;
    }
    if (typeExpr.kind === "MissingType") {
      return UNKNOWN;
    }
    if (typeExpr.kind === "NamedType") {
      const primitive = PRIMITIVE_TYPES[typeExpr.name];
      if (primitive) {
        return primitive;
      }
      const symbol = this.lookup(typeExpr.name, new Set(["alias", "class", "type"]));
      if (symbol) {
        this.addReference(symbol, typeExpr.name, typeExpr.nameRange);
        if (symbol.kind === "alias") {
          return symbol.type;
        }
        if (symbol.kind === "class") {
          const classType = symbol.decl?.kind === "ClassDecl"
            ? this.ensureClassType(typeExpr.name, new Set(), symbol.decl)
            : this.ensureClassType(typeExpr.name, new Set());
          return { kind: "ptr", inner: classType };
        }
        if (symbol.kind === "type") {
          return symbol.type;
        }
      }
      if (!this.currentModule && this.classDecls.has(typeExpr.name)) {
        return { kind: "ptr", inner: this.ensureClassType(typeExpr.name, new Set()) };
      }
      if (!this.currentModule && this.typeDecls.has(typeExpr.name)) {
        const decl = this.typeDecls.get(typeExpr.name)!;
        return { kind: "interface", name: decl.name, methods: decl.methods.map((method) => method.name) };
      }
      this.addDiagnostic("vela.sem.unknownType", `unknown type '${typeExpr.name}'`, typeExpr.nameRange, didYouMean(typeExpr.name, this.typeCandidateNames()) ?? "use a primitive type, class name, type declaration, alias, or Ptr<T>");
      return { kind: "unknown", name: typeExpr.name };
    }
    if (typeExpr.kind === "PtrType") {
      let inner = this.resolveType(typeExpr.inner);
      if (inner.kind === "ptr" && inner.inner.kind === "class") {
        inner = inner.inner;
      }
      return { kind: "ptr", inner };
    }
    return UNKNOWN;
  }

  private signatureFor(fn: FunctionDeclNode): FunctionSignature {
    const returnType = this.resolveType(fn.returnType);
    const params = fn.params.map((param) => ({
      name: param.name,
      type: this.resolveType(param.typeExpr),
      range: param.nameRange,
    }));
    return {
      name: fn.name,
      returnType,
      params,
      decl: fn,
      symbol: makeLocalSymbol(fn.name, "function", returnType, fn.nameRange, this.parse.uri),
    };
  }

  private checkSignatureValueTypes(fn: FunctionDeclNode): void {
    for (const param of fn.params) {
      this.checkValueStorageType(this.resolveType(param.typeExpr), `parameter '${param.name}'`, param.nameRange);
    }
  }

  private checkValueStorageType(type: VelaType, subject: string, range: VelaRange): void {
    if (type.kind === "void") {
      this.addDiagnostic("vela.sem.voidStorage", `${subject} cannot have type U0`, range, "use U0 only as a function return type or inside Ptr<U0>");
    }
  }

  private checkInitializerCompatible(target: VelaType, source: VelaType, expr: ExprNode): void {
    if (this.initializerCompatible(target, source, expr)) {
      return;
    }
    if (this.hasOutOfRangeLiteralForSameIntType(target, source, expr)) {
      return;
    }
    this.addDiagnostic("vela.sem.incompatibleInitializer", `cannot initialise ${typeToString(target)} from ${typeToString(source)}`, expr.range, "use Cast<T>(expr) only when the conversion is intentional");
  }

  private initializerCompatible(target: VelaType, source: VelaType, expr: ExprNode): boolean {
    if (this.argumentCompatible(target, source, expr)) {
      return true;
    }
    if (isBoolLike(target)) {
      return isBoolLike(source) || this.typesCompatible(target, source);
    }
    if (source.kind === "bool") {
      return isBoolLike(target);
    }
    if (!(target.kind === "ptr" && target.inner.kind === "class" && source.kind !== "ptr")) {
      return false;
    }
    const cls = this.classDeclForName(target.inner.name);
    const first = cls?.onAlloc?.params[0];
    return !!first && this.argumentCompatible(this.resolveType(first.typeExpr), source, expr);
  }

  private isStaticGlobalInitializer(target: VelaType, expr: ExprNode): boolean {
    if (target.kind === "int") {
      return intLiteralValue(expr) !== undefined || expr.kind === "CharLiteral";
    }
    if (target.kind === "float") {
      return floatLiteralValue(expr) !== undefined;
    }
    if (target.kind === "ptr") {
      return expr.kind === "NullLiteral";
    }
    return false;
  }

  private argumentCompatible(expected: VelaType, actual: VelaType, expr: ExprNode): boolean {
    const literal = intLiteralValue(expr);
    if (expected.kind === "int" && actual.kind === "int" && literal !== undefined) {
      return intFits(literal, expected);
    }
    return this.typesCompatible(expected, actual);
  }

  private typesCompatible(target: VelaType, source: VelaType): boolean {
    if (target.kind === "unknown" || source.kind === "unknown") {
      return true;
    }
    if (this.typeEquals(target, source)) {
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
      return this.typeEquals(target.inner, source.inner);
    }
    return false;
  }

  private typeEquals(left: VelaType, right: VelaType): boolean {
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
        return right.kind === "ptr" && this.typeEquals(left.inner, right.inner);
      case "class": {
        if (right.kind !== "class" || left.name !== right.name) {
          return false;
        }
        const leftSymbol = this.classTypeSymbols.get(left);
        const rightSymbol = this.classTypeSymbols.get(right);
        return !leftSymbol || !rightSymbol ? true : leftSymbol.id === rightSymbol.id;
      }
      case "interface":
        return right.kind === "interface" && left.name === right.name;
      case "unknown":
        return right.kind === "unknown";
    }
  }

  private sameSignature(left: FunctionSignature, right: FunctionSignature): boolean {
    return this.typeEquals(left.returnType, right.returnType)
      && left.params.length === right.params.length
      && left.params.every((param, index) => this.typeEquals(param.type, right.params[index]!.type));
  }

  private hasOutOfRangeLiteralForSameIntType(expected: VelaType, actual: VelaType, expr: ExprNode): boolean {
    const literal = intLiteralValue(expr);
    return literal !== undefined
      && expected.kind === "int"
      && actual.kind === "int"
      && this.typeEquals(expected, actual)
      && !intFits(literal, expected);
  }

  private numericCommonType(left: VelaType, right: VelaType, leftExpr: ExprNode, rightExpr: ExprNode): VelaType | undefined {
    if (left.kind === "float" && right.kind === "float") {
      return F16;
    }
    if (left.kind === "float" || right.kind === "float") {
      return undefined;
    }
    if (left.kind === "int" && right.kind === "int") {
      if (this.argumentCompatible(left, right, rightExpr)) {
        return left;
      }
      if (this.argumentCompatible(right, left, leftExpr)) {
        return right;
      }
    }
    return undefined;
  }

  private checkComparison(op: string, left: VelaType, right: VelaType, expr: BinaryExprNode): void {
    if (["<", ">", "<=", ">="].includes(op)) {
      if (isNumeric(left) && isNumeric(right)) {
        if (!this.numericCommonType(left, right, expr.left, expr.right)) {
          this.addDiagnostic("vela.sem.comparisonOperands", `operator '${op}' requires compatible numeric operands, got ${typeToString(left)} and ${typeToString(right)}`, expr.range);
        }
      } else {
        this.addDiagnostic("vela.sem.comparisonOperands", `operator '${op}' requires numeric operands, got ${typeToString(left)} and ${typeToString(right)}`, expr.range, "ordered comparisons are only defined for integer and F16 values");
      }
      return;
    }
    if (isBoolLike(left) || isBoolLike(right)) {
      if (!isBoolLike(left) || !isBoolLike(right)) {
        this.addDiagnostic("vela.sem.equalityOperands", `operator '${op}' requires compatible operands, got ${typeToString(left)} and ${typeToString(right)}`, expr.range, "Bool values only compare with Bool values");
      }
      return;
    }
    if (isNumeric(left) && isNumeric(right)) {
      if (!this.numericCommonType(left, right, expr.left, expr.right)) {
        this.addDiagnostic("vela.sem.equalityOperands", `operator '${op}' requires compatible operands, got ${typeToString(left)} and ${typeToString(right)}`, expr.range);
      }
      return;
    }
    if (!this.argumentCompatible(left, right, expr.right) && !this.argumentCompatible(right, left, expr.left)) {
      this.addDiagnostic("vela.sem.equalityOperands", `operator '${op}' requires compatible operands, got ${typeToString(left)} and ${typeToString(right)}`, expr.range);
    }
  }

  private checkArity(name: string, expected: number, actual: number, range: VelaRange): void {
    if (expected === actual) {
      return;
    }
    this.addDiagnostic("vela.sem.arity", `${name} expects ${expected} ${expected === 1 ? "argument" : "arguments"}, got ${actual}`, range, "adjust the argument list to match the declaration");
  }

  private checkArgumentTypes(name: string, expected: VelaType[], actual: VelaType[], args: ExprNode[]): void {
    expected.forEach((expectedType, index) => {
      const actualType = actual[index];
      const arg = args[index];
      if (!actualType || !arg || this.argumentCompatible(expectedType, actualType, arg)) {
        return;
      }
      if (this.hasOutOfRangeLiteralForSameIntType(expectedType, actualType, arg)) {
        return;
      }
      this.addDiagnostic("vela.sem.argumentType", `argument ${index + 1} of ${name} expects ${typeToString(expectedType)}, got ${typeToString(actualType)}`, arg.range, "use Cast<T>(expr) only when the conversion is intentional");
    });
  }

  private blockAlwaysReturns(stmts: StmtNode[]): boolean {
    return stmts.some((stmt) => this.stmtAlwaysReturns(stmt));
  }

  private stmtAlwaysReturns(stmt: StmtNode): boolean {
    if (stmt.kind === "ReturnStmt") {
      return true;
    }
    if (stmt.kind === "IfStmt") {
      return stmt.thenBody.length > 0 && stmt.elseBody.length > 0 && this.blockAlwaysReturns(stmt.thenBody) && this.blockAlwaysReturns(stmt.elseBody);
    }
    if (stmt.kind === "WhileStmt") {
      return stmt.condition.kind === "BoolLiteral" && stmt.condition.value && this.blockAlwaysReturns(stmt.body);
    }
    if (stmt.kind === "ForStmt") {
      return (!stmt.condition || (stmt.condition.kind === "BoolLiteral" && stmt.condition.value)) && this.blockAlwaysReturns(stmt.body);
    }
    if (stmt.kind === "BlockStmt") {
      return this.blockAlwaysReturns(stmt.body);
    }
    return false;
  }

  private checkMain(module: ModuleDeclNode): void {
    const hasMainFunction = module.body.some((node) => node.kind === "FunctionDecl" && node.name === "main");
    if (!hasMainFunction) {
      this.addDiagnostic("vela.sem.missingMain", `module '${module.name}' has no top-level main function`, module.nameRange, "set vela.requireMainDiagnostic to off or currentFile/workspaceEntry according to project role");
    }
  }

  private collectClassFields(className: string): ClassFieldInfo[] {
    const type = this.ensureClassType(className, new Set());
    return type.kind === "class" ? type.fields : [];
  }

  private classDeclForName(className: string): ClassDeclNode | undefined {
    return (this.currentModule ? this.classDeclsByModule.get(classDeclKey(this.currentModule.name, className)) : undefined)
      ?? this.classDecls.get(className);
  }

  private classSymbolForDecl(cls: ClassDeclNode): VelaSymbol | undefined {
    return this.symbols.find((symbol) => symbol.kind === "class" && symbol.decl === cls);
  }

  private classSymbolForType(type: VelaType): VelaSymbol | undefined {
    return type.kind === "class" ? this.classTypeSymbols.get(type) : undefined;
  }

  private classTypeKey(cls: ClassDeclNode): string {
    const module = this.classModules.get(cls);
    return module ? classDeclKey(module.name, cls.name) : cls.name;
  }

  private parentSymbolForClassDecl(cls: ClassDeclNode, kinds: Set<string> = new Set(["class", "type"])): VelaSymbol | undefined {
    const parentName = this.effectiveClassParent(cls);
    if (!parentName) {
      return undefined;
    }
    const module = this.classModules.get(cls);
    const scope = module ? this.moduleScopes.get(module) : undefined;
    if (scope) {
      return this.lookupInScope(scope, parentName, kinds);
    }
    return this.symbols.find((symbol) => kinds.has(symbol.kind) && symbol.name === parentName);
  }

  private findMethodDeclForClassSymbol(classSymbol: VelaSymbol, methodName: string): FunctionDeclNode | undefined {
    if (classSymbol.decl?.kind !== "ClassDecl") {
      return this.findMethodDecl(classSymbol.name, methodName);
    }
    return this.findMethodDeclForClassDecl(classSymbol.decl, methodName, new Set());
  }

  private findMethodDeclForClassDecl(cls: ClassDeclNode, methodName: string, seen: Set<string>): FunctionDeclNode | undefined {
    const key = this.classTypeKey(cls);
    if (seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    if (methodName === "OnAlloc" && cls.onAlloc) {
      return cls.onAlloc;
    }
    if (methodName === "OnFree" && cls.onFree) {
      return cls.onFree;
    }
    const method = cls.methods.find((item) => item.name === methodName);
    if (method) {
      return method;
    }
    const parent = this.parentSymbolForClassDecl(cls, new Set(["class"]));
    return parent?.decl?.kind === "ClassDecl" ? this.findMethodDeclForClassDecl(parent.decl, methodName, seen) : undefined;
  }

  private symbolForClassMethodSymbol(classSymbol: VelaSymbol, methodName: string): VelaSymbol | undefined {
    const direct = this.symbols.find((symbol) =>
      symbol.kind === "method"
      && symbol.className === classSymbol.name
      && symbol.uri === classSymbol.uri
      && symbol.moduleName === classSymbol.moduleName
      && symbol.name === methodName);
    if (direct) {
      return direct;
    }
    if (classSymbol.decl?.kind !== "ClassDecl") {
      return this.symbolForClassMethod(classSymbol.name, methodName);
    }
    const parent = this.parentSymbolForClassDecl(classSymbol.decl, new Set(["class"]));
    return parent ? this.symbolForClassMethodSymbol(parent, methodName) : undefined;
  }

  private symbolForClassFieldSymbol(classSymbol: VelaSymbol, fieldName: string): VelaSymbol | undefined {
    const direct = this.symbols.find((symbol) =>
      symbol.kind === "field"
      && symbol.className === classSymbol.name
      && symbol.uri === classSymbol.uri
      && symbol.moduleName === classSymbol.moduleName
      && symbol.name === fieldName);
    if (direct) {
      return direct;
    }
    if (classSymbol.decl?.kind !== "ClassDecl") {
      return this.symbolForClassField(classSymbol.name, fieldName);
    }
    const parent = this.parentSymbolForClassDecl(classSymbol.decl, new Set(["class"]));
    return parent ? this.symbolForClassFieldSymbol(parent, fieldName) : undefined;
  }

  private effectiveClassParent(cls: ClassDeclNode | undefined): string | undefined {
    if (!cls) {
      return undefined;
    }
    if (cls.parent) {
      return this.parentVisibleForClass(cls, cls.parent) ? cls.parent : undefined;
    }
    return cls.name !== "Storeable" && this.storeableVisibleForClass(cls) ? "Storeable" : undefined;
  }

  private parentVisibleForClass(cls: ClassDeclNode, parentName: string): boolean {
    const module = this.classModules.get(cls);
    const scope = module ? this.moduleScopes.get(module) : undefined;
    if (!scope) {
      return true;
    }
    return !!this.lookupInScope(scope, parentName, new Set(["class", "type"]));
  }

  private storeableVisibleForClass(cls: ClassDeclNode): boolean {
    const module = this.classModules.get(cls);
    const scope = module ? this.moduleScopes.get(module) : undefined;
    if (!scope) {
      return this.classDecls.has("Storeable");
    }
    return !!this.lookupInScope(scope, "Storeable", new Set(["class"]));
  }

  private findMethodDecl(className: string, methodName: string): FunctionDeclNode | undefined {
    let cls = this.classDeclForName(className);
    while (cls) {
      if (methodName === "OnAlloc" && cls.onAlloc) {
        return cls.onAlloc;
      }
      if (methodName === "OnFree" && cls.onFree) {
        return cls.onFree;
      }
      const method = cls.methods.find((item) => item.name === methodName);
      if (method) {
        return method;
      }
      const parent = this.effectiveClassParent(cls);
      cls = parent ? this.classDeclForName(parent) : undefined;
    }
    return undefined;
  }

  private classMethodNames(className: string): string[] {
    const names: string[] = [];
    let cls = this.classDeclForName(className);
    while (cls) {
      if (cls.onAlloc) {
        names.push(cls.onAlloc.name);
      }
      if (cls.onFree) {
        names.push(cls.onFree.name);
      }
      names.push(...cls.methods.map((method) => method.name));
      const parent = this.effectiveClassParent(cls);
      cls = parent ? this.classDeclForName(parent) : undefined;
    }
    return names;
  }

  private symbolForClassMethod(className: string, methodName: string): VelaSymbol | undefined {
    const direct = this.currentModule
      ? this.symbols.find((symbol) => symbol.kind === "method" && symbol.className === className && symbol.name === methodName && symbol.moduleName === this.currentModule?.name)
      : undefined;
    const fallback = direct ?? this.symbols.find((symbol) => symbol.kind === "method" && symbol.className === className && symbol.name === methodName);
    if (fallback) {
      return fallback;
    }
    const cls = this.classDeclForName(className);
    const parent = this.effectiveClassParent(cls);
    if (!parent) {
      return undefined;
    }
    return this.symbolForClassMethod(parent, methodName);
  }

  private symbolForClassField(className: string, fieldName: string): VelaSymbol | undefined {
    const direct = this.currentModule
      ? this.symbols.find((symbol) => symbol.kind === "field" && symbol.className === className && symbol.name === fieldName && symbol.moduleName === this.currentModule?.name)
      : undefined;
    const fallback = direct ?? this.symbols.find((symbol) => symbol.kind === "field" && symbol.className === className && symbol.name === fieldName);
    if (fallback) {
      return fallback;
    }
    const cls = this.classDeclForName(className);
    const parent = this.effectiveClassParent(cls);
    if (!parent) {
      return undefined;
    }
    return this.symbolForClassField(parent, fieldName);
  }

  private addModuleSymbol(module: ModuleDeclNode): void {
    const uri = this.env.moduleUri(module) ?? this.parse.uri;
    this.addSymbol({
      id: topLevelId(uri, module.name, "module", module.name),
      name: module.name,
      kind: "module",
      type: UNKNOWN,
      uri,
      range: module.range,
      selectionRange: module.nameRange,
      moduleName: module.name,
      defaultLibrary: this.env.isDefaultLibraryUri(uri),
      decl: module as never,
    });
  }

  private syntheticClassSymbol(cls: ClassDeclNode, name: string, type: VelaType): VelaSymbol {
    const module = this.classModules.get(cls);
    const uri = (module ? this.env.moduleUri(module) : undefined) ?? this.parse.uri;
    return this.addSymbol({
      ...makeLocalSymbol(name, "param", type, cls.nameRange, uri),
      moduleName: module?.name ?? this.currentModule?.name,
      className: cls.name,
      generated: true,
      decl: cls,
    });
  }

  private addSymbol(symbol: VelaSymbol): VelaSymbol {
    symbol.documentation = this.env.documentationFor(symbol);
    if (!this.symbols.some((existing) => existing.id === symbol.id)) {
      this.symbols.push(symbol);
    }
    return symbol;
  }

  private define(name: string, symbol: VelaSymbol, imported = false): void {
    if (!imported) {
      this.currentScope.symbols.set(name, symbol);
      return;
    }
    if (!this.currentScope.symbols.has(name)) {
      this.currentScope.symbols.set(name, symbol);
    }
  }

  private lookup(name: string, kinds?: Set<string>): VelaSymbol | undefined {
    return this.lookupInScope(this.currentScope, name, kinds);
  }

  private lookupInScope(start: Scope, name: string, kinds?: Set<string>): VelaSymbol | undefined {
    let scope: Scope | undefined = start;
    while (scope) {
      const symbol = scope.symbols.get(name);
      if (symbol && (!kinds || kinds.has(symbol.kind))) {
        return symbol;
      }
      scope = scope.parent;
    }
    return undefined;
  }

  private visibleNames(kinds?: Set<string>): string[] {
    const names = new Set<string>();
    let scope: Scope | undefined = this.currentScope;
    while (scope) {
      for (const [name, symbol] of scope.symbols) {
        if (!kinds || kinds.has(symbol.kind)) {
          names.add(name);
        }
      }
      scope = scope.parent;
    }
    return [...names];
  }

  private typeCandidateNames(): string[] {
    if (this.currentModule) {
      return [
        ...Object.keys(PRIMITIVE_TYPES),
        "Ptr",
        ...this.visibleNames(new Set(["alias", "class", "type"])),
      ];
    }
    return [
      ...Object.keys(PRIMITIVE_TYPES),
      "Ptr",
      ...this.aliases.keys(),
      ...this.classDecls.keys(),
      ...this.typeDecls.keys(),
    ];
  }

  private inheritableTypeNames(): string[] {
    if (this.currentModule) {
      return this.visibleNames(new Set(["class", "type"]));
    }
    return [
      ...this.classDecls.keys(),
      ...this.typeDecls.keys(),
    ];
  }

  private pushScope(name: string): void {
    this.currentScope = { name, parent: this.currentScope, symbols: new Map() };
  }

  private popScope(): void {
    if (this.currentScope.parent) {
      this.currentScope = this.currentScope.parent;
    }
  }

  private addReference(symbol: VelaSymbol, name: string, range: VelaRange, write = false): void {
    this.references.push({
      symbolId: symbol.id,
      name,
      range,
      uri: range.uri,
      write,
    });
  }

  private addCallEdge(to: VelaSymbol, range: VelaRange): void {
    if (!this.currentFunctionSymbol) {
      return;
    }
    this.callEdges.push({ from: this.currentFunctionSymbol, to, range });
  }

  private undefined(kind: string, name: string, range: VelaRange, candidates: Iterable<string>, owner?: string): void {
    const subject = `${kind} '${name}'`;
    const message = owner ? `${owner} has no ${subject}` : `undefined ${subject}`;
    this.addDiagnostic("vela.sem.unknownIdentifier", message, range, didYouMean(name, candidates) ?? "check the spelling, declaration order, and imports");
  }

  private addDiagnostic(code: string, message: string, range: VelaRange, hint?: string, related?: { message: string; range: VelaRange }[]): void {
    this.diagnostics.push({
      code,
      message,
      severity: DiagnosticSeverity.Error,
      range,
      hint,
      related,
      source: "vela-lsp",
    });
  }

  private isBuiltinStoreable(module: ModuleDeclNode): boolean {
    const uri = this.env.moduleUri(module) ?? this.parse.uri;
    return module.name === "storeable" && uri.replaceAll("\\", "/").endsWith("stdlib/core/storeable.vl");
  }
}

function hasName(node: DeclNode): node is AliasDeclNode | VarDeclNode | FunctionDeclNode | ClassDeclNode | TypeDeclNode {
  return ["AliasDecl", "VarDecl", "FunctionDecl", "ClassDecl", "TypeDecl"].includes(node.kind);
}

function declKindDescription(node: AliasDeclNode | VarDeclNode | FunctionDeclNode | ClassDeclNode | TypeDeclNode): string {
  if (node.kind === "AliasDecl") {
    return `alias '${node.name}'`;
  }
  if (node.kind === "VarDecl") {
    return `variable '${node.name}'`;
  }
  if (node.kind === "FunctionDecl") {
    return `function '${node.name}'`;
  }
  if (node.kind === "ClassDecl") {
    return `class '${node.name}'`;
  }
  return `type '${node.name}'`;
}

function sameIncludedEntry(left: IncludedEntry, right: IncludedEntry): boolean {
  return left.moduleKey === right.moduleKey && left.description === right.description;
}

function formatImport(imp: ImportDeclNode): string {
  return `${imp.package.join("::")}::{${imp.modules.join(", ")}}`;
}

function importPackageRelatedInfo(imp: ImportDeclNode): { message: string; range: VelaRange }[] | undefined {
  const range = imp.packageRanges[0] && imp.packageRanges.at(-1)
    ? { ...imp.packageRanges[0], end: imp.packageRanges.at(-1)!.end }
    : undefined;
  return range ? [{ message: "import package path", range }] : undefined;
}

function pascal(prefix: string, fieldName: string): string {
  return `${prefix}${fieldName.charAt(0).toUpperCase()}${fieldName.slice(1)}`;
}

function makeGeneratedGetter(field: VarDeclNode, name: string): FunctionDeclNode {
  return {
    kind: "FunctionDecl",
    returnType: field.typeExpr,
    name,
    nameRange: field.nameRange,
    params: [],
    body: [
      {
        kind: "ReturnStmt",
        value: {
          kind: "FieldAccessExpr",
          obj: {
            kind: "IdentifierExpr",
            name: "this",
            nameRange: field.nameRange,
            range: field.nameRange,
          },
          fieldName: field.name,
          fieldRange: field.nameRange,
          range: field.nameRange,
        },
        range: field.range,
      },
    ],
    isSkeleton: false,
    generated: true,
    range: field.range,
  };
}

function makeGeneratedSetter(field: VarDeclNode, name: string): FunctionDeclNode {
  return {
    kind: "FunctionDecl",
    returnType: { kind: "NamedType", name: "U0", nameRange: field.nameRange, range: field.nameRange },
    name,
    nameRange: field.nameRange,
    params: [
      {
        kind: "ParamDecl",
        typeExpr: field.typeExpr,
        name: "value",
        nameRange: field.nameRange,
        range: field.range,
      },
    ],
    body: [
      {
        kind: "Assignment",
        target: {
          kind: "FieldAccessExpr",
          obj: {
            kind: "IdentifierExpr",
            name: "this",
            nameRange: field.nameRange,
            range: field.nameRange,
          },
          fieldName: field.name,
          fieldRange: field.nameRange,
          range: field.nameRange,
        },
        value: {
          kind: "IdentifierExpr",
          name: "value",
          nameRange: field.nameRange,
          range: field.nameRange,
        },
        op: "=",
        range: field.range,
      },
    ],
    isSkeleton: false,
    generated: true,
    range: field.range,
  };
}

function isLvalue(expr: ExprNode): boolean {
  return ["IdentifierExpr", "FieldAccessExpr", "DerefExpr", "IndexExpr"].includes(expr.kind);
}

function primitiveBoxedSuggestion(type: VelaType): string | undefined {
  if (type.kind === "int" || type.kind === "float" || type.kind === "bool") {
    return PRIMITIVE_TO_BOXED[typeToString(type)];
  }
  return undefined;
}

function intLiteralValue(expr: ExprNode): number | undefined {
  if (expr.kind === "IntLiteral") {
    return expr.value;
  }
  if (expr.kind === "CharLiteral") {
    return expr.value.codePointAt(0) ?? 0;
  }
  if (expr.kind === "UnaryExpr" && expr.op === "-" && expr.operand.kind === "IntLiteral") {
    return -expr.operand.value;
  }
  return undefined;
}

function floatLiteralValue(expr: ExprNode): number | undefined {
  if (expr.kind === "FloatLiteral") {
    return expr.value;
  }
  if (expr.kind === "UnaryExpr" && expr.op === "-" && expr.operand.kind === "FloatLiteral") {
    return -expr.operand.value;
  }
  return undefined;
}

function intFits(value: number, type: VelaType): boolean {
  if (type.kind !== "int") {
    return false;
  }
  const low = type.signed ? -(1 << (type.bits - 1)) : 0;
  const high = type.signed ? (1 << (type.bits - 1)) - 1 : (1 << type.bits) - 1;
  return low <= value && value <= high;
}

function assemblyLabelsFor(node: DeclNode): { name: string; description: string; range: VelaRange }[] {
  if (node.kind === "FunctionDecl" && !node.isSkeleton) {
    return [{ name: node.name, description: `function '${node.name}'`, range: node.nameRange }];
  }
  if (node.kind === "VarDecl") {
    return [{ name: node.name, description: `global variable '${node.name}'`, range: node.nameRange }];
  }
  if (node.kind !== "ClassDecl") {
    return [];
  }
  const labels = [
    { name: `__vtable_${node.name}`, description: `vtable for class '${node.name}'`, range: node.nameRange },
    { name: `${node.name}_OnFree`, description: `OnFree slot for class '${node.name}'`, range: node.onFree?.nameRange ?? node.nameRange },
  ];
  if (node.onAlloc && !node.onAlloc.isSkeleton) {
    labels.push({ name: `${node.name}_OnAlloc`, description: `OnAlloc for class '${node.name}'`, range: node.onAlloc.nameRange });
  }
  for (const method of node.methods) {
    if (!method.isSkeleton) {
      labels.push({ name: `${node.name}_${method.name}`, description: `method '${node.name}.${method.name}'`, range: method.nameRange });
    }
  }
  return labels;
}

function topLevelId(uri: string, moduleName: string, kind: string, name: string): string {
  return `${uri}#${moduleName}.${kind}.${name}`;
}

function classDeclKey(moduleName: string, className: string): string {
  return `${moduleName}.${className}`;
}

function memberId(uri: string, className: string, kind: string, name: string, moduleName?: string): string {
  return `${uri}#${className}.${kind}.${name}${moduleName ? `@${moduleName}` : ""}`;
}

function localId(uri: string, owner: string, kind: string, name: string, offset: number): string {
  return `${uri}#${owner}.${kind}.${name}@${offset}`;
}

function makeLocalSymbol(name: string, kind: VelaSymbol["kind"], type: VelaType, range: VelaRange, uri: string): VelaSymbol {
  return {
    id: localId(uri, "<generated>", kind, name, range.start.offset),
    name,
    kind,
    type,
    uri,
    range,
    selectionRange: range,
  };
}

function didYouMean(name: string, candidates: Iterable<string>): string | undefined {
  const candidate = closestName(name, candidates);
  return candidate ? `did you mean '${candidate}'?` : undefined;
}

function closestName(name: string, candidates: Iterable<string>): string | undefined {
  const unique = [...new Set([...candidates].filter(Boolean))].sort();
  const threshold = Math.max(2, Math.floor(name.length / 3));
  let best: { distance: number; candidate: string } | undefined;
  for (const candidate of unique) {
    const distance = levenshtein(name.toLowerCase(), candidate.toLowerCase());
    if (distance > threshold) {
      continue;
    }
    if (!best || distance < best.distance || (distance === best.distance && candidate < best.candidate)) {
      best = { distance, candidate };
    }
  }
  return best?.candidate;
}

function levenshtein(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (!left) {
    return right.length;
  }
  if (!right) {
    return left.length;
  }
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[right.length]!;
}
