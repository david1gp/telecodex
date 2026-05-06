import { describe, expect, it } from "bun:test"

describe("bot command registrations", () => {
  it("registers handlers for advertised commands without duplicates", async () => {
    const source = await Bun.file(new URL("../src/bot.ts", import.meta.url)).text()
    const commandLines = source.split("\n").filter((line) => line.includes("bot.command("))
    const commandNames = commandLines.flatMap(extractCommandNames)

    expect(commandNames).toContain("new")
    expect(commandNames).toContain("effort")
    expect(commandNames.filter((command) => command === "effort")).toHaveLength(1)

    const advertisedMatches = [...source.matchAll(/\{\s*command:\s*"([^"]+)"/g)]
    const advertisedCommands = advertisedMatches.flatMap((match) => (match[1] ? [match[1]] : []))
    for (const command of advertisedCommands) {
      expect(commandNames).toContain(command)
    }
  })
})

function extractCommandNames(argument: string): string[] {
  return [...argument.matchAll(/"([^"]+)"/g)].flatMap((match) => (match[1] ? [match[1]] : []))
}
