# TaskSchedulerManager 开发日志

## v1.1.0 (2026-02-27)

### 新增
- `interval` 字段支持：在 `CreateTask` / `EditTask` 中加入可选的 `interval` 参数（单位：秒）
- 循环任务原生续命：`routes/taskScheduler.js` 的 `finally` 块中加入 interval 分支判断，执行完毕后自动将 `scheduledLocalTime` 推进一个 interval 并写回文件，由 `fs.watch` 重新调度，实现永久循环
- `RescheduleLoop` 指令：手动触发循环任务续命，可修复异常中断的循环
- `ListTasks` 增强：循环任务标注 `♾️ 循环(Ns)` 标签
- `EditTask` 支持通过传入空字符串或 0 移除 interval，将循环任务降级为单次任务

### 修改（routes/taskScheduler.js）
- `executeTimedContact()` 的 `finally` 块改为分支逻辑：
  - 有 `interval`：推进时间写回文件 → fs.watch 重新调度
  - 无 `interval`：原逻辑 `fs.unlink` 删除文件
  - 续命失败时降级 unlink，防止文件残留导致立即重复执行

### 已知问题
- 极端时序竞争：若 DeleteTask 与续命写回恰好同时发生，新文件会被写回后被 fs.watch 重新调度，需再执行一次 DeleteTask 即可彻底清除
- 后续可在续命写回前加入文件存在性检查（`fs.access`）以彻底消除竞争窗口

---

## v1.0.0 (2026-02-27)

### 初始发布
- `CreateTask`：创建定时任务，支持 ISO 8601 / YYYY-MM-DD-HH:mm 两种时间格式，task_id 可选（默认生成 UUID），task_id 去重校验
- `EditTask`：按 task_id 定位并原地覆写文件，触发 fs.watch change 事件使 TaskScheduler 自动重新调度
- `DeleteTask`：支持逗号分隔批量删除，删文件触发 fs.watch 使 TaskScheduler 自动取消 Job
- `ListTasks`：按触发时间升序列出所有任务，标注过期/等待状态

### 设计说明
- pluginType: synchronous，Node.js 原生实现，stdio 通信
- TASK_DIR 指向 `../../VCPTimedContacts`（与 server.js 同级）
- 基于「文件即任务」架构，与 taskScheduler.js 解耦，任何能写文件的模块均可派发任务
- arguments 字段兼容对象和字符串两种入参形式
## v1.1.1 (2026-02-27)

### 修复
- plugin-manifest.json：为全部 5 条指令补全完整的 VCP 调用格式示例（<<<[TOOL_REQUEST]>>> 块 + 字段名 + 「始」## v1.1.2 (2026-02-27)

### 修复
- plugin-manifest.json：调用示例中的 <<<[TOOL_REQUEST]>>> 标签和「始」## v1.1.3 (2026-02-27)

### 新增
- config.env：新增 TASK_DIR 配置项，支持绝对路径或相对于插件目录的相对路径
- config.env.example：新增默认配置示例文件，含 Linux/Windows/相对路径三种写法说明
- TaskSchedulerManager.js：TASK_DIR 改为优先读取环境变量 process.env.TASK_DIR，通过 path.isAbsolute() 自动判断绝对/相对路径，fallback 到 ../../VCPTimedContacts
- ListTasks / CreateTask 返回信息中新增当前 TASK_DIR 路径，方便调试确认