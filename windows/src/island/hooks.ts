// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type T3Thread } from "../core/state";
import type { Island } from "./island";

const CLAUDE_ID = "integration_claude";

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

/** The compact pill's transient step, cleared by the island's frame loop. */
function showCompactLine(text: string) {
  if (State.mode === "expanded" || State.paused) return;
  State.compactLine = text;
  State.compactLineAt = performance.now();
  State.notify();
}

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Options of an OpenCode question (`Question`). */
  question_options?: { label?: string; description?: string }[];
  /** Recent T3 Code conversations (`T3Threads`). */
  threads?: T3Thread[];
  /** Which agent sent this: the OpenCode plugin sets it, Claude Code doesn't. */
  agent?: string;
  /** Model: SessionStart's `model`, or PostModelSwitch's `to_model`. */
  model?: string;
  to_model?: string;
  /** The OpenCode plugin's marker; Claude Code's source is a session-start reason. */
  source?: string;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  coucou_agent?: string;
}

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
  // OpenCode sends lower-case tool ids; the plugin maps most of them, but a
  // fallback keeps an unmapped tool readable.
  bash: "Exécute",
  read: "Lit",
  write: "Écrit",
  edit: "Modifie",
  glob: "Cherche",
  grep: "Recherche",
  webfetch: "Récupère",
  websearch: "Recherche web",
  todowrite: "Tâches",
  task: "Agent",
  list: "Liste",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

function upsert(projectName: string, cwd: string, agent?: string, model?: string) {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.name = projectName;
  if (cwd) t.sessionCwd = cwd;
  // nil = Claude Code (its relay never sends `agent`); OpenCode sends its name.
  t.agentName = agent ?? null;
  t.agentModel = model ?? null;
}

function clearSession() {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = "Agent";
  t.pillBadge = null;
  t.agentName = null;
  t.agentModel = null;
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");
  // The OpenCode plugin names itself, or is recognised by its `source` marker.
  const agent = payload.agent ?? (payload.source === "opencode" ? "OpenCode" : undefined);
  const model = payload.model ?? payload.to_model;

  // Route to the right pill. Valid coucou_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code pill unchanged.
  const validAgent = validateAgent(payload.coucou_agent);
  const agentId = validAgent ? `agent_${validAgent}` : CLAUDE_ID;
  const isExternalAgent = validAgent !== null;

  const focused = State.focusId === agentId;

  // A pending question owns the island: another session working must not steal
  // its state — that is what used to make the question (and the floating blob)
  // vanish mid-question. An approval still takes over; it is a quick yes/no.
  const setState = (next: Parameters<typeof State.updateTask>[1]) => {
    if (State.pendingQuestion && next !== "question" && next !== "approval") return;
    State.updateTask(agentId, next);
  };

  // A step both lands in the ticker and, while the island is shrunk, flashes in
  // the pill for a couple of seconds so progress is visible.
  const noteStep = (text: string) => {
    State.appendStep(agentId, text);
    showCompactLine(text);
  };

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  /** Ensure the agent pill exists (no-op for Claude Code). */
  const ensurePill = () => {
    if (isExternalAgent) {
      State.upsertExternalAgent(agentId, validAgent!, agentColor(validAgent!));
    } else {
      upsert(projectName, cwd, agent, model);
    }
  };

  switch (name) {
    case "SessionStart":
      ensurePill();
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      setState("thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) noteStep(asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      ensurePill();
      setState("working");
      const tool = payload.tool_name ?? "Tool";
      noteStep(stepLabel(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      setState("working");
      break;

    case "PostToolUseFailure":
      setState("working");
      noteStep("⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        setState("ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        setState("question");
        noteStep(message);
      }
      break;
    }

    // The threads tab's data: the latest T3 conversations.
    case "T3Threads": {
      State.t3Threads = payload.threads ?? [];
      State.notify();
      break;
    }

    // An assistant reply (T3 Code conversations, forwarded by the watcher).
    case "AgentMessage": {
      ensurePill();
      setState("working");
      const reply = (payload.message ?? "").replace(/\s+/g, " ").trim();
      if (reply) noteStep(reply.slice(0, 90));
      break;
    }

    // The agent is asking something (OpenCode's question tool).
    case "Question": {
      ensurePill();
      State.pendingQuestion = {
        id: payload.request_id ?? "",
        text: payload.message ?? "A question needs an answer.",
        options: (payload.question_options ?? []).map((option) => ({
          label: option.label ?? "",
          description: option.description ?? "",
        })),
      };
      // "The card is up": the relay can keep waiting for a click.
      if (payload.request_id) void Bridge.approvalAck(payload.request_id);
      setState("question");
      State.isPinned = true;
      Sound.play("approval");
      island.alert("question");
      break;
    }

    // Answered or rejected, here or in the terminal: drop the card.
    case "QuestionEnd": {
      const pending = State.pendingQuestion;
      if (!pending) break;
      if (payload.request_id && pending.id && payload.request_id !== pending.id) break;
      State.pendingQuestion = null;
      State.isPinned = false;
      island.dropPin();
      setState("working");
      if (State.view === "question") island.setView(State.defaultView());
      break;
    }

    case "Stop":
      setState("finished");
      if (payload.message) noteStep(payload.message.slice(0, 60));
      Sound.play("finish");
      if (focused) surface("finished", true);
      else State.setPillBadge(agentId, "finished");
      window.setTimeout(() => {
        if (isExternalAgent) {
          State.removeTask(agentId);
        } else {
          setState("idle");
          State.setPillBadge(agentId, null);
        }
      }, 5200);
      break;

    case "StopFailure":
      setState("error");
      Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(agentId, "error");
      break;

    case "SessionEnd":
      if (isExternalAgent) {
        State.removeTask(agentId);
      } else {
        setState("idle");
        clearSession();
      }
      break;

    case "SubagentStart":
      noteStep("+ subagent");
      break;

    case "SubagentStop":
      noteStep("• subagent done");
      break;

    case "PermissionRequest": {
      // External agents do not get an approval card — showing one would look like
      // a Claude Code request. Decline immediately so the agent re-asks in its
      // terminal. Approval support for other agents will come with Codex support.
      if (isExternalAgent) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      upsert(projectName, cwd, agent, model);
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      State.pendingApproval = {
        requestId,
        sessionId: payload.session_id ?? "",
        tool,
        command: approvalTarget(tool, input),
      };
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      setState("approval");
      State.isPinned = true;
      Sound.play("approval");
      if (focused) {
        island.alert("approval");
      } else {
        // Another agent holds the view, so the card would yank it away. The badge
        // is the signal instead — but it has to be on screen for that to mean
        // anything, hence the reveal. We just told the relay a human can act.
        State.setPillBadge(CLAUDE_ID, "approval");
        island.reveal();
      }
      // Coucou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (!State.pendingApproval) return;
        State.pendingApproval = null;
        State.isPinned = false;
        island.dropPin();
        setState("working");
        State.setPillBadge(CLAUDE_ID, null);
        if (State.view === "approval") island.setView(State.defaultView());
        State.notify();
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}
