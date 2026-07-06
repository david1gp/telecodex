import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

export interface CodexThreadRecord {
  id: string
  title: string
  cwd: string
  model: string | null
  createdAt: Date
  updatedAt: Date
  firstUserMessage: string
}

export interface CodexModelRecord {
  slug: string
  displayName: string
}

export const FALLBACK_MODELS: CodexModelRecord[] = [
  { slug: "gpt-5.4", displayName: "GPT-5.4" },
  { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini" },
  { slug: "gpt-5", displayName: "GPT-5" },
  { slug: "o4-mini", displayName: "o4-mini" },
  { slug: "o3", displayName: "o3" },
  { slug: "o3-mini", displayName: "o3-mini" },
  { slug: "gpt-4o", displayName: "GPT-4o" },
]

type DatabaseCtor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[]
    get(...args: unknown[]): unknown
  }
  close(): void
}
type DatabaseInstance = InstanceType<DatabaseCtor>
type ThreadRow = {
  id: unknown
  title: unknown
  cwd: unknown
  model: unknown
  created_at: unknown
  updated_at: unknown
  first_user_message: unknown
}

type WorkspaceRow = {
  cwd: unknown
}

const betterSqlite3Module = await import("better-sqlite3").catch(() => null)
const BetterSqlite3 = ((betterSqlite3Module as { default?: DatabaseCtor } | null)?.default ??
  (betterSqlite3Module as DatabaseCtor | null)) as DatabaseCtor | null

export interface CodexStateDependencies {
  existsSync?: typeof existsSync
  readdirSync?: typeof readdirSync
  readFileSync?: typeof readFileSync
  statSync?: typeof statSync
  Database?: DatabaseCtor | null
  home?: string
}

export interface CodexStateApi {
  findLatestDatabase(): string | null
  listThreads(limit?: number): CodexThreadRecord[]
  getThread(id: string): CodexThreadRecord | null
  listWorkspaces(): string[]
  listModels(): CodexModelRecord[]
}

export function createCodexState(dependencies: CodexStateDependencies = {}): CodexStateApi {
  const fs = {
    existsSync: dependencies.existsSync ?? existsSync,
    readdirSync: dependencies.readdirSync ?? readdirSync,
    readFileSync: dependencies.readFileSync ?? readFileSync,
    statSync: dependencies.statSync ?? statSync,
  }
  const Database = dependencies.Database === undefined ? BetterSqlite3 : dependencies.Database
  const home = dependencies.home ?? process.env.HOME

  const getCodexDirForState = (): string | null => {
    const trimmedHome = home?.trim()
    return trimmedHome ? path.join(trimmedHome, ".codex") : null
  }

  const getModelsCachePathForState = (): string | null => {
    const codexDir = getCodexDirForState()
    return codexDir ? path.join(codexDir, "models_cache.json") : null
  }

  const findLatestDatabaseForState = (): string | null => {
    const codexDir = getCodexDirForState()
    if (!codexDir || !fs.existsSync(codexDir)) {
      return null
    }

    try {
      const candidates = fs
        .readdirSync(codexDir)
        .filter((file) => /^state_.*\.sqlite$/i.test(String(file)))
        .map((file) => {
          const fullPath = path.join(codexDir, String(file))
          return {
            path: fullPath,
            modifiedAtMs: fs.statSync(fullPath).mtimeMs,
          }
        })
        .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)

      return candidates[0]?.path ?? null
    } catch {
      return null
    }
  }

  const withDatabaseForState = <T>(fn: (db: DatabaseInstance) => T): T | null => {
    if (!Database) {
      return null
    }

    const databasePath = findLatestDatabaseForState()
    if (!databasePath) {
      return null
    }

    let db: DatabaseInstance | null = null
    try {
      db = new Database(databasePath, { readonly: true, fileMustExist: true })
      return fn(db)
    } catch {
      return null
    } finally {
      try {
        db?.close()
      } catch {
        // Ignore close failures.
      }
    }
  }

  return {
    findLatestDatabase: findLatestDatabaseForState,
    listThreads(limit = 20): CodexThreadRecord[] {
      return (
        withDatabaseForState((db) => {
          const query = db.prepare(`
      SELECT id, title, cwd, model, created_at, updated_at, first_user_message
      FROM threads
      WHERE (archived = 0 OR archived IS NULL)
      ORDER BY updated_at DESC
      LIMIT ?
    `)

          const rows = query.all(limit) as ThreadRow[]
          return rows.map(mapThreadRow)
        }) ?? []
      )
    },

    getThread(id: string): CodexThreadRecord | null {
      return (
        withDatabaseForState((db) => {
          const query = db.prepare(`
        SELECT id, title, cwd, model, created_at, updated_at, first_user_message
        FROM threads
        WHERE archived = 0 AND id = ?
        LIMIT 1
      `)

          const row = query.get(id) as ThreadRow | undefined
          return row ? mapThreadRow(row) : null
        }) ?? null
      )
    },

    listWorkspaces(): string[] {
      return (
        withDatabaseForState((db) => {
          const query = db.prepare(`
        SELECT DISTINCT cwd
        FROM threads
        WHERE (archived = 0 OR archived IS NULL) AND cwd IS NOT NULL AND cwd != ''
        ORDER BY cwd ASC
      `)

          const rows = query.all() as WorkspaceRow[]
          return rows.map((row) => (typeof row.cwd === "string" ? row.cwd : "")).filter(Boolean)
        }) ?? []
      )
    },

    listModels(): CodexModelRecord[] {
      const modelsPath = getModelsCachePathForState()
      if (!modelsPath || !fs.existsSync(modelsPath)) {
        return FALLBACK_MODELS
      }

      try {
        const payload = JSON.parse(String(fs.readFileSync(modelsPath, "utf8"))) as {
          models?: Array<{
            slug?: unknown
            display_name?: unknown
            visibility?: unknown
          }>
        }

        const models = (payload.models ?? [])
          .filter((model) => model && typeof model === "object")
          .filter((model) => model.visibility !== "hidden")
          .map((model) => ({
            slug: typeof model.slug === "string" ? model.slug : "",
            displayName: typeof model.display_name === "string" ? model.display_name : "",
          }))
          .filter((model) => model.slug && model.displayName)

        return models.length > 0 ? models : FALLBACK_MODELS
      } catch {
        return FALLBACK_MODELS
      }
    },
  }
}

const defaultState = createCodexState()

export const findLatestDatabase = (): string | null => defaultState.findLatestDatabase()
export const listThreads = (limit = 20): CodexThreadRecord[] => defaultState.listThreads(limit)
export const getThread = (id: string): CodexThreadRecord | null => defaultState.getThread(id)
export const listWorkspaces = (): string[] => defaultState.listWorkspaces()
export const listModels = (): CodexModelRecord[] => defaultState.listModels()

export function reloadModelsFromCLI(): CodexModelRecord[] {
  try {
    const result = spawnSync("codex", ["debug", "models"], {
      timeout: 15000,
      encoding: "utf8",
    })

    if (result.status !== 0 || !result.stdout) {
      return FALLBACK_MODELS
    }

    const payload = JSON.parse(result.stdout) as {
      models?: Array<{
        slug?: unknown
        display_name?: unknown
        visibility?: unknown
      }>
    }

    const models = (payload.models ?? [])
      .filter((model) => model && typeof model === "object")
      .filter((model) => model.visibility !== "hidden")
      .map((model) => ({
        slug: typeof model.slug === "string" ? model.slug : "",
        displayName: typeof model.display_name === "string" ? model.display_name : "",
      }))
      .filter((model) => model.slug && model.displayName)

    return models.length > 0 ? models : FALLBACK_MODELS
  } catch {
    return FALLBACK_MODELS
  }
}

function mapThreadRow(row: ThreadRow): CodexThreadRecord {
  return {
    id: typeof row.id === "string" ? row.id : String(row.id ?? ""),
    title: typeof row.title === "string" ? row.title : "",
    cwd: typeof row.cwd === "string" ? row.cwd : "",
    model: typeof row.model === "string" ? row.model : null,
    createdAt: fromUnixSeconds(row.created_at),
    updatedAt: fromUnixSeconds(row.updated_at),
    firstUserMessage: typeof row.first_user_message === "string" ? row.first_user_message : "",
  }
}

function fromUnixSeconds(value: unknown): Date {
  return typeof value === "number" ? new Date(value * 1000) : new Date(0)
}
