import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { release } from "node:os";
import { posix, win32 } from "node:path";

// Executable paths belong to the Node host; script/asset paths belong to Windows.
export function resolveWindowsHost({
  platform = process.platform,
  env = process.env,
  kernelRelease = release(),
  exists = existsSync,
  execFile = execFileSync,
} = {}) {
  if (platform === "win32") {
    const powershell = win32.join(env.SystemRoot ?? "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return exists(powershell) ? { powershell, toWindowsPath: (path) => path } : null;
  }
  const wsl = platform === "linux" &&
    (env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft/i.test(kernelRelease));
  if (!wsl) return null;
  // Honor WSL's imported Windows PATH, including custom drive mount locations.
  const powershell = (env.PATH ?? "").split(":")
    .filter((dir) => posix.isAbsolute(dir))
    .map((dir) => posix.join(dir, "powershell.exe"))
    .find(exists);
  if (!powershell) return null;
  return {
    powershell,
    toWindowsPath(path) {
      const translated = execFile("wslpath", ["-w", path], {
        encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (!/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(translated)) {
        throw new Error("wslpath did not return an absolute Windows path");
      }
      return translated;
    },
  };
}
