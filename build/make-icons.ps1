# Build rounded, transparent icons from the flat white-background logo:
#  1) make near-white pixels transparent
#  2) clip to a rounded rectangle (corner radius = 22% of width)
#  3) export 256px app icon (build/icon.png) and 32px/16px tray icons
$src = 'D:\codes\coding-usage\assets\images\logo.png'
$img = [System.Drawing.Image]::FromFile($src)
$w = $img.Width
$h = $img.Height
$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($img, 0, 0, $w, $h)
$radius = [Math]::Round($w * 0.22)
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    $px = $bmp.GetPixel($x, $y)
    $a = 255
    # transparent white background
    if ($px.R -gt 235 -and $px.G -gt 235 -and $px.B -gt 235) { $a = 0 }
    # rounded corner clipping
    if ($a -eq 255) {
      $dx = 0; $dy = 0
      if ($x -lt $radius) { $dx = $radius - $x } elseif ($x -ge $w - $radius) { $dx = $x - ($w - 1 - $radius) }
      if ($y -lt $radius) { $dy = $radius - $y } elseif ($y -ge $h - $radius) { $dy = $y - ($h - 1 - $radius) }
      if (($dx * $dx + $dy * $dy) -gt ($radius * $radius)) { $a = 0 }
    }
    if ($a -ne 255) { $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($a, 0, 0, 0)) }
  }
}
function Save-Scaled($bmpSrc, $size, $dest) {
  $out = New-Object System.Drawing.Bitmap($size, $size)
  $g2 = [System.Drawing.Graphics]::FromImage($out)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmpSrc, 0, 0, $size, $size)
  $out.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  $g2.Dispose(); $out.Dispose()
}
Save-Scaled $bmp 256 'D:\codes\coding-usage\build\icon.png'
Save-Scaled $bmp 32 'D:\codes\coding-usage\assets\images\tray-32.png'
Save-Scaled $bmp 16 'D:\codes\coding-usage\assets\images\tray-16.png'
$g.Dispose(); $bmp.Dispose(); $img.Dispose()
Write-Output 'icons done'
