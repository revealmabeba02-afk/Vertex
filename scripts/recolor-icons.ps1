# Recolour the raster brand icons from cyan/teal to the new electric blue.
#
# The favicons predate the palette change and still carry the cyan half of
# the mark, which is the most visible "we are the same product" tell (browser
# tab, home screen, link preview). Hue-shifting rather than repainting keeps
# the original shading, glows and the green half of the mark intact.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/recolor-icons.ps1

Add-Type -AssemblyName System.Drawing

$src = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;

public static class RecolorIcons
{
    // Cyan/teal band we want to move. Everything outside it (green, amber,
    // greys, the dark backdrop) is left exactly as it is.
    const double FromLow = 158.0;
    const double FromHigh = 205.0;
    const double ToLow = 212.0;
    const double ToHigh = 232.0;

    static void ToHsl(Color c, out double h, out double s, out double l)
    {
        double r = c.R / 255.0, g = c.G / 255.0, b = c.B / 255.0;
        double max = Math.Max(r, Math.Max(g, b)), min = Math.Min(r, Math.Min(g, b));
        l = (max + min) / 2.0;
        if (Math.Abs(max - min) < 1e-9) { h = 0; s = 0; return; }
        double d = max - min;
        s = l > 0.5 ? d / (2.0 - max - min) : d / (max + min);
        if (max == r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60.0;
        else if (max == g) h = ((b - r) / d + 2) * 60.0;
        else h = ((r - g) / d + 4) * 60.0;
    }

    static Color FromHsl(double h, double s, double l, int alpha)
    {
        if (s <= 0)
        {
            int v = (int)Math.Round(l * 255);
            v = Math.Max(0, Math.Min(255, v));
            return Color.FromArgb(alpha, v, v, v);
        }
        double q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        double p = 2 * l - q;
        Func<double, double> hue = t =>
        {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1.0 / 6) return p + (q - p) * 6 * t;
            if (t < 1.0 / 2) return q;
            if (t < 2.0 / 3) return p + (q - p) * (2.0 / 3 - t) * 6;
            return p;
        };
        double hh = h / 360.0;
        int r = (int)Math.Round(hue(hh + 1.0 / 3) * 255);
        int g = (int)Math.Round(hue(hh) * 255);
        int b = (int)Math.Round(hue(hh - 1.0 / 3) * 255);
        return Color.FromArgb(alpha,
            Math.Max(0, Math.Min(255, r)),
            Math.Max(0, Math.Min(255, g)),
            Math.Max(0, Math.Min(255, b)));
    }

    public static string Process(string path, string outPath)
    {
        int moved = 0;
        using (var src = new Bitmap(path))
        using (var dst = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb))
        {
            for (int y = 0; y < src.Height; y++)
            {
                for (int x = 0; x < src.Width; x++)
                {
                    Color c = src.GetPixel(x, y);
                    if (c.A == 0) { dst.SetPixel(x, y, c); continue; }
                    double h, s, l;
                    ToHsl(c, out h, out s, out l);
                    if (s > 0.18 && h >= FromLow && h <= FromHigh)
                    {
                        // Keep the pixel's position inside the band, so a
                        // gradient keeps its direction instead of flattening.
                        double t = (h - FromLow) / (FromHigh - FromLow);
                        h = ToLow + t * (ToHigh - ToLow);
                        moved++;
                        dst.SetPixel(x, y, FromHsl(h, s, l, c.A));
                    }
                    else
                    {
                        dst.SetPixel(x, y, c);
                    }
                }
            }
            dst.Save(outPath, ImageFormat.Png);
        }
        return moved + " px recoloured";
    }
}
'@

Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root "public"
$icons = @("favicon-32.png", "favicon-192.png", "favicon-512.png", "apple-touch-icon.png")

foreach ($icon in $icons) {
    $path = Join-Path $dir $icon
    if (-not (Test-Path $path)) { Write-Output "$icon missing"; continue }
    $tmp = Join-Path $dir "$icon.new.png"
    $result = [RecolorIcons]::Process($path, $tmp)
    Move-Item $tmp $path -Force
    Write-Output ("{0,-22} {1}" -f $icon, $result)
}
