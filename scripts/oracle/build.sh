#!/bin/sh
# build.sh – the .lmp oracle: Chocolate Doom 3.1.0 (GPL-2, fetched, never in this repo),
# built as it ships with one MIT file of ours linked in (dump.c, wrapping G_Ticker and
# P_SetupLevel), to run headless and trace vanilla's game tic by tic (npm run oracle;
# docs/ROADMAP.md, .lmp demos).
#
#   scripts/oracle/build.sh [DIR]      (default: oracle-build/, git-ignored)
#
# Needs a C compiler, CMake and SDL2, SDL2_mixer and SDL2_net with their headers
# (Ubuntu: apt-get install libsdl2-dev libsdl2-mixer-dev libsdl2-net-dev). Prints the
# binary's path.
set -e
here=$(cd "$(dirname "$0")" && pwd)
dir=${1:-$here/../../oracle-build}
mkdir -p "$dir"
dir=$(cd "$dir" && pwd)
tag=chocolate-doom-3.1.0
if [ ! -d "$dir/chocolate-doom" ]; then
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$tag" https://github.com/chocolate-doom/chocolate-doom.git "$dir/chocolate-doom"
fi
src="$dir/chocolate-doom"
mkdir -p "$dir/build"
cd "$dir/build"
# (dump.c needs the config.h CMake generates: configure first with an empty dump.o, then build it)
[ -f dump.o ] || { : > empty.c && cc -c -o dump.o empty.c; }
cmake -S "$src" -B . -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_EXE_LINKER_FLAGS="-Wl,--wrap=G_Ticker -Wl,--wrap=P_SetupLevel" -DCMAKE_C_STANDARD_LIBRARIES="$dir/build/dump.o" >/dev/null
cc -c -O1 -I"$src/src" -I"$src/src/doom" -I"$dir/build" -o dump.o "$here/dump.c"
rm -f src/chocolate-doom   # (CMake doesn't know the binary depends on dump.o: link it again)
cmake --build . --target chocolate-doom -j "$(nproc)" >/dev/null
echo "$dir/build/src/chocolate-doom"
