'use strict';

const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// ── 路径配置（优先读取 config.env 注入的环境变量）────────────────────────────
// TASK_DIR 支持绝对路径或相对于 __dirname 的相对路径
const TASK_DIR_RAW = process.env.TASK_DIR || '../../VCPTimedContacts';
const TASK_DIR = path.isAbsolute(TASK_DIR_RAW)
  ? TASK_DIR_RAW
  : path.resolve(__dirname, TASK_DIR_RAW);
const DEBUG = process.env.DEBUG_MODE === 'true';

// ── 基础工具 ──────────────────────────────────────────────────────────────────

function log(...args) {
  if (DEBUG) process.stderr.write('[TSM] ' + args.join(' ') + '\n');
}

function respond(status, result) {
  process.stdout.write(JSON.stringify({ status, result }) + '\n');
  process.exit(status === 'success' ? 0 : 1);
}

function ensureDir() {
  if (!fs.existsSync(TASK_DIR)) fs.mkdirSync(TASK_DIR, { recursive: true });
}

function normalizeTime(raw) {
  const s = raw.trim();
  if (s.includes('T')) return s;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2}):(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+08:00`;
  throw new Error(`无法识别的时间格式: "${raw}"。请使用 ISO 8601 或 YYYY-MM-DD-HH:mm`);
}

function findTaskFile(taskId) {
  ensureDir();
  for (const f of fs.readdirSync(TASK_DIR).filter(f => f.endsWith('.json'))) {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(TASK_DIR, f), 'utf-8'));
      if (obj.taskId === taskId) return path.join(TASK_DIR, f);
    } catch (_) {}
  }
  return null;
}

function readAllTasks() {
  ensureDir();
  const tasks = [];
  for (const f of fs.readdirSync(TASK_DIR).filter(f => f.endsWith('.json'))) {
    try {
      tasks.push(JSON.parse(fs.readFileSync(path.join(TASK_DIR, f), 'utf-8')));
    } catch (_) {}
  }
  return tasks;
}

function parseArguments(raw) {
  if (typeof raw === 'object' && raw !== null) return raw;
  return JSON.parse(String(raw).trim());
}

function rescheduleLoop(task, filePath) {
  const interval = task.interval;
  const prev = new Date(task.scheduledLocalTime);
  const next = new Date(prev.getTime() + interval * 1000);

  const offset = task.scheduledLocalTime.match(/([\+\-]\d{2}:\d{2})$/)?.[1] ?? '+08:00';
  const pad = n => String(n).padStart(2, '0');
  const tzOffset = (offset === '+08:00' ? 8 : 0) * 60;
  const localMs  = next.getTime() + tzOffset * 60000 - next.getTimezoneOffset() * 60000;
  const d        = new Date(localMs);
  const iso = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}` +
              `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${offset}`;

  task.scheduledLocalTime = iso;
  fs.writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf-8');
  log('Loop rescheduled:', task.taskId, '→', iso);
}

// ── 指令处理器 ────────────────────────────────────────────────────────────────

function handleCreate(args) {
  ensureDir();

  const taskId   = (args.task_id          || '').trim() || randomUUID();
  const rawTime  = (args.scheduled_time   || '').trim();
  const toolName = (args.tool_name_target || '').trim();
  const rawArg   = args.arguments;
  const interval = args.interval ? parseInt(args.interval, 10) : null;

  if (!rawTime)  return respond('error', '缺少必需参数: scheduled_time');
  if (!toolName) return respond('error', '缺少必需参数: tool_name_target');
  if (rawArg === undefined || rawArg === null || rawArg === '')
    return respond('error', '缺少必需参数: arguments');
  if (interval !== null && (isNaN(interval) || interval <= 0))
    return respond('error', 'interval 必须是正整数（单位：秒）');

  if (findTaskFile(taskId))
    return respond('error', `任务 ID "${taskId}" 已存在，请先删除或使用 EditTask 编辑。`);

  let scheduledLocalTime;
  try { scheduledLocalTime = normalizeTime(rawTime); }
  catch (e) { return respond('error', e.message); }

  let parsedArgs;
  try { parsedArgs = parseArguments(rawArg); }
  catch (e) { return respond('error', `arguments 不是合法 JSON: ${e.message}`); }

  const task = {
    taskId,
    scheduledLocalTime,
    ...(interval ? { interval } : {}),
    tool_call: { tool_name: toolName, arguments: parsedArgs }
  };

  fs.writeFileSync(path.join(TASK_DIR, `${taskId}.json`), JSON.stringify(task, null, 2), 'utf-8');
  log('Created:', taskId, '@', scheduledLocalTime, interval ? `loop:${interval}s` : '');

  return respond('success',
    `✅ 任务创建成功！\n` +
    `  任务ID   : ${taskId}\n` +
    `  触发时间 : ${scheduledLocalTime}\n` +
    `  目标插件 : ${toolName}\n` +
    `  参数     : ${JSON.stringify(parsedArgs)}\n` +
    (interval ? `  循环间隔 : ${interval} 秒（♾️ 自动续命）\n` : '') +
    `  任务目录 : ${TASK_DIR}\n` +
    `TaskScheduler 已通过 fs.watch 感知，将在指定时间自动触发。`
  );
}

function handleEdit(args) {
  const taskId = (args.task_id || '').trim();
  if (!taskId) return respond('error', '缺少必需参数: task_id');

  const fp = findTaskFile(taskId);
  if (!fp) return respond('error', `未找到任务 ID: "${taskId}"，请先用 ListTasks 确认。`);

  let task;
  try { task = JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  catch (e) { return respond('error', `读取任务文件失败: ${e.message}`); }

  const changed = [];

  if (args.scheduled_time) {
    try {
      task.scheduledLocalTime = normalizeTime(args.scheduled_time.trim());
      changed.push(`触发时间 → ${task.scheduledLocalTime}`);
    } catch (e) { return respond('error', e.message); }
  }

  if (args.tool_name_target) {
    task.tool_call.tool_name = args.tool_name_target.trim();
    changed.push(`目标插件 → ${task.tool_call.tool_name}`);
  }

  if (args.arguments !== undefined) {
    try {
      task.tool_call.arguments = parseArguments(args.arguments);
      changed.push(`参数 → ${JSON.stringify(task.tool_call.arguments)}`);
    } catch (e) { return respond('error', `arguments 不是合法 JSON: ${e.message}`); }
  }

  if (args.interval !== undefined) {
    if (args.interval === '' || args.interval === null || args.interval === '0') {
      delete task.interval;
      changed.push('循环间隔 → 已移除（改为单次任务）');
    } else {
      const iv = parseInt(args.interval, 10);
      if (isNaN(iv) || iv <= 0) return respond('error', 'interval 必须是正整数（单位：秒）');
      task.interval = iv;
      changed.push(`循环间隔 → ${iv} 秒`);
    }
  }

  if (changed.length === 0)
    return respond('error', '未提供任何修改字段（scheduled_time / tool_name_target / arguments / interval）');

  fs.writeFileSync(fp, JSON.stringify(task, null, 2), 'utf-8');
  log('Edited:', taskId);

  return respond('success',
    `✅ 任务编辑成功！\n  任务ID: ${taskId}\n  修改项:\n` +
    changed.map(c => `    · ${c}`).join('\n') +
    '\n\nTaskScheduler 将自动重新调度。'
  );
}

function handleDelete(args) {
  const raw = (args.task_id || '').trim();
  if (!raw) return respond('error', '缺少必需参数: task_id');

  const results = raw
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(id => {
      const fp = findTaskFile(id);
      if (!fp) return `❌ ${id}: 未找到`;
      try { fs.unlinkSync(fp); log('Deleted:', id); return `✅ ${id}: 已删除`; }
      catch (e) { return `❌ ${id}: 删除失败 (${e.message})`; }
    });

  const allOk = results.every(r => r.startsWith('✅'));
  return respond(allOk ? 'success' : 'error',
    `批量删除结果（共 ${results.length} 个）:\n` + results.join('\n')
  );
}

function handleList() {
  const tasks = readAllTasks();
  if (tasks.length === 0)
    return respond('success', `📭 当前没有任何待执行的定时任务。\n  任务目录: ${TASK_DIR}`);

  tasks.sort((a, b) => new Date(a.scheduledLocalTime) - new Date(b.scheduledLocalTime));
  const now = new Date();

  const lines = tasks.map((t, i) => {
    const trigger = new Date(t.scheduledLocalTime);
    const status  = trigger < now ? '⚠️  已过期/待立即执行' : '⏳ 等待触发';
    const loopTag = t.interval ? ` ♾️ 循环(${t.interval}s)` : '';
    return (
      `[${i + 1}] ${status}${loopTag}\n` +
      `    ID     : ${t.taskId}\n` +
      `    时间   : ${t.scheduledLocalTime}\n` +
      `    插件   : ${t.tool_call?.tool_name ?? '(未知)'}\n` +
      `    参数   : ${JSON.stringify(t.tool_call?.arguments ?? {})}`
    );
  });

  return respond('success',
    `📋 定时任务列表（共 ${tasks.length} 个，目录: ${TASK_DIR}）:\n\n` + lines.join('\n\n')
  );
}

function handleReschedule(args) {
  const taskId = (args.task_id || '').trim();
  if (!taskId) return respond('error', '缺少必需参数: task_id');

  const fp = findTaskFile(taskId);
  if (!fp) return respond('error', `未找到任务 ID: "${taskId}"`);

  let task;
  try { task = JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  catch (e) { return respond('error', `读取失败: ${e.message}`); }

  if (!task.interval)
    return respond('error', `任务 "${taskId}" 没有设置 interval，不是循环任务。`);

  try { rescheduleLoop(task, fp); }
  catch (e) { return respond('error', `续命失败: ${e.message}`); }

  return respond('success',
    `♾️ 循环任务已续命！\n  任务ID : ${taskId}\n  下次触发: ${task.scheduledLocalTime}\n  间隔   : ${task.interval} 秒`
  );
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) raw += chunk;

  let args;
  try { args = JSON.parse(raw.trim()); }
  catch (e) { return respond('error', `入参 JSON 解析失败: ${e.message}`); }

  log('command:', args.command, '| TASK_DIR:', TASK_DIR);

  switch ((args.command || '').trim()) {
    case 'CreateTask':     return handleCreate(args);
    case 'EditTask':       return handleEdit(args);
    case 'DeleteTask':     return handleDelete(args);
    case 'ListTasks':      return handleList();
    case 'RescheduleLoop': return handleReschedule(args);
    default:
      return respond('error',
        `未知指令: "${args.command}"。支持: CreateTask | EditTask | DeleteTask | ListTasks | RescheduleLoop`
      );
  }
}

main().catch(e => {
  process.stdout.write(
    JSON.stringify({ status: 'error', result: `未捕获异常: ${e.message}` }) + '\n'
  );
  process.exit(1);
});