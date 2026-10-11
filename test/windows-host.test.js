import test from "node:test";
import assert from "node:assert/strict";
import { resolveWindowsHost } from "../windows-host.js";

test("native Windows preserves SystemRoot and requires the built-in executable", () => {
  const path = "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const host = resolveWindowsHost({ platform: "win32", env: { SystemRoot: "D:\\Windows" }, exists: (p) => p === path });
  assert.equal(host.powershell, path);
  assert.equal(host.toWindowsPath("D:\\temp\\hello.ps1"), "D:\\temp\\hello.ps1");
  assert.equal(resolveWindowsHost({ platform: "win32", exists: () => false }), null);
});

test("WSL uses interop PATH including custom mounts and ignores relative entries", () => {
  const path = "/windows drive/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe";
  const seen = [];
  const host = resolveWindowsHost({ platform: "linux", env: {
    WSL_DISTRO_NAME: "Ubuntu", PATH: ".:/usr/bin:/windows drive/WINDOWS/System32/WindowsPowerShell/v1.0",
  }, exists: (p) => { seen.push(p); return p === path; }, execFile: (exe, args) => {
    assert.equal(exe, "wslpath");
    assert.deepEqual(args, ["-w", "/tmp/a b's.ps1"]);
    return "\\\\wsl.localhost\\Ubuntu\\tmp\\a b's.ps1\n";
  } });
  assert.equal(host.powershell, path);
  assert.equal(host.toWindowsPath("/tmp/a b's.ps1"), "\\\\wsl.localhost\\Ubuntu\\tmp\\a b's.ps1");
  assert.ok(seen.every((p) => p.startsWith("/")));
});

test("WSL kernel detection works without WSL environment variables", () => {
  assert.equal(resolveWindowsHost({ platform: "linux", env: { PATH: "/interop" },
    kernelRelease: "6.1-microsoft-standard-WSL2", exists: () => true }).powershell, "/interop/powershell.exe");
});

test("ordinary Linux/macOS and WSL without interop are unavailable", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.equal(resolveWindowsHost({ platform, env: { PATH: "/interop" }, kernelRelease: "generic", exists: () => true }), null);
  }
  assert.equal(resolveWindowsHost({ platform: "linux", env: { WSL_INTEROP: "socket", PATH: "/usr/bin" }, exists: () => false }), null);
});

test("conversion errors and non-Windows output fail closed", () => {
  for (const execFile of [() => { throw new Error("disabled interop"); }, () => "", () => "/tmp/a.ps1"]) {
    const host = resolveWindowsHost({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu", PATH: "/interop" }, exists: () => true, execFile });
    assert.throws(() => host.toWindowsPath("/tmp/a.ps1"));
  }
});
