/** One line in a file list: a loose file, or a whole top-level folder. */
export interface FileRow {
  name: string;
  size: number;
  /** Files inside, for a folder; 1 for a loose file. */
  count: number;
  folder: boolean;
  renamed: boolean;
}

interface ListedFile {
  name: string;
  size: number;
  /** "Photos/2024" from the sender, or ["Photos", "2024"] from the receiver. */
  dir?: string | string[] | null;
  renamed?: boolean;
}

/** Collapse files into rows, one per top-level folder, in first-seen order,
 *  so a folder of 3,000 photos is one line instead of 3,000. */
export function fileRows(files: ListedFile[]): FileRow[] {
  const rows: FileRow[] = [];
  const folders = new Map<string, FileRow>();
  for (const f of files) {
    const top = typeof f.dir === "string" ? f.dir.split("/")[0] : f.dir?.[0];
    if (!top) {
      rows.push({ name: f.name, size: f.size, count: 1, folder: false, renamed: !!f.renamed });
      continue;
    }
    let row = folders.get(top);
    if (!row) {
      row = { name: top, size: 0, count: 0, folder: true, renamed: false };
      folders.set(top, row);
      rows.push(row);
    }
    row.size += f.size;
    row.count += 1;
    row.renamed ||= !!f.renamed;
  }
  return rows;
}

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;
