import { spawn } from "node:child_process";

export type MulticaCliErrorCode =
  | "not_found"
  | "daemon_down"
  | "cli_error"
  | "parse_error";

export class MulticaCliError extends Error {
  readonly code: MulticaCliErrorCode;
  readonly stderr?: string;

  constructor(message: string, code: MulticaCliErrorCode, stderr?: string) {
    super(message);
    this.name = "MulticaCliError";
    this.code = code;
    this.stderr = stderr;
  }
}

type ExecResult = { stdout: string; stderr: string; code: number };

async function exec(
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.MULTICA_BIN ?? "multica", args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new MulticaCliError(`multica CLI timed out after ${timeoutMs}ms`, "cli_error"));
    }, timeoutMs);

    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new MulticaCliError(
            "multica CLI not found on PATH (or MULTICA_BIN). Install via: brew install multica-ai/tap/multica, or point MULTICA_BIN at the binary (macOS app: /Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica)",
            "not_found",
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });

    if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
  });
}

function diagnoseError(result: ExecResult): MulticaCliError {
  const err = result.stderr.trim() || result.stdout.trim();
  const lower = err.toLowerCase();
  if (
    lower.includes("connection refused") ||
    lower.includes("connect: refused") ||
    lower.includes("daemon is not running") ||
    lower.includes("failed to connect") ||
    lower.includes("timeout waiting for daemon") ||
    (lower.includes("daemon") && lower.includes("start"))
  ) {
    return new MulticaCliError(
      "daemon down, run 'multica daemon start'",
      "daemon_down",
      err,
    );
  }
  if (
    lower.includes("not authenticated") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized") ||
    lower.includes("token")
  ) {
    return new MulticaCliError(
      "Authentication error. Try: multica login",
      "cli_error",
      err,
    );
  }
  return new MulticaCliError(`multica CLI failed: ${err}`, "cli_error", err);
}

export async function runMulticaJson<T = unknown>(
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<T> {
  const fullArgs = args.includes("--output") ? args : [...args, "--output", "json"];
  const result = await exec(fullArgs, opts);
  if (result.code !== 0) throw diagnoseError(result);
  const trimmed = result.stdout.trim();
  if (trimmed === "") return null as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    throw new MulticaCliError(
      `Failed to parse multica JSON output: ${(err as Error).message}`,
      "parse_error",
      result.stdout.slice(0, 500),
    );
  }
}

export async function runMulticaRaw(args: string[]): Promise<string> {
  const result = await exec(args);
  if (result.code !== 0) throw diagnoseError(result);
  return result.stdout;
}

export async function ensureMulticaCliAvailable(): Promise<void> {
  await runMulticaRaw(["version"]);
}

export function formatMulticaError(
  err: unknown,
): { code: string; message: string; stderr?: string } {
  if (err instanceof MulticaCliError) {
    return {
      code: err.code,
      message: err.message,
      stderr: err.stderr,
    };
  }

  return {
    code: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  };
}
