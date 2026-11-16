// parse.js — a fast Markdown renderer, byte-identical to marked 18.1.3
// (GFM on, default options) for every input. Dependency-free ES module.
//
// Fused single-pass recursive descent: blocks dispatch per line, inline
// dispatches per character, and both render straight into one string with
// `+=` (no token tree, no lex-then-parse phases, no per-token objects).
// Link reference definitions are collected by one cheap structural pre-scan
// (scanDefs) so forward references resolve exactly like marked's, which
// lexes every block before it inlines any of them.
//
// Written from the CommonMark 0.31.2 / GFM 0.29 rules and the observed
// behaviour of marked 18.1.3 on its own spec suite; the code below is an
// independent implementation of that grammar.

// ---------------------------------------------------------------------------
// Character classes. ASCII (0-127) via a flag table; anything else falls
// back to a unicode test, cached per character.
// flags: 1 = whitespace, 2 = punctuation (CommonMark: ASCII punct + \p{P}\p{S}),
// 4 = alphanumeric (\p{L}\p{N}), 8 = digit
const _CC = new Uint8Array(128);
for (let i = 0; i < 128; i++) {
  const c = String.fromCharCode(i);
  let f = 0;
  if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') f |= 1;
  if ((i >= 33 && i <= 47) || (i >= 58 && i <= 64) || (i >= 91 && i <= 96) || (i >= 123 && i <= 126)) f |= 2;
  if ((i >= 48 && i <= 57) || (i >= 65 && i <= 90) || (i >= 97 && i <= 122)) f |= 4;
  if (i >= 48 && i <= 57) f |= 8;
  _CC[i] = f;
}
const _punctRe = /[\p{P}\p{S}]/u;
const _spaceRe = /\s/u;
const _alnumRe = /[\p{L}\p{N}]/u;
const _ccCache = new Map();
function cc(ch) {
  const code = ch.charCodeAt(0);
  if (code < 128) return _CC[code];
  let f = _ccCache.get(ch);
  if (f === undefined) {
    f = 0;
    if (_spaceRe.test(ch)) f |= 1;
    if (_punctRe.test(ch)) f |= 2;
    if (_alnumRe.test(ch)) f |= 4;
    _ccCache.set(ch, f);
  }
  return f;
}
const isSpaceCh = (ch) => ch !== '' && (cc(ch) & 1) !== 0;
// GFM emphasis treats `~` as NOT punctuation (it is the strikethrough marker).
const isPunctCh = (ch) => ch !== '' && (cc(ch) & 2) !== 0;
const isPunctGfm = (ch) => ch !== '' && ch !== '~' && (cc(ch) & 2) !== 0;
// The backslash-escape rule only unescapes ASCII punctuation (marked's
// escape regex); a backslash before a non-ASCII punct char (e.g. `\«`) is
// a literal backslash.
const isAsciiPunct = (ch) => {
  if (ch === '') return false;
  const code = ch.charCodeAt(0);
  return code < 128 && (_CC[code] & 2) !== 0;
};
const isAlnumCh = (ch) => ch !== '' && (cc(ch) & 4) !== 0;
// The punctuation test marked's emStrong/del use for the char before a run:
// whitespace or punctuation, but never `*` or `_`.
const isPunctOrSpaceNoDelim = (ch) => ch !== '' && ch !== '*' && ch !== '_' && ((cc(ch) & 3) !== 0);

// ---------------------------------------------------------------------------
// HTML escaping. Regex replace wins over hand-rolled loops (V8 does it in C++).
// encode=true escapes every `&`; encode=false leaves an `&` that already
// starts a valid entity reference alone.
const _ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const _ESC_RE = /[&<>"']/g;
const _ESC_TEST = /[&<>"']/;
const _ESC_NOENC_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const _ESC_NOENC_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
function esc(s, encode) {
  if (encode) {
    return _ESC_TEST.test(s) ? s.replace(_ESC_RE, (c) => _ESC_MAP[c]) : s;
  }
  return _ESC_NOENC_TEST.test(s) ? s.replace(_ESC_NOENC_RE, (c) => _ESC_MAP[c]) : s;
}
// One escaped punctuation character, as an escape token renders it.
function escChar(ch) {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '"') return '&quot;';
  if (ch === "'") return '&#39;';
  return ch;
}

// ---------------------------------------------------------------------------
// Numeric character references. A decoded character must not join its
// neighbours into a new reference, so every `&` that is not already one is
// escaped here too. 0, out of range and surrogates become U+FFFD; 38 is `&amp;`.
const _NUM_REF_TEST = /&#(?:\d{1,7}|[Xx][a-fA-F0-9]{1,6});/;
const _NUM_REF_AMP = /&#(?:(\d{1,7})|[Xx]([a-fA-F0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeEnt(s) {
  if (!_NUM_REF_TEST.test(s)) return s;
  return s.replace(_NUM_REF_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

// ---------------------------------------------------------------------------
// Small string helpers.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}
// Index of the bracket that closes the one opened at the start of `str`
// (brackets nest, backslash escapes one char); -1 if none, -2 if an opener
// is left unmatched. Code spans are NOT skipped: a `]` inside backticks
// still closes the bracket.
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}
function rtrim(s, c) {
  let e = s.length;
  while (e > 0 && s[e - 1] === c) e--;
  return s.slice(0, e);
}
function trimTrailingBlankLines(s) {
  const lines = s.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  if (lines.length - end <= 2) return s;
  return lines.slice(0, end + 1).join('\n');
}
function expandTabs(line, indent) {
  let col = indent || 0;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const a = 4 - (col % 4);
      out += ' '.repeat(a);
      col += a;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}
// Expand only the leading whitespace tabs of `line` (to spaces, from the
// tab stops at `startCol`); the rest of the line is left untouched. This is
// what marked does to a line before measuring its indent.
function expandTabsLeading(line, startCol) {
  let col = startCol;
  let k = 0;
  let out = '';
  while (k < line.length) {
    const ch = line[k];
    if (ch === ' ') { out += ' '; col++; k++; }
    else if (ch === '\t') { const a = 4 - (col % 4); out += ' '.repeat(a); col += a; k++; }
    else break;
  }
  return out + line.slice(k);
}
// Unescape backslash-escaped punctuation: `\x` -> `x` for x punctuation/symbol.
const _ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
function unescapePunct(s) {
  return _ANY_PUNCT.test(s) ? s.replace(_ANY_PUNCT, '$1') : s;
}
// Table cells: escape-aware pipe split, trim, pad/truncate to count.
// Single manual pass: a `|` preceded by an odd run of backslashes is
// escaped (it stays in the cell); otherwise it separates cells.
function splitCells(row, count) {
  const cells = [];
  let start = 0;
  let i = 0;
  const n = row.length;
  while (i < n) {
    const ch = row[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '|') {
      cells.push(row.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  cells.push(row.slice(start));
  // A leading/trailing `|` leaves one empty cell at each end; drop it.
  let a = 0;
  let b = cells.length;
  if (b > 0 && cells[0].trim() === '') a = 1;
  if (b > a && cells[b - 1].trim() === '') b--;
  const out = [];
  for (let k = a; k < b; k++) out.push(cells[k].trim().replace(/\\\|/g, '|'));
  if (count) {
    if (out.length > count) out.length = count;
    else while (out.length < count) out.push('');
  }
  return out;
}
// Last code point of a string (handles an astral char at the end).
function lastCodePoint(s) {
  if (s === '') return '';
  const c = s.charCodeAt(s.length - 1);
  if (c >= 0xdc00 && c <= 0xdfff && s.length >= 2) {
    const h = s.charCodeAt(s.length - 2);
    if (h >= 0xd800 && h <= 0xdbff) return s.slice(-2);
  }
  return s[s.length - 1];
}

// ---------------------------------------------------------------------------
// Link reference definitions. A definition is collected when it sits at a
// block boundary (the block walker only calls matchDef there, so a line
// swallowed into a paragraph is never offered to it). The first definition
// of a label wins.
// ---------------------------------------------------------------------------

// Parse a link title starting at win[pos] ('"' or '\'' or '('). The title may
// span lines (`"` and `(` titles freely; `'` titles only across single
// newlines). Returns {title, next} or null.
function parseTitleAt(win, pos) {
  const q = win[pos];
  const close = q === '(' ? ')' : q;
  let j = pos + 1;
  const n = win.length;
  let out = '';
  while (j < n) {
    const c = win[j];
    if (c === close) return { title: out, next: j + 1 };
    // Keep a backslash escape raw (both chars) so the closing quote is not
    // mistaken for the end; the final unescapePunct does the unescaping
    // (only punctuation escapes drop the backslash).
    if (c === '\\' && j + 1 < n) { out += c + win[j + 1]; j += 2; continue; }
    if (c === '\n') {
      if (q === "'") {
        if (win[j + 1] === '\n') return null;
        out += '\n'; j++; continue;
      }
      out += '\n'; j++; continue;
    }
    if (q === "'" && c === '\n') return null;
    out += c; j++;
  }
  return null;
}

// Match a link reference definition starting at lines[i]. The line must begin
// (after at most 3 spaces) with '['. Returns {tag, href, title, endLine}
// (endLine = first line after the definition) or null.
function matchDef(lines, i) {
  const line = lines[i];
  let p = 0;
  while (p < line.length && line[p] === ' ') p++;
  if (p > 3 || line[p] !== '[') return null;
  // A definition spans at most a few lines (label wrap, destination line,
  // title line); parse it out of a small window of the following lines.
  const win = lines.slice(i, i + 16).join('\n');
  // label: not empty / not all whitespace, escapes, no unescaped brackets,
  // a newline only when the next line is not blank.
  let j = p + 1;
  let labelEnd = -1;
  let nonWs = false;
  while (j < win.length) {
    const c = win[j];
    if (c === '\\') { j += 2; nonWs = true; continue; }
    if (c === ']') { labelEnd = j; break; }
    if (c === '[') return null;
    if (c === '\n') {
      let m = j + 1;
      while (m < win.length && (win[m] === ' ' || win[m] === '\t')) m++;
      if (m >= win.length || win[m] === '\n') return null;
      j++;
      continue;
    }
    if (c !== ' ' && c !== '\t') nonWs = true;
    j++;
  }
  if (labelEnd === -1 || !nonWs) return null;
  const label = win.slice(p + 1, labelEnd);
  let k = labelEnd + 1;
  if (win[k] !== ':') return null;
  k++;
  // spaces, then optionally one newline + spaces before the destination
  while (win[k] === ' ' || win[k] === '\t') k++;
  if (win[k] === '\n') {
    k++;
    while (win[k] === ' ' || win[k] === '\t') k++;
  }
  // destination
  let dest;
  if (win[k] === '<') {
    const gt = win.indexOf('>', k + 1);
    const nl = win.indexOf('\n', k + 1);
    if (gt === -1 || (nl !== -1 && nl < gt)) return null;
    dest = win.slice(k + 1, gt);
    k = gt + 1;
  } else {
    if (k >= win.length || win[k] === ' ' || win[k] === '\t' || win[k] === '\n' || win[k] === '<') return null;
    let d = k;
    while (d < win.length && win[d] !== ' ' && win[d] !== '\t' && win[d] !== '\n') d++;
    dest = win.slice(k, d);
    k = d;
    // outside angle brackets a destination holds only balanced parentheses
    if (findClosingBracket(dest, '()') !== -1) return null;
  }
  // optional title: spaces (then optionally newline + spaces) or a newline +
  // spaces, then a quoted title. After it only spaces up to the line end.
  // When the title sits on the NEXT line and fails (unterminated, or text
  // after it), the definition still stands without a title and the title
  // line is left for the paragraph; when the title is on the SAME line and
  // fails, the whole definition fails.
  let title = null;
  {
    let t = k;
    let spaces = 0;
    while (win[t] === ' ' || win[t] === '\t') { t++; spaces++; }
    let titleStart = -1;
    let titleNextLine = false;
    if (win[t] === '\n') {
      let u = t + 1;
      while (win[u] === ' ' || win[u] === '\t') u++;
      if (win[u] === '"' || win[u] === "'" || win[u] === '(') { titleStart = u; titleNextLine = true; }
    } else if (spaces >= 1 && (win[t] === '"' || win[t] === "'" || win[t] === '(')) {
      titleStart = t;
    }
    if (titleStart !== -1) {
      const parsed = parseTitleAt(win, titleStart);
      let v = parsed ? parsed.next : -1;
      if (parsed) {
        while (win[v] === ' ' || win[v] === '\t') v++;
        if (win[v] !== '\n' && v < win.length) v = -1;
      }
      if (v === -1) {
        if (!titleNextLine) return null;
        // no title: leave k at the end of the destination
      } else {
        title = parsed.title;
        k = v;
      }
    }
  }
  while (win[k] === ' ' || win[k] === '\t') k++;
  if (k < win.length && win[k] !== '\n') return null;
  let consumed = 1;
  for (let m = 0; m < k; m++) if (win[m] === '\n') consumed++;
  return {
    tag: normLabel(label),
    href: unescapePunct(dest),
    title: title === null ? null : unescapePunct(title),
    endLine: i + consumed,
  };
}

// ---------------------------------------------------------------------------
// Inline link pieces.
// ---------------------------------------------------------------------------

// A link label `[...]`: the content may hold one level of nested brackets,
// backslash escapes and code spans. The match is lazy, so the first `]` that
// can close the label wins. Group 1 is the label content.
const LABEL_RE = /^\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]/;

// Parse a link destination starting at s[pos] (after `(` or after `:` in a
// definition, with leading spaces/newlines already skipped). Returns
// {dest, next} or null. `<...>` destinations are single-line; bare ones end
// at whitespace and hold balanced parentheses.
function parseDest(s, pos) {
  const n = s.length;
  if (s[pos] === '<') {
    let j = pos + 1;
    let out = '';
    while (j < n) {
      const c = s[j];
      if (c === '\n') return null;
      if (c === '>') return { dest: out, next: j + 1 };
      if (c === '<') return null;
      if (c === '\\' && j + 1 < n && isPunctCh(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c; j++;
    }
    return null;
  }
  let j = pos;
  let depth = 0;
  let out = '';
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f') break;
    if (c === '\\' && j + 1 < n && isPunctCh(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (c === '(') { depth++; out += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; out += c; j++; continue;
    }
    const code = c.charCodeAt(0);
    if (code < 32 || code === 127) break;
    out += c; j++;
  }
  if (j === pos) return null;
  return { dest: out, next: j };
}

// Parse a link title starting at s[pos] (after optional spaces/newlines).
// Returns {title, next} or null. A `'` title may not contain a newline.
function parseInlineTitle(s, pos) {
  const n = s.length;
  let j = pos;
  while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j >= n) return null;
  const q = s[j];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  j++;
  let out = '';
  while (j < n) {
    const c = s[j];
    if (c === close) return { title: out, next: j + 1 };
    if (c === '\n' && q === "'") return null;
    if (c === '\\' && j + 1 < n && isPunctCh(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (c === '\\' && j + 1 < n) { out += s[j + 1]; j += 2; continue; }
    out += c; j++;
  }
  return null;
}

// A label holding a raw `<tag>` or autolink that runs past the label's end
// can never be a link.
const _INLINE_TAG_RE = /^(?:<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>)/;
const _AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)>/;
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = _INLINE_TAG_RE.exec(tokenSrc) || _AUTOLINK_RE.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Masking. Emphasis and strikethrough scan a masked copy of the inline
// source so delimiters inside links, code spans, html tags and backslash
// escapes cannot open or close a span. Every mask keeps the length it
// replaces, so indices in the masked copy line up with the real source.
// ---------------------------------------------------------------------------

// Inline links, code spans and html tags, flattened to `[aaa...]`.
const BLOCKSKIP_RE = /\[(?:[^\[\]`]|(`+)[^`]+\1(?!`))*?\]\((?:\\[\s\S]|[^\()]|\((?:\\[\s\S]|[^\()])*\))*\)|(?<!`)(`+)[^`]+\2(?!`)|<(?! )[^<>]*?>/g;
// An inline link on its own (for the link-in-text check).
const INLINE_LINK_RE = /^\[(?:[^\[\]`]|(`+)[^`]+\1(?!`))*?\]\((?:\\[\s\S]|[^\()]|\((?:\\[\s\S]|[^\()])*\))*\)/;
// Reflink candidates: `[label][ref]` or `[ref]` (with an optional `[]`).
const REFLINK_SEARCH_RE = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
// Escaped punctuation outside code spans (a backslash inside a code span is
// literal, so code spans are matched whole and their inner backticks masked).
const ESCAPE_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;

// Does this link text already hold a link? Images do not count.
function linkInText(text, links) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(BLOCKSKIP_RE)) {
    if (INLINE_LINK_RE.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(REFLINK_SEARCH_RE)) {
    const match0 = m[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!') continue;
    if (!links.has(normLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), links)) continue;
    return true;
  }
  return false;
}

function maskSrc(s, links) {
  // Fast path: nothing to mask (no link/code/html/escape to hide from
  // the emphasis scanner) — the masked source is the source itself.
  if (!s.includes('[') && !s.includes('`') && !s.includes('<') && !s.includes('\\')) return s;
  let masked = s;
  // 1. Defined reflinks are flattened; a candidate whose text already holds
  // a link is not a link, so only the links it holds (and its ref) are masked.
  if (links.size > 0 && s.includes('[')) {
    const maskOne = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!links.has(normLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, links)) {
          return '[' + text.replace(REFLINK_SEARCH_RE, maskOne)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    masked = masked.replace(REFLINK_SEARCH_RE, maskOne);
  }
  // 2. Escaped punctuation (masked to `+`); code spans keep their backticks
  // so step 3 still recognises them, with inner backticks masked.
  masked = masked.replace(ESCAPE_OUTSIDE_CODE_RE, (match0, code, punct) => {
    if (punct) return '+'.repeat(match0.length);
    if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return match0;
  });
  // 3. Inline links, code spans and html tags are flattened to `[aaa...]`.
  masked = masked.replace(BLOCKSKIP_RE, (match0) => '[' + 'a'.repeat(match0.length - 2) + ']');
  return masked;
}

// One scan of the masked source for the last run that can close emphasis
// (per delimiter) and strikethrough. A run can close only when the character
// before it is not whitespace; a leading run has no predecessor, same as one
// after a line break.
function lastCloserHint(masked) {
  const hint = { '*': -1, '_': -1, '~': -1 };
  const len = masked.length;
  for (let i = 0; i < len; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < len && masked[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      hint[ch] = i;
    }
    i = j - 1;
  }
  return hint;
}

// ---------------------------------------------------------------------------
// Emphasis / strong / strikethrough. These follow marked's single-pass
// delimiter scan: an opener looks ahead through the masked source for a
// closer, classifying each later run by its neighbours.
// ---------------------------------------------------------------------------

// Classify a delimiter run by the characters around it (in the masked
// source): 'right' (can only close), 'left' (can only open), 'either', or
// null (neither). For `_` there is no 'either' from a run between two
// non-punctuation non-space characters.
function classifyDelim(prevC, nextC, delim) {
  const isPunct = delim === '~' ? isPunctCh : isPunctGfm;
  const prevSpace = prevC !== '' && isSpaceCh(prevC);
  const prevPunct = isPunct(prevC);
  const prevNPS = prevC !== '' && !prevSpace && !prevPunct;
  const nextSpace = nextC === '' || isSpaceCh(nextC);
  const nextPunct = isPunct(nextC);
  const nextNPS = nextC !== '' && !nextSpace && !nextPunct;
  if (prevPunct && nextSpace) return 'right';
  if (prevNPS && (nextPunct || nextSpace)) return 'right';
  if ((prevPunct || prevSpace) && nextNPS) return 'left';
  if (prevSpace && nextPunct) return 'left';
  if (prevPunct && nextPunct) return 'either';
  if (delim === '*' && prevNPS && nextNPS) return 'either';
  return null;
}

// Next run of `delim` at or after `pos` in `masked` (up to length `n`).
function nextDelimRun(masked, pos, delim, n) {
  const p = masked.indexOf(delim, pos);
  if (p === -1 || p >= n) return null;
  let len = 1;
  while (p + len < n && masked[p + len] === delim) len++;
  return { start: p, len };
}

// Skip a delimiter of the other kind sitting inside a strong span of that
// kind (`*a __b*c__ d*` — the `*` between the `__`s cannot close the outer
// `*`). Only applies at the very start of the closer scan.
function skipOrphan(masked, pos, delim, n) {
  const other = delim === '*' ? '_' : '*';
  const strong = other + other;
  const q1 = masked.indexOf(strong, pos);
  if (q1 === -1) return pos;
  for (let k = pos; k < q1; k++) {
    if (masked[k] === delim || masked[k] === other) return pos;
  }
  let r = q1 + 2;
  while (r < n && masked[r] !== delim && masked[r] !== other) r++;
  if (r >= n || masked[r] !== delim) return pos;
  let s2 = r + 1;
  while (s2 < n && masked[s2] !== delim && masked[s2] !== other) s2++;
  if (s2 >= n || masked[s2] !== other) return pos;
  if (masked[s2 + 1] !== other) return pos;
  return s2;
}

// Try emphasis/strong at s[i] (a `*` or `_` run). Returns {html, next} or
// null. `masked`/`hint` belong to the whole inline string being rendered.
function tryEmStrong(s, masked, hint, i, prevChar, links, st, textMode) {
  const delim = s[i];
  const n = s.length;
  let run = 0;
  while (i + run < n && s[i + run] === delim) run++;
  const nextCh = i + run < n ? s[i + run] : '';
  if (nextCh === '' || isSpaceCh(nextCh)) return null;
  // The run may already have started before this position (its first
  // characters were taken as text after an earlier span failed). Flanking
  // and rules 9-10 are about the whole run, so find its start in the mask.
  // The character before the run (in the masked source) decides flanking;
  // the renderer's prevChar goes stale while scanning plain text, so it is
  // not used here.
  let runStart = i;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  const midRun = runStart < i;
  const effPrev = runStart === 0 ? '' : lastCodePoint(masked.slice(Math.max(0, runStart - 2), runStart));
  const nextIsPunct = isPunctGfm(nextCh);
  // `_` cannot open inside a word.
  if (delim === '_' && !nextIsPunct && isAlnumCh(effPrev)) return null;
  // Left-flanking: the next char is not punctuation, or there is no previous
  // char, or the previous char is punctuation/space (but not `*`/`_`).
  if (nextIsPunct && effPrev !== '' && !isPunctOrSpaceNoDelim(effPrev)) return null;

  const lLength = run;
  const runLength = i - runStart + lLength;
  const runPrev = effPrev;
  const openerCanClose = runPrev !== '' && runPrev.trim() !== ''
    && (nextIsPunct || (delim === '*' && !isPunctOrSpaceNoDelim(runPrev)));
  const lastPossible = hint[delim];
  const windowStart = i + lLength;
  if (lastPossible < windowStart) return null;

  let delimTotal = lLength;
  let midDelimTotal = 0;
  let pos = skipOrphan(masked, windowStart, delim, n);
  while (true) {
    const runInfo = nextDelimRun(masked, pos, delim, n);
    if (!runInfo) return null;
    const p = runInfo.start;
    const rLength = runInfo.len;
    if (p > lastPossible) return null;
    const cls = classifyDelim(masked[p - 1], p + rLength < n ? masked[p + rLength] : '', delim);
    if (cls === null) { pos = p + rLength; continue; }
    if (cls === 'left') { delimTotal += rLength; pos = p + rLength; continue; }
    if (cls === 'either' || openerCanClose) {
      // A mid-run opener cannot close against an ambiguous delimiter that
      // can also open; that delimiter opens its own span instead.
      if (midRun && cls === 'either') return null;
      // CommonMark rules 9-10 (the sum of the two runs must not be a
      // multiple of 3 unless both are).
      if (runLength % 3 !== 0 && (runLength + rLength) % 3 === 0) {
        midDelimTotal += rLength;
        pos = p + rLength;
        continue;
      }
    }
    delimTotal -= rLength;
    if (delimTotal > 0) { pos = p + rLength; continue; }
    // Found the closer; drop any surplus characters from its run.
    const usedR = Math.min(rLength, rLength + delimTotal + midDelimTotal);
    const raw = s.slice(i, p + usedR);
    const next = p + usedR;
    const isEm = Math.min(lLength, usedR) % 2 === 1;
    const inner = isEm ? raw.slice(1, -1) : raw.slice(2, -2);
    const innerHtml = renderInline(inner, links, st, textMode);
    const html = textMode ? innerHtml : (isEm ? '<em>' + innerHtml + '</em>' : '<strong>' + innerHtml + '</strong>');
    return { html, next };
  }
}

// Try strikethrough at s[i] (a `~` run of 1-2). Returns {html, next} or null.
function tryDel(s, masked, hint, i, prevChar, links, st, textMode) {
  const n = s.length;
  let run = 0;
  while (run < 2 && i + run < n && s[i + run] === '~') run++;
  const nextCh = i + run < n ? s[i + run] : '';
  if (nextCh === '' || isSpaceCh(nextCh) || nextCh === '~') return null;
  const nextIsPunct = isPunctCh(nextCh);
  // Flanking comes from the character before the run in the masked source.
  let runStart = i;
  while (runStart > 0 && masked[runStart - 1] === '~') runStart--;
  const effPrev = runStart === 0 ? '' : lastCodePoint(masked.slice(Math.max(0, runStart - 2), runStart));
  if (nextIsPunct && effPrev !== '' && !isPunctOrSpaceNoDelim(effPrev)) return null;
  const lLength = run;
  const lastPossible = hint['~'];
  const windowStart = i + lLength;
  if (lastPossible < windowStart) return null;
  let delimTotal = lLength;
  let pos = windowStart;
  while (true) {
    const runInfo = nextDelimRun(masked, pos, '~', n);
    if (!runInfo) return null;
    const p = runInfo.start;
    const rLength = runInfo.len;
    if (p > lastPossible) return null;
    // Only a run of the same length can close a strikethrough.
    if (rLength !== lLength) { pos = p + rLength; continue; }
    const cls = classifyDelim(masked[p - 1], p + rLength < n ? masked[p + rLength] : '', '~');
    if (cls === null) { pos = p + rLength; continue; }
    if (cls === 'left') { delimTotal += rLength; pos = p + rLength; continue; }
    delimTotal -= rLength;
    if (delimTotal > 0) { pos = p + rLength; continue; }
    const usedR = Math.min(rLength, rLength + delimTotal);
    const raw = s.slice(i, p + usedR);
    const next = p + usedR;
    const inner = raw.slice(lLength, raw.length - lLength);
    const innerHtml = renderInline(inner, links, st, textMode);
    const html = textMode ? innerHtml : '<del>' + innerHtml + '</del>';
    return { html, next };
  }
}

// ---------------------------------------------------------------------------
// Inline rendering. One left-to-right pass over the string, in the order
// marked tries its tokenizers: escape, tag, link, reflink, emStrong,
// codespan, br, del, autolink, url, text. `st` carries the shared state
// (inLink, inRawBlock, linkEmitted); `textMode` renders plain text (image
// alt attributes) instead of HTML.
// ---------------------------------------------------------------------------

const _START_A_TAG = /^<a /i;
const _END_A_TAG = /^<\/a>/i;
const _START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const _END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
// A code span: matching backtick runs, content not starting/ending in one.
const _CODE_SPAN_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
// GFM extended autolink (sticky: matches only at the given position).
const _URL_RE = /(?:(?:mailto:|xmpp:)[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-]))/y;
const _BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const _EMAIL_CHAR_RE = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;

function isSchemeAt(s, i) {
  const c0 = s[i], c1 = s[i + 1], c2 = s[i + 2], c3 = s[i + 3];
  if ((c0 === 'h' || c0 === 'H') && (c1 === 't' || c1 === 'T') && (c2 === 't' || c2 === 'T') && (c3 === 'p' || c3 === 'P')) {
    let j = i + 4;
    if (s[j] === 's' || s[j] === 'S') j++;
    return s[j] === ':' && s[j + 1] === '/' && s[j + 2] === '/';
  }
  if ((c0 === 'f' || c0 === 'F') && (c1 === 't' || c1 === 'T') && (c2 === 'p' || c2 === 'P')) {
    return s[i + 3] === ':' && s[i + 4] === '/' && s[i + 5] === '/';
  }
  return false;
}

// A code span starting at s[i] (a backtick). Returns {html, next} or null.
function parseCodeSpan(s, i, textMode) {
  const m = _CODE_SPAN_RE.exec(s.slice(i));
  if (!m) return null;
  let content = m[2].replace(/\n/g, ' ');
  if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
    content = content.slice(1, -1);
  }
  return { html: textMode ? content : '<code>' + esc(content, true) + '</code>', next: i + m[0].length };
}

// An autolink `<...>` starting at s[i]. Returns {text, href, next} or null.
// No backslash escapes are processed inside an autolink.
function parseAutolink(s, i) {
  const n = s.length;
  let j = i + 1;
  let out = '';
  while (j < n) {
    const c = s[j];
    if (c === '>') {
      if (out.length === 0) return null;
      const m = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):([\s\S]*)$/.exec(out);
      if (m) {
        if (/[ \t\n<>]/.test(out)) return null;
        return { text: out, href: out, next: j + 1 };
      }
      if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(out)) {
        return { text: out, href: 'mailto:' + out, next: j + 1 };
      }
      return null;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '<') return null;
    out += c; j++;
  }
  return null;
}

// A GFM extended autolink at s[i] (www. / scheme:// / email / mailto:).
// Returns {text, href, next} or null.
function tryUrl(s, i) {
  _URL_RE.lastIndex = i;
  const m = _URL_RE.exec(s);
  if (!m) return null;
  const prev = i === 0 ? '' : s[i - 1];
  let text, href;
  if (m[2] === '@') {
    // plain email: only when not preceded by an email character
    if (prev !== '' && _EMAIL_CHAR_RE.test(prev)) return null;
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let t = m[0];
    let prevT;
    do {
      prevT = t;
      const b = _BACKPEDAL_RE.exec(t);
      t = b ? b[0] : '';
    } while (prevT !== t);
    if (t === '') return null;
    text = t;
    if (m[1] === 'www.') {
      // www. only after the start, whitespace, `*`, `_`, `~` or `(`
      if (prev !== '' && !(prev === ' ' || prev === '\t' || prev === '\n' || prev === '*' || prev === '_' || prev === '~' || prev === '(')) return null;
      href = 'http://' + t;
    } else {
      href = t;
      // mailto:/xmpp: only after a non-alphanumeric
      if (/^(?:mailto:|xmpp:)/i.test(t) && prev !== '' && /[A-Za-z0-9]/.test(prev)) return null;
    }
  }
  return { text, href, next: i + text.length };
}

// Build a link/image once its label, destination and title are known.
// Returns {html, next} or null when the link is rejected (its text holds
// another link). The label is rendered in text mode for images (alt text).
function buildLink(label, href, title, isImage, next, links, st, textMode) {
  const labelText = label.replace(/\\([\[\]])/g, '$1');
  const outerInLink = st.inLink;
  const outerLinkEmitted = st.linkEmitted;
  const outerInRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = renderInline(labelText, links, st, isImage ? true : textMode);
  const textHasLink = st.linkEmitted;
  st.linkEmitted = outerLinkEmitted;
  st.inLink = outerInLink;
  if (!isImage && textHasLink) {
    // Links may not contain other links; the outer one is dropped so the
    // inner link (already rendered into `inner`) is the one kept. Undo the
    // raw-block state the discarded label opened.
    st.inRawBlock = outerInRawBlock;
    return null;
  }
  if (!isImage) st.linkEmitted = true;
  const clean = cleanUrl(href);
  if (isImage) {
    if (clean === null) return { html: textMode ? inner : esc(inner, false), next };
    let out = '<img src="' + esc(clean, false) + '" alt="' + esc(inner, false) + '"';
    if (title) out += ' title="' + esc(title, false) + '"';
    out += '>';
    return { html: textMode ? inner : out, next };
  }
  if (clean === null) return { html: inner, next };
  let out = '<a href="' + esc(clean, false) + '"';
  if (title) out += ' title="' + esc(title, false) + '"';
  out += '>' + inner + '</a>';
  return { html: textMode ? inner : out, next };
}

// Try a link or image at s[i] ('[' or '!['). Returns {html, next},
// {oneChar:true} (a reflink matched but its reference is undefined: emit
// one character as text), or null (not a link at all).
function tryLink(s, i, links, st, textMode) {
  const n = s.length;
  const isImage = s[i] === '!';
  const open = isImage ? i + 1 : i;
  const labelM = LABEL_RE.exec(s.slice(open));
  if (!labelM) return null;
  const label = labelM[1];
  const labelEnd = open + labelM[0].length - 1;
  const after = labelEnd + 1;
  if (isLabelEndInsideToken(s, label, open + 1)) return null;
  // inline link: (dest "title")
  if (s[after] === '(') {
    let j = after + 1;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j < n && s[j] === ')') {
      return buildLink(label, '', null, isImage, j + 1, links, st, textMode);
    }
    if (j < n) {
      const d = parseDest(s, j);
      if (d) {
        let k = d.next;
        let title = null;
        let t = k;
        while (t < n && (s[t] === ' ' || s[t] === '\t')) t++;
        if (t < n && s[t] !== ')') {
          const ti = parseInlineTitle(s, t);
          if (ti) { title = ti.title; k = ti.next; }
        }
        let m2 = k;
        while (m2 < n && (s[m2] === ' ' || s[m2] === '\t' || s[m2] === '\n')) m2++;
        if (m2 < n && s[m2] === ')') {
          const built = buildLink(label, d.dest, title, isImage, m2 + 1, links, st, textMode);
          if (built) return built;
          // rejected (nested link): fall through to reflink
        }
      }
    }
    // the inline form failed; fall through to reflink / nolink
  }
  // reflink: [label][ref]
  if (s[after] === '[') {
    const refM = BLOCK_LABEL_RE.exec(s.slice(after + 1));
    if (refM && s[after + 1 + refM[0].length] === ']') {
      const ref = refM[0];
      const refNext = after + 1 + refM[0].length + 1;
      const link = links.get(normLabel(ref));
      if (!link) return { oneChar: true };
      const built = buildLink(label, link.href, link.title, isImage, refNext, links, st, textMode);
      if (built) return built;
      return null;
    }
  }
  // nolink: [label] or [label][]
  {
    const refM = BLOCK_LABEL_RE.exec(s.slice(open + 1));
    if (refM && s[open + 1 + refM[0].length] === ']') {
      const ref = refM[0];
      let refNext = open + 1 + refM[0].length + 1;
      if (s[refNext] === '[' && s[refNext + 1] === ']') refNext += 2;
      const link = links.get(normLabel(ref));
      if (!link) return { oneChar: true };
      const built = buildLink(label, link.href, link.title, isImage, refNext, links, st, textMode);
      if (built) return built;
      return null;
    }
  }
  return null;
}

// A reference label (for reflinks): not empty/whitespace-only, escapes,
// no unescaped brackets, a newline only when the next line is not blank.
const BLOCK_LABEL_RE = /^(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;

function renderInline(s, links, st, textMode) {
  // Fast path: nothing special (except possibly `&`, which esc/decodeEnt
  // handle on their own) and nothing that could start a GFM autolink
  // (www. / scheme:// / mailto: / xmpp: / an email's @).
  if (!/[\\`<\[!*_~<>\n]/.test(s) && !s.includes('www.') && !s.includes('://') && !s.includes('mailto:') && !s.includes('xmpp:') && !s.includes('@')) {
    // Numeric character references still decode (&#35; -> #); esc with
    // encode=false then leaves named references (like &amp;) alone.
    return textMode ? decodeEnt(s) : esc(decodeEnt(s), false);
  }
  const hasDelim = s.includes('*') || s.includes('_') || s.includes('~');
  // A GFM url/email can only start when one of these substrings is
  // present; without them the url branch is dead and plain text can be
  // skipped in bulk (see the jump at the bottom of the loop).
  const hasUrlMarker = s.includes('www.') || s.includes('://') || s.includes('mailto:') || s.includes('xmpp:') || s.includes('@');
  const masked = hasDelim ? maskSrc(s, links) : s;
  const hint = hasDelim ? lastCloserHint(masked) : null;
  const n = s.length;
  let out = '';
  let i = 0;
  let prevChar = '';
  let textStart = 0;
  // Flush the pending text run [textStart, to). Inside a raw block
  // (`<pre>`/`<code>`/`<kbd>`/`<script>`) text is neither decoded nor
  // escaped; elsewhere numeric references are decoded and the result
  // escaped (encode=false in HTML mode).
  const flushText = (to) => {
    if (to > textStart) {
      const run = s.slice(textStart, to);
      if (textMode) {
        out += st.inRawBlock ? run : decodeEnt(run);
      } else {
        out += st.inRawBlock ? run : esc(decodeEnt(run), false);
      }
      if (run[run.length - 1] !== '_') prevChar = run[run.length - 1];
    }
    textStart = to;
  };
  while (i < n) {
    const ch = s[i];
    // --- backslash escape / hard break ---
    if (ch === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        let m = i + 2;
        while (m < n && isSpaceCh(s[m])) m++;
        if (m < n) {
          flushText(i);
          if (!textMode) out += '<br>';
          let k = i + 2;
          while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
          i = k; textStart = i; prevChar = '';
          continue;
        }
        i++;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) {
        flushText(i);
        out += textMode ? nx : escChar(nx);
        i += 2; textStart = i; prevChar = '';
        continue;
      }
      i++;
      continue;
    }
    // --- code span ---
    if (ch === '`') {
      const cs = parseCodeSpan(s, i, textMode);
      if (cs) {
        flushText(i);
        out += cs.html;
        i = cs.next; textStart = i; prevChar = '';
        continue;
      }
      // No code span: the whole backtick run is literal text (marked's
      // inlineText starts a text token with the full run, so a shorter
      // run inside it never gets a second chance).
      let j = i;
      while (j < n && s[j] === '`') j++;
      i = j;
      continue;
    }
    // --- emphasis / strong ---
    if (ch === '*' || ch === '_') {
      const em = tryEmStrong(s, masked, hint, i, prevChar, links, st, textMode);
      if (em) {
        flushText(i);
        out += em.html;
        i = em.next; textStart = i; prevChar = '';
        continue;
      }
      i++;
      continue;
    }
    // --- strikethrough ---
    if (ch === '~') {
      const del = tryDel(s, masked, hint, i, prevChar, links, st, textMode);
      if (del) {
        flushText(i);
        out += del.html;
        i = del.next; textStart = i; prevChar = '';
        continue;
      }
      i++;
      continue;
    }
    // --- link / image ---
    // No inLink gate here: images must parse inside a link's label, and a
    // link inside a label is parsed too — it sets linkEmitted, which makes
    // buildLink reject the outer link (marked's nested-link rule).
    if (ch === '[' || (ch === '!' && s[i + 1] === '[')) {
      const res = tryLink(s, i, links, st, textMode);
      if (res && res.html !== undefined) {
        flushText(i);
        out += res.html;
        i = res.next; textStart = i; prevChar = '';
        continue;
      }
      i++;
      continue;
    }
    // --- html tag / autolink ---
    if (ch === '<') {
      const tagM = _INLINE_TAG_RE.exec(s.slice(i));
      if (tagM) {
        const raw = tagM[0];
        flushText(i);
        out += raw;
        if (!st.inLink && _START_A_TAG.test(raw)) st.inLink = true;
        else if (st.inLink && _END_A_TAG.test(raw)) st.inLink = false;
        if (!st.inRawBlock && _START_PRE_TAG.test(raw)) st.inRawBlock = true;
        else if (st.inRawBlock && _END_PRE_TAG.test(raw)) st.inRawBlock = false;
        i += raw.length; textStart = i; prevChar = '';
        continue;
      }
      const auto = parseAutolink(s, i);
      if (auto) {
        flushText(i);
        if (textMode) {
          out += auto.text;
        } else {
          const href = cleanUrl(auto.href);
          if (href === null) out += esc(auto.text, true);
          else out += '<a href="' + esc(href, true) + '">' + esc(auto.text, true) + '</a>';
        }
        i = auto.next; textStart = i; prevChar = '';
        continue;
      }
      i++;
      continue;
    }
    // --- newline: hard break (2+ spaces) or soft break ---
    if (ch === '\n') {
      let sp = 0;
      let k = i - 1;
      while (k >= textStart && s[k] === ' ') { sp++; k--; }
      if (sp >= 2) {
        let m = i + 1;
        while (m < n && isSpaceCh(s[m])) m++;
        if (m < n) {
          flushText(i - sp);
          if (!textMode) out += '<br>';
          let j2 = i + 1;
          while (j2 < n && (s[j2] === ' ' || s[j2] === '\t')) j2++;
          i = j2; textStart = i; prevChar = '';
          continue;
        }
      }
      i++;
      continue;
    }
    // --- GFM extended autolink ---
    if (hasUrlMarker && !st.inLink && (ch === 'w' || ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || ch === 'm' || ch === 'M' || _EMAIL_CHAR_RE.test(ch))) {
      const prev = i === 0 ? '' : s[i - 1];
      const maybeUrl = s.startsWith('www.', i) || isSchemeAt(s, i)
        || s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)
        || (prev === '' || !_EMAIL_CHAR_RE.test(prev));
      if (maybeUrl) {
        const urlRes = tryUrl(s, i);
        if (urlRes) {
          flushText(i);
          if (textMode) {
            out += urlRes.text;
          } else {
            const href = cleanUrl(urlRes.href);
            if (href === null) out += esc(urlRes.text, true);
            else out += '<a href="' + esc(href, true) + '">' + esc(urlRes.text, true) + '</a>';
          }
          i = urlRes.next; textStart = i; prevChar = '';
          continue;
        }
      }
      i++;
      continue;
    }
    // Plain character. With no url marker in the string, no url can start
    // here, so jump straight to the next character that can start a
    // token instead of walking the plain run one char at a time (the run
    // is flushed in bulk when that token is handled). With a url marker
    // present, step one char (a url may start at an ordinary letter).
    if (!hasUrlMarker) {
      let nx = n;
      for (const sp of _SPECIALS) {
        const p = s.indexOf(sp, i + 1);
        if (p !== -1 && p < nx) nx = p;
      }
      i = nx;
    } else {
      i++;
    }
  }
  flushText(n);
  return out;
}

// Characters that can start an inline token (backslash escape, code span,
// emphasis/strong, strikethrough, link/image, tag/autolink, newline).
const _SPECIALS = ['\\', '`', '*', '_', '~', '[', '!', '<', '\n'];

// ---------------------------------------------------------------------------
// Block layer. The document is walked line by line (lines carry no trailing
// newline; `cols[i]` is the absolute column at which lines[i] starts, which
// only matters for tab-stop expansion). Blocks are accumulated as objects:
// {k:'t', s: source text, h: rendered inline HTML} for text/paragraph blocks
// (rendered without <p> tags; the caller decides the wrapping) and
// {k:'b', h: full HTML} for everything else. In collect mode (pass 1) the
// inline HTML is left empty — only structure is walked, to gather link
// reference definitions before any rendering happens (a link may precede
// its definition). Pass 2 renders with the complete definition map.
// ---------------------------------------------------------------------------

// Inline rendering of one block's source text. The inline state object
// lives on ctx and PERSISTS across blocks: marked resets only inRawBlock
// before each block's inline run (Lexer.lex line 109); inLink is NOT
// reset, so an unclosed literal `<a ...>` tag suppresses GFM url
// autolinking for the rest of the document (docs 06/30/35).
function inlineHtml(s, ctx) {
  const st = ctx.inlineSt;
  st.inRawBlock = false;
  st.linkEmitted = false;
  const h = renderInline(s, ctx.refs, st, false);
  st.inRawBlock = false;
  return h;
}
function inlineHtmlOrEmpty(s, ctx) {
  return ctx.collect ? '' : inlineHtml(s, ctx);
}

// Is this line blank (only spaces/tabs, or empty)?
function isBlankLine(s) {
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// First non-whitespace character of `line`, with tabs expanded from the
// absolute column `col`. Returns {col, idx} or null when the line is blank.
// First non-whitespace character (index == column once leading tabs are
// expanded to spaces).
const nonSpaceChar = /\S/;

function firstNonWs(line, col) {
  let c = col;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (ch === ' ') c++;
    else if (ch === '\t') c += 4 - (c % 4);
    else return { col: c, idx: k };
  }
  return null;
}

// Number of leading whitespace columns of `line` (tabs expanded from `col`).
function leadCols(line, col) {
  const fw = firstNonWs(line, col);
  return fw === null ? line.length : fw.col - col;
}

// Remove `cols` columns of leading whitespace from `line`. A tab that
// straddles the cut leaves spaces for the columns that remain.
function stripCols(line, cols, col) {
  if (cols <= 0) return line;
  let c = col;
  let k = 0;
  while (k < line.length && c - col < cols) {
    const ch = line[k];
    if (ch === ' ') { c++; k++; }
    else if (ch === '\t') {
      const w = 4 - (c % 4);
      if (c - col + w <= cols) { c += w; k++; }
      else return ' '.repeat(c + w - (col + cols)) + line.slice(k + 1);
    } else break;
  }
  return line.slice(k);
}

// Is this line an indented-code line (indent >= 4 columns with content)?
function isIndentedCodeLine(line, col) {
  const fw = firstNonWs(line, col);
  return fw !== null && fw.col - col >= 4;
}

// Setext underline? Returns 1 for '=', 2 for '-', else 0. Indent <= 3.
function setextLevel(line, col) {
  const fw = firstNonWs(line, col);
  if (fw === null || fw.col - col > 3) return 0;
  const rest = line.slice(fw.idx);
  let k = 0;
  const ch = rest[0];
  if (ch !== '=' && ch !== '-') return 0;
  while (k < rest.length && rest[k] === ch) k++;
  while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) k++;
  return k === rest.length ? (ch === '=' ? 1 : 2) : 0;
}

// Thematic break? `***`, `---`, `___` (and spaced variants), indent <= 3.
function isHrLine(line, col) {
  const fw = firstNonWs(line, col);
  if (fw === null || fw.col - col > 3) return false;
  const rest = line.slice(fw.idx);
  const ch = rest[0];
  if (ch !== '*' && ch !== '-' && ch !== '_') return false;
  let count = 0;
  for (let k = 0; k < rest.length; k++) {
    const c = rest[k];
    if (c === ch) count++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return count >= 3;
}

// ATX heading. Returns {level, text} or null. The text has trailing hashes
// removed only when they are preceded by a space/tab (or the whole text is
// hashes, giving an empty heading).
function matchAtxLine(line, col) {
  const fw = firstNonWs(line, col);
  if (fw === null || fw.col - col > 3) return null;
  const rest = line.slice(fw.idx);
  if (rest[0] !== '#') return null;
  let hashes = 0;
  while (hashes < rest.length && rest[hashes] === '#') hashes++;
  if (hashes > 6) return null;
  if (hashes < rest.length && rest[hashes] !== ' ' && rest[hashes] !== '\t') return null;
  let text = rest.slice(hashes).trim();
  if (text.endsWith('#')) {
    const t = rtrim(text, '#');
    if (t === '' || /[ \t]$/.test(t)) text = t.trim();
  }
  return { level: hashes, text };
}

// Fenced code opening. Returns {ch, len, info, indent} or null.
function matchFenceLine(line, col) {
  const fw = firstNonWs(line, col);
  if (fw === null || fw.col - col > 3) return null;
  const rest = line.slice(fw.idx);
  const ch = rest[0];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (len < rest.length && rest[len] === ch) len++;
  if (len < 3) return null;
  // A backtick fence's info must contain no backtick (the fences regex
  // lookahead `(?=[^`\n]*(?:\n|$))`); ```` ```inner backticks``` ````
  // is paragraph text, not a fence. Tilde fences have no such rule.
  if (ch === '`' && rest.slice(len).indexOf('`') >= 0) return null;
  // indentChars is the raw count of leading whitespace characters on
  // the fence line (marked's indentCodeCompensation slices by character
  // count, not columns, so a tab counts as 1).
  return { ch, len, info: rest.slice(len), indent: fw.col - col, indentChars: fw.idx };
}

// Fenced code closing line for fence (ch, len). Only spaces/tabs may follow.
function isFenceCloseLine(line, col, ch, len) {
  const fw = firstNonWs(line, col);
  if (fw === null || fw.col - col > 3) return false;
  const rest = line.slice(fw.idx);
  if (rest[0] !== ch) return false;
  let n = 0;
  while (n < rest.length && rest[n] === ch) n++;
  if (n < len) return false;
  for (let k = n; k < rest.length; k++) {
    if (rest[k] !== ' ' && rest[k] !== '\t') return false;
  }
  return true;
}

// Does this line start a blockquote (`>` after <= 3 spaces)?
function isBlockquoteLine(line, col) {
  const fw = firstNonWs(line, col);
  return fw !== null && fw.col - col <= 3 && line[fw.idx] === '>';
}

// Strip one blockquote marker from a line. Returns [text, newCol] or null
// when the line has no marker. A tab after the marker expands to the next
// tab stop, of which the marker consumes one space.
function stripQuoteMarker(line, col) {
  const fw = firstNonWs(line, col);
  if (fw === null || fw.col - col > 3 || line[fw.idx] !== '>') return null;
  let s = line.slice(fw.idx + 1);
  const afterMarkerCol = fw.col + 1;
  // The whitespace after the marker expands to the next tab stops
  // (starting at the column after `>`); the marker then consumes one
  // space of it (marked's blockquoteMarkerWhitespace + SetextReplace2).
  let k = 0;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
  if (k > 0) {
    let expanded = '';
    let c = afterMarkerCol;
    for (let q = 0; q < k; q++) {
      const ch = s[q];
      if (ch === '\t') { const add = 4 - (c % 4); expanded += ' '.repeat(add); c += add; }
      else { expanded += ch; c++; }
    }
    s = expanded.slice(1) + s.slice(k);
  }
  return [s, afterMarkerCol];
}

// Block tags that can start an HTML block of type 6.
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// HTML block start at this line. Returns {type, tag?} or null.
// Type 1: script/pre/style/textarea (ends at the closing-tag line).
// Type 2: comment, 3: processing instruction, 4: declaration, 5: CDATA
// (all end at the line holding their end marker). Type 6: open/close block
// tag, type 7: a complete open/close tag alone on the line (both end at a
// blank line). Types 1-6 can interrupt a paragraph; type 7 cannot.
function matchHtmlStart(line, col) {
  const fw = firstNonWs(line, col);
  if (fw === null || fw.col - col > 3 || line[fw.idx] !== '<') return null;
  const rest = line.slice(fw.idx);
  const after = rest.slice(1);
  const m1 = /^(script|pre|style|textarea)(?:[ \t>]|$)/i.exec(after);
  if (m1) return { type: 1, tag: m1[1].toLowerCase() };
  if (rest.startsWith('<!--')) return { type: 2 };
  if (rest.startsWith('<?')) return { type: 3 };
  if (/^<![A-Za-z]/.test(rest)) return { type: 4 };
  if (rest.startsWith('<![CDATA[')) return { type: 5 };
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]+|\/?>|$)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { type: 6 };
  const m7 = /^<([A-Za-z][A-Za-z0-9-]*)(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>$/.exec(rest);
  if (m7) {
    const name = m7[1].toLowerCase();
    // script/pre/style/textarea are type 1 territory, never type 7.
    if ((name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')
      && !/[a-z0-9-]/i.test(rest[1 + m7[1].length] || '')) return null;
    return { type: 7 };
  }
  // A closing tag alone on the line (no attributes allowed on it).
  const m7c = /^<\/([A-Za-z][A-Za-z0-9-]*)[ \t]*>$/.exec(rest);
  if (m7c) {
    const name = m7c[1].toLowerCase();
    if (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea') return null;
    return { type: 7 };
  }
  return null;
}

// List marker at the start of a line. Returns null or
// {kind, delim, num, contentCol, content, empty, baseIndent, markerEnd,
// bulletIndent, rawAfter}.
// contentCol is the absolute column where item content starts (the
// "content indent"); content is the first line's text after the marker.
// markerEnd is the string index just past the marker; bulletIndent is the
// column just past the marker (base + marker length); rawAfter is the raw
// text after the marker (whitespace included). A marker needs whitespace
// (or end of line) after it.
function matchListMarker(line, col) {
  const fw = firstNonWs(line, col);
  if (fw === null || fw.col - col > 3) return null;
  const rest = line.slice(fw.idx);
  const base = fw.col; // absolute column of the marker
  let m = /^([*+-])(?:[ \t]+(.*)|[ \t]*)$/.exec(rest);
  if (m) return finishMarker(line, col, base, fw.idx, 1, 'bullet', m[1], 0, m[2]);
  m = /^(\d{1,9})([.)])(?:[ \t]+(.*)|[ \t]*)$/.exec(rest);
  if (m) return finishMarker(line, col, base, fw.idx, m[1].length + 1, 'ordered', m[2], parseInt(m[1], 10), m[3]);
  return null;
}
function finishMarker(line, col, base, markerIdx, markerLen, kind, delim, num, after) {
  void after;
  // Columns of whitespace after the marker (tabs expanded from `base`).
  let k = 0;
  let wsCols = 0;
  const markerEnd = markerIdx + markerLen;
  k = markerEnd;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    if (line[k] === ' ') { wsCols++; k++; }
    else { wsCols += 4 - ((base + markerLen + wsCols) % 4); k++; }
  }
  const bulletIndent = base + markerLen;
  const rawAfter = line.slice(markerEnd);
  const empty = k >= line.length;
  if (empty) return { kind, delim, num, contentCol: base + markerLen + 1, content: '', empty: true, baseIndent: base, markerEnd, bulletIndent, rawAfter };
  if (wsCols >= 1 && wsCols <= 4) {
    return { kind, delim, num, contentCol: base + markerLen + wsCols, content: line.slice(k), empty: false, baseIndent: base, markerEnd, bulletIndent, rawAfter };
  }
  // More than 4 spaces: the content starts one column past the marker and
  // keeps the extra spaces as its own text.
  return { kind, delim, num, contentCol: base + markerLen + 1, content: ' '.repeat(wsCols - 1) + line.slice(k), empty: false, baseIndent: base, markerEnd, bulletIndent, rawAfter };
}

// Parse a table delimiter row. Returns the align list (null/left/center/
// right per column) or null when the row is not a delimiter. The row must
// contain a pipe or a colon (a bare `---` is a setext underline, not a
// delimiter); each cell must be `:?-+:?`.
function parseDelimRow(delim) {
  if (delim.indexOf('|') < 0 && delim.indexOf(':') < 0) return null;
  let row = delim.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  const parts = row.split('|');
  const aligns = [];
  for (const part of parts) {
    const t = part.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    aligns.push(t[0] === ':' && t[t.length - 1] === ':' ? 'center'
      : t[t.length - 1] === ':' ? 'right'
      : t[0] === ':' ? 'left' : null);
  }
  return aligns.length ? aligns : null;
}

// ---------------------------------------------------------------------------
// Table, setext heading, indented code, paragraph interrupts.
// ---------------------------------------------------------------------------

// Table structure at lines[j] (header) + lines[j+1] (delimiter). Returns
// {aligns, headerCells, next} (next = index after the last row) or null.
// The row consumption mirrors marked: rows run while the line is non-blank
// and does not start a new block (hr/heading/blockquote/indented code/
// fence/list/html types 1-6).
function tableInfo(ctx, j, end) {
  const { lines, cols } = ctx;
  if (j + 1 >= end) return null;
  const headerCells = splitCells(lines[j]);
  const aligns = parseDelimRow(lines[j + 1]);
  if (!aligns || aligns.length !== headerCells.length) return null;
  let next = j + 2;
  while (next < end) {
    const line = lines[next];
    const col = cols[next];
    // Rows end at a line of only spaces (or empty); a tab-only line is
    // an empty row, not an end (marked's table regex blank check is
    // ` *\n`, spaces only).
    if (/^ *$/.test(line)) break;
    if (isHrLine(line, col) || matchAtxLine(line, col) || isBlockquoteLine(line, col)
      || isIndentedCodeLine(line, col) || matchFenceLine(line, col) || matchListMarker(line, col)) break;
    const hs = matchHtmlStart(line, col);
    if (hs && hs.type <= 6) break;
    next++;
  }
  return { aligns, headerCells, next };
}

// Render a table whose structure was found by tableInfo.
function renderTable(ctx, info, j) {
  const { lines } = ctx;
  const { aligns, headerCells } = info;
  const th = (cell, align) => '<th' + (align ? ' align="' + align + '"' : '') + '>'
    + inlineHtmlOrEmpty(cell, ctx) + '</th>\n';
  let h = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < headerCells.length; c++) h += th(headerCells[c], aligns[c]);
  h += '</tr>\n</thead>\n';
  if (info.next > j + 2) {
    h += '<tbody>';
    for (let r = j + 2; r < info.next; r++) {
      const cells = splitCells(lines[r], headerCells.length);
      h += '<tr>\n';
      for (let c = 0; c < cells.length; c++) {
        h += '<td' + (aligns[c] ? ' align="' + aligns[c] + '"' : '') + '>'
          + inlineHtmlOrEmpty(cells[c], ctx) + '</td>\n';
      }
      h += '</tr>\n';
    }
    h += '</tbody>';
  }
  return h + '</table>\n';
}

// The raw GFM table-delimiter pattern used inside a setext heading's text:
// a line of only `:`/`-`/spaces/pipes with at least one pipe. (A bare `---`
// is a setext underline, not a table line, and `:---` alone is not one
// either — it needs a pipe.)
function isTableDelimPattern(line, col) {
  const fw = firstNonWs(line, col);
  if (fw === null || fw.col - col > 3) return false;
  return /^\|?(?:[:\- ]*\|)+[:\- ]*$/.test(line.slice(fw.idx));
}

// A line that breaks a setext heading's text (lheading lookahead): a list
// marker followed by a space/tab, a fence start, a blockquote, an ATX
// heading, a thematic break, a complete tag alone on the line, or a
// table-delimiter-pattern line. Indented code and definitions do NOT break it.
function isLheadingBreak(line, col) {
  if (matchFenceLine(line, col) || isBlockquoteLine(line, col)
    || matchAtxLine(line, col) || isHrLine(line, col)
    || isTableDelimPattern(line, col)) return true;
  const fw = firstNonWs(line, col);
  if (fw === null || fw.col - col > 3) return false;
  const rest = line.slice(fw.idx);
  // list marker followed by a space or tab (a bare marker at end of line
  // does not break the heading text)
  if (rest[0] === '*' || rest[0] === '+' || rest[0] === '-') {
    if (rest[1] === ' ' || rest[1] === '\t') return true;
  } else if (rest[0] >= '0' && rest[0] <= '9') {
    const m = /^\d{1,9}[.)][ \t]/.exec(rest);
    if (m) return true;
  }
  // a complete tag alone on the line: `<...>` with no `>` inside and nothing
  // after the closing `>`
  if (rest[0] === '<' && /^<[^>\n]+>$/.test(rest)) return true;
  return false;
}

// Setext heading starting at line i: text lines i..k-1 plus a setext
// underline at k. Returns {level, text, next} or null. The text may not
// cross a blank line or a breaking line, and the first line may not itself
// be a table-delimiter-pattern line.
function tryLheading(ctx, i, end) {
  const { lines, cols } = ctx;
  if (isTableDelimPattern(lines[i], cols[i])) return null;
  for (let k = i + 1; k < end; k++) {
    const line = lines[k];
    if (isBlankLine(line)) return null;
    const lvl = setextLevel(line, cols[k]);
    if (lvl) return { level: lvl, text: lines.slice(i, k).join('\n').trim(), next: k + 1 };
    if (isLheadingBreak(line, cols[k])) return null;
  }
  return null;
}

// Collect an indented code block starting at line i. Returns {chunks, next}
// or null. chunks are the dedented lines; interior blank lines are kept
// (dedented by 4 columns), trailing blank lines are dropped. A blank line
// is only kept when a further code line follows it.
function collectIndentedCode(ctx, i, end) {
  const { lines, cols } = ctx;
  if (!isIndentedCodeLine(lines[i], cols[i])) return null;
  const chunks = [];
  let j = i;
  while (j < end) {
    const line = lines[j];
    if (isBlankLine(line)) {
      // keep the blank only if another code line follows
      let m = j + 1;
      while (m < end && isBlankLine(lines[m])) m++;
      if (m < end && isIndentedCodeLine(lines[m], cols[m])) {
        while (j < m) { chunks.push(stripCols(lines[j], 4, cols[j])); j++; }
        continue;
      }
      break;
    }
    if (!isIndentedCodeLine(line, cols[j])) break;
    chunks.push(stripCols(line, 4, cols[j]));
    j++;
  }
  return { chunks, next: j };
}

// The code token's text: dedented lines joined with '\n', plus one trailing
// newline when the block is followed by more lines (or the source ends with
// a newline) — the lexer regex consumes the newline after the last code
// line in that case. `next` is the index after the last consumed line.
function codeTokenText(chunks, next, end, endsWithNL) {
  const text = chunks.join('\n');
  return (next < end || endsWithNL) ? text + '\n' : text;
}

// Rendered code content (what goes inside <pre><code>): the token text
// with one trailing newline stripped, then one added (an empty code block
// renders with no newline at all).
function codeRenderText(tokenText) {
  if (tokenText === '') return '';
  return tokenText.endsWith('\n') ? tokenText : tokenText + '\n';
}

// Does the line at j start a new block that interrupts a paragraph? `anyNum`
// is true inside a list item (any-number ordered lists interrupt there);
// at the top level and inside blockquotes only ordered lists starting
// with 1 interrupt. Table starts interrupt; setext underlines and
// definitions do not.
function isParagraphInterrupt(ctx, j, end, anyNum) {
  const { lines, cols } = ctx;
  const line = lines[j];
  const col = cols[j];
  if (isHrLine(line, col) || matchAtxLine(line, col) || isBlockquoteLine(line, col)
    || matchFenceLine(line, col)) return true;
  const hs = matchHtmlStart(line, col);
  if (hs && hs.type <= 6) return true;
  const mk = matchListMarker(line, col);
  // A list interrupts a paragraph only when it is non-empty: the marker
  // must be followed by whitespace and content. A bare marker (`*` alone)
  // is paragraph text.
  if (mk && !mk.empty) {
    if (mk.kind === 'bullet') return true;
    if (anyNum || mk.num === 1) return true;
  }
  if (tableInfo(ctx, j, end)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The block walker.
// ---------------------------------------------------------------------------

// Walk blocks over lines[start..end) into `out`. `top` is true at the top
// level and inside blockquotes (paragraphs render as <p>), false inside
// list items (text blocks render bare). `bq` is true inside a blockquote
// (any-number ordered lists interrupt paragraphs there). Returns
// {next, blankBetween}: blankBetween is true when a blank line separated
// two emitted blocks (used for list looseness).
function walkBlocks(ctx, start, end, out, top, bq) {
  const { lines, cols } = ctx;
  let i = start;
  let blankBetween = false;
  let seenBlock = false;
  let pendingBlank = false;
  while (i < end) {
    const line = lines[i];
    const col = cols[i];
    if (isBlankLine(line)) { i++; pendingBlank = true; continue; }
    if (pendingBlank && seenBlock) blankBetween = true;
    pendingBlank = false;

    // indented code
    const code = collectIndentedCode(ctx, i, end);
    if (code) {
      const tokenText = codeTokenText(code.chunks, code.next, end, ctx.endsWithNL);
      out.push({ k: 'b', bk: 'code', s: i, ct: tokenText, h: ctx.collect ? '' : '<pre><code>' + esc(codeRenderText(tokenText), true) + '</code></pre>\n' });
      seenBlock = true;
      i = code.next;
      continue;
    }

    // fenced code
    const fence = matchFenceLine(line, col);
    if (fence && !(fence.ch === '`' && fence.info.includes('`'))) {
      let j = i + 1;
      const contentLines = [];
      while (j < end && !isFenceCloseLine(lines[j], cols[j], fence.ch, fence.len)) {
        contentLines.push([lines[j], cols[j]]);
        j++;
      }
      const closed = j < end;
      if (closed) j++;
      let content = contentLines;
      if (fence.ch === '`' && fence.indentChars > 0) {
        // marked's indentCodeCompensation: remove up to the fence's own
        // indentation (raw character count, a tab counts as 1) from each
        // content line. A tab-indented line loses the whole tab.
        content = contentLines.map(([l]) => {
          let n = 0;
          while (n < l.length && (l[n] === ' ' || l[n] === '\t')) n++;
          return l.slice(Math.min(n, fence.indentChars));
        });
      } else {
        content = contentLines.map(([l]) => l);
      }
      const joined = content.join('\n');
      const lang = unescapePunct(fence.info.trim()).split(/\s+/)[0] || '';
      out.push({
        k: 'b', bk: 'code', s: i,
        h: ctx.collect ? '' : '<pre><code' + (lang ? ' class="language-' + esc(lang, false) + '"' : '') + '>'
          + esc(codeRenderText(joined), true) + '</code></pre>\n',
      });
      seenBlock = true;
      i = j;
      continue;
    }

    // ATX heading
    const atx = matchAtxLine(line, col);
    if (atx) {
      out.push({ k: 'b', bk: 'heading', s: i, h: ctx.collect ? '' : '<h' + atx.level + '>' + inlineHtmlOrEmpty(atx.text, ctx) + '</h' + atx.level + '>\n' });
      seenBlock = true;
      i++;
      continue;
    }

    // thematic break
    if (isHrLine(line, col)) {
      out.push({ k: 'b', bk: 'hr', s: i, h: '<hr>\n' });
      seenBlock = true;
      i++;
      continue;
    }

    // blockquote
    if (isBlockquoteLine(line, col)) {
      i = walkBlockquote(ctx, i, end, out, top);
      seenBlock = true;
      continue;
    }

    // list
    if (matchListMarker(line, col)) {
      i = walkList(ctx, i, end, out, top);
      seenBlock = true;
      continue;
    }

    // html block
    const hs = matchHtmlStart(line, col);
    if (hs) {
      const hb = walkHtmlBlock(ctx, i, end, hs);
      out.push({ k: 'b', bk: 'html', s: i, h: hb.html });
      seenBlock = true;
      i = hb.next;
      continue;
    }

    // link reference definition
    const def = matchDef(lines, i);
    if (def) {
      if (ctx.collect && !ctx.refs.has(def.tag)) {
        ctx.refs.set(def.tag, { href: def.href, title: def.title });
      }
      seenBlock = true;
      i = def.endLine;
      continue;
    }

    // table
    const ti = tableInfo(ctx, i, end);
    if (ti) {
      out.push({ k: 'b', bk: 'table', s: i, h: ctx.collect ? '' : renderTable(ctx, ti, i) });
      seenBlock = true;
      i = ti.next;
      continue;
    }

    // setext heading (applies at the top level, in blockquotes, and in
    // list items alike)
    const lh = tryLheading(ctx, i, end);
    if (lh) {
      out.push({ k: 'b', bk: 'heading', s: i, h: ctx.collect ? '' : '<h' + lh.level + '>' + inlineHtmlOrEmpty(lh.text, ctx) + '</h' + lh.level + '>\n' });
      seenBlock = true;
      i = lh.next;
      continue;
    }

    // paragraph (tries a setext heading first) or, inside list items, a
    // single-line text block with merges
    i = walkParagraph(ctx, i, end, out, top, bq);
    seenBlock = true;
  }
  return { next: i, blankBetween };
}

// Walk an HTML block starting at line i (matchHtmlStart already matched).
// Returns {html, next}.
function walkHtmlBlock(ctx, i, end, hs) {
  const { lines } = ctx;
  let j = i;
  if (hs.type === 1) {
    // ends at the line holding the closing tag (which may be the start
    // line itself), or at the end of input
    const closeRe = new RegExp('</' + hs.tag + '>', 'i');
    j = i;
    while (j < end && !closeRe.test(lines[j])) j++;
    if (j < end) j++;
  } else if (hs.type === 2) {
    while (j < end && lines[j].indexOf('-->') < 0) j++;
    if (j < end) j++;
  } else if (hs.type === 3) {
    while (j < end && lines[j].indexOf('?>') < 0) j++;
    if (j < end) j++;
  } else if (hs.type === 4) {
    while (j < end && lines[j].indexOf('>') < 0) j++;
    if (j < end) j++;
  } else if (hs.type === 5) {
    while (j < end && lines[j].indexOf(']]>') < 0) j++;
    if (j < end) j++;
  } else {
    // types 6 and 7 end at a blank line
    j++;
    while (j < end && !isBlankLine(lines[j])) j++;
  }
  const html = lines.slice(i, j).join('\n');
  // Trailing newline (marked's trimTrailingBlankLines on the html regex
  // match). Types 6/7 end at blank lines, and the regex swallows those
  // lines into the match, so trimTrailingBlankLines always drops the
  // trailing newline there — it is kept only at end of input when the
  // source ends with one. Types 1–5 end at a closing marker, so the
  // newline is kept unless the line after the block is empty (a
  // whitespace-only line still keeps it); at end of input, kept only
  // when the source ends with one.
  const trail = hs.type >= 6
    ? (j === end && ctx.endsWithNL ? '\n' : '')
    : ((j < end && lines[j] !== '') || (j === end && ctx.endsWithNL) ? '\n' : '');
  return { html: html + trail, next: j };
}

// A line ends a paragraph when it is empty (the paragraph rule needs
// `[^\n]+` to continue) or whitespace-only and followed by a newline. A
// trailing whitespace-only line at the very end (no trailing newline) is
// paragraph content (marked's rule only sees a blank line as `[ \t]*\n`).
function isParaBreak(ctx, j, end) {
  const line = ctx.lines[j];
  if (line === '') return true;
  return isBlankLine(line) && (j + 1 < end || ctx.endsWithNL);
}

// Walk a paragraph (top=true) or a text block (top=false) starting at line
// i. The setext heading check already ran in walkBlocks. Returns the index
// after the block.
function walkParagraph(ctx, i, end, out, top, bq) {
  const { lines, cols } = ctx;
  if (top) {
    let j = i + 1;
    while (j < end) {
      if (isParaBreak(ctx, j, end)) break;
      if (isParagraphInterrupt(ctx, j, end, false)) break;
      j++;
    }
    const text = lines.slice(i, j).join('\n');
    out.push({ k: 't', t: text, s: i, h: inlineHtmlOrEmpty(text, ctx) });
    return j;
  }
  // Inside a list item: a single-line text block. Following lines merge in
  // when they are indented code (dedented), a swallowed definition, a
  // setext-shaped line, or plain continuation text; any other block start
  // ends the text block.
  let text = lines[i];
  let j = i + 1;
  while (j < end) {
    const line = lines[j];
    if (isParaBreak(ctx, j, end)) break;
    const code = collectIndentedCode(ctx, j, end);
    if (code) {
      text += '\n' + codeTokenText(code.chunks, code.next, end, ctx.endsWithNL);
      j = code.next;
      continue;
    }
    const def = matchDef(lines, j);
    if (def) {
      text += '\n' + lines.slice(j, def.endLine).join('\n');
      j = def.endLine;
      continue;
    }
    if (setextLevel(line, cols[j])) {
      text += '\n' + line;
      j++;
      continue;
    }
    if (isParagraphInterrupt(ctx, j, end, true)) break;
    text += '\n' + line;
    j++;
  }
  out.push({ k: 't', t: text, s: i, h: inlineHtmlOrEmpty(text, ctx) });
  return j;
}

// ---------------------------------------------------------------------------
// Blockquote and list walkers.
// ---------------------------------------------------------------------------

// Block kind of a block object, for the blockquote stop/extend decisions:
// 't' (paragraph/text), 'code', 'heading', 'hr', 'bq', 'list', 'html',
// 'table'.
function blockKind(b) {
  return b.k === 't' ? 't' : b.bk;
}

// A lazy line (no `>` marker) only continues a blockquote when it does not
// interrupt a paragraph there (any-number ordered lists interrupt inside a
// blockquote).
function isBqLazyLine(ctx, j, end) {
  // A lazy line cannot be a list marker at all (marked's
  // blockquoteParagraph interrupt allows any bullet/number, even an
  // empty marker), nor any other paragraph interrupt.
  if (matchListMarker(ctx.lines[j], ctx.cols[j])) return false;
  return !isParagraphInterrupt(ctx, j, end, true);
}

// Walk a blockquote starting at line i. Returns the index after it. The
// blockquote's HTML is pushed as one 'b' block (bk 'bq'). Runs of marked
// lines (plus lazy lines at a run's start) are walked separately so that a
// lazy indented-code line merges into the preceding paragraph (as marked's
// per-run blockTokens does); paragraphs merge across runs. When a run ends
// in a nested blockquote/list, the next run's lines are offered to that
// nested block by re-walking from its start.
function walkBlockquote(ctx, i, end, out, top) {
  const { lines, cols } = ctx;
  const innerLines = [];
  const innerCols = [];
  const innerOuter = [];
  let j = i;
  let blocks = [];
  let firstRun = true;
  while (j < end) {
    const runStartIdx = innerLines.length;
    const runLines = [];
    let seenMarked = false;
    let k = j;
    while (k < end) {
      const line = lines[k];
      if (isBlankLine(line)) break;
      const stripped = stripQuoteMarker(line, cols[k]);
      if (stripped) {
        seenMarked = true;
        runLines.push({ text: stripped[0], col: 0, outer: k, lazy: false });
        k++;
      } else if (!seenMarked) {
        // A lazy line cannot follow a blank inner line (an empty `>` line
        // ends the paragraph), nor a fence/heading/html/hr/indented-code
        // line.
        const prevInner = runLines.length ? runLines[runLines.length - 1].text
          : (innerLines.length ? innerLines[innerLines.length - 1] : null);
        if (prevInner !== null && isBlankLine(prevInner)) break;
        if (prevInner !== null && (
          matchFenceLine(prevInner, 0) !== null
          || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(prevInner)
          || matchHtmlStart(prevInner, 0) !== null
          || isHrLine(prevInner, 0)
          || prevInner.search(nonSpaceChar) >= 4)) break;
        if (!firstRun && !isBqLazyLine(ctx, k, end)) break;
        runLines.push({ text: line, col: 0, outer: k, lazy: true });
        k++;
      } else {
        break;
      }
    }
    if (runLines.length === 0) break;
    // A lazy setext underline at run index >= 1 is neutralised with a
    // 4-space prefix so it stays paragraph text.
    for (let m = 1; m < runLines.length; m++) {
      const rl = runLines[m];
      if (rl.lazy && /^ {0,3}(?:=+|-+)[ \t]*$/.test(rl.text)) {
        rl.text = '    ' + rl.text.replace(/^ {0,3}/, '');
      }
    }
    // Leading definitions of this run are swallowed into a preceding
    // paragraph (and not registered), as marked's def merge does.
    let runStart = 0;
    const prevBlock = blocks.length ? blocks[blocks.length - 1] : null;
    if (prevBlock && prevBlock.k === 't') {
      while (runStart < runLines.length) {
        const defLines = runLines.slice(runStart).map((rl) => rl.text);
        const def = matchDef(defLines, 0);
        if (!def) break;
        prevBlock.t = prevBlock.t + '\n' + defLines.slice(0, def.endLine).join('\n');
        prevBlock.h = inlineHtmlOrEmpty(prevBlock.t, ctx);
        runStart += def.endLine;
      }
    }
    const runInner = runLines.slice(runStart);
    if (runInner.length === 0) { j = k; firstRun = false; continue; }
    for (const rl of runInner) {
      innerLines.push(rl.text);
      innerCols.push(rl.col);
      innerOuter.push(rl.outer);
    }
    // Walk this run's lines on their own.
    const subCtx = {
      lines: runInner.map((rl) => rl.text),
      cols: runInner.map((rl) => rl.col),
      refs: ctx.refs, collect: ctx.collect, endsWithNL: false, inlineSt: ctx.inlineSt,
    };
    const runBlocks = [];
    walkBlocks(subCtx, 0, runInner.length, runBlocks, true, true);
    // Merge the run's blocks into the accumulated ones. Only the FIRST
    // block of a run can merge with the previous run's last block (a
    // paragraph or indented code continuing across runs); blocks later in
    // the same run are already separated by a blank line or another block.
    for (let ri = 0; ri < runBlocks.length; ri++) {
      const rb = runBlocks[ri];
      rb.s = runStartIdx + rb.s;
      const last = blocks.length ? blocks[blocks.length - 1] : null;
      if (ri === 0 && rb.ct !== undefined && last && last.k === 't') {
        // an indented code block at the start of a run merges into the
        // preceding paragraph, dedented (fenced code never merges)
        last.t = last.t + '\n' + rb.ct;
        last.h = inlineHtmlOrEmpty(last.t, ctx);
        continue;
      }
      if (ri === 0 && rb.k === 't' && last && last.k === 't') {
        last.t = last.t + '\n' + rb.t;
        last.h = inlineHtmlOrEmpty(last.t, ctx);
        continue;
      }
      blocks.push(rb);
    }
    j = k;
    firstRun = false;
    const last = blocks.length ? blocks[blocks.length - 1] : null;
    const lk = last ? blockKind(last) : null;
    if (lk === 'code' || lk === 'heading' || lk === 'hr' || lk === 'html' || lk === 'table') break;
    if (lk === 'bq' || lk === 'list') {
      // The nested block may absorb the next run's lines: re-walk from its
      // start once those lines are collected. Collect the next run now
      // (its lines are appended to innerLines) and re-walk.
      const nestedIdx = blocks.length - 1;
      const nestedStart = blocks[nestedIdx].s;
      // Peek the next run's lines without consuming them yet.
      const nextRun = [];
      let seenM2 = false;
      let k2 = j;
      while (k2 < end) {
        const line = lines[k2];
        if (isBlankLine(line)) break;
        const stripped = stripQuoteMarker(line, cols[k2]);
        if (stripped) {
          seenM2 = true;
          nextRun.push({ text: stripped[0], col: 0, outer: k2, lazy: false });
          k2++;
        } else if (!seenM2) {
          if (!isBqLazyLine(ctx, k2, end)) break;
          nextRun.push({ text: line, col: 0, outer: k2, lazy: true });
          k2++;
        } else {
          break;
        }
      }
      if (nextRun.length === 0) break;
      for (let m = 1; m < nextRun.length; m++) {
        const rl = nextRun[m];
        if (rl.lazy && /^ {0,3}(?:=+|-+)[ \t]*$/.test(rl.text)) {
          rl.text = '    ' + rl.text.replace(/^ {0,3}/, '');
        }
      }
      const baseLen = innerLines.length;
      for (const rl of nextRun) {
        innerLines.push(rl.text);
        innerCols.push(rl.col);
        innerOuter.push(rl.outer);
      }
      // Re-walk from the nested block's start over the extended lines.
      const rwCtx = { lines: innerLines, cols: innerCols, refs: ctx.refs, collect: ctx.collect, endsWithNL: false, inlineSt: ctx.inlineSt };
      const rwBlocks = [];
      walkBlocks(rwCtx, nestedStart, innerLines.length, rwBlocks, true, true);
      for (const rb of rwBlocks) rb.s = nestedStart + rb.s;
      blocks = blocks.slice(0, nestedIdx).concat(rwBlocks);
      // The re-walk may have merged the nested block with following lines;
      // the outer index advances past the collected run.
      void baseLen;
      j = k2;
      firstRun = false;
      const last2 = blocks.length ? blocks[blocks.length - 1] : null;
      const lk2 = last2 ? blockKind(last2) : null;
      if (lk2 === 'code' || lk2 === 'heading' || lk2 === 'hr' || lk2 === 'html' || lk2 === 'table') break;
    }
  }
  // Inside a blockquote the inner walk runs with top=true, so 't' blocks
  // are paragraphs and render as <p>...</p>; other blocks carry full HTML.
  const inner = blocks.map((b) => (b.k === 't' ? '<p>' + b.h + '</p>\n' : b.h)).join('');
  out.push({ k: 'b', bk: 'bq', s: i, h: ctx.collect ? '' : '<blockquote>\n' + inner + '</blockquote>\n' });
  return j;
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

// Whether a line can lazily continue a list item. `prevLine` is the text of
// the previously collected line (dedented, for indented lines; the raw
// remainder after the marker for the first line). `line` is the raw next
// line, `col` its first-non-ws column, `ci` the item's content indent.
// Interrupt checks use the indent cap ci-1: a construct only interrupts
// when its first non-ws column is < ci.
function lazyOkForList(prevLine, line, col, ci, ctx, k, end) {
  // the previous line must not be an indented code line / fence / heading /
  // html block start / hr
  if (prevLine.search(nonSpaceChar) >= 4) return false;
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(prevLine)) return false;
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(prevLine)) return false;
  if (matchHtmlStart(prevLine, 0) !== null) return false;
  if (isHrLine(prevLine, 0)) return false;
  // the line itself must not start a block construct (with the indent cap)
  // — marked clamps the cap to 0..3 (cachedIndentRegex: min(3, indent-1)),
  // so a marker at column 4 does not interrupt an item whose content
  // starts at column 5.
  const cap = Math.max(0, Math.min(3, ci - 1));
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line) && col <= cap) return false;
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line) && col <= cap) return false;
  if (isHrLine(line, 0) && col <= cap) return false;
  if (/^ {0,3}>/.test(line) && col <= cap) return false;
  if (matchListMarker(line, 0) !== null && col <= cap) return false;
  if (matchHtmlStart(line, 0) !== null && col <= cap) return false;
  // a table start (this line as header, the next as delimiter)
  if (k + 1 < end && tableInfo(ctx, k, end) !== null) return false;
  return true;
}

// Collect one list item's lines. Returns
// {lines, cols, next, blankAfter} where lines/cols are the dedented item
// text (each line's first-non-ws column is in cols), next is the index of
// the first line after the item, blankAfter is whether the item ended with
// pending blank lines.
function collectListItem(ctx, j, end, mk) {
  const { lines, cols } = ctx;
  const ci = mk.contentCol;
  const itemLines = [mk.content];
  const itemCols = [0];
  const blankFirst = mk.empty;
  let k = j + 1;
  // endEarly: first line blank and the next line blank -> the item is
  // empty and the second blank line is consumed.
  if (blankFirst && k < end && isBlankLine(lines[k])) {
    // The blank line is consumed by the (empty) item; it still separates
    // this item from the next, so the list is loose when another follows.
    // blankAt is the consumed blank line, so the caller can see it.
    return { lines: itemLines, cols: itemCols, next: k + 1, blankAfter: true, blankAt: k };
  }
  // `prevLine` for the lazy checks: the first line's raw remainder after
  // the marker, with leading tabs expanded from the marker column.
  let prevLine = expandTabsLeading(mk.rawAfter, mk.bulletIndent);
  let pendingBlanks = 0;
  while (k < end) {
    const rawLine = lines[k];
    const nc = cols[k];
    if (isBlankLine(rawLine)) {
      pendingBlanks++;
      k++;
      continue;
    }
    const expanded = expandTabsLeading(rawLine, 0);
    const ind = expanded.search(nonSpaceChar);
    if (ind >= ci) {
      // indented enough: dedent by ci columns and append (after any
      // pending blank lines)
      for (let b = 0; b < pendingBlanks; b++) { itemLines.push(''); itemCols.push(0); }
      pendingBlanks = 0;
      const ded = expanded.slice(ci);
      itemLines.push(ded);
      itemCols.push(0);
      prevLine = ded;
      k++;
      continue;
    }
    // ind < ci: a lazy continuation is only possible with no pending
    // blank lines and a lazy-ok line. The line joins the item text with
    // its leading whitespace intact (marked appends the raw line); a
    // 4-space-indented lazy line becomes indented code in the re-lex and
    // merges back into the paragraph, dedented.
    if (pendingBlanks === 0 && lazyOkForList(prevLine, rawLine, nc, ci, ctx, k, end)) {
      itemLines.push(rawLine);
      itemCols.push(0);
      prevLine = expandTabsLeading(rawLine, 0).slice(ci);
      k++;
      continue;
    }
    break;
  }
  return { lines: itemLines, cols: itemCols, next: k, blankAfter: pendingBlanks > 0, blankAt: pendingBlanks > 0 ? k - pendingBlanks : -1 };
}

// Walk a list starting at line i. Returns the index of the first line after
// the list. Pushes one 'b' block (bk 'list') into out.
function walkList(ctx, i, end, out, top) {
  void top;
  const { lines, cols } = ctx;
  const first = matchListMarker(lines[i], cols[i]);
  const isOrdered = first.kind === 'ordered';
  const delim = first.delim;
  const startNum = first.num;
  const items = [];
  let loose = false;
  let j = i;
  let prevBlankAfter = false;
  let lastBlankAt = -1;
  while (j < end) {
    const mk = matchListMarker(lines[j], cols[j]);
    if (!mk) break;
    if (isOrdered) {
      if (mk.kind !== 'ordered' || mk.delim !== delim) break;
    } else {
      if (mk.kind !== 'bullet' || mk.delim !== delim) break;
    }
    // a marker line that is actually an hr ends the list
    if (isHrLine(lines[j], cols[j])) break;
    const item = collectListItem(ctx, j, end, mk);
    if (prevBlankAfter) loose = true;
    items.push(item);
    prevBlankAfter = item.blankAfter;
    lastBlankAt = item.blankAt;
    j = item.next;
  }
  // Walk every item first (looseness is a property of the whole list and
  // changes how every item's paragraphs render).
  const walked = [];
  for (const item of items) {
    const itemText = item.lines.join('\n');
    let itemLines = item.lines;
    let itemCols = item.cols;
    const taskMatch = /^\[([ xX])\][ \t]+\S/.exec(itemText);
    if (taskMatch) {
      const checked = taskMatch[1] !== ' ';
      const cb = checked
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ';
      itemLines = item.lines.slice();
      itemCols = item.cols.slice();
      itemLines[0] = itemLines[0].replace(/^\[[ xX]\][ \t]+/, cb);
      itemCols[0] = 0;
    }
    const sub = { lines: itemLines, cols: itemCols, refs: ctx.refs, collect: ctx.collect, endsWithNL: false, inlineSt: ctx.inlineSt };
    const blocks = [];
    const res = walkBlocks(sub, 0, itemLines.length, blocks, false, false);
    if (res.blankBetween) loose = true;
    walked.push(blocks);
  }
  let html = '';
  if (!ctx.collect) {
    html = isOrdered
      ? (startNum !== 1 ? '<ol start="' + startNum + '">\n' : '<ol>\n')
      : '<ul>\n';
    for (const blocks of walked) {
      let itemHtml = '';
      for (const b of blocks) {
        if (b.k === 't') {
          itemHtml += loose ? '<p>' + b.h + '</p>\n' : b.h;
        } else {
          itemHtml += b.h;
        }
      }
      html += '<li>' + itemHtml + '</li>\n';
    }
    html += isOrdered ? '</ol>\n' : '</ul>\n';
  }
  out.push({ k: 'b', bk: 'list', s: i, h: html });
  // Return the first trailing blank line of the last item, so the caller
  // sees it (a blank line after a list separates it from the next block —
  // e.g. a nested list followed by a blank line and a paragraph makes the
  // enclosing item loose). Blank lines between items were already handled
  // by prevBlankAfter.
  return lastBlankAt >= 0 ? lastBlankAt : j;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Start column of each top-level line (a document line always starts at
// column 0; inner walks pass their own start columns).
function computeCols(lines) {
  return new Array(lines.length).fill(0);
}

// Render `markdown` to HTML, byte-for-byte identical to marked 18.1.3 with
// default options (GFM on). Two passes over the same walker: pass 1 collects
// link reference definitions (a link may precede its definition), pass 2
// renders. The link map is shared, so definitions found anywhere — including
// inside blockquotes and lists — resolve everywhere.
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  let endsWithNL = false;
  if (src.endsWith('\n')) { endsWithNL = true; lines.pop(); }
  const cols = computeCols(lines);
  const refs = new Map();
  const ctx1 = { lines, cols, refs, collect: true, endsWithNL, inlineSt: { inLink: false, inRawBlock: false, linkEmitted: false } };
  walkBlocks(ctx1, 0, lines.length, [], true, false);
  const ctx2 = { lines, cols, refs, collect: false, endsWithNL, inlineSt: { inLink: false, inRawBlock: false, linkEmitted: false } };
  const blocks = [];
  walkBlocks(ctx2, 0, lines.length, blocks, true, false);
  let html = '';
  for (const b of blocks) {
    if (b.k === 't') html += '<p>' + b.h + '</p>\n';
    else html += b.h;
  }
  return html;
}

export default parse;
