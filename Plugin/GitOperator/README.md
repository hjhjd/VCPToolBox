# GitOperator — VCP Git 仓库管理插件

> **版本**: v1.0.0 | **作者**: Nova & hjhjd | **日期**: 2026-03-02

## 📌 这是什么？

GitOperator 是一个为 VCP 系统设计的 **配置档驱动 (Profile-Driven)** Git 仓库管理插件。它解决了一个常见的痛点：

**当你的项目是从别人的仓库 fork 来的时候**，`git pull` 拉的是自己仓库的代码，而不是上游的最新更新。每次想同步上游都得手动配置 remote，非常麻烦。

GitOperator 让你把所有仓库地址、凭证、上下游关系写在一个配置文件里，然后通过 AI 对话就能完成拉取、推送、同步等所有 Git 操作。

---

## 🚀 核心特性

- **多仓库管理**：通过 `repos.json` 配置多个仓库档案（Profile），随时切换操作目标
- **一键上游同步**：`SyncUpstream` 命令自动完成 fetch → stash → merge → push 全流程
- **凭证安全注入**：GitHub Token 仅在内存中使用，不会写入 `.git/config`
- **输出自动脱敏**：所有返回给 AI 的内容会自动将 Token 替换为 `***`
- **危险操作保护**：强制推送、硬重置等 5 条危险指令需要验证码才能执行
- **冲突智能处理**：合并冲突时自动 abort 恢复干净状态，不会留下半成品
- **串行调用**：支持一次请求执行多个 Git 操作（如 Add → Commit → Push）
- **路径白名单**：所有文件操作限制在 `PLUGIN_WORK_PATHS` 允许的范围内

---

## 📂 文件结构

```
Plugin/GitOperator/
├── GitOperator.js          # 主脚本（~600行）
├── plugin-manifest.json    # 插件清单（25条指令定义）
├── config.env              # 运行配置
├── config.env.example      # 配置模板
├── repos.json              # 仓库配置档（需要填入你的信息）
├── repos.json.example      # 仓库配置示例（3种典型场景）
├── CHANGELOG.md            # 变更日志
└── README.md               # 本文档
```

---

## ⚙️ 快速开始

### 第一步：配置 config.env

打开 `config.env`，根据需要修改：

```env
# 插件工作路径白名单（逗号分隔，支持多个路径）
PLUGIN_WORK_PATHS=../../

# 日志开关（true/false）
ENABLE_LOGGING=true
```

> `PLUGIN_WORK_PATHS` 默认是 `../../`（VCP 项目根目录），一般不需要改。如果你要管理其他位置的仓库，把路径加进来就行。

### 第二步：配置 repos.json

这是最重要的配置文件。打开 `repos.json`，参考 `repos.json.example` 填入你的仓库信息：

```json
{
  "defaultProfile": "vcp-server",
  "profiles": {
    "vcp-server": {
      "localPath": "../../",
      "push": {
        "remote": "origin",
        "url": "https://github.com/你的用户名/VCPServer.git",
        "branch": "main"
      },
      "pull": {
        "remote": "upstream",
        "url": "https://github.com/RyanLiuCN/VCPServer.git",
        "branch": "main"
      },
      "credentials": {
        "email": "你的邮箱",
        "username": "你的GitHub用户名",
        "token": "ghp_你的PersonalAccessToken"
      },
      "mergeStrategy": "merge"
    }
  }
}
```

**字段说明**：

| 字段 | 说明 |
|------|------|
| `defaultProfile` | 默认使用的仓库档案名称 |
| `localPath` | 本地仓库的路径（支持相对路径和绝对路径） |
| `push` | 推送目标配置（通常是你自己的仓库） |
| `pull` | 拉取来源配置（通常是上游仓库） |
| `credentials` | Git 凭证（邮箱、用户名、GitHub Token） |
| `mergeStrategy` | 同步时的合并策略：`merge`（默认）或 `rebase` |

> ⚠️ **安全提醒**：`repos.json` 包含你的 GitHub Token，请确保它已加入 `.gitignore`，不要提交到仓库！

### 第三步：重启 VCP 服务

配置完成后重启 VCP 服务器，GitOperator 插件会自动加载。

---

## 📋 全部指令一览

GitOperator 共提供 **25 条指令**，分为 5 个类别：

### 只读查询（8条）

| 指令 | 功能 | 关键参数 |
|------|------|----------|
| `Status` | 查看仓库状态 | `profile`（可选） |
| `Log` | 查看提交历史（JSON格式） | `maxCount`（默认20）、`branch` |
| `Diff` | 查看变更差异 | `target`（如 upstream/main）、`maxLines`（默认200） |
| `BranchList` | 列出所有分支 | — |
| `RemoteInfo` | 查看远程仓库信息 | — |
| `StashList` | 查看暂存列表 | — |
| `TagList` | 查看标签列表 | — |
| `ProfileList` | 列出所有仓库配置档 | — |

### 常规写操作（7条）

| 指令 | 功能 | 关键参数 |
|------|------|----------|
| `Add` | 暂存文件 | `files`（必需，`"."`=全部） |
| `Commit` | 提交变更 | `message`（必需） |
| `Pull` | 拉取代码（走 pull 配置） | `source`（可选） |
| `Push` | 推送代码（走 push 配置） | — |
| `Fetch` | 获取远程引用 | `source`（可选） |
| `Clone` | 克隆仓库 | `url`、`localPath`（均必需） |
| `SyncUpstream` ⭐ | 一键同步上游仓库 | — |

### 分支管理（3条）

| 指令 | 功能 | 关键参数 |
|------|------|----------|
| `BranchCreate` | 创建新分支 | `branchName`（必需）、`startPoint`（可选） |
| `Checkout` | 切换分支 | `branch`（必需） |
| `Merge` | 合并分支 | `branch`（必需） |

### 🔒 危险操作（5条，需验证码）

| 指令 | 功能 | 关键参数 |
|------|------|----------|
| `ForcePush` | 强制推送 | `requireAdmin`（必需） |
| `ResetHard` | 硬重置 | `target`、`requireAdmin`（必需） |
| `BranchDelete` | 删除分支 | `branchName`、`requireAdmin`（必需） |
| `Rebase` | 变基操作 | `onto`、`requireAdmin`（必需） |
| `CherryPick` | 摘取提交 | `commitHash`、`requireAdmin`（必需） |

> 危险操作需要在调用时提供 VCP Auth 验证码，验证失败会被直接拒绝。

### 配置管理（3条）

| 指令 | 功能 | 关键参数 |
|------|------|----------|
| `ProfileAdd` | 添加仓库配置 | `profileName`（必需）等 |
| `ProfileEdit` | 编辑仓库配置 | `profileName`（必需）等 |
| `ProfileRemove` | 删除仓库配置 | `profileName`（必需） |

---

## ⭐ SyncUpstream 详解

这是 GitOperator 最核心的功能。一条命令完成从上游仓库的完整同步：

```
执行流程：
1. 读取 profile 配置
2. 自动校准 remote（ensureRemotes）
3. git fetch upstream
4. 检查未提交更改 → 自动 stash 保护
5. 执行合并（merge 或 rebase，取决于配置）
6. 冲突检测 → 有冲突则中止并报告
7. 恢复 stash
8. git push origin main
```

**使用场景**：你 fork 了 RyanLiuCN/VCPServer，想把上游的最新更新同步到你自己的仓库。只需告诉 AI "同步一下上游"，GitOperator 会自动完成全部步骤。

---

## 🔗 串行调用

支持在一次请求中执行多个连续操作，非常适合 "Add → Commit → Push" 这样的常见工作流。

AI 会自动构造带数字后缀的参数，例如：
- `command1: Add, files1: "."`
- `command2: Commit, message2: "feat: 新功能"`
- `command3: Push`

所有指令共享同一个 `profile` 参数。

---

## 🛡️ 安全架构

GitOperator 采用了 **7 层安全防护**：

1. **路径白名单** — 所有文件操作限制在 `PLUGIN_WORK_PATHS` 范围内
2. **凭证脱敏** — 输出中的 Token 自动替换为 `***`
3. **凭证仅内存注入** — Token 不会写入 `.git/config` 或任何日志
4. **Auth 验证码守卫** — 5 条危险指令需要 6 位验证码
5. **冲突自动中止** — Merge/Rebase/SyncUpstream 遇冲突自动 abort
6. **分支保护** — 禁止删除当前所在分支
7. **恢复提示** — ResetHard/Rebase 输出 recoveryHint 便于回滚

---

## 🔧 自动校准机制

首次使用时，GitOperator 会自动执行 `ensureRemotes()`：

1. 读取 `repos.json` 中配置的 remote 地址
2. 检查本地仓库的 remote 是否匹配
3. 不存在则自动 `git remote add`
4. URL 不匹配则自动 `git remote set-url`
5. 自动设置 `user.email` 和 `user.name`

**这意味着你只需要在 repos.json 里填好地址，第一次调用时它会自动把所有 remote 配好。** 地址变了？改配置文件就行，下次调用自动修正。

---

## 💡 常见使用场景

### 场景 1：日常开发提交
> "Nova，帮我把改动都提交了，备注'修复登录bug'，然后推上去"

AI 执行：Add(".") → Commit("修复登录bug") → Push

### 场景 2：同步上游更新
> "Nova，从莱恩的仓库同步一下最新代码"

AI 执行：SyncUpstream（自动 fetch → merge → push）

### 场景 3：创建功能分支
> "Nova，帮我创建一个 feature/dark-mode 分支"

AI 执行：BranchCreate("feature/dark-mode")

### 场景 4：查看最近改了什么
> "Nova，看看最近 10 条提交记录"

AI 执行：Log(maxCount=10)

---

## ❓ FAQ

**Q：我没有上游仓库怎么办？**
A：`pull` 配置中的 `url` 留空即可。Pull 指令会自动使用 push 配置的 remote。

**Q：Token 会不会泄露？**
A：不会。Token 只在推送时临时注入到内存中的 URL 里，不会写入 `.git/config`，也不会出现在返回给 AI 的任何输出中。

**Q：遇到合并冲突怎么办？**
A：GitOperator 会自动中止合并（`git merge --abort`），恢复到干净状态，并返回冲突文件列表。你可以手动解决冲突后再次尝试。

**Q：可以管理多个仓库吗？**
A：可以！在 `repos.json` 的 `profiles` 里添加多个配置即可。调用时指定 `profile` 参数切换目标仓库。

**Q：支持分布式节点吗？**
A：支持。在 `config.env` 的 `PLUGIN_WORK_PATHS` 中加入 NFS/SMB 挂载路径即可远程操作其他节点上的仓库。

---

## 📜 许可

本插件作为 VCP 系统的一部分，遵循 VCP 项目的开源协议。

---

*Built with ❤️ by Nova & hjhjd — 2026.03.02*