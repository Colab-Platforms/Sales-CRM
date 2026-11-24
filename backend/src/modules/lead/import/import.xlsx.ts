import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import JSZip from "jszip";
import { SaxesParser } from "saxes";

// A SMALL, BOUNDED-MEMORY .xlsx READER. The spreadsheet library's own streaming reader proved unreliable (it fails on many workbooks, depending on the order of the entries inside the zip), and its normal reader holds every
// cell of the workbook in memory. This reads the zip's central directory (so entry order does not matter), loads only the shared strings and the cell styles, and streams the first worksheet's XML row by row.
// Cells are returned as text: numbers exactly as written (a phone number keeps every digit), dates as ISO strings, booleans as TRUE/FALSE, errors as empty.

const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormatCode(code: string): boolean {
  // ignore quoted text and [bracketed] sections (colours, locales), then look for date/time tokens
  const stripped = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[dmyhs]/i.test(stripped) && !/^(general|0|#)/i.test(stripped.trim());
}

type Node = { name: string; attrs: Record<string, string> };

/** Runs a SAX parse over a stream of XML chunks, awaiting between chunks so the caller can drain what the events produced. */
async function parseXml(chunks: AsyncIterable<Buffer | string>, handlers: { open?: (n: Node) => void; text?: (t: string, parents: string[]) => void; close?: (name: string) => void }, afterChunk?: () => Promise<void> | void): Promise<void> {
  const parser = new SaxesParser({ xmlns: false, position: false });
  const stack: string[] = [];
  parser.on("opentag", (tag) => {
    stack.push(tag.name);
    handlers.open?.({ name: tag.name, attrs: tag.attributes as Record<string, string> });
  });
  parser.on("text", (t) => handlers.text?.(t, stack));
  parser.on("closetag", (tag) => {
    handlers.close?.(tag.name);
    stack.pop();
  });
  let failure: Error | null = null;
  parser.on("error", (e) => {
    failure = e;
  });
  const decoder = new StringDecoder("utf8");
  for await (const chunk of chunks) {
    parser.write(typeof chunk === "string" ? chunk : decoder.write(chunk));
    if (failure) throw failure;
    if (afterChunk) await afterChunk();
  }
  parser.write(decoder.end());
  parser.close();
  if (failure) throw failure;
  if (afterChunk) await afterChunk();
}

/** A zip entry's decompressed bytes as an async iterable, one chunk at a time (the entry is inflated on demand, never whole). */
function chunksOf(file: JSZip.JSZipObject): AsyncIterable<Buffer> {
  return {
    [Symbol.asyncIterator]() {
      const stream = file.nodeStream() as unknown as NodeJS.ReadableStream;
      const queue: Buffer[] = [];
      let ended = false;
      let failure: unknown = null;
      let wake: (() => void) | null = null;
      stream.pause();
      stream.on("data", (c: Buffer) => {
        queue.push(Buffer.from(c));
        stream.pause();
        wake?.();
      });
      stream.on("end", () => {
        ended = true;
        wake?.();
      });
      stream.on("error", (e) => {
        failure = e;
        wake?.();
      });
      return {
        async next(): Promise<IteratorResult<Buffer>> {
          for (;;) {
            if (failure) throw failure;
            if (queue.length) return { value: queue.shift()!, done: false };
            if (ended) return { value: undefined, done: true };
            stream.resume();
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
          }
        },
      };
    },
  };
}

const columnIndex = (ref: string): number => {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

const serialToIso = (serial: number): string | null => {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  // Excel's 1900 system (with its fictitious 29 Feb 1900): serial 25569 is 1970-01-01
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export type XlsxRow = { rowNumber: number; values: string[] };

const STOP = new Error("stop");

/** The workbook's worksheets in tab order: name and the zip path of each. */
async function sheetList(zip: JSZip): Promise<{ name: string; path: string }[]> {
  const entry = (name: string) => zip.file(name);
  const wbFile = entry("xl/workbook.xml");
  const found: { name: string; rid: string | null }[] = [];
  if (wbFile) {
    await parseXml(chunksOf(wbFile), {
      open: (n) => {
        if (n.name === "sheet") found.push({ name: n.attrs.name ?? `Sheet ${found.length + 1}`, rid: n.attrs["r:id"] ?? n.attrs[`{${NS_REL}}id`] ?? null });
      },
    });
  }
  const targets = new Map<string, string>();
  const relsFile = entry("xl/_rels/workbook.xml.rels");
  if (relsFile) {
    await parseXml(chunksOf(relsFile), {
      open: (n) => {
        if (n.name === "Relationship" && n.attrs.Id && n.attrs.Target) targets.set(n.attrs.Id, n.attrs.Target);
      },
    });
  }
  const out = found.map((f) => {
    const t = f.rid ? targets.get(f.rid) : undefined;
    return { name: f.name, path: t ? (t.startsWith("/") ? t.slice(1) : `xl/${t}`) : "" };
  }).filter((f) => f.path && entry(f.path));
  return out.length ? out : [{ name: "Sheet1", path: "xl/worksheets/sheet1.xml" }];
}

/** The header row (first non-empty row) of every worksheet, so the importer can choose the sheet that holds the customer table. */
export async function listXlsxSheets(filePath: string): Promise<{ name: string; index: number; header: string[] }[]> {
  const zip = await JSZip.loadAsync(await readFile(filePath));
  const sheets = await sheetList(zip);
  const out: { name: string; index: number; header: string[] }[] = [];
  for (let i = 0; i < sheets.length; i++) {
    let header: string[] = [];
    for await (const row of readXlsxRows(filePath, i)) {
      if (row.values.some((v) => v !== "")) {
        header = row.values;
        break;
      }
    }
    out.push({ name: sheets[i]!.name, index: i, header });
  }
  return out;
}

/** Rows of one worksheet (default: the first), streamed. */
export async function* readXlsxRows(filePath: string, sheetIndex = 0): AsyncGenerator<XlsxRow> {
  const zip = await JSZip.loadAsync(await readFile(filePath));
  const entry = (name: string) => zip.file(name);
  const sheets = await sheetList(zip);
  const sheetFile = entry(sheets[Math.min(Math.max(sheetIndex, 0), sheets.length - 1)]!.path);
  if (!sheetFile) throw new Error("worksheet not found");

  // ---- shared strings
  const strings: string[] = [];
  const ssFile = entry("xl/sharedStrings.xml");
  if (ssFile) {
    let current = "";
    let inSi = false;
    await parseXml(chunksOf(ssFile), {
      open: (n) => {
        if (n.name === "si") {
          inSi = true;
          current = "";
        }
      },
      // text of <t> directly under <si> or inside an <r> run; phonetic runs (<rPh>) are skipped
      text: (t, parents) => {
        if (inSi && parents[parents.length - 1] === "t" && !parents.includes("rPh")) current += t;
      },
      close: (name) => {
        if (name === "si") {
          strings.push(current);
          inSi = false;
        }
      },
    });
  }

  // ---- which cell styles are dates
  const dateStyle: boolean[] = [];
  const stylesFile = entry("xl/styles.xml");
  if (stylesFile) {
    const customDate = new Map<number, boolean>();
    let inCellXfs = false;
    await parseXml(chunksOf(stylesFile), {
      open: (n) => {
        if (n.name === "numFmt") customDate.set(Number(n.attrs.numFmtId), isDateFormatCode(n.attrs.formatCode ?? ""));
        else if (n.name === "cellXfs") inCellXfs = true;
        else if (n.name === "xf" && inCellXfs) {
          const id = Number(n.attrs.numFmtId ?? 0);
          dateStyle.push(customDate.get(id) ?? BUILTIN_DATE_FORMATS.has(id));
        }
      },
      close: (name) => {
        if (name === "cellXfs") inCellXfs = false;
      },
    });
  }

  // ---- the first worksheet, row by row
  const queue: XlsxRow[] = [];
  let stopped = false;
  let row: string[] | null = null;
  let rowNumber = 0;
  let cell: { col: number; type: string; style: number; value: string; inline: string } | null = null;
  let inValue = false;
  let inInline = false;
  const finishCell = () => {
    if (!cell || !row) return;
    let text = "";
    switch (cell.type) {
      case "s":
        text = strings[Number(cell.value)] ?? "";
        break;
      case "inlineStr":
        text = cell.inline;
        break;
      case "str":
        text = cell.value;
        break;
      case "b":
        text = cell.value === "1" ? "TRUE" : cell.value === "0" ? "FALSE" : "";
        break;
      case "e":
        text = "";
        break;
      case "d":
        text = cell.value;
        break;
      default:
        // number: a date when the cell's style says so, otherwise exactly as written
        text = cell.value && dateStyle[cell.style] ? (serialToIso(Number(cell.value)) ?? cell.value) : cell.value;
    }
    while (row.length < cell.col) row.push("");
    row[cell.col] = text.trim();
    cell = null;
  };

  const chunks = chunksOf(sheetFile);
  const parsing = parseXml(
    chunks,
    {
      open: (n) => {
        if (n.name === "row") {
          rowNumber = n.attrs.r ? Number(n.attrs.r) : rowNumber + 1;
          row = [];
        } else if (n.name === "c" && row) {
          cell = { col: n.attrs.r ? columnIndex(n.attrs.r) : row.length, type: n.attrs.t ?? "n", style: Number(n.attrs.s ?? 0), value: "", inline: "" };
        } else if (n.name === "v" && cell) inValue = true;
        else if (n.name === "is" && cell) inInline = true;
      },
      text: (t, parents) => {
        if (!cell) return;
        if (inValue) cell.value += t;
        else if (inInline && parents[parents.length - 1] === "t" && !parents.includes("rPh")) cell.inline += t;
      },
      close: (name) => {
        if (name === "v") inValue = false;
        else if (name === "is") inInline = false;
        else if (name === "c") finishCell();
        else if (name === "row" && row) {
          queue.push({ rowNumber, values: row });
          row = null;
        }
      },
    },
    // backpressure: stop reading the file while the consumer is far behind, so memory stays bounded
    async () => {
      while (queue.length > 5000 && !stopped) await new Promise((r) => setImmediate(r));
      if (stopped) throw STOP;
    },
  );
  // Drain the queue as the parse advances: parseXml resolves when the file ends. A single in-flight promise is awaited between polls so rows are yielded in order without buffering the whole sheet.
  let done = false;
  let failure: unknown = null;
  parsing.then(
    () => {
      done = true;
    },
    (e) => {
      if (e !== STOP) failure = e;
      done = true;
    },
  );
  try {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (done) break;
      await new Promise((r) => setImmediate(r));
    }
    while (queue.length) yield queue.shift()!;
    if (failure) throw failure;
  } finally {
    // a caller that stops early (header-only read) must not leave the parser spinning
    stopped = true;
  }
}
