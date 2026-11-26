// The local query service. The browser reports a refused or dropped connection
// as a TypeError, which is said here in words.
export async function post(path, body) {
  let response;
  try { response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  catch (error) { throw error.name === "TypeError" ? new Error("无法连接本机服务") : error; }
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "查询失败，请重试。");
  return value;
}
