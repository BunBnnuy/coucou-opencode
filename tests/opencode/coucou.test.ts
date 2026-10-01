// Unit tests for the pure translation half of the Coucou OpenCode plugin.
// Run with: node --test tests/opencode/
//
// The relay and the plugin wiring are not exercised here — only the mapping
// between OpenCode events/permissions and the payload shape Coucou's hook relay
// already speaks. That mapping is where a field rename would silently break the
// integration, so it is the part worth pinning down.

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  claudeDecision,
  eventPayload,
  modelFromEvent,
  normalizeTool,
  normalizeToolInput,
  permissionPayload,
  questionEndPayload,
  questionPayload,
  t3PayloadFromRow,
  t3ThreadsPayload,
  toolAfterPayload,
  toolBeforePayload,
  userPromptPayload,
} from "../../NotchBuddy/Resources/opencode/coucou.ts"

test("session.created becomes SessionStart with the session directory", () => {
  const payload = eventPayload(
    { type: "session.created", properties: { info: { id: "ses_1", directory: "/work/coucou" } } },
    "/fallback",
  )
  assert.equal(payload?.hook_event_name, "SessionStart")
  assert.equal(payload?.session_id, "ses_1")
  assert.equal(payload?.cwd, "/work/coucou")
  assert.equal(payload?.source, "opencode")
})

test("session.lifecycle events map to Stop / StopFailure / SessionEnd", () => {
  assert.equal(eventPayload({ type: "session.idle", properties: { sessionID: "s" } }, "/f")?.hook_event_name, "Stop")
  assert.equal(eventPayload({ type: "session.error", properties: { sessionID: "s" } }, "/f")?.hook_event_name, "StopFailure")
  assert.equal(eventPayload({ type: "session.deleted", properties: { info: { id: "s" } } }, "/f")?.hook_event_name, "SessionEnd")
})

test("a retry carrying a rate limit becomes a rate-limit notification", () => {
  const payload = eventPayload(
    { type: "session.status", properties: { sessionID: "s", status: { type: "retry", message: "429 Too Many Requests" } } },
    "/f",
  )
  assert.equal(payload?.hook_event_name, "Notification")
  assert.match(String(payload?.message), /rate limit/i)
})

test("a plain retry is ignored (neither rate limit nor a question)", () => {
  const payload = eventPayload(
    { type: "session.status", properties: { sessionID: "s", status: { type: "retry", message: "connection reset" } } },
    "/f",
  )
  assert.equal(payload?.hook_event_name, "Notification")
  assert.doesNotMatch(String(payload?.message), /rate limit/i)
})

test("unrelated events are dropped", () => {
  assert.equal(eventPayload({ type: "message.updated", properties: {} }, "/f"), null)
  assert.equal(eventPayload({ type: "session.status", properties: { status: { type: "busy" } } }, "/f"), null)
})

test("the cwd falls back to the plugin directory", () => {
  const payload = eventPayload({ type: "session.idle", properties: { sessionID: "s" } }, "/plugin/dir")
  assert.equal(payload?.cwd, "/plugin/dir")
})

test("every payload names the agent so the island can show it", () => {
  assert.equal(userPromptPayload("s", "hi", "/w").agent, "OpenCode")
  assert.equal(toolBeforePayload("bash", { command: "ls" }, "s", "/w").agent, "OpenCode")
  assert.equal(permissionPayload("bash", "ls", "s", "/w").agent, "OpenCode")
})

test("the model is read from an assistant message when present", () => {
  assert.equal(modelFromEvent({ type: "message.updated", properties: { info: { role: "assistant", modelID: "claude-opus-5" } } }), "claude-opus-5")
  assert.equal(modelFromEvent({ properties: { info: { model: { modelID: "gpt-5" } } } }), "gpt-5")
  assert.equal(modelFromEvent({ type: "session.idle", properties: { sessionID: "s" } }), undefined)
})

test("OpenCode tools map to the labels Coucou draws", () => {
  assert.equal(normalizeTool("bash").name, "Bash")
  assert.equal(normalizeTool("edit").name, "Edit")
  assert.equal(normalizeTool("webfetch").name, "WebFetch")
  assert.equal(normalizeTool("mystery-tool").name, "mystery-tool")
})

test("filePath is translated to file_path so the app can name the file", () => {
  const input = normalizeToolInput("edit", { filePath: "/work/coucou/README.md", oldString: "a" })
  assert.equal(input.file_path, "/work/coucou/README.md")
})

test("tool.execute.before becomes PreToolUse with the tool and its target", () => {
  const payload = toolBeforePayload("bash", { command: "npm test" }, "ses_1", "/work")
  assert.equal(payload.hook_event_name, "PreToolUse")
  assert.equal(payload.tool_name, "Bash")
  assert.deepEqual(payload.tool_input, { command: "npm test" })
})

test("a failed tool execution becomes PostToolUseFailure", () => {
  assert.equal(toolAfterPayload("bash", true, "s", "/w").hook_event_name, "PostToolUseFailure")
  assert.equal(toolAfterPayload("bash", false, "s", "/w").hook_event_name, "PostToolUse")
})

test("a user prompt carries the text so the ticker can show it", () => {
  const payload = userPromptPayload("ses_1", "fix the notch", "/work")
  assert.equal(payload.hook_event_name, "UserPromptSubmit")
  assert.equal(payload.prompt, "fix the notch")
})

test("a permission becomes PermissionRequest the app can render", () => {
  const payload = permissionPayload("bash", "rm -rf build", "ses_1", "/work")
  assert.equal(payload.hook_event_name, "PermissionRequest")
  assert.equal(payload.tool_name, "Bash")
  assert.deepEqual(payload.tool_input, { command: "rm -rf build" })
})

test("a V2-style permission using resources still renders a command", () => {
  const payload = permissionPayload("bash", ["git push origin main"], "ses_1", "/work")
  assert.equal(payload.tool_input?.command, "git push origin main")
})

test("an edit permission shows the file on the approval card", () => {
  const payload = permissionPayload("edit", "/work/coucou/README.md", "ses_1", "/work")
  assert.equal(payload.tool_name, "Edit")
  assert.equal(payload.tool_input?.command, "/work/coucou/README.md")
  assert.equal(payload.tool_input?.file_path, "/work/coucou/README.md")
})

test("a T3 assistant reply becomes an AgentMessage named after the provider", () => {
  const payload = t3PayloadFromRow({
    rowid: 1,
    thread_id: "thread-1",
    role: "assistant",
    text: "Done —  the   build is green.",
    cwd: "C:\\Users\\Admin\\projects\\coucou",
    provider: "opencode",
  })
  assert.equal(payload?.hook_event_name, "AgentMessage")
  assert.equal(payload?.source, "t3")
  assert.equal(payload?.agent, "OpenCode")
  assert.equal(payload?.session_id, "thread-1")
  assert.equal(payload?.cwd, "C:\\Users\\Admin\\projects\\coucou")
  assert.equal(payload?.message, "Done — the build is green.")
})

test("an OpenCode prompt from T3 is skipped — OpenCode already reported it", () => {
  const payload = t3PayloadFromRow({
    rowid: 2,
    thread_id: "t",
    role: "user",
    text: "hi",
    provider: "opencode",
  })
  assert.equal(payload, null)
})

test("a prompt from another provider becomes UserPromptSubmit", () => {
  const payload = t3PayloadFromRow({
    rowid: 3,
    thread_id: "t",
    role: "user",
    text: "fix it",
    provider: "codex",
  })
  assert.equal(payload?.hook_event_name, "UserPromptSubmit")
  assert.equal(payload?.prompt, "fix it")
  assert.equal(payload?.agent, "Codex")
})

test("a question.asked event becomes a Question with its options", () => {
  const payload = questionPayload({
    type: "question.asked",
    properties: {
      id: "q1",
      sessionID: "ses_1",
      questions: [
        {
          header: "Style",
          question: "Which output style do you want?",
          options: [{ label: "Diff", description: "Show diff block" }, { label: "Code" }],
          multiple: false,
        },
      ],
    },
  })
  assert.equal(payload?.hook_event_name, "Question")
  assert.equal(payload?.request_id, "q1")
  assert.equal(payload?.session_id, "ses_1")
  assert.equal(payload?.message, "Which output style do you want?")
  assert.deepEqual(payload?.question_options, [
    { label: "Diff", description: "Show diff block" },
    { label: "Code", description: "" },
  ])
})

test("question.replied and question.rejected both close the card", () => {
  for (const type of ["question.replied", "question.rejected"]) {
    const payload = questionEndPayload({ type, properties: { requestID: "q1", sessionID: "s" } })
    assert.equal(payload?.hook_event_name, "QuestionEnd")
    assert.equal(payload?.request_id, "q1")
  }
  assert.equal(questionEndPayload({ type: "session.idle", properties: {} }), null)
  assert.equal(questionPayload({ type: "question.replied", properties: {} }), null)
})

test("T3 threads become a T3Threads payload for the island tab", () => {
  const payload = t3ThreadsPayload([
    {
      id: "t1",
      title: "Fix the bug",
      project: "API",
      cwd: "C:\\work",
      updatedAt: "2026-10-01T12:00:00Z",
      provider: "opencode",
      lastRole: "assistant",
      lastText: "  Done —  the build is green.",
    },
  ])
  assert.equal(payload.hook_event_name, "T3Threads")
  assert.equal(payload.source, "t3")
  assert.deepEqual(payload.threads, [
    {
      id: "t1",
      title: "Fix the bug",
      project: "API",
      cwd: "C:\\work",
      updatedAt: "2026-10-01T12:00:00Z",
      provider: "opencode",
      lastRole: "assistant",
      lastMessage: "Done — the build is green.",
    },
  ])
})

test("the relay's Claude decision JSON is decoded", () => {  assert.equal(
    claudeDecision('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'),
    "allow",
  )
  assert.equal(claudeDecision('{"hookSpecificOutput":{"decision":{"behavior":"deny"}}}'), "deny")
})

test("an empty or unknown relay answer means ask — never an accidental allow", () => {
  assert.equal(claudeDecision(""), "ask")
  assert.equal(claudeDecision(null), "ask")
  assert.equal(claudeDecision("not json"), "ask")
  assert.equal(claudeDecision('{"ok":true}'), "ask")
  assert.equal(claudeDecision('{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}'), "allow")
})
