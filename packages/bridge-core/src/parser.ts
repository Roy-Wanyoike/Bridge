/**
 * Recursive-descent parser for the Bridge IDL.
 *
 * The parser never throws: every syntax error produces a diagnostic and
 * parsing recovers (skipping to the next line, brace or declaration
 * boundary) so a single pass reports as many errors as possible. The
 * resulting AST is best-effort: failed constructs carry error placeholders
 * that later stages know to ignore. Recursion is bounded — type expressions
 * deeper than {@link MAX_TYPE_DEPTH} report "type nesting too deep" (BR1005)
 * instead of exhausting the call stack.
 *
 * Grammar (v1):
 * ```
 * file      := doc* packageDecl doc* importDecl* decl*
 * package   := 'package' dottedName
 * import    := 'import' dottedName
 * decl      := struct | enum | union | alias | service | event
 * struct    := 'type' NAME headerModifiers? '{' field* '}'
 * enum      := 'enum' NAME headerModifiers? '{' (variant)* '}'
 * union     := 'union' NAME headerModifiers? '{' field* '}'
 * alias     := 'alias' NAME headerModifiers? '=' type
 * service   := 'service' NAME '{' method* '}'
 * event     := 'event' NAME '{' field* '}'
 * field     := doc* NAME '?'? ':' type '?'? constraint* ('=' default)?
 * variant   := doc* NAME '@deprecated'?
 * method    := doc* NAME '(' type ')' '->' type '@deprecated'?
 * type      := 'list' '<' type '>' | 'set' '<' type '>' | 'map' '<' type ',' type '>'
 *            | primitive | dottedName '?'?
 * ```
 * Fields and variants are newline-separated: commas and semicolons are not
 * part of the grammar and produce errors with actionable hints.
 */

import type { Diagnostic } from './ir/types';
import type { PrimitiveKind } from './ir/types';
import type { Token } from './lexer';
import {
  CONSTRAINT_KINDS,
  PRIMITIVE_SET,
  type AliasDeclNode,
  type BridgeFileNode,
  type ConstraintArgNode,
  type ConstraintNode,
  type EnumDeclNode,
  type EventDeclNode,
  type FieldNode,
  type ImportDeclNode,
  type MethodNode,
  type PackageDeclNode,
  type ServiceDeclNode,
  type StructDeclNode,
  type TypeNode,
  type UnionDeclNode,
  type DefaultValueNode,
  type VariantNode,
} from './ast';

/** Syntax-error diagnostic code (lexer/parser family, BR1xxx). */
const SYNTAX_ERROR = 'BR1004';
/**
 * Type-nesting depth-limit diagnostic code (syntax family, BR1xxx). Emitted
 * instead of an internal BR2999 when a type expression nests past
 * {@link MAX_TYPE_DEPTH} and the parser would otherwise overflow the stack.
 */
const TYPE_DEPTH_ERROR = 'BR1005';
/**
 * Redundant optional-marker warning code (BR21xx style-warning family, like
 * the BR2101-BR2103 naming warnings). Advisory only: warnings never block
 * compilation or formatting.
 */
const REDUNDANT_OPTIONAL = 'BR2104';
/** Package-statement placement diagnostic code. */
const PACKAGE_ERROR = 'BR2007';
/** Unknown-constraint diagnostic code (emitted during parsing). */
const UNKNOWN_CONSTRAINT = 'BR2014';

/**
 * Maximum nesting depth of a type expression (`list<…>` / `set<…>` /
 * `map<…, …>` / optional wrappers). Past this the parser reports
 * "type nesting too deep" and recovers instead of recursing further —
 * unbounded recursion overflows the call stack and surfaces as an internal
 * `BR2999` error. Exported so tools and tests can match the threshold.
 */
export const MAX_TYPE_DEPTH = 256;

const DECL_KEYWORDS: ReadonlySet<string> = new Set([
  'type', 'enum', 'union', 'alias', 'service', 'event',
]);

/** Result of parsing: the best-effort file AST plus diagnostics. */
export interface ParseResult {
  file: BridgeFileNode;
  diagnostics: Diagnostic[];
}

/** Parse a token stream (from {@link tokenize}) into a Bridge file AST. */
export function parse(tokens: Token[], filePath: string): ParseResult {
  return new Parser(tokens, filePath).parseFile();
}

/** Shape returned by `parseAtModifier` — either a deprecated marker, a constraint, or nothing. */
type ModifierResult =
  | { kind: 'deprecated'; value: string | true }
  | { kind: 'constraint'; constraint: ConstraintNode }
  | { kind: 'none' };

class Parser {
  private idx = 0;
  private readonly diagnostics: Diagnostic[] = [];
  /** Doc comment lines waiting to be attached to the next declaration/field. */
  private pendingDocs: string[] = [];
  /**
   * Set while recovering from a type-nesting depth-limit violation (BR1005):
   * the diagnostic is reported once and enclosing composite frames close
   * silently instead of cascading "Expected `>`" errors. Reset when the
   * top-level `parseType` call completes.
   */
  private typeDepthLimitHit = false;

  constructor(
    private readonly tokens: Token[],
    private readonly filePath: string,
  ) {}

  // ---------------------------------------------------------------- accessors

  private peek(offset = 0): Token {
    const t = this.tokens[this.idx + offset];
    if (t !== undefined) return t;
    // Tokens always end with `eof`; fall back to it when out of range.
    const last = this.tokens[this.tokens.length - 1];
    return last ?? { kind: 'eof', text: '', line: 1, column: 1 };
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.idx++;
    return t;
  }

  private atPunct(text: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'punct' && t.text === text;
  }

  private atKeyword(text: string): boolean {
    const t = this.peek();
    return t.kind === 'keyword' && t.text === text;
  }

  private err(
    code: string,
    message: string,
    tok: Token,
    hint?: string,
  ): void {
    const d: Diagnostic = {
      severity: 'error',
      code,
      message,
      file: this.filePath,
      line: tok.line,
      column: tok.column,
    };
    if (hint !== undefined) d.hint = hint;
    this.diagnostics.push(d);
  }

  /** Report an advisory warning (never blocks compilation or formatting). */
  private warn(
    code: string,
    message: string,
    tok: Token,
    hint?: string,
  ): void {
    const d: Diagnostic = {
      severity: 'warning',
      code,
      message,
      file: this.filePath,
      line: tok.line,
      column: tok.column,
    };
    if (hint !== undefined) d.hint = hint;
    this.diagnostics.push(d);
  }

  /** Human-readable description of a token for error messages. */
  private describe(tok: Token): string {
    switch (tok.kind) {
      case 'ident':
        return `\`${tok.text}\``;
      case 'keyword':
        return `keyword \`${tok.text}\``;
      case 'number':
        return `number \`${tok.text}\``;
      case 'string':
        return 'string literal';
      case 'punct':
        return `\`${tok.text}\``;
      case 'doc':
        return 'doc comment';
      case 'eof':
        return 'end of file';
    }
  }

  /** Consume the current token if it is the expected punctuation. */
  private expectPunct(text: string, message?: string, hint?: string): boolean {
    if (this.atPunct(text)) {
      this.next();
      return true;
    }
    this.err(
      SYNTAX_ERROR,
      message ?? `Expected \`${text}\` but found ${this.describe(this.peek())}.`,
      this.peek(),
      hint,
    );
    return false;
  }

  /** Consume an identifier, or report an error and return an empty name. */
  private expectIdent(what: string): { name: string; token: Token } {
    const t = this.peek();
    if (t.kind === 'ident') {
      this.next();
      return { name: t.text, token: t };
    }
    this.err(
      SYNTAX_ERROR,
      `Expected ${what} but found ${this.describe(t)}.`,
      t,
      'Names are identifiers made of letters, digits and underscores.',
    );
    return { name: '', token: t };
  }

  /** Join and clear pending doc comments. */
  private takeDocs(): string | undefined {
    if (this.pendingDocs.length === 0) return undefined;
    const joined = this.pendingDocs.join('\n');
    this.pendingDocs = [];
    return joined;
  }

  /**
   * Parse `name.segment...` (used for package and import names).
   * Returns the dotted name as written; empty when unparseable.
   */
  private parseDottedName(what: string): string {
    const first = this.expectIdent(what);
    if (first.name === '') return '';
    let name = first.name;
    while (this.atPunct('.')) {
      this.next();
      const seg = this.expectIdent(`${what} segment after \`.\``);
      if (seg.name === '') break;
      name += `.${seg.name}`;
    }
    return name;
  }

  /** Skip tokens until a declaration keyword, `package`/`import`, or EOF. */
  private skipToDeclaration(): void {
    for (;;) {
      const t = this.peek();
      if (t.kind === 'eof') return;
      if (t.kind === 'keyword') return; // decl keywords and package/import
      this.next();
    }
  }

  // ------------------------------------------------------------------- file

  parseFile(): ParseResult {
    const file: BridgeFileNode = { imports: [], decls: [] };
    let seenDecl = false;

    for (;;) {
      const tok = this.peek();
      if (tok.kind === 'eof') break;

      if (tok.kind === 'doc') {
        this.pendingDocs.push(tok.text);
        this.next();
        continue;
      }

      if (tok.kind === 'keyword') {
        if (tok.text === 'package') {
          if (file.package !== undefined) {
            this.err(
              PACKAGE_ERROR,
              'Duplicate package statement — a file may declare only one package.',
              tok,
            );
            this.next();
            this.parseDottedName('package name');
            continue;
          }
          if (seenDecl || file.imports.length > 0) {
            this.err(
              PACKAGE_ERROR,
              'The package statement must be the first statement in the file.',
              tok,
              'Move `package <name>` above every import and declaration.',
            );
          }
          const docs = this.takeDocs();
          this.next(); // consume `package`
          const nameTok = this.peek();
          const name = this.parseDottedName('package name');
          const pkg: PackageDeclNode = {
            name,
            line: nameTok.line,
            column: nameTok.column,
          };
          if (docs !== undefined) pkg.docs = docs;
          file.package = pkg;
          continue;
        }

        if (tok.text === 'import') {
          // Doc comments above `import` belong to the import itself — take
          // them here so they are neither misattributed to the next
          // declaration nor silently dropped at EOF. They stay on the AST
          // node (the formatter re-prints them above the `import` line); the
          // IR keeps `imports` as bare dotted names.
          const docs = this.takeDocs();
          if (seenDecl) {
            this.err(
              SYNTAX_ERROR,
              'Unexpected `import` after declarations — imports must appear before types, services and events.',
              tok,
              'Move all `import` statements directly below the `package` statement.',
            );
          }
          this.next(); // consume `import`
          const nameTok = this.peek();
          const name = this.parseDottedName('imported package name');
          const imp: ImportDeclNode = {
            name,
            line: nameTok.line,
            column: nameTok.column,
          };
          if (docs !== undefined) imp.docs = docs;
          file.imports.push(imp);
          continue;
        }

        // One of the declaration keywords.
        seenDecl = true;
        file.decls.push(this.parseDecl());
        continue;
      }

      // Unexpected token at file scope.
      this.err(
        SYNTAX_ERROR,
        `Unexpected ${this.describe(tok)} at file scope — expected a declaration.`,
        tok,
        'Top-level declarations start with one of: type, enum, union, alias, service, event.',
      );
      this.next();
      this.skipToDeclaration();
    }

    return { file, diagnostics: this.diagnostics };
  }

  // ------------------------------------------------------------- declarations

  private parseDecl(): StructDeclNode | EnumDeclNode | UnionDeclNode | AliasDeclNode | ServiceDeclNode | EventDeclNode {
    const t = this.peek();
    switch (t.text) {
      case 'type':
        return this.parseStruct();
      case 'enum':
        return this.parseEnum();
      case 'union':
        return this.parseUnion();
      case 'alias':
        return this.parseAlias();
      case 'service':
        return this.parseService();
      case 'event':
        return this.parseEvent();
      default: {
        // Unreachable: callers only dispatch declaration keywords.
        this.err(SYNTAX_ERROR, `Unexpected keyword \`${t.text}\`.`, t);
        this.next();
        return { decl: 'struct', name: '', fields: [], line: t.line, column: t.column };
      }
    }
  }

  /** Parse `@deprecated` / constraint modifiers that may follow a type header name. */
  private parseHeaderModifiers(
    declKind: string,
    allowDeprecated: boolean,
  ): string | true | undefined {
    let deprecated: string | true | undefined;
    while (this.atPunct('@')) {
      const at = this.peek();
      const mod = this.parseAtModifier();
      if (mod.kind === 'deprecated') {
        if (!allowDeprecated) {
          this.err(
            SYNTAX_ERROR,
            `@deprecated is not supported on ${declKind}s.`,
            at,
          );
        } else {
          deprecated = mod.value;
        }
      } else if (mod.kind === 'constraint') {
        this.err(
          SYNTAX_ERROR,
          `Only @deprecated is allowed on a ${declKind} header — \`@${mod.constraint.kindName}\` cannot be used here.`,
          at,
          'Validation constraints belong on fields, e.g. `count: int32 @min(0)`.',
        );
      }
    }
    return deprecated;
  }

  private parseStruct(): StructDeclNode {
    const kw = this.next(); // `type`
    const docs = this.takeDocs();
    const { name } = this.expectIdent('a type name');
    const deprecated = this.parseHeaderModifiers('type', true);
    this.expectPunct(
      '{',
      `Expected \`{\` to open the body of type \`${name}\`.`,
      'Structs are written `type Name { field: type }`.',
    );
    const fields = this.parseFieldBody(name, 'type');
    const node: StructDeclNode = { decl: 'struct', name, fields, line: kw.line, column: kw.column };
    if (docs !== undefined) node.docs = docs;
    if (deprecated !== undefined) node.deprecated = deprecated;
    return node;
  }

  private parseUnion(): UnionDeclNode {
    const kw = this.next(); // `union`
    const docs = this.takeDocs();
    const { name } = this.expectIdent('a union name');
    const deprecated = this.parseHeaderModifiers('union', true);
    this.expectPunct(
      '{',
      `Expected \`{\` to open the body of union \`${name}\`.`,
      'Unions are written `union Name { member: Type }`.',
    );
    const members = this.parseFieldBody(name, 'union');
    const node: UnionDeclNode = { decl: 'union', name, members, line: kw.line, column: kw.column };
    if (docs !== undefined) node.docs = docs;
    if (deprecated !== undefined) node.deprecated = deprecated;
    return node;
  }

  private parseEvent(): EventDeclNode {
    const kw = this.next(); // `event`
    const docs = this.takeDocs();
    const { name } = this.expectIdent('an event name');
    this.parseHeaderModifiers('event', false);
    this.expectPunct(
      '{',
      `Expected \`{\` to open the body of event \`${name}\`.`,
      'Events are written `event Name { field: type }`.',
    );
    const fields = this.parseFieldBody(name, 'event');
    const node: EventDeclNode = { decl: 'event', name, fields, line: kw.line, column: kw.column };
    if (docs !== undefined) node.docs = docs;
    return node;
  }

  /**
   * Parse the newline-separated field body of a struct/union/event until `}`
   * or EOF. Recovers at declaration boundaries so a missing `}` does not
   * swallow the rest of the file.
   */
  private parseFieldBody(containerName: string, kind: string): FieldNode[] {
    const fields: FieldNode[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok.kind === 'eof') {
        this.err(
          SYNTAX_ERROR,
          `Unexpected end of file inside ${kind} \`${containerName}\` — missing closing \`}\`.`,
          tok,
          'Add a `}` to close the body.',
        );
        break;
      }
      if (tok.kind === 'punct' && tok.text === '}') {
        this.next();
        break;
      }
      if (tok.kind === 'doc') {
        this.pendingDocs.push(tok.text);
        this.next();
        continue;
      }
      if (tok.kind === 'punct' && (tok.text === ',' || tok.text === ';')) {
        this.err(
          SYNTAX_ERROR,
          tok.text === ','
            ? `Unexpected \`,\` in ${kind} body — fields are separated by newlines, not commas.`
            : `Unexpected \`;\` in ${kind} body — fields are separated by newlines; semicolons are not part of the grammar.`,
          tok,
          'Remove the punctuation and put each field on its own line.',
        );
        this.next();
        continue;
      }
      if (tok.kind === 'keyword' && DECL_KEYWORDS.has(tok.text)) {
        this.err(
          SYNTAX_ERROR,
          `Expected \`}\` before \`${tok.text}\` — the ${kind} body \`${containerName}\` is not closed.`,
          tok,
        );
        break; // leave the token for the outer declaration loop
      }
      if (tok.kind === 'ident') {
        fields.push(this.parseField());
        continue;
      }
      this.err(
        SYNTAX_ERROR,
        `Unexpected ${this.describe(tok)} in ${kind} body — expected a field.`,
        tok,
        'Fields are written `name: type`.',
      );
      this.next();
    }
    return fields;
  }

  private parseField(): FieldNode {
    const docs = this.takeDocs();
    const nameTok = this.next(); // identifier (caller verified)

    let optional = false;
    /** Optional markers (`?`) claimed by this field, for BR2104. */
    let optionalMarkers = 0;
    if (this.atPunct('?')) {
      optional = true;
      optionalMarkers += 1;
      this.next();
    }
    this.expectPunct(
      ':',
      `Expected \`:\` after field name \`${nameTok.text}\`.`,
      'Fields are written `name: type`.',
    );

    const parsedType = this.parseType();
    // `parseType` consumes a trailing `?` itself (wrapping the type), so the
    // marker must be recovered from the node to keep `name: T?` and `name?: T`
    // equivalent at the field level.
    if (this.atPunct('?')) {
      optional = true;
      optionalMarkers += 1;
      this.next();
    }
    if (parsedType.kind === 'optional') {
      optional = true;
      optionalMarkers += 1;
    }

    const constraints: ConstraintNode[] = [];
    let deprecated: string | true | undefined;
    for (;;) {
      if (!this.atPunct('@')) break;
      const mod = this.parseAtModifier();
      if (mod.kind === 'deprecated') {
        deprecated = mod.value;
      } else if (mod.kind === 'constraint') {
        constraints.push(mod.constraint);
      }
      // Invariant: `parseAtModifier` always consumes the `@` — progress is
      // guaranteed by that consumption, so this loop terminates even when a
      // malformed modifier (e.g. the `@ @` in `a: string @ @ @ :`) reports
      // an error and returns `{ kind: 'none' }`. No extra guard is needed.
    }

    let defaultValue: DefaultValueNode | undefined;
    if (this.atPunct('=')) {
      this.next();
      defaultValue = this.parseDefaultValue();
    }

    // Lenient trailing `?` after constraints/default.
    if (this.atPunct('?')) {
      optional = true;
      optionalMarkers += 1;
      this.next();
    }

    // More than one marker (`a?: string?`, `a: string??`, …) is redundant —
    // the extra markers are silently swallowed otherwise.
    if (optionalMarkers > 1) {
      this.warn(
        REDUNDANT_OPTIONAL,
        `Field \`${nameTok.text}\` declares the optional marker \`?\` more than once.`,
        nameTok,
        'Keep a single `?` — canonical style is `name: Type?` (or `name?: Type`).',
      );
    }

    const node: FieldNode = {
      name: nameTok.text,
      type: parsedType,
      optional,
      constraints,
      line: nameTok.line,
      column: nameTok.column,
    };
    if (docs !== undefined) node.docs = docs;
    if (deprecated !== undefined) node.deprecated = deprecated;
    if (defaultValue !== undefined) node.defaultValue = defaultValue;
    return node;
  }

  private parseEnum(): EnumDeclNode {
    const kw = this.next(); // `enum`
    const docs = this.takeDocs();
    const { name } = this.expectIdent('an enum name');
    const deprecated = this.parseHeaderModifiers('enum', true);
    this.expectPunct(
      '{',
      `Expected \`{\` to open the body of enum \`${name}\`.`,
      'Enum variants are SCREAMING_CASE names separated by newlines.',
    );
    const variants: VariantNode[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok.kind === 'eof') {
        this.err(
          SYNTAX_ERROR,
          `Unexpected end of file inside enum \`${name}\` — missing closing \`}\`.`,
          tok,
          'Add a `}` to close the body.',
        );
        break;
      }
      if (tok.kind === 'punct' && tok.text === '}') {
        this.next();
        break;
      }
      if (tok.kind === 'doc') {
        this.pendingDocs.push(tok.text);
        this.next();
        continue;
      }
      if (tok.kind === 'punct' && (tok.text === ',' || tok.text === ';')) {
        this.err(
          SYNTAX_ERROR,
          tok.text === ','
            ? 'Unexpected `,` in enum body — variants are separated by newlines, not commas.'
            : 'Unexpected `;` in enum body — variants are separated by newlines; semicolons are not part of the grammar.',
          tok,
          'Remove the punctuation and put each variant on its own line.',
        );
        this.next();
        continue;
      }
      if (tok.kind === 'keyword' && DECL_KEYWORDS.has(tok.text)) {
        this.err(
          SYNTAX_ERROR,
          `Expected \`}\` before \`${tok.text}\` — the enum body \`${name}\` is not closed.`,
          tok,
        );
        break;
      }
      if (tok.kind === 'ident') {
        variants.push(this.parseVariant());
        continue;
      }
      this.err(
        SYNTAX_ERROR,
        `Unexpected ${this.describe(tok)} in enum body — expected a variant name.`,
        tok,
      );
      this.next();
    }
    const node: EnumDeclNode = { decl: 'enum', name, variants, line: kw.line, column: kw.column };
    if (docs !== undefined) node.docs = docs;
    if (deprecated !== undefined) node.deprecated = deprecated;
    return node;
  }

  private parseVariant(): VariantNode {
    const docs = this.takeDocs();
    const nameTok = this.next(); // identifier
    let deprecated: string | true | undefined;
    while (this.atPunct('@')) {
      const at = this.peek();
      const mod = this.parseAtModifier();
      if (mod.kind === 'deprecated') {
        deprecated = mod.value;
      } else if (mod.kind === 'constraint') {
        this.err(
          SYNTAX_ERROR,
          `Constraints are not allowed on enum variants — only @deprecated.`,
          at,
        );
      }
    }
    const node: VariantNode = { name: nameTok.text, line: nameTok.line, column: nameTok.column };
    if (docs !== undefined) node.docs = docs;
    if (deprecated !== undefined) node.deprecated = deprecated;
    return node;
  }

  private parseAlias(): AliasDeclNode {
    const kw = this.next(); // `alias`
    const docs = this.takeDocs();
    const { name } = this.expectIdent('an alias name');
    const deprecated = this.parseHeaderModifiers('alias', true);
    this.expectPunct(
      '=',
      `Expected \`=\` in alias \`${name}\`.`,
      'Aliases are written `alias Name = Type`.',
    );
    const target = this.parseType();
    const node: AliasDeclNode = { decl: 'alias', name, target, line: kw.line, column: kw.column };
    if (docs !== undefined) node.docs = docs;
    if (deprecated !== undefined) node.deprecated = deprecated;
    return node;
  }

  private parseService(): ServiceDeclNode {
    const kw = this.next(); // `service`
    const docs = this.takeDocs();
    const { name } = this.expectIdent('a service name');
    this.parseHeaderModifiers('service', false);
    this.expectPunct(
      '{',
      `Expected \`{\` to open the body of service \`${name}\`.`,
      'Methods are written `Name(Input) -> Output`.',
    );
    const methods: MethodNode[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok.kind === 'eof') {
        this.err(
          SYNTAX_ERROR,
          `Unexpected end of file inside service \`${name}\` — missing closing \`}\`.`,
          tok,
          'Add a `}` to close the body.',
        );
        break;
      }
      if (tok.kind === 'punct' && tok.text === '}') {
        this.next();
        break;
      }
      if (tok.kind === 'doc') {
        this.pendingDocs.push(tok.text);
        this.next();
        continue;
      }
      if (tok.kind === 'punct' && (tok.text === ',' || tok.text === ';')) {
        this.err(
          SYNTAX_ERROR,
          tok.text === ','
            ? 'Unexpected `,` in service body — methods are separated by newlines, not commas.'
            : 'Unexpected `;` in service body — methods are separated by newlines; semicolons are not part of the grammar.',
          tok,
          'Remove the punctuation and put each method on its own line.',
        );
        this.next();
        continue;
      }
      if (tok.kind === 'keyword' && DECL_KEYWORDS.has(tok.text)) {
        this.err(
          SYNTAX_ERROR,
          `Expected \`}\` before \`${tok.text}\` — the service body \`${name}\` is not closed.`,
          tok,
        );
        break;
      }
      if (tok.kind === 'ident') {
        methods.push(this.parseMethod());
        continue;
      }
      this.err(
        SYNTAX_ERROR,
        `Unexpected ${this.describe(tok)} in service body — expected a method.`,
        tok,
        'Methods are written `Name(Input) -> Output`.',
      );
      this.next();
    }
    const node: ServiceDeclNode = { decl: 'service', name, methods, line: kw.line, column: kw.column };
    if (docs !== undefined) node.docs = docs;
    return node;
  }

  private parseMethod(): MethodNode {
    const docs = this.takeDocs();
    const nameTok = this.next(); // identifier

    let input: TypeNode = { kind: 'error', line: nameTok.line, column: nameTok.column };
    let output: TypeNode = { kind: 'error', line: nameTok.line, column: nameTok.column };

    if (this.expectPunct(
      '(',
      `Expected \`(\` after method name \`${nameTok.text}\`.`,
      'Methods are written `Name(Input) -> Output`.',
    )) {
      input = this.parseType();
      this.expectPunct(')', `Expected \`)\` after the input type of method \`${nameTok.text}\`.`);
    }
    if (this.atPunct('->')) {
      this.next();
      output = this.parseType();
    } else {
      this.err(
        SYNTAX_ERROR,
        `Expected \`->\` in method \`${nameTok.text}\` — methods are written \`Name(Input) -> Output\`.`,
        this.peek(),
      );
      // Lenient recovery: if an identifier follows, treat it as the output type.
      if (this.peek().kind === 'ident') {
        output = this.parseType();
      }
    }

    let deprecated: string | true | undefined;
    while (this.atPunct('@')) {
      const at = this.peek();
      const mod = this.parseAtModifier();
      if (mod.kind === 'deprecated') {
        deprecated = mod.value;
      } else if (mod.kind === 'constraint') {
        this.err(
          SYNTAX_ERROR,
          `Constraints are not allowed on methods — only @deprecated.`,
          at,
        );
      }
    }

    const node: MethodNode = {
      name: nameTok.text,
      input,
      output,
      line: nameTok.line,
      column: nameTok.column,
    };
    if (docs !== undefined) node.docs = docs;
    if (deprecated !== undefined) node.deprecated = deprecated;
    return node;
  }

  // --------------------------------------------------------------- modifiers

  /**
   * Parse an `@name(...)` modifier. The `@` must be the current token.
   * Returns the deprecated marker for `@deprecated`, a constraint node for
   * known constraint kinds, or nothing (after reporting) for unknown names.
   */
  private parseAtModifier(): ModifierResult {
    const at = this.next(); // `@`
    const kindTok = this.peek();
    if (kindTok.kind !== 'ident') {
      this.err(
        SYNTAX_ERROR,
        `Expected a constraint name after \`@\` but found ${this.describe(kindTok)}.`,
        kindTok,
        'Known constraints: @min, @max, @length, @email, @url, @pattern, @uuid.',
      );
      return { kind: 'none' };
    }
    this.next(); // constraint name

    if (kindTok.text === 'deprecated') {
      const args = this.parseArgList();
      if (args.length === 0) return { kind: 'deprecated', value: true };
      if (args.length === 1 && args[0]?.isString) {
        return { kind: 'deprecated', value: args[0].text };
      }
      this.err(
        SYNTAX_ERROR,
        '@deprecated takes at most one string literal argument.',
        kindTok,
        'Use `@deprecated` or `@deprecated("explanation")`.',
      );
      return { kind: 'deprecated', value: true };
    }

    if (CONSTRAINT_KINDS.has(kindTok.text)) {
      const args = this.parseArgList();
      return {
        kind: 'constraint',
        constraint: {
          kindName: kindTok.text,
          args,
          line: at.line,
          column: at.column,
        },
      };
    }

    this.err(
      UNKNOWN_CONSTRAINT,
      `Unknown constraint \`@${kindTok.text}\`.`,
      kindTok,
      'Known constraints: @min, @max, @length, @email, @url, @pattern, @uuid.',
    );
    this.skipParenGroup();
    return { kind: 'none' };
  }

  /**
   * Parse an optional parenthesized argument list `(a, b, ...)` for a
   * constraint. Arguments are kept as written; quoted strings are recorded
   * so the formatter can re-quote them. Commas are separators here (unlike
   * field bodies).
   */
  private parseArgList(): ConstraintArgNode[] {
    const args: ConstraintArgNode[] = [];
    if (!this.atPunct('(')) return args;
    this.next(); // `(`
    for (;;) {
      const tok = this.peek();
      if (tok.kind === 'eof') {
        this.err(SYNTAX_ERROR, 'Unclosed `(` in constraint arguments.', tok, 'Add a closing `)`.');
        break;
      }
      if (tok.kind === 'punct' && tok.text === ')') {
        this.next();
        break;
      }
      if (tok.kind === 'punct' && tok.text === '(') {
        this.next(); // tolerate nesting without mis-pairing
        continue;
      }
      if (tok.kind === 'punct' && tok.text === ',') {
        this.next();
        continue;
      }
      if (tok.kind === 'string') {
        args.push({ text: tok.text, isString: true });
        this.next();
        continue;
      }
      if (tok.kind === 'number') {
        args.push({ text: tok.text, isString: false });
        this.next();
        continue;
      }
      if (tok.kind === 'punct' && tok.text === '-') {
        this.next();
        const num = this.peek();
        if (num.kind === 'number') {
          args.push({ text: `-${num.text}`, isString: false });
          this.next();
        } else {
          this.err(SYNTAX_ERROR, 'Expected a number after `-` in constraint argument.', num);
        }
        continue;
      }
      if (tok.kind === 'ident') {
        args.push({ text: tok.text, isString: false });
        this.next();
        continue;
      }
      this.err(
        SYNTAX_ERROR,
        `Unexpected ${this.describe(tok)} in constraint arguments.`,
        tok,
      );
      this.next();
    }
    return args;
  }

  /** Skip a balanced-ish `(...)` group after an unknown constraint name. */
  private skipParenGroup(): void {
    if (!this.atPunct('(')) return;
    this.next();
    let depth = 1;
    while (depth > 0) {
      const tok = this.peek();
      if (tok.kind === 'eof') return;
      if (tok.kind === 'punct' && tok.text === '(') depth++;
      if (tok.kind === 'punct' && tok.text === ')') depth--;
      this.next();
    }
  }

  private parseDefaultValue(): DefaultValueNode | undefined {
    const tok = this.peek();
    if (tok.kind === 'string') {
      this.next();
      return { text: tok.text, isString: true };
    }
    if (tok.kind === 'number') {
      this.next();
      return { text: tok.text, isString: false };
    }
    if (tok.kind === 'ident') {
      this.next();
      return { text: tok.text, isString: false };
    }
    if (tok.kind === 'punct' && tok.text === '-') {
      this.next();
      const num = this.peek();
      if (num.kind === 'number') {
        this.next();
        return { text: `-${num.text}`, isString: false };
      }
      this.err(SYNTAX_ERROR, 'Expected a number after `-` in default value.', num);
      return undefined;
    }
    this.err(
      SYNTAX_ERROR,
      `Expected a default value but found ${this.describe(tok)}.`,
      tok,
      'Defaults are written `field: type = value` and may be a string, number or identifier.',
    );
    return undefined;
  }

  // -------------------------------------------------------------------- types

  /**
   * Parse a type expression: primitives, named (possibly package-qualified)
   * references, or `list<T>` / `set<T>` / `map<K, V>` composites, each
   * optionally followed by `?` (producing an optional wrapper).
   *
   * Recursion is bounded by {@link MAX_TYPE_DEPTH}: past the threshold the
   * parser reports "type nesting too deep" (BR1005) once and recovers by
   * skipping the remainder of the type expression, instead of recursing
   * until the call stack overflows (which previously surfaced as an
   * internal BR2999 error).
   *
   * On failure reports an error and returns an `error` node **without
   * consuming** the offending token — the caller's loop makes progress.
   */
  private parseType(depth = 0): TypeNode {
    if (depth === 0) {
      // Top-level entry point: reset the depth-limit recovery flag when the
      // whole expression has been parsed so later types parse normally.
      try {
        return this.parseTypeAt(depth);
      } finally {
        this.typeDepthLimitHit = false;
      }
    }
    return this.parseTypeAt(depth);
  }

  private parseTypeAt(depth: number): TypeNode {
    const tok = this.peek();

    if (depth > MAX_TYPE_DEPTH) {
      this.reportTypeDepthLimit(tok);
      this.skipTypeTail();
      return { kind: 'error', line: tok.line, column: tok.column };
    }

    let result: TypeNode;

    if (tok.kind === 'ident') {
      const name = tok.text;
      const nextTok = this.peek(1);
      const isComposite =
        (name === 'list' || name === 'set' || name === 'map') &&
        nextTok.kind === 'punct' &&
        nextTok.text === '<';

      if (isComposite) {
        this.next(); // composite name
        this.next(); // `<`
        if (name === 'map') {
          const key = this.parseType(depth + 1);
          this.expectPunct(
            ',',
            'Expected `,` between the key and value types of a map.',
            'Map types are written `map<K, V>`.',
          );
          const value = this.parseType(depth + 1);
          this.closeComposite('map');
          result = { kind: 'map', key, value, line: tok.line, column: tok.column };
        } else {
          const element = this.parseType(depth + 1);
          this.closeComposite(name);
          result =
            name === 'list'
              ? { kind: 'list', element, line: tok.line, column: tok.column }
              : { kind: 'set', element, line: tok.line, column: tok.column };
        }
      } else if (PRIMITIVE_SET.has(name)) {
        this.next();
        result = { kind: 'primitive', primitive: name as PrimitiveKind, line: tok.line, column: tok.column };
      } else {
        this.next();
        const segments: string[] = [name];
        while (this.atPunct('.')) {
          this.next();
          const seg = this.expectIdent('a type name segment after `.`');
          if (seg.name === '') break;
          segments.push(seg.name);
        }
        if (segments.length === 1) {
          result = { kind: 'named', name, line: tok.line, column: tok.column };
        } else {
          const typeName = segments[segments.length - 1] ?? name;
          const pkg = segments.slice(0, -1).join('.');
          result = { kind: 'named', name: typeName, package: pkg, line: tok.line, column: tok.column };
        }
      }
    } else {
      this.err(
        SYNTAX_ERROR,
        `Expected a type but found ${this.describe(tok)}.`,
        tok,
        'Types are primitives (string, int64, ...), named types, or composites like list<T> and map<K, V>.',
      );
      result = { kind: 'error', line: tok.line, column: tok.column };
    }

    if (this.atPunct('?')) {
      this.next();
      result = { kind: 'optional', inner: result, line: tok.line, column: tok.column };
    }
    return result;
  }

  /** Report the BR1005 depth-limit diagnostic at most once per expression. */
  private reportTypeDepthLimit(tok: Token): void {
    if (this.typeDepthLimitHit) return;
    this.typeDepthLimitHit = true;
    this.err(
      TYPE_DEPTH_ERROR,
      `Type nesting too deep — type expressions may nest at most ${MAX_TYPE_DEPTH} levels.`,
      tok,
      'Introduce a named alias for the inner types, e.g. `alias Inner = list<string>`.',
    );
  }

  /**
   * Close a `list<` / `set<` / `map<` composite. While unwinding after a
   * depth-limit violation the closing `>` is consumed silently when present
   * (the violation itself was already reported), so the recovery does not
   * cascade into hundreds of "Expected `>`" errors.
   */
  private closeComposite(name: string): void {
    if (this.typeDepthLimitHit) {
      if (this.atPunct('>')) this.next();
      return;
    }
    this.expectPunct('>', `Expected \`>\` to close the \`${name}<\` type.`);
  }

  /**
   * Skip the remainder of an over-deep type expression after a BR1005
   * violation. Consumes type-ish tokens while brackets are balanced and
   * stops at the first token that cannot continue a type (leaving closing
   * `>`s for the enclosing frames, which pair them via {@link closeComposite}).
   */
  private skipTypeTail(): void {
    let balance = 0;
    for (;;) {
      const tok = this.peek();
      if (tok.kind === 'eof') return;
      if (tok.kind === 'punct') {
        switch (tok.text) {
          case '<':
            balance += 1;
            this.next();
            continue;
          case '>':
            if (balance === 0) return; // closes an enclosing composite
            balance -= 1;
            this.next();
            continue;
          case '.':
            this.next();
            continue;
          case ',':
          case '?':
            if (balance === 0) return;
            this.next();
            continue;
          default:
            return; // `}` `)` `:` `@` `=` `->` … end the type expression
        }
      }
      if (tok.kind === 'ident' || tok.kind === 'number' || tok.kind === 'string') {
        this.next();
        continue;
      }
      return; // keywords, doc comments, …
    }
  }
}
