#!/usr/bin/env bash
# Builds ffmpeg (GPL, with x264 and the Mac's VideoToolbox) for one Mac architecture: arm64 or x86_64.
# Usage: scripts/ffmpeg/build-mac.sh <arch> [work-dir]     Result: <work-dir>/<arch>/prefix/bin/ffmpeg
# x86_64 is cross-compiled on an Apple Silicon Mac (it needs nasm: brew install nasm).
set -euo pipefail
ARCH="${1:?arch: arm64 or x86_64}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/versions.env"
WORK="${2:-$PWD/build/ffmpeg-work}/$ARCH"
PREFIX="$WORK/prefix"
MINVER=11.0
mkdir -p "$WORK" && cd "$WORK"

CC="clang -arch $ARCH"
CROSS=()
if [ "$ARCH" != "$(uname -m)" ]; then CROSS=(--enable-cross-compile --target-os=darwin); fi

echo "== x264 ($X264_COMMIT) for $ARCH"
rm -rf x264 && git clone --quiet "$X264_REPO" x264 && (cd x264 && git checkout --quiet "$X264_COMMIT")
(
  cd x264
  HOST=()
  if [ "$ARCH" = "x86_64" ]; then HOST=(--host=x86_64-apple-darwin); else HOST=(--host=aarch64-apple-darwin); fi
  CC="$CC" ./configure "${HOST[@]}" --prefix="$PREFIX" --enable-static --enable-pic --disable-cli --disable-opencl \
    --extra-cflags="-mmacosx-version-min=$MINVER" --extra-ldflags="-mmacosx-version-min=$MINVER"
  make -j"$(sysctl -n hw.ncpu)"
  make install
)

echo "== ffmpeg $FFMPEG_VERSION for $ARCH"
rm -rf ffmpeg-src "ffmpeg-$FFMPEG_VERSION.tar.xz"
curl -sSL -o "ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_URL"
echo "$FFMPEG_SHA256  ffmpeg-$FFMPEG_VERSION.tar.xz" | shasum -a 256 -c -
mkdir ffmpeg-src && tar -xJf "ffmpeg-$FFMPEG_VERSION.tar.xz" -C ffmpeg-src --strip-components=1
(
  cd ffmpeg-src
  PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure --prefix="$PREFIX" --arch="$ARCH" ${CROSS[@]+"${CROSS[@]}"} \
    --cc="$CC" \
    --extra-cflags="-I$PREFIX/include -mmacosx-version-min=$MINVER" \
    --extra-ldflags="-L$PREFIX/lib -mmacosx-version-min=$MINVER" \
    --pkg-config-flags=--static \
    --enable-gpl --enable-libx264 --enable-videotoolbox --enable-zlib \
    --disable-autodetect --disable-network --disable-doc --disable-debug \
    --disable-ffplay --disable-ffprobe --disable-shared --enable-static
  make -j"$(sysctl -n hw.ncpu)"
  make install
)
strip -x "$PREFIX/bin/ffmpeg"
file "$PREFIX/bin/ffmpeg"
