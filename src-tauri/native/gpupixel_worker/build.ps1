# Build gpupixel_worker.exe into resources/beauty/gpupixel/
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here "..\..\..")
$outDir = Join-Path $repo "src-tauri\resources\beauty\gpupixel"
$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) {
  throw "MSVC BuildTools not found: $vcvars"
}
if (-not (Test-Path (Join-Path $outDir "gpupixel.lib"))) {
  throw "gpupixel.lib missing under $outDir — download GPUPixel windows package first"
}
if (-not (Test-Path (Join-Path $outDir "glfw\lib\glfw3dll.lib"))) {
  throw "glfw3dll.lib missing under $outDir\glfw\lib"
}

$src = Join-Path $here "main.cc"
$exe = Join-Path $outDir "gpupixel_worker.exe"
$cmd = @"
call `"$vcvars`" && cl /nologo /EHsc /O2 /std:c++17 /MD /I`"$outDir\include`" /I`"$outDir\glfw\include`" `"$src`" /Fe:`"$exe`" /Fo:`"$outDir\gpupixel_worker.obj`" /link /LIBPATH:`"$outDir`" /LIBPATH:`"$outDir\glfw\lib`" gpupixel.lib glfw3dll.lib opengl32.lib user32.lib gdi32.lib shell32.lib advapi32.lib
"@
Write-Host "Building gpupixel_worker..."
cmd /c $cmd
if ($LASTEXITCODE -ne 0) { throw "cl failed: $LASTEXITCODE" }
Remove-Item (Join-Path $outDir "gpupixel_worker.obj") -ErrorAction SilentlyContinue
Remove-Item (Join-Path $outDir "main.obj") -ErrorAction SilentlyContinue
Write-Host "OK: $exe"
Get-Item $exe | Format-List Name, Length, LastWriteTime
