// Coucou ↔ OpenCode plugin.
//
// Mochi lives in the MacBook notch (or at the top of the screen on Windows) and
// watches your coding-agent sessions. Claude Code talks to Coucou through a hook
// relay (`nb-hook` / `coucou-hook.exe`); this plugin gives OpenCode the same
// live view — sessions, steps, approvals — by feeding the same relay.
//
// One file supports both OpenCode generations:
//   * OpenCode 1 calls `server()` and uses the returned V1 hooks.
//   * OpenCode 2 reads `id` and `setup()`.
// See https://opencode.ai/v2/docs/build/plugins/migrate-v1
//
// Hard rule, same as the Claude Code relay: **never block OpenCode.** Every
// network/relay step is wrapped so a missing or wedged Coucou costs the agent
// nothing. A permission Coucou does not answer is handed back to OpenCode as
// "ask", which is exactly what would have happened without the plugin.
//
// Install: Coucou writes this file to
//   %USERPROFILE%\.config\opencode\plugins\coucou.ts   (Windows)
//   ~/.config/opencode/plugins/coucou.ts               (macOS / Linux)
// where OpenCode loads it automatically. To point at a Coucou built elsewhere,
// set COUCOU_HOOK to the relay executable path.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const SOURCE = "opencode"

/** Tools Coucou gates by default: bash commands, file edits, web fetches. */
export const DEFAULT_GATE = ["bash", "edit", "webfetch"]

/** How long to wait for a human before handing the prompt back to OpenCode. */
const DECISION_TIMEOUT_MS = 118_000
/** Fire-and-forget budget. Beyond this the relay is not worth waiting for. */
const NOTIFY_TIMEOUT_MS = 800

// ── Payloads ──────────────────────────────────────────────────────────────────
// The relay speaks Claude Code's hook shape; the app already knows how to read
// it. `source` tells the app this is OpenCode, not a VS Code Claude session.

export type CoucouPayload = {
  hook_event_name: string
  source: typeof SOURCE
  /** Display name the app shows for this agent. */
  agent?: string
  /** Model id, when the session has told us one. */
  model?: string
  session_id?: string
  cwd?: string
  prompt?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  message?: string
  [key: string]: unknown
}

/** What the island calls this agent. Claude Code hooks never send one. */
export const AGENT_NAME = "OpenCode"

// OpenCode tool ids are lowercase; Coucou's step labels are keyed by Claude Code
// names. `argKey` names the single field Coucou shows next to the label.
const TOOLS: Record<string, { name: string; argKey: string }> = {
  bash: { name: "Bash", argKey: "command" },
  read: { name: "Read", argKey: "file_path" },
  write: { name: "Write", argKey: "file_path" },
  edit: { name: "Edit", argKey: "file_path" },
  patch: { name: "MultiEdit", argKey: "file_path" },
  multiedit: { name: "MultiEdit", argKey: "file_path" },
  glob: { name: "Glob", argKey: "pattern" },
  grep: { name: "Grep", argKey: "pattern" },
  list: { name: "LS", argKey: "path" },
  ls: { name: "LS", argKey: "path" },
  webfetch: { name: "WebFetch", argKey: "url" },
  websearch: { name: "WebSearch", argKey: "query" },
  task: { name: "Task", argKey: "prompt" },
  todowrite: { name: "TodoWrite", argKey: "" },
  todoread: { name: "TodoRead", argKey: "" },
}

export function normalizeTool(tool: unknown): { name: string; argKey: string } {
  const key = typeof tool === "string" ? tool.toLowerCase() : ""
  const known = TOOLS[key]
  if (known) return known
  return { name: typeof tool === "string" && tool ? tool : "Tool", argKey: "" }
}

/** Picks the most identifying string out of a tool's arguments. */
export function normalizeToolInput(tool: unknown, args: unknown): Record<string, unknown> {
  const { argKey } = normalizeTool(tool)
  if (!args || typeof args !== "object") return {}
  const source = args as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (argKey) {
    // OpenCode spells the file argument `filePath`; Coucou reads `file_path`.
    const value = source[argKey] ?? (argKey === "file_path" ? source.filePath : undefined)
    if (value !== undefined) out[argKey] = value
  }
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "prompt", "description"]) {
    if (out[key] === undefined && typeof source[key] === "string") out[key] = source[key]
  }
  // `filePath` is the one OpenCode key worth translating even when unmapped.
  if (out.file_path === undefined && typeof source.filePath === "string") out.file_path = source.filePath
  return out
}

function base(event: string, sessionID: unknown, cwd: unknown): CoucouPayload {
  return {
    hook_event_name: event,
    source: SOURCE,
    agent: AGENT_NAME,
    session_id: typeof sessionID === "string" ? sessionID : undefined,
    cwd: typeof cwd === "string" ? cwd : undefined,
  }
}

export function userPromptPayload(sessionID: unknown, text: unknown, cwd: string): CoucouPayload {
  return { ...base("UserPromptSubmit", sessionID, cwd), prompt: typeof text === "string" ? text : "" }
}

export function toolBeforePayload(tool: unknown, args: unknown, sessionID: unknown, cwd: string): CoucouPayload {
  return { ...base("PreToolUse", sessionID, cwd), tool_name: normalizeTool(tool).name, tool_input: normalizeToolInput(tool, args) }
}

export function toolAfterPayload(tool: unknown, failed: boolean, sessionID: unknown, cwd: string): CoucouPayload {
  return base(failed ? "PostToolUseFailure" : "PostToolUse", sessionID, cwd)
}

export function permissionPayload(tool: unknown, pattern: unknown, sessionID: unknown, cwd: string, title?: unknown): CoucouPayload {
  const { name, argKey } = normalizeTool(tool)
  const shown = typeof title === "string" && title ? title : Array.isArray(pattern) ? pattern.join(", ") : pattern
  const input: Record<string, unknown> = {}
  if (typeof shown === "string" && shown) {
    // macOS reads `command` for the approval card, whatever the tool is.
    input.command = shown
    if (argKey && argKey !== "command") input[argKey] = shown
  }
  return {
    ...base("PermissionRequest", sessionID, cwd),
    tool_name: name,
    tool_input: input,
    permission_title: typeof title === "string" ? title : undefined,
  }
}

// ── Events ────────────────────────────────────────────────────────────────────

function eventInfo(event: any): { type: string; sessionID?: string; cwd?: string; status?: any } {
  const type = typeof event?.type === "string" ? event.type : ""
  const props = event?.properties ?? event ?? {}
  const info = props.info ?? props.session ?? {}
  const sessionID = info.id ?? props.sessionID ?? event?.sessionID ?? props.session?.id
  const cwd = info.directory ?? props.cwd ?? event?.cwd
  return { type, sessionID: typeof sessionID === "string" ? sessionID : undefined, cwd: typeof cwd === "string" ? cwd : undefined, status: props.status }
}

const RATE_LIMIT = /rate.?limit|429|quota|too many requests/i

/** Maps an OpenCode server event to a Coucou hook payload, or null to ignore. */
export function eventPayload(raw: unknown, fallbackCwd: string): CoucouPayload | null {
  const { type, sessionID, cwd, status } = eventInfo(raw)
  const dir = cwd ?? fallbackCwd
  switch (type) {
    case "session.created":
      return base("SessionStart", sessionID, dir)
    case "session.deleted":
      return base("SessionEnd", sessionID, dir)
    case "session.idle":
      return base("Stop", sessionID, dir)
    case "session.error":
      return base("StopFailure", sessionID, dir)
    case "session.status": {
      if (status?.type !== "retry") return null
      const message = typeof status.message === "string" ? status.message : "Retrying"
      // The app only raises the rate-limit state when the word is present.
      return { ...base("Notification", sessionID, dir), message: RATE_LIMIT.test(message) ? `rate limit: ${message}` : message }
    }
    default:
      return null
  }
}

/** An OpenCode question (`question.asked`) as a payload the island can show. */
export function questionPayload(raw: unknown): CoucouPayload | null {
  const event: any = raw
  if (event?.type !== "question.asked") return null
  const props: any = event.properties ?? {}
  const questions = Array.isArray(props.questions) ? props.questions : []
  const first = questions[0]
  if (!first) return null
  const text =
    typeof first.question === "string" && first.question ? first.question : String(first.header ?? "Question")
  const options = Array.isArray(first.options)
    ? first.options
        .map((option: any) => ({
          label: typeof option?.label === "string" ? option.label : "",
          description: typeof option?.description === "string" ? option.description : "",
        }))
        .filter((option: { label: string }) => option.label)
        .slice(0, 6)
    : []
  return {
    hook_event_name: "Question",
    source: SOURCE,
    agent: AGENT_NAME,
    session_id: typeof props.sessionID === "string" ? props.sessionID : undefined,
    request_id: typeof props.id === "string" ? props.id : undefined,
    message: text.slice(0, 160),
    question_options: options,
    question_multiple: first.multiple === true,
  }
}

/** `question.replied` / `question.rejected`: the island can drop the card. */
export function questionEndPayload(raw: unknown): CoucouPayload | null {
  const event: any = raw
  if (event?.type !== "question.replied" && event?.type !== "question.rejected") return null
  const props: any = event.properties ?? {}
  if (typeof props.requestID !== "string") return null
  return {
    hook_event_name: "QuestionEnd",
    source: SOURCE,
    session_id: typeof props.sessionID === "string" ? props.sessionID : undefined,
    request_id: props.requestID,
  }
}
/** The model behind an assistant message, when the event carries one. */
export function modelFromEvent(raw: unknown): string | undefined {
  const props: any = (raw as any)?.properties ?? raw ?? {}
  const info: any = props?.info ?? props?.message ?? props
  const id = info?.modelID ?? info?.model?.modelID ?? info?.model?.id
  return typeof id === "string" && id ? id : undefined
}

/**
 * Sends a question to Coucou and, if the user answers from the island, replies
 * in OpenCode. The relay blocks until Coucou answers (or the terminal wins), so
 * this runs in the background and never delays the event stream.
 */
async function answerQuestionFromIsland(payload: CoucouPayload, client: any, directory: string): Promise<void> {
  if (!payload.request_id) return
  const answer = (await runRelay(payload, DECISION_TIMEOUT_MS))?.trim()
  if (!answer) return // answered in the terminal, or nobody replied in time
  try {
    if (answer === "__dismiss__") {
      await client?.question?.reject?.({ requestID: payload.request_id, directory })
    } else {
      await client?.question?.reply?.({ requestID: payload.request_id, answers: [[answer]], directory })
    }
  } catch {
    // Older builds may not expose the question client; the terminal still works.
  }
}

/** Attaches the last model seen for the payload's session, if any. */
function stamp(payload: CoucouPayload, models: Map<string, string>): CoucouPayload {
  const id = payload.session_id
  const model = typeof id === "string" ? models.get(id) : undefined
  if (model) payload.model = model
  return payload
}

// ── Relay ─────────────────────────────────────────────────────────────────────
function relayCandidates(): string[] {
  const list: string[] = []
  if (process.env.COUCOU_HOOK) list.push(process.env.COUCOU_HOOK)
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local")
    list.push(path.join(local, "Coucou", "bin", "coucou-hook.exe"))
  } else if (process.platform === "darwin") {
    list.push(path.join(os.homedir(), "Library", "Application Support", "NotchBuddy", "nb-hook"))
    list.push(path.join(os.homedir(), ".claude", "coucou", "nb-hook"))
  } else {
    list.push(path.join(os.homedir(), ".config", "opencode", "coucou-hook"))
  }
  return list.filter((p): p is string => Boolean(p))
}

function relayExecutable(): string | null {
  return relayCandidates().find((candidate) => existsSync(candidate)) ?? null
}

/** Runs the relay and resolves with everything it printed, or null on failure. */
function runRelay(payload: CoucouPayload, waitMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const executable = relayExecutable()
    if (!executable) return resolve(null)

    const windows = process.platform === "win32"
    let child
    try {
      child = spawn(
        windows ? executable : "/bin/sh",
        windows ? [payload.hook_event_name] : [executable],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
      )
    } catch {
      return resolve(null)
    }

    let out = ""
    let settled = false
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        // already gone
      }
      resolve(value)
    }

    const timer = setTimeout(() => finish(out || null), waitMs)
    timer.unref?.()

    child.stdout?.on("data", (chunk) => {
      out += chunk.toString()
    })
    child.on("error", () => {
      clearTimeout(timer)
      finish(null)
    })
    child.on("close", () => {
      clearTimeout(timer)
      finish(out || null)
    })

    try {
      child.stdin?.end(JSON.stringify(payload) + "\n")
    } catch {
      clearTimeout(timer)
      finish(null)
    }
  })
}

/** Fire-and-forget: a tool step or a lifecycle event. */
export function notifyCoucou(payload: CoucouPayload): void {
  void runRelay(payload, NOTIFY_TIMEOUT_MS)
}

/** Reads the relay's Claude Code decision JSON. Empty output means "ask". */
export function claudeDecision(stdout: string | null): "allow" | "deny" | "ask" {
  const text = (stdout ?? "").trim()
  if (!text) return "ask"
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return "ask"
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    const behavior = parsed?.hookSpecificOutput?.decision?.behavior
    if (behavior === "allow") return "allow"
    if (behavior === "deny") return "deny"
  } catch {
    // fall through
  }
  return "ask"
}

async function askCoucou(payload: CoucouPayload): Promise<"allow" | "deny" | "ask"> {
  return claudeDecision(await runRelay(payload, DECISION_TIMEOUT_MS))
}

// ── T3 Code conversations ─────────────────────────────────────────────────────
// T3 Code keeps its threads and messages in ~/.t3/userdata/state.sqlite. When
// that database exists the plugin tails it read-only and forwards the
// conversation, so T3 threads appear in the island even when they run on a
// provider other than OpenCode.
//
// OpenCode already reports its own prompts and tool calls, so for threads whose
// provider is `opencode` only the assistant's replies are taken from here — the
// prompts would otherwise appear twice.

const T3_DB = (): string => path.join(os.homedir(), ".t3", "userdata", "state.sqlite")

const T3_QUERY = `
  select m.rowid as rowid, m.thread_id as thread_id, m.role as role, m.text as text,
         t.title as title, p.workspace_root as cwd, s.provider_name as provider
  from projection_thread_messages m
  left join projection_threads t on t.thread_id = m.thread_id
  left join projection_projects p on p.project_id = t.project_id
  left join projection_thread_sessions s on s.thread_id = m.thread_id
  where m.rowid > ? and m.role in ('user', 'assistant')
    and m.text is not null and length(trim(m.text)) > 0
  order by m.rowid asc
  limit 50
`

/** The island's threads tab: the most recent T3 conversations. */
const T3_THREADS_QUERY = `
  select t.thread_id as id, t.title as title, p.title as project, p.workspace_root as cwd,
         t.updated_at as updatedAt, s.provider_name as provider,
         (select m.role from projection_thread_messages m
           where m.thread_id = t.thread_id and m.role in ('user', 'assistant')
             and length(trim(coalesce(m.text, ''))) > 0
           order by m.rowid desc limit 1) as lastRole,
         (select m.text from projection_thread_messages m
           where m.thread_id = t.thread_id and m.role in ('user', 'assistant')
             and length(trim(coalesce(m.text, ''))) > 0
           order by m.rowid desc limit 1) as lastText
  from projection_threads t
  left join projection_projects p on p.project_id = t.project_id
  left join projection_thread_sessions s on s.thread_id = t.thread_id
  where t.deleted_at is null
  order by t.updated_at desc
  limit 20
`

export interface T3MessageRow {
  rowid: number
  thread_id: string
  role: string
  text: string
  title?: string | null
  cwd?: string | null
  provider?: string | null
}

function providerAgent(provider: string): string {
  switch (provider.toLowerCase()) {
    case "opencode":
      return "OpenCode"
    case "codex":
      return "Codex"
    case "claude":
    case "claude-code":
      return "Claude Code"
    default:
      return "T3 Code"
  }
}

/** Maps a T3 message row to a Coucou payload, or null to skip it. */
export function t3PayloadFromRow(row: T3MessageRow): CoucouPayload | null {
  const provider = String(row.provider ?? "")
  // OpenCode reports its own prompts; taking them from T3 as well would double them.
  if (row.role === "user" && provider === "opencode") return null
  const text = String(row.text ?? "").replace(/\s+/g, " ").trim()
  if (!text) return null
  const base: CoucouPayload = {
    hook_event_name: row.role === "user" ? "UserPromptSubmit" : "AgentMessage",
    source: "t3",
    agent: providerAgent(provider),
    session_id: typeof row.thread_id === "string" ? row.thread_id : undefined,
    cwd: typeof row.cwd === "string" ? row.cwd : undefined,
  }
  if (row.role === "user") base.prompt = text
  else base.message = text
  return base
}

interface T3Database {
  query?(sql: string): { all(...params: unknown[]): unknown[] }
  prepare?(sql: string): { all(...params: unknown[]): unknown[] }
  close?(): void
}

function t3Query(db: T3Database, sql: string, ...params: unknown[]): T3MessageRow[] {
  const rows = typeof db.query === "function" ? db.query(sql).all(...params) : db.prepare!(sql).all(...params)
  return (rows ?? []) as T3MessageRow[]
}

async function openT3Database(file: string): Promise<T3Database | null> {
  try {
    const { Database } = await import("bun:sqlite")
    return new Database(file, { readonly: true })
  } catch {
    // not Bun, or bun:sqlite unavailable
  }
  try {
    const { DatabaseSync } = await import("node:sqlite")
    return new DatabaseSync(file, { readOnly: true })
  } catch {
    return null
  }
}

export function t3ThreadsPayload(rows: unknown[]): CoucouPayload {
  const threads = (Array.isArray(rows) ? rows : []).map((row: any) => ({
    id: String(row?.id ?? ""),
    title: String(row?.title ?? ""),
    project: String(row?.project ?? ""),
    cwd: String(row?.cwd ?? ""),
    updatedAt: String(row?.updatedAt ?? ""),
    provider: String(row?.provider ?? ""),
    lastRole: String(row?.lastRole ?? ""),
    lastMessage: String(row?.lastText ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
  }))
  return {
    hook_event_name: "T3Threads",
    source: "t3",
    agent: "T3 Code",
    threads,
  }
}

/**
 * Starts tailing T3 Code's database. Returns a stop function; does nothing (and
 * costs nothing) when T3 Code is not installed. Every failure is swallowed: a
 * locked or half-migrated database must never affect OpenCode.
 */
export async function startT3Watcher(onPayload: (payload: CoucouPayload) => void): Promise<() => void> {
  const file = T3_DB()
  if (!existsSync(file)) return () => {}
  const db = await openT3Database(file)
  if (!db) return () => {}

  let last = 0
  let threadsKey = ""
  const publishThreads = () => {
    try {
      const rows = t3Query(db, T3_THREADS_QUERY)
      const key = rows.map((row) => `${row.id}:${row.updatedAt ?? ""}:${row.title ?? ""}`).join("|")
      if (key === threadsKey) return
      threadsKey = key
      onPayload(t3ThreadsPayload(rows))
    } catch {
      // locked or mid-migration — try again on the next tick
    }
  }
  try {
    const rows = t3Query(db, "select coalesce(max(rowid), 0) as rowid from projection_thread_messages")
    last = Number((rows[0] as { rowid?: number })?.rowid ?? 0)
  } catch {
    db.close?.()
    return () => {}
  }
  publishThreads()

  const seenThreads = new Set<string>()
  const timer = setInterval(() => {
    try {
      for (const row of t3Query(db, T3_QUERY, last)) {
        last = Math.max(last, Number(row.rowid) || last)
        if (row.thread_id && !seenThreads.has(row.thread_id)) {
          seenThreads.add(row.thread_id)
          // The thread's first sighting: let the island name the project.
          if (String(row.provider ?? "") !== "opencode") {
            onPayload({
              hook_event_name: "SessionStart",
              source: "t3",
              agent: providerAgent(String(row.provider ?? "")),
              session_id: row.thread_id,
              cwd: typeof row.cwd === "string" ? row.cwd : undefined,
            })
          }
        }
        const payload = t3PayloadFromRow(row)
        if (payload) onPayload(payload)
      }
    } catch {
      // locked or mid-migration — try again on the next tick
    }
    publishThreads()
  }, 2000)
  timer.unref?.()

  return () => {
    clearInterval(timer)
    try {
      db.close?.()
    } catch {
      // already closed
    }
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

function gateList(options: any): string[] {
  const gate = options?.gate
  if (gate === false) return []
  if (Array.isArray(gate)) return gate.filter((t) => typeof t === "string")
  return DEFAULT_GATE
}

/** V1 only: make OpenCode ask for the gated tools so Coucou can answer. */
function applyGate(config: any, gate: string[]): void {
  if (!config || typeof config !== "object" || gate.length === 0) return
  const permission = (config.permission = config.permission ?? {})
  for (const tool of gate) {
    if (permission[tool] === undefined) permission[tool] = "ask"
  }
}

type SessionCwd = { get: (id?: string) => string; set: (id: string | undefined, cwd: string | undefined) => void }

function sessionCwds(fallback: string): SessionCwd {
  const map = new Map<string, string>()
  return {
    get: (id) => (id && map.get(id)) || fallback,
    set: (id, cwd) => {
      if (id && cwd) map.set(id, cwd)
    },
  }
}

async function setupV2(ctx: any): Promise<() => void> {
  const directory = ctx?.location?.directory ?? process.cwd()
  const gate = gateList(ctx?.options)
  const cwds = sessionCwds(directory)
  const models = new Map<string, string>()
  const controller = new AbortController()
  const send = (payload: CoucouPayload) => notifyCoucou(stamp(payload, models))

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const info = eventInfo(event)
        cwds.set(info.sessionID, info.cwd)
        const model = modelFromEvent(event)
        if (info.sessionID && model) models.set(info.sessionID, model)
        const payload = eventPayload(event, directory)
        if (payload) {
          send(payload)
          continue
        }
        const question = questionPayload(event)
        if (question) {
          send(question)
          // The user may answer from the island; the relay blocks until they do.
          void answerQuestionFromIsland(question, ctx, directory)
          continue
        }
        const ended = questionEndPayload(event)
        if (ended) send(ended)
      }
    } catch {
      // Coucou is a nicety; a broken subscription must never surface to the agent.
    }
  })()

  await ctx.tool.hook("execute.before", (event: any) => {
    send(toolBeforePayload(event?.tool, event?.input, event?.sessionID, cwds.get(event?.sessionID)))
  })
  await ctx.tool.hook("execute.after", (event: any) => {
    send(toolAfterPayload(event?.tool, event?.status === "error", event?.sessionID, cwds.get(event?.sessionID)))
  })
  await ctx.session.hook("prompt", (event: any) => {
    const text = event?.prompt?.text
    const model = modelFromEvent(event)
    if (event?.sessionID && model) models.set(event.sessionID, model)
    if (typeof text === "string" && text) send(userPromptPayload(event?.sessionID, text, cwds.get(event?.sessionID)))
  })
  await ctx.permission.hook("evaluate", async (event: any) => {
    if (gate.length === 0 || !gate.includes(String(event?.action))) return
    const original = event.effect
    const decision = await askCoucou(
      stamp(permissionPayload(event?.action, event?.resources, event?.sessionID, cwds.get(event?.sessionID), event?.title), models),
    )
    if (decision === "allow") event.effect = "allow"
    else if (decision === "deny") event.effect = "deny"
    else if (decision === "ask") event.effect = "ask"
    else event.effect = original // Coucou unreachable — keep the user's rule.
  })

  const stopT3 = await startT3Watcher(send)

  return () => {
    controller.abort()
    stopT3()
  }
}

async function serverV1(input: any, options?: any): Promise<Record<string, unknown>> {
  const directory = input?.directory ?? process.cwd()
  const gate = gateList(options)
  const cwds = sessionCwds(directory)
  const models = new Map<string, string>()
  const send = (payload: CoucouPayload) => notifyCoucou(stamp(payload, models))
  const stopT3 = await startT3Watcher(send)

  return {
    dispose: async () => {
      stopT3()
    },
    config: async (config: any) => applyGate(config, gate),
    event: async ({ event }: any) => {
      const info = eventInfo(event)
      cwds.set(info.sessionID, info.cwd)
      const model = modelFromEvent(event)
      if (info.sessionID && model) models.set(info.sessionID, model)
      const payload = eventPayload(event, directory)
      if (payload) {
        send(payload)
        return
      }
      const question = questionPayload(event)
      if (question) {
        send(question)
        void answerQuestionFromIsland(question, input?.client, directory)
        return
      }
      const ended = questionEndPayload(event)
      if (ended) send(ended)
    },
    "chat.message": async (input2: any, output: any) => {
      const model = input2?.model?.modelID ?? input2?.model?.id
      if (input2?.sessionID && typeof model === "string" && model) models.set(input2.sessionID, model)
      const text = textFromParts(output?.parts)
      if (text) send(userPromptPayload(input2?.sessionID, text, cwds.get(input2?.sessionID)))
    },
    "tool.execute.before": async (input2: any, output: any) => {
      send(toolBeforePayload(input2?.tool, output?.args, input2?.sessionID, cwds.get(input2?.sessionID)))
    },
    "tool.execute.after": async (input2: any) => {
      send(toolAfterPayload(input2?.tool, false, input2?.sessionID, cwds.get(input2?.sessionID)))
    },
    "permission.ask": async (permission: any, output: any) => {
      const payload = permissionPayload(
        permission?.type ?? permission?.permission ?? "Tool",
        permission?.pattern ?? permission?.patterns,
        permission?.sessionID,
        cwds.get(permission?.sessionID),
        permission?.title,
      )
      const decision = await askCoucou(stamp(payload, models))
      if (decision === "allow") output.status = "allow"
      else if (decision === "deny") output.status = "deny"
      // "ask" is left untouched: OpenCode shows its own prompt.
    },
  }
}

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  for (const part of parts) {
    if (part && typeof part === "object") {
      const typed = part as { type?: unknown; text?: unknown }
      if (typed.type === "text" && typeof typed.text === "string" && typed.text) return typed.text
    }
  }
  return ""
}

const coucou: { id: string; setup: typeof setupV2; server: typeof serverV1 } = {
  id: "coucou",
  setup: setupV2,
  server: serverV1,
}

export default coucou
