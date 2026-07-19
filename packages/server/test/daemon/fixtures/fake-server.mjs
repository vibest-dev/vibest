// A minimal stand-in for the real server: binds the port the launcher reserved
// and answers /api/health, so the daemon launcher can be tested without booting
// the full runtime. Exits on SIGTERM (no handler) like the real foreground server.
import http from "node:http";

const port = Number(process.env.VIBEST_PORT ?? 0);

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/health") {
    res.end("ok");
    return;
  }
  res.statusCode = 404;
  res.end("nope");
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(`vibest:ready {"port":${address.port}}`);
});
