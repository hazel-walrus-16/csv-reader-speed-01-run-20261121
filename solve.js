// A faster drop-in for csv-reader 1.0.0 (make.fun's own reference program).
//
// Same answers, same errors, same order, on every input: the reference
// reads one character at a time and builds each field a character at a
// time; this one jumps between the characters that can end a field with
// the regex engine (C++ scan) and slices whole fields out of the text,
// so a field costs a few scans instead of a loop per character. Quoted
// fields are handled the same way: jump to the next quote, take the whole
// segment between quotes, and only walk a segment when it holds a line
// break (then CRLF and lone CR inside quotes each become one LF, exactly
// as the reference counts them).
//
// Pure: no clock, no randomness, no locale, nothing kept from one call
// to the next. Dependency-free ES module: run(input) answers
// {columns, rows, errors} for {text, header}, exactly as csv-reader does.

const RE_DELIM = /[,\n\r]/g; // what can end an unquoted field
const RE_QUOTE = /"/g; // what can end a quoted field
const RE_BREAKS = /\r\n|\r|\n/g; // line breaks inside a quoted field
const RE_CR = /\r\n?/g; // a CR or CRLF inside a quoted field becomes one LF

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1; // a U+FEFF at the very start is dropped

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed by LF is dropped
  // (stray_cr). Returns the field and how it ended; `added` counts the characters kept.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      RE_DELIM.lastIndex = pos;
      const m = RE_DELIM.exec(text);
      if (m === null) {
        added += n - pos;
        value += text.slice(pos, n);
        pos = n;
        return { value, ended: "end", added };
      }
      const idx = m.index;
      const c = m[0];
      if (c === ",") {
        added += idx - pos;
        value += text.slice(pos, idx);
        pos = idx + 1;
        return { value, ended: "comma", added };
      }
      if (c === "\n") {
        added += idx - pos;
        value += text.slice(pos, idx);
        pos = idx + 1;
        line += 1;
        return { value, ended: "line break", added };
      }
      // c === "\r"
      if (text[idx + 1] === "\n") {
        added += idx - pos;
        value += text.slice(pos, idx);
        pos = idx + 2;
        line += 1;
        return { value, ended: "line break", added };
      }
      error("stray_cr");
      added += idx - pos;
      value += text.slice(pos, idx);
      pos = idx + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = "";
    pos += 1;
    let closed = false;
    for (;;) {
      RE_QUOTE.lastIndex = pos;
      const m = RE_QUOTE.exec(text);
      if (m === null) break;
      const idx = m.index;
      const seg = text.slice(pos, idx);
      if (text[idx + 1] === '"') {
        // A doubled quote is one quote in the value; the segment before it stays.
        value += quotedSegment(seg) + '"';
        pos = idx + 2;
        continue;
      }
      value += quotedSegment(seg);
      pos = idx + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error("unterminated_quote");
      return readUnquoted('"');
    }
    if (pos >= n) return { value, ended: "end" };
    const c = text[pos];
    if (c === ",") {
      pos += 1;
      return { value, ended: "comma" };
    }
    if (c === "\n") {
      pos += 1;
      line += 1;
      return { value, ended: "line break" };
    }
    if (c === "\r" && text[pos + 1] === "\n") {
      pos += 2;
      line += 1;
      return { value, ended: "line break" };
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error("quote_junk");
    return junk;
  }

  // A segment from inside a quoted field: each CRLF or lone CR in it is one LF, and each such break is one line.
  function quotedSegment(seg) {
    if (seg.indexOf("\r") === -1 && seg.indexOf("\n") === -1) return seg;
    const breaks = seg.match(RE_BREAKS);
    line += breaks === null ? 0 : breaks.length;
    return seg.replace(RE_CR, "\n");
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text[pos] === "\n") {
        pos += 1;
        line += 1;
      } else if (text[pos] === "\r" && text[pos + 1] === "\n") {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text[pos] === '"';
      field = quoted ? readQuoted() : readUnquoted("");
      fields.push(field.value);
    } while (field.ended === "comma");

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === "" && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: "short_row", line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push("");
    } else if (fields.length > width) {
      errors.push({ code: "long_row", line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
