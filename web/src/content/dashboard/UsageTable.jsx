import React from "react";
import { exact, short } from "./format.js";

const cell = (column, row) => column.count
  ? <span title={exact(row[column.key])} className={row[column.key] > 0 ? "" : "is-zero"}>{short(row[column.key])}</span>
  : row[column.key];

// A plain table of counts. Every row is on one page, inside a box that scrolls
// when the list is long. Each number is written short, with its exact value on
// hover, and a column is right-aligned when it holds numbers.
export function UsageTable({ caption, columns, rows, footer, maxHeight = 420 }) {
  const cells = (row, Tag) => columns.map(column => {
    const numeric = column.align === "right";
    return <Tag key={column.key} className={numeric ? "is-num" : undefined}>{Tag === "th" ? column.label : cell(column, row)}</Tag>;
  });
  return <div className="usage-table-box" tabIndex={0} role="region" aria-label={caption} style={{ maxHeight }}>
    <table className="usage-table">
      {caption && <caption>{caption}</caption>}
      <thead><tr>{cells(null, "th")}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.key ?? index}>{cells(row, "td")}</tr>)}</tbody>
      {footer && <tfoot><tr>{cells(footer, "td")}</tr></tfoot>}
    </table>
  </div>;
}
