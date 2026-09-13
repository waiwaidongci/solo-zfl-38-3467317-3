# 古船帆索 · 多角色校准调度台

在原型「古船模型帆索校准」基础上扩展的多角色协作调度台：

- **角色隔离（RBAC）**：校准员、复核员、交付员只能执行本岗动作，越权请求返回 `403` 并明确说明原因。
- **批次化排期**：每艘船的帆索条目先编成校准批次，排期引擎同时满足
  ① 工序依赖（勘验→初调→张紧→拉力复测）、② 负责人日排期（工作时段/午休/请假会议）、
  ③ 桅区占用（跨批工单与桅区封修）三类约束，给出可用时段。
- **整批改期事务**：先试算冲突，列出每个冲突项与**自洽的替代时段**；任一冲突则整批拒绝、**全部回滚**，
  版本号、原排期、schedules 表都不变；成功才整批替换并自增版本。
- **驳回留痕**：复核驳回后批次回到校准，排期与全部历史记录保留，校准员改期后可重新提交。
- **交付锁定**：已交付批次禁止新增条目、改期、撤回、复核、再交付（服务端强制，非仅 UI 隐藏）。
- **幂等与乐观锁**：`Idempotency-Key` 重复提交回放首次结果，绝不生成重复记录；旧 `version` 的过期请求直接拒绝。
- **三角色页面**：按角色显示待办、未来两周冲突日历、全员可见的审计轨迹。
- **持久化**：JSON 文件原子写（临时文件 + rename）+ 进程内写事务互斥，重启服务数据仍在；首跑自动播种，
  旧原型 `data/model-rigging-calibration.json` 中的船档案自动迁移。

## 运行

```bash
npm install        # 仅浏览器 E2E 需要 playwright；纯 API 无第三方依赖
npm start          # http://localhost:3038 （PORT / DB_PATH 可覆盖）
```

页面右上角切换身份：周宁/林锚（校准员）、沈渭（复核员）、郑合（交付员）。

## API（身份经 `X-User-Id` 头传递，建批支持 `Idempotency-Key`）

| 动作 | 方法与路径 | 角色 |
| --- | --- | --- |
| 总览（待办/日历/批次/审计） | `GET /api/overview?userId=` | 任意 |
| 编成校准批次 | `POST /api/batches` | 校准员 |
| 批次内新增帆索条目 | `POST /api/batches/:id/entries` | 负责校准员 |
| 自动排出可用时段 | `POST /api/batches/:id/auto-schedule` | 负责校准员 |
| 整批改期（带 `version` 乐观锁） | `POST /api/batches/:id/reschedule` | 负责校准员 |
| 提交复核 / 撤回复核 | `POST /api/batches/:id/submit` `/withdraw` | 负责校准员 |
| 复核通过 / 驳回（驳回必填原因） | `POST /api/batches/:id/review` | 复核员 |
| 确认交付（终态锁定） | `POST /api/batches/:id/deliver` | 交付员 |

批次状态机：`待校准 → 待复核 →（驳回）→ 待校准 … → 复核通过 → 已交付`。

## 测试

```bash
npm test
```

14 个用例（`node:test`，无外部测试框架）：

- `tests/api.test.js`：越权拒绝、幂等不重复、排期三约束、冲突报项与替代时段、**整批回滚**、
  过期版本拒绝、**驳回留痕与重新提交**、**交付六类写操作全锁定**、审计完整性；
- `tests/restart.test.js`：子进程真实起停，验证**重启后**批次/排期/锁定/审计/幂等记录全部保留；
- `tests/e2e.browser.test.js`：**Playwright 真实 Chromium** 三角色协作全链路
  （建批排期→提交→驳回→冲突改期回滚→点替代时段改期成功→重提→通过→交付锁定），
  并在浏览器内断言越权与锁定被服务端拒绝。

> 无 root 的精简容器若 Chromium 缺系统库（如 `libnspr4.so`），可用非 root 方式
> `apt-get download` 下载依赖 deb 解压到用户目录，再以 `LD_LIBRARY_PATH` 运行；
> E2E 文件会自动探测 `~/.local/playwright-libs`。
