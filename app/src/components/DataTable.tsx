import { Fragment, type ReactNode } from "react";

export type Column<T> = {
  /** The column's header, and the line's label in a phone's card. */
  label: ReactNode;
  cell: (row: T) => ReactNode;
  /** Right-aligned, tabular figures. */
  numeric?: boolean;
  /**
   * Where it goes in a phone's card: `title` leads the card, `corner` sits opposite it (a
   * status, a link, a label). Anything else is a labelled line.
   */
  phone?: "title" | "corner";
};

/**
 * A table from `sm` up; on phones, a card per row, its title and corner first and every other
 * column a labelled line, where six columns would have meant scrolling sideways.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  dense = false,
  top = false,
}: {
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T) => string | number;
  /** Tighter cells, for a table with many columns. */
  dense?: boolean;
  /** Top-align cells, for cells that hold two lines. */
  top?: boolean;
}) {
  const title = columns.filter((c) => c.phone === "title");
  const corner = columns.filter((c) => c.phone === "corner");
  const lines = columns.filter((c) => !c.phone);
  const pad = dense ? "px-3 py-3" : "px-4 py-3";

  return (
    <>
      <ul className="divide-y divide-line sm:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className="px-4 py-3.5">
            {(title.length > 0 || corner.length > 0) && (
              <div className="flex items-start justify-between gap-3">
                <div className="font-medium">
                  {title.map((c, i) => (
                    <Fragment key={i}>{c.cell(r)}</Fragment>
                  ))}
                </div>
                <div className="shrink-0 text-right text-sm">
                  {corner.map((c, i) => (
                    <Fragment key={i}>{c.cell(r)}</Fragment>
                  ))}
                </div>
              </div>
            )}
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {lines.map((c, i) => (
                <Fragment key={i}>
                  <dt className="text-muted">{c.label}</dt>
                  <dd className={`text-right whitespace-nowrap ${c.numeric ? "num" : ""}`}>{c.cell(r)}</dd>
                </Fragment>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <div className="scroll-x hidden sm:block">
        <table className="w-full text-sm whitespace-nowrap">
          <thead className="text-left text-muted">
            <tr className="border-b border-line">
              {columns.map((c, i) => (
                <th key={i} className={`${pad} font-normal ${c.numeric ? "text-right" : ""}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)} className={`border-b border-line last:border-0 ${top ? "align-top" : ""}`}>
                {columns.map((c, i) => (
                  <td key={i} className={`${pad} ${c.numeric ? "num text-right" : ""}`}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
