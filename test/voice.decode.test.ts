import { afterEach, describe, expect, it, vi } from "bun:test"
import { EventEmitter } from "node:events"
import { transcribeAudio } from "../src/voice.js"

type FakeChildProcess = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
}

function createSpawnMock(onSpawn: (child: FakeChildProcess) => void) {
  return vi.fn(() => {
    const child = new EventEmitter() as FakeChildProcess
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    process.nextTick(() => onSpawn(child))
    return child
  })
}

afterEach(() => {
  delete process.env.OPENAI_API_KEY
})

describe("voice decoding", () => {
  it("decodes ffmpeg float32 output into samples for parakeet", async () => {
    const expectedSamples = new Float32Array([0.25, -0.5, 0.75])
    const spawnMock = createSpawnMock((child) => {
      child.stdout.emit("data", Buffer.from(expectedSamples.buffer.slice(0)))
      child.emit("close", 0, null)
    })
    const result = await transcribeAudio("/tmp/sample.ogg", {
      spawn: spawnMock as any,
      importModule: async () => ({
        ParakeetAsrEngine: class {
          async initialize(): Promise<void> {}
          async transcribe(samples: Float32Array): Promise<{ text: string; durationMs: number }> {
            expect(Array.from(samples)).toEqual(Array.from(expectedSamples))
            return { text: "decoded locally", durationMs: 7 }
          }
        },
      }),
      engine: null,
    })

    expect(spawnMock).toHaveBeenCalledWith(
      "ffmpeg",
      ["-i", "/tmp/sample.ogg", "-ar", "16000", "-ac", "1", "-f", "f32le", "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    expect(result).toMatchObject({
      text: "decoded locally",
      backend: "parakeet",
      durationMs: 7,
    })
  })

  it("surfaces ffmpeg decode failures", async () => {
    const spawnMock = createSpawnMock((child) => {
      child.stderr.emit("data", Buffer.from("bad input file"))
      child.emit("close", 1, null)
    })
    await expect(
      transcribeAudio("/tmp/bad.ogg", {
        spawn: spawnMock as any,
        importModule: async () => ({
          ParakeetAsrEngine: class {
            async initialize(): Promise<void> {}
            async transcribe(): Promise<{ text: string; durationMs: number }> {
              return { text: "unused", durationMs: 7 }
            }
          },
        }),
        engine: null,
      }),
    ).rejects.toThrow("ffmpeg failed to decode audio: bad input file")
  })

  it("rejects invalid ffmpeg PCM output", async () => {
    const spawnMock = createSpawnMock((child) => {
      child.stdout.emit("data", Buffer.from([1, 2, 3]))
      child.emit("close", 0, null)
    })
    await expect(
      transcribeAudio("/tmp/bad-pcm.ogg", {
        spawn: spawnMock as any,
        importModule: async () => ({
          ParakeetAsrEngine: class {
            async initialize(): Promise<void> {}
            async transcribe(): Promise<{ text: string; durationMs: number }> {
              return { text: "unused", durationMs: 7 }
            }
          },
        }),
        engine: null,
      }),
    ).rejects.toThrow(
      "ffmpeg returned invalid float32 PCM output",
    )
  })

  it("surfaces a friendly error when ffmpeg cannot be spawned", async () => {
    const spawnMock = createSpawnMock((child) => {
      child.emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }))
    })
    await expect(
      transcribeAudio("/tmp/missing.ogg", {
        spawn: spawnMock as any,
        importModule: async () => ({
          ParakeetAsrEngine: class {
            async initialize(): Promise<void> {}
            async transcribe(): Promise<{ text: string; durationMs: number }> {
              return { text: "unused", durationMs: 7 }
            }
          },
        }),
        engine: null,
      }),
    ).rejects.toThrow("brew install ffmpeg")
  })
})
