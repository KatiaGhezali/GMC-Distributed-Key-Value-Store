import http from "node:http";

export class StorageNode {
  constructor(nodeId, port) {
    this.nodeId = nodeId;
    this.port = port;
    this.data = new Map();
    this.server = null;
    this.available = true;
  }

  start() {
    this.server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");

      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            nodeId: this.nodeId,
            status: "healthy",
          }),
        );
        return;
      }

      if (!this.available) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "Node unavailable" }));
        return;
      }

      const url = new URL(req.url, `http://localhost:${this.port}`);
      const key = url.searchParams.get("key");

      // Internal endpoint: retrieve all stored records.
      if (req.method === "GET" && url.pathname === "/data/all") {
        res.writeHead(200);
        res.end(JSON.stringify(Object.fromEntries(this.data)));
        return;
      }

      // Internal endpoint: clear stored records after migration.
      if (req.method === "DELETE" && url.pathname === "/data/all") {
        const deletedCount = this.data.size;
        this.data.clear();

        res.writeHead(200);
        res.end(
          JSON.stringify({
            message: "All records cleared",
            deletedCount,
          }),
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/data") {
        if (!key || !this.data.has(key)) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Key not found" }));
          return;
        }

        res.writeHead(200);
        res.end(
          JSON.stringify({
            key,
            value: this.data.get(key),
          }),
        );
        return;
      }

      if (req.method === "PUT" && url.pathname === "/data") {
        if (!key) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Key is required" }));
          return;
        }

        let body = "";

        req.on("data", (chunk) => {
          body += chunk;
        });

        req.on("end", () => {
          try {
            const parsed = JSON.parse(body);

            if (!Object.hasOwn(parsed, "value")) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: "Value is required" }));
              return;
            }

            this.data.set(key, parsed.value);

            res.writeHead(200);
            res.end(
              JSON.stringify({
                message: "Value stored successfully",
                nodeId: this.nodeId,
                key,
              }),
            );
          } catch {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Invalid JSON" }));
          }
        });

        return;
      }

      if (req.method === "DELETE" && url.pathname === "/data") {
        if (!key || !this.data.has(key)) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Key not found" }));
          return;
        }

        this.data.delete(key);

        res.writeHead(200);
        res.end(JSON.stringify({ message: "Value deleted", key }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "Route not found" }));
    });

    return new Promise((resolve, reject) => {
      this.server.once("error", reject);

      this.server.listen(this.port, "0.0.0.0", () => {
        console.log(
          `[${this.nodeId}] Storage node listening on port ${this.port}`,
        );
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        console.log(`[${this.nodeId}] Storage node stopped`);
        resolve();
      });
    });
  }
}
