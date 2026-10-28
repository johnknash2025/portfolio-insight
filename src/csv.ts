export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function rowsToRecords(rows: string[][]): { headers: string[]; records: Record<string, string>[] } {
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const records: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0].trim() === "") continue;
    const rec: Record<string, string> = {};
    for (const [i, h] of headers.entries()) rec[h] = cells[i] ?? "";
    records.push(rec);
  }
  return { headers, records };
}

export function requireColumns(headers: string[], required: string[], fileLabel: string): void {
  const missing = required.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    throw new Error(`${fileLabel}: missing required column(s): ${missing.join(", ")}`);
  }
}
