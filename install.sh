#!/bin/sh
# Install the weather-outlook standalone binary.
#
#   curl -fsSL https://raw.githubusercontent.com/cport1/weather-outlook/main/install.sh | sh
#
# Env: WEATHER_OUTLOOK_VERSION (default: latest), WEATHER_OUTLOOK_INSTALL_DIR (default: ~/.local/bin)
set -eu

REPO="cport1/weather-outlook"
DIR="${WEATHER_OUTLOOK_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required"; }

need curl
need uname

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "unsupported OS $(uname -s) — on Windows, download the .exe from https://github.com/$REPO/releases" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac
target="$os-$arch"
# Alpine and other musl distros need the musl build.
if [ "$os" = linux ] && { [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; }; then
  target="$target-musl"
fi

version="${WEATHER_OUTLOOK_VERSION:-}"
if [ -z "$version" ]; then
  version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
    sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)
  [ -n "$version" ] || die "couldn't determine the latest version"
fi
version="${version#v}"

asset="weather-outlook-$version-$target"
base="https://github.com/$REPO/releases/download/v$version"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

say "Installing weather-outlook $version ($target) to $DIR"
curl -fL --progress-bar "$base/$asset" -o "$tmp/$asset" || die "download failed: $base/$asset"
curl -fsSL "$base/$asset.sha256" -o "$tmp/$asset.sha256" || die "checksum download failed"

expected=$(cut -d' ' -f1 <"$tmp/$asset.sha256")
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)
fi
[ "$expected" = "$actual" ] || die "checksum mismatch for $asset"

mkdir -p "$DIR"
chmod 755 "$tmp/$asset"
mv "$tmp/$asset" "$DIR/weather-outlook"
ln -sf weather-outlook "$DIR/wo"

say "Installed: $("$DIR/weather-outlook" --version)"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) say "Add $DIR to your PATH:  export PATH=\"$DIR:\$PATH\"" ;;
esac
