import { readFileSync, appendFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { resolveWindowsHost } from "../../windows-host.js";

// Exercise the production functions without installing the Harness schema/runtime.
// Only module wiring is replaced; all registration/event/notification logic is real.
export function loadPlugin(overrides = {}) {
  const url = new URL("../../index.js", import.meta.url);
  const source = readFileSync(url, "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/\bexport /g, "")
    .replaceAll("import.meta.url", JSON.stringify(url.href));
  const schema = { default() { return this; } };
  return runInNewContext(source + "\n({ apply, ensureRegistered, registrationScript, runPowerShell, toastScript, showToast, clientViews, DEFAULTS, ACTIVATION_TOKEN })", {
    Buffer, URL, process, spawn, randomBytes, appendFileSync, writeFileSync,
    unlinkSync, homedir, tmpdir, join, fileURLToPath, resolveWindowsHost,
    setTimeout, clearTimeout, Date,
    z: { object: () => ({}), boolean: () => schema, string: () => schema, number: () => schema },
    ...overrides,
  }, { filename: fileURLToPath(url) });
}
