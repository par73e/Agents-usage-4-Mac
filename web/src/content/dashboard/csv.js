// A table as a CSV file that Excel opens with its Chinese text intact.
const cell = value => {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const toCsv = (header, rows) => "\uFEFF" + [header, ...rows].map(row => row.map(cell).join(",")).join("\r\n");

// The file is offered for download under `name`; the name gets the moment, so
// two exports do not overwrite each other.
export function downloadCsv(name, header, rows, now = new Date()) {
  const stamp = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"), String(now.getMinutes()).padStart(2, "0")].join("");
  const url = URL.createObjectURL(new Blob([toCsv(header, rows)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = `${name}-${stamp}.csv`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
