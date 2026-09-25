// Reads the "grid" tables Python's tabulate prints, which is how Zephyr's
// hardenconfig and DT Doctor report, out of a build log. vscode-free, so the
// parsers built on it are unit tested on captured output.
//
//   +------------------+-----------+
//   | Name             | Current   |
//   +==================+===========+
//   | CONFIG_FOO       | y         |
//   +------------------+-----------+

import { cleanForLog } from '../core/ansi';

export interface GridTable {
  /** The header cells, empty when the table has no header row. */
  headers: string[];
  /** One entry per row, one string per column; a multi-line cell keeps its line breaks. */
  rows: string[][];
}

const BORDER = /^\s*\+(?:-+\+)+\s*$/;
const HEADER_RULE = /^\s*\+(?:=+\+)+\s*$/;
const ROW = /^\s*\|.*\|\s*$/;

/** Where each column starts and ends, from the positions of the + in a border line. */
function columnsOf(border: string): number[] {
  const stops: number[] = [];
  for (let i = 0; i < border.length; i++) {
    if (border[i] === '+') {
      stops.push(i);
    }
  }
  return stops;
}

/** The cells of one row line, cut where the border has its +; split on | when the line does not line up. */
function cellsOf(line: string, stops: number[]): string[] {
  const aligned = stops.every(stop => line[stop] === '|');
  if (aligned) {
    const cells: string[] = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      cells.push(line.slice(stops[i] + 1, stops[i + 1]));
    }
    return cells;
  }
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|');
}

/** Every grid table in `text`, in order. Anything else in the text is ignored. */
export function parseGridTables(text: string): GridTable[] {
  const lines = cleanForLog(text).split('\n');
  const tables: GridTable[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!BORDER.test(lines[i]) || i + 1 >= lines.length || !ROW.test(lines[i + 1])) {
      i++;
      continue;
    }
    const stops = columnsOf(lines[i].trimEnd());
    const width = stops.length - 1;
    const table: GridTable = { headers: [], rows: [] };
    let group: string[][] = [];
    const flush = (asHeader: boolean) => {
      if (group.length === 0) {
        return;
      }
      const cells = Array.from({ length: width }, (_, col) =>
        group.map(lineCells => (lineCells[col] ?? '').trim()).join('\n').replace(/^\n+|\n+$/g, ''));
      if (asHeader) {
        table.headers = cells;
      } else {
        table.rows.push(cells);
      }
      group = [];
    };
    i++;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (ROW.test(line)) {
        group.push(cellsOf(line, stops));
        continue;
      }
      if (HEADER_RULE.test(line)) {
        flush(table.headers.length === 0 && table.rows.length === 0);
      } else if (BORDER.test(line)) {
        flush(false);
      } else {
        break;
      }
      // A rule not followed by a row closes the table: the next line may be
      // the top border of another table printed right after this one.
      if (i + 1 >= lines.length || !ROW.test(lines[i + 1])) {
        i++;
        break;
      }
    }
    // A table cut short by the end of the log still gives the rows it had.
    flush(false);
    tables.push(table);
  }
  return tables;
}
