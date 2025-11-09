#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0
#
# Universal Zephyr OpenOCD build wrapper
#
# Builds Zephyr OpenOCD for:
#   - Linux (native)
#   - Windows (cross from Linux)
#   - macOS (native)
#
# Output archives:
#   openocd-zephyr-<version>-<os>-<arch>.<ext>
# Each contains a top-level "openocd/" folder.
#
# Usage:
#   ./build-openocd.sh [linux|windows|mac|all]
#
# Recommended hosts:
#   - Linux: Ubuntu 20.04 or newer
#   - macOS: 12.0 or newer (with Homebrew installed)

set -euo pipefail

TARGET="${1:-all}"

# --- Paths and constants ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_URL="https://github.com/zephyrproject-rtos/openocd.git"
REPO_DIR="${SCRIPT_DIR}/openocd"
BUILD_DIR="${SCRIPT_DIR}/build"
INSTALL_DIR="${SCRIPT_DIR}/install"
OUTPUT_DIR="${SCRIPT_DIR}/output"
PKG_DIR="${SCRIPT_DIR}/packages"
CROSSLIB_DIR="${SCRIPT_DIR}/mingw-root/x86_64-w64-mingw32"
NUM_JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu || echo 4)"
OS_NAME="$(uname -s)"

mkdir -p "${BUILD_DIR}" "${INSTALL_DIR}" "${OUTPUT_DIR}" "${PKG_DIR}"

# === Verify platform ===
if [[ "$TARGET" == "mac" && "$OS_NAME" != "Darwin" ]]; then
  echo "❌ mac build requested but this host is not macOS. Run this on macOS."
  exit 1
elif [[ "$TARGET" != "mac" && "$OS_NAME" != "Linux" ]]; then
  echo "❌ Non-mac build requested but this host is not Linux."
  exit 1
fi

# === Install dependencies ===
if [[ "$OS_NAME" == "Linux" ]]; then
  echo ">>> Installing Linux dependencies..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y
    sudo apt-get install -y \
      git build-essential autoconf automake libtool pkg-config gettext texinfo cmake \
      libusb-1.0-0-dev libhidapi-dev libftdi1-dev \
      mingw-w64 mingw-w64-tools mingw-w64-x86-64-dev p7zip-full wget
  fi
elif [[ "$OS_NAME" == "Darwin" ]]; then
  echo ">>> Checking for macOS dependencies..."
  if ! command -v brew >/dev/null 2>&1; then
    echo "❌ Homebrew not found. Please install it from https://brew.sh"
    exit 1
  fi
  brew install -q autoconf automake libtool pkg-config hidapi libftdi libusb gettext texinfo cmake || true
fi

# === Clone or update OpenOCD source ===
if [[ ! -d "${REPO_DIR}" ]]; then
  echo ">>> Cloning Zephyr OpenOCD..."
  git clone --recurse-submodules "${REPO_URL}" "${REPO_DIR}"
else
  echo ">>> Updating Zephyr OpenOCD..."
  cd "${REPO_DIR}"
  git fetch --all
  git pull --recurse-submodules
  git submodule update --init --recursive
  cd "${SCRIPT_DIR}"
fi

# === Detect version ===
detect_version() {
  if [[ -f "${REPO_DIR}/configure.ac" ]]; then
    grep "AC_INIT" "${REPO_DIR}/configure.ac" | sed -E 's/.*\[openocd\], *\[([^]]+)\].*/\1/'
  else
    echo "unknown"
  fi
}
OPENOCD_VERSION="$(detect_version)"
echo ">>> Detected OpenOCD version: ${OPENOCD_VERSION}"

# === Determine targets ===
if [[ "$TARGET" == "all" ]]; then
  TARGETS=("linux" "windows")
  [[ "$OS_NAME" == "Darwin" ]] && TARGETS=("mac")
else
  TARGETS=("$TARGET")
fi

# === Helper: packaging ===
package_output() {
  local target="$1"
  local src_dir="$2"
  case "$target" in
    linux)   os="linux";  arch="x86_64";  ext="tar.xz";;
    windows) os="win32";  arch="x86_64";  ext="7z";;
    mac)     os="darwin"; arch="$(uname -m)"; ext="tar.xz";;
  esac
  local outfile="${PKG_DIR}/openocd-zephyr-${OPENOCD_VERSION}-${os}-${arch}.${ext}"
  local tempdir
  tempdir="$(mktemp -d)"
  mkdir -p "${tempdir}/openocd"
  cp -a "${src_dir}/." "${tempdir}/openocd/"
  cd "${tempdir}"
  if [[ "$ext" == "7z" ]]; then
    7z a -mx9 "${outfile}" openocd >/dev/null
  else
    tar -cJf "${outfile}" openocd
  fi
  cd "${SCRIPT_DIR}"
  rm -rf "${tempdir}"
  echo "✅ Created: ${outfile}"
}

# === Build Windows dependencies (libusb/hidapi/ftdi) ===
build_cross_libs() {
  echo ">>> Building required MinGW cross-libs..."
  local PREFIX="${CROSSLIB_DIR}"
  local LIBDIR="${PREFIX}/lib"
  mkdir -p "${LIBDIR}"
  cd "${SCRIPT_DIR}"
  mkdir -p cross-libs && cd cross-libs

  # libusb
  if [[ ! -f "${LIBDIR}/libusb-1.0.a" ]]; then
    echo ">>> Building libusb..."
    rm -rf libusb
    git clone --depth=1 https://github.com/libusb/libusb.git
    cd libusb
    ./bootstrap.sh
    ./configure --host=x86_64-w64-mingw32 --prefix="${PREFIX}" --enable-static --disable-shared
    make -j"${NUM_JOBS}" && make install
    cd ..
  fi

  # hidapi
  if [[ ! -f "${LIBDIR}/libhidapi.a" ]]; then
    echo ">>> Building hidapi..."
    rm -rf hidapi
    git clone --depth=1 https://github.com/libusb/hidapi.git
    cd hidapi
    ./bootstrap
    ./configure --host=x86_64-w64-mingw32 --prefix="${PREFIX}" --enable-static --disable-shared
    make -j"${NUM_JOBS}" && make install
    cd ..
  fi

  # libftdi
  if [[ ! -f "${LIBDIR}/libftdi1.a" ]]; then
    echo ">>> Building libftdi1..."
    rm -rf libftdi1-1.5
    wget -q https://www.intra2net.com/en/developer/libftdi/download/libftdi1-1.5.tar.bz2
    tar xf libftdi1-1.5.tar.bz2
    cd libftdi1-1.5
    mkdir -p build && cd build
    cmake .. \
      -DCMAKE_SYSTEM_NAME=Windows \
      -DCMAKE_C_COMPILER=x86_64-w64-mingw32-gcc \
      -DCMAKE_CXX_COMPILER=x86_64-w64-mingw32-g++ \
      -DCMAKE_INSTALL_PREFIX="${PREFIX}" \
      -DLIBFTDI1_LIBRARY_TYPE=STATIC \
      -DLIBUSB_LIBRARIES="${PREFIX}/lib/libusb-1.0.a" \
      -DLIBUSB_INCLUDE_DIR="${PREFIX}/include/libusb-1.0" \
      -DPYTHON_BINDINGS=OFF -DEXAMPLES=OFF -DFTDIPP=OFF -DFTDI_EEPROM=OFF
    make -j"${NUM_JOBS}" && make install
    cd "${SCRIPT_DIR}/cross-libs"
  fi

  echo "✅ Cross-libs built in ${PREFIX}"
}

# === Build for Linux ===
build_linux() {
  echo ">>> Building OpenOCD for Linux..."
  mkdir -p "${BUILD_DIR}/linux"
  cd "${REPO_DIR}"
  ./bootstrap
  cd "${BUILD_DIR}/linux"
  "${REPO_DIR}/configure" \
    --enable-ftdi --enable-cmsis-dap --enable-jlink --enable-stlink \
    --disable-doxygen-html --disable-git-update --disable-werror \
    --prefix="${INSTALL_DIR}/linux"
  make -j"${NUM_JOBS}"
  make install
  package_output "linux" "${INSTALL_DIR}/linux"
}

# === Build for Windows (cross) ===
build_windows() {
  echo ">>> Building OpenOCD for Windows..."
  build_cross_libs
  local PREFIX="${INSTALL_DIR}/windows"
  mkdir -p "${BUILD_DIR}/windows"
  cd "${REPO_DIR}"
  ./bootstrap
  cd "${BUILD_DIR}/windows"
  export PKG_CONFIG_PATH="${CROSSLIB_DIR}/lib/pkgconfig"
  export LDFLAGS="-static"
  export CPPFLAGS="-I${CROSSLIB_DIR}/include"
  export PATH="${CROSSLIB_DIR}/bin:$PATH"

  export LIBUSB1_CFLAGS="-I${CROSSLIB_DIR}/include/libusb-1.0"
  export LIBUSB1_LIBS="-L${CROSSLIB_DIR}/lib -lusb-1.0"
  export HIDAPI_CFLAGS="-I${CROSSLIB_DIR}/include/hidapi"
  export HIDAPI_LIBS="-L${CROSSLIB_DIR}/lib -lhidapi"

  "${REPO_DIR}/configure" \
    --host=x86_64-w64-mingw32 \
    --enable-ftdi --enable-cmsis-dap --enable-jlink --enable-stlink \
    --disable-doxygen-html --disable-git-update --disable-werror \
    --prefix="${PREFIX}"
  make -j"${NUM_JOBS}"
  make install
  package_output "windows" "${PREFIX}"
}

# === Build for macOS ===
build_mac() {
  echo ">>> Building OpenOCD for macOS..."
  mkdir -p "${BUILD_DIR}/mac"
  cd "${REPO_DIR}"
  ./bootstrap
  cd "${BUILD_DIR}/mac"
  "${REPO_DIR}/configure" \
    --enable-ftdi --enable-cmsis-dap --enable-jlink --enable-stlink \
    --disable-doxygen-html --disable-git-update --disable-werror \
    --prefix="${INSTALL_DIR}/mac"
  make -j"${NUM_JOBS}"
  make install
  package_output "mac" "${INSTALL_DIR}/mac"
}

# === Run builds ===
for t in "${TARGETS[@]}"; do
  case "$t" in
    linux) build_linux ;;
    windows) build_windows ;;
    mac) build_mac ;;
  esac
done

echo
echo "✅ All builds completed successfully."
echo "Packages in: ${PKG_DIR}"
ls -1 "${PKG_DIR}"
