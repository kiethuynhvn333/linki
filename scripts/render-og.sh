#!/bin/sh
# Rebuild the share PNGs from the SVG sources in assets/.
# Needs rsvg-convert (Ubuntu/Debian: librsvg2-bin). optipng and Pillow are optional.
# The wordmark uses assets/font/BricolageGrotesque-800.ttf (a subset of
# Bricolage Grotesque ExtraBold, SIL OFL — see assets/font/OFL.txt).
# assets/og.svg is the card that ships at /og.png. It is variant C (assets/og-c.svg).
# Studies: assets/og-a.svg, assets/og-b.svg, assets/og-c.svg.
set -eu
cd "$(dirname "$0")/.."

render() {
  src=$1
  width=$2
  height=$3
  dest=$4
  rsvg-convert -w "$width" -h "$height" "$src" -o "$dest"
  python3 - "$dest" << 'PY' || true
import sys
try:
    from PIL import Image
except ImportError:
    raise SystemExit(0)
Image.open(sys.argv[1]).convert("RGB").save(sys.argv[1], optimize=True)
PY
  if command -v optipng >/dev/null 2>&1; then
    optipng -quiet -o2 "$dest"
  fi
}

render assets/og.svg 1200 630 assets/og.png
render assets/icon.svg 180 180 assets/apple-touch-icon.png
render assets/icon.svg 512 512 assets/icon-512.png
echo "wrote assets/og.png assets/apple-touch-icon.png assets/icon-512.png"
