// HTTP 服务：JSON API + 单页调度台。角色身份用 X-User-Id 头（会话由页面登录后保存）。
import http from "node:http";
import { Store } from "./src/store.js";
import { renderPage } from "./src/page.js";
import {
  HttpError, ROLES, overview, createBatch, addEntry, autoSchedule, getSlots,
  rescheduleBatch, submitBatch, withdrawBatch, reviewBatch, deliverBatch
} from "./src/domain.js";

const port = Number(process.env.PORT || 3038);
const store = new Store();

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}
function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

// HTTP 层幂等：同一 Idempotency-Key 的重复提交直接回放首次响应，绝不产生第二条记录。
async function withIdempotency(state, req, body, work) {
  const key = req.headers["idempotency-key"] || body.idempotencyKey;
  if (key) {
    const hit = state.idempotency[key];
    if (hit && hit.http) {
      return { ...hit.http.payload, replayed: true, firstAt: hit.http.at };
    }
  }
  const result = await work();
  if (key) {
    state.idempotency[key] = state.idempotency[key] || {};
    state.idempotency[key].http = { at: new Date().toISOString(), payload: JSON.parse(JSON.stringify(result)) };
  }
  return result;
}

// 在同一事务内执行动作；domain 抛 HttpError 时事务回滚（store 已恢复快照），错误照常返回。
async function tx(req, body, fn) {
  return store.mutate(state => withIdempotency(state, req, body, () => {
    const userId = req.headers["x-user-id"] || body.userId || null;
    return fn(state, userId, body);
  }));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(renderPage());
    }

    if (req.method === "GET" && pathname === "/api/overview") {
      const userId = url.searchParams.get("userId");
      const data = await store.read(state => overview(state, userId));
      return sendJson(res, 200, data);
    }

    if (req.method === "POST" && pathname === "/api/batches") {
      const body = await readBody(req);
      const data = await tx(req, body, (state, userId) => createBatch(state, userId, body));
      return sendJson(res, 201, data);
    }

    let m = pathname.match(/^\/api\/batches\/([^/]+)\/slots$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const data = await tx(req, body, (state, userId) => getSlots(state, userId, body));
      return sendJson(res, 200, data);
    }

    m = pathname.match(/^\/api\/batches\/([^/]+)\/entries$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const data = await tx(req, body, (state, userId) => addEntry(state, userId, m[1], body));
      return sendJson(res, 201, data);
    }

    m = pathname.match(/^\/api\/batches\/([^/]+)\/auto-schedule$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const data = await tx(req, body, (state, userId) => autoSchedule(state, userId, m[1], body));
      return sendJson(res, 200, data);
    }

    m = pathname.match(/^\/api\/batches\/([^/]+)\/reschedule$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const data = await tx(req, body, (state, userId) => rescheduleBatch(state, userId, m[1], body));
      return sendJson(res, 200, data);
    }

    m = pathname.match(/^\/api\/batches\/([^/]+)\/submit$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const data = await tx(req, body, (state, userId) => submitBatch(state, userId, m[1], body));
      return sendJson(res, 200, data);
    }

    m = pathname.match(/^\/api\/batches\/([^/]+)\/withdraw$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const data = await tx(req, body, (state, userId) => withdrawBatch(state, userId, m[1]));
      return sendJson(res, 200, data);
    }

    m = pathname.match(/^\/api\/batches\/([^/]+)\/review$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const decision = body.decision === "approve" ? "approve" : "reject";
      const data = await tx(req, body, (state, userId) => reviewBatch(state, userId, m[1], decision, body));
      return sendJson(res, 200, data);
    }

    m = pathname.match(/^\/api\/batches\/([^/]+)\/deliver$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const data = await tx(req, body, (state, userId) => deliverBatch(state, userId, m[1], body));
      return sendJson(res, 200, data);
    }

    if (req.method === "GET" && pathname === "/api/roles") {
      return sendJson(res, 200, { roles: Object.entries(ROLES).map(([key, name]) => ({ key, name })) });
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    if (err instanceof HttpError) {
      return sendJson(res, err.status, { error: err.code, details: err.details });
    }
    sendJson(res, 500, { error: "internal_error", message: err.message });
  }
});

// 测试可 import { start } 并用 PORT/DB_PATH 启动独立实例；直接运行则自动监听。
export function start(listenPort = port) {
  return new Promise(resolve => {
    server.listen(listenPort, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : listenPort;
      console.log(`古船帆索多角色校准调度台 listening on http://localhost:${actualPort}`);
      resolve({ server, port: actualPort });
    });
  });
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("server.js");
if (invokedDirectly) start();

export { server };
