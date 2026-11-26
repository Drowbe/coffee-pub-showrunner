#!/usr/bin/env bash
# Joins the arm64 and x86_64 builds into one universal ffmpeg, checks it works, and writes the package with its licence and source notes.
# Usage: scripts/ffmpeg/package-mac.sh <dir holding ffmpeg-mac-arm64/ffmpeg and ffmpeg-mac-x86_64/ffmpeg> <output dir>
set -euo pipefail
IN="${1:?input dir}"; OUT="${2:?output dir}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/versions.env"
mkdir -p "$OUT/pkg"
lipo -create "$IN/ffmpeg-mac-arm64/ffmpeg" "$IN/ffmpeg-mac-x86_64/ffmpeg" -output "$OUT/pkg/ffmpeg"
chmod +x "$OUT/pkg/ffmpeg"
lipo -info "$OUT/pkg/ffmpeg"

echo "== check: the encoders Showrunner uses"
"$OUT/pkg/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -E "h264_videotoolbox|libx264 | aac " 
for e in h264_videotoolbox libx264 aac; do "$OUT/pkg/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q " $e " || { echo "missing encoder $e"; exit 1; }; done
echo "== check: a short recording both ways, with the options the recorder uses"
"$OUT/pkg/ffmpeg" -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=1920x1080:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 2 \
  -c:v h264_videotoolbox -b:v 8000k -profile:v high -realtime 1 -g 60 -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +frag_keyframe+empty_moov+default_base_moof -f mp4 "$OUT/check-vt.mp4"
"$OUT/pkg/ffmpeg" -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=1920x1080:rate=30 -t 2 \
  -c:v libx264 -preset veryfast -b:v 8000k -maxrate 10000k -bufsize 16000k -g 60 -pix_fmt yuv420p -f matroska "$OUT/check-x264.mkv"
test -s "$OUT/check-vt.mp4" && test -s "$OUT/check-x264.mkv"
rm -f "$OUT/check-vt.mp4" "$OUT/check-x264.mkv"

# The licence and where the source is. The GPL asks that anyone who gets the program can get the source, so this travels with it.
curl -sSL -o "$OUT/ffmpeg-src.tar.xz" "$FFMPEG_URL"
echo "$FFMPEG_SHA256  $OUT/ffmpeg-src.tar.xz" | shasum -a 256 -c -
tar -xJf "$OUT/ffmpeg-src.tar.xz" -C "$OUT" --strip-components=1 "ffmpeg-$FFMPEG_VERSION/COPYING.GPLv3" "ffmpeg-$FFMPEG_VERSION/LICENSE.md"
mv "$OUT/COPYING.GPLv3" "$OUT/pkg/COPYING.GPLv3"; mv "$OUT/LICENSE.md" "$OUT/pkg/FFMPEG-LICENSE.md"; rm -f "$OUT/ffmpeg-src.tar.xz"
cat > "$OUT/pkg/SOURCE.txt" <<TXT
This ffmpeg program is free software, licensed under the GNU General Public License (see COPYING.GPLv3 and FFMPEG-LICENSE.md).
It is built from these sources, unmodified:

  FFmpeg $FFMPEG_VERSION   $FFMPEG_URL   (sha256 $FFMPEG_SHA256)
  x264 (GPL)              $X264_REPO   commit $X264_COMMIT

and the scripts in https://github.com/Drowbe/coffee-pub-showrunner/tree/main/scripts/ffmpeg (build revision $BUILD_REVISION).
Configured with: --enable-gpl --enable-libx264 --enable-videotoolbox --enable-zlib --disable-autodetect --disable-network
                 --disable-doc --disable-debug --disable-ffplay --disable-ffprobe --disable-shared --enable-static

Showrunner runs this program as a separate program; it does not link to it.
TXT
( cd "$OUT/pkg" && zip -q -r "../ffmpeg-mac-universal-$FFMPEG_VERSION-r$BUILD_REVISION.zip" . )
( cd "$OUT" && shasum -a 256 "ffmpeg-mac-universal-$FFMPEG_VERSION-r$BUILD_REVISION.zip" | tee "ffmpeg-mac-universal-$FFMPEG_VERSION-r$BUILD_REVISION.zip.sha256" )
rm -rf "$OUT/pkg"
ls -l "$OUT"
