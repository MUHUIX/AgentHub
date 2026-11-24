/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐晖 (MUHUIX)
 * https://github.com/MUHUIX/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · 连接三级校验：配置态（文件里有没有）→ 握手态（真拉起桥发 initialize+tools/list）
// → 真实调用态（桥有没有回传心跳）。三级全过才是绿色"已连接"（§5.4）。
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const agents = require("./agents.cjs");
const inject = require("./inject.cjs");

// MCP 桥物理路径候选（修正清单 B1：args 指向物理 JS，走 ELECTRON_RUN_AS_NODE）
function bridgeCandidates(appPath, resourcesPath) {
  const out = [];
  if (resourcesPath) out.push(path.join(resourcesPath, "mcp", "mcp-memory-server.cjs"));
  if (appPath) out.push(path.join(path.dirname(appPath), "resources", "mcp", "mcp-memory-server.cjs"));
  // 开发环境：源码树
  out.push(path.resolve(__dirname, "..", "..", "..", "tools", "mcp-memory-server.cjs"));
  return out;
}

function resolveBridge(appPath, resourcesPath) {
  for (const c of bridgeCandidates(appPath, resourcesPath)) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function resolveHostExe(appPath) {
  if (appPath && fs.existsSync(appPath) && /\.exe$/i.test(appPath)) return appPath;
  // 开发环境（electron.exe 起 dev）：退回主程序 exe 的常见安装位置探测
  const candidates = [
    appPath,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "AgentHub", "AgentHub.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "AgentHub", "AgentHub.exe"),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return appPath || null;
}

// MCP 宿主进程名必须与主程序**不同名**，且**不能住在安装目录里**。两条缺一不可。
//
// ① 同名：electron-builder 的 NSIS 安装/卸载阶段按「映像名」（AgentHub.exe）判定应用是否仍在运行，
//    不看路径也不看命令行。MCP 桥是常驻进程（DSH / Cursor / Claude 长期持有），若它用主程序 exe
//    启动，升级时主进程虽已干净退出（crash.log 有 `quit exitCode=0`），安装器仍会因为"同名进程在跑"
//    而拒绝卸载。
// ② 同目录：即使换了名字，只要宿主 exe 还躺在 INSTDIR 里，运行中的它对
//    `AgentHub.exe` / `icudtl.dat` / `v8_context_snapshot.bin` 持有映像锁。NSIS 卸载遍历安装目录时
//    删不掉这些文件，会留下残留，新安装器随后报
//    「Failed to uninstall old application files. Please try running the installer again.: 2」。
//    实测：卸载器本身返回 0，但目录里正好剩这 3 个被锁文件。
//
// 结论：宿主必须放在安装目录之外的独立运行目录里，进程名也用 agenthub-mcp.exe。
const MCP_HOST_BASENAME = "agenthub-mcp";
// Electron 以 ELECTRON_RUN_AS_NODE 跑脚本时仍需从 exe 同目录读这两份数据文件（缺 icudtl.dat 会
// 报 "Invalid file descriptor to ICU data received" 且脚本不执行）。
const MCP_HOST_DATA_FILES = ["icudtl.dat", "v8_context_snapshot.bin"];

/** 同一份文件？硬链接看 inode，复制件退回 size+mtime。 */
function sameFile(srcStat, dstPath) {
  try {
    const cur = fs.statSync(dstPath);
    return cur.ino === srcStat.ino && cur.size === srcStat.size && cur.mtimeMs === srcStat.mtimeMs;
  } catch {
    return false;
  }
}

/** 把 src 备到 dst：先试硬链接（同卷零拷贝），失败退复制。成功返回 true。 */
function linkOrCopy(src, dst) {
  if (fs.existsSync(dst)) return true;
  try {
    fs.linkSync(src, dst);
    return true;
  } catch {
    try {
      fs.copyFileSync(src, dst);
      return true;
    } catch {
      return false;
    }
  }
}

/** 宿主运行根目录：优先与安装目录**同卷的兄弟目录**（可硬链接、零拷贝），
 *  父目录不可写时退回 userData。两者都在 INSTDIR 之外。 */
function mcpHostRoot(appPath) {
  const instDir = path.dirname(appPath);
  const sibling = path.join(path.dirname(instDir), `${path.basename(instDir)}-runtime`);
  try {
    fs.mkdirSync(sibling, { recursive: true });
    // 探一下真能写（Program Files 下无权限时 mkdir 可能已被创建但写文件会失败）
    const probe = path.join(sibling, `.w`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
    return sibling;
  } catch { /* 退回 userData */ }
  try {
    const fallback = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"), "AgentHub", "mcp-host");
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  } catch {
    return null;
  }
}

/** 清掉运行目录里除 keep 之外的旧版本子目录（旧宿主可能仍在跑，删不掉就留给下次）。 */
function pruneHostVersions(root, keep) {
  try {
    for (const name of fs.readdirSync(root)) {
      if (name === keep) continue;
      const p = path.join(root, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      try {
        for (const f of fs.readdirSync(p)) {
          try { fs.unlinkSync(path.join(p, f)); } catch { /* 被占用：下次再清 */ }
        }
        fs.rmdirSync(p);
      } catch { /* 同上 */ }
    }
  } catch { /* 清理失败不影响接入 */ }
}

/** 与主程序同内容、独立名字、**独立目录**的 MCP 宿主可执行路径（仅 Windows 需要，其余平台原样返回）。 */
function resolveMcpHostExe(appPath) {
  if (!appPath || process.platform !== "win32") return appPath;
  if (!/\.exe$/i.test(appPath) || !fs.existsSync(appPath)) return appPath;
  const legacydst = path.join(path.dirname(appPath), `${MCP_HOST_BASENAME}.exe`); // ① 之前的落地位置（INSTDIR 内）
  try {
    const src = fs.statSync(appPath);
    // 版本键用主程序 size+mtime：每次升级/重装都会变，天然隔离新旧宿主，避免"运行中无法覆盖"。
    const key = `${src.size}-${Math.round(src.mtimeMs)}`;
    const root = mcpHostRoot(appPath);
    if (!root) return legacyFallback(appPath, src, legacydst);
    const dir = path.join(root, key);
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, `${MCP_HOST_BASENAME}.exe`);
    if (!sameFile(src, dst)) {
      // 版本目录是新的，正常不会撞锁；真撞了就说明同一版本被重装，退回旧落地位置
      try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch { return legacyFallback(appPath, src, legacydst); }
    }
    if (!linkOrCopy(appPath, dst)) return legacyFallback(appPath, src, legacydst);
    for (const name of MCP_HOST_DATA_FILES) {
      const from = path.join(path.dirname(appPath), name);
      if (fs.existsSync(from)) linkOrCopy(from, path.join(dir, name));
    }
    pruneHostVersions(root, key);
    return dst;
  } catch {
    try { return legacyFallback(appPath, fs.statSync(appPath), legacydst); } catch { return appPath; }
  }
}

/** 兜底：仍放安装目录内（旧行为）。宁可升级受阻，也不能让记忆中枢接不上。 */
function legacyFallback(appPath, srcStat, dst) {
  try {
    if (!sameFile(srcStat, dst)) {
      try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch { return dst; }
      if (!linkOrCopy(appPath, dst)) return appPath;
    }
    return dst;
  } catch {
    return appPath;
  }
}

// 注入预览/实际写入用的命令行（含路径可达性预检结果）。
// opts.agentId：写入具体 Agent 配置时必须带上，桥用它上报心跳归属（三级校验按 adapter.id 匹配）。
function connectionCommand(opts) {
  const host = resolveMcpHostExe(resolveHostExe(opts.appPath));
  const bridge = resolveBridge(opts.appPath, opts.resourcesPath);
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  if (opts.agentId) env.AGENTHUB_AGENT = opts.agentId;
  return {
    command: host,
    args: bridge ? [bridge] : [],
    env,
    hostExists: !!(host && fs.existsSync(host)),
    bridgeExists: !!(bridge && fs.existsSync(bridge)),
    candidates: bridgeCandidates(opts.appPath, opts.resourcesPath),
  };
}

function renderSnippet(adapter, cmd, format) {
  const fmt = format || "json";
  // 只有 command/args/env 可以进用户配置，hostExists 等内部预检字段不外泄
  const pub = { command: cmd.command, args: cmd.args, env: cmd.env };
  if (fmt === "toml" || adapter.format === "toml-mcp_servers") {
    const envPairs = Object.entries(pub.env || {}).map(([k, v]) => `${k} = ${inject.tomlString(v)}`).join(", ");
    return [
      `[mcp_servers.${inject.SERVER_KEY}]`,
      `command = ${inject.tomlString(pub.command)}`,
      `args = [${pub.args.map(inject.tomlString).join(", ")}]`,
      `env = { ${envPairs} }`,
      `startup_timeout_sec = 20`,
    ].join("\n");
  }
  if (fmt === "cli") {
    return `${pub.command} ${pub.args.join(" ")}`;
  }
  if (adapter.id === "zcode") {
    return JSON.stringify({ mcp: { servers: { [inject.SERVER_KEY]: { type: "stdio", ...pub, enabled: true } } } }, null, 2);
  }
  return JSON.stringify({ mcpServers: { [inject.SERVER_KEY]: { type: "stdio", ...pub } } }, null, 2);
}

// ---------- 三级校验 ----------

function verifyConfig(adapter) {
  const result = { level: "config", ok: false, message: "", detail: {} };
  if (!adapter.configExists) {
    result.message = "配置文件不存在";
    return result;
  }
  if (adapter.format === "yml-cordis-patch") {
    // DSH cordis patch：profiles 下任一文件含受控块即已配置（configExists 已在 agents.list 特判）
    if (!inject.cordisHasEntry(adapter)) {
      result.message = "profiles 下没有 agenthub-memory 受控块";
      return result;
    }
    result.ok = true;
    result.message = "已配置";
    return result;
  }
  if (adapter.format === "toml-mcp_servers") {
    if (!inject.tomlHasEntry(adapter)) {
      result.message = "配置文件中没有 agenthub-memory 条目";
      return result;
    }
    result.ok = true;
    result.message = "已配置";
    return result;
  }
  const has = inject.jsonHasEntry(adapter);
  if (!has || !has.present) {
    result.message = "配置文件中没有 agenthub-memory 条目";
    return result;
  }
  if (has.disabled) {
    result.message = "条目存在但 enabled=false";
    return result;
  }
  result.ok = true;
  result.message = "已配置";
  result.detail.entry = has;
  // 归属标记校验：注入时写的 AGENTHUB_AGENT 决定心跳/真实调用记到哪个 Agent 名下。
  // WorkBuddy 与 WorkBuddy AI 拆成两个产品后，旧版注入留下的 workbuddy 标记会让 AI 的调用
  // 静默记到中国版卡片上——如实提示，重新注入即可修正（配置本身能用，不判失败）
  const tag = String(has.agentTag || "");
  if (tag && tag !== adapter.id) {
    result.warning = `配置里的 AGENTHUB_AGENT 是「${tag}」而不是「${adapter.id}」：真实调用会记到 ${tag} 名下，请重新注入以修正归属`;
  }
  return result;
}

function handshake(cmd, timeoutMs) {
  return new Promise((resolve) => {
    if (!cmd.hostExists || !cmd.bridgeExists) {
      return resolve({ ok: false, message: "启动路径不可达（exe 或桥脚本缺失）" });
    }
    const t0 = Date.now();
    let child;
    try {
      child = spawn(cmd.command, cmd.args, {
        env: { ...process.env, ...cmd.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, message: `桥启动失败：${e.message}` });
    }
    let buffer = "";
    let stdoutMeta = "{}";
    let settled = false;
    let timer = null;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      // 统一在收口处清定时器：否则成功/失败都留着未触发的 20s 定时器（事件循环被白占）
      if (timer) clearTimeout(timer);
      try { child.kill(); } catch { /* 进程可能已退出 */ }
      resolve(payload);
    };
    timer = setTimeout(() => finish({ ok: false, message: "握手超时（20 秒）" }), timeoutMs || 20000);
    child.on("error", (e) => finish({ ok: false, message: `桥进程错误：${e.message}` }));
    // 子进程秒退时立刻返回，不必等满 20 秒超时
    child.on("exit", (code) => { if (!settled) finish({ ok: false, message: `桥进程退出（code ${code}）` }); });
    if (child.stdin) child.stdin.on("error", () => { /* 子进程先退出时的 EPIPE，按失败处理即可 */ });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === "h1" && msg.result) {
          stdoutMeta = msg.result.serverInfo ? JSON.stringify(msg.result.serverInfo) : "{}";
          try {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "h2", method: "tools/list" }) + "\n");
          } catch { finish({ ok: false, message: "桥进程不可写（tools/list）" }); }
        } else if (msg.id === "h2") {
          const count = msg.result && Array.isArray(msg.result.tools) ? msg.result.tools.length : 0;
          if (!count) finish({ ok: false, message: "握手成功但工具清单为空" });
          else finish({ ok: true, latencyMs: Date.now() - t0, tools: count, serverInfo: safeParse(stdoutMeta) });
        }
      }
    });
    try {
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: "h1", method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agenthub-verify", version: "1.0.0" } },
      }) + "\n");
    } catch (e) {
      finish({ ok: false, message: `桥进程不可写：${e.message}` });
    }
  });
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

async function verifyAgent(adapter, opts) {
  const cmd = connectionCommand(opts || {});
  const config = verifyConfig(adapter);
  const beat = opts && opts.beats ? opts.beats.find((b) => b.agent === adapter.id) : null;
  const real = beat && beat.last_call
    ? { ok: true, lastCall: beat.last_call, calls: beat.calls, lastTool: beat.last_tool, writes: beat.writes, searches: beat.searches, errors: beat.errors }
    : { ok: false, message: "尚未观察到真实调用" };
  const hs = opts && opts.skipHandshake ? { ok: false, message: "未执行握手（配置态与真实态已足够）" } : await handshake(cmd, opts && opts.timeoutMs);

  let level = "none";
  if (config.ok && hs.ok && real.ok) level = "verified";
  else if (config.ok && hs.ok) level = "handshaked";
  else if (config.ok) level = "configured";
  else if (adapter.configExists) level = "detected";
  return {
    agent: adapter.id,
    name: adapter.name,
    level,
    config,
    handshake: hs,
    real,
    command: cmd,
    configPath: adapter.configPath,
    instructionPath: adapter.instruction && adapter.instruction.path,
    instructionInjected: adapter.instruction && adapter.instruction.path ? inject.hasBlock(adapter.instruction.path) : false,
  };
}

async function verifyAll(opts) {
  const cfgAgents = opts && opts.cfg ? opts.cfg : {};
  const list = agents.list(cfgAgents).filter((a) => a.enabled);
  const beats = opts && opts.beats ? opts.beats : [];
  const out = [];
  // 限并发批量握手：串行时每个 agent 最坏 20s 超时，N 个 agent = N×20s 才能出结果
  // （巡检页转圈半分钟起步）。握手是各自 spawn 独立子进程，无共享状态，4 路并发安全
  const CONCURRENCY = 4;
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const batch = list.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((a) => verifyAgent(a, { ...(opts || {}), beats })));
    out.push(...results);
  }
  return out;
}

module.exports = { verifyAgent, verifyAll, verifyConfig, handshake, connectionCommand, renderSnippet, resolveBridge, resolveHostExe, resolveMcpHostExe, bridgeCandidates };
