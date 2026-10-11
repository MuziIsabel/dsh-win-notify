$ErrorActionPreference = 'Stop'
$text = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../index.js') -Raw -Encoding UTF8
$match = [regex]::Match($text, 'const ACTIVATION_STUB_CS = String.raw`([\s\S]*?)`;')
if (-not $match.Success) { throw 'Activation helper source missing' }
$source = $match.Groups[1].Value
# Compile the real helper without executing Main; replace only OS bindings in
# a second compilation to test native selection without touching live windows.
$fixture = @'
public static class ActivationFixture {
 public static readonly System.Collections.Generic.List<IntPtr> Raised = new System.Collections.Generic.List<IntPtr>();
 public static readonly System.Collections.Generic.List<IntPtr> Restored = new System.Collections.Generic.List<IntPtr>();
 public static int Mode;
 public static string ProcessName(uint pid) { return pid == 3 ? "explorer" : pid == 4 ? "msedge" : "firefox"; }
 public static string Title(IntPtr h) { return Mode == 1 ? "Unrelated" : h.ToInt32() == 2 ? "DeepSeek Harness \u2014 Firefox Nightly" : "DeepSeek Harness - Browser"; }
 static object Call(string name, params object[] args) { return typeof(Program).GetMethod(name, System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static).Invoke(null, args); }
 static void Check(bool value, string name) { if (!value) throw new Exception(name); }
 public static int Pure() {
  int n=0;
  foreach(string s in new string[]{"firefox","FIREFOX","chrome","msedge"}) { Check((bool)Call("IsSupportedBrowserProcessName",s),"supported browser"); n++; }
  foreach(string s in new string[]{"explorer","firefox-helper","",null}) { Check(!(bool)Call("IsSupportedBrowserProcessName",s),"unrelated process"); n++; }
  foreach(string s in new string[]{"DeepSeek Harness","DeepSeek Harness - Chrome","DeepSeek Harness - Edge","DeepSeek Harness \u2014 Firefox","DeepSeek Harness \u2014 Firefox Nightly"}) { Check((bool)Call("MatchesTabTitle",s,"DeepSeek Harness"),"browser decoration"); n++; }
  foreach(string s in new string[]{"DeepSeek Harness Other","Other - DeepSeek Harness","deepseek harness","",null}) { Check(!(bool)Call("MatchesTabTitle",s,"DeepSeek Harness"),"unrelated title"); n++; }
  Check(!(bool)Call("MatchesTabTitle","DeepSeek Harness",""),"empty expected title"); return n+1;
 }
 public static int Native() {
  Mode=0;
  IntPtr target=(IntPtr)Call("FindBrowserWindowByTitle","DeepSeek Harness");
  Check(target==new IntPtr(2),"invisible skipped; Firefox matched without accessibility");
  Call("BringNativeWindowForward",target);
  Check(Raised.Count==1 && Raised[0]==target,"correct HWND raised");
  Check(Restored.Count==1 && Restored[0]==target,"minimized restored");
  Restored.Clear(); Raised.Clear();
  Call("BringNativeWindowForward",new IntPtr(4));
  Check(Restored.Count==0 && Raised.Count==1,"normal/maximized not restored");
  Call("BringNativeWindowForward",IntPtr.Zero); Check(Raised.Count==1,"zero ignored");
  Mode=1; Check((IntPtr)Call("FindBrowserWindowByTitle","DeepSeek Harness")==IntPtr.Zero,"unrelated windows ignored");
  Mode=2; Check((IntPtr)Call("FindBrowserWindowByTitle","DeepSeek Harness")==new IntPtr(4),"unsupported process rejected; Edge retained");
  return 7;
 }
}
'@
$bodies = @{
 EnumWindows = 'private static bool EnumWindows(EnumWindowCallback cb, IntPtr p) { foreach(int h in new int[]{1,2,3,4}) if(!cb(new IntPtr(h),p)) return false; return true; }'
 IsWindowVisible = 'private static bool IsWindowVisible(IntPtr h) { return h.ToInt32()!=1 && (ActivationFixture.Mode!=2 || h.ToInt32()!=2); }'
 GetWindowThreadProcessId = 'private static uint GetWindowThreadProcessId(IntPtr h, out uint pid) { pid=(uint)h.ToInt32(); return 1; }'
 GetWindowText = 'private static int GetWindowText(IntPtr h, StringBuilder text, int max) { text.Append(ActivationFixture.Title(h)); return text.Length; }'
 SetForegroundWindow = 'private static bool SetForegroundWindow(IntPtr h) { ActivationFixture.Raised.Add(h); return true; }'
 ShowWindow = 'private static bool ShowWindow(IntPtr h, int command) { if(command!=9) throw new Exception("restore command"); ActivationFixture.Restored.Add(h); return true; }'
 GetForegroundWindow = 'private static IntPtr GetForegroundWindow() { return IntPtr.Zero; }'
 IsIconic = 'private static bool IsIconic(IntPtr h) { return h==new IntPtr(2); }'
}
$mocked = [regex]::Replace($source, '\[DllImport\("user32.dll"[^\]]*\)\]\s*private static extern \w+ (\w+)\([^;]*;', [System.Text.RegularExpressions.MatchEvaluator]{
 param($declaration)
 $name=$declaration.Groups[1].Value
 if(-not $bodies.ContainsKey($name)) { throw "Unexpected import: $name" }
 return $bodies[$name]
})
$mocked=$mocked.Replace('Process.GetProcessById((int)processId).ProcessName','ActivationFixture.ProcessName(processId)')
$runtime=[Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
$parameters=New-Object System.CodeDom.Compiler.CompilerParameters
$parameters.GenerateInMemory=$true
$parameters.GenerateExecutable=$true
$parameters.CompilerOptions='/target:winexe'
foreach($reference in @('System.dll','System.Core.dll',(Join-Path $runtime 'WPF/UIAutomationClient.dll'),(Join-Path $runtime 'WPF/UIAutomationTypes.dll'))) { [void]$parameters.ReferencedAssemblies.Add($reference) }
$provider=New-Object Microsoft.CSharp.CSharpCodeProvider
try {
 $result=$provider.CompileAssemblyFromSource($parameters,$source+$fixture)
 if($result.Errors.HasErrors) { throw (($result.Errors | ForEach-Object ToString)-join "`n") }
 $pure=$result.CompiledAssembly.GetType('ActivationFixture').GetMethod('Pure').Invoke($null,@())
 $result=$provider.CompileAssemblyFromSource($parameters,$mocked+$fixture)
 if($result.Errors.HasErrors) { throw (($result.Errors | ForEach-Object ToString)-join "`n") }
 $native=$result.CompiledAssembly.GetType('ActivationFixture').GetMethod('Native').Invoke($null,@())
 Write-Output "$pure real-helper and $native mocked Win32 assertions passed; no live window input performed."
} finally { $provider.Dispose() }
