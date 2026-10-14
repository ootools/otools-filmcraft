# 把插件同步到 otools 仓库的 plugins 目录（本地试跑用）
# 用法：pwsh -File scripts/deploy-to-otools.ps1 [-OtoolsRoot "D:\Repos\xyito\otools\otools"]
#
# 只同步「宿主真正需要的」：plugin.json / logo / index 壳（本仓库没有，入口是 dist/index.html）
# 和构建产物 dist/。upstream/、shell/、scripts/、docs 都留在本仓库，不进插件目录。
param(
  [string]$OtoolsRoot = "D:\Repos\xyito\otools\otools"
)

$ErrorActionPreference = "Stop"
$pluginRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $OtoolsRoot "plugins\otools-filmcraft"

if (-not (Test-Path (Join-Path $OtoolsRoot "vendor\otools-plugin-sdk\src\index.ts"))) {
  Write-Error "未找到 otools 仓库：$OtoolsRoot（可用 -OtoolsRoot 指定其它路径）"
}

New-Item -ItemType Directory -Force -Path $target | Out-Null

# 需要随插件分发的东西：清单、图标、入口与构建产物
$ship = @(
  "plugin.json",
  "logo.svg",
  "dist"
)

foreach ($item in $ship) {
  $from = Join-Path $pluginRoot $item
  if (-not (Test-Path $from)) { continue }
  if (Test-Path (Join-Path $target $item)) {
    Remove-Item -LiteralPath (Join-Path $target $item) -Recurse -Force
  }
  Copy-Item -LiteralPath $from -Destination $target -Recurse -Force
}

Write-Host "已同步到 $target"
Write-Host "在 otools 里重载/重启应用即可看到「CAD 制图」插件。"
