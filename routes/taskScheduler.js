// routes/taskScheduler.js
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const schedule = require('node-schedule');

let pluginManager;
let webSocketServer;
let DEBUG_MODE = false;

const TIMED_CONTACTS_DIR = path.join(__dirname, '..', 'VCPTimedContacts');
const scheduledJobs = new Map();

async function executeTimedContact(task, filePath) {
    try {
        const scheduledTime = new Date(task.scheduledLocalTime);
        const formattedTime = `${scheduledTime.getFullYear()}-${(scheduledTime.getMonth() + 1).toString().padStart(2, '0')}-${scheduledTime.getDate().toString().padStart(2, '0')} ${scheduledTime.getHours().toString().padStart(2, '0')}:${scheduledTime.getMinutes().toString().padStart(2, '0')}:${scheduledTime.getSeconds().toString().padStart(2, '0')}`;

        if (!task.tool_call || !task.tool_call.tool_name || !task.tool_call.arguments) {
            console.error(`[TaskScheduler] 任务文件 ${path.basename(filePath)} 格式无效，缺少 'tool_call' 对象或其 'tool_name', 'arguments' 属性。`);
            webSocketServer.broadcast({
                type: 'vcp_log',
                data: {
                    tool_name: 'TaskScheduler',
                    status: 'error',
                    content: `执行定时任务 ${task.taskId} 失败: 无效的任务格式。`,
                    source: 'task_scheduler_executor_error'
                }
            }, 'VCPLog');
            return;
        }

        const { tool_name, arguments: toolArgs } = task.tool_call;

        if (tool_name === 'AgentAssistant' && toolArgs.prompt) {
            toolArgs.prompt = `[预定通讯: ${formattedTime}] ${toolArgs.prompt}`;
        }

        console.log(`[TaskScheduler] 正在执行任务 ${task.taskId}: 调用插件 '${tool_name}'...`);
        const result = await pluginManager.processToolCall(tool_name, toolArgs);

        console.log(`[TaskScheduler] 任务 ${task.taskId} (${tool_name}) 已处理。`);

        let resultSummary = `[无法从插件获取明确的回复内容]`;
        if (result) {
            resultSummary = typeof result === 'object' ? JSON.stringify(result) : String(result);
        }

        webSocketServer.broadcast({
            type: 'vcp_log',
            data: {
                tool_name: `${tool_name} (Timed)`,
                status: 'success',
                content: `定时任务 ${task.taskId} 已成功执行。\n插件响应: ${resultSummary.substring(0, 500)}`,
                source: 'task_scheduler_executor'
            }
        }, 'VCPLog');

    } catch (error) {
        console.error(`[TaskScheduler] 执行任务 ${task.taskId} 时发生错误:`, error);
        webSocketServer.broadcast({
            type: 'vcp_log',
            data: {
                tool_name: `${task.tool_call?.tool_name || 'UnknownPlugin'} (Timed)`,
                status: 'error',
                content: `执行定时任务 ${task.taskId} 失败: ${error.message || '未知错误'}`,
                details: error.stack || JSON.stringify(error),
                source: 'task_scheduler_executor_error'
            }
        }, 'VCPLog');
    } finally {
        // ── 循环任务处理 ──────────────────────────────────────────────────────
        // 若任务包含有效的 interval 字段（秒），则推进触发时间后写回文件，
        // fs.watch 感知变化后将重新调度，实现永久循环。删除文件即可终止循环。
        if (task.interval && typeof task.interval === 'number' && task.interval > 0) {
            try {
                const prevTime = new Date(task.scheduledLocalTime);
                const nextTime = new Date(prevTime.getTime() + task.interval * 1000);

                // 保留原始时区偏移（如 +08:00）
                const tzMatch = task.scheduledLocalTime.match(/([\+\-]\d{2}:\d{2})$/);
                const tzOffset = tzMatch ? tzMatch[1] : '+08:00';
                const sign = tzOffset[0] === '+' ? 1 : -1;
                const offsetMs = (parseInt(tzOffset.slice(1, 3)) * 60 + parseInt(tzOffset.slice(4, 6))) * 60000 * sign;

                const localTime = new Date(nextTime.getTime() + offsetMs);
                const pad = n => String(n).padStart(2, '0');
                const nextIso =
                    `${localTime.getUTCFullYear()}-${pad(localTime.getUTCMonth() + 1)}-${pad(localTime.getUTCDate())}` +
                    `T${pad(localTime.getUTCHours())}:${pad(localTime.getUTCMinutes())}:${pad(localTime.getUTCSeconds())}${tzOffset}`;

                task.scheduledLocalTime = nextIso;

                // 从 Map 中移除旧 Job，fs.watch 写回后会重新 scheduleTaskFromFile
                scheduledJobs.delete(task.taskId);

                await fs.writeFile(filePath, JSON.stringify(task, null, 2), 'utf-8');
                console.log(`[TaskScheduler] 循环任务 ${task.taskId} 已续命，下次触发: ${nextIso}`);

            } catch (rescheduleError) {
                console.error(`[TaskScheduler] 循环任务 ${task.taskId} 续命失败:`, rescheduleError);
                // 续命失败时降级删除，避免文件残留导致立即重复执行
                try { await fs.unlink(filePath); } catch (_) {}
            }
        } else {
            // ── 单次任务：执行完毕后删除文件 ──────────────────────────────────
            try {
                await fs.unlink(filePath);
                console.log(`[TaskScheduler] 已删除任务文件: ${path.basename(filePath)}`);
            } catch (unlinkError) {
                console.error(`[TaskScheduler] 删除任务文件 ${path.basename(filePath)} 失败:`, unlinkError);
            }
        }
    }
}

async function scheduleTaskFromFile(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const task = JSON.parse(content);
        if (!task.scheduledLocalTime || !task.taskId) {
            console.error(`[TaskScheduler] 任务文件 ${path.basename(filePath)} 格式错误，缺少 scheduledLocalTime 或 taskId。正在跳过...`);
            return;
        }

        if (scheduledJobs.has(task.taskId)) {
            if (DEBUG_MODE) console.log(`[TaskScheduler] 任务 ${task.taskId} 已被调度，跳过重复调度。`);
            return;
        }

        const scheduledTime = new Date(task.scheduledLocalTime);

        if (scheduledTime.getTime() <= Date.now()) {
            console.warn(`[TaskScheduler] 任务 ${task.taskId} (${path.basename(filePath)}) 已过期，立即执行...`);
            executeTimedContact(task, filePath);
        } else {
            const job = schedule.scheduleJob(scheduledTime, () => {
                console.log(`[TaskScheduler] 正在执行定时任务: ${task.taskId}`);
                executeTimedContact(task, filePath);
                scheduledJobs.delete(task.taskId);
            });

            scheduledJobs.set(task.taskId, job);
            console.log(`[TaskScheduler] 已调度任务 ${task.taskId} 在 ${scheduledTime.toLocaleString()} 执行。`);
        }
    } catch (e) {
        if (e.code !== 'ENOENT') {
            console.error(`[TaskScheduler] 处理任务文件 ${path.basename(filePath)} 失败:`, e);
        }
    }
}

function startTimedContactWatcher() {
    console.log(`[TaskScheduler] 启动目录监视: ${TIMED_CONTACTS_DIR}`);
    try {
        fsSync.watch(TIMED_CONTACTS_DIR, (eventType, filename) => {
            if (filename && filename.endsWith('.json')) {
                const filePath = path.join(TIMED_CONTACTS_DIR, filename);
                const taskId = filename.replace('.json', '');

                fs.access(filePath, fsSync.constants.F_OK)
                  .then(() => {
                      if (DEBUG_MODE) console.log(`[TaskScheduler] 监视器发现文件新增/变更: ${filename}。尝试调度...`);
                      scheduleTaskFromFile(filePath);
                  })
                  .catch(() => {
                      if (scheduledJobs.has(taskId)) {
                          console.log(`[TaskScheduler] 监视器发现文件删除: ${filename}。取消已调度的任务。`);
                          const job = scheduledJobs.get(taskId);
                          if (job) {
                              job.cancel();
                          }
                          scheduledJobs.delete(taskId);
                      }
                  });
            }
        });
    } catch (error) {
        console.error(`[TaskScheduler] 启动目录监视失败 ${TIMED_CONTACTS_DIR}:`, error);
    }
}

async function scheduleAllPendingTasks() {
    try {
        await fs.mkdir(TIMED_CONTACTS_DIR, { recursive: true });
        const files = await fs.readdir(TIMED_CONTACTS_DIR);
        const jsonFiles = files.filter(f => f.endsWith('.json'));

        if (jsonFiles.length > 0) {
            console.log(`[TaskScheduler] 发现 ${jsonFiles.length} 个待处理的定时任务，开始调度...`);
            for (const file of jsonFiles) {
                const filePath = path.join(TIMED_CONTACTS_DIR, file);
                await scheduleTaskFromFile(filePath);
            }
        } else {
            console.log(`[TaskScheduler] 未发现待处理的定时任务。调度器将保持待命。`);
        }
    } catch (error) {
        console.error('[TaskScheduler] 初始化定时任务调度器失败:', error);
    }
}

function initialize(_pluginManager, _webSocketServer, _debugMode) {
    pluginManager = _pluginManager;
    webSocketServer = _webSocketServer;
    DEBUG_MODE = _debugMode;

    console.log('正在初始化通用任务调度器...');
    scheduleAllPendingTasks();
    startTimedContactWatcher();
    console.log('通用任务调度器已初始化并开始监视任务。');
}

function shutdown() {
    if (scheduledJobs.size > 0) {
        console.log(`[TaskScheduler] 正在清除 ${scheduledJobs.size} 个已调度的任务...`);
        for (const [taskId, job] of scheduledJobs.entries()) {
            if (job) {
                job.cancel();
                console.log(`  - 已取消任务ID: ${taskId}`);
            }
        }
        scheduledJobs.clear();
    }
}

module.exports = {
    initialize,
    shutdown
};