import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test"
import { formatToolSummaryLine, formatTurnUsageLine, summarizeToolName } from "../src/bot.js"

describe("tool summary formatting", () => {
  it("normalizes raw tool names into compact summary categories", () => {
    expect(summarizeToolName("ls -la")).toBe("bash")
    expect(summarizeToolName("🔍 latest codex release")).toBe("web_fetch")
    expect(summarizeToolName("mcp:codex_apps/spawn_agent")).toBe("subagent")
    expect(summarizeToolName("mcp:codex_apps/github_fetch")).toBe("github_fetch")
    expect(summarizeToolName("file_change")).toBe("file_change")
  })

  it("formats a short summary line with grouped counts", () => {
    const toolCounts = new Map<string, number>([
      ["ls -la", 2],
      ["git status", 1],
      ["mcp:codex_apps/spawn_agent", 2],
      ["🔍 latest codex release", 1],
    ])

    expect(formatToolSummaryLine(toolCounts)).toBe("Tools used: 3x bash, 2x subagents, web_fetch")
  })

  it("keeps the turn usage line format stable when enabled", () => {
    expect(
      formatTurnUsageLine({
        inputTokens: { last: 68004, total: 142678 },
        cachedInputTokens: { last: 62848, total: 120000 },
        outputTokens: { last: 68, total: 900 },
      }),
    ).toBe("🪙 in: `5.2K`/`22.7K` · cached: `62.8K`/`120K` · out: `68`/`900`")
  })

  it("collapses turn usage totals when they match the last message", () => {
    expect(
      formatTurnUsageLine({
        inputTokens: { last: 12000, total: 12000 },
        cachedInputTokens: { last: 6528, total: 6528 },
        outputTokens: { last: 9, total: 30 },
      }),
    ).toBe("🪙 in: `5.5K` · cached: `6.5K` · out: `9`/`30`")
  })

  it("does not show negative uncached input when cached exceeds input", () => {
    expect(
      formatTurnUsageLine({
        inputTokens: { last: 100, total: 200 },
        cachedInputTokens: { last: 120, total: 250 },
        outputTokens: { last: 9, total: 30 },
      }),
    ).toBe("🪙 in: `0` · cached: `120`/`250` · out: `9`/`30`")
  })
})
