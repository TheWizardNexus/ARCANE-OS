import { createServer } from "node:http";
import { once } from "node:events";
import process from "node:process";

const host = "127.0.0.1";
const port = 47831;
const abortController = new AbortController();

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, {
      product: "ARCANE",
      status: "ok",
      pid: process.pid
    });
  }

  return json(res, 404, {
    code: "NOT_FOUND",
    message: "Capability endpoint not found."
  });
});

server.listen(port, host);
await once(server, "listening");

console.log(`ARCANE runtime listening at http://${host}:${port}`);

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  abortController.abort();
  server.close();
  await once(server, "close").catch(() => {});
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
