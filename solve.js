// A faster drop-in for csv-reader 1.0.0 (make.fun's own reference program).
//
// Same answers, same errors, same order, on every input. Where v1 jumped
// between field ends with the regex engine, this one makes a single pass
// over the text by char code: a tight scan loop walks each field's plain
// stretch (V8 runs it at near memory speed), whole fields are sliced out
// of the text, and no per-field result objects are built — the field
// readers hand their results back through shared locals. Quoted fields
// scan for the next quote the same way; only a segment that actually
// holds a line break pays for break handling (each CRLF or lone CR in it
// becomes one LF, exactly as the reference counts them).
//
// Pure: no clock, no randomness, no locale, nothing kept from one call
// to the next. Dependency-free ES module: run(input) answers
// {columns, rows, errors} for {text, header}, exactly as csv-reader does.

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

  // The field being read: its value, how it ended (0 end, 1 comma, 2 line break), and how many
  // characters the last unquoted scan kept (the quote_junk test reads it).
  let fValue = '';
  let fEnded = 0;
  let uAdded = 0;

  // Reads unquoted characters from pos onto `acc` (already-read text the field starts with: '' for a
  // plain field, the quoted value for quote junk, '"' for an unterminated quote re-read) up to the
  // next comma or line break: a CR not followed by LF is dropped (stray_cr). Sets fValue/fEnded/uAdded.
  function scanUnquoted(acc) {
    let start = pos;
    uAdded = 0;
    for (;;) {
      let i = pos;
      let c = -1;
      while (i < n) {
        c = text.charCodeAt(i);
        if (c === 44 || c === 10 || c === 13) break;
        i += 1;
      }
      if (i >= n) {
        uAdded += i - start;
        fValue = acc + text.slice(start, i);
        pos = n;
        fEnded = 0;
        return;
      }
      if (c === 44) {
        uAdded += i - start;
        fValue = acc + text.slice(start, i);
        pos = i + 1;
        fEnded = 1;
        return;
      }
      if (c === 10) {
        uAdded += i - start;
        fValue = acc + text.slice(start, i);
        pos = i + 1;
        line += 1;
        fEnded = 2;
        return;
      }
      // c === 13: a CR.
      if (text.charCodeAt(i + 1) === 10) {
        uAdded += i - start;
        fValue = acc + text.slice(start, i);
        pos = i + 2;
        line += 1;
        fEnded = 2;
        return;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      acc += text.slice(start, i);
      uAdded += i - start;
      pos = i + 1;
      start = pos;
    }
  }

  // The text of a quoted segment [a, b): each CRLF or lone CR in it is one LF, and each such break
  // (and each LF) is one line. A segment with no break in it is sliced out whole.
  function quotedSegment(a, b) {
    let i = a;
    let c = -1;
    while (i < b) {
      c = text.charCodeAt(i);
      if (c === 13 || c === 10) break;
      i += 1;
    }
    if (i >= b) return text.slice(a, b);
    let out = text.slice(a, i);
    for (;;) {
      if (c === 13) {
        out += '\n';
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
      } else {
        // c === 10: the LF stands as it is.
        out += '\n';
        line += 1;
        i += 1;
      }
      let j = i;
      c = -1;
      while (j < b) {
        c = text.charCodeAt(j);
        if (c === 13 || c === 10) break;
        j += 1;
      }
      out += text.slice(i, j);
      i = j;
      if (i >= b) return out;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue/fEnded.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    let acc = '';
    pos += 1;
    let start = pos;
    for (;;) {
      let i = pos;
      while (i < n && text.charCodeAt(i) !== 34) i += 1;
      if (i >= n) {
        // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        pos = open + 1;
        line = openLine;
        scanUnquoted('"');
        return;
      }
      acc += quotedSegment(start, i);
      if (text.charCodeAt(i + 1) === 34) {
        // A doubled quote is one quote in the value; the segment before it stays.
        acc += '"';
        pos = i + 2;
        start = pos;
        continue;
      }
      pos = i + 1;
      break;
    }
    if (pos >= n) {
      fValue = acc;
      fEnded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = acc;
      fEnded = 1;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = acc;
      fEnded = 2;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = acc;
      fEnded = 2;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    scanUnquoted(acc);
    if (uAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
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
    let quoted = false;
    for (;;) {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        scanQuoted();
      } else {
        quoted = false;
        scanUnquoted('');
      }
      fields.push(fValue);
      if (fEnded !== 1) break;
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
