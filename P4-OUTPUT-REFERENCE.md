# p4 输出参考（Simple UnrealGameSync）

本 app 跑的 p4 命令各自输出什么、每行什么含义、app 怎么解析。
基于真实样本（run `bf509a08`，2026-07-08，HEAD 同步，8596 文件：5072 updating / 3001 added / 523 deleted）。

---

## 速览：app 跑的 p4 命令

| 命令 | 传不传输 | 输出形态 | app 拿来干嘛 |
|---|---|---|---|
| `p4 -I sync <paths>` | ✅ 传输 | 每文件动作行 + 错误行 + summary | 主同步；行数 → count 分子 |
| `p4 sync -n <paths>` | ❌ | 同上的每文件行（不真传） | 干跑数 `total`（count 分母） |
| `p4 sync -N <paths>` | ❌ | 每子路径一行 network estimate | 数 byte bar 分母 |
| `p4 sync -f Engine/...` | ✅ | 同 `sync`（强制） | Engine 强同步 |
| `p4 info -s` | ❌ | 连通状态 | 连通性检查 |
| `p4 changes -m1 //client/...#have` | ❌ | `Change N on DATE by USER@CLIENT` | 当前 have 的 CL |
| `p4 client -o` | ❌ | client spec（含 `Stream:`） | 绑定的 stream |
| `p4 changes -l -s submitted` | ❌ | CL 历史（带描述） | 历史回滚列表 |
| （以上全部） | — | 全局加 `-s`（scripting 模式），每行带 severity 前缀 | 见 §1b 注（quick-260718-eje） |

---

## 1. 真同步 `p4 -I sync <paths>`

**传输在这里发生**。p4 进程活多久，就传多久。

### 1a. 每文件动作行（count 的来源）

格式：`//<depot路径>#<版本号> - <动作> <本地路径>`

| 行尾标志 | 含义 | 真实例子 | run bf509a08 数量 |
|---|---|---|---|
| ` - updating ` | 本地已有该文件，更新到新版本 | `//FY_Depot/.../ANS_Wwise.uasset#3 - updating D:\FYDepot\...\ANS_Wwise.uasset` | 5072 |
| ` - added as ` | 本地没有的新文件 | `//FY_Depot/.../SFX_72001_...uasset#1 - added as D:\FYDepot\...\SFX_...uasset` | 3001 |
| ` - deleted as ` | 该文件被删除 | `//FY_Depot/.../SFX_GP_DanBoBangMai__Pop.uasset#1 - deleted as D:\FYDepot\...\...uasset` | 523 |

合计 **8596 = `files_synced`**。这三种行就是进度条 `current`（分子）的来源——`parse_sync_file_count` 匹配它们各 +1。

### 1b. 错误 / 提示行（不计 count，显示在日志窗）

> **`-s` scripting 模式注记（quick-260718-eje）**：所有 p4 命令现在都带全局 `-s` 运行（`p4_global_args`，`-s` 在 `-C utf8 -c <client> -d <root>` 之前）。从此**每行 stdout 都带 severity 前缀**：`info: ` / `warning: ` / `error: `，末尾再加一行 `exit: <code>`。
>
> 真实形态（§1a 的每文件行现在长这样）：
> ```
> info: //FY_Depot/.../X.uasset#1 - added as D:\FYDepot\...\X.uasset
> info: //FY_Depot/.../Y.uasset#3 - updating D:\FYDepot\...\Y.uasset
> exit: 0
> ```
>
> §5 所有 parser 先经 `split_p4_severity` 剥前缀 / 按 tag 分流再匹配；`exit:` 行永远不会被当成已同步文件、也不会粘进 CL 描述。解析结果与加 `-s` 之前完全一致（零行为变化）。

| 行 | 含义 |
|---|---|
| `<path> - no such file(s).` | 该路径在 server 没有文件（如 `UnrealEngine/FYGame/DerivedDataCache/... - no such file(s).`，DerivedDataCache 常见） |
| `<path> - protected` | 权限不够，跳过 |
| `<path> - currently opened` | 文件被 checkout，跳过 |
| `Library file missing.` | 缺库文件 |

### 1c. 摘要行

- `... N file(s) up-to-date.`（没东西可更新时）

---

## 2. 干跑 `p4 sync -n <paths>`（**不传输**）

输出和 §1a **一模一样的每文件行**，但 p4 不真取真写——纯"如果我跑会碰哪些文件"。

**用途**：在真同步**之前**跑一次，数出 `total`（分母）→ `dry_run_sync` → `total_clone.store(count)`（`sync_orchestrator.rs:777`）→ 推给前端 `progress.total`。

---

## 3. 网络估算 `p4 sync -N <paths>`（**不传输**）

app 传 ~47 条 depot 子路径，p4 对每条吐一行：

```
Server network estimates: files added/updated/deleted=X/Y/Z, bytes added/updated=D/E
```

真实例子：
```
Server network estimates: files added/updated/deleted=0/1/0, bytes added/updated=0/227479
Server network estimates: files added/updated/deleted=28/7491/140, bytes added/updated=897481/1190745888
```

**用途**：数 byte bar 的 `bytesTotal` 分母——`parse_sync_n_total_bytes`（`p4_executor.rs:348`）把所有行的 `D+E` 加起来。

> 注意：`-N` 是服务端**悲观估算**，即便修完 path-overlap（quick-260707-s1y），仍比实际写入高 ~3x → byte bar 收尾够不到 100%。这是已知 cosmetic 缺口。

---

## 4. 其它命令的输出

| 命令 | 典型输出 |
|---|---|
| `p4 info -s` | `Client fidelity: ...` / 错误码——只看 exit code + 有无 stdout |
| `p4 changes -m1 //client/...#have` | `Change 12345 on 2024/01/01 by user@client`（app split 空格取第 2 个 token = CL 号） |
| `p4 client -o` | client spec 表单，app `strip_prefix("Stream:")` 取绑定的 stream |
| `p4 changes -l -s submitted -mN //...` | 每条 `Change N on DATE by user@client *pending* 描述...`，`parse_changelists` 解析成列表 |
| `p4 sync -f Engine/Source/... Engine/Shaders/... Engine/Config/...` | 同 §1a，但强制重新评估（用来覆盖 git 改过的 Engine 文件） |

---

## 5. app 的解析器（代码位置）

| 解析器 | 位置 | 匹配什么 | 喂给谁 |
|---|---|---|---|
| `parse_sync_file_count` | `src-tauri/src/services/p4_executor.rs:1500` | `- updating` / `- added as` / `- deleted` | `current`（分子）+ dry-run 的 `total`（分母） |
| `extract_sync_file_path` | `p4_executor.rs:1509` | 同上的本地路径部分 | `current_file` 显示 |
| `parse_sync_n_total_bytes` | `p4_executor.rs:348` | `-N` 输出里所有 `bytes added/updated=D/E` 的 `D+E` 之和 | byte bar 的 `bytesTotal` |
| `parse_changelists` | `p4_executor.rs:1532` | `p4 changes -l` 的 `Change N on ...` | 历史列表 |

---

## 6. ⚠️ 最关键的坑：每文件行 ≠ "传完了"

`- updating` / `- added as` / `- deleted` 这三种行是 p4 在**同步一开始**（扫服务器、拿清单、决定碰哪些文件时）**前置吐完的调度通告**，跟实际传输解耦。

**实证**（run bf509a08，单线程，p4 进程跑了 35s）：

```
13:57:14  p4 sync spawn
13:57:16  第一批 ~4365 行
13:57:18  第二批 ~4704 行   ← 全部行 ~4s 吐完
13:57:18 → 49  stdout 一行都没有（31s 静默）
13:57:39  disk 写 388 MB
13:57:41  disk 写 1.2 GB     ← 真传输一直在进行
13:57:49  p4 exit（35s）
```

所以数这些行得到的 count，**~4 秒就打满 100%**，跟真实传输还差几十秒。这正是：

- 进度条用 **byte bar**（`sysinfo disk_usage` 测真写入，和传输同步）当主信号
- count 降级为字节 bar 下面的**副行参考**（quick-260706-pnr）
- 单线程也救不了 count（quick-260707 验证：threads=1 仍前置）

**count 注定是"p4 计划碰多少文件"，不是"传了多少"。**
