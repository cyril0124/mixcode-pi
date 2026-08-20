// pi-packages/mpi-permission/vendor/unbash/dist/ansi-c.js
function isOctal(code) {
  return code >= 48 && code <= 55;
}
function isHex(code) {
  return code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102;
}
function codePoint(value, fallback) {
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}
function decodeAnsiCQuoted(source, start, limit) {
  let pos = start;
  let value = "";
  while (pos < limit && source.charCodeAt(pos) !== 39) {
    if (source.charCodeAt(pos) !== 92 || pos + 1 >= limit) {
      const runStart = pos;
      while (pos < limit) {
        const code = source.charCodeAt(pos);
        if (code === 39 || code === 92 && pos + 1 < limit)
          break;
        pos++;
      }
      value += source.slice(runStart, pos);
      continue;
    }
    const escapeStart = pos++;
    const escaped = source[pos++];
    switch (escaped) {
      case "a":
        value += "\x07";
        break;
      case "b":
        value += "\b";
        break;
      case "e":
      case "E":
        value += "\x1B";
        break;
      case "f":
        value += "\f";
        break;
      case "n":
        value += `
`;
        break;
      case "r":
        value += "\r";
        break;
      case "t":
        value += "\t";
        break;
      case "v":
        value += "\v";
        break;
      case "\\":
        value += "\\";
        break;
      case "'":
        value += "'";
        break;
      case '"':
        value += '"';
        break;
      case "?":
        value += "?";
        break;
      case `
`:
        break;
      case "c": {
        const code = pos < limit ? source.charCodeAt(pos) : 39;
        if (code === 39) {
          value += source.slice(escapeStart, pos);
          break;
        }
        pos++;
        if (code === 92) {
          const pair = pos < limit && source.charCodeAt(pos) === 92;
          if (pair)
            pos++;
          value += "\x1C";
          if (!pair && pos < limit) {
            value += source[pos];
            pos++;
          }
          break;
        }
        value += String.fromCharCode(code === 63 ? 127 : code & 31);
        break;
      }
      case "x":
      case "u":
      case "U": {
        const digitsStart = pos;
        const maxDigits = escaped === "x" ? 2 : escaped === "u" ? 4 : 8;
        while (pos < limit && pos - digitsStart < maxDigits && isHex(source.charCodeAt(pos)))
          pos++;
        if (pos === digitsStart) {
          value += `\\${escaped}`;
          break;
        }
        const raw = source.slice(escapeStart, pos);
        value += codePoint(Number.parseInt(source.slice(digitsStart, pos), 16), raw);
        break;
      }
      default: {
        const escapedCode = escaped.charCodeAt(0);
        if (!isOctal(escapedCode)) {
          value += `\\${escaped}`;
          break;
        }
        while (pos < limit && pos - escapeStart - 1 < 3 && isOctal(source.charCodeAt(pos)))
          pos++;
        value += String.fromCharCode(Number.parseInt(source.slice(escapeStart + 1, pos), 8) & 255);
        break;
      }
    }
  }
  const closed = pos < limit;
  if (closed)
    pos++;
  return { value, end: pos, closed };
}

// pi-packages/mpi-permission/vendor/unbash/dist/chars.js
var CH_TAB = 9;
var CH_NL = 10;
var CH_SPACE = 32;
var CH_BANG = 33;
var CH_DQUOTE = 34;
var CH_HASH = 35;
var CH_DOLLAR = 36;
var CH_PERCENT = 37;
var CH_AMP = 38;
var CH_SQUOTE = 39;
var CH_LPAREN = 40;
var CH_RPAREN = 41;
var CH_STAR = 42;
var CH_PLUS = 43;
var CH_COMMA = 44;
var CH_DASH = 45;
var CH_SLASH = 47;
var CH_0 = 48;
var CH_9 = 57;
var CH_COLON = 58;
var CH_SEMI = 59;
var CH_LT = 60;
var CH_EQ = 61;
var CH_GT = 62;
var CH_QUESTION = 63;
var CH_AT = 64;
var CH_A = 65;
var CH_Z = 90;
var CH_LBRACKET = 91;
var CH_BACKSLASH = 92;
var CH_RBRACKET = 93;
var CH_CARET = 94;
var CH_UNDERSCORE = 95;
var CH_BACKTICK = 96;
var CH_a = 97;
var CH_z = 122;
var CH_LBRACE = 123;
var CH_PIPE = 124;
var CH_RBRACE = 125;
var CH_TILDE = 126;

// pi-packages/mpi-permission/vendor/unbash/dist/arithmetic.js
function opPrec(op) {
  switch (op) {
    case ",":
      return 1;
    case "=":
    case "+=":
    case "-=":
    case "*=":
    case "/=":
    case "%=":
    case "<<=":
    case ">>=":
    case "&=":
    case "|=":
    case "^=":
      return 2;
    case "||":
      return 4;
    case "&&":
      return 5;
    case "|":
      return 6;
    case "^":
      return 7;
    case "&":
      return 8;
    case "==":
    case "!=":
      return 9;
    case "<":
    case "<=":
    case ">":
    case ">=":
      return 10;
    case "<<":
    case ">>":
      return 11;
    case "+":
    case "-":
      return 12;
    case "*":
    case "/":
    case "%":
      return 13;
    case "**":
      return 14;
    default:
      return -1;
  }
}
function opRightAssoc(op) {
  switch (op) {
    case "=":
    case "+=":
    case "-=":
    case "*=":
    case "/=":
    case "%=":
    case "<<=":
    case ">>=":
    case "&=":
    case "|=":
    case "^=":
    case "**":
      return true;
    default:
      return false;
  }
}
function parseArithmeticExpression(src, offset = 0, collector) {
  let pos = 0;
  const len = src.length;
  const initialCommandCount = collector?.commandExpansions.length ?? 0;
  const initialWordCount = collector?.embeddedWords.length ?? 0;
  function makeWord(start, end, embedded = false) {
    const node = {
      type: "ArithmeticWord",
      pos: start + offset,
      end: end + offset,
      value: src.slice(start, end),
      parts: undefined
    };
    if (embedded)
      collector?.embeddedWords.push(node);
    return node;
  }
  function skipWS() {
    while (pos < len) {
      const c = src.charCodeAt(pos);
      if (c === CH_SPACE || c === CH_TAB || c === CH_NL)
        pos++;
      else
        break;
    }
  }
  function tryReadBinOp() {
    if (pos >= len)
      return null;
    const c = src.charCodeAt(pos);
    const nc = pos + 1 < len ? src.charCodeAt(pos + 1) : 0;
    const nnc = pos + 2 < len ? src.charCodeAt(pos + 2) : 0;
    switch (c) {
      case CH_COMMA:
        pos++;
        return ",";
      case CH_EQ:
        if (nc === CH_EQ) {
          pos += 2;
          return "==";
        }
        pos++;
        return "=";
      case CH_BANG:
        if (nc === CH_EQ) {
          pos += 2;
          return "!=";
        }
        return null;
      case CH_LT:
        if (nc === CH_LT) {
          if (nnc === CH_EQ) {
            pos += 3;
            return "<<=";
          }
          pos += 2;
          return "<<";
        }
        if (nc === CH_EQ) {
          pos += 2;
          return "<=";
        }
        pos++;
        return "<";
      case CH_GT:
        if (nc === CH_GT) {
          if (nnc === CH_EQ) {
            pos += 3;
            return ">>=";
          }
          pos += 2;
          return ">>";
        }
        if (nc === CH_EQ) {
          pos += 2;
          return ">=";
        }
        pos++;
        return ">";
      case CH_PLUS:
        if (nc === CH_EQ) {
          pos += 2;
          return "+=";
        }
        if (nc === CH_PLUS)
          return null;
        pos++;
        return "+";
      case CH_DASH:
        if (nc === CH_EQ) {
          pos += 2;
          return "-=";
        }
        if (nc === CH_DASH)
          return null;
        pos++;
        return "-";
      case CH_STAR:
        if (nc === CH_STAR) {
          pos += 2;
          return "**";
        }
        if (nc === CH_EQ) {
          pos += 2;
          return "*=";
        }
        pos++;
        return "*";
      case CH_SLASH:
        if (nc === CH_EQ) {
          pos += 2;
          return "/=";
        }
        pos++;
        return "/";
      case CH_PERCENT:
        if (nc === CH_EQ) {
          pos += 2;
          return "%=";
        }
        pos++;
        return "%";
      case CH_PIPE:
        if (nc === CH_PIPE) {
          pos += 2;
          return "||";
        }
        if (nc === CH_EQ) {
          pos += 2;
          return "|=";
        }
        pos++;
        return "|";
      case CH_AMP:
        if (nc === CH_AMP) {
          pos += 2;
          return "&&";
        }
        if (nc === CH_EQ) {
          pos += 2;
          return "&=";
        }
        pos++;
        return "&";
      case CH_CARET:
        if (nc === CH_EQ) {
          pos += 2;
          return "^=";
        }
        pos++;
        return "^";
      case CH_QUESTION:
        pos++;
        return "?";
      default:
        return null;
    }
  }
  function parseBinExpr(minPrec) {
    let left = parseUnaryExpr();
    while (true) {
      skipWS();
      if (pos >= len)
        break;
      const saved = pos;
      const op = tryReadBinOp();
      if (!op)
        break;
      if (op === "?") {
        if (3 < minPrec) {
          pos = saved;
          break;
        }
        const consequent = parseBinExpr(1);
        skipWS();
        if (pos < len && src.charCodeAt(pos) === CH_COLON)
          pos++;
        const alternate = parseBinExpr(3);
        left = { type: "ArithmeticTernary", pos: left.pos, end: alternate.end, test: left, consequent, alternate };
        continue;
      }
      const prec = opPrec(op);
      if (prec < minPrec) {
        pos = saved;
        break;
      }
      const nextPrec = opRightAssoc(op) ? prec : prec + 1;
      const right = parseBinExpr(nextPrec);
      left = { type: "ArithmeticBinary", pos: left.pos, end: right.end, operator: op, left, right };
    }
    return left;
  }
  function parseUnaryExpr() {
    skipWS();
    if (pos >= len)
      return makeWord(pos, pos);
    const start = pos;
    const c = src.charCodeAt(pos);
    const nc = pos + 1 < len ? src.charCodeAt(pos + 1) : 0;
    if (c === CH_PLUS && nc === CH_PLUS) {
      pos += 2;
      const operand = parseUnaryExpr();
      return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "++", operand, prefix: true };
    }
    if (c === CH_DASH && nc === CH_DASH) {
      pos += 2;
      const operand = parseUnaryExpr();
      return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "--", operand, prefix: true };
    }
    if (c === CH_BANG) {
      pos++;
      const operand = parseUnaryExpr();
      return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "!", operand, prefix: true };
    }
    if (c === CH_TILDE) {
      pos++;
      const operand = parseUnaryExpr();
      return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "~", operand, prefix: true };
    }
    if (c === CH_PLUS && nc !== CH_PLUS && nc !== CH_EQ) {
      pos++;
      const operand = parseUnaryExpr();
      return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "+", operand, prefix: true };
    }
    if (c === CH_DASH && nc !== CH_DASH && nc !== CH_EQ) {
      pos++;
      const operand = parseUnaryExpr();
      return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "-", operand, prefix: true };
    }
    return parsePostfixExpr();
  }
  function parsePostfixExpr() {
    const operand = parseAtom();
    skipWS();
    if (pos + 1 < len) {
      const c = src.charCodeAt(pos);
      const nc = src.charCodeAt(pos + 1);
      if (c === CH_PLUS && nc === CH_PLUS) {
        pos += 2;
        return { type: "ArithmeticUnary", pos: operand.pos, end: pos + offset, operator: "++", operand, prefix: false };
      }
      if (c === CH_DASH && nc === CH_DASH) {
        pos += 2;
        return { type: "ArithmeticUnary", pos: operand.pos, end: pos + offset, operator: "--", operand, prefix: false };
      }
    }
    return operand;
  }
  function parseAtom() {
    skipWS();
    if (pos >= len)
      return makeWord(pos, pos);
    const c = src.charCodeAt(pos);
    if (c === CH_LPAREN) {
      const start2 = pos;
      pos++;
      const expr = parseBinExpr(0);
      skipWS();
      if (pos < len && src.charCodeAt(pos) === CH_RPAREN)
        pos++;
      return { type: "ArithmeticGroup", pos: start2 + offset, end: pos + offset, expression: expr };
    }
    if (c === CH_DOLLAR) {
      const start2 = pos;
      const commandCount = collector?.commandExpansions.length ?? 0;
      const wordCount2 = collector?.embeddedWords.length ?? 0;
      const atom2 = readDollarAtom();
      const wordEnd2 = collector?.findArithmeticWordEnd?.(start2 + offset, offset + len) ?? pos + offset;
      if (wordEnd2 > pos + offset) {
        if (collector) {
          collector.commandExpansions.length = commandCount;
          collector.embeddedWords.length = wordCount2;
        }
        pos = wordEnd2 - offset;
        return makeWord(start2, pos, true);
      }
      return atom2;
    }
    if (c === 96 || c === 34 || c === 39) {
      const start2 = pos;
      pos = (collector?.findArithmeticWordEnd?.(start2 + offset, offset + len) ?? start2 + offset + 1) - offset;
      return makeWord(start2, pos, true);
    }
    const start = pos;
    const wordCount = collector?.embeddedWords.length ?? 0;
    const atom = readWordAtom();
    const wordEnd = collector?.findArithmeticWordEnd?.(start + offset, offset + len) ?? pos + offset;
    if (wordEnd > pos + offset) {
      if (collector)
        collector.embeddedWords.length = wordCount;
      pos = wordEnd - offset;
      return makeWord(start, pos, true);
    }
    return atom;
  }
  function readDollarAtom() {
    const start = pos;
    pos++;
    if (pos >= len)
      return makeWord(start, pos);
    const c = src.charCodeAt(pos);
    if (c === CH_LPAREN) {
      if (pos + 1 < len && src.charCodeAt(pos + 1) === CH_LPAREN) {
        const expansionEnd = collector?.findArithmeticExpansionEnd(start + offset, offset + len) ?? -1;
        if (expansionEnd !== -1) {
          pos = expansionEnd - offset;
        } else {
          pos += 2;
          let depth = 1;
          while (pos < len && depth > 0) {
            if (src.charCodeAt(pos) === CH_LPAREN && src.charCodeAt(pos + 1) === CH_LPAREN) {
              depth++;
              pos += 2;
            } else if (src.charCodeAt(pos) === CH_RPAREN && src.charCodeAt(pos + 1) === CH_RPAREN) {
              depth--;
              pos += 2;
            } else {
              pos++;
            }
          }
        }
      } else {
        pos++;
        const close = collector?.findClosingParenthesis(pos + offset, offset + len) ?? -1;
        if (close !== -1) {
          pos = close - offset + 1;
        } else {
          let depth = 1;
          while (pos < len && depth > 0) {
            const ch = src.charCodeAt(pos++);
            if (ch === CH_LPAREN)
              depth++;
            else if (ch === CH_RPAREN)
              depth--;
          }
        }
        const text = src.slice(start, pos);
        const inner = text.slice(2, -1);
        const node = {
          type: "ArithmeticCommandExpansion",
          pos: start + offset,
          end: pos + offset,
          text,
          inner,
          script: undefined
        };
        collector?.commandExpansions.push(node);
        return node;
      }
    } else if (c === CH_LBRACE) {
      const close = collector?.findClosingBrace(pos + offset + 1, offset + len) ?? -1;
      if (close !== -1) {
        pos = close - offset + 1;
      } else {
        pos++;
        let depth = 1;
        while (pos < len && depth > 0) {
          const ch = src.charCodeAt(pos++);
          if (ch === CH_LBRACE)
            depth++;
          else if (ch === CH_RBRACE)
            depth--;
        }
      }
    } else {
      while (pos < len) {
        const ch = src.charCodeAt(pos);
        if (ch >= CH_a && ch <= CH_z || ch >= CH_A && ch <= CH_Z || ch >= CH_0 && ch <= CH_9 || ch === CH_UNDERSCORE)
          pos++;
        else
          break;
      }
    }
    return makeWord(start, pos, c === CH_LPAREN || c === CH_LBRACE);
  }
  function readWordAtom() {
    const start = pos;
    while (pos < len) {
      const c = src.charCodeAt(pos);
      if (c >= CH_0 && c <= CH_9 || c >= CH_A && c <= CH_Z || c >= CH_a && c <= CH_z || c === CH_UNDERSCORE || c === 35) {
        pos++;
      } else
        break;
    }
    if (pos > start && pos < len && src.charCodeAt(pos) === CH_LBRACKET) {
      const close = collector?.findClosingBracket?.(pos + offset + 1, offset + len) ?? -1;
      if (close !== -1) {
        pos = close - offset + 1;
      } else {
        pos++;
        let depth = 1;
        while (pos < len && depth > 0) {
          const c = src.charCodeAt(pos);
          if (c === CH_LBRACKET)
            depth++;
          else if (c === CH_RBRACKET)
            depth--;
          pos++;
        }
      }
      return makeWord(start, pos, true);
    }
    if (pos === start) {
      pos++;
      return makeWord(start, pos);
    }
    return makeWord(start, pos);
  }
  skipWS();
  if (pos >= len)
    return null;
  const result = parseBinExpr(0);
  skipWS();
  if (pos < len && collector) {
    collector.commandExpansions.length = initialCommandCount;
    collector.embeddedWords.length = initialWordCount;
    return makeWord(0, len, true);
  }
  return result;
}

// pi-packages/mpi-permission/vendor/unbash/dist/word.js
function dequoteValue(parts) {
  let s = "";
  for (const c of parts)
    s += c.type === "Literal" ? c.value : c.text;
  return s;
}
function unescapeBareValue(text) {
  const first = text.indexOf("\\");
  if (first === -1)
    return text;
  let s = "";
  let start = 0;
  for (let i = first;i < text.length; i++) {
    if (text.charCodeAt(i) !== 92)
      continue;
    s += text.slice(start, i);
    i++;
    if (i >= text.length) {
      s += "\\";
      start = i;
      break;
    }
    if (text.charCodeAt(i) !== 10)
      s += text[i];
    start = i + 1;
  }
  return s + text.slice(start);
}

class WordImpl {
  static _resolveWord;
  static _resolveHeredocBody;
  text;
  pos;
  end;
  #source;
  #resolver;
  #depth;
  #parts;
  #value = null;
  constructor(text, pos, end, source, resolver, depth = 0) {
    this.text = text;
    this.pos = pos;
    this.end = end;
    this.#source = source;
    this.#resolver = resolver ?? WordImpl._resolveWord;
    this.#depth = depth;
    this.#parts = source !== undefined ? null : undefined;
  }
  get value() {
    if (this.#value === null) {
      const parts = this.parts;
      if (!parts) {
        this.#value = unescapeBareValue(this.text);
      } else {
        let s = "";
        for (const p of parts) {
          switch (p.type) {
            case "Literal":
            case "SingleQuoted":
            case "AnsiCQuoted":
              s += p.value;
              break;
            case "DoubleQuoted":
            case "LocaleString":
              s += dequoteValue(p.parts);
              break;
            default:
              s += p.text;
              break;
          }
        }
        this.#value = s;
      }
    }
    return this.#value;
  }
  get parts() {
    if (this.#parts === null) {
      this.#parts = this.#resolver(this.#source ?? "", this, this.#depth) ?? undefined;
    }
    return this.#parts;
  }
  set parts(v) {
    this.#parts = v ?? undefined;
  }
  sourceText() {
    return this.#source?.slice(this.pos, this.end);
  }
  toJSON() {
    return { text: this.text, pos: this.pos, end: this.end, parts: this.parts, value: this.value };
  }
}

// pi-packages/mpi-permission/vendor/unbash/dist/lexer.js
var MAX_SYNTAX_NESTING = 256;
var Token = {
  Word: 0,
  Assignment: 1,
  Semi: 2,
  Newline: 3,
  Pipe: 4,
  And: 5,
  Or: 6,
  Amp: 7,
  LParen: 8,
  RParen: 9,
  LBrace: 10,
  RBrace: 11,
  Bang: 12,
  If: 13,
  Then: 14,
  Else: 15,
  Elif: 16,
  Fi: 17,
  Do: 18,
  Done: 19,
  For: 20,
  While: 21,
  Until: 22,
  In: 23,
  Case: 24,
  Esac: 25,
  Function: 26,
  DoubleSemi: 27,
  SemiAmp: 28,
  DoubleSemiAmp: 29,
  Select: 30,
  DblLBracket: 31,
  DblRBracket: 32,
  EOF: 33,
  ArithCmd: 34,
  Coproc: 35,
  Redirect: 36
};

class TokenValue {
  token = Token.EOF;
  _value = "";
  _owner;
  pos = 0;
  end = 0;
  fileDescriptor = undefined;
  variableName = undefined;
  content = undefined;
  targetPos = 0;
  targetEnd = 0;
  assignmentOperatorPos = -1;
  raw = false;
  keywordEligible = false;
  constructor(owner = null) {
    this._owner = owner;
  }
  get value() {
    return this._value ?? (this._value = this._owner === null ? "" : this._owner._tokenValue(this.pos, this.end, this.raw));
  }
  set value(v) {
    this._value = v;
  }
  reset() {
    this.token = Token.EOF;
    this._value = "";
    this.pos = 0;
    this.end = 0;
    this.fileDescriptor = undefined;
    this.variableName = undefined;
    this.content = undefined;
    this.targetPos = 0;
    this.targetEnd = 0;
    this.assignmentOperatorPos = -1;
    this.raw = false;
    this.keywordEligible = false;
  }
  copyFrom(other) {
    this.token = other.token;
    this._value = other._value;
    this.pos = other.pos;
    this.end = other.end;
    this.fileDescriptor = other.fileDescriptor;
    this.variableName = other.variableName;
    this.content = other.content;
    this.targetPos = other.targetPos;
    this.targetEnd = other.targetEnd;
    this.assignmentOperatorPos = other.assignmentOperatorPos;
    this.raw = other.raw;
    this.keywordEligible = other.keywordEligible;
  }
}
var RESERVED_WORDS = new Map([
  ["if", Token.If],
  ["then", Token.Then],
  ["else", Token.Else],
  ["elif", Token.Elif],
  ["fi", Token.Fi],
  ["do", Token.Do],
  ["done", Token.Done],
  ["for", Token.For],
  ["while", Token.While],
  ["until", Token.Until],
  ["in", Token.In],
  ["case", Token.Case],
  ["esac", Token.Esac],
  ["function", Token.Function],
  ["select", Token.Select],
  ["coproc", Token.Coproc],
  ["!", Token.Bang],
  ["{", Token.LBrace],
  ["}", Token.RBrace]
]);
var charType = new Uint8Array(128);
charType[CH_PIPE] = 1;
charType[CH_AMP] = 1;
charType[CH_SEMI] = 1;
charType[CH_LPAREN] = 1;
charType[CH_RPAREN] = 1;
charType[CH_LT] = 1;
charType[CH_GT] = 1;
charType[CH_SPACE] = 1;
charType[CH_TAB] = 1;
charType[CH_NL] = 1;
charType[CH_BACKSLASH] = 2;
charType[CH_SQUOTE] = 2;
charType[CH_DQUOTE] = 2;
charType[CH_DOLLAR] = 2;
charType[CH_BACKTICK] = 2;
charType[CH_LBRACE] = 2;
function opensComment(src, pos, start) {
  if (pos === start)
    return true;
  const prev = src.charCodeAt(pos - 1);
  return prev < 128 && (charType[prev] & 1) !== 0;
}
var arithmeticWordDelimiter = new Uint8Array(128);
for (const ch of [
  CH_TAB,
  CH_NL,
  CH_SPACE,
  CH_BANG,
  CH_PERCENT,
  CH_AMP,
  CH_LPAREN,
  CH_RPAREN,
  CH_STAR,
  CH_PLUS,
  CH_COMMA,
  CH_DASH,
  CH_SLASH,
  CH_COLON,
  CH_LT,
  CH_EQ,
  CH_GT,
  CH_QUESTION,
  CH_CARET,
  CH_PIPE
]) {
  arithmeticWordDelimiter[ch] = 1;
}
function hasEmbeddedWordStructure(source, start, end) {
  for (let pos = start;pos < end; pos++) {
    const ch = source.charCodeAt(pos);
    if (ch === CH_BACKSLASH || ch === CH_SQUOTE || ch === CH_DQUOTE || ch === CH_DOLLAR || ch === CH_BACKTICK || (ch === CH_LT || ch === CH_GT) && pos + 1 < end && source.charCodeAt(pos + 1) === CH_LPAREN) {
      return true;
    }
  }
  return false;
}
function findUnnested(s, target) {
  let depth = 0;
  for (let i = 0;i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === CH_BACKSLASH) {
      i++;
      continue;
    }
    if (c === CH_LBRACE) {
      depth++;
      continue;
    }
    if (c === CH_RBRACE) {
      if (depth > 0)
        depth--;
      continue;
    }
    if (c === CH_SQUOTE) {
      i++;
      while (i < s.length && s.charCodeAt(i) !== CH_SQUOTE)
        i++;
      continue;
    }
    if (c === CH_DQUOTE) {
      i++;
      while (i < s.length && s.charCodeAt(i) !== CH_DQUOTE) {
        if (s.charCodeAt(i) === CH_BACKSLASH)
          i++;
        i++;
      }
      continue;
    }
    if (c === target && depth === 0)
      return i;
  }
  return -1;
}
var isIdChar = new Uint8Array(128);
for (let i = CH_a;i <= CH_z; i++)
  isIdChar[i] = 3;
for (let i = CH_A;i <= CH_Z; i++)
  isIdChar[i] = 3;
for (let i = CH_0;i <= CH_9; i++)
  isIdChar[i] = 2;
isIdChar[CH_UNDERSCORE] = 3;
var extglobPrefix = new Uint8Array(128);
extglobPrefix[CH_QUESTION] = 1;
extglobPrefix[CH_AT] = 1;
extglobPrefix[CH_STAR] = 1;
extglobPrefix[CH_PLUS] = 1;
extglobPrefix[CH_BANG] = 1;
extglobPrefix[CH_EQ] = 1;
var extglobOp = {
  [CH_QUESTION]: "?",
  [CH_AT]: "@",
  [CH_STAR]: "*",
  [CH_PLUS]: "+",
  [CH_BANG]: "!"
};
function isDQChild(p) {
  const t = p.type;
  return t === "Literal" || t === "SimpleExpansion" || t === "ParameterExpansion" || t === "CommandExpansion" || t === "ArithmeticExpansion";
}
function isAllDigits(text) {
  for (let i = 0;i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < CH_0 || c > CH_9)
      return false;
  }
  return text.length > 0;
}
function isAllDigitsRange(src, start, end) {
  for (let i = start;i < end; i++) {
    const c = src.charCodeAt(i);
    if (c < CH_0 || c > CH_9)
      return false;
  }
  return end > start;
}
var ASSIGNMENT_INVALID = -1;
var ASSIGNMENT_NAME_START = 0;
var ASSIGNMENT_NAME = 1;
var ASSIGNMENT_AFTER_INDEX = 2;
var ASSIGNMENT_AFTER_PLUS = 3;
var ASSIGNMENT_INDEX_BASE = 4;
function isMatchedAssignment(state) {
  return state < ASSIGNMENT_INVALID;
}
function assignmentOperatorPos(state) {
  return -state - 2;
}
function scanAssignmentPrefix(src, start, end, initialState) {
  let state = initialState;
  for (let i = start;i < end && state >= 0; i++) {
    const c = src.charCodeAt(i);
    if (state >= ASSIGNMENT_INDEX_BASE) {
      if (c === CH_LBRACKET)
        state++;
      else if (c === CH_RBRACKET && --state === ASSIGNMENT_INDEX_BASE)
        state = ASSIGNMENT_AFTER_INDEX;
    } else if (state === ASSIGNMENT_NAME_START) {
      state = c < 128 && isIdChar[c] & 1 ? ASSIGNMENT_NAME : ASSIGNMENT_INVALID;
    } else if (state === ASSIGNMENT_NAME) {
      if (c < 128 && isIdChar[c] & 2)
        continue;
      if (c === CH_LBRACKET)
        state = ASSIGNMENT_INDEX_BASE + 1;
      else if (c === CH_PLUS)
        state = ASSIGNMENT_AFTER_PLUS;
      else
        state = c === CH_EQ ? -i - 2 : ASSIGNMENT_INVALID;
    } else if (state === ASSIGNMENT_AFTER_INDEX) {
      if (c === CH_PLUS)
        state = ASSIGNMENT_AFTER_PLUS;
      else
        state = c === CH_EQ ? -i - 2 : ASSIGNMENT_INVALID;
    } else {
      state = c === CH_EQ ? -i - 2 : ASSIGNMENT_INVALID;
    }
  }
  return state;
}
var NO_EXPANSIONS = [];
function setToken(out, token, value, pos = 0, end = 0) {
  out.token = token;
  out._value = value;
  out.pos = pos;
  out.end = end;
  out.fileDescriptor = undefined;
  out.variableName = undefined;
  out.content = undefined;
  out.assignmentOperatorPos = -1;
  out.raw = false;
  out.keywordEligible = false;
}
function setSpanToken(out, token, pos, end, raw) {
  out.token = token;
  out._value = null;
  out.pos = pos;
  out.end = end;
  out.fileDescriptor = undefined;
  out.variableName = undefined;
  out.content = undefined;
  out.assignmentOperatorPos = -1;
  out.raw = raw;
  out.keywordEligible = false;
}
function matchReservedWord(src, start, len) {
  switch (src.charCodeAt(start)) {
    case CH_BANG:
      return len === 1 ? Token.Bang : undefined;
    case CH_LBRACE:
      return len === 1 ? Token.LBrace : undefined;
    case CH_RBRACE:
      return len === 1 ? Token.RBrace : undefined;
    case 105: {
      if (len !== 2)
        return;
      const c = src.charCodeAt(start + 1);
      return c === 102 ? Token.If : c === 110 ? Token.In : undefined;
    }
    case 102:
      if (len === 2)
        return src.charCodeAt(start + 1) === 105 ? Token.Fi : undefined;
      if (len === 3)
        return src.startsWith("for", start) ? Token.For : undefined;
      if (len === 8)
        return src.startsWith("function", start) ? Token.Function : undefined;
      return;
    case 116:
      return len === 4 && src.startsWith("then", start) ? Token.Then : undefined;
    case 101:
      if (len !== 4)
        return;
      if (src.startsWith("else", start))
        return Token.Else;
      if (src.startsWith("elif", start))
        return Token.Elif;
      if (src.startsWith("esac", start))
        return Token.Esac;
      return;
    case 100:
      if (len === 2)
        return src.charCodeAt(start + 1) === 111 ? Token.Do : undefined;
      if (len === 4)
        return src.startsWith("done", start) ? Token.Done : undefined;
      return;
    case 99:
      if (len === 4)
        return src.startsWith("case", start) ? Token.Case : undefined;
      if (len === 6)
        return src.startsWith("coproc", start) ? Token.Coproc : undefined;
      return;
    case 119:
      return len === 5 && src.startsWith("while", start) ? Token.While : undefined;
    case 117:
      return len === 5 && src.startsWith("until", start) ? Token.Until : undefined;
    case 115:
      return len === 6 && src.startsWith("select", start) ? Token.Select : undefined;
    default:
      return;
  }
}
var LexContext = {
  Normal: 0,
  CommandStart: 1,
  TestMode: 2,
  CommandPrefix: 3
};
function scanBraceExpansion(src, pos, len) {
  const nextCh = pos + 1 < len ? src.charCodeAt(pos + 1) : 0;
  if (nextCh <= CH_SPACE || nextCh === CH_RBRACE)
    return -1;
  let depth = 1;
  let hasSep = false;
  let scanPos = pos + 1;
  while (scanPos < len && depth > 0) {
    const bc = src.charCodeAt(scanPos);
    if (bc === CH_LBRACE)
      depth++;
    else if (bc === CH_RBRACE) {
      if (--depth === 0)
        break;
    } else if (bc <= CH_SPACE || bc === CH_SEMI || bc === CH_PIPE || bc === CH_AMP)
      return -1;
    else if (depth === 1 && (bc === 44 || bc === 46 && scanPos + 1 < len && src.charCodeAt(scanPos + 1) === 46))
      hasSep = true;
    if (bc === CH_BACKSLASH)
      scanPos++;
    scanPos++;
  }
  if (depth === 0 && hasSep)
    return scanPos + 1;
  return -1;
}

class Lexer {
  src;
  srcEnd;
  pos;
  current;
  nextState;
  hasPeek;
  pendingHereDocs;
  collectedExpansions;
  _errors = null;
  _buildParts = false;
  _buildValue = false;
  _nestingDepth = 0;
  constructor(src, start = 0, end = src.length) {
    this.src = src;
    this.srcEnd = end;
    this.pos = start;
    this.current = new TokenValue(this);
    this.nextState = new TokenValue(this);
    this.hasPeek = false;
    this.pendingHereDocs = null;
    this.collectedExpansions = null;
    if (start === 0 && src.charCodeAt(0) === CH_HASH && src.charCodeAt(1) === CH_BANG) {
      const nl = src.indexOf(`
`);
      this.pos = nl === -1 ? this.srcEnd : nl + 1;
    }
  }
  getSource() {
    return this.src;
  }
  get errors() {
    return this._errors ?? (this._errors = []);
  }
  getCollectedExpansions() {
    return this.collectedExpansions ?? NO_EXPANSIONS;
  }
  collect(part) {
    (this.collectedExpansions ??= []).push([part, this._nestingDepth]);
  }
  getPos() {
    return this.pos;
  }
  _tokenValue(pos, end, raw) {
    return raw ? this.src.slice(pos, end) : this.wordValueOf(pos, end);
  }
  wordValueOf(start, end) {
    const savedPos = this.pos;
    const savedEnd = this.srcEnd;
    const savedBuildValue = this._buildValue;
    const savedUnbalanced = this._unbalanced;
    const errorCount = this._errors === null ? 0 : this._errors.length;
    this.pos = start;
    this.srcEnd = end;
    this._buildValue = true;
    this.readWordText();
    const value = this._wordText;
    this.pos = savedPos;
    this.srcEnd = savedEnd;
    this._buildValue = savedBuildValue;
    this._unbalanced = savedUnbalanced;
    if (this._errors !== null)
      this._errors.length = errorCount;
    return value;
  }
  findClosingBracket(start, end = this.srcEnd) {
    return this.findClosingShellDelimiter(start, end, CH_RBRACKET);
  }
  findClosingArithmeticBracket(start, end = this.srcEnd) {
    return this.findClosingShellDelimiter(start, end, CH_RBRACKET, false, false);
  }
  findClosingBrace(start, end = this.srcEnd) {
    return this.findClosingShellDelimiter(start, end, CH_RBRACE);
  }
  findClosingParenthesis(start, end = this.srcEnd) {
    const savedPos = this.pos;
    const savedEnd = this.srcEnd;
    const savedUnbalanced = this._unbalanced;
    this.pos = start;
    this.srcEnd = Math.min(end, this.srcEnd);
    this.extractBalanced();
    const close = this._unbalanced ? -1 : this.pos - 1;
    this.pos = savedPos;
    this.srcEnd = savedEnd;
    this._unbalanced = savedUnbalanced;
    return close;
  }
  findArithmeticExpansionEnd(start, end = this.srcEnd) {
    const scanner = new Lexer(this.src, start, end);
    scanner.pos = start + 1;
    scanner.scanArithmeticBody();
    return scanner.pos;
  }
  findArithmeticWordEnd(start, end = this.srcEnd) {
    const scanner = new Lexer(this.src, start, end);
    scanner.pos = start;
    return scanner.scanArithmeticWordEnd();
  }
  scanArithmeticWordEnd() {
    while (this.pos < this.srcEnd) {
      const ch = this.src.charCodeAt(this.pos);
      if (ch === CH_DOLLAR) {
        this.readDollar();
        continue;
      }
      if (ch === CH_BACKTICK) {
        this.readBacktickExpansion();
        continue;
      }
      if (ch === CH_SQUOTE) {
        this.pos++;
        this.skipSQ();
        continue;
      }
      if (ch === CH_DQUOTE) {
        this.pos++;
        this.skipDQ();
        continue;
      }
      if (ch === CH_BACKSLASH) {
        this.pos += 2;
        continue;
      }
      if (ch === CH_LBRACKET) {
        const close = this.findClosingBracket(this.pos + 1);
        if (close !== -1) {
          this.pos = close + 1;
          continue;
        }
      }
      if ((ch === CH_LT || ch === CH_GT) && this.src.charCodeAt(this.pos + 1) === CH_LPAREN) {
        this.pos += 2;
        this.extractBalanced();
        continue;
      }
      if (ch < 128 && arithmeticWordDelimiter[ch])
        break;
      this.pos++;
    }
    return this.pos;
  }
  findClosingShellDelimiter(start, end, closing, comments = false, braces = true) {
    const savedPos = this.pos;
    const savedEnd = this.srcEnd;
    const savedUnbalanced = this._unbalanced;
    this.srcEnd = Math.min(end, this.srcEnd);
    const delimiters = [closing];
    let pos = start;
    while (pos < this.srcEnd) {
      const ch = this.src.charCodeAt(pos);
      if (ch === CH_BACKSLASH) {
        pos += 2;
        continue;
      }
      if (ch === CH_HASH && comments && opensComment(this.src, pos, start)) {
        while (pos < this.srcEnd && this.src.charCodeAt(pos) !== CH_NL)
          pos++;
        continue;
      }
      if (ch === CH_SQUOTE) {
        this.pos = pos + 1;
        this.skipSQ();
        pos = this.pos;
        continue;
      }
      if (ch === CH_DQUOTE) {
        this.pos = pos + 1;
        this.skipDQ();
        pos = this.pos;
        continue;
      }
      if (ch === CH_BACKTICK) {
        pos++;
        while (pos < this.srcEnd && this.src.charCodeAt(pos) !== CH_BACKTICK) {
          if (this.src.charCodeAt(pos) === CH_BACKSLASH)
            pos++;
          pos++;
        }
        if (pos < this.srcEnd)
          pos++;
        continue;
      }
      if (ch === CH_DOLLAR && pos + 1 < this.srcEnd && this.src.charCodeAt(pos + 1) === CH_LPAREN || (ch === CH_LT || ch === CH_GT) && pos + 1 < this.srcEnd && this.src.charCodeAt(pos + 1) === CH_LPAREN) {
        this.pos = pos + 2;
        this.extractBalanced();
        pos = this.pos;
        continue;
      }
      const expected = delimiters[delimiters.length - 1];
      if (ch === CH_DOLLAR && pos + 1 < this.srcEnd) {
        const after = this.src.charCodeAt(pos + 1);
        if (after === CH_DOLLAR) {
          pos += 2;
          continue;
        }
        if (after === CH_LBRACE && braces) {
          delimiters.push(CH_RBRACE);
          pos += 2;
          continue;
        }
      }
      if (expected === CH_RBRACKET && ch === CH_LBRACKET) {
        delimiters.push(CH_RBRACKET);
      } else if (expected === CH_RPAREN && ch === CH_LPAREN) {
        delimiters.push(CH_RPAREN);
      } else if (ch === expected) {
        delimiters.pop();
        if (delimiters.length === 0) {
          this.pos = savedPos;
          this.srcEnd = savedEnd;
          this._unbalanced = savedUnbalanced;
          return pos;
        }
      }
      pos++;
    }
    this.pos = savedPos;
    this.srcEnd = savedEnd;
    this._unbalanced = savedUnbalanced;
    return -1;
  }
  skipSubshellBody() {
    this.extractBalanced();
    return this._unbalanced ? -1 : this.pos;
  }
  skipCompoundBody(closeToken) {
    const frames = [
      { close: closeToken, phase: closeToken === Token.Esac ? "case-pattern" : "commands" }
    ];
    let commandStart = true;
    for (;; ) {
      const value = this.next(commandStart ? LexContext.CommandStart : LexContext.Normal);
      const token = value.token;
      if (token === Token.EOF)
        return -1;
      const last = frames.length - 1;
      const frame = frames[last];
      if (frame.phase === "function-name") {
        if (token === Token.Newline)
          continue;
        frame.phase = "function-body";
        commandStart = true;
        continue;
      } else if (frame.phase === "function-body") {
        if (token === Token.Newline)
          continue;
        frame.phase = "commands";
        commandStart = true;
        if (token === Token.LParen && this.peek(LexContext.Normal).token === Token.RParen) {
          this.next(LexContext.Normal);
          frame.phase = "function-body";
          continue;
        }
      } else if (frame.phase === "coproc-command") {
        if (token === Token.Newline)
          continue;
        if (token === Token.Word) {
          frame.phase = "coproc-body";
          commandStart = true;
          continue;
        }
        frame.phase = "commands";
        commandStart = true;
      } else if (frame.phase === "coproc-body") {
        if (token === Token.Newline)
          continue;
        frame.phase = token === Token.Word && value.keywordEligible && value.value === "time" ? "time-command" : "commands";
        commandStart = true;
        if (frame.phase === "time-command")
          continue;
      } else if (frame.phase === "time-command") {
        if (token === Token.Word && value.keywordEligible && value.value === "-p") {
          frame.phase = "time-command-after-p";
          continue;
        }
        if (token === Token.Word && value.keywordEligible && value.value === "--") {
          frame.phase = "commands";
          continue;
        }
        frame.phase = "commands";
        commandStart = true;
      } else if (frame.phase === "time-command-after-p") {
        if (token === Token.Word && value.keywordEligible && value.value === "--") {
          frame.phase = "commands";
          continue;
        }
        frame.phase = "commands";
        commandStart = true;
      } else if (frame.phase === "for-header") {
        if (token === Token.ArithCmd || token === Token.Semi || token === Token.Newline) {
          commandStart = true;
          continue;
        }
        if (token === Token.Do || token === Token.LBrace) {
          frame.close = token === Token.Do ? Token.Done : Token.RBrace;
          frame.phase = "commands";
          commandStart = true;
          continue;
        }
      } else if (frame.phase === "case-word") {
        if (token === Token.Newline)
          continue;
        frame.phase = "case-in";
        commandStart = false;
        continue;
      } else if (frame.phase === "case-in") {
        if (token === Token.Newline) {
          commandStart = true;
          continue;
        }
        frame.phase = "case-pattern";
        commandStart = true;
        continue;
      } else if (frame.phase === "case-pattern") {
        if (token === Token.Esac && commandStart) {
          frames.pop();
          if (frames.length === 0)
            return value.end;
          commandStart = false;
          continue;
        }
        if (token === Token.RParen) {
          frame.phase = "commands";
          commandStart = true;
        } else {
          commandStart = token === Token.Newline;
        }
        continue;
      }
      if (token === frame.close) {
        frames.pop();
        if (frames.length === 0)
          return value.end;
        commandStart = false;
        continue;
      }
      if (commandStart) {
        switch (token) {
          case Token.LParen:
            frames.push({ close: Token.RParen, phase: "commands" });
            break;
          case Token.LBrace:
            frames.push({ close: Token.RBrace, phase: "commands" });
            break;
          case Token.If:
            frames.push({ close: Token.Fi, phase: "commands" });
            break;
          case Token.For:
            frames.push({ close: Token.Done, phase: "for-header" });
            break;
          case Token.While:
          case Token.Until:
          case Token.Select:
            frames.push({ close: Token.Done, phase: "commands" });
            break;
          case Token.Case:
            frames.push({ close: Token.Esac, phase: "case-word" });
            break;
          case Token.DblLBracket:
            if (!this.skipTestCommandBody())
              return -1;
            commandStart = false;
            continue;
          case Token.Assignment:
          case Token.Redirect:
          case Token.Bang:
          case Token.Then:
          case Token.Else:
          case Token.Elif:
          case Token.Do:
          case Token.In:
            break;
          case Token.Semi:
          case Token.Newline:
          case Token.Pipe:
          case Token.And:
          case Token.Or:
          case Token.Amp:
          case Token.DoubleSemi:
          case Token.SemiAmp:
          case Token.DoubleSemiAmp:
            break;
          case Token.Function:
            frame.phase = "function-name";
            break;
          case Token.Coproc:
            frame.phase = "coproc-command";
            break;
          default:
            if (token === Token.Word && value.keywordEligible && value.value === "time") {
              frame.phase = "time-command";
              commandStart = true;
            } else {
              commandStart = false;
            }
            continue;
        }
      }
      switch (token) {
        case Token.Semi:
        case Token.Newline:
        case Token.Pipe:
        case Token.And:
        case Token.Or:
        case Token.Amp:
          commandStart = true;
          break;
        case Token.DoubleSemi:
        case Token.SemiAmp:
        case Token.DoubleSemiAmp:
          if (frame.close === Token.Esac)
            frame.phase = "case-pattern";
          commandStart = true;
          break;
        case Token.RParen:
          commandStart = true;
          break;
      }
    }
  }
  skipTestGroup() {
    let depth = 1;
    for (;; ) {
      const value = this.next(LexContext.TestMode);
      if (value.token === Token.EOF)
        return -1;
      if (value.token === Token.DblRBracket) {
        this.unshift(value);
        return -1;
      }
      if (value.token === Token.LParen)
        depth++;
      else if (value.token === Token.RParen && --depth === 0)
        return value.end;
    }
  }
  skipTestCommandBody() {
    for (;; ) {
      const token = this.next(LexContext.TestMode).token;
      if (token === Token.DblRBracket)
        return true;
      if (token === Token.EOF)
        return false;
    }
  }
  buildWordParts(startPos) {
    this._buildParts = true;
    this.pos = startPos;
    const ch = this.src.charCodeAt(startPos);
    if ((ch === 60 || ch === 62) && startPos + 1 < this.srcEnd && this.src.charCodeAt(startPos + 1) === 40) {
      this.pos = startPos + 2;
      const inner = this.extractBalanced();
      if (this._unbalanced)
        this.errors.push({ message: "unterminated process substitution", pos: startPos });
      const text = this.src.slice(startPos, this.pos);
      const part = {
        type: "ProcessSubstitution",
        text,
        operator: ch === 60 ? "<" : ">",
        script: undefined,
        inner: inner ?? undefined,
        innerStart: startPos + 2
      };
      this.collect(part);
      if (this.pos < this.srcEnd) {
        this.readWordText();
        if (this._wordParts) {
          this._wordParts.unshift(part);
        } else {
          this._wordParts = [part];
        }
      } else {
        this._wordParts = [part];
      }
    } else {
      this.readWordText();
    }
    return this._wordParts;
  }
  buildEmbeddedWordParts(startPos) {
    this._buildParts = true;
    this.pos = startPos;
    this.readInnerWordText();
    return this._wordParts;
  }
  buildHereDocParts(bodyPos, bodyEnd) {
    this._buildParts = true;
    const src = this.src;
    const parts = [];
    let litBuf = "";
    let litStart = bodyPos;
    let i = bodyPos;
    const flushLit = () => {
      if (litBuf) {
        parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, i) });
        litBuf = "";
      }
    };
    while (i < bodyEnd) {
      const ch = src.charCodeAt(i);
      if (ch === 92) {
        if (i + 1 < bodyEnd) {
          const nc = src.charCodeAt(i + 1);
          if (nc === 36 || nc === 96 || nc === 92) {
            litBuf += String.fromCharCode(nc);
            i += 2;
            continue;
          }
        }
        litBuf += "\\";
        i++;
        continue;
      }
      if (ch === 36) {
        flushLit();
        litStart = i;
        this.pos = i;
        this.readDollar();
        if (this._resultPart) {
          parts.push(this._resultPart);
          litStart = this.pos;
        } else {
          litBuf += src.slice(i, this.pos);
        }
        i = this.pos;
        continue;
      }
      if (ch === 96) {
        flushLit();
        litStart = i;
        this.pos = i;
        this.readBacktickExpansion();
        if (this._resultPart) {
          parts.push(this._resultPart);
          litStart = this.pos;
        } else {
          litBuf += src.slice(i, this.pos);
        }
        i = this.pos;
        continue;
      }
      litBuf += src[i];
      i++;
    }
    flushLit();
    return parts.length > 1 || parts.length === 1 && parts[0].type !== "Literal" ? parts : null;
  }
  registerHereDocTarget(target) {
    if (this.pendingHereDocs === null)
      return;
    for (const hd of this.pendingHereDocs) {
      if (!hd.target) {
        hd.target = target;
        return;
      }
    }
  }
  readTestRegexWord() {
    this.hasPeek = false;
    this.skipSpacesAndTabs();
    const src = this.src;
    const len = this.srcEnd;
    const start = this.pos;
    let depth = 0;
    while (this.pos < len) {
      const ch = src.charCodeAt(this.pos);
      if (ch === CH_LPAREN) {
        depth++;
        this.pos++;
        continue;
      }
      if (ch === CH_BACKSLASH) {
        this.pos += this.pos + 1 < len ? 2 : 1;
        continue;
      }
      if (ch === CH_SQUOTE) {
        const quotePos = this.pos++;
        const ansiC = quotePos > start && src.charCodeAt(quotePos - 1) === CH_DOLLAR;
        while (this.pos < len && src.charCodeAt(this.pos) !== CH_SQUOTE) {
          if (ansiC && src.charCodeAt(this.pos) === CH_BACKSLASH && this.pos + 1 < len)
            this.pos++;
          this.pos++;
        }
        if (this.pos < len)
          this.pos++;
        else
          this.errors.push({
            message: ansiC ? "unterminated ANSI-C quote" : "unterminated single quote",
            pos: quotePos
          });
        continue;
      }
      if (ch === CH_DQUOTE) {
        this.pos++;
        this.readDoubleQuoted();
        continue;
      }
      if (ch === CH_BACKTICK) {
        this.readBacktickExpansion();
        continue;
      }
      if (depth > 0) {
        if (ch === CH_RPAREN)
          depth--;
        this.pos++;
        continue;
      }
      if (ch === CH_DOLLAR) {
        this.readDollar();
        continue;
      }
      if ((ch === CH_LT || ch === CH_GT) && this.pos + 1 < len && src.charCodeAt(this.pos + 1) === CH_LPAREN) {
        const subPos = this.pos;
        this.pos += 2;
        this.extractBalanced();
        if (this._unbalanced)
          this.errors.push({ message: "unterminated process substitution", pos: subPos });
        continue;
      }
      if (ch < 128 && charType[ch] & 1 && ch !== CH_PIPE)
        break;
      this.pos++;
    }
    setToken(this.current, Token.Word, src.slice(start, this.pos), start, this.pos);
    return this.current;
  }
  readCStyleForExprs() {
    this.hasPeek = false;
    const src = this.src;
    const len = this.srcEnd;
    while (this.pos < len && (src.charCodeAt(this.pos) === CH_SPACE || src.charCodeAt(this.pos) === CH_TAB))
      this.pos++;
    if (this.pos < len && src.charCodeAt(this.pos) === CH_LPAREN)
      this.pos++;
    const starts = [this.pos, 0, 0];
    const parts = ["", "", "", 0, 0, 0];
    let partIdx = 0;
    let depth = 1;
    let partStart = this.pos;
    while (this.pos < len && depth > 0) {
      const c = src.charCodeAt(this.pos);
      if (c === CH_LPAREN) {
        depth++;
        this.pos++;
      } else if (c === CH_RPAREN) {
        depth--;
        if (depth === 0) {
          const raw = src.slice(partStart, this.pos);
          parts[partIdx] = raw.trim();
          parts[3 + partIdx] = starts[partIdx] + raw.length - raw.trimStart().length;
          this.pos++;
          while (this.pos < len && (src.charCodeAt(this.pos) === CH_SPACE || src.charCodeAt(this.pos) === CH_TAB))
            this.pos++;
          if (this.pos < len && src.charCodeAt(this.pos) === CH_RPAREN)
            this.pos++;
          break;
        }
        this.pos++;
      } else if (c === CH_SEMI && depth === 1) {
        const raw = src.slice(partStart, this.pos);
        parts[partIdx] = raw.trim();
        parts[3 + partIdx] = starts[partIdx] + raw.length - raw.trimStart().length;
        if (partIdx < 2)
          partIdx++;
        this.pos++;
        partStart = this.pos;
        starts[partIdx] = partStart;
      } else if (c === CH_SQUOTE) {
        this.pos++;
        this.skipSQ();
      } else if (c === CH_DQUOTE) {
        this.pos++;
        this.skipDQ();
      } else {
        this.pos++;
      }
    }
    return parts;
  }
  peek(ctx = LexContext.Normal) {
    if (!this.hasPeek) {
      this.readNext(this.nextState, ctx);
      this.hasPeek = true;
    }
    return this.nextState;
  }
  peekFollow(closers) {
    if (!this.hasPeek) {
      const ctx = closers[this.current.token] ? LexContext.CommandStart : LexContext.Normal;
      this.readNext(this.nextState, ctx);
      this.hasPeek = true;
    }
    return this.nextState;
  }
  next(ctx = LexContext.Normal) {
    if (this.hasPeek) {
      this.hasPeek = false;
      const temp = this.current;
      this.current = this.nextState;
      this.nextState = temp;
      return this.current;
    }
    this.readNext(this.current, ctx);
    return this.current;
  }
  unshift(tok) {
    this.nextState.copyFrom(tok);
    this.hasPeek = true;
  }
  readNext(out, ctx) {
    const src = this.src;
    const len = this.srcEnd;
    let pos = this.pos;
    while (pos < len) {
      const ch2 = src.charCodeAt(pos);
      if (ch2 === CH_SPACE || ch2 === CH_TAB) {
        pos++;
        continue;
      }
      if (ch2 === CH_BACKSLASH && pos + 1 < len && src.charCodeAt(pos + 1) === CH_NL) {
        pos += 2;
        continue;
      }
      if (ch2 === CH_NL && ctx === LexContext.TestMode) {
        pos++;
        continue;
      }
      break;
    }
    this.pos = pos;
    if (pos >= len) {
      this.consumePendingHereDocs();
      setToken(out, Token.EOF, "", pos, pos);
      return;
    }
    const tokenStart = pos;
    const ch = src.charCodeAt(pos);
    if (ch === CH_HASH) {
      while (this.pos < len && src.charCodeAt(this.pos) !== CH_NL)
        this.pos++;
      this.readNext(out, ctx);
      return;
    }
    if (ch === CH_NL) {
      this.pos++;
      this.consumePendingHereDocs();
      setToken(out, Token.Newline, `
`, tokenStart, this.pos);
      return;
    }
    if (ctx === LexContext.TestMode && (ch === CH_LT || ch === CH_GT) && !(this.pos + 1 < this.srcEnd && src.charCodeAt(this.pos + 1) === CH_LPAREN)) {
      this.pos++;
      setToken(out, Token.Word, ch === CH_LT ? "<" : ">", tokenStart, this.pos);
      out.keywordEligible = true;
      return;
    }
    if (ch < 128 && charType[ch] & 1 && this.tryReadOperator(out, ch, ctx, tokenStart))
      return;
    this.readWord(out, ctx, tokenStart);
  }
  tryReadOperator(out, ch, ctx, tokenStart) {
    const src = this.src;
    const pos = this.pos;
    const next = pos + 1 < this.srcEnd ? src.charCodeAt(pos + 1) : 0;
    switch (ch) {
      case CH_SEMI:
        if (next === CH_SEMI) {
          if (pos + 2 < this.srcEnd && src.charCodeAt(pos + 2) === CH_AMP) {
            this.pos += 3;
            setToken(out, Token.DoubleSemiAmp, ";;&", tokenStart, this.pos);
            return true;
          }
          this.pos += 2;
          setToken(out, Token.DoubleSemi, ";;", tokenStart, this.pos);
          return true;
        }
        if (next === CH_AMP) {
          this.pos += 2;
          setToken(out, Token.SemiAmp, ";&", tokenStart, this.pos);
          return true;
        }
        this.pos++;
        setToken(out, Token.Semi, ";", tokenStart, this.pos);
        return true;
      case CH_PIPE:
        if (next === CH_PIPE) {
          this.pos += 2;
          setToken(out, Token.Or, "||", tokenStart, this.pos);
          return true;
        }
        if (next === CH_AMP) {
          this.pos += 2;
          setToken(out, Token.Pipe, "|&", tokenStart, this.pos);
          return true;
        }
        this.pos++;
        setToken(out, Token.Pipe, "|", tokenStart, this.pos);
        return true;
      case CH_AMP:
        if (next === CH_AMP) {
          this.pos += 2;
          setToken(out, Token.And, "&&", tokenStart, this.pos);
          return true;
        }
        if (next === CH_GT) {
          this.pos += 2;
          const append = this.pos < this.srcEnd && src.charCodeAt(this.pos) === CH_GT;
          if (append)
            this.pos++;
          this.skipSpacesAndTabs();
          const targetPos = this.pos;
          if (this.pos < this.srcEnd && src.charCodeAt(this.pos) !== CH_NL && src.charCodeAt(this.pos) !== CH_HASH) {
            this.readRedirectTargetText();
          }
          this.redirectToken(out, append ? "&>>" : "&>", tokenStart, targetPos);
          return true;
        }
        this.pos++;
        setToken(out, Token.Amp, "&", tokenStart, this.pos);
        return true;
      case CH_LPAREN:
        if (ctx === LexContext.CommandStart && next === CH_LPAREN) {
          const savedErrors = this.errors.length;
          this.readArithmeticCommand(out, tokenStart);
          if (!this._notArithmetic)
            return true;
          this.errors.length = savedErrors;
          this.pos = tokenStart;
        }
        this.pos++;
        setToken(out, Token.LParen, "(", tokenStart, this.pos);
        return true;
      case CH_RPAREN:
        this.pos++;
        setToken(out, Token.RParen, ")", tokenStart, this.pos);
        return true;
      case CH_LT:
      case CH_GT:
        return this.readRedirection(out, tokenStart);
      default:
        return false;
    }
  }
  readRedirection(out, tokenStart) {
    const src = this.src;
    const ch = src.charCodeAt(this.pos);
    let op = "";
    if (ch === CH_LT) {
      this.pos++;
      const next = this.pos < this.srcEnd ? src.charCodeAt(this.pos) : 0;
      if (next === CH_LT) {
        this.pos++;
        const third = this.pos < this.srcEnd ? src.charCodeAt(this.pos) : 0;
        if (third === CH_LT) {
          this.pos++;
          this.skipSpacesAndTabs();
          const targetPos2 = this.pos;
          if (this.pos < this.srcEnd && src.charCodeAt(this.pos) !== CH_NL && src.charCodeAt(this.pos) !== CH_HASH) {
            this.readRedirectTargetText();
          }
          this.redirectToken(out, "<<<", tokenStart, targetPos2);
          return true;
        }
        const dash = third === CH_DASH;
        if (dash)
          this.pos++;
        this.skipSpacesAndTabs();
        const targetPos = this.pos;
        if (this.pos >= this.srcEnd || src.charCodeAt(this.pos) !== CH_HASH)
          this.readHereDocDelimiter();
        const hasTarget = this.pos > targetPos;
        if (hasTarget) {
          (this.pendingHereDocs ??= []).push({ delimiter: this._hereDelim, strip: dash, quoted: this._hereQuoted });
        }
        setToken(out, Token.Redirect, dash ? "<<-" : "<<", tokenStart, this.pos);
        out.content = hasTarget ? this._hereDelim : undefined;
        out.targetPos = targetPos;
        out.targetEnd = hasTarget ? this.pos : targetPos;
        return true;
      }
      if (next === CH_LPAREN) {
        this.readProcessSubstitution(out, "<", tokenStart);
        return true;
      }
      if (next === CH_GT) {
        op = "<>";
        this.pos++;
      } else if (next === CH_AMP) {
        op = "<&";
        this.pos++;
      } else {
        op = "<";
      }
    } else if (ch === CH_GT) {
      this.pos++;
      const next = this.pos < this.srcEnd ? src.charCodeAt(this.pos) : 0;
      if (next === CH_LPAREN) {
        this.readProcessSubstitution(out, ">", tokenStart);
        return true;
      }
      if (next === CH_GT) {
        op = ">>";
        this.pos++;
      } else if (next === CH_AMP) {
        op = ">&";
        this.pos++;
      } else if (next === CH_PIPE) {
        op = ">|";
        this.pos++;
      } else {
        op = ">";
      }
    }
    this.skipSpacesAndTabs();
    if (this.pos < this.srcEnd) {
      const nc = src.charCodeAt(this.pos);
      if ((nc === CH_LT || nc === CH_GT) && this.pos + 1 < this.srcEnd && src.charCodeAt(this.pos + 1) === CH_LPAREN) {
        const psStart = this.pos;
        this.pos += 2;
        this.extractBalanced();
        if (this._unbalanced)
          this.errors.push({ message: "unterminated process substitution", pos: psStart });
        const psText = src.slice(psStart, this.pos);
        setToken(out, Token.Redirect, op, tokenStart, this.pos);
        out.content = psText;
        out.targetPos = psStart;
        out.targetEnd = this.pos;
        return true;
      }
      const targetPos = this.pos;
      if (nc !== CH_NL && nc !== CH_HASH)
        this.readRedirectTargetText();
      this.redirectToken(out, op, tokenStart, targetPos);
      return true;
    }
    this.redirectToken(out, op, tokenStart, this.pos);
    return true;
  }
  readRedirectTargetText() {
    const savedBuildValue = this._buildValue;
    this._buildValue = true;
    this.readWordText();
    this._buildValue = savedBuildValue;
  }
  redirectToken(out, operator, tokenStart, targetPos) {
    const hasTarget = this.pos > targetPos && (this._wordText.length > 0 || this._wordQuoted);
    setToken(out, Token.Redirect, operator, tokenStart, this.pos);
    out.content = hasTarget ? this._wordText : undefined;
    out.targetPos = targetPos;
    out.targetEnd = hasTarget ? this.pos : targetPos;
  }
  readProcessSubstitution(out, operator, tokenStart) {
    this.pos++;
    this.extractBalanced();
    if (this._unbalanced)
      this.errors.push({ message: "unterminated process substitution", pos: tokenStart });
    const text = this.src.slice(tokenStart, this.pos);
    setToken(out, Token.Word, text, tokenStart, this.pos);
  }
  readHereDocDelimiter() {
    const src = this.src;
    const len = this.srcEnd;
    const savedBuildValue = this._buildValue;
    this._buildValue = true;
    let delimiter = "";
    let quoted = false;
    while (this.pos < len) {
      const c = src.charCodeAt(this.pos);
      if (c === CH_SQUOTE) {
        quoted = true;
        this.pos++;
        while (this.pos < len && src.charCodeAt(this.pos) !== CH_SQUOTE) {
          delimiter += src[this.pos];
          this.pos++;
        }
        if (this.pos < len)
          this.pos++;
      } else if (c === CH_DQUOTE) {
        quoted = true;
        this.pos++;
        while (this.pos < len && src.charCodeAt(this.pos) !== CH_DQUOTE) {
          if (src.charCodeAt(this.pos) === CH_BACKSLASH && this.pos + 1 < len) {
            const next = src.charCodeAt(this.pos + 1);
            if (next === CH_NL) {
              this.pos += 2;
              continue;
            }
            if (next === CH_DOLLAR || next === CH_BACKTICK || next === CH_DQUOTE || next === CH_BACKSLASH)
              this.pos++;
          }
          delimiter += src[this.pos];
          this.pos++;
        }
        if (this.pos < len)
          this.pos++;
      } else if (c === CH_BACKSLASH) {
        if (this.pos + 1 < len && src.charCodeAt(this.pos + 1) === CH_NL) {
          this.pos += 2;
          continue;
        }
        quoted = true;
        this.pos++;
        if (this.pos < len) {
          delimiter += src[this.pos];
          this.pos++;
        } else {
          delimiter += "\\";
        }
      } else if (c === CH_BACKTICK) {
        const btStart = this.pos;
        this.pos++;
        while (this.pos < len && src.charCodeAt(this.pos) !== CH_BACKTICK) {
          if (src.charCodeAt(this.pos) === CH_BACKSLASH)
            this.pos++;
          this.pos++;
        }
        if (this.pos < len)
          this.pos++;
        delimiter += src.slice(btStart, this.pos);
      } else if (c === CH_DOLLAR) {
        const next = this.pos + 1 < len ? src.charCodeAt(this.pos + 1) : 0;
        if (next === CH_SQUOTE || next === CH_DQUOTE)
          quoted = true;
        this.readDollar();
        delimiter += this._resultText;
      } else if (c < 128 && charType[c] & 1) {
        break;
      } else {
        delimiter += src[this.pos];
        this.pos++;
      }
    }
    this._buildValue = savedBuildValue;
    this._hereDelim = delimiter;
    this._hereQuoted = quoted;
  }
  consumePendingHereDocs() {
    const pending = this.pendingHereDocs;
    if (pending === null || pending.length === 0)
      return;
    for (const hd of pending) {
      const bodyPos = this.pos;
      const body = this.readHereDocBody(hd.delimiter, hd.strip);
      if (hd.target) {
        hd.target.content = body;
        if (hd.quoted) {
          hd.target.heredocQuoted = true;
        } else if (body) {
          const parsed = this.parseHereDocBody(body, bodyPos);
          if (parsed)
            hd.target.body = parsed;
        }
      }
    }
    pending.length = 0;
  }
  readHereDocBody(delimiter, strip) {
    const bodyStart = this.pos;
    const bodyEnd = this.skipHereDocBody(delimiter, strip);
    return this.src.slice(bodyStart, bodyEnd);
  }
  matchHereDocDelimiter(delimiter, lineStart, end, join) {
    const src = this.src;
    let pos = lineStart;
    for (let i = 0;i < delimiter.length; ) {
      if (join && src.charCodeAt(pos) === CH_BACKSLASH && pos + 1 < end && src.charCodeAt(pos + 1) === CH_NL) {
        pos += 2;
        continue;
      }
      if (pos >= end || src.charCodeAt(pos) !== delimiter.charCodeAt(i))
        return -1;
      pos++;
      i++;
    }
    return pos;
  }
  logicalLineEnd(from, end, join) {
    const src = this.src;
    let pos = from;
    while (pos < end) {
      const c = src.charCodeAt(pos);
      if (c === CH_NL)
        return pos;
      pos += join && c === CH_BACKSLASH ? 2 : 1;
    }
    return end;
  }
  skipHereDocBody(delimiter, strip, parenEnds = false, quoted = false) {
    const src = this.src;
    const len = this.srcEnd;
    const dLen = delimiter.length;
    while (this.pos < len) {
      let lineStart = this.pos;
      let lineEnd = src.indexOf(`
`, this.pos);
      if (lineEnd === -1 || lineEnd > len)
        lineEnd = len;
      if (strip) {
        while (lineStart < lineEnd && src.charCodeAt(lineStart) === CH_TAB)
          lineStart++;
      }
      if (lineEnd - lineStart === dLen && src.startsWith(delimiter, lineStart)) {
        const bodyEnd = this.pos;
        this.pos = lineEnd < len ? lineEnd + 1 : lineEnd;
        return bodyEnd;
      }
      if (parenEnds) {
        const afterDelim = this.matchHereDocDelimiter(delimiter, lineStart, len, !quoted);
        if (afterDelim !== -1) {
          const paren = src.indexOf(")", afterDelim);
          if (paren !== -1 && paren < this.logicalLineEnd(lineStart, len, !quoted)) {
            const bodyEnd = this.pos;
            this.pos = afterDelim;
            return bodyEnd;
          }
        }
      }
      this.pos = lineEnd < len ? lineEnd + 1 : lineEnd;
    }
    return this.pos;
  }
  parseHereDocBody(body, bodyPos) {
    let hasExpansion = false;
    for (let i = 0;i < body.length; i++) {
      const c = body.charCodeAt(i);
      if (c === CH_BACKTICK) {
        hasExpansion = true;
        break;
      }
      if (c === CH_DOLLAR) {
        const next = i + 1 < body.length ? body.charCodeAt(i + 1) : 0;
        if (next === CH_LBRACE || next === CH_LPAREN || next === CH_DOLLAR || next >= CH_a && next <= CH_z || next >= CH_A && next <= CH_Z || next === CH_UNDERSCORE || next === CH_BANG || next === CH_HASH || next === CH_AT || next === CH_STAR || next === CH_QUESTION || next === CH_DASH || next >= CH_0 && next <= CH_9) {
          hasExpansion = true;
          break;
        }
      }
      if (c === CH_BACKSLASH)
        i++;
    }
    if (!hasExpansion)
      return null;
    return new WordImpl(body, bodyPos, bodyPos + body.length, this.src, WordImpl._resolveHeredocBody, this._nestingDepth);
  }
  _wordText = "";
  _wordRaw = false;
  _wordQuoted = false;
  _wordHasExpansions = false;
  _wordKeywordEligible = false;
  _wordIsAssignment;
  _wordAssignmentOperatorPos;
  _wordParts = null;
  _resultText = "";
  _resultIsRaw = true;
  _resultHasExpansion = false;
  _resultPart;
  _unbalanced = false;
  _notArithmetic = false;
  _dqText = "";
  _dqHasExpansions = false;
  _dqParts = null;
  _dqEnd = 0;
  _hereDelim = "";
  _hereQuoted = false;
  readWord(out, ctx, tokenStart = 0) {
    this.readWordText();
    this.classifyWord(out, ctx, tokenStart);
  }
  classifyWord(out, ctx, tokenStart) {
    const src = this.src;
    const raw = this._wordRaw;
    const hasExpansions = this._wordHasExpansions;
    const quoted = this._wordQuoted;
    const keywordEligible = this._wordKeywordEligible;
    const isAssignment = this._wordIsAssignment;
    let assignmentOpPos = this._wordAssignmentOperatorPos;
    const wordEnd = this.pos;
    const wordLen = wordEnd - tokenStart;
    let value = null;
    if (!raw && !hasExpansions) {
      const nextCh = wordEnd < this.srcEnd ? src.charCodeAt(wordEnd) : 0;
      if (!quoted && wordLen <= 16 || nextCh === CH_LT || nextCh === CH_GT) {
        value = this.wordValueOf(tokenStart, wordEnd);
      }
    }
    if (ctx === LexContext.CommandStart && keywordEligible) {
      if (raw) {
        if (wordLen <= 8) {
          const reserved = matchReservedWord(src, tokenStart, wordLen);
          if (reserved !== undefined) {
            setSpanToken(out, reserved, tokenStart, wordEnd, true);
            return;
          }
        }
        if (wordLen === 2 && src.charCodeAt(tokenStart) === CH_LBRACKET && src.charCodeAt(tokenStart + 1) === CH_LBRACKET) {
          setSpanToken(out, Token.DblLBracket, tokenStart, wordEnd, true);
          return;
        }
      } else if (value !== null && value.length > 0) {
        const fc = value.charCodeAt(0);
        if (fc >= CH_a && fc <= CH_z && value.length <= 8 || fc === CH_BANG || fc === CH_LBRACE || fc === CH_RBRACE) {
          const reserved = RESERVED_WORDS.get(value);
          if (reserved !== undefined) {
            setToken(out, reserved, value, tokenStart, wordEnd);
            return;
          }
        }
        if (fc === CH_LBRACKET && value === "[[") {
          setToken(out, Token.DblLBracket, value, tokenStart, wordEnd);
          return;
        }
      }
    }
    if (ctx === LexContext.CommandStart || ctx === LexContext.CommandPrefix) {
      if (isAssignment === undefined) {
        let eq = -1;
        let bracket = false;
        for (let i = tokenStart + 1;i < wordEnd; i++) {
          const c = src.charCodeAt(i);
          if (c === CH_EQ) {
            eq = i;
            break;
          }
          if (c === CH_LBRACKET)
            bracket = true;
        }
        if (eq !== -1) {
          const state = scanAssignmentPrefix(src, tokenStart, wordEnd, ASSIGNMENT_NAME_START);
          if (isMatchedAssignment(state))
            assignmentOpPos = assignmentOperatorPos(state);
        } else if (bracket && wordEnd < this.srcEnd && scanAssignmentPrefix(src, tokenStart, wordEnd, ASSIGNMENT_NAME_START) >= ASSIGNMENT_INDEX_BASE) {
          this.pos = tokenStart;
          this.readWordText(true);
          this.classifyWord(out, ctx, tokenStart);
          return;
        }
      }
      if (assignmentOpPos !== undefined) {
        setSpanToken(out, Token.Assignment, tokenStart, wordEnd, raw);
        if (value !== null)
          out._value = value;
        out.assignmentOperatorPos = assignmentOpPos;
        return;
      }
    }
    if ((ctx === LexContext.CommandStart || ctx === LexContext.TestMode) && keywordEligible) {
      if (raw) {
        if (wordLen === 2 && src.charCodeAt(tokenStart) === CH_RBRACKET && src.charCodeAt(tokenStart + 1) === CH_RBRACKET) {
          setSpanToken(out, Token.DblRBracket, tokenStart, wordEnd, true);
          return;
        }
      } else if (value === "]]") {
        setToken(out, Token.DblRBracket, value, tokenStart, wordEnd);
        return;
      }
    }
    if (!hasExpansions && this.pos < this.srcEnd) {
      const nc = src.charCodeAt(this.pos);
      if (nc === CH_LT || nc === CH_GT) {
        if (raw) {
          const fc = src.charCodeAt(tokenStart);
          if (fc >= CH_0 && fc <= CH_9 && isAllDigitsRange(src, tokenStart, wordEnd)) {
            const fd = Number.parseInt(src.slice(tokenStart, wordEnd), 10);
            if (this.readRedirection(out, tokenStart)) {
              out.fileDescriptor = fd;
              return;
            }
          }
          if (fc === CH_LBRACE && wordLen > 2 && src.charCodeAt(wordEnd - 1) === CH_RBRACE) {
            const varname = src.slice(tokenStart + 1, wordEnd - 1);
            if (this.readRedirection(out, tokenStart)) {
              out.variableName = varname;
              return;
            }
          }
        } else if (value !== null && value.length > 0) {
          if (value.charCodeAt(0) >= CH_0 && value.charCodeAt(0) <= CH_9 && isAllDigits(value)) {
            const fd = Number.parseInt(value, 10);
            if (this.readRedirection(out, tokenStart)) {
              out.fileDescriptor = fd;
              return;
            }
          }
          if (value.charCodeAt(0) === CH_LBRACE && value.charCodeAt(value.length - 1) === CH_RBRACE && value.length > 2) {
            const varname = value.slice(1, -1);
            if (this.readRedirection(out, tokenStart)) {
              out.variableName = varname;
              return;
            }
          }
        }
      }
    }
    setSpanToken(out, Token.Word, tokenStart, wordEnd, raw);
    if (value !== null)
      out._value = value;
    out.keywordEligible = keywordEligible;
  }
  readWordText(subscripts = false) {
    const src = this.src;
    const len = this.srcEnd;
    let pos = this.pos;
    const fastStart = pos;
    let exitCh = 0;
    while (pos < len) {
      const c = src.charCodeAt(pos);
      if (c < 128 && charType[c]) {
        exitCh = c;
        break;
      }
      pos++;
    }
    if (pos >= len || charType[exitCh] & 1 && !(exitCh === CH_LPAREN && pos > fastStart && extglobPrefix[src.charCodeAt(pos - 1)]) && !subscripts) {
      this.pos = pos;
      this._wordText = (this._buildParts || this._buildValue) && pos > fastStart ? src.slice(fastStart, pos) : "";
      this._wordRaw = true;
      this._wordQuoted = false;
      this._wordHasExpansions = false;
      this._wordKeywordEligible = true;
      this._wordIsAssignment = undefined;
      this._wordAssignmentOperatorPos = undefined;
      if (this._buildParts)
        this._wordParts = null;
      return;
    }
    const bp = this._buildParts;
    const bt = bp || this._buildValue;
    let text = bt && pos > fastStart ? src.slice(fastStart, pos) : "";
    let quoted = false;
    let hasExpansions = false;
    let keywordEligible = true;
    let valueIsRaw = true;
    let lastValueChar = pos > fastStart ? src.charCodeAt(pos - 1) : 0;
    let assignmentState = scanAssignmentPrefix(src, fastStart, pos, ASSIGNMENT_NAME_START);
    let parts;
    let litBuf = "";
    let litStart = 0;
    if (bp) {
      parts = [];
      litBuf = text;
      litStart = fastStart;
    }
    while (pos < len) {
      const ch = src.charCodeAt(pos);
      if (ch >= 128 || !charType[ch]) {
        const runStart = pos;
        pos++;
        while (pos < len) {
          const c = src.charCodeAt(pos);
          if (c < 128 && charType[c])
            break;
          pos++;
        }
        lastValueChar = src.charCodeAt(pos - 1);
        assignmentState = scanAssignmentPrefix(src, runStart, pos, assignmentState);
        if (bt) {
          const chunk = src.slice(runStart, pos);
          text += chunk;
          if (bp)
            litBuf += chunk;
        }
        continue;
      }
      if (charType[ch] & 1) {
        if (ch === CH_LPAREN && lastValueChar < 128 && extglobPrefix[lastValueChar]) {
          keywordEligible = false;
          const prefixChar = lastValueChar;
          pos++;
          const innerStart = pos;
          const close = this.findClosingShellDelimiter(innerStart, len, CH_RPAREN, prefixChar === CH_EQ);
          const patternEnd = close === -1 ? len : close;
          pos = close === -1 ? len : close + 1;
          if (close === -1)
            this.errors.push({ message: "unterminated extended glob", pos: innerStart - 2 });
          lastValueChar = src.charCodeAt(pos - 1);
          if (bt) {
            const eg = "(" + src.slice(innerStart, pos);
            text += eg;
            if (bp && prefixChar !== CH_EQ) {
              if (litBuf.length > 0) {
                const trimmed = litBuf.slice(0, -1);
                if (trimmed)
                  parts.push({ type: "Literal", value: trimmed, text: src.slice(litStart, innerStart - 2) });
                litBuf = "";
              }
              const op = extglobOp[prefixChar];
              parts.push({
                type: "ExtendedGlob",
                text: op + eg,
                operator: op,
                pattern: src.slice(innerStart, patternEnd),
                parts: hasEmbeddedWordStructure(src, innerStart, patternEnd) ? this.parseSubFieldWord(innerStart, patternEnd).parts : undefined
              });
              litStart = pos;
            } else if (bp) {
              litBuf += eg;
            }
          }
          continue;
        }
        if (subscripts && assignmentState >= ASSIGNMENT_INDEX_BASE) {
          const close = this.findClosingBracket(pos);
          if (close !== -1) {
            const spanEnd = close + 1;
            assignmentState = scanAssignmentPrefix(src, pos, spanEnd, assignmentState);
            lastValueChar = src.charCodeAt(close);
            if (bt) {
              const chunk = src.slice(pos, spanEnd);
              text += chunk;
              if (bp)
                litBuf += chunk;
            }
            pos = spanEnd;
            continue;
          }
        }
        break;
      }
      if (ch === CH_BACKSLASH) {
        pos++;
        if (pos < len) {
          if (src.charCodeAt(pos) === CH_NL) {
            pos++;
            valueIsRaw = false;
          } else {
            if (assignmentState >= 0 && assignmentState < ASSIGNMENT_INDEX_BASE)
              assignmentState = ASSIGNMENT_INVALID;
            quoted = true;
            keywordEligible = false;
            valueIsRaw = false;
            lastValueChar = src.charCodeAt(pos);
            if (bt) {
              text += src[pos];
              if (bp)
                litBuf += src[pos];
            }
            pos++;
          }
        } else {
          if (assignmentState >= 0 && assignmentState < ASSIGNMENT_INDEX_BASE)
            assignmentState = ASSIGNMENT_INVALID;
          quoted = true;
          keywordEligible = false;
          lastValueChar = CH_BACKSLASH;
          if (bt) {
            text += "\\";
            if (bp)
              litBuf += "\\";
          }
        }
        continue;
      }
      if (ch === CH_SQUOTE) {
        const sqStart = pos;
        if (assignmentState >= 0 && assignmentState < ASSIGNMENT_INDEX_BASE)
          assignmentState = ASSIGNMENT_INVALID;
        quoted = true;
        keywordEligible = false;
        valueIsRaw = false;
        pos++;
        const start = pos;
        while (pos < len && src.charCodeAt(pos) !== CH_SQUOTE)
          pos++;
        if (pos > start)
          lastValueChar = src.charCodeAt(pos - 1);
        const value = bt ? src.slice(start, pos) : "";
        if (bt)
          text += value;
        if (pos < len)
          pos++;
        else
          this.errors.push({ message: "unterminated single quote", pos: start - 1 });
        if (bp) {
          if (litBuf) {
            parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, sqStart) });
            litBuf = "";
          }
          parts.push({ type: "SingleQuoted", value, text: src.slice(sqStart, pos) });
          litStart = pos;
        }
        continue;
      }
      if (ch === CH_DQUOTE) {
        const dqStart = pos;
        if (assignmentState >= 0 && assignmentState < ASSIGNMENT_INDEX_BASE)
          assignmentState = ASSIGNMENT_INVALID;
        quoted = true;
        keywordEligible = false;
        valueIsRaw = false;
        pos++;
        this.pos = pos;
        this.readDoubleQuoted();
        pos = this.pos;
        if (this._dqEnd > dqStart + 1)
          lastValueChar = src.charCodeAt(this._dqEnd - 1);
        if (this._dqHasExpansions)
          hasExpansions = true;
        if (bt)
          text += this._dqText;
        if (bp) {
          if (litBuf) {
            parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, dqStart) });
            litBuf = "";
          }
          const dqText = src.slice(dqStart, pos);
          parts.push({
            type: "DoubleQuoted",
            text: dqText,
            parts: this._dqParts ?? [
              { type: "Literal", value: this._dqText, text: src.slice(dqStart + 1, this._dqEnd) }
            ]
          });
          litStart = pos;
        }
        continue;
      }
      if (ch === CH_DOLLAR) {
        keywordEligible = false;
        const dollarStart = pos;
        if (assignmentState >= 0 && assignmentState < ASSIGNMENT_INDEX_BASE)
          assignmentState = ASSIGNMENT_INVALID;
        this.pos = pos;
        this.readDollar();
        pos = this.pos;
        if (!this._resultIsRaw)
          valueIsRaw = false;
        if (pos > dollarStart)
          lastValueChar = src.charCodeAt(pos - 1);
        if (this._resultHasExpansion)
          hasExpansions = true;
        if (bt)
          text += this._resultText;
        if (bp) {
          if (this._resultPart) {
            if (litBuf) {
              parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, dollarStart) });
              litBuf = "";
            }
            parts.push(this._resultPart);
            litStart = pos;
          } else {
            litBuf += this._resultText;
          }
        }
        continue;
      }
      if (ch === CH_BACKTICK) {
        keywordEligible = false;
        const btStart = pos;
        if (assignmentState >= 0 && assignmentState < ASSIGNMENT_INDEX_BASE)
          assignmentState = ASSIGNMENT_INVALID;
        this.pos = pos;
        this.readBacktickExpansion();
        pos = this.pos;
        valueIsRaw = false;
        lastValueChar = src.charCodeAt(pos - 1);
        hasExpansions = true;
        if (bt)
          text += this._resultText;
        if (bp) {
          if (litBuf) {
            parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, btStart) });
            litBuf = "";
          }
          parts.push(this._resultPart);
          litStart = pos;
        }
        continue;
      }
      if (ch === CH_LBRACE) {
        if (assignmentState >= 0 && assignmentState < ASSIGNMENT_INDEX_BASE)
          assignmentState = ASSIGNMENT_INVALID;
        const braceEnd = scanBraceExpansion(src, pos, len);
        if (braceEnd > 0) {
          keywordEligible = false;
          lastValueChar = src.charCodeAt(braceEnd - 1);
          if (bt) {
            const braceText = src.slice(pos, braceEnd);
            text += braceText;
            if (bp) {
              if (litBuf) {
                parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, pos) });
                litBuf = "";
              }
              parts.push({
                type: "BraceExpansion",
                text: braceText,
                parts: hasEmbeddedWordStructure(src, pos + 1, braceEnd - 1) ? this.parseSubFieldWord(pos + 1, braceEnd - 1).parts : undefined
              });
              litStart = braceEnd;
            }
          }
          pos = braceEnd;
          continue;
        }
        lastValueChar = CH_LBRACE;
        if (bt) {
          text += "{";
          if (bp)
            litBuf += "{";
        }
        pos++;
        continue;
      }
      pos++;
    }
    if (bp && litBuf)
      parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, pos) });
    this.pos = pos;
    this._wordText = text;
    this._wordRaw = valueIsRaw;
    this._wordQuoted = quoted;
    this._wordHasExpansions = hasExpansions;
    this._wordKeywordEligible = keywordEligible;
    this._wordIsAssignment = isMatchedAssignment(assignmentState);
    this._wordAssignmentOperatorPos = this._wordIsAssignment ? assignmentOperatorPos(assignmentState) : undefined;
    if (bp) {
      this._wordParts = parts.length > 1 || parts.length === 1 && parts[0].type !== "Literal" ? parts : null;
    }
  }
  readInnerWordText() {
    const src = this.src;
    const len = this.srcEnd;
    let pos = this.pos;
    let text = "";
    const bp = this._buildParts;
    let parts;
    let litBuf = "";
    let litStart = 0;
    if (bp) {
      parts = [];
      litStart = pos;
    }
    while (pos < len) {
      const ch = src.charCodeAt(pos);
      if (ch === CH_BACKSLASH) {
        pos++;
        if (pos < len) {
          if (src.charCodeAt(pos) === CH_NL) {
            pos++;
          } else {
            const escaped = src[pos++];
            text += escaped;
            if (bp)
              litBuf += escaped;
          }
        }
        continue;
      }
      if (ch === CH_SQUOTE) {
        const sqStart = pos;
        pos++;
        const start = pos;
        while (pos < len && src.charCodeAt(pos) !== CH_SQUOTE)
          pos++;
        const value = src.slice(start, pos);
        text += value;
        if (pos < len)
          pos++;
        if (bp) {
          if (litBuf) {
            parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, sqStart) });
            litBuf = "";
          }
          parts.push({ type: "SingleQuoted", value, text: src.slice(sqStart, pos) });
          litStart = pos;
        }
        continue;
      }
      if (ch === CH_DQUOTE) {
        const dqStart = pos;
        pos++;
        this.pos = pos;
        this.readDoubleQuoted();
        pos = this.pos;
        text += this._dqText;
        if (bp) {
          if (litBuf) {
            parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, dqStart) });
            litBuf = "";
          }
          const dqText = src.slice(dqStart, pos);
          parts.push({
            type: "DoubleQuoted",
            text: dqText,
            parts: this._dqParts ?? [
              { type: "Literal", value: this._dqText, text: src.slice(dqStart + 1, this._dqEnd) }
            ]
          });
          litStart = pos;
        }
        continue;
      }
      if (ch === CH_DOLLAR) {
        const dollarStart = pos;
        this.pos = pos;
        this.readDollar();
        pos = this.pos;
        text += this._resultText;
        if (bp) {
          if (this._resultPart) {
            if (litBuf) {
              parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, dollarStart) });
              litBuf = "";
            }
            parts.push(this._resultPart);
            litStart = pos;
          } else {
            litBuf += this._resultText;
          }
        }
        continue;
      }
      if (ch === CH_BACKTICK) {
        const btStart = pos;
        this.pos = pos;
        this.readBacktickExpansion();
        pos = this.pos;
        text += this._resultText;
        if (bp) {
          if (litBuf) {
            parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, btStart) });
            litBuf = "";
          }
          parts.push(this._resultPart);
          litStart = pos;
        }
        continue;
      }
      if ((ch === CH_LT || ch === CH_GT) && pos + 1 < len && src.charCodeAt(pos + 1) === CH_LPAREN) {
        const psStart = pos;
        this.pos = pos + 2;
        const inner = this.extractBalanced();
        pos = this.pos;
        const raw = src.slice(psStart, pos);
        text += raw;
        if (bp) {
          if (litBuf) {
            parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, psStart) });
            litBuf = "";
          }
          const part = {
            type: "ProcessSubstitution",
            text: raw,
            operator: ch === CH_LT ? "<" : ">",
            script: undefined,
            inner,
            innerStart: psStart + 2
          };
          parts.push(part);
          this.collect(part);
          litStart = pos;
        }
        continue;
      }
      text += src[pos];
      if (bp)
        litBuf += src[pos];
      pos++;
    }
    if (bp && litBuf)
      parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, pos) });
    this.pos = pos;
    this._wordText = text;
    this._wordRaw = false;
    this._wordQuoted = false;
    this._wordHasExpansions = false;
    this._wordKeywordEligible = false;
    if (bp) {
      this._wordParts = parts.length > 1 || parts.length === 1 && parts[0].type !== "Literal" ? parts : null;
    }
  }
  parseSubFieldWord(start, end) {
    if (start >= end)
      return new WordImpl("", start, start);
    if (this._nestingDepth >= MAX_SYNTAX_NESTING)
      return new WordImpl(this.src.slice(start, end), start, end);
    this._nestingDepth++;
    const savedEnd = this.srcEnd;
    const savedPos = this.pos;
    const savedText = this._wordText;
    const savedParts = this._wordParts;
    const savedQuoted = this._wordQuoted;
    const savedKeywordEligible = this._wordKeywordEligible;
    this.srcEnd = end;
    this.pos = start;
    this.readInnerWordText();
    const word = new WordImpl(this.src.slice(start, end), start, end);
    if (this._buildParts && this._wordParts) {
      word.parts = this._wordParts;
    }
    this.srcEnd = savedEnd;
    this.pos = savedPos;
    this._wordText = savedText;
    this._wordParts = savedParts;
    this._wordQuoted = savedQuoted;
    this._wordKeywordEligible = savedKeywordEligible;
    this._nestingDepth--;
    return word;
  }
  skipSQ() {
    while (this.pos < this.srcEnd && this.src.charCodeAt(this.pos) !== CH_SQUOTE)
      this.pos++;
    if (this.pos < this.srcEnd)
      this.pos++;
  }
  skipAnsiCQuoted() {
    const quotePos = this.pos - 1;
    const result = decodeAnsiCQuoted(this.src, this.pos, this.srcEnd);
    this.pos = result.end;
    if (!result.closed)
      this.errors.push({ message: "unterminated ANSI-C quote", pos: quotePos });
  }
  skipDQ() {
    const src = this.src;
    const len = this.srcEnd;
    while (this.pos < len) {
      const ch = src.charCodeAt(this.pos);
      if (ch === CH_DQUOTE) {
        this.pos++;
        return;
      }
      if (ch === CH_BACKSLASH) {
        this.pos += 2;
        continue;
      }
      if (ch === CH_DOLLAR && this.pos + 1 < len) {
        const next = src.charCodeAt(this.pos + 1);
        if (next === CH_LPAREN) {
          const csStart = this.pos;
          this.pos += 2;
          this.extractBalanced();
          if (this._unbalanced)
            this.errors.push({ message: "unterminated command substitution", pos: csStart });
          continue;
        }
        if (next === CH_LBRACE) {
          this.pos += 2;
          let d = 1;
          while (this.pos < len && d > 0) {
            const c = src.charCodeAt(this.pos);
            if (c === CH_RBRACE) {
              if (--d === 0) {
                this.pos++;
                break;
              }
            } else if (c === CH_LBRACE && this.pos > 0 && src.charCodeAt(this.pos - 1) === CH_DOLLAR)
              d++;
            else if (c === CH_BACKSLASH) {
              this.pos++;
            } else if (c === CH_SQUOTE) {
              this.pos++;
              this.skipSQ();
              continue;
            } else if (c === CH_DQUOTE) {
              this.pos++;
              this.skipDQ();
              continue;
            }
            this.pos++;
          }
          continue;
        }
      }
      if (ch === CH_BACKTICK) {
        this.pos++;
        while (this.pos < len && src.charCodeAt(this.pos) !== CH_BACKTICK) {
          if (src.charCodeAt(this.pos) === CH_BACKSLASH)
            this.pos++;
          this.pos++;
        }
        if (this.pos < len)
          this.pos++;
        continue;
      }
      this.pos++;
    }
  }
  skipSpacesAndTabs() {
    const src = this.src;
    const len = this.srcEnd;
    while (this.pos < len) {
      const ch = src.charCodeAt(this.pos);
      if (ch === CH_SPACE || ch === CH_TAB)
        this.pos++;
      else if (ch === CH_BACKSLASH && this.pos + 1 < len && src.charCodeAt(this.pos + 1) === CH_NL)
        this.pos += 2;
      else
        break;
    }
  }
  readDoubleQuoted() {
    const src = this.src;
    const len = this.srcEnd;
    const contentStart = this.pos;
    let hasExpansions = false;
    const bp = this._buildParts;
    const bt = bp || this._buildValue;
    if (!bp) {
      let p = this.pos;
      while (p < len) {
        const c = src.charCodeAt(p);
        if (c === CH_DQUOTE) {
          this._dqText = bt ? src.slice(contentStart, p) : "";
          this._dqEnd = p;
          this.pos = p + 1;
          this._dqHasExpansions = false;
          this._dqParts = null;
          return;
        }
        if (c === CH_DOLLAR || c === CH_BACKTICK || c === CH_BACKSLASH)
          break;
        p++;
      }
    }
    let text = "";
    let parts = null;
    let litBuf = "";
    let litStart = bp ? this.pos : 0;
    while (this.pos < len && src.charCodeAt(this.pos) !== CH_DQUOTE) {
      const runStart = this.pos;
      while (this.pos < len) {
        const c = src.charCodeAt(this.pos);
        if (c === CH_DQUOTE || c === CH_BACKSLASH || c === CH_DOLLAR || c === CH_BACKTICK)
          break;
        this.pos++;
      }
      if (bt && this.pos > runStart) {
        const chunk = src.slice(runStart, this.pos);
        text += chunk;
        if (bp)
          litBuf += chunk;
      }
      if (this.pos >= len || src.charCodeAt(this.pos) === CH_DQUOTE)
        break;
      const ch = src.charCodeAt(this.pos);
      if (ch === CH_BACKSLASH) {
        this.pos++;
        if (this.pos < len) {
          const next = src.charCodeAt(this.pos);
          if (next === CH_NL) {
            this.pos++;
            continue;
          }
          if (bt) {
            if (next === CH_DOLLAR || next === CH_BACKTICK || next === CH_DQUOTE || next === CH_BACKSLASH) {
              const c = src[this.pos];
              text += c;
              if (bp)
                litBuf += c;
            } else {
              const pair = "\\" + src[this.pos];
              text += pair;
              if (bp)
                litBuf += pair;
            }
          }
          this.pos++;
        }
        continue;
      }
      if (ch === CH_DOLLAR) {
        const afterDollar = this.pos + 1 < len ? src.charCodeAt(this.pos + 1) : 0;
        if (afterDollar === CH_DQUOTE || afterDollar === CH_SQUOTE) {
          if (bt) {
            text += "$";
            if (bp)
              litBuf += "$";
          }
          this.pos++;
          continue;
        }
        const expStart = this.pos;
        this.readDollar();
        if (bt)
          text += this._resultText;
        if (this._resultHasExpansion)
          hasExpansions = true;
        if (bp) {
          const rp = this._resultPart;
          if (rp && isDQChild(rp)) {
            if (!parts)
              parts = [];
            if (litBuf) {
              parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, expStart) });
              litBuf = "";
            }
            parts.push(rp);
            litStart = this.pos;
          } else {
            litBuf += this._resultText;
          }
        }
        continue;
      }
      if (ch === CH_BACKTICK) {
        const btStart = this.pos;
        this.readBacktickExpansion();
        if (bt)
          text += this._resultText;
        hasExpansions = true;
        if (bp && this._resultPart && isDQChild(this._resultPart)) {
          if (!parts)
            parts = [];
          if (litBuf) {
            parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, btStart) });
            litBuf = "";
          }
          parts.push(this._resultPart);
          litStart = this.pos;
        }
        continue;
      }
    }
    if (bp && parts && litBuf)
      parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, this.pos) });
    this._dqEnd = this.pos;
    if (this.pos < len)
      this.pos++;
    else
      this.errors.push({ message: "unterminated double quote", pos: contentStart - 1 });
    this._dqText = text;
    this._dqHasExpansions = hasExpansions;
    this._dqParts = parts;
  }
  readDollar() {
    const dollarPos = this.pos;
    this.pos++;
    const src = this.src;
    const len = this.srcEnd;
    const bt = this._buildParts || this._buildValue;
    if (this.pos >= len) {
      this._resultText = "$";
      this._resultIsRaw = true;
      this._resultHasExpansion = false;
      this._resultPart = undefined;
      return;
    }
    const ch = src.charCodeAt(this.pos);
    if (ch === CH_LPAREN) {
      if (this.pos + 1 < len && src.charCodeAt(this.pos + 1) === CH_LPAREN) {
        const savedPos = this.pos;
        const savedErrors = this.errors.length;
        this.readArithmeticExpansion();
        if (!this._notArithmetic)
          return;
        this.errors.length = savedErrors;
        this.pos = savedPos;
      }
      this.readCommandSubstitution();
      return;
    }
    if (ch === CH_LBRACE) {
      const after = this.pos + 1 < len ? src.charCodeAt(this.pos + 1) : 0;
      if (after === CH_SPACE || after === CH_TAB || after === CH_NL) {
        this.readBraceCommandSubstitution();
        return;
      }
      if (after === CH_PIPE) {
        this.readValueSubstitution();
        return;
      }
      this.readParameterExpansion();
      return;
    }
    if (ch === CH_SQUOTE) {
      this.pos++;
      if (bt) {
        const value = this.readAnsiCQuoted();
        this._resultText = value;
        this._resultPart = this._buildParts ? { type: "AnsiCQuoted", text: src.slice(dollarPos, this.pos), value } : undefined;
      } else {
        this.skipAnsiCQuoted();
        this._resultText = "";
        this._resultPart = undefined;
      }
      this._resultIsRaw = false;
      this._resultHasExpansion = false;
      return;
    }
    if (ch === CH_DQUOTE) {
      this.pos++;
      this.readDoubleQuoted();
      this._resultText = this._dqText;
      this._resultIsRaw = false;
      this._resultHasExpansion = this._dqHasExpansions;
      if (this._buildParts) {
        const text = src.slice(dollarPos, this.pos);
        this._resultPart = {
          type: "LocaleString",
          text,
          parts: this._dqParts ?? [
            { type: "Literal", value: this._dqText, text: src.slice(dollarPos + 2, this._dqEnd) }
          ]
        };
      } else {
        this._resultPart = undefined;
      }
      return;
    }
    if (ch === CH_AT || ch === CH_STAR || ch === CH_HASH || ch === CH_QUESTION || ch === CH_DASH || ch === CH_DOLLAR || ch === CH_BANG || ch >= CH_0 && ch <= CH_9) {
      this.pos++;
      const text = bt ? src.slice(this.pos - 2, this.pos) : "";
      this._resultText = text;
      this._resultIsRaw = true;
      this._resultHasExpansion = false;
      this._resultPart = this._buildParts ? { type: "SimpleExpansion", text } : undefined;
      return;
    }
    if (ch < 128 && isIdChar[ch] & 1) {
      const namePos = this.pos - 1;
      while (this.pos < len) {
        const c = src.charCodeAt(this.pos);
        if (c < 128 && isIdChar[c] & 2)
          this.pos++;
        else
          break;
      }
      const text = bt ? src.slice(namePos, this.pos) : "";
      this._resultText = text;
      this._resultIsRaw = true;
      this._resultHasExpansion = false;
      this._resultPart = this._buildParts ? { type: "SimpleExpansion", text } : undefined;
      return;
    }
    if (ch === CH_LBRACKET) {
      const close = this.findClosingArithmeticBracket(this.pos + 1);
      if (close !== -1) {
        const bodyStart = this.pos + 1;
        const body = src.slice(bodyStart, close);
        this.pos = close + 1;
        const text = bt ? src.slice(dollarPos, this.pos) : "";
        this._resultText = text;
        this._resultIsRaw = true;
        this._resultHasExpansion = false;
        this._resultPart = this._buildParts ? { type: "ArithmeticExpansion", text, expression: this.buildArithmeticExpression(body, bodyStart) } : undefined;
        return;
      }
    }
    this._resultText = "$";
    this._resultIsRaw = true;
    this._resultHasExpansion = false;
    this._resultPart = undefined;
  }
  scanArithmeticBody() {
    this._notArithmetic = false;
    this.pos += 2;
    let depth = 1;
    let parenDepth = 0;
    let parentParenDepth = 0;
    let parenDepths;
    let expansions = 0;
    let reported = false;
    const src = this.src;
    const len = this.srcEnd;
    const start = this.pos;
    while (this.pos < len && depth > 0) {
      const c = src.charCodeAt(this.pos);
      if (c === CH_BACKSLASH) {
        this.pos += 2;
      } else if (c === CH_SQUOTE) {
        this.pos++;
        this.skipSQ();
      } else if (c === CH_DQUOTE) {
        this.pos++;
        this.skipDQ();
      } else if (c === CH_BACKTICK) {
        this.pos++;
        while (this.pos < len && src.charCodeAt(this.pos) !== CH_BACKTICK) {
          if (src.charCodeAt(this.pos) === CH_BACKSLASH)
            this.pos++;
          this.pos++;
        }
        if (this.pos < len)
          this.pos++;
      } else if (c === CH_DOLLAR && this.pos + 2 < len && src.charCodeAt(this.pos + 1) === CH_LPAREN && src.charCodeAt(this.pos + 2) !== CH_LPAREN) {
        const dollarPos = this.pos;
        this.pos += 2;
        this.extractBalanced();
        if (this._unbalanced)
          this.errors.push({ message: "unterminated command substitution", pos: dollarPos });
      } else if (c === CH_DOLLAR && this.pos + 1 < len && src.charCodeAt(this.pos + 1) === CH_LBRACE) {
        const close = this.findClosingBrace(this.pos + 2, len);
        this.pos = close === -1 ? len : close + 1;
      } else if ((c === CH_LT || c === CH_GT) && this.pos + 1 < len && src.charCodeAt(this.pos + 1) === CH_LPAREN) {
        this.pos += 2;
        this.extractBalanced();
      } else if (c === CH_LPAREN) {
        if (src.charCodeAt(this.pos - 1) === CH_DOLLAR && src.charCodeAt(this.pos + 1) === CH_LPAREN) {
          if (depth === 1)
            parentParenDepth = parenDepth;
          else
            (parenDepths ??= []).push(parenDepth);
          depth++;
          parenDepth = 0;
          if (++expansions + this._nestingDepth >= MAX_SYNTAX_NESTING) {
            if (!reported) {
              this.errors.push({ message: "maximum arithmetic expansion nesting depth exceeded", pos: this.pos - 1 });
              reported = true;
            }
          }
          this.pos += 2;
        } else {
          parenDepth++;
          this.pos++;
        }
      } else if (c === CH_RPAREN && parenDepth > 0) {
        parenDepth--;
        this.pos++;
      } else if (c === CH_RPAREN && this.pos + 1 < len && src.charCodeAt(this.pos + 1) === CH_RPAREN) {
        if (--depth === 0) {
          this.pos += 2;
          break;
        }
        parenDepth = depth === 1 ? parentParenDepth : parenDepths.pop();
        this.pos += 2;
      } else if (c === CH_RPAREN && depth === 1) {
        this._notArithmetic = true;
        return "";
      } else {
        this.pos++;
      }
    }
    return this._buildParts || this._buildValue ? src.slice(start, this.pos - 2) : "";
  }
  readArithmeticExpansion() {
    const bodyStart = this.pos + 2;
    const body = this.scanArithmeticBody();
    if (this._notArithmetic)
      return;
    const text = this._buildParts || this._buildValue ? "$((" + body + "))" : "";
    this._resultText = text;
    this._resultIsRaw = true;
    this._resultHasExpansion = false;
    this._resultPart = this._buildParts ? { type: "ArithmeticExpansion", text, expression: this.buildArithmeticExpression(body, bodyStart) } : undefined;
  }
  buildArithmeticExpression(body, bodyStart) {
    if (!hasEmbeddedWordStructure(this.src, bodyStart, bodyStart + body.length)) {
      return parseArithmeticExpression(body, bodyStart) ?? undefined;
    }
    const commandExpansions = [];
    const embeddedWords = [];
    const expr = parseArithmeticExpression(body, bodyStart, {
      commandExpansions,
      embeddedWords,
      findClosingBracket: (start, end) => this.findClosingBracket(start, end),
      findClosingBrace: (start, end) => this.findClosingBrace(start, end),
      findClosingParenthesis: (start, end) => this.findClosingParenthesis(start, end),
      findArithmeticExpansionEnd: (start, end) => this.findArithmeticExpansionEnd(start, end),
      findArithmeticWordEnd: (start, end) => this.findArithmeticWordEnd(start, end)
    }) ?? undefined;
    for (const node of commandExpansions) {
      node.innerStart = node.pos + 2;
      this.collect(node);
    }
    for (const node of embeddedWords)
      node.parts = this.parseSubFieldWord(node.pos, node.end).parts;
    return expr;
  }
  readArithmeticCommand(out, tokenStart) {
    const savedBuildValue = this._buildValue;
    this._buildValue = true;
    const body = this.scanArithmeticBody();
    this._buildValue = savedBuildValue;
    setToken(out, Token.ArithCmd, body, tokenStart, this.pos);
  }
  readCommandSubstitution() {
    const dollarPos = this.pos - 1;
    this.pos++;
    const inner = this.extractBalanced();
    if (this._unbalanced)
      this.errors.push({ message: "unterminated command substitution", pos: dollarPos });
    const bt = this._buildParts || this._buildValue;
    const text = bt ? this.src.slice(dollarPos, this.pos) : "";
    this._resultText = text;
    this._resultIsRaw = true;
    this._resultHasExpansion = true;
    if (this._buildParts) {
      this._resultPart = { type: "CommandExpansion", text, script: undefined, inner, innerStart: dollarPos + 2 };
      this.collect(this._resultPart);
    } else {
      this._resultPart = undefined;
    }
  }
  readBraceCommandSubstitution() {
    this.readBraceSubstitution(1);
  }
  readValueSubstitution() {
    this.readBraceSubstitution(2);
  }
  readBraceSubstitution(skip) {
    const dollarPos = this.pos - 1;
    this.pos += skip;
    const src = this.src;
    const len = this.srcEnd;
    let depth = 1;
    const start = this.pos;
    while (this.pos < len) {
      const c = src.charCodeAt(this.pos);
      if (c === CH_LBRACE)
        depth++;
      else if (c === CH_RBRACE) {
        if (--depth === 0) {
          this.pos++;
          break;
        }
      } else if (c === CH_SQUOTE) {
        this.pos++;
        this.skipSQ();
        continue;
      } else if (c === CH_DQUOTE) {
        this.pos++;
        this.skipDQ();
        continue;
      } else if (c === CH_BACKSLASH)
        this.pos++;
      this.pos++;
    }
    this._resultIsRaw = true;
    this._resultHasExpansion = true;
    if (this._buildParts || this._buildValue) {
      const rawInner = src.slice(start, this.pos - 1);
      const inner = rawInner.trim();
      const text = src.slice(dollarPos, this.pos);
      this._resultText = text;
      if (this._buildParts) {
        const innerStart = start + (rawInner.length - rawInner.trimStart().length);
        this._resultPart = { type: "CommandExpansion", text, script: undefined, inner, innerStart };
        this.collect(this._resultPart);
      } else {
        this._resultPart = undefined;
      }
    } else {
      this._resultText = "";
      this._resultPart = undefined;
    }
  }
  readBacktickExpansion() {
    this.pos++;
    const src = this.src;
    const len = this.srcEnd;
    const start = this.pos;
    if (!this._buildParts && !this._buildValue) {
      while (this.pos < len && src.charCodeAt(this.pos) !== CH_BACKTICK) {
        if (src.charCodeAt(this.pos) === CH_BACKSLASH && this.pos + 1 < len)
          this.pos++;
        this.pos++;
      }
      if (this.pos < len)
        this.pos++;
      else
        this.errors.push({ message: "unterminated backtick", pos: start - 1 });
      this._resultText = "";
      this._resultIsRaw = false;
      this._resultHasExpansion = true;
      this._resultPart = undefined;
      return;
    }
    let inner = "";
    let hasEscapes = false;
    while (this.pos < len && src.charCodeAt(this.pos) !== CH_BACKTICK) {
      if (src.charCodeAt(this.pos) === CH_BACKSLASH) {
        hasEscapes = true;
        break;
      }
      this.pos++;
    }
    if (!hasEscapes) {
      inner = src.slice(start, this.pos);
    } else {
      inner = src.slice(start, this.pos);
      while (this.pos < len && src.charCodeAt(this.pos) !== CH_BACKTICK) {
        if (src.charCodeAt(this.pos) === CH_BACKSLASH) {
          this.pos++;
          if (this.pos < len) {
            const c = src.charCodeAt(this.pos);
            if (c === CH_DOLLAR || c === CH_BACKTICK || c === CH_BACKSLASH) {
              inner += src[this.pos];
            } else {
              inner += "\\" + src[this.pos];
            }
            this.pos++;
          }
        } else {
          const runStart = this.pos;
          while (this.pos < len) {
            const c = src.charCodeAt(this.pos);
            if (c === CH_BACKTICK || c === CH_BACKSLASH)
              break;
            this.pos++;
          }
          inner += src.slice(runStart, this.pos);
        }
      }
    }
    if (this.pos < len)
      this.pos++;
    else
      this.errors.push({ message: "unterminated backtick", pos: start - 1 });
    const text = src.slice(start - 1, this.pos);
    this._resultText = inner;
    this._resultHasExpansion = true;
    if (this._buildParts) {
      this._resultPart = {
        type: "CommandExpansion",
        text,
        script: undefined,
        inner,
        innerStart: hasEscapes ? undefined : start
      };
      this.collect(this._resultPart);
    } else {
      this._resultPart = undefined;
    }
  }
  readParameterExpansion() {
    const src = this.src;
    const len = this.srcEnd;
    const start = this.pos;
    this.pos++;
    let depth = 1;
    let reported = false;
    while (this.pos < len && depth > 0) {
      const ch = src.charCodeAt(this.pos);
      if (ch === CH_DOLLAR) {
        const next = this.pos + 1 < len ? src.charCodeAt(this.pos + 1) : 0;
        if (next === CH_LBRACE) {
          depth++;
          if (this._nestingDepth + depth > MAX_SYNTAX_NESTING && !reported) {
            this.errors.push({ message: "maximum parameter expansion nesting depth exceeded", pos: this.pos });
            reported = true;
          }
          this.pos += 2;
          continue;
        }
        if (next === CH_DOLLAR) {
          this.pos += 2;
          continue;
        }
        if (next === CH_LPAREN) {
          const dollarPos = this.pos;
          this.pos += 2;
          this.extractBalanced();
          if (this._unbalanced)
            this.errors.push({ message: "unterminated command substitution", pos: dollarPos });
          continue;
        }
      } else if (ch === CH_BACKTICK) {
        this.pos++;
        while (this.pos < len && src.charCodeAt(this.pos) !== CH_BACKTICK) {
          if (src.charCodeAt(this.pos) === CH_BACKSLASH)
            this.pos++;
          this.pos++;
        }
        if (this.pos < len)
          this.pos++;
        continue;
      } else if (ch === CH_RBRACE) {
        if (--depth === 0) {
          this.pos++;
          break;
        }
      } else if (ch === CH_BACKSLASH) {
        this.pos++;
      } else if (ch === CH_SQUOTE) {
        this.pos++;
        if (this.pos > start + 1 && src.charCodeAt(this.pos - 2) === CH_DOLLAR)
          this.skipAnsiCQuoted();
        else
          this.skipSQ();
        continue;
      } else if (ch === CH_DQUOTE) {
        this.pos++;
        this.skipDQ();
        continue;
      }
      this.pos++;
    }
    const closed = depth === 0;
    if (!closed)
      this.errors.push({ message: "unterminated parameter expansion", pos: start - 1 });
    const text = this._buildParts || this._buildValue ? src.slice(start - 1, this.pos) : "";
    this._resultText = text;
    this._resultIsRaw = true;
    this._resultHasExpansion = false;
    if (this._buildParts) {
      const inner = src.slice(start + 1, closed ? this.pos - 1 : this.pos);
      this._resultPart = this.parseParamInner(text, inner, start + 1);
    } else {
      this._resultPart = undefined;
    }
  }
  parseParamInner(text, inner, innerStart) {
    const result = {
      type: "ParameterExpansion",
      text,
      parameter: "",
      index: undefined,
      indexParts: undefined,
      indirect: undefined,
      length: undefined,
      operator: undefined,
      operand: undefined,
      slice: undefined,
      replace: undefined
    };
    const ilen = inner.length;
    if (ilen === 0)
      return result;
    const sub = (a, b) => this.parseSubFieldWord(innerStart + a, innerStart + b);
    const closeBracket = (start) => {
      const close = this.findClosingBracket(innerStart + start, innerStart + ilen);
      return close === -1 ? -1 : close - innerStart;
    };
    let i = 0;
    if (inner.charCodeAt(0) === CH_BANG) {
      result.indirect = true;
      i = 1;
    }
    if (!result.indirect && inner.charCodeAt(0) === CH_HASH) {
      if (ilen === 1) {
        result.parameter = "#";
        return result;
      }
      if (inner.charCodeAt(1) === CH_HASH) {
        result.parameter = "#";
        i = 1;
      } else {
        const tryI = this.scanParamName(inner, 1);
        if (tryI > 1) {
          let endI = tryI;
          if (endI < ilen && inner.charCodeAt(endI) === CH_LBRACKET) {
            const closeB = closeBracket(endI + 1);
            if (closeB !== -1)
              endI = closeB + 1;
          }
          if (endI >= ilen) {
            result.length = true;
            result.parameter = inner.slice(1, tryI);
            if (tryI < ilen && inner.charCodeAt(tryI) === CH_LBRACKET) {
              const closeB = closeBracket(tryI + 1);
              if (closeB !== -1) {
                result.index = inner.slice(tryI + 1, closeB);
                result.indexParts = sub(tryI + 1, closeB).parts;
              }
            }
            return result;
          }
        }
        result.parameter = "#";
        i = 1;
      }
    }
    if (!result.parameter) {
      const nameStart = i;
      i = this.scanParamName(inner, i);
      result.parameter = inner.slice(nameStart, i);
    }
    if (i < ilen && inner.charCodeAt(i) === CH_LBRACKET) {
      const closeB = closeBracket(i + 1);
      if (closeB !== -1) {
        result.index = inner.slice(i + 1, closeB);
        result.indexParts = sub(i + 1, closeB).parts;
        i = closeB + 1;
      }
    }
    if (i >= ilen)
      return result;
    const opChar = inner.charCodeAt(i);
    if (opChar === CH_COLON) {
      if (i + 1 < ilen) {
        const nc = inner.charCodeAt(i + 1);
        if (nc === CH_DASH || nc === CH_EQ || nc === CH_PLUS || nc === CH_QUESTION) {
          result.operator = inner.slice(i, i + 2);
          result.operand = sub(i + 2, ilen);
          return result;
        }
      }
      i++;
      const sliceRest = inner.slice(i);
      const colonIdx = findUnnested(sliceRest, CH_COLON);
      if (colonIdx === -1) {
        result.slice = { offset: sub(i, ilen), length: undefined };
      } else {
        result.slice = {
          offset: sub(i, i + colonIdx),
          length: sub(i + colonIdx + 1, ilen)
        };
      }
      return result;
    }
    if (opChar === CH_DASH || opChar === CH_EQ || opChar === CH_PLUS || opChar === CH_QUESTION) {
      result.operator = inner[i];
      result.operand = sub(i + 1, ilen);
      return result;
    }
    if (opChar === CH_HASH) {
      if (i + 1 < ilen && inner.charCodeAt(i + 1) === CH_HASH) {
        result.operator = "##";
        result.operand = sub(i + 2, ilen);
      } else {
        result.operator = "#";
        result.operand = sub(i + 1, ilen);
      }
      return result;
    }
    if (opChar === CH_PERCENT) {
      if (i + 1 < ilen && inner.charCodeAt(i + 1) === CH_PERCENT) {
        result.operator = "%%";
        result.operand = sub(i + 2, ilen);
      } else {
        result.operator = "%";
        result.operand = sub(i + 1, ilen);
      }
      return result;
    }
    if (opChar === CH_SLASH) {
      i++;
      let replOp = "/";
      if (i < ilen) {
        const nc = inner.charCodeAt(i);
        if (nc === CH_SLASH) {
          replOp = "//";
          i++;
        } else if (nc === CH_HASH) {
          replOp = "/#";
          i++;
        } else if (nc === CH_PERCENT) {
          replOp = "/%";
          i++;
        }
      }
      result.operator = replOp;
      const rest = inner.slice(i);
      const sepIdx = findUnnested(rest, CH_SLASH);
      if (sepIdx === -1) {
        result.replace = {
          pattern: sub(i, ilen),
          replacement: new WordImpl("", innerStart + ilen, innerStart + ilen)
        };
      } else {
        result.replace = {
          pattern: sub(i, i + sepIdx),
          replacement: sub(i + sepIdx + 1, ilen)
        };
      }
      return result;
    }
    if (opChar === CH_CARET) {
      if (i + 1 < ilen && inner.charCodeAt(i + 1) === CH_CARET) {
        result.operator = "^^";
        if (i + 2 < ilen)
          result.operand = sub(i + 2, ilen);
      } else {
        result.operator = "^";
        if (i + 1 < ilen)
          result.operand = sub(i + 1, ilen);
      }
      return result;
    }
    if (opChar === CH_COMMA) {
      if (i + 1 < ilen && inner.charCodeAt(i + 1) === CH_COMMA) {
        result.operator = ",,";
        if (i + 2 < ilen)
          result.operand = sub(i + 2, ilen);
      } else {
        result.operator = ",";
        if (i + 1 < ilen)
          result.operand = sub(i + 1, ilen);
      }
      return result;
    }
    if (opChar === CH_AT) {
      result.operator = "@";
      result.operand = sub(i + 1, ilen);
      return result;
    }
    result.operator = inner.slice(i);
    return result;
  }
  scanParamName(s, start) {
    let i = start;
    if (i >= s.length)
      return i;
    const c = s.charCodeAt(i);
    if (c === CH_AT || c === CH_STAR || c === CH_HASH || c === CH_QUESTION || c === CH_DASH || c === CH_DOLLAR || c === CH_BANG) {
      return i + 1;
    }
    if (c >= CH_0 && c <= CH_9) {
      while (i < s.length && s.charCodeAt(i) >= CH_0 && s.charCodeAt(i) <= CH_9)
        i++;
      return i;
    }
    if (c >= CH_a && c <= CH_z || c >= CH_A && c <= CH_Z || c === CH_UNDERSCORE) {
      i++;
      while (i < s.length) {
        const ch = s.charCodeAt(i);
        if (ch >= CH_a && ch <= CH_z || ch >= CH_A && ch <= CH_Z || ch >= CH_0 && ch <= CH_9 || ch === CH_UNDERSCORE)
          i++;
        else
          break;
      }
    }
    return i;
  }
  readAnsiCQuoted() {
    const quotePos = this.pos - 1;
    const result = decodeAnsiCQuoted(this.src, this.pos, this.srcEnd);
    this.pos = result.end;
    if (!result.closed)
      this.errors.push({ message: "unterminated ANSI-C quote", pos: quotePos });
    return result.value;
  }
  extractBalanced() {
    const src = this.src;
    const len = this.srcEnd;
    const bt = this._buildParts || this._buildValue;
    let depth = 1;
    const start = this.pos;
    this._unbalanced = false;
    while (this.pos < len) {
      const c = src.charCodeAt(this.pos);
      if (c === CH_RPAREN) {
        const result = bt ? src.slice(start, this.pos) : "";
        this.pos++;
        return result;
      } else if (c === CH_LPAREN || c === CH_BACKSLASH || c === CH_SQUOTE || c === CH_DQUOTE || c === CH_BACKTICK) {
        break;
      } else if (c === CH_LT && this.pos + 1 < len && src.charCodeAt(this.pos + 1) === CH_LT) {
        break;
      } else if (c === CH_HASH && (this.pos === start || src.charCodeAt(this.pos - 1) < 128 && charType[src.charCodeAt(this.pos - 1)] & 1)) {
        break;
      } else if (c === 99 && (this.pos === start || src.charCodeAt(this.pos - 1) < 128 && charType[src.charCodeAt(this.pos - 1)] & 1) && this.pos + 3 < len && src.charCodeAt(this.pos + 1) === 97 && src.charCodeAt(this.pos + 2) === 115 && src.charCodeAt(this.pos + 3) === 101 && (this.pos + 4 >= len || src.charCodeAt(this.pos + 4) < 128 && charType[src.charCodeAt(this.pos + 4)] & 1)) {
        break;
      } else {
        this.pos++;
      }
    }
    let caseDepth = 0;
    let caseParens = 0;
    let pendingDelims = null;
    let arithBase = -1;
    const arithExtent = start >= 2 && src.charCodeAt(start) === CH_LPAREN && src.charCodeAt(start - 1) === CH_LPAREN && src.charCodeAt(start - 2) === CH_DOLLAR;
    let substitutions = 0;
    let reported = false;
    while (this.pos < len && depth > 0) {
      const ch = src.charCodeAt(this.pos);
      if (ch === CH_LPAREN) {
        if (arithBase < 0 && this.pos + 1 < len && src.charCodeAt(this.pos + 1) === CH_LPAREN) {
          arithBase = depth;
        }
        if (src.charCodeAt(this.pos - 1) === CH_DOLLAR && ++substitutions + this._nestingDepth >= MAX_SYNTAX_NESTING) {
          if (!reported) {
            this.errors.push({ message: "maximum command substitution nesting depth exceeded", pos: this.pos - 1 });
            reported = true;
          }
        }
        depth++;
        if (caseDepth > 0)
          caseParens++;
        this.pos++;
      } else if (ch === CH_RPAREN) {
        if (caseDepth > 0 && caseParens === 0) {
          this.pos++;
        } else {
          if (caseDepth > 0)
            caseParens--;
          depth--;
          if (depth === 0) {
            const result = bt ? src.slice(start, this.pos) : "";
            this.pos++;
            return result;
          }
          if (depth <= arithBase)
            arithBase = -1;
          this.pos++;
        }
      } else if (ch === CH_BACKSLASH) {
        this.pos++;
        if (this.pos < len)
          this.pos++;
      } else if (ch === CH_SQUOTE) {
        this.pos++;
        this.skipSQ();
      } else if (ch === CH_DQUOTE) {
        this.pos++;
        this.skipDQ();
      } else if (ch === CH_BACKTICK) {
        this.pos++;
        while (this.pos < len && src.charCodeAt(this.pos) !== CH_BACKTICK) {
          if (src.charCodeAt(this.pos) === CH_BACKSLASH)
            this.pos++;
          if (this.pos < len)
            this.pos++;
        }
        if (this.pos < len)
          this.pos++;
      } else if (ch === CH_LT && arithBase < 0 && this.pos + 1 < len && src.charCodeAt(this.pos + 1) === CH_LT) {
        if (this.pos + 2 < len && src.charCodeAt(this.pos + 2) === CH_LT) {
          this.pos += 3;
        } else {
          this.pos += 2;
          const strip = this.pos < len && src.charCodeAt(this.pos) === CH_DASH;
          if (strip)
            this.pos++;
          this.skipSpacesAndTabs();
          this.readHereDocDelimiter();
          if (this._hereDelim || this._hereQuoted) {
            (pendingDelims ??= []).push({ delimiter: this._hereDelim, strip, quoted: this._hereQuoted });
          }
        }
      } else if (ch === CH_NL && pendingDelims) {
        this.pos++;
        for (const hd of pendingDelims)
          this.skipHereDocBody(hd.delimiter, hd.strip, true, hd.quoted);
        pendingDelims = null;
      } else if (ch === CH_HASH && arithBase < 0 && !arithExtent && opensComment(src, this.pos, start)) {
        while (this.pos < len && src.charCodeAt(this.pos) !== CH_NL)
          this.pos++;
      } else {
        const wStart = this.pos;
        while (this.pos < len) {
          const wc = src.charCodeAt(this.pos);
          if (wc < 128 && charType[wc])
            break;
          this.pos++;
        }
        if (this.pos > wStart) {
          const wLen = this.pos - wStart;
          const prev = wStart > start ? src.charCodeAt(wStart - 1) : 0;
          if (wLen === 4 && (wStart === start || prev < 128 && charType[prev] & 1)) {
            const c0 = src.charCodeAt(wStart);
            if (c0 === 99 && src.charCodeAt(wStart + 1) === 97 && src.charCodeAt(wStart + 2) === 115 && src.charCodeAt(wStart + 3) === 101) {
              caseDepth++;
            } else if (c0 === 101 && src.charCodeAt(wStart + 1) === 115 && src.charCodeAt(wStart + 2) === 97 && src.charCodeAt(wStart + 3) === 99 && caseDepth > 0) {
              caseDepth--;
              if (caseDepth === 0)
                caseParens = 0;
            }
          }
        } else {
          this.pos++;
        }
      }
    }
    this._unbalanced = true;
    return bt ? src.slice(start, this.pos) : "";
  }
}

// pi-packages/mpi-permission/vendor/unbash/dist/parts.js
function computeWordParts(source, word, depth = 0) {
  const lexer = new Lexer(source, word.pos, word.end);
  lexer._nestingDepth = depth;
  const parts = lexer.buildWordParts(word.pos);
  if (!parts)
    return;
  resolveCollected(lexer);
  return parts;
}
function computeEmbeddedWordParts(source, word, depth = 0) {
  if (!hasEmbeddedWordStructure(source, word.pos, word.end))
    return;
  const lexer = new Lexer(source, word.pos, word.end);
  lexer._nestingDepth = depth;
  const parts = lexer.buildEmbeddedWordParts(word.pos);
  if (!parts)
    return;
  resolveCollected(lexer);
  return parts;
}
function computeHereDocBodyParts(source, word, depth = 0) {
  const lexer = new Lexer(source, word.pos, word.end);
  lexer._nestingDepth = depth;
  const parts = lexer.buildHereDocParts(word.pos, word.end);
  if (!parts)
    return;
  resolveCollected(lexer);
  return parts;
}
function resolveCollected(lexer) {
  const source = lexer.getSource();
  for (const [e, innerDepth] of lexer.getCollectedExpansions()) {
    if (e.inner !== undefined) {
      const depth = innerDepth + 1;
      if (depth > MAX_SYNTAX_NESTING + 1) {} else if (e.innerStart !== undefined) {
        e.script = parseRegion(source, e.innerStart, e.innerStart + e.inner.length, depth);
      } else {
        e.script = parse(e.inner);
        Object.defineProperty(e.script, "source", { value: e.inner, enumerable: false });
      }
      e.inner = undefined;
      e.innerStart = undefined;
    }
  }
}

// pi-packages/mpi-permission/vendor/unbash/dist/parser.js
WordImpl._resolveWord = computeWordParts;
WordImpl._resolveHeredocBody = computeHereDocBodyParts;

class ArithmeticCommandImpl {
  type = "ArithmeticCommand";
  pos;
  end;
  body;
  #source;
  #depth;
  #expression = null;
  constructor(pos, end, body, source, depth) {
    this.pos = pos;
    this.end = end;
    this.body = body;
    this.#source = source;
    this.#depth = depth;
  }
  get expression() {
    if (this.#expression === null) {
      this.#expression = parseArithmeticWithParts(this.body, this.pos + 2, this.#source, this.#depth);
    }
    return this.#expression;
  }
  set expression(v) {
    this.#expression = v ?? undefined;
  }
  toJSON() {
    return {
      type: this.type,
      pos: this.pos,
      end: this.end,
      expression: this.expression,
      body: this.body
    };
  }
}

class ArithmeticForImpl {
  type = "ArithmeticFor";
  pos;
  end;
  body;
  #initStr;
  #testStr;
  #updateStr;
  #initPos;
  #testPos;
  #updatePos;
  #source;
  #depth;
  #initialize = null;
  #test = null;
  #update = null;
  constructor(pos, end, body, initStr, testStr, updateStr, initPos, testPos, updatePos, source, depth) {
    this.pos = pos;
    this.end = end;
    this.body = body;
    this.#initStr = initStr;
    this.#testStr = testStr;
    this.#updateStr = updateStr;
    this.#initPos = initPos;
    this.#testPos = testPos;
    this.#updatePos = updatePos;
    this.#source = source;
    this.#depth = depth;
  }
  get initialize() {
    if (this.#initialize === null) {
      if (this.#initStr) {
        this.#initialize = parseArithmeticWithParts(this.#initStr, this.#initPos, this.#source, this.#depth);
      } else {
        this.#initialize = undefined;
      }
    }
    return this.#initialize;
  }
  set initialize(v) {
    this.#initialize = v ?? undefined;
  }
  get test() {
    if (this.#test === null) {
      if (this.#testStr) {
        this.#test = parseArithmeticWithParts(this.#testStr, this.#testPos, this.#source, this.#depth);
      } else {
        this.#test = undefined;
      }
    }
    return this.#test;
  }
  set test(v) {
    this.#test = v ?? undefined;
  }
  get update() {
    if (this.#update === null) {
      if (this.#updateStr) {
        this.#update = parseArithmeticWithParts(this.#updateStr, this.#updatePos, this.#source, this.#depth);
      } else {
        this.#update = undefined;
      }
    }
    return this.#update;
  }
  set update(v) {
    this.#update = v ?? undefined;
  }
  toJSON() {
    return {
      type: this.type,
      pos: this.pos,
      end: this.end,
      initialize: this.initialize,
      test: this.test,
      update: this.update,
      body: this.body
    };
  }
}
var CASE_TERMINATORS = {
  [Token.DoubleSemi]: ";;",
  [Token.SemiAmp]: ";&",
  [Token.DoubleSemiAmp]: ";;&"
};
var REDIRECT_OPS = {
  ">": ">",
  ">>": ">>",
  "<": "<",
  "<<": "<<",
  "<<-": "<<-",
  "<<<": "<<<",
  "<>": "<>",
  "<&": "<&",
  ">&": ">&",
  ">|": ">|",
  "&>": "&>",
  "&>>": "&>>"
};
function parseArithmeticWithParts(body, offset, source, depth = 0) {
  if (!hasEmbeddedWordStructure(source, offset, offset + body.length)) {
    return parseArithmeticExpression(body, offset) ?? undefined;
  }
  const commandExpansions = [];
  const embeddedWords = [];
  const lexer = new Lexer(source);
  const expression = parseArithmeticExpression(body, offset, {
    commandExpansions,
    embeddedWords,
    findClosingBracket: (start, end) => lexer.findClosingBracket(start, end),
    findClosingBrace: (start, end) => lexer.findClosingBrace(start, end),
    findClosingParenthesis: (start, end) => lexer.findClosingParenthesis(start, end),
    findArithmeticExpansionEnd: (start, end) => lexer.findArithmeticExpansionEnd(start, end),
    findArithmeticWordEnd: (start, end) => lexer.findArithmeticWordEnd(start, end)
  }) ?? undefined;
  for (const node of commandExpansions) {
    if (node.inner !== undefined) {
      if (depth <= MAX_SYNTAX_NESTING) {
        const innerStart = node.pos + 2;
        node.script = parseRegion(source, innerStart, innerStart + node.inner.length, depth + 1);
      }
      node.inner = undefined;
    }
  }
  for (const node of embeddedWords)
    node.parts = computeEmbeddedWordParts(source, node, depth);
  return expression;
}
var listTerminators = new Uint8Array(37);
listTerminators[Token.EOF] = 1;
listTerminators[Token.RParen] = 1;
listTerminators[Token.RBrace] = 1;
listTerminators[Token.Then] = 1;
listTerminators[Token.Else] = 1;
listTerminators[Token.Elif] = 1;
listTerminators[Token.Fi] = 1;
listTerminators[Token.Do] = 1;
listTerminators[Token.Done] = 1;
listTerminators[Token.Esac] = 1;
listTerminators[Token.DoubleSemi] = 1;
listTerminators[Token.SemiAmp] = 1;
listTerminators[Token.DoubleSemiAmp] = 1;
var compoundClosers = new Uint8Array(37);
compoundClosers[Token.RParen] = 1;
compoundClosers[Token.RBrace] = 1;
compoundClosers[Token.DblRBracket] = 1;
compoundClosers[Token.Fi] = 1;
compoundClosers[Token.Done] = 1;
compoundClosers[Token.Esac] = 1;
compoundClosers[Token.ArithCmd] = 1;
function isTestNegation(t) {
  return t.token === Token.Word && t.keywordEligible && t.value === "!";
}
var commandStarts = new Uint8Array(37);
commandStarts[Token.Word] = 1;
commandStarts[Token.Assignment] = 1;
commandStarts[Token.Bang] = 1;
commandStarts[Token.LParen] = 1;
commandStarts[Token.LBrace] = 1;
commandStarts[Token.DblLBracket] = 1;
commandStarts[Token.If] = 1;
commandStarts[Token.For] = 1;
commandStarts[Token.While] = 1;
commandStarts[Token.Until] = 1;
commandStarts[Token.Case] = 1;
commandStarts[Token.Function] = 1;
commandStarts[Token.Select] = 1;
commandStarts[Token.ArithCmd] = 1;
commandStarts[Token.Coproc] = 1;
commandStarts[Token.Redirect] = 1;
var UNARY_TEST_OPS = {
  "-a": 1,
  "-b": 1,
  "-c": 1,
  "-d": 1,
  "-e": 1,
  "-f": 1,
  "-g": 1,
  "-h": 1,
  "-k": 1,
  "-p": 1,
  "-r": 1,
  "-s": 1,
  "-t": 1,
  "-u": 1,
  "-v": 1,
  "-w": 1,
  "-x": 1,
  "-z": 1,
  "-n": 1,
  "-o": 1,
  "-N": 1,
  "-S": 1,
  "-L": 1,
  "-G": 1,
  "-O": 1,
  "-R": 1
};
var BINARY_TEST_OPS = {
  "==": 1,
  "!=": 1,
  "=~": 1,
  "=": 1,
  "-eq": 1,
  "-ne": 1,
  "-lt": 1,
  "-le": 1,
  "-gt": 1,
  "-ge": 1,
  "-nt": 1,
  "-ot": 1,
  "-ef": 1,
  "<": 1,
  ">": 1
};
function heredocDelimiterParts(value) {
  return (source, word) => {
    const raw = source.slice(word.pos, word.end);
    return raw === value ? undefined : [{ type: "Literal", value, text: raw }];
  };
}
var EMPTY_REDIRECTS = [];
function ownEmpty(values) {
  return values.length === 0 ? [] : values;
}
function parse(source) {
  return new Parser(source, 0, source.length).run();
}
function parseRegion(source, start, end, depth = 0) {
  return new Parser(source, start, end, depth).run();
}

class Parser {
  tok;
  source;
  start;
  end;
  depth;
  errors = null;
  _redirects = EMPTY_REDIRECTS;
  syntaxDepth = 0;
  constructor(source, start, end, depth = 0) {
    this.tok = new Lexer(source, start, end);
    this.tok._nestingDepth = depth;
    this.source = source;
    this.start = start;
    this.end = end;
    this.depth = depth;
  }
  run() {
    const start = this.start;
    if (this.depth > MAX_SYNTAX_NESTING)
      this.error("maximum substitution nesting depth exceeded", start);
    let shebang;
    if (start === 0 && this.source.charCodeAt(0) === 35 && this.source.charCodeAt(1) === 33) {
      const nl = this.source.indexOf(`
`);
      shebang = nl === -1 ? this.source : this.source.slice(0, nl);
    }
    const commands = this.list();
    for (;; ) {
      const unexpected = this.tok.peek(LexContext.CommandStart);
      if (unexpected.token === Token.EOF)
        break;
      this.error(`unexpected token '${unexpected.value}'`, unexpected.pos);
      if (!listTerminators[unexpected.token] && unexpected.token !== Token.In)
        break;
      this.tok.next(LexContext.CommandStart);
      let separator = this.tok.peek(LexContext.CommandStart).token;
      if (separator !== Token.Semi && separator !== Token.Newline && separator !== Token.Amp)
        break;
      while (separator === Token.Semi || separator === Token.Newline || separator === Token.Amp) {
        this.tok.next(LexContext.CommandStart);
        separator = this.tok.peek(LexContext.CommandStart).token;
      }
      const recovered = this.list();
      for (let i = 0;i < recovered.length; i++)
        commands.push(recovered[i]);
    }
    const lexerErrors = this.tok._errors;
    if (lexerErrors !== null && lexerErrors.length > 0) {
      const errors = this.errors ??= [];
      for (let i = 0;i < lexerErrors.length; i++)
        errors.push(lexerErrors[i]);
    }
    if (this.errors !== null && this.errors.length > 1)
      this.errors.sort((a, b) => a.pos - b.pos);
    const result = {
      type: "Script",
      pos: start,
      end: this.end,
      shebang,
      commands,
      errors: this.errors ?? undefined
    };
    return result;
  }
  error(message, pos) {
    (this.errors ??= []).push({ message, pos });
  }
  skipSemi() {
    if (this.tok.peek(LexContext.Normal).token === Token.Semi)
      this.tok.next(LexContext.Normal);
  }
  accept(token, ctx = LexContext.Normal) {
    if (this.tok.peek(ctx).token === token)
      return this.tok.next(ctx);
    return null;
  }
  acceptEnd(token, ctx = LexContext.Normal) {
    if (this.tok.peek(ctx).token === token)
      return this.tok.next(ctx).end;
    return -1;
  }
  skipNewlines(ctx = LexContext.Normal) {
    while (this.tok.peek(ctx).token === Token.Newline)
      this.tok.next(ctx);
  }
  makeStatement(command, redirects) {
    const end = redirects.length > 0 ? redirects[redirects.length - 1].end : command.end;
    return {
      type: "Statement",
      pos: command.pos,
      end,
      command,
      background: undefined,
      redirects: ownEmpty(redirects)
    };
  }
  list() {
    const commands = [];
    this.skipNewlines(LexContext.CommandStart);
    let t = this.tok.peek(LexContext.CommandStart).token;
    if (listTerminators[t] || !commandStarts[t])
      return commands;
    const first = this.andOr();
    if (first) {
      const redirects = this._redirects;
      this._redirects = EMPTY_REDIRECTS;
      commands.push(this.makeStatement(first, redirects));
    }
    for (;; ) {
      t = this.tok.peekFollow(compoundClosers).token;
      if (t !== Token.Semi && t !== Token.Newline && t !== Token.Amp)
        break;
      const isBackground = t === Token.Amp;
      const sepEnd = this.tok.next(LexContext.Normal).end;
      if (isBackground) {
        const stmt = commands[commands.length - 1];
        stmt.background = true;
        stmt.end = sepEnd;
      }
      this.skipNewlines(LexContext.CommandStart);
      t = this.tok.peek(LexContext.CommandStart).token;
      if (listTerminators[t] || !commandStarts[t])
        break;
      const node = this.andOr();
      if (node) {
        const redirects = this._redirects;
        this._redirects = EMPTY_REDIRECTS;
        commands.push(this.makeStatement(node, redirects));
      }
    }
    return commands;
  }
  andOr() {
    const first = this.pipeline();
    if (!first)
      return null;
    let t = this.tok.peek(LexContext.Normal).token;
    if (t !== Token.And && t !== Token.Or)
      return first;
    let wrappedFirst = first;
    if (this._redirects.length > 0) {
      wrappedFirst = this.makeStatement(first, this._redirects);
      this._redirects = EMPTY_REDIRECTS;
    }
    const commands = [wrappedFirst];
    const operators = [];
    do {
      const operatorToken = this.tok.next(LexContext.Normal);
      const operator = operatorToken.token === Token.And ? "&&" : "||";
      this.skipNewlines(LexContext.CommandStart);
      const next = this.pipeline();
      if (!next) {
        this.error(`expected command after '${operator}'`, operatorToken.end);
        break;
      }
      operators.push(operator);
      commands.push(next);
      t = this.tok.peek(LexContext.Normal).token;
    } while (t === Token.And || t === Token.Or);
    return {
      type: "AndOr",
      pos: first.pos,
      end: commands[commands.length - 1].end,
      commands,
      operators
    };
  }
  wrapCompoundRedirects(node) {
    const redirects = this._redirects;
    this._redirects = EMPTY_REDIRECTS;
    if (redirects.length === 0)
      return node;
    return this.makeStatement(node, redirects);
  }
  pipeline() {
    let time = false;
    let pipelinePos = 0;
    let prefixEnd = 0;
    const firstToken = this.tok.peek(LexContext.CommandStart);
    if (firstToken.token === Token.Word && firstToken.keywordEligible && firstToken.value === "time") {
      time = true;
      const timeToken = this.tok.next(LexContext.CommandStart);
      pipelinePos = timeToken.pos;
      prefixEnd = timeToken.end;
      const flag = this.tok.peek(LexContext.CommandStart);
      if (flag.token === Token.Word && flag.keywordEligible && flag.value === "-p")
        prefixEnd = this.tok.next(LexContext.CommandStart).end;
    }
    let negated = false;
    const bang = this.tok.peek(LexContext.CommandStart);
    if (bang.token === Token.Bang) {
      if (!time)
        pipelinePos = bang.pos;
      prefixEnd = this.tok.next(LexContext.CommandStart).end;
      negated = true;
      const repeated = this.tok.peek(LexContext.CommandStart);
      if (repeated.token === Token.Bang) {
        this.error("unexpected token '!'", repeated.pos);
        do {
          prefixEnd = this.tok.next(LexContext.CommandStart).end;
        } while (this.tok.peek(LexContext.CommandStart).token === Token.Bang);
      }
    }
    const first = this.command();
    if (!first) {
      if (time || negated) {
        const pipeline2 = {
          type: "Pipeline",
          pos: pipelinePos,
          end: prefixEnd,
          commands: [],
          negated: negated ? true : undefined,
          operators: [],
          time: time ? true : undefined
        };
        return pipeline2;
      }
      return null;
    }
    if (!time && !negated)
      pipelinePos = first.pos;
    const commands = [first];
    const operators = [];
    let firstRedirects = this._redirects;
    this._redirects = EMPTY_REDIRECTS;
    while (this.tok.peek(LexContext.Normal).token === Token.Pipe) {
      if (commands.length === 1 && firstRedirects.length > 0) {
        commands[0] = this.makeStatement(first, firstRedirects);
        firstRedirects = [];
      }
      const pipeToken = this.tok.next(LexContext.Normal);
      const operator = pipeToken.value === "|&" ? "|&" : "|";
      this.skipNewlines(LexContext.CommandStart);
      const cmd = this.command();
      if (!cmd) {
        this.error(`expected command after '${operator}'`, pipeToken.end);
        break;
      }
      operators.push(operator);
      commands.push(this.wrapCompoundRedirects(cmd));
    }
    if (commands.length === 1 && !negated && !time) {
      this._redirects = firstRedirects;
      return commands[0];
    }
    if (firstRedirects.length > 0) {
      commands[0] = this.makeStatement(first, firstRedirects);
    }
    const pipeline = {
      type: "Pipeline",
      pos: pipelinePos,
      end: commands[commands.length - 1].end,
      commands,
      negated: negated ? true : undefined,
      operators,
      time: time ? true : undefined
    };
    return pipeline;
  }
  command() {
    switch (this.tok.peek(LexContext.CommandStart).token) {
      case Token.LParen:
        return this.subshell();
      case Token.LBrace:
        return this.braceGroup();
      case Token.If:
        return this.ifClause();
      case Token.For:
        return this.forClause();
      case Token.While:
        return this.whileClause();
      case Token.Until:
        return this.untilClause();
      case Token.Case:
        return this.caseClause();
      case Token.Function:
        return this.functionDef();
      case Token.Select:
        return this.selectClause();
      case Token.DblLBracket:
        return this.testCommand();
      case Token.ArithCmd:
        return this.arithCommand();
      case Token.Coproc:
        return this.coprocCommand();
      case Token.Word:
      case Token.Assignment:
      case Token.Redirect:
        return this.simpleCommandOrFunction();
      default:
        return null;
    }
  }
  collectTrailingRedirects() {
    let redirects = EMPTY_REDIRECTS;
    while (this.tok.peekFollow(compoundClosers).token === Token.Redirect) {
      redirects = this.collectRedirect(redirects, LexContext.Normal);
    }
    return redirects;
  }
  arithCommand() {
    const tok = this.tok.next(LexContext.CommandStart);
    this._redirects = this.collectTrailingRedirects();
    return new ArithmeticCommandImpl(tok.pos, tok.end, tok.value, this.source, this.depth);
  }
  coprocCommand() {
    const startTok = this.tok.next(LexContext.CommandStart);
    const pos = startTok.pos;
    const startEnd = startTok.end;
    const t = this.tok.peek(LexContext.CommandStart);
    if (t.token !== Token.Word && t.token !== Token.Assignment && t.token !== Token.Redirect) {
      const body2 = this.pipeline() ?? {
        type: "Command",
        pos,
        end: startEnd,
        name: undefined,
        prefix: [],
        suffix: [],
        redirects: []
      };
      const bodyRedirects2 = this._redirects;
      this._redirects = EMPTY_REDIRECTS;
      const redirects2 = this.collectTrailingRedirects();
      const allRedirects2 = [...bodyRedirects2, ...redirects2];
      const end2 = allRedirects2.length > 0 ? allRedirects2[allRedirects2.length - 1].end : body2.end;
      return { type: "Coproc", pos, end: end2, name: undefined, body: body2, redirects: allRedirects2 };
    }
    const tentativeWord = this.toWord(this.tok.next(LexContext.CommandStart));
    const body = this.pipeline();
    if (body === null) {
      const cmd = {
        type: "Command",
        pos: tentativeWord.pos,
        end: tentativeWord.end,
        name: tentativeWord,
        prefix: [],
        suffix: [],
        redirects: []
      };
      const redirects2 = this.collectTrailingRedirects();
      const end2 = redirects2.length > 0 ? redirects2[redirects2.length - 1].end : cmd.end;
      return { type: "Coproc", pos, end: end2, name: undefined, body: cmd, redirects: ownEmpty(redirects2) };
    }
    if (body.type === "Command") {
      const cmd = body;
      if (cmd.name) {
        cmd.suffix = [cmd.name, ...cmd.suffix];
      }
      cmd.name = tentativeWord;
      cmd.pos = tentativeWord.pos;
      const redirects2 = this.collectTrailingRedirects();
      const end2 = redirects2.length > 0 ? redirects2[redirects2.length - 1].end : cmd.end;
      return { type: "Coproc", pos, end: end2, name: undefined, body: cmd, redirects: ownEmpty(redirects2) };
    }
    const bodyRedirects = this._redirects;
    this._redirects = EMPTY_REDIRECTS;
    const redirects = this.collectTrailingRedirects();
    const allRedirects = [...bodyRedirects, ...redirects];
    const end = allRedirects.length > 0 ? allRedirects[allRedirects.length - 1].end : body.end;
    return { type: "Coproc", pos, end, name: tentativeWord, body, redirects: allRedirects };
  }
  subshell() {
    return this.subshellBody(this.tok.next(LexContext.CommandStart).pos);
  }
  subshellBody(pos) {
    if (this.syntaxDepth === MAX_SYNTAX_NESTING) {
      this.error("maximum subshell nesting depth exceeded", pos);
      const closeEnd2 = this.tok.skipSubshellBody();
      if (closeEnd2 < 0)
        this.error("expected ')' to close subshell", this.tok.getPos());
      const end2 = closeEnd2 >= 0 ? closeEnd2 : pos;
      this._redirects = this.collectTrailingRedirects();
      return { type: "Subshell", pos, end: end2, body: this.makeCompoundList([]) };
    }
    this.syntaxDepth++;
    const commands = this.list();
    this.syntaxDepth--;
    const closeEnd = this.acceptEnd(Token.RParen, LexContext.Normal);
    if (closeEnd < 0)
      this.error("expected ')' to close subshell", this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this._redirects = this.collectTrailingRedirects();
    return { type: "Subshell", pos, end, body: this.makeCompoundList(commands) };
  }
  braceGroup() {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    if (this.syntaxDepth === MAX_SYNTAX_NESTING) {
      this.error("maximum brace group nesting depth exceeded", pos);
      const closeEnd2 = this.tok.skipCompoundBody(Token.RBrace);
      if (closeEnd2 < 0)
        this.error("expected '}' to close brace group", this.tok.getPos());
      const end2 = closeEnd2 >= 0 ? closeEnd2 : pos;
      this._redirects = this.collectTrailingRedirects();
      return { type: "BraceGroup", pos, end: end2, body: this.makeCompoundList([]) };
    }
    this.syntaxDepth++;
    const commands = this.list();
    this.syntaxDepth--;
    const closeEnd = this.acceptEnd(Token.RBrace, LexContext.Normal);
    if (closeEnd < 0)
      this.error("expected '}' to close brace group", this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this._redirects = this.collectTrailingRedirects();
    return { type: "BraceGroup", pos, end, body: this.makeCompoundList(commands) };
  }
  ifClause() {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    if (this.syntaxDepth === MAX_SYNTAX_NESTING) {
      this.error("maximum if nesting depth exceeded", pos);
      const closeEnd = this.tok.skipCompoundBody(Token.Fi);
      if (closeEnd < 0)
        this.error("expected 'fi' to close 'if'", this.tok.getPos());
      const end2 = closeEnd >= 0 ? closeEnd : pos;
      this._redirects = this.collectTrailingRedirects();
      return {
        type: "If",
        pos,
        end: end2,
        clause: this.makeCompoundList([]),
        then: this.makeCompoundList([]),
        else: undefined
      };
    }
    this.syntaxDepth++;
    let firstBranch;
    let lastBranch;
    let branchPos = pos;
    let clause;
    let then_;
    for (;; ) {
      clause = this.makeCompoundList(this.list());
      this.skipSemi();
      if (!this.accept(Token.Then, LexContext.CommandStart))
        this.error("expected 'then'", this.tok.getPos());
      then_ = this.makeCompoundList(this.list());
      this.skipSemi();
      const elif = this.accept(Token.Elif, LexContext.CommandStart);
      if (!elif)
        break;
      const branch2 = {
        type: "If",
        pos: branchPos,
        end: branchPos,
        clause,
        then: then_,
        else: undefined
      };
      if (lastBranch)
        lastBranch.else = branch2;
      else
        firstBranch = branch2;
      lastBranch = branch2;
      branchPos = elif.pos;
    }
    let else_;
    let end;
    if (this.accept(Token.Else, LexContext.CommandStart)) {
      else_ = this.makeCompoundList(this.list());
      this.skipSemi();
      const closeEnd = this.acceptEnd(Token.Fi, LexContext.CommandStart);
      if (closeEnd < 0)
        this.error("expected 'fi' to close 'if'", this.tok.getPos());
      end = closeEnd >= 0 ? closeEnd : branchPos;
    } else {
      const closeEnd = this.acceptEnd(Token.Fi, LexContext.CommandStart);
      if (closeEnd < 0)
        this.error("expected 'fi' to close 'if'", this.tok.getPos());
      end = closeEnd >= 0 ? closeEnd : branchPos;
    }
    this.syntaxDepth--;
    this._redirects = this.collectTrailingRedirects();
    const finalBranch = { type: "If", pos: branchPos, end, clause, then: then_, else: else_ };
    if (!firstBranch)
      return finalBranch;
    lastBranch.else = finalBranch;
    let branch = firstBranch;
    while (branch !== finalBranch) {
      branch.end = end;
      branch = branch.else;
    }
    return firstBranch;
  }
  forClause() {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    if (this.tok.peek(LexContext.Normal).token === Token.LParen) {
      return this.cStyleFor(pos);
    }
    const name = this.readWord(LexContext.Normal);
    const wordlist = [];
    this.skipNewlines(LexContext.CommandStart);
    if (this.tok.peek(LexContext.CommandStart).token === Token.In) {
      this.tok.next(LexContext.CommandStart);
      while (this.tok.peek(LexContext.Normal).token === Token.Word) {
        wordlist.push(this.readWord(LexContext.Normal));
      }
    }
    this.skipSemi();
    this.skipNewlines(LexContext.CommandStart);
    if (this.tok.peek(LexContext.CommandStart).token === Token.LBrace) {
      const bg = this.braceGroup();
      return { type: "For", pos, end: bg.end, name, wordlist, body: bg.body };
    }
    if (!this.accept(Token.Do, LexContext.CommandStart))
      this.error("expected 'do'", this.tok.getPos());
    if (this.syntaxDepth === MAX_SYNTAX_NESTING) {
      this.error("maximum for nesting depth exceeded", pos);
      const closeEnd2 = this.tok.skipCompoundBody(Token.Done);
      if (closeEnd2 < 0)
        this.error("expected 'done' to close 'for'", this.tok.getPos());
      const end2 = closeEnd2 >= 0 ? closeEnd2 : pos;
      this._redirects = this.collectTrailingRedirects();
      return { type: "For", pos, end: end2, name, wordlist, body: this.makeCompoundList([]) };
    }
    this.syntaxDepth++;
    const body = this.list();
    this.syntaxDepth--;
    this.skipSemi();
    const closeEnd = this.acceptEnd(Token.Done, LexContext.CommandStart);
    if (closeEnd < 0)
      this.error("expected 'done' to close 'for'", this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this._redirects = this.collectTrailingRedirects();
    return { type: "For", pos, end, name, wordlist, body: this.makeCompoundList(body) };
  }
  cStyleFor(pos) {
    const [initStr, testStr, updateStr, initPos, testPos, updatePos] = this.tok.readCStyleForExprs();
    if (this.tok.peek(LexContext.CommandStart).token === Token.Semi)
      this.tok.next(LexContext.CommandStart);
    this.skipNewlines(LexContext.CommandStart);
    if (this.tok.peek(LexContext.CommandStart).token === Token.LBrace) {
      const bg = this.braceGroup();
      return new ArithmeticForImpl(pos, bg.end, bg.body, initStr, testStr, updateStr, initPos, testPos, updatePos, this.source, this.depth);
    }
    if (!this.accept(Token.Do, LexContext.CommandStart))
      this.error("expected 'do'", this.tok.getPos());
    if (this.syntaxDepth === MAX_SYNTAX_NESTING) {
      this.error("maximum for nesting depth exceeded", pos);
      const closeEnd2 = this.tok.skipCompoundBody(Token.Done);
      if (closeEnd2 < 0)
        this.error("expected 'done' to close 'for'", this.tok.getPos());
      const end2 = closeEnd2 >= 0 ? closeEnd2 : pos;
      this._redirects = this.collectTrailingRedirects();
      return new ArithmeticForImpl(pos, end2, this.makeCompoundList([]), initStr, testStr, updateStr, initPos, testPos, updatePos, this.source, this.depth);
    }
    this.syntaxDepth++;
    const body = this.list();
    this.syntaxDepth--;
    const closeEnd = this.acceptEnd(Token.Done, LexContext.CommandStart);
    if (closeEnd < 0)
      this.error("expected 'done' to close 'for'", this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this._redirects = this.collectTrailingRedirects();
    return new ArithmeticForImpl(pos, end, this.makeCompoundList(body), initStr, testStr, updateStr, initPos, testPos, updatePos, this.source, this.depth);
  }
  whileClause() {
    return this.whileOrUntil("while");
  }
  untilClause() {
    return this.whileOrUntil("until");
  }
  whileOrUntil(kind) {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    if (this.syntaxDepth === MAX_SYNTAX_NESTING) {
      this.error(`maximum ${kind} nesting depth exceeded`, pos);
      const closeEnd2 = this.tok.skipCompoundBody(Token.Done);
      if (closeEnd2 < 0)
        this.error(`expected 'done' to close '${kind}'`, this.tok.getPos());
      const end2 = closeEnd2 >= 0 ? closeEnd2 : pos;
      this._redirects = this.collectTrailingRedirects();
      return {
        type: "While",
        pos,
        end: end2,
        kind,
        clause: this.makeCompoundList([]),
        body: this.makeCompoundList([])
      };
    }
    this.syntaxDepth++;
    const clause = this.makeCompoundList(this.list());
    this.skipSemi();
    if (!this.accept(Token.Do, LexContext.CommandStart))
      this.error("expected 'do'", this.tok.getPos());
    const body = this.list();
    this.skipSemi();
    const closeEnd = this.acceptEnd(Token.Done, LexContext.CommandStart);
    if (closeEnd < 0)
      this.error(`expected 'done' to close '${kind}'`, this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this.syntaxDepth--;
    this._redirects = this.collectTrailingRedirects();
    return { type: "While", pos, end, kind, clause, body: this.makeCompoundList(body) };
  }
  caseClause() {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    const word = this.readWord(LexContext.Normal);
    this.skipNewlines(LexContext.CommandStart);
    if (!this.accept(Token.In, LexContext.CommandStart))
      this.error("expected 'in' after 'case' word", this.tok.getPos());
    this.skipNewlines(LexContext.CommandStart);
    if (this.syntaxDepth === MAX_SYNTAX_NESTING) {
      this.error("maximum case nesting depth exceeded", pos);
      const closeEnd2 = this.tok.skipCompoundBody(Token.Esac);
      if (closeEnd2 < 0)
        this.error("expected 'esac' to close 'case'", this.tok.getPos());
      const end2 = closeEnd2 >= 0 ? closeEnd2 : pos;
      this._redirects = this.collectTrailingRedirects();
      return { type: "Case", pos, end: end2, word, items: [] };
    }
    this.syntaxDepth++;
    const items = [];
    let t = this.tok.peek(LexContext.CommandStart).token;
    while (t !== Token.Esac && t !== Token.EOF) {
      const itemPos = this.tok.peek(LexContext.Normal).pos;
      this.accept(Token.LParen, LexContext.Normal);
      const pattern = [];
      t = this.tok.peek(LexContext.Normal).token;
      while (t !== Token.RParen && t !== Token.EOF) {
        if (t !== Token.Pipe)
          pattern.push(this.toWord(this.tok.next(LexContext.Normal)));
        else
          this.tok.next(LexContext.Normal);
        t = this.tok.peek(LexContext.Normal).token;
      }
      const rparenEnd = this.acceptEnd(Token.RParen, LexContext.Normal);
      const cmds = this.list();
      let itemEnd = rparenEnd >= 0 ? rparenEnd : itemPos;
      if (cmds.length > 0)
        itemEnd = cmds[cmds.length - 1].end;
      const item = {
        type: "CaseItem",
        pos: itemPos,
        end: itemEnd,
        pattern,
        body: this.makeCompoundList(cmds),
        terminator: undefined
      };
      t = this.tok.peek(LexContext.CommandStart).token;
      if (t === Token.DoubleSemi || t === Token.SemiAmp || t === Token.DoubleSemiAmp) {
        const termTok = this.tok.next(LexContext.CommandStart);
        item.terminator = CASE_TERMINATORS[termTok.token];
        item.end = termTok.end;
      }
      items.push(item);
      this.skipNewlines(LexContext.CommandStart);
      t = this.tok.peek(LexContext.CommandStart).token;
    }
    const closeEnd = this.acceptEnd(Token.Esac, LexContext.CommandStart);
    if (closeEnd < 0)
      this.error("expected 'esac' to close 'case'", this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this.syntaxDepth--;
    this._redirects = this.collectTrailingRedirects();
    return { type: "Case", pos, end, word, items };
  }
  selectClause() {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    const name = this.readWord(LexContext.Normal);
    const wordlist = [];
    this.skipNewlines(LexContext.CommandStart);
    if (this.tok.peek(LexContext.CommandStart).token === Token.In) {
      this.tok.next(LexContext.CommandStart);
      while (this.tok.peek(LexContext.Normal).token === Token.Word) {
        wordlist.push(this.readWord(LexContext.Normal));
      }
    }
    this.skipSemi();
    this.skipNewlines(LexContext.CommandStart);
    if (this.tok.peek(LexContext.CommandStart).token === Token.LBrace) {
      const bg = this.braceGroup();
      return { type: "Select", pos, end: bg.end, name, wordlist, body: bg.body };
    }
    if (!this.accept(Token.Do, LexContext.CommandStart))
      this.error("expected 'do'", this.tok.getPos());
    if (this.syntaxDepth === MAX_SYNTAX_NESTING) {
      this.error("maximum select nesting depth exceeded", pos);
      const closeEnd2 = this.tok.skipCompoundBody(Token.Done);
      if (closeEnd2 < 0)
        this.error("expected 'done' to close 'select'", this.tok.getPos());
      const end2 = closeEnd2 >= 0 ? closeEnd2 : pos;
      this._redirects = this.collectTrailingRedirects();
      return { type: "Select", pos, end: end2, name, wordlist, body: this.makeCompoundList([]) };
    }
    this.syntaxDepth++;
    const body = this.list();
    this.syntaxDepth--;
    this.skipSemi();
    const closeEnd = this.acceptEnd(Token.Done, LexContext.CommandStart);
    if (closeEnd < 0)
      this.error("expected 'done' to close 'select'", this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this._redirects = this.collectTrailingRedirects();
    return { type: "Select", pos, end, name, wordlist, body: this.makeCompoundList(body) };
  }
  testCommand() {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    const expr = this.parseTestOr();
    const closeEnd = this.acceptEnd(Token.DblRBracket, LexContext.TestMode);
    if (closeEnd < 0)
      this.error("expected ']]' to close '[['", this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this._redirects = this.collectTrailingRedirects();
    return { type: "TestCommand", pos, end, expression: expr };
  }
  parseTestOr() {
    let left = this.parseTestAnd();
    while (this.tok.peek(LexContext.TestMode).token === Token.Or) {
      this.tok.next(LexContext.TestMode);
      const right = this.parseTestAnd();
      left = {
        type: "TestLogical",
        pos: left.pos,
        end: right.end,
        operator: "||",
        left,
        right
      };
    }
    return left;
  }
  parseTestAnd() {
    let left = this.parseTestNot();
    while (this.tok.peek(LexContext.TestMode).token === Token.And) {
      this.tok.next(LexContext.TestMode);
      const right = this.parseTestNot();
      left = {
        type: "TestLogical",
        pos: left.pos,
        end: right.end,
        operator: "&&",
        left,
        right
      };
    }
    return left;
  }
  parseTestNot() {
    let t = this.tok.peek(LexContext.TestMode);
    if (!isTestNegation(t))
      return this.parseTestPrimary();
    const firstPos = this.tok.next(LexContext.TestMode).pos;
    t = this.tok.peek(LexContext.TestMode);
    if (!isTestNegation(t)) {
      const operand = this.parseTestPrimary();
      return { type: "TestNot", pos: firstPos, end: operand.end, operand };
    }
    const positions = [firstPos];
    while (isTestNegation(t)) {
      positions.push(this.tok.next(LexContext.TestMode).pos);
      t = this.tok.peek(LexContext.TestMode);
    }
    let expression = this.parseTestPrimary();
    for (let i = positions.length - 1;i >= 0; i--) {
      expression = {
        type: "TestNot",
        pos: positions[i],
        end: expression.end,
        operand: expression
      };
    }
    return expression;
  }
  parseTestPrimary() {
    if (this.tok.peek(LexContext.TestMode).token === Token.LParen) {
      const openPos = this.tok.next(LexContext.TestMode).pos;
      if (this.syntaxDepth === MAX_SYNTAX_NESTING) {
        this.error("maximum test group nesting depth exceeded", openPos);
        const closeEnd2 = this.tok.skipTestGroup();
        if (closeEnd2 < 0)
          this.error("expected ')' to close test group", this.tok.getPos());
        const end2 = closeEnd2 >= 0 ? closeEnd2 : openPos;
        const operand = new WordImpl("", openPos, openPos, this.source, undefined, this.depth);
        const expression = {
          type: "TestUnary",
          pos: openPos,
          end: openPos,
          operator: "-n",
          operand
        };
        return { type: "TestGroup", pos: openPos, end: end2, expression };
      }
      this.syntaxDepth++;
      const expr = this.parseTestOr();
      this.syntaxDepth--;
      const closeEnd = this.acceptEnd(Token.RParen, LexContext.TestMode);
      if (closeEnd < 0)
        this.error("expected ')' to close test group", this.tok.getPos());
      const end = closeEnd >= 0 ? closeEnd : openPos;
      return { type: "TestGroup", pos: openPos, end, expression: expr };
    }
    const first = this.tok.next(LexContext.TestMode);
    const val = first.value;
    const firstPos = first.pos;
    const firstEnd = first.end;
    if (first.keywordEligible && UNARY_TEST_OPS[val] === 1) {
      const nt2 = this.tok.peek(LexContext.TestMode).token;
      if (nt2 === Token.Word) {
        const operand = this.readWord(LexContext.TestMode);
        return {
          type: "TestUnary",
          pos: firstPos,
          end: operand.end,
          operator: val,
          operand
        };
      }
    }
    const nt = this.tok.peek(LexContext.TestMode);
    if (nt.token === Token.Word && nt.keywordEligible && BINARY_TEST_OPS[nt.value] === 1) {
      const op = this.tok.next(LexContext.TestMode).value;
      let right;
      if (op === "=~") {
        const token = this.tok.readTestRegexWord();
        right = new WordImpl(this.source.slice(token.pos, token.end), token.pos, token.end, this.source, computeEmbeddedWordParts, this.depth);
      } else {
        right = this.readWord(LexContext.TestMode);
      }
      const left = this.toWordFromPosEnd(first, firstPos, firstEnd);
      return {
        type: "TestBinary",
        pos: firstPos,
        end: right.end,
        operator: op,
        left,
        right
      };
    }
    const w = this.toWordFromPosEnd(first, firstPos, firstEnd);
    return { type: "TestUnary", pos: firstPos, end: w.end, operator: "-n", operand: w };
  }
  functionDef() {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    const name = this.readWord(LexContext.Normal);
    let body;
    if (this.tok.peek(LexContext.CommandStart).token === Token.LParen) {
      const openPos = this.tok.next(LexContext.CommandStart).pos;
      if (this.tok.peek(LexContext.CommandStart).token === Token.RParen) {
        this.tok.next(LexContext.CommandStart);
        this.skipNewlines(LexContext.CommandStart);
        body = this.commandAsBody();
      } else {
        body = this.subshellBody(openPos);
      }
    } else {
      this.skipNewlines(LexContext.CommandStart);
      body = this.commandAsBody();
    }
    const redirects = this._redirects;
    this._redirects = EMPTY_REDIRECTS;
    const end = redirects.length > 0 ? redirects[redirects.length - 1].end : body.end;
    return { type: "Function", pos, end, name, body, redirects: ownEmpty(redirects) };
  }
  simpleCommandOrFunction() {
    const prefix = [];
    let redirects = [];
    let cmdPos = this.tok.peek(LexContext.CommandStart).pos;
    let lastEnd = cmdPos;
    let ctx = LexContext.CommandStart;
    for (;; ) {
      const t = this.tok.peek(ctx).token;
      if (t === Token.Assignment) {
        const assignment = this.tok.next(ctx);
        lastEnd = assignment.end;
        prefix.push(this.parseAssignment(assignment));
      } else if (t === Token.Redirect) {
        redirects = this.collectRedirect(redirects, ctx);
        lastEnd = redirects[redirects.length - 1].end;
      } else {
        break;
      }
      ctx = LexContext.CommandPrefix;
    }
    if (this.tok.peek(LexContext.Normal).token !== Token.Word) {
      return {
        type: "Command",
        pos: cmdPos,
        end: lastEnd,
        name: undefined,
        prefix,
        suffix: [],
        redirects
      };
    }
    const name = this.readWord(LexContext.Normal);
    lastEnd = name.end;
    if (this.tok.peek(LexContext.Normal).token === Token.LParen) {
      this.tok.next(LexContext.Normal);
      if (this.tok.peek(LexContext.Normal).token === Token.RParen) {
        this.tok.next(LexContext.Normal);
        this.skipNewlines(LexContext.CommandStart);
        const body = this.commandAsBody();
        const bodyRedirects = this._redirects;
        this._redirects = EMPTY_REDIRECTS;
        const end = bodyRedirects.length > 0 ? bodyRedirects[bodyRedirects.length - 1].end : body.end;
        return {
          type: "Function",
          pos: name.pos,
          end,
          name,
          body,
          redirects: ownEmpty(bodyRedirects)
        };
      }
    }
    const suffix = [];
    for (;; ) {
      const st = this.tok.peek(LexContext.Normal).token;
      if (st === Token.Word || st === Token.Assignment) {
        const w = this.readWord(LexContext.Normal);
        suffix.push(w);
        lastEnd = w.end;
      } else if (st === Token.Redirect) {
        redirects = this.collectRedirect(redirects, LexContext.Normal);
        lastEnd = redirects[redirects.length - 1].end;
      } else {
        break;
      }
    }
    return {
      type: "Command",
      pos: cmdPos,
      end: lastEnd,
      name,
      prefix,
      suffix,
      redirects
    };
  }
  collectRedirect(redirects, ctx) {
    if (redirects === EMPTY_REDIRECTS)
      redirects = [];
    const t = this.tok.next(ctx);
    const tPos = t.pos;
    const tEnd = t.end;
    const r = {
      pos: tPos,
      end: tEnd,
      operator: REDIRECT_OPS[t.value] ?? ">",
      target: undefined,
      fileDescriptor: t.fileDescriptor,
      variableName: t.variableName,
      content: t.content,
      heredocQuoted: undefined,
      body: undefined
    };
    if (t.targetEnd > t.targetPos) {
      const heredoc = t.value === "<<" || t.value === "<<-";
      const resolver = heredoc ? heredocDelimiterParts(t.content ?? "") : undefined;
      const text = this.source.slice(t.targetPos, t.targetEnd);
      r.target = new WordImpl(text, t.targetPos, t.targetEnd, this.source, resolver, this.depth);
    } else {
      this.error("expected redirect target", t.targetPos);
    }
    if (r.target && (t.value === "<<" || t.value === "<<-"))
      this.tok.registerHereDocTarget(r);
    redirects.push(r);
    return redirects;
  }
  commandAsBody() {
    const t = this.tok.peek(LexContext.CommandStart).token;
    if (t === Token.LBrace)
      return this.braceGroup();
    if (t === Token.LParen)
      return this.subshell();
    const cmd = this.command();
    const p = this.tok.getPos();
    return cmd ?? { type: "CompoundList", pos: p, end: p, commands: [] };
  }
  readWord(ctx) {
    return this.toWord(this.tok.next(ctx));
  }
  toWord(tok) {
    const text = tok.raw ? tok.value : this.source.slice(tok.pos, tok.end);
    return new WordImpl(text, tok.pos, tok.end, this.source, undefined, this.depth);
  }
  toWordFromPosEnd(tok, pos, end) {
    const text = tok.raw && tok.pos === pos && tok.end === end ? tok.value : this.source.slice(pos, end);
    return new WordImpl(text, pos, end, this.source, undefined, this.depth);
  }
  parseAssignment(tok) {
    const text = tok.raw ? tok.value : this.source.slice(tok.pos, tok.end);
    const tokPos = tok.pos;
    const tokEnd = tok.end;
    const result = {
      type: "Assignment",
      pos: tokPos,
      end: tokEnd,
      text,
      name: undefined,
      value: undefined,
      append: undefined,
      index: undefined,
      indexParts: undefined,
      array: undefined
    };
    const eqIdx = tok.assignmentOperatorPos - tokPos;
    if (eqIdx <= 0)
      return result;
    let nameEnd = eqIdx;
    let append = false;
    let index;
    let appendPos = eqIdx;
    while (appendPos >= 2 && text.charCodeAt(appendPos - 2) === 92 && text.charCodeAt(appendPos - 1) === 10)
      appendPos -= 2;
    if (text.charCodeAt(appendPos - 1) === 43) {
      append = true;
      nameEnd = appendPos - 1;
    }
    const bracketIdx = text.indexOf("[");
    if (bracketIdx > 0 && bracketIdx < nameEnd) {
      const rbracketIdx = text.lastIndexOf("]", eqIdx);
      if (rbracketIdx > bracketIdx) {
        index = text.slice(bracketIdx + 1, rbracketIdx);
        nameEnd = bracketIdx;
      }
    }
    const rawName = text.slice(0, nameEnd);
    const name = rawName.includes("\\\n") ? rawName.split("\\\n").join("") : rawName;
    result.name = name;
    if (append)
      result.append = true;
    if (index !== undefined) {
      result.index = index;
      const indexPos = tokPos + bracketIdx + 1;
      const indexEnd = indexPos + index.length;
      if (hasEmbeddedWordStructure(this.source, indexPos, indexEnd)) {
        const indexWord = new WordImpl(index, indexPos, indexEnd, this.source, computeEmbeddedWordParts, this.depth);
        Object.defineProperty(result, "indexParts", {
          configurable: true,
          enumerable: true,
          get: () => indexWord.parts,
          set: (value) => {
            indexWord.parts = value;
          }
        });
      }
    }
    const valStart = eqIdx + 1;
    const valueStart = tokPos + valStart;
    if (valStart < text.length && text.charCodeAt(valStart) === 40 && text.charCodeAt(text.length - 1) === 41) {
      const elements = this.parseArrayElements(valueStart + 1, tokEnd - 1);
      result.array = elements;
    } else {
      result.value = new WordImpl(text.slice(valStart), valueStart, tokEnd, this.source, undefined, this.depth);
    }
    return result;
  }
  parseArrayElements(start, end) {
    const subTok = new Lexer(this.source, start, end);
    const elements = [];
    while (subTok.peek(LexContext.Normal).token !== Token.EOF) {
      if (subTok.peek(LexContext.Normal).token === Token.Newline) {
        subTok.next(LexContext.Normal);
        continue;
      }
      const t = subTok.next(LexContext.Normal);
      if (t.token === Token.Word || t.token === Token.Assignment) {
        const text = t.raw ? t.value : this.source.slice(t.pos, t.end);
        elements.push(new WordImpl(text, t.pos, t.end, this.source, undefined, this.depth));
      }
    }
    return elements;
  }
  makeCompoundList(commands) {
    const p = this.tok.getPos();
    const pos = commands.length > 0 ? commands[0].pos : p;
    const end = commands.length > 0 ? commands[commands.length - 1].end : p;
    return { type: "CompoundList", pos, end, commands };
  }
}
export {
  parseRegion,
  parse
};
