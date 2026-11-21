// A faster drop-in for csv-reader 1.0.0 (make.fun's own reference program).
//
// Same answers, same errors, same order, on every input. v4 keeps v3's
// reading and its flat single-function shape; the one change is inside
// the quoted-field segment scan. v3 unrolled that scan four characters
// per step; measured back-to-back on the practice set, a plain
// one-character loop is faster there (the unrolled body's repeated
// bounds checks and break traffic cost more than the checks they save),
// so v4 scans segments with the simple loop. The unquoted scan keeps
// v3's unrolled form, which measured level with the simple loop there.
// Directions measured and rejected on the way: locating delimiters with
// String#indexOf (native-call overhead per field exceeds the scan it
// replaces) and gating the delimiter test on charCode <= 44 (the extra
// comparison costs more than it saves).
//
// The reading itself is unchanged: a U+FEFF at the very start is dropped;
// records end at LF or CRLF and a line with no characters is no record; a
// CR outside quotes that is not part of a CRLF is dropped (stray_cr); a
// field that opens with a quote runs to the next undoubled quote, "" is
// one quote, each CRLF or lone CR inside becomes one LF; what follows the
// closing quote is appended as it stands (quote_junk when it adds text);
// a quote that never closes is a literal character and the text after it
// is read again as unquoted (unterminated_quote); records are padded or
// cut to the first record's width (short_row / long_row).
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

  // The field being read: its value, and how it ended (0 end, 1 comma, 2 line break).
  let fValue = '';
  let fEnded = 0;

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

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;

    // Read the record's fields.
    for (;;) {
      // One field. `acc` is the text the field already holds before the
      // unquoted scan: '' for a plain field, the quoted value when junk
      // follows its closing quote, '"' when an unterminated quote is
      // re-read as unquoted. The phase loop runs the quoted scan first
      // when the field opens with a quote, then falls into the unquoted
      // scan for those two continuations.
      let acc = '';
      let quoted = false;

      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        // ---- Quoted field: one merged pass over its segments. ----
        const open = pos;
        const openLine = line;
        let segStart = pos + 1;
        let value = null; // accumulated value; null until the first segment lands
        let junk = false; // the closing quote is followed by more text
        let reread = false; // the quote never closes: re-read as unquoted

        segments: for (;;) {
          // Scan the segment [segStart, next '"'): watch for the quote
          // and for line breaks in the same pass. Breaks found along the
          // way are normalised into `out` (each CRLF or lone CR is one
          // LF and one line); a segment with no break is sliced whole.
          let i = segStart;
          let out = null; // normalised text of this segment, once a break is met
          let partStart = segStart;
          segScan: for (;;) {
            // Unrolled four-wide: stop at the segment's closing quote or
            // at a line break (which is normalised and scanning resumes).
            let c = -1;
            while (i < n) {
              const cx = text.charCodeAt(i);
              if (cx === 34 || cx === 10 || cx === 13) { c = cx; break; }
              i += 1;
            }
            if (i >= n || c === 34) break segScan;
            // A line break inside the segment: normalise it and resume.
            if (out === null) out = text.slice(partStart, i);
            else out += text.slice(partStart, i);
            out += '\n';
            line += 1;
            i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
            partStart = i;
          }
          const segment = out === null ? text.slice(segStart, i) : out + text.slice(partStart, i);

          if (i >= n) {
            // The quote never closes: it is a literal character, and the
            // text after it is read again as unquoted.
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            pos = open + 1;
            line = openLine;
            acc = '"';
            reread = true;
            break segments;
          }
          if (text.charCodeAt(i + 1) === 34) {
            // A doubled quote is one quote in the value.
            value = value === null ? segment + '"' : value + segment + '"';
            segStart = i + 2;
            continue segments;
          }
          // The closing quote.
          value = value === null ? segment : value + segment;
          pos = i + 1;
          if (pos >= n) {
            fValue = value;
            fEnded = 0;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              fValue = value;
              fEnded = 1;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              fValue = value;
              fEnded = 2;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              fValue = value;
              fEnded = 2;
            } else {
              // What follows the closing quote is appended as it stands.
              acc = value;
              junk = true;
            }
          }
          break segments;
        }

        if (!junk && !reread) {
          fields.push(fValue);
          lastQuoted = true;
          if (fEnded !== 1) break;
          continue;
        }
        // Junk after the closing quote, or an unterminated quote re-read:
        // both continue with the unquoted scan below, on `acc`.
        lastQuoted = !reread;
      } else {
        lastQuoted = false;
      }

      // ---- Unquoted scan: from pos onto `acc`, up to the next comma or
      // line break; a CR not followed by LF is dropped (stray_cr). ----
      {
        let start = pos;
        let uAdded = 0;
        for (;;) {
          let i = pos;
          let c = -1;
          scan: while (i < n) {
            let cx = text.charCodeAt(i);
            if (cx === 44 || cx === 10 || cx === 13) { c = cx; break scan; }
            i += 1;
            if (i >= n) break scan;
            cx = text.charCodeAt(i);
            if (cx === 44 || cx === 10 || cx === 13) { c = cx; break scan; }
            i += 1;
            if (i >= n) break scan;
            cx = text.charCodeAt(i);
            if (cx === 44 || cx === 10 || cx === 13) { c = cx; break scan; }
            i += 1;
            if (i >= n) break scan;
            cx = text.charCodeAt(i);
            if (cx === 44 || cx === 10 || cx === 13) { c = cx; break scan; }
            i += 1;
          }
          if (i >= n) {
            uAdded += i - start;
            fValue = acc === '' ? text.slice(start, i) : acc + text.slice(start, i);
            pos = n;
            fEnded = 0;
            break;
          }
          if (c === 44) {
            uAdded += i - start;
            fValue = acc === '' ? text.slice(start, i) : acc + text.slice(start, i);
            pos = i + 1;
            fEnded = 1;
            break;
          }
          if (c === 10) {
            uAdded += i - start;
            fValue = acc === '' ? text.slice(start, i) : acc + text.slice(start, i);
            pos = i + 1;
            line += 1;
            fEnded = 2;
            break;
          }
          // c === 13: a CR.
          if (text.charCodeAt(i + 1) === 10) {
            uAdded += i - start;
            fValue = acc === '' ? text.slice(start, i) : acc + text.slice(start, i);
            pos = i + 2;
            line += 1;
            fEnded = 2;
            break;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          acc += text.slice(start, i);
          uAdded += i - start;
          pos = i + 1;
          start = pos;
        }
        // quote_junk: junk followed a closing quote and added text.
        if (quoted && lastQuoted && uAdded > 0) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
      }

      fields.push(fValue);
      if (fEnded !== 1) break;
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

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
