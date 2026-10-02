// Local, disposable HTTP/WebSocket servers for the UAT driver tests.
// Everything binds 127.0.0.1 on an ephemeral port; nothing here is a real
// target and no credential in these tests is real.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

// Generic HTTP server. `handler(req, res, url, requests)` decides the response.
// Every request (method, path, headers) is recorded so a test can prove which
// origin received a credential.
function startHttpServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      requests.push({ method: req.method, path: url.pathname, headers: Object.assign({}, req.headers) });
      handler(req, res, url, requests);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, origin: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
    });
  });
}

function startStaticServer(rootDir) {
  return startHttpServer((req, res, url) => {
    const rel = url.pathname === "/" ? "/sample.html" : url.pathname;
    const file = path.join(rootDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(path.resolve(rootDir)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const type = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(fs.readFileSync(file));
  });
}

// Accepts the TCP connection and then never answers, so page.goto() hangs and
// a wrapper-level timeout can be exercised mid-run.
function startStallingServer() {
  return new Promise((resolve) => {
    const server = http.createServer(() => { /* never responds */ });
    server.on("connection", () => { /* hold the socket open */ });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, origin: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) === 0x80;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload, total: offset + len };
}

// Minimal WebSocket server: completes the handshake and records text frames.
function startWsServer() {
  return new Promise((resolve) => {
    const messages = [];
    let connections = 0;
    const server = http.createServer((req, res) => {
      res.writeHead(426, { "content-type": "text/plain" });
      res.end("upgrade required");
    });
    server.on("upgrade", (req, socket) => {
      const key = req.headers["sec-websocket-key"] || "";
      const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      connections++;
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const frame = parseFrame(buf);
          if (!frame) break;
          buf = buf.subarray(frame.total);
          if (frame.opcode === 0x1) messages.push(frame.payload.toString("utf8"));
          if (frame.opcode === 0x8) { socket.end(); return; }
        }
      });
      socket.on("error", () => { /* ignore client resets */ });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server, port, messages,
        origin: `ws://127.0.0.1:${port}`,
        connectionCount: () => connections,
        close: () => server.close(),
      });
    });
  });
}

module.exports = { startHttpServer, startStaticServer, startStallingServer, startWsServer };
