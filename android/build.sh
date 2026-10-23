#!/bin/bash
# Build the FRIDAY One app on an aarch64 host.
#
# Two host quirks are load-bearing here:
#
#  1. QEMU_LD_PREFIX points qemu-user at the x86_64 sysroot. The Android SDK
#     ships x86_64 build-tools only, and binfmt_misc is registered for
#     x86_64 (so no explicit qemu- prefix is needed) but qemu still has to be
#     told where the x86_64 libc lives. Without this, aapt2 dies with
#     "Could not open '/lib64/ld-linux-x86-64.so.2'" and AGP reports it as
#     "AAPT2 daemon startup failed", which reads like a Gradle bug and is not.
#     A shell-script aapt2 wrapper is NOT an alternative: AGP rejects a
#     non-ELF override with "does not point to an AAPT2 executable".
#
#  2. workers.max=2 keeps emulated aapt2 processes from thrashing 2 cores.
set -euo pipefail
export QEMU_LD_PREFIX=/usr/x86_64-linux-gnu

cd "$(dirname "$0")"

VARIANT="${1:-debug}"
BASE_URL="${FRIDAY_BASE_URL:-}"

ARGS=(":app:assemble${VARIANT^}" --console=plain)
if [ -n "$BASE_URL" ]; then
  ARGS+=("-PFRIDAY_BASE_URL=$BASE_URL")
fi

exec gradle "${ARGS[@]}"
