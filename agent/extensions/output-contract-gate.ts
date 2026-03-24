// @ts-nocheck
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".pi", "agent", "state", "output-contract-gate");
const RUNS_DIR = path.join(STATE_DIR, "runs");
const VALIDATIONS_FILE = path.join(STATE_DIR, "validations.jsonl");
const CONFIG_FILE = path.join(STATE_DIR, "config.json");
const STATUS_KEY = "output-gate";
const GLOBAL_KEY = "__pi_output_contract_gate_state__";
const REPAIR_SENTINEL = "[[output-contract-gate repair ";
const DEFAULT_CONTRACT =
  process.env.PI_OUTPUT_CONTRACT_FILE ||
  path.join(HOME, "devel", "specs", "drafts", "contract-enforced-agent-output-pipeline.example.edn");
const OUTPUT_GATE_DIST = path.join(HOME, "devel", "packages", "output-contract-gate", "dist", "index.js");

type GateConfig = {
  enabled: boolean;
  autoRepair: boolean;
  contractPath: string;
  // Phase 4: GPT review integration
  enableGptReview?: boolean;
  gptReviewModel?: string;
  gptReviewBaseUrl?: string;
  gptReviewApiKey?: string;
  maxSessionTurns?: number;
};

type GateState = {
  config: GateConfig;
  runtime?: any;
  contractCache?: {
    path: string;
    mtimeMs: number;
    source: string;
    contract: any;
  };
  lastResult?: any;
  contractError?: string;
};

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendJsonl(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(value) + "\n", "utf8");
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block) => block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string")
    .map((block) => (block as any).text)
    .join("");
}

function extractMessages(ctx: any) {
  return ctx.sessionManager
    .getBranch()
    .filter((entry: any) => entry?.type === "message" && entry.message)
    .map((entry: any) => entry.message);
}

function lastMessageByRole(ctx: any, role: string) {
  const messages = extractMessages(ctx);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === role) return messages[i];
  }
  return undefined;
}

function readConfig(): GateConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return {
        enabled: true,
        autoRepair: true,
        contractPath: DEFAULT_CONTRACT,
        enableGptReview: false,
        gptReviewModel: "gpt-5.4",
        maxSessionTurns: 10,
      };
    }
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return {
      enabled: parsed?.enabled !== false,
      autoRepair: parsed?.autoRepair !== false,
      contractPath:
        typeof parsed?.contractPath === "string" && parsed.contractPath.trim().length > 0
          ? parsed.contractPath
          : DEFAULT_CONTRACT,
      enableGptReview: parsed?.enableGptReview === true,
      gptReviewModel: typeof parsed?.gptReviewModel === "string" ? parsed.gptReviewModel : "gpt-5.4",
      gptReviewBaseUrl: typeof parsed?.gptReviewBaseUrl === "string" ? parsed.gptReviewBaseUrl : undefined,
      gptReviewApiKey: typeof parsed?.gptReviewApiKey === "string" ? parsed.gptReviewApiKey : undefined,
      maxSessionTurns: typeof parsed?.maxSessionTurns === "number" ? parsed.maxSessionTurns : 10,
    };
  } catch {
    return {
      enabled: true,
      autoRepair: true,
      contractPath: DEFAULT_CONTRACT,
      enableGptReview: false,
      gptReviewModel: "gpt-5.4",
      maxSessionTurns: 10,
    };
  }
}

function writeConfig(config: GateConfig) {
  ensureDir(STATE_DIR);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function getState(): GateState {
  const globalAny = globalThis as any;
  if (!globalAny[GLOBAL_KEY]) {
    globalAny[GLOBAL_KEY] = {
      config: readConfig(),
    } as GateState;
  }
  return globalAny[GLOBAL_KEY] as GateState;
}

async function loadRuntime(state: GateState) {
  if (state.runtime) return state.runtime;
  if (!fs.existsSync(OUTPUT_GATE_DIST)) {
    throw new Error(`output-contract-gate dist not found: ${OUTPUT_GATE_DIST}`);
  }
  const mod = await import(pathToFileURL(OUTPUT_GATE_DIST).href);
  state.runtime = mod;
  return mod;
}

async function loadContract(state: GateState) {
  const contractPath = path.resolve(state.config.contractPath);
  if (!fs.existsSync(contractPath)) {
    throw new Error(`contract file not found: ${contractPath}`);
  }

  const stat = fs.statSync(contractPath);
  if (
    state.contractCache &&
    state.contractCache.path === contractPath &&
    state.contractCache.mtimeMs === stat.mtimeMs
  ) {
    return state.contractCache;
  }

  const runtime = await loadRuntime(state);
  const source = fs.readFileSync(contractPath, "utf8");
  const contract = runtime.compileAgentOutputContract(source);
  state.contractCache = {
    path: contractPath,
    mtimeMs: stat.mtimeMs,
    source,
    contract,
  };
  return state.contractCache;
}

function parseRepairAttempt(text: string | undefined) {
  if (!text || !text.startsWith(REPAIR_SENTINEL)) return undefined;
  const match = text.match(/^\[\[output-contract-gate repair (\d+)\/(\d+)\]\]/);
  if (!match) return undefined;
  return {
    attempt: Number(match[1]),
    max: Number(match[2]),
  };
}

function buildRepairTurnMessage(repairPrompt: string, attempt: number, max: number) {
  return [
    `[[output-contract-gate repair ${attempt}/${max}]]`,
    "Repair your last response to satisfy the active output contract.",
    "Preserve all passing content and return the full corrected Markdown response only.",
    "",
    repairPrompt,
  ].join("\n");
}

function buildPromptAppend(contract: any) {
  const headings = contract.sections.map((section: any) => section.heading).join(", ");
  const nextRule = contract.rules.find((rule: any) => rule.id === "rule/next-exactly-one-action");
  const framesRule = contract.rules.find((rule: any) => rule.id === "rule/frames-cardinality");

  return [
    "## Active Output Contract",
    `- Return Markdown with these exact level-2 headings in order: ${headings}`,
    nextRule?.exactly != null ? `- Next must contain exactly ${nextRule.exactly} concrete next action.` : undefined,
    framesRule?.min != null && framesRule?.max != null
      ? `- Frames must contain ${framesRule.min}–${framesRule.max} plausible interpretations.`
      : undefined,
    "- If your response fails the structure gate, you will be asked to repair it.",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatStatus(state: GateState) {
  if (state.contractError) {
    return `gate:error`;
  }
  const mode = state.config.enabled ? "on" : "off";
  const repair = state.config.autoRepair ? "repair:on" : "repair:off";
  const last = state.lastResult
    ? ` last:${state.lastResult.ok ? "pass" : "fail"}/${state.lastResult.failureCount ?? 0}`
    : "";
  return `gate:${mode} ${repair}${last}`;
}

function setStatus(ctx: any, state: GateState) {
  if (!ctx?.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, formatStatus(state));
}

async function validateLatestAssistant(ctx: any, state: GateState) {
  const runtime = await loadRuntime(state);
  const cached = await loadContract(state);
  const assistant = lastMessageByRole(ctx, "assistant");
  const user = lastMessageByRole(ctx, "user");

  if (!assistant) {
    return { ok: false, error: "no assistant message found" };
  }

  const assistantText = extractText(assistant.content);
  if (!assistantText.trim()) {
    return { ok: false, error: "assistant message has no text content" };
  }

  const document = runtime.extractMarkdownSections(assistantText);
  const validation = runtime.validateMarkdownResponse(cached.contract, assistantText);
  const report = runtime.toFailureReport(cached.contract, validation);
  const repairPrompt = validation.ok ? undefined : runtime.compileRepairPrompt(cached.contract, validation);
  const bundle = await runtime.writeRunArtifacts({
    artifactsRoot: RUNS_DIR,
    contractPath: cached.path,
    responsePath: `session:${ctx.sessionManager.getSessionFile() ?? "ephemeral"}:assistant:${assistant.id ?? "unknown"}`,
    contractSource: cached.source,
    responseMarkdown: assistantText,
    contract: cached.contract,
    document,
    report,
    repairPrompt,
    exitCode: validation.ok ? 0 : 1,
  });

  let review;
  let reviewArtifacts;
  if (validation.ok) {
    if (state.config.enableGptReview) {
      const sessionMessages = extractMessages(ctx);
      const sessionHistory = sessionMessages.slice(-(state.config.maxSessionTurns ?? 10)).map((msg: any) => ({
        role: msg.role as "user" | "assistant",
        content: extractText(msg.content),
      }));
      try {
        review = await runtime.buildGptReviewReport(cached.contract, assistantText, report, {
          model: state.config.gptReviewModel,
          baseUrl: state.config.gptReviewBaseUrl,
          apiKey: state.config.gptReviewApiKey,
          sessionHistory,
          maxSessionTurns: state.config.maxSessionTurns,
          fallbackToStub: true,
        });
      } catch (gptError: any) {
        // Fall back to stub on any error
        review = runtime.buildStubReviewReport(cached.contract, assistantText, report);
        if (ctx.hasUI) {
          ctx.ui.notify(`GPT review failed (${gptError.message}), using stub review`, "warn");
        }
      }
    } else {
      review = runtime.buildStubReviewReport(cached.contract, assistantText, report);
    }
    reviewArtifacts = await runtime.writeReviewArtifacts(bundle.dir, review);
  }

  const repairInfo = parseRepairAttempt(extractText(user?.content));
  const summary = {
    ts: new Date().toISOString(),
    ok: validation.ok,
    failureCount: report.failures.length,
    assistantMessageId: assistant.id,
    userMessageId: user?.id,
    repairAttempt: repairInfo?.attempt ?? 0,
    bundleDir: bundle.dir,
    contract: {
      name: cached.contract.name,
      version: cached.contract.version,
      path: cached.path,
    },
    reviewOk: review?.ok,
    reviewScore: review?.overallScore,
  };

  appendJsonl(VALIDATIONS_FILE, summary);
  state.lastResult = summary;
  state.contractError = undefined;

  return {
    ok: validation.ok,
    validation,
    report,
    repairPrompt,
    review,
    bundle,
    reviewArtifacts,
    repairInfo,
    assistant,
    user,
    contract: cached.contract,
  };
}

function statusLines(state: GateState) {
  return [
    `enabled: ${state.config.enabled}`,
    `autoRepair: ${state.config.autoRepair}`,
    `contract: ${state.config.contractPath}`,
    `gptReview: ${state.config.enableGptReview ? "on" : "off"}`,
    state.lastResult ? `last ok: ${state.lastResult.ok}` : "last ok: n/a",
    state.lastResult ? `last failureCount: ${state.lastResult.failureCount}` : "last failureCount: n/a",
    state.lastResult?.reviewOk !== undefined ? `last reviewOk: ${state.lastResult.reviewOk}` : undefined,
    state.lastResult?.reviewScore !== undefined ? `last reviewScore: ${state.lastResult.reviewScore.toFixed(2)}` : undefined,
    state.lastResult?.bundleDir ? `last bundle: ${state.lastResult.bundleDir}` : "last bundle: n/a",
    state.contractError ? `error: ${state.contractError}` : undefined,
  ].filter(Boolean);
}

export default function outputContractGateExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const state = getState();
    state.config = readConfig();
    try {
      await loadRuntime(state);
      await loadContract(state);
      state.contractError = undefined;
    } catch (error: any) {
      state.contractError = error?.message ?? String(error);
      if (ctx.hasUI) {
        ctx.ui.notify(`output-contract-gate: ${state.contractError}`, "warn");
      }
    }
    setStatus(ctx, state);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const state = getState();
    if (!state.config.enabled) return;

    try {
      const cached = await loadContract(state);
      state.contractError = undefined;
      return {
        systemPrompt: `${event.systemPrompt}\n\n${buildPromptAppend(cached.contract)}`,
      };
    } catch (error: any) {
      state.contractError = error?.message ?? String(error);
      setStatus(ctx, state);
      return;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const state = getState();
    if (!state.config.enabled) {
      setStatus(ctx, state);
      return;
    }

    try {
      const result = await validateLatestAssistant(ctx, state);
      setStatus(ctx, state);
      if (!result.ok) {
        const currentAttempt = result.repairInfo?.attempt ?? 0;
        const maxRetries = result.contract?.repairMaxRetries ?? 0;

        if (state.config.autoRepair && result.repairPrompt && currentAttempt < maxRetries) {
          const nextAttempt = currentAttempt + 1;
          const msg = buildRepairTurnMessage(result.repairPrompt, nextAttempt, maxRetries);
          pi.sendUserMessage(msg);
          if (ctx.hasUI) {
            ctx.ui.notify(
              `output-contract-gate queued repair ${nextAttempt}/${maxRetries}`,
              "warn",
            );
          }
          return;
        }

        if (ctx.hasUI) {
          ctx.ui.notify(
            `output-contract-gate failed (${result.report.failures.length} structural violation${result.report.failures.length === 1 ? "" : "s"})`,
            "warn",
          );
        }
        return;
      }

      if (result.repairInfo?.attempt && ctx.hasUI) {
        ctx.ui.notify(
          `output-contract-gate repaired output in ${result.repairInfo.attempt} attempt${result.repairInfo.attempt === 1 ? "" : "s"}`,
          "success",
        );
      }
    } catch (error: any) {
      state.contractError = error?.message ?? String(error);
      setStatus(ctx, state);
      if (ctx.hasUI) {
        ctx.ui.notify(`output-contract-gate error: ${state.contractError}`, "warn");
      }
    }
  });

  pi.registerCommand("output-gate", {
    description: "Manage the output contract gate (/output-gate status|on|off|gpt-review|validate-last|repair-last|contract <path>)",
    handler: async (args, ctx) => {
      const state = getState();
      const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
      const cmd = tokens[0] || "status";

      if (cmd === "status") {
        if (ctx.hasUI) ctx.ui.setWidget("output-gate", statusLines(state));
        return;
      }

      if (cmd === "on" || cmd === "enable") {
        state.config.enabled = true;
        writeConfig(state.config);
        setStatus(ctx, state);
        ctx.ui.notify("output-contract-gate enabled", "success");
        return;
      }

      if (cmd === "off" || cmd === "disable") {
        state.config.enabled = false;
        writeConfig(state.config);
        setStatus(ctx, state);
        ctx.ui.notify("output-contract-gate disabled", "warn");
        return;
      }

      if (cmd === "contract") {
        const nextPath = tokens.slice(1).join(" ").trim();
        if (!nextPath) {
          ctx.ui.notify(`Current contract: ${state.config.contractPath}`, "info");
          return;
        }
        state.config.contractPath = path.resolve(nextPath);
        writeConfig(state.config);
        state.contractCache = undefined;
        await loadContract(state);
        state.contractError = undefined;
        setStatus(ctx, state);
        ctx.ui.notify(`output-contract-gate contract set to ${state.config.contractPath}`, "success");
        return;
      }

      if (cmd === "gpt-review") {
        const subCmd = tokens[1];
        if (subCmd === "on" || subCmd === "enable") {
          state.config.enableGptReview = true;
          writeConfig(state.config);
          setStatus(ctx, state);
          ctx.ui.notify("GPT review enabled (will call gpt-5.4 for semantic review after structure passes)", "success");
          return;
        }
        if (subCmd === "off" || subCmd === "disable") {
          state.config.enableGptReview = false;
          writeConfig(state.config);
          setStatus(ctx, state);
          ctx.ui.notify("GPT review disabled (using stub reviewer)", "info");
          return;
        }
        if (subCmd === "model") {
          const model = tokens[2];
          if (!model) {
            ctx.ui.notify(`Current GPT review model: ${state.config.gptReviewModel ?? "gpt-5.4"}`, "info");
            return;
          }
          state.config.gptReviewModel = model;
          writeConfig(state.config);
          ctx.ui.notify(`GPT review model set to ${model}`, "success");
          return;
        }
        ctx.ui.notify("Usage: /output-gate gpt-review on|off|model <id>", "warn");
        return;
      }

      if (cmd === "validate-last") {
        const result = await validateLatestAssistant(ctx, state);
        setStatus(ctx, state);
        if (ctx.hasUI) {
          ctx.ui.setWidget(
            "output-gate",
            [
              ...statusLines(state),
              "",
              `validation ok: ${result.ok}`,
              `bundle: ${result.bundle?.dir ?? "n/a"}`,
              ...(result.report?.failures?.map((failure: any) => `- ${failure.ruleId}: ${failure.message}`) ?? []),
            ],
          );
        }
        return;
      }

      if (cmd === "repair-last") {
        const result = await validateLatestAssistant(ctx, state);
        setStatus(ctx, state);
        if (result.ok) {
          ctx.ui.notify("Latest assistant response already satisfies the contract", "success");
          return;
        }
        const currentAttempt = result.repairInfo?.attempt ?? 0;
        const maxRetries = result.contract?.repairMaxRetries ?? 0;
        if (!result.repairPrompt || currentAttempt >= maxRetries) {
          ctx.ui.notify("Cannot queue repair: retry budget exhausted", "warn");
          return;
        }
        const nextAttempt = currentAttempt + 1;
        pi.sendUserMessage(buildRepairTurnMessage(result.repairPrompt, nextAttempt, maxRetries));
        ctx.ui.notify(`Queued repair ${nextAttempt}/${maxRetries}`, "info");
        return;
      }

      ctx.ui.notify("Unknown /output-gate command. Use status|on|off|gpt-review|validate-last|repair-last|contract <path>", "warn");
    },
  });

  pi.registerTool({
    name: "output_contract_gate",
    label: "Output Contract Gate",
    description: "Inspect the active pi output contract gate and validate the latest assistant response.",
    promptSnippet: "Inspect output contract gate status or validate the latest assistant response.",
    promptGuidelines: [
      "Use action=status to inspect whether automatic response contract enforcement is enabled.",
      "Use action=validate_last to run the structure gate against the latest assistant response and get the latest bundle/report path.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("validate_last"),
      ]),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      if (params.action === "status") {
        return {
          content: [{ type: "text", text: statusLines(state).join("\n") }],
          details: { config: state.config, lastResult: state.lastResult, contractError: state.contractError },
        };
      }

      const result = await validateLatestAssistant(ctx, state);
      setStatus(ctx, state);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: result.ok,
                bundleDir: result.bundle?.dir,
                reviewOk: result.review?.ok,
                reviewScore: result.review?.overallScore,
                failures: result.report?.failures ?? [],
              },
              null,
              2,
            ),
          },
        ],
        details: {
          ok: result.ok,
          bundle: result.bundle,
          report: result.report,
          review: result.review,
        },
      };
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
