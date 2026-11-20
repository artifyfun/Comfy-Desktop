// Vendored from @openai/codex-sdk@0.149.1 (dist/index.js), Apache-2.0.
// 本地化原因：electron-vite 主进程 bundle 输出为 CJS，官方包 ESM 顶层的 import.meta.url 无法安全打进 CJS。
// 本文件裁剪了仅在 codexPathOverride 为空时才使用的 findCodexPath 解析逻辑（agentDriver 恒传内置二进制路径），
// 其余行为与官方 SDK 一致：spawn `codex exec --experimental-json`，stdin 传 prompt，stdout 逐行 JSON 事件流。
/* global process, Buffer */

// src/outputSchemaFile.ts
import { promises as fs } from "fs";
import os from "os";
import path from "path";
async function createOutputSchemaFile(schema) {
  if (schema === void 0) {
    return { cleanup: async () => {
    } };
  }
  if (!isJsonObject(schema)) {
    throw new Error("outputSchema must be a plain JSON object");
  }
  const schemaDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-output-schema-"));
  const schemaPath = path.join(schemaDir, "schema.json");
  const cleanup = async () => {
    try {
      await fs.rm(schemaDir, { recursive: true, force: true });
    } catch {
    }
  };
  try {
    await fs.writeFile(schemaPath, JSON.stringify(schema), "utf8");
    return { schemaPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/thread.ts
var Thread = class {
  _exec;
  _options;
  _id;
  _threadOptions;
  /** Returns the ID of the thread. Populated after the first turn starts. */
  get id() {
    return this._id;
  }
  /* @internal */
  constructor(exec, options, threadOptions, id = null) {
    this._exec = exec;
    this._options = options;
    this._id = id;
    this._threadOptions = threadOptions;
  }
  /** Provides the input to the agent and streams events as they are produced during the turn. */
  async runStreamed(input, turnOptions = {}) {
    return { events: this.runStreamedInternal(input, turnOptions) };
  }
  async *runStreamedInternal(input, turnOptions = {}) {
    const { schemaPath, cleanup } = await createOutputSchemaFile(turnOptions.outputSchema);
    const options = this._threadOptions;
    const { prompt, images } = normalizeInput(input);
    const generator = this._exec.run({
      input: prompt,
      baseUrl: this._options.baseUrl,
      apiKey: this._options.apiKey,
      threadId: this._id,
      images,
      model: options?.model,
      threadSource: options?.threadSource,
      sandboxMode: options?.sandboxMode,
      workingDirectory: options?.workingDirectory,
      skipGitRepoCheck: options?.skipGitRepoCheck,
      outputSchemaFile: schemaPath,
      modelReasoningEffort: options?.modelReasoningEffort,
      signal: turnOptions.signal,
      networkAccessEnabled: options?.networkAccessEnabled,
      webSearchMode: options?.webSearchMode,
      webSearchEnabled: options?.webSearchEnabled,
      approvalPolicy: options?.approvalPolicy,
      additionalDirectories: options?.additionalDirectories
    });
    try {
      for await (const item of generator) {
        let parsed;
        try {
          parsed = JSON.parse(item);
        } catch (error) {
          throw new Error(`Failed to parse item: ${item}`, { cause: error });
        }
        if (parsed.type === "thread.started") {
          this._id = parsed.thread_id;
        } else if (parsed.type === "turn.completed") {
          parsed.usage.cache_write_input_tokens ??= 0;
        }
        yield parsed;
      }
    } finally {
      await cleanup();
    }
  }
  /** Provides the input to the agent and returns the completed turn. */
  async run(input, turnOptions = {}) {
    const generator = this.runStreamedInternal(input, turnOptions);
    const items = [];
    let finalResponse = "";
    let usage = null;
    let turnFailure = null;
    for await (const event of generator) {
      if (event.type === "item.completed") {
        if (event.item.type === "agent_message") {
          finalResponse = event.item.text;
        }
        items.push(event.item);
      } else if (event.type === "turn.completed") {
        usage = event.usage;
      } else if (event.type === "turn.failed") {
        turnFailure = event.error;
        break;
      }
    }
    if (turnFailure) {
      throw new Error(turnFailure.message);
    }
    return { items, finalResponse, usage };
  }
};
function normalizeInput(input) {
  if (typeof input === "string") {
    return { prompt: input, images: [] };
  }
  const promptParts = [];
  const images = [];
  for (const item of input) {
    if (item.type === "text") {
      promptParts.push(item.text);
    } else if (item.type === "local_image") {
      images.push(item.path);
    }
  }
  return { prompt: promptParts.join("\n\n"), images };
}

// src/exec.ts
import { spawn } from "child_process";
import readline from "readline";
var INTERNAL_ORIGINATOR_ENV = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
var TYPESCRIPT_SDK_ORIGINATOR = "codex_sdk_ts";
var CodexExec = class {
  executablePath;
  envOverride;
  configOverrides;
  rawConfigOverrides;
  constructor(executablePath, env, configOverrides, rawConfigOverrides) {
    if (!executablePath) {
      throw new Error("codexPathOverride is required: vendored Codex SDK 不提供 findCodexPath 兜底");
    }
    this.executablePath = executablePath;
    this.envOverride = env;
    this.configOverrides = configOverrides;
    this.rawConfigOverrides = rawConfigOverrides;
  }
  async *run(args) {
    const commandArgs = ["exec", "--experimental-json"];
    if (this.configOverrides) {
      for (const override of serializeConfigOverrides(this.configOverrides)) {
        commandArgs.push("--config", override);
      }
    }
    if (this.rawConfigOverrides) {
      for (const override of this.rawConfigOverrides) {
        commandArgs.push("--config", override);
      }
    }
    if (args.baseUrl) {
      commandArgs.push(
        "--config",
        `openai_base_url=${toTomlValue(args.baseUrl, "openai_base_url")}`
      );
    }
    if (args.model) {
      commandArgs.push("--model", args.model);
    }
    if (args.threadSource !== void 0 && !args.threadId) {
      commandArgs.push("--thread-source", args.threadSource);
    }
    if (args.sandboxMode) {
      commandArgs.push("--sandbox", args.sandboxMode);
    }
    if (args.workingDirectory) {
      commandArgs.push("--cd", args.workingDirectory);
    }
    if (args.additionalDirectories?.length) {
      for (const dir of args.additionalDirectories) {
        commandArgs.push("--add-dir", dir);
      }
    }
    if (args.skipGitRepoCheck) {
      commandArgs.push("--skip-git-repo-check");
    }
    if (args.outputSchemaFile) {
      commandArgs.push("--output-schema", args.outputSchemaFile);
    }
    if (args.modelReasoningEffort) {
      commandArgs.push("--config", `model_reasoning_effort="${args.modelReasoningEffort}"`);
    }
    if (args.networkAccessEnabled !== void 0) {
      commandArgs.push(
        "--config",
        `sandbox_workspace_write.network_access=${args.networkAccessEnabled}`
      );
    }
    if (args.webSearchMode) {
      commandArgs.push("--config", `web_search="${args.webSearchMode}"`);
    } else if (args.webSearchEnabled === true) {
      commandArgs.push("--config", `web_search="live"`);
    } else if (args.webSearchEnabled === false) {
      commandArgs.push("--config", `web_search="disabled"`);
    }
    if (args.approvalPolicy) {
      commandArgs.push("--config", `approval_policy="${args.approvalPolicy}"`);
    }
    if (args.threadId) {
      commandArgs.push("resume", args.threadId);
    }
    if (args.images?.length) {
      for (const image of args.images) {
        commandArgs.push("--image", image);
      }
    }
    const env = {};
    if (this.envOverride) {
      Object.assign(env, this.envOverride);
    } else {
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== void 0) {
          env[key] = value;
        }
      }
    }
    if (!env[INTERNAL_ORIGINATOR_ENV]) {
      env[INTERNAL_ORIGINATOR_ENV] = TYPESCRIPT_SDK_ORIGINATOR;
    }
    if (args.apiKey) {
      env.CODEX_API_KEY = args.apiKey;
    }
    const child = spawn(this.executablePath, commandArgs, {
      env,
      signal: args.signal
    });
    let spawnError = null;
    child.once("error", (err) => spawnError = err);
    if (!child.stdin) {
      child.kill();
      throw new Error("Child process has no stdin");
    }
    child.stdin.write(args.input);
    child.stdin.end();
    if (!child.stdout) {
      child.kill();
      throw new Error("Child process has no stdout");
    }
    const stderrChunks = [];
    if (child.stderr) {
      child.stderr.on("data", (data) => {
        stderrChunks.push(data);
        // 诊断通道：WB_DEBUG_STDERR=1 时把 codex 子进程 stderr 落盘
        // （MCP 启动/工具调用失败只走 stderr，exec JSONL 不可见）
        if (process.env.WB_DEBUG_STDERR) {
          try {
            import("fs").then((m) => m.appendFileSync("/tmp/wb-codex-stderr.log", String(data))).catch(() => {});
          } catch {}
        }
      });
    }
    const exitPromise = new Promise(
      (resolve) => {
        child.once("exit", (code, signal) => {
          resolve({ code, signal });
        });
      }
    );
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    });
    try {
      for await (const line of rl) {
        yield line;
      }
      if (spawnError) throw spawnError;
      const { code, signal } = await exitPromise;
      if (code !== 0 || signal) {
        const stderrBuffer = Buffer.concat(stderrChunks);
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        throw new Error(`Codex Exec exited with ${detail}: ${stderrBuffer.toString("utf8")}`);
      }
    } finally {
      rl.close();
      child.removeAllListeners();
      try {
        if (!child.killed) child.kill();
      } catch {
      }
    }
  }
};
function serializeConfigOverrides(configOverrides) {
  const overrides = [];
  flattenConfigOverrides(configOverrides, "", overrides);
  return overrides;
}
function flattenConfigOverrides(value, prefix, overrides) {
  if (!isPlainObject(value)) {
    if (prefix) {
      overrides.push(`${prefix}=${toTomlValue(value, prefix)}`);
      return;
    } else {
      throw new Error("Codex config overrides must be a plain object");
    }
  }
  const entries = Object.entries(value);
  if (!prefix && entries.length === 0) {
    return;
  }
  if (prefix && entries.length === 0) {
    overrides.push(`${prefix}={}`);
    return;
  }
  for (const [key, child] of entries) {
    if (!key) {
      throw new Error("Codex config override keys must be non-empty strings");
    }
    if (child === void 0) {
      continue;
    }
    const path3 = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) {
      flattenConfigOverrides(child, path3, overrides);
    } else {
      overrides.push(`${path3}=${toTomlValue(child, path3)}`);
    }
  }
}
function toTomlValue(value, path3) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Codex config override at ${path3} must be a finite number`);
    }
    return `${value}`;
  } else if (typeof value === "boolean") {
    return value ? "true" : "false";
  } else if (Array.isArray(value)) {
    const rendered = value.map((item, index) => toTomlValue(item, `${path3}[${index}]`));
    return `[${rendered.join(", ")}]`;
  } else if (isPlainObject(value)) {
    const parts = [];
    for (const [key, child] of Object.entries(value)) {
      if (!key) {
        throw new Error("Codex config override keys must be non-empty strings");
      }
      if (child === void 0) {
        continue;
      }
      parts.push(`${formatTomlKey(key)} = ${toTomlValue(child, `${path3}.${key}`)}`);
    }
    return `{${parts.join(", ")}}`;
  } else if (value === null) {
    throw new Error(`Codex config override at ${path3} cannot be null`);
  } else {
    const typeName = typeof value;
    throw new Error(`Unsupported Codex config override value at ${path3}: ${typeName}`);
  }
}
var TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;
function formatTomlKey(key) {
  return TOML_BARE_KEY.test(key) ? key : JSON.stringify(key);
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/codex.ts
var Codex = class {
  exec;
  options;
  constructor(options = {}) {
    const { codexPathOverride, env, config, configOverrides } = options;
    this.exec = new CodexExec(codexPathOverride, env, config, configOverrides);
    this.options = options;
  }
  /**
   * Starts a new conversation with an agent.
   * @returns A new thread instance.
   */
  startThread(options = {}) {
    return new Thread(this.exec, this.options, options);
  }
  /**
   * Resumes a conversation with an agent based on the thread id.
   * Threads are persisted in ~/.codex/sessions.
   *
   * @param id The id of the thread to resume.
   * @returns A new thread instance.
   */
  resumeThread(id, options = {}) {
    return new Thread(this.exec, this.options, options, id);
  }
};
export {
  Codex,
  Thread
};