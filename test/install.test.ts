import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("install appends after existing hooks; uninstall removes only ours", () => {
  const home = mkdtempSync(join(tmpdir(), "ctx-install-"));
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".codex"));
  const mine = { type: "command", command: "my-own-logger", timeout: 3 };
  const orca = { hooks: [{ type: "command", command: "orca-hook", timeout: 10 }] };
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [orca], UserPromptSubmit: [{ hooks: [mine] }] }, theme: "dark" }));
  writeFileSync(join(home, ".codex", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [orca] } }));
  const run = (...args: string[]) =>
    Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], { env: { ...process.env, HOME: home, CTX_HOME: join(home, ".ctx"), CTX_NO_SERVICE: "1" }, stdout: "pipe", stderr: "pipe" });
  expect(run("install", "--apply").exitCode).toBe(0);
  const codex = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
  expect(codex.hooks.SessionStart[0]).toEqual(orca); // trusted index unchanged
  expect(codex.hooks.SessionStart[1].hooks[0].command).toContain("/.local/bin/ctx hook codex session-start");

  // user adds their own handler into our group; uninstall must keep it
  const claudePath = join(home, ".claude", "settings.json");
  const claude = JSON.parse(readFileSync(claudePath, "utf8"));
  claude.hooks.SessionStart[1].hooks.push({ type: "command", command: "user-added" });
  writeFileSync(claudePath, JSON.stringify(claude));
  expect(run("uninstall", "--apply").exitCode).toBe(0);
  const after = JSON.parse(readFileSync(claudePath, "utf8"));
  expect(after.theme).toBe("dark");
  expect(after.hooks.SessionStart[0]).toEqual(orca);
  expect(after.hooks.SessionStart[1].hooks).toEqual([{ type: "command", command: "user-added" }]);
  expect(after.hooks.UserPromptSubmit).toEqual([{ hooks: [mine] }]);
  expect(JSON.stringify(after)).not.toContain("ctx hook");
}, 120_000);
