// HTTP 服务：JSON API + 单页调度台。角色身份用 X-User-Id 头（会话由页面登录后保存）。
import http from "node:http";
import { createHash } from "node:crypto";
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

// 请求内容指纹：剔除幂等键与乐观锁版本号（版本是并发控制字段，同一命令重发时会变，
// 不属于业务内容），再按键名排序做稳定序列化。
// 同键同动作只有在业务内容指纹一致时才回放；内容不一致直接 409 且不改数据。
function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value)
      .filter(k => k !== "idempotencyKey" && k !== "version")
      .sort()
      .map(k => JSON.stringify(k) + ":" + canonicalJson(value[k]))
      .join(",") + "}";
  }
  return JSON.stringify(value);
}
function fingerprint(body) {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

// 幂等键只在「同一动作作用域 + 同一请求内容」内回放，作用域 = 动作名 + 批次 id（+ 新建端点标识）。
// - 同键用于不同动作：409 idempotency_scope_conflict，不回放；
// - 同键同动作但内容不同：409 idempotency_content_mismatch，不执行、不改数据；
// - 完全一致：回放首次响应（replayed:true）。
// 动作失败（抛错）时不缓存，客户端可用同键安全重试。
async function mutateWithIdempotency(req, body, scope, work) {
  const key = req.headers["idempotency-key"] || body.idempotencyKey;
  return store.mutate(state => {
    const userId = req.headers["x-user-id"] || body.userId || null;
    if (key) {
      const hit = state.idempotency[key];
      if (hit) {
        if (hit.scope !== scope) {
          throw new HttpError(409, "idempotency_scope_conflict", {
            usedBy: hit.scope, requestedScope: scope,
            message: "该幂等键已用于其他动作，不能回放不同动作的结果"
          });
        }
        const fp = fingerprint(body);
        if (hit.fingerprint !== fp) {
          throw new HttpError(409, "idempotency_content_mismatch", {
            message: "该幂等键已用于内容不同的请求；请核对请求或更换新的幂等键"
          });
        }
        if (hit.ok) {
          if (hit.actorId && hit.actorId !== userId) {
            throw new HttpError(403, "idempotency_actor_mismatch", {
              message: "该幂等键属于其他负责人，不能代为重放"
            });
          }
          return { ...hit.payload, replayed: true, firstAt: hit.at };
        }
      }
    }
    const result = work(state, userId);
    if (key) {
      state.idempotency[key] = {
        scope, actorId: userId, fingerprint: fingerprint(body),
        ok: true, at: new Date().toISOString(),
        payload: JSON.parse(JSON.stringify(result))
      };
    }
    return result;
  });
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

    // 只读预演：不进入幂等/写事务。
    let m = pathname.match(/^\/api\/batches\/([^/]+)\/slots$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const data = await store.read(state => {
        const userId = req.headers["x-user-id"] || body.userId || null;
        return getSlots(state, userId, body);
      });
      return sendJson(res, 200, data);
    }

    if (req.method === "POST" && pathname === "/api/batches") {
      const body = await readBody(req);
      const data = await mutateWithIdempotency(req, body, "batch.create",
        (state, userId) => createBatch(state, userId, body));
      return sendJson(res, 201, data);
    }

    m = pathname.match(/^\/api\/batches\/([^/]+)\/entries$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const data = await mutateWithIdempotency(req, body, `entry.add:${m[1]}`,
        (state, userId) => addEntry(state, userId, m[1], body));
      return sendJson(res, 201, data);
    }

    m = pathname.match(/^\/api\/batches\/([^/]+)\/auto-schedule$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const data = await mutateWithIdempotency(req, body, `batch.auto_schedule:${m[1]}`,
        (state, userId) => autoSchedule(state, userId, m[1], body));
      return sendJson(res, 200, data);
    }

    m = pathname.match(/^\/api\/batches\/([^/]+)\/reschedule$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const data = await mutateWithIdempotency(req, body, `batch.reschedule:${m[1]}`,
        (state, userId) => rescheduleBatch(state, userId, m[1], body));
      return sendJson(res, 200, data);
    }

    m = pathname.match(/^\/api\/batches\/([^/]+)\/submit$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const data = await mutateWithIdempotency(req, body, `batch.submit:${m[1]}`,
        (state, userId) => submitBatch(state, userId, m[1], body));
      return sendJson(res, 200, data);
    }

    m = pathname.match(/^\/api\/batches\/([^/]+)\/withdraw$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const data = await mutateWithIdempotency(req, body, `batch.withdraw:${m[1]}`,
        (state, userId) => withdrawBatch(state, userId, m[1], body));
      return sendJson(res, 200, data);
    }

    m = pathname.match(/^\/api\/batches\/([^/]+)\/review$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const decision = body.decision === "approve" ? "approve" : "reject";
      const data = await mutateWithIdempotency(req, body, `batch.${decision}:${m[1]}`,
        (state, userId) => reviewBatch(state, userId, m[1], decision, body));
      return sendJson(res, 200, data);
    }

    m = pathname.match(/^\/api\/batches\/([^/]+)\/deliver$/);
    if (m && req.method === "POST") {
      const body = await readBody(req);
      const data = await mutateWithIdempotency(req, body, `batch.deliver:${m[1]}`,
        (state, userId) => deliverBatch(state, userId, m[1], body));
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
