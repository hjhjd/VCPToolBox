#!/usr/bin/env node
'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// ============================================================
// GitOperator - 基于配置档驱动的 VCP Git 仓库管理器
// ============================================================

const REPOS_JSON_PATH = path.resolve(__dirname, 'repos.json');

// --------------- 工具函数: 加载 config.env ---------------
function loadEnvConfig() {
  const envPath = path.resolve(__dirname, 'config.env');
  const result = {};
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      result[key] = value;
    }
  } catch (e) { /* config.env 为可选文件 */ }
  return result;
}

// --------------- 工具函数: 加载 repos.json ---------------
function loadRepos() {
  try {
    const raw = fs.readFileSync(REPOS_JSON_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`加载 repos.json 失败: ${e.message}`);
  }
}

// --------------- 工具函数: 保存 repos.json ---------------
function saveRepos(data) {
  fs.writeFileSync(REPOS_JSON_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// --------------- 工具函数: 解析配置档 ---------------
function resolveProfile(repos, profileName) {
  const name = profileName || repos.defaultProfile;
  if (!name) throw new Error('未指定 profile 且 repos.json 中未配置 defaultProfile。');
  const profile = repos.profiles && repos.profiles[name];
  if (!profile) throw new Error(`在 repos.json 中找不到 Profile "${name}"。可用的 Profile: ${Object.keys(repos.profiles || {}).join(', ')}`);
  return { name, profile };
}

// --------------- 工具函数: 路径白名单校验 ---------------
function buildAllowedPaths(envConfig) {
  const raw = envConfig.PLUGIN_WORK_PATHS || process.env.PLUGIN_WORK_PATHS || '../../';
  return raw.split(',').map(p => path.resolve(__dirname, p.trim()));
}

function validatePath(localPath, allowedPaths) {
  const resolved = path.resolve(localPath);
  const isAllowed = allowedPaths.some(allowed => resolved.startsWith(allowed));
  if (!isAllowed) {
    throw new Error(`路径不在 PLUGIN_WORK_PATHS 白名单内: ${resolved}`);
  }
  return resolved;
}

// --------------- 工具函数: 输出脱敏 (Token 遮蔽) ---------------
function sanitizeOutput(text, profile) {
  if (!text || !profile) return text;
  const token = profile.credentials && profile.credentials.token;
  if (token && token.length > 4) {
    return text.split(token).join('***');
  }
  return text;
}

// --------------- 工具函数: 执行 git 命令 ---------------
function execGit(args, cwd, timeout = 25000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
      if (error) {
        const msg = stderr.trim() || stdout.trim() || error.message;
        const err = new Error(msg);
        err.exitCode = error.code;
        reject(err);
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}

// --------------- ensureRemotes: 自动校准远程仓库 URL ---------------
async function ensureRemotes(profile, cwd) {
  const steps = [];

  const { stdout: remoteRaw } = await execGit(['remote', '-v'], cwd);
  const remotes = {};
  for (const line of remoteRaw.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
    if (match) {
      if (!remotes[match[1]]) remotes[match[1]] = {};
      remotes[match[1]][match[3]] = match[2];
    }
  }

  if (profile.push && profile.push.url) {
    const rName = profile.push.remote || 'origin';
    if (!remotes[rName]) {
      await execGit(['remote', 'add', rName, profile.push.url], cwd);
      steps.push(`已添加远程仓库 "${rName}" -> ${profile.push.url}`);
    } else if (remotes[rName].push !== profile.push.url) {
      await execGit(['remote', 'set-url', rName, profile.push.url], cwd);
      steps.push(`已更新远程仓库 "${rName}" 的推送 URL -> ${profile.push.url}`);
    }
  }

  if (profile.pull && profile.pull.url) {
    const rName = profile.pull.remote || 'upstream';
    if (!remotes[rName]) {
      await execGit(['remote', 'add', rName, profile.pull.url], cwd);
      steps.push(`已添加远程仓库 "${rName}" -> ${profile.pull.url}`);
    } else if (remotes[rName].fetch !== profile.pull.url) {
      await execGit(['remote', 'set-url', rName, profile.pull.url], cwd);
      steps.push(`已更新远程仓库 "${rName}" 的拉取 URL -> ${profile.pull.url}`);
    }
  }

  if (profile.credentials) {
    if (profile.credentials.email) {
      await execGit(['config', 'user.email', profile.credentials.email], cwd);
    }
    if (profile.credentials.username) {
      await execGit(['config', 'user.name', profile.credentials.username], cwd);
    }
  }

  return steps;
}

// ============================================================
// 指令处理函数
// ============================================================

async function cmdStatus(profile, cwd) {
  const { stdout } = await execGit(['status', '--short', '--branch'], cwd);
  return { status: 'success', command: 'Status', result: stdout || '(工作区干净)' };
}

async function cmdLog(profile, cwd, args) {
  const maxCount = parseInt(args.maxCount) || 20;
  const branch = args.branch || '';
  const gitArgs = ['log', `--max-count=${maxCount}`, '--format={"hash":"%H","shortHash":"%h","author":"%an","date":"%aI","message":"%s"},'];
  if (branch) gitArgs.push(branch);

  const { stdout } = await execGit(gitArgs, cwd);

  const commits = [];
  const lines = stdout.split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const clean = line.endsWith(',') ? line.slice(0, -1) : line;
      commits.push(JSON.parse(clean));
    } catch (e) { /* 跳过格式错误的行 */ }
  }

  return {
    status: 'success',
    command: 'Log',
    totalCount: commits.length,
    showing: Math.min(maxCount, commits.length),
    commits
  };
}

async function cmdDiff(profile, cwd, args) {
  const maxLines = parseInt(args.maxLines) || 200;
  const target = args.target || '';
  const gitArgs = ['diff'];
  if (target) gitArgs.push(target);

  const { stdout } = await execGit(gitArgs, cwd);

  const lines = stdout.split('\n');
  const truncated = lines.length > maxLines;
  const output = truncated
    ? lines.slice(0, maxLines).join('\n') + `\n\n[已截断, 还有 ${lines.length - maxLines} 行未显示]`
    : stdout;

  return { status: 'success', command: 'Diff', result: output || '(无差异)' };
}

async function cmdBranchList(profile, cwd) {
  const { stdout } = await execGit(['branch', '-a', '-v'], cwd);
  return { status: 'success', command: 'BranchList', result: stdout };
}

async function cmdRemoteInfo(profile, cwd) {
  const { stdout } = await execGit(['remote', '-v'], cwd);
  return { status: 'success', command: 'RemoteInfo', result: stdout || '(未配置远程仓库)' };
}

async function cmdStashList(profile, cwd) {
  const { stdout } = await execGit(['stash', 'list'], cwd);
  return { status: 'success', command: 'StashList', result: stdout || '(无暂存记录)' };
}

async function cmdTagList(profile, cwd) {
  const { stdout } = await execGit(['tag', '-l', '--sort=-creatordate'], cwd);
  return { status: 'success', command: 'TagList', result: stdout || '(无标签)' };
}

function cmdProfileList(repos) {
  const profiles = repos.profiles || {};
  const list = Object.entries(profiles).map(([name, p]) => ({
    name,
    localPath: p.localPath,
    pushRemote: p.push ? `${p.push.remote || 'origin'} -> ${p.push.url}` : '(未配置)',
    pullRemote: p.pull ? `${p.pull.remote || 'upstream'} -> ${p.pull.url}` : '(未配置)',
    mergeStrategy: p.mergeStrategy || 'merge',
    isDefault: name === repos.defaultProfile
  }));
  return { status: 'success', command: 'ProfileList', profiles: list };
}

async function cmdAdd(profile, cwd, args) {
  const files = args.files;
  if (!files) throw new Error('Add 指令需要 "files" 参数。使用 "." 暂存全部文件。');
  const fileList = files.split(/\s+/).filter(f => f);
  await execGit(['add', ...fileList], cwd);
  return { status: 'success', command: 'Add', result: `已暂存: ${fileList.join(', ')}` };
}

async function cmdCommit(profile, cwd, args) {
  const message = args.message;
  if (!message) throw new Error('Commit 指令需要 "message" 参数。');
  const { stdout } = await execGit(['commit', '-m', message], cwd);
  return { status: 'success', command: 'Commit', result: stdout };
}

// ============================================================
// 阶段 2: 远程协作 & 凭证注入
// ============================================================

function injectCredentials(url, credentials) {
  if (!url || !credentials || !credentials.token) return url;
  try {
    const parsed = new URL(url);
    parsed.username = credentials.username || credentials.email || 'git';
    parsed.password = credentials.token;
    return parsed.toString();
  } catch (e) {
    return url;
  }
}

function resolveSourceRemote(profile, source, defaultType) {
  const type = source || defaultType;
  if (type === 'push') {
    return {
      remote: (profile.push && profile.push.remote) || 'origin',
      branch: (profile.push && profile.push.branch) || 'main',
      url: profile.push && profile.push.url
    };
  }
  return {
    remote: (profile.pull && profile.pull.remote) || 'upstream',
    branch: (profile.pull && profile.pull.branch) || 'main',
    url: profile.pull && profile.pull.url
  };
}

async function cmdPull(profile, cwd, args) {
  const steps = [];
  const src = resolveSourceRemote(profile, args.source, 'pull');

  steps.push(`正在从 ${src.remote}/${src.branch} 拉取...`);
  const { stdout, stderr } = await execGit(['pull', src.remote, src.branch], cwd);
  const output = (stdout + '\n' + stderr).trim();
  steps.push(output || '(已是最新)');

  return {
    status: 'success',
    command: 'Pull',
    steps,
    summary: `从 ${src.remote}/${src.branch} 拉取完成。`
  };
}

async function cmdPush(profile, cwd, args) {
  const steps = [];
  const pushRemote = (profile.push && profile.push.remote) || 'origin';
  const pushBranch = (profile.push && profile.push.branch) || 'main';
  const pushUrl = profile.push && profile.push.url;

  if (!pushUrl) throw new Error('Profile 中未配置推送 URL。');

  const authUrl = injectCredentials(pushUrl, profile.credentials);
  steps.push(`正在推送到 ${pushRemote}/${pushBranch}...`);

  const { stdout, stderr } = await execGit(['push', authUrl, pushBranch], cwd);
  const output = (stdout + '\n' + stderr).trim();
  steps.push(output || '(推送完成)');

  return {
    status: 'success',
    command: 'Push',
    steps,
    summary: `推送到 ${pushRemote}/${pushBranch} 完成。`
  };
}

async function cmdFetch(profile, cwd, args) {
  const steps = [];
  const src = resolveSourceRemote(profile, args.source, 'pull');

  steps.push(`正在从 ${src.remote} 获取...`);
  const { stdout, stderr } = await execGit(['fetch', src.remote], cwd);
  const output = (stdout + '\n' + stderr).trim();
  steps.push(output || '(无新对象)');

  return {
    status: 'success',
    command: 'Fetch',
    steps,
    summary: `从 ${src.remote} 获取完成。`
  };
}

async function cmdSyncUpstream(profile, cwd, args) {
  const steps = [];
  const pullRemote = (profile.pull && profile.pull.remote) || 'upstream';
  const pullBranch = (profile.pull && profile.pull.branch) || 'main';
  const pushRemote = (profile.push && profile.push.remote) || 'origin';
  const pushBranch = (profile.push && profile.push.branch) || 'main';
  const pushUrl = profile.push && profile.push.url;
  const strategy = profile.mergeStrategy || 'merge';

  steps.push(`[1/6] 正在获取 ${pullRemote}...`);
  const fetchResult = await execGit(['fetch', pullRemote], cwd);
  steps.push((fetchResult.stdout + '\n' + fetchResult.stderr).trim() || '(已获取)');

  steps.push(`[2/6] 检查工作区状态...`);
  const { stdout: statusOut } = await execGit(['status', '--porcelain'], cwd);
  let stashed = false;
  if (statusOut.trim()) {
    steps.push('检测到未提交的更改，正在暂存...');
    await execGit(['stash', 'push', '-m', 'GitOperator-SyncUpstream-自动暂存'], cwd);
    stashed = true;
    steps.push('更改已成功暂存。');
  } else {
    steps.push('工作区干净。');
  }

  let conflictDetected = false;
  const mergeTarget = `${pullRemote}/${pullBranch}`;
  try {
    if (strategy === 'rebase') {
      steps.push(`[3/6] 正在变基到 ${mergeTarget}...`);
      const { stdout: rbOut } = await execGit(['rebase', mergeTarget], cwd);
      steps.push(rbOut || '(变基完成)');
    } else {
      steps.push(`[3/6] 正在合并 ${mergeTarget}...`);
      const { stdout: mgOut } = await execGit(['merge', mergeTarget], cwd);
      steps.push(mgOut || '(合并完成)');
    }
  } catch (mergeError) {
    const { stdout: conflictStatus } = await execGit(['status', '--porcelain'], cwd);
    const conflictFiles = conflictStatus.split('\n')
      .filter(l => l.startsWith('UU') || l.startsWith('AA') || l.startsWith('DU') || l.startsWith('UD'))
      .map(l => l.substring(3).trim());

    if (conflictFiles.length > 0) {
      conflictDetected = true;
      try {
        if (strategy === 'rebase') {
          await execGit(['rebase', '--abort'], cwd);
        } else {
          await execGit(['merge', '--abort'], cwd);
        }
      } catch (abortErr) { /* 尽力而为 */ }

      if (stashed) {
        try { await execGit(['stash', 'pop'], cwd); } catch (e) { /* 尽力而为 */ }
      }

      return {
        status: 'conflict',
        command: 'SyncUpstream',
        steps,
        conflictFiles,
        hint: `在 ${conflictFiles.length} 个文件中检测到冲突。请手动解决后重新执行 SyncUpstream。`,
        stashSaved: stashed
      };
    }
    throw mergeError;
  }

  if (stashed) {
    steps.push(`[4/6] 正在恢复暂存的更改...`);
    try {
      await execGit(['stash', 'pop'], cwd);
      steps.push('暂存已恢复。');
    } catch (stashErr) {
      steps.push(`警告: stash pop 失败 (${stashErr.message})。您的更改仍保存在 stash 中。`);
    }
  } else {
    steps.push(`[4/6] 无需恢复暂存。`);
  }

  if (pushUrl) {
    steps.push(`[5/6] 正在推送到 ${pushRemote}/${pushBranch}...`);
    const authUrl = injectCredentials(pushUrl, profile.credentials);
    const { stdout: pushOut, stderr: pushErr } = await execGit(['push', authUrl, pushBranch], cwd);
    steps.push((pushOut + '\n' + pushErr).trim() || '(已推送)');
  } else {
    steps.push(`[5/6] 未配置推送 URL，跳过推送。`);
  }

  steps.push(`[6/6] 同步完成！(策略: ${strategy})`);

  return {
    status: 'success',
    command: 'SyncUpstream',
    steps,
    summary: `已通过 ${strategy} 策略完成同步: ${pullRemote}/${pullBranch} -> 本地 -> ${pushRemote}/${pushBranch}。`
  };
}

async function cmdClone(profile, cwd, args) {
  const url = args.url;
  const localPath = args.localPath;
  if (!url) throw new Error('Clone 指令需要 "url" 参数。');
  if (!localPath) throw new Error('Clone 指令需要 "localPath" 参数。');

  const envConfig = loadEnvConfig();
  const allowedPaths = buildAllowedPaths(envConfig);
  const resolvedClonePath = path.resolve(localPath);
  const isAllowed = allowedPaths.some(allowed => resolvedClonePath.startsWith(allowed));
  if (!isAllowed) {
    throw new Error(`克隆目标路径不在 PLUGIN_WORK_PATHS 白名单内: ${resolvedClonePath}`);
  }

  const steps = [];
  steps.push(`正在克隆 ${url} -> ${resolvedClonePath}...`);

  const parentDir = path.dirname(resolvedClonePath);
  const { stdout, stderr } = await execGit(['clone', url, resolvedClonePath], parentDir, 60000);
  steps.push((stdout + '\n' + stderr).trim() || '(克隆完成)');

  return {
    status: 'success',
    command: 'Clone',
    steps,
    summary: `已将 ${url} 克隆到 ${localPath}。`
  };
}

// ============================================================
// 阶段 3: 分支管理
// ============================================================

async function cmdBranchCreate(profile, cwd, args) {
  const branchName = args.branchName;
  if (!branchName) throw new Error('BranchCreate 指令需要 "branchName" 参数。');
  const startPoint = args.startPoint;

  const gitArgs = ['checkout', '-b', branchName];
  if (startPoint) gitArgs.push(startPoint);

  const { stdout, stderr } = await execGit(gitArgs, cwd);
  const output = (stdout + '\n' + stderr).trim();

  return {
    status: 'success',
    command: 'BranchCreate',
    result: output || `分支 "${branchName}" 已创建并切换。`,
    summary: `已创建分支 "${branchName}"${startPoint ? `（起点: ${startPoint}）` : ''}。`
  };
}

async function cmdCheckout(profile, cwd, args) {
  const branch = args.branch;
  if (!branch) throw new Error('Checkout 指令需要 "branch" 参数。');

  const { stdout, stderr } = await execGit(['checkout', branch], cwd);
  const output = (stdout + '\n' + stderr).trim();

  return {
    status: 'success',
    command: 'Checkout',
    result: output || `已切换到分支 "${branch}"。`
  };
}

async function cmdMerge(profile, cwd, args) {
  const branch = args.branch;
  if (!branch) throw new Error('Merge 指令需要 "branch" 参数。');

  const steps = [];
  steps.push(`正在将分支 "${branch}" 合并到当前分支...`);

  try {
    const { stdout } = await execGit(['merge', branch], cwd);
    steps.push(stdout || '(合并完成)');

    return {
      status: 'success',
      command: 'Merge',
      steps,
      summary: `成功合并 "${branch}"。`
    };
  } catch (mergeError) {
    const { stdout: conflictStatus } = await execGit(['status', '--porcelain'], cwd);
    const conflictFiles = conflictStatus.split('\n')
      .filter(l => l.startsWith('UU') || l.startsWith('AA') || l.startsWith('DU') || l.startsWith('UD'))
      .map(l => l.substring(3).trim());

    if (conflictFiles.length > 0) {
      try { await execGit(['merge', '--abort'], cwd); } catch (e) { /* 尽力而为 */ }

      return {
        status: 'conflict',
        command: 'Merge',
        steps,
        conflictFiles,
        hint: `合并 "${branch}" 时在 ${conflictFiles.length} 个文件中检测到冲突。合并已中止。请手动解决冲突或选择其他策略。`
      };
    }
    throw mergeError;
  }
}

// ============================================================
// 阶段 4: 危险操作 (需要 Auth 验证)
// ============================================================

const DANGEROUS_COMMANDS = new Set(['ForcePush', 'ResetHard', 'BranchDelete', 'Rebase', 'CherryPick']);

function requireAuth(cmdName, args) {
  const authCode = args.authCode || args.requireAdmin;
  const expectedCode = process.env.DECRYPTED_AUTH_CODE;
  if (!expectedCode) {
    throw new Error(`[认证拦截] "${cmdName}" 需要 Auth 验证，但环境变量 DECRYPTED_AUTH_CODE 未设置。此危险操作无法执行。`);
  }
  if (!authCode) {
    throw new Error(`[需要认证] "${cmdName}" 是危险操作。请提供 "authCode" 参数并填入有效的 6 位验证码。`);
  }
  if (String(authCode).trim() !== String(expectedCode).trim()) {
    throw new Error(`[认证失败] "${cmdName}" 的验证码错误。访问被拒绝。`);
  }
}

async function cmdForcePush(profile, cwd, args) {
  requireAuth('ForcePush', args);

  const steps = [];
  const pushRemote = (profile.push && profile.push.remote) || 'origin';
  const pushBranch = args.branch || (profile.push && profile.push.branch) || 'main';
  const pushUrl = profile.push && profile.push.url;

  if (!pushUrl) throw new Error('Profile 中未配置推送 URL。');

  const authUrl = injectCredentials(pushUrl, profile.credentials);
  steps.push(`⚠️ 正在强制推送到 ${pushRemote}/${pushBranch}...`);

  const { stdout, stderr } = await execGit(['push', '--force', authUrl, pushBranch], cwd);
  const output = (stdout + '\n' + stderr).trim();
  steps.push(output || '(强制推送完成)');

  return {
    status: 'success',
    command: 'ForcePush',
    steps,
    warning: '远程仓库历史已被覆盖！',
    summary: `已强制推送到 ${pushRemote}/${pushBranch}。`
  };
}

async function cmdResetHard(profile, cwd, args) {
  requireAuth('ResetHard', args);

  const target = args.target || 'HEAD';
  const steps = [];

  const { stdout: currentHead } = await execGit(['rev-parse', '--short', 'HEAD'], cwd);
  steps.push(`⚠️ 当前 HEAD: ${currentHead}`);
  steps.push(`正在硬重置到 "${target}"...`);

  const { stdout, stderr } = await execGit(['reset', '--hard', target], cwd);
  const output = (stdout + '\n' + stderr).trim();
  steps.push(output || '(重置完成)');

  return {
    status: 'success',
    command: 'ResetHard',
    steps,
    warning: `所有未提交的更改已丢失！之前的 HEAD 是 ${currentHead}。`,
    recoveryHint: `撤销方法: git reset --hard ${currentHead}`,
    summary: `已硬重置到 "${target}"。`
  };
}

async function cmdBranchDelete(profile, cwd, args) {
  requireAuth('BranchDelete', args);

  const branchName = args.branchName;
  if (!branchName) throw new Error('BranchDelete 指令需要 "branchName" 参数。');

  const { stdout: currentBranch } = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (currentBranch.trim() === branchName) {
    throw new Error(`无法删除当前所在分支 "${branchName}"。请先切换到其他分支。`);
  }

  const steps = [];
  const force = args.force === 'true' || args.force === true;

  try {
    const { stdout: branchHead } = await execGit(['rev-parse', '--short', branchName], cwd);
    steps.push(`分支 "${branchName}" 的 HEAD: ${branchHead}`);
  } catch (e) { /* 分支可能无效 */ }

  const deleteFlag = force ? '-D' : '-d';
  steps.push(`⚠️ 正在删除分支 "${branchName}" (${force ? '强制' : '安全'}模式)...`);

  const { stdout, stderr } = await execGit(['branch', deleteFlag, branchName], cwd);
  const output = (stdout + '\n' + stderr).trim();
  steps.push(output || `分支 "${branchName}" 已删除。`);

  if (args.deleteRemote === 'true' || args.deleteRemote === true) {
    const remoteName = args.remote || (profile.push && profile.push.remote) || 'origin';
    const pushUrl = profile.push && profile.push.url;
    if (pushUrl) {
      steps.push(`同时删除远程分支 ${remoteName}/${branchName}...`);
      const authUrl = injectCredentials(pushUrl, profile.credentials);
      try {
        const { stdout: rOut, stderr: rErr } = await execGit(['push', authUrl, '--delete', branchName], cwd);
        steps.push((rOut + '\n' + rErr).trim() || '(远程分支已删除)');
      } catch (remoteErr) {
        steps.push(`警告: 删除远程分支失败: ${remoteErr.message}`);
      }
    }
  }

  return {
    status: 'success',
    command: 'BranchDelete',
    steps,
    summary: `已删除分支 "${branchName}"。`
  };
}

async function cmdRebase(profile, cwd, args) {
  requireAuth('Rebase', args);

  const onto = args.onto;
  if (!onto) throw new Error('Rebase 指令需要 "onto" 参数（例如 "main"、"upstream/main"）。');

  const steps = [];
  const interactive = args.interactive === 'true' || args.interactive === true;

  const { stdout: currentHead } = await execGit(['rev-parse', '--short', 'HEAD'], cwd);
  steps.push(`当前 HEAD: ${currentHead}`);

  if (interactive) {
    steps.push('注意: 非 TTY 环境不支持交互式变基，已使用标准变基。');
  }

  steps.push(`⚠️ 正在变基到 "${onto}"...`);

  try {
    const { stdout, stderr } = await execGit(['rebase', onto], cwd);
    const output = (stdout + '\n' + stderr).trim();
    steps.push(output || '(变基完成)');

    return {
      status: 'success',
      command: 'Rebase',
      steps,
      recoveryHint: `撤销方法: git reset --hard ${currentHead}`,
      summary: `成功变基到 "${onto}"。`
    };
  } catch (rebaseError) {
    const { stdout: conflictStatus } = await execGit(['status', '--porcelain'], cwd);
    const conflictFiles = conflictStatus.split('\n')
      .filter(l => l.startsWith('UU') || l.startsWith('AA') || l.startsWith('DU') || l.startsWith('UD'))
      .map(l => l.substring(3).trim());

    if (conflictFiles.length > 0) {
      try { await execGit(['rebase', '--abort'], cwd); } catch (e) { /* 尽力而为 */ }

      return {
        status: 'conflict',
        command: 'Rebase',
        steps,
        conflictFiles,
        hint: `在 ${conflictFiles.length} 个文件中发生冲突。变基已中止。之前的 HEAD: ${currentHead}。`
      };
    }
    throw rebaseError;
  }
}

async function cmdCherryPick(profile, cwd, args) {
  requireAuth('CherryPick', args);

  const commitHash = args.commitHash;
  if (!commitHash) throw new Error('CherryPick 指令需要 "commitHash" 参数。');

  const steps = [];
  steps.push(`⚠️ 正在摘取提交 "${commitHash}"...`);

  try {
    const { stdout, stderr } = await execGit(['cherry-pick', commitHash], cwd);
    const output = (stdout + '\n' + stderr).trim();
    steps.push(output || '(摘取完成)');

    return {
      status: 'success',
      command: 'CherryPick',
      steps,
      summary: `成功摘取提交 "${commitHash}"。`
    };
  } catch (cpError) {
    const { stdout: conflictStatus } = await execGit(['status', '--porcelain'], cwd);
    const conflictFiles = conflictStatus.split('\n')
      .filter(l => l.startsWith('UU') || l.startsWith('AA') || l.startsWith('DU') || l.startsWith('UD'))
      .map(l => l.substring(3).trim());

    if (conflictFiles.length > 0) {
      try { await execGit(['cherry-pick', '--abort'], cwd); } catch (e) { /* 尽力而为 */ }

      return {
        status: 'conflict',
        command: 'CherryPick',
        steps,
        conflictFiles,
        hint: `摘取提交 "${commitHash}" 时在 ${conflictFiles.length} 个文件中发生冲突。操作已中止。`
      };
    }
    throw cpError;
  }
}

// --------------- 配置档管理指令 ---------------
function cmdProfileAdd(repos, args) {
  const name = args.profileName;
  if (!name) throw new Error('需要 "profileName" 参数。');
  if (repos.profiles && repos.profiles[name]) throw new Error(`Profile "${name}" 已存在。`);

  const newProfile = {
    localPath: args.localPath || '',
    push: {
      remote: args.pushRemote || 'origin',
      url: args.pushUrl || '',
      branch: args.pushBranch || 'main'
    },
    pull: {
      remote: args.pullRemote || 'upstream',
      url: args.pullUrl || '',
      branch: args.pullBranch || 'main'
    },
    credentials: {
      email: args.email || '',
      username: args.username || '',
      token: args.token || ''
    },
    mergeStrategy: args.mergeStrategy || 'merge'
  };

  if (!repos.profiles) repos.profiles = {};
  repos.profiles[name] = newProfile;
  saveRepos(repos);

  return { status: 'success', command: 'ProfileAdd', result: `Profile "${name}" 已成功添加。` };
}

function cmdProfileEdit(repos, args) {
  const name = args.profileName;
  if (!name) throw new Error('需要 "profileName" 参数。');
  if (!repos.profiles || !repos.profiles[name]) throw new Error(`未找到 Profile "${name}"。`);

  const p = repos.profiles[name];
  if (args.localPath !== undefined) p.localPath = args.localPath;
  if (args.pushUrl !== undefined) p.push.url = args.pushUrl;
  if (args.pushRemote !== undefined) p.push.remote = args.pushRemote;
  if (args.pushBranch !== undefined) p.push.branch = args.pushBranch;
  if (args.pullUrl !== undefined) p.pull.url = args.pullUrl;
  if (args.pullRemote !== undefined) p.pull.remote = args.pullRemote;
  if (args.pullBranch !== undefined) p.pull.branch = args.pullBranch;
  if (args.email !== undefined) { if (!p.credentials) p.credentials = {}; p.credentials.email = args.email; }
  if (args.username !== undefined) { if (!p.credentials) p.credentials = {}; p.credentials.username = args.username; }
  if (args.token !== undefined) { if (!p.credentials) p.credentials = {}; p.credentials.token = args.token; }
  if (args.mergeStrategy !== undefined) p.mergeStrategy = args.mergeStrategy;

  saveRepos(repos);
  return { status: 'success', command: 'ProfileEdit', result: `Profile "${name}" 已成功更新。` };
}

function cmdProfileRemove(repos, args) {
  const name = args.profileName;
  if (!name) throw new Error('需要 "profileName" 参数。');
  if (!repos.profiles || !repos.profiles[name]) throw new Error(`未找到 Profile "${name}"。`);

  delete repos.profiles[name];
  if (repos.defaultProfile === name) {
    const remaining = Object.keys(repos.profiles);
    repos.defaultProfile = remaining.length > 0 ? remaining[0] : '';
  }
  saveRepos(repos);
  return { status: 'success', command: 'ProfileRemove', result: `Profile "${name}" 已移除。${repos.defaultProfile ? ` 默认 Profile 已切换为 "${repos.defaultProfile}"。` : ' 警告: 当前无默认 Profile。'}` };
}

// ============================================================
// 指令分发器
// ============================================================

async function dispatchCommand(command, args, repos, envConfig) {
  const allowedPaths = buildAllowedPaths(envConfig);

  if (command === 'ProfileList') return cmdProfileList(repos);
  if (command === 'ProfileAdd') return cmdProfileAdd(repos, args);
  if (command === 'ProfileEdit') return cmdProfileEdit(repos, args);
  if (command === 'ProfileRemove') return cmdProfileRemove(repos, args);

  const { name: profileName, profile } = resolveProfile(repos, args.profile);
  const cwd = validatePath(profile.localPath, allowedPaths);

  const calibrationSteps = await ensureRemotes(profile, cwd);

  let result;
  switch (command) {
    case 'Status':      result = await cmdStatus(profile, cwd); break;
    case 'Log':         result = await cmdLog(profile, cwd, args); break;
    case 'Diff':        result = await cmdDiff(profile, cwd, args); break;
    case 'BranchList':  result = await cmdBranchList(profile, cwd); break;
    case 'RemoteInfo':  result = await cmdRemoteInfo(profile, cwd); break;
    case 'StashList':   result = await cmdStashList(profile, cwd); break;
    case 'TagList':     result = await cmdTagList(profile, cwd); break;
    case 'Add':         result = await cmdAdd(profile, cwd, args); break;
    case 'Commit':      result = await cmdCommit(profile, cwd, args); break;

    case 'Pull':         result = await cmdPull(profile, cwd, args); break;
    case 'Push':         result = await cmdPush(profile, cwd, args); break;
    case 'Fetch':        result = await cmdFetch(profile, cwd, args); break;
    case 'SyncUpstream': result = await cmdSyncUpstream(profile, cwd, args); break;
    case 'Clone':        result = await cmdClone(profile, cwd, args); break;

    case 'BranchCreate': result = await cmdBranchCreate(profile, cwd, args); break;
    case 'Checkout':     result = await cmdCheckout(profile, cwd, args); break;
    case 'Merge':        result = await cmdMerge(profile, cwd, args); break;

    case 'ForcePush':   result = await cmdForcePush(profile, cwd, args); break;
    case 'ResetHard':   result = await cmdResetHard(profile, cwd, args); break;
    case 'BranchDelete':result = await cmdBranchDelete(profile, cwd, args); break;
    case 'Rebase':      result = await cmdRebase(profile, cwd, args); break;
    case 'CherryPick':  result = await cmdCherryPick(profile, cwd, args); break;

    default:
      result = { status: 'error', command, error: `未知指令: "${command}"` };
  }

  if (calibrationSteps.length > 0) {
    result.remoteCalibration = calibrationSteps;
  }
  result.profile = profileName;

  if (result.result && typeof result.result === 'string') {
    result.result = sanitizeOutput(result.result, profile);
  }

  return result;
}

// ============================================================
// 串行调用支持 (commandN 语法)
// ============================================================

function parseSerialCommands(input) {
  const commands = [];
  let i = 1;
  while (input[`command${i}`] || input[`command`] && i === 1) {
    const cmd = input[`command${i}`] || (i === 1 ? input.command : null);
    if (!cmd) break;

    const args = {};
    const suffix = String(i);
    for (const [key, value] of Object.entries(input)) {
      if (key === `command${i}`) continue;
      if (key.endsWith(suffix) && key !== `command${suffix}`) {
        const baseKey = key.slice(0, -suffix.length);
        args[baseKey] = value;
      }
    }

    if (input.profile && !args.profile) args.profile = input.profile;

    commands.push({ command: cmd, args });
    i++;
  }

  if (commands.length === 0 && input.command) {
    const args = { ...input };
    delete args.command;
    commands.push({ command: input.command, args });
  }

  return commands;
}

// ============================================================
// 输出包装: 适配 Plugin.js processToolCall 的 .result 协议
// ============================================================
function wrapForPluginJs(rawResult) {
  return { status: rawResult.status || 'success', result: JSON.stringify(rawResult) };
}

// ============================================================
// 主入口
// ============================================================

async function main() {

  let inputData = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    inputData += chunk;

  });

  process.stdin.on('end', async () => {

    try {
      const input = JSON.parse(inputData.trim());

      const envConfig = loadEnvConfig();
      const repos = loadRepos();

      const commands = parseSerialCommands(input);

      if (commands.length === 0) {
        console.log(JSON.stringify({ status: 'error', error: '未指定指令。请提供 "command" 字段。' }));
        process.exit(1);
        return;
      }

      if (commands.length === 1) {
        const { command, args } = commands[0];
        const result = await dispatchCommand(command, args, repos, envConfig);

        console.log(JSON.stringify(wrapForPluginJs(result)));
      } else {
        const results = [];
        let succeeded = 0;
        let failed = 0;

        for (const { command, args } of commands) {
          try {
            const result = await dispatchCommand(command, args, repos, envConfig);
            results.push(result);
            if (result.status === 'success') succeeded++;
            else failed++;
          } catch (e) {
            results.push({ status: 'error', command, error: e.message });
            failed++;
          }
        }

        const finalResult = {
          status: failed === 0 ? 'success' : 'partial',
          summary: `串行执行完成。成功: ${succeeded}, 失败: ${failed}`,
          results
        };

        console.log(JSON.stringify(wrapForPluginJs(finalResult)));
      }

    } catch (e) {

      console.log(JSON.stringify({ status: 'error', error: e.message }));
      process.exit(1);
    }
  });
}

main();