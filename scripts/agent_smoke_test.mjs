import { unstable_v2_prompt } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";

const model = "sonnet";

const resolveClaudeExecutable = () => {
  if (process.env.CLAUDE_CODE_PATH) {
    return process.env.CLAUDE_CODE_PATH;
  }
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  } catch {
    return "claude";
  }
};

const run = async () => {
  try {
    const result = await unstable_v2_prompt("Return exactly the word OK.", {
      model,
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      permissionMode: "dontAsk",
      env: process.env
    });

    if (result.subtype !== "success") {
      console.error(result.errors?.join("; ") ?? "Agent returned an error.");
      process.exit(1);
    }

    if (!result.result.includes("OK")) {
      console.error("Smoke test failed: response did not include OK.");
      process.exit(1);
    }

    console.log("OK");
  } catch (error) {
    console.error(
      `Smoke test failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    process.exit(1);
  }
};

await run();
