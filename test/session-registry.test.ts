import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createDefaultLaunchProfile, createLaunchProfile } from "../src/codex-launch.js"
import type { TeleCodexConfig } from "../src/config.js"

const mockSessionState = (() => {
  const create = vi.fn()
  const sessions: Array<{
    getInfo: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    isProcessing: ReturnType<typeof vi.fn>
    setInfo: (
      next: Partial<{
        threadId: string | null
        workspace: string
        model?: string
        reasoningEffort?: string
        launchProfileId: string
        launchProfileLabel: string
        launchProfileBehavior: string
        sandboxMode: string
        approvalPolicy: string
        unsafeLaunch: boolean
        nextLaunchProfileId?: string
        nextLaunchProfileLabel?: string
        nextLaunchProfileBehavior?: string
        nextUnsafeLaunch?: boolean
      }>,
    ) => void
  }> = []

  const reset = () => {
    create.mockReset()
    sessions.length = 0
  }

  return {
    create,
    sessions,
    reset,
  }
})()

import { SessionRegistry } from "../src/session-registry.js"

describe("SessionRegistry", () => {
  let tempWorkspace: string

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(tempWorkspace, { recursive: true, force: true })
  })

  const createConfig = (overrides: Partial<TeleCodexConfig> = {}): TeleCodexConfig => ({
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: tempWorkspace,
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: "codex-key",
    codexModel: "o3",
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "never",
    launchProfiles: [
      createDefaultLaunchProfile("workspace-write", "never"),
      createLaunchProfile({
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      }),
    ],
    defaultLaunchProfileId: "default",
    enableUnsafeLaunchProfiles: false,
    toolVerbosity: "summary",
    showLaunchBehavior: true,
    showLaunchProfile: true,
    showTurnTokenUsage: false,
    enableTelegramLogin: true,
    enableTelegramReactions: false,
    ...overrides,
  })

  const writePersistedContexts = (workspace: string, contexts: unknown[]): string => {
    const persistPath = path.join(workspace, ".telecodex", "contexts.json")
    mkdirSync(path.dirname(persistPath), { recursive: true })
    writeFileSync(persistPath, JSON.stringify(contexts))
    return persistPath
  }

  const createRegistry = (config = createConfig()) =>
    new SessionRegistry(config, {
      createSession: mockSessionState.create as any,
    })

  const createMockSession = (info: {
    threadId: string | null
    workspace: string
    model?: string
    reasoningEffort?: string
    launchProfileId: string
    launchProfileLabel: string
    launchProfileBehavior: string
    sandboxMode: string
    approvalPolicy: string
    unsafeLaunch: boolean
  }) => {
    let currentInfo = { ...info }
    const session = {
      getInfo: vi.fn(() => ({ ...currentInfo })),
      dispose: vi.fn(),
      isProcessing: vi.fn(() => false),
      setInfo: (next: Partial<typeof currentInfo>) => {
        currentInfo = { ...currentInfo, ...next }
      },
    }
    mockSessionState.sessions.push(session)
    return session
  }

  beforeEach(() => {
    tempWorkspace = mkdtempSync(path.join(tmpdir(), "telecodex-registry-"))
    mockSessionState.reset()
    mockSessionState.create.mockImplementation(
      async (
        config: TeleCodexConfig,
        options?: {
          workspace?: string
          model?: string
          reasoningEffort?: string
          launchProfileId?: string
          resumeThreadId?: string
        },
      ) =>
        createMockSession({
          threadId: options?.resumeThreadId ?? null,
          workspace: options?.workspace ?? config.workspace,
          model: options?.model ?? config.codexModel,
          reasoningEffort: options?.reasoningEffort,
          launchProfileId: options?.launchProfileId ?? config.defaultLaunchProfileId,
          launchProfileLabel: options?.launchProfileId === "readonly" ? "Read Only" : "Default",
          launchProfileBehavior:
            options?.launchProfileId === "readonly" ? "read-only / never" : "workspace-write / never",
          sandboxMode: options?.launchProfileId === "readonly" ? "read-only" : "workspace-write",
          approvalPolicy: "never",
          unsafeLaunch: false,
        }),
    )
  })

  it("returns the same session instance for the same context key", async () => {
    const registry = createRegistry()

    const first = await registry.getOrCreate("123")
    const second = await registry.getOrCreate("123")

    expect(first).toBe(second)
    expect(mockSessionState.create).toHaveBeenCalledTimes(1)
  })

  it("returns different session instances for different context keys", async () => {
    const registry = createRegistry()

    const first = await registry.getOrCreate("123")
    const second = await registry.getOrCreate("123:42")

    expect(first).not.toBe(second)
    expect(mockSessionState.create).toHaveBeenCalledTimes(2)
  })

  it("two topic contexts in the same chat maintain independent sessions", async () => {
    const registry = createRegistry()

    const first = await registry.getOrCreate("67890:1")
    const second = await registry.getOrCreate("67890:2")

    expect(first).not.toBe(second)
    expect(registry.has("67890:1")).toBe(true)
    expect(registry.has("67890:2")).toBe(true)
  })

  it("removing one topic context does not affect another in the same chat", async () => {
    const registry = createRegistry()

    await registry.getOrCreate("67890:1")
    await registry.getOrCreate("67890:2")
    registry.remove("67890:1")

    expect(registry.has("67890:1")).toBe(false)
    expect(registry.has("67890:2")).toBe(true)
  })

  it("restores distinct per-context workspace, model, reasoning effort, and thread ids", async () => {
    writePersistedContexts(tempWorkspace, [
      {
        contextKey: "123",
        threadId: "thread-a",
        workspace: "/workspace/a",
        model: "o4-mini",
        reasoningEffort: "low",
        launchProfileId: "readonly",
        updatedAt: 10,
      },
      {
        contextKey: "123:42",
        threadId: "thread-b",
        workspace: "/workspace/b",
        model: "gpt-5.4",
        reasoningEffort: "high",
        launchProfileId: "default",
        updatedAt: 20,
      },
    ])

    const registry = createRegistry()

    const first = await registry.getOrCreate("123")
    const second = await registry.getOrCreate("123:42")

    expect(mockSessionState.create).toHaveBeenNthCalledWith(1, createConfig(), {
      workspace: "/workspace/a",
      model: "o4-mini",
      reasoningEffort: "low",
      launchProfileId: "readonly",
      resumeThreadId: "thread-a",
    })
    expect(mockSessionState.create).toHaveBeenNthCalledWith(2, createConfig(), {
      workspace: "/workspace/b",
      model: "gpt-5.4",
      reasoningEffort: "high",
      launchProfileId: "default",
      resumeThreadId: "thread-b",
    })
    expect(first.getInfo()).toEqual({
      threadId: "thread-a",
      workspace: "/workspace/a",
      model: "o4-mini",
      reasoningEffort: "low",
      launchProfileId: "readonly",
      launchProfileLabel: "Read Only",
      launchProfileBehavior: "read-only / never",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      unsafeLaunch: false,
    })
    expect(second.getInfo()).toEqual({
      threadId: "thread-b",
      workspace: "/workspace/b",
      model: "gpt-5.4",
      reasoningEffort: "high",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    })
  })

  it("falls back to the default launch profile when persisted metadata references a missing profile", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    writePersistedContexts(tempWorkspace, [
      {
        contextKey: "123",
        threadId: "thread-a",
        workspace: "/workspace/a",
        launchProfileId: "missing",
        updatedAt: 10,
      },
    ])

    const registry = createRegistry()
    await registry.getOrCreate("123")

    expect(mockSessionState.create).toHaveBeenCalledWith(createConfig(), {
      workspace: "/workspace/a",
      model: undefined,
      reasoningEffort: undefined,
      launchProfileId: undefined,
      resumeThreadId: "thread-a",
    })
    expect(warnSpy).toHaveBeenCalledWith('Unknown persisted launch profile "missing" for 123. Falling back to default.')
  })

  it("updates metadata and lists contexts sorted by newest first", async () => {
    const registry = createRegistry()
    const first = (await registry.getOrCreate("123")) as any
    const second = (await registry.getOrCreate("123:42")) as any
    const dateNowSpy = vi.spyOn(Date, "now")

    first.setInfo({
      threadId: "thread-a",
      workspace: "/workspace/a",
      model: "o4-mini",
      launchProfileId: "readonly",
      launchProfileLabel: "Read Only",
      launchProfileBehavior: "read-only / never",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      unsafeLaunch: false,
    })
    dateNowSpy.mockReturnValueOnce(1000)
    registry.updateMetadata("123", first as any)

    second.setInfo({
      threadId: "thread-b",
      workspace: "/workspace/b",
      model: "gpt-5.4",
      reasoningEffort: "high",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    })
    dateNowSpy.mockReturnValueOnce(2000)
    registry.updateMetadata("123:42", second as any)

    expect(registry.listContexts()).toEqual([
      {
        contextKey: "123:42",
        threadId: "thread-b",
        workspace: "/workspace/b",
        model: "gpt-5.4",
        reasoningEffort: "high",
        launchProfileId: "default",
        updatedAt: 2000,
      },
      {
        contextKey: "123",
        threadId: "thread-a",
        workspace: "/workspace/a",
        model: "o4-mini",
        reasoningEffort: undefined,
        launchProfileId: "readonly",
        updatedAt: 1000,
      },
    ])
  })

  it("persists the next selected launch profile when it differs from the active thread profile", async () => {
    const registry = createRegistry()
    const session = (await registry.getOrCreate("123")) as any

    session.setInfo({
      threadId: "thread-a",
      workspace: "/workspace/a",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
      nextLaunchProfileId: "readonly",
      nextLaunchProfileLabel: "Read Only",
      nextLaunchProfileBehavior: "read-only / never",
      nextUnsafeLaunch: false,
    })
    registry.updateMetadata("123", session as any)

    expect(registry.listContexts()).toEqual([
      {
        contextKey: "123",
        threadId: "thread-a",
        workspace: "/workspace/a",
        model: "o3",
        reasoningEffort: undefined,
        launchProfileId: "readonly",
        updatedAt: expect.any(Number),
      },
    ])
  })

  it("removes a context and disposes its session", async () => {
    const registry = createRegistry()
    const session = await registry.getOrCreate("123")

    registry.updateMetadata("123", session as any)
    registry.remove("123")

    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(registry.has("123")).toBe(false)
    expect(registry.listContexts()).toEqual([])
  })

  it("persists metadata and reloads it in a new registry", async () => {
    const config = createConfig()
    const persistPath = path.join(config.workspace, ".telecodex", "contexts.json")
    const registry = createRegistry(config)
    const session = (await registry.getOrCreate("123")) as any

    session.setInfo({
      threadId: "thread-a",
      workspace: "/workspace/a",
      model: "o4-mini",
      reasoningEffort: "medium",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    })
    registry.updateMetadata("123", session as any)

    expect(readFileSync(persistPath, "utf8")).toContain("thread-a")

    const reloaded = createRegistry(config)
    expect(reloaded.listContexts()).toEqual([
      {
        contextKey: "123",
        threadId: "thread-a",
        workspace: "/workspace/a",
        model: "o4-mini",
        reasoningEffort: "medium",
        launchProfileId: "default",
        updatedAt: expect.any(Number),
      },
    ])
  })

  it("disposeAll disposes all sessions and clears the map", async () => {
    const registry = createRegistry()

    await registry.getOrCreate("100")
    await registry.getOrCreate("200")

    expect(registry.has("100")).toBe(true)
    expect(registry.has("200")).toBe(true)

    registry.disposeAll()

    expect(registry.has("100")).toBe(false)
    expect(registry.has("200")).toBe(false)
  })

  it("remove fires onRemove callback", async () => {
    const registry = createRegistry()

    await registry.getOrCreate("100")
    const removed: string[] = []
    registry.onRemove((key) => removed.push(key))

    registry.remove("100")

    expect(removed).toEqual(["100"])
    expect(registry.has("100")).toBe(false)
  })
})
