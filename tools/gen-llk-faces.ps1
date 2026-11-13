<#
.SYNOPSIS
    把 24 张角色头像拼成连连看用的 6×4 sprite（《36》v2.1 §2.4 第 3 步）。

.DESCRIPTION
    流程：读 raw/01..24-*.png → 等比缩放到 128 → 居中贴到米纸底 #F3ECE1 的 128×128 → 按文件名顺序
    （行优先）拼成 768×512 → 输出 faces.png。

    刻意不引 Node 依赖：sprite 只在"换头像"时才重新生成（一年几次），为它维护一套 sharp/jimp 不划算；
    PowerShell + System.Drawing 在 Windows 上零安装。

    水印与背景归一**不在本脚本里**：那是 512/ 目录生成时做过的一次性处理
    （四角中位数采样 → 抹水印 → 四边洪水填充，见《36》v2.1 §2.6）。本脚本只消费已处理好的 512 图。

.PARAMETER RawDir
    源图目录（默认指向设计文档里的 512/ 产物）。要求正好 24 张、文件名以 01..24 开头。

.PARAMETER OutFile
    输出 sprite 路径。默认落在网站的 wwwroot/Images/llk/faces.png。

.PARAMETER Cell
    单元格边长，默认 128（40px 格 × DPR 3 = 120，取 128 留余量）。

.EXAMPLE
    pwsh tools/gen-llk-faces.ps1
    pwsh tools/gen-llk-faces.ps1 -RawDir "D:\faces\512" -OutFile "D:\faces\faces.png"
#>
param(
    [string]$RawDir = "E:\300programing\330GitHub\1设计文档\1夜游桃花源\8设计图\1连连看\512",
    [string]$OutFile = (Join-Path $PSScriptRoot "..\jtjsym\jtjsym\wwwroot\Images\llk\faces.png"),
    [int]$Cell = 128
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $RawDir)) {
    throw "源图目录不存在：$RawDir`n（raw/512 在设计文档目录下，见《36》v2.1 §2.6；换机器后需要先取回这批图）"
}

$files = Get-ChildItem -Path $RawDir -Filter '*.png' | Sort-Object Name
if ($files.Count -ne 24) {
    throw "需要正好 24 张 PNG，实际 $($files.Count) 张：$RawDir"
}

# 索引公式与 LianliankanThemes.Position 必须一致：col = (idx-1) % 6、row = ⌊(idx-1)/6⌋
$cols = 6
$rows = 4
$paper = [System.Drawing.ColorTranslator]::FromHtml('#F3ECE1')

$canvas = New-Object System.Drawing.Bitmap ($cols * $Cell), ($rows * $Cell)
$g = [System.Drawing.Graphics]::FromImage($canvas)
$g.Clear($paper)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

for ($i = 0; $i -lt $files.Count; $i++) {
    $img = [System.Drawing.Image]::FromFile($files[$i].FullName)
    try {
        # 等比缩放到格内（留 2px 边，避免相邻格贴在一起看不出分界）
        $box = $Cell - 4
        $scale = [Math]::Min($box / $img.Width, $box / $img.Height)
        $w = [int][Math]::Round($img.Width * $scale)
        $h = [int][Math]::Round($img.Height * $scale)

        $col = $i % $cols
        $row = [Math]::Floor($i / $cols)
        $x = $col * $Cell + [int](($Cell - $w) / 2)
        $y = $row * $Cell + [int](($Cell - $h) / 2)

        $g.DrawImage($img, $x, $y, $w, $h)
        Write-Host ("[{0,2}] {1} -> ({2},{3}) {4}x{5}" -f ($i + 1), $files[$i].Name, $col, $row, $w, $h)
    }
    finally {
        $img.Dispose()
    }
}

$g.Dispose()

$dir = Split-Path -Parent $OutFile
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

# 24bpp：PNG-8 量化（≤180KB）这一步用外部工具做，脚本不假装能替（见 v2.1 §2.2 的体积目标）
$canvas.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()

$size = (Get-Item $OutFile).Length
Write-Host ""
Write-Host ("sprite: {0}  ({1}x{2}, {3:N0} 字节)" -f $OutFile, ($cols * $Cell), ($rows * $Cell), $size)
if ($size -gt 180KB) {
    Write-Warning "体积超过 180KB 目标，先做 PNG-8 量化再拷进 wwwroot（v2.1 §2.2）。"
}
