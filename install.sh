#!/bin/sh
# Installs the relay client from the latest GitHub release.
#
#   curl -fsSL https://relay.tnnnnnnnl.xyz/install | sh
#
# Environment:
#   RELAY_VERSION       a tag such as v0.1.0 (default: latest)
#   RELAY_INSTALL_DIR   where to put the binary (default: /usr/local/bin if
#                       writable, else ~/.local/bin)
#   RELAY_DOWNLOAD_BASE release URL base, for testing
#
# Everything runs inside main, so a download cut short runs nothing.

set -eu

main() {
	base="${RELAY_DOWNLOAD_BASE:-https://github.com/shahnewaz-labib/relay/releases}"
	version="${RELAY_VERSION:-latest}"

	case "$(uname -s)" in
	Darwin) os=darwin ;;
	Linux) os=linux ;;
	*) fail "unsupported OS $(uname -s). On Windows, download relay_windows_*.zip from $base" ;;
	esac
	case "$(uname -m)" in
	x86_64 | amd64) arch=amd64 ;;
	arm64 | aarch64) arch=arm64 ;;
	*) fail "unsupported CPU $(uname -m)" ;;
	esac

	if [ "$version" = latest ]; then
		url="$base/latest/download"
	else
		url="$base/download/$version"
	fi
	archive="relay_${os}_${arch}.tar.gz"

	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT

	say "downloading $archive ($version)"
	fetch "$url/$archive" "$tmp/$archive"
	fetch "$url/checksums.txt" "$tmp/checksums.txt"

	want="$(awk -v f="$archive" '$2 == f { print $1 }' "$tmp/checksums.txt")"
	[ -n "$want" ] || fail "$archive is not listed in checksums.txt"
	got="$(sha256 "$tmp/$archive")"
	[ "$want" = "$got" ] || fail "checksum mismatch for $archive"

	tar -xzf "$tmp/$archive" -C "$tmp" relay

	dir="${RELAY_INSTALL_DIR:-}"
	if [ -z "$dir" ]; then
		if [ -w /usr/local/bin ]; then
			dir=/usr/local/bin
		else
			dir="$HOME/.local/bin"
		fi
	fi
	mkdir -p "$dir"
	mv "$tmp/relay" "$dir/relay"
	chmod 755 "$dir/relay"

	say "installed $("$dir/relay" --version) to $dir/relay"
	case ":$PATH:" in
	*":$dir:"*) ;;
	*) say "add $dir to your PATH, e.g.: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile" ;;
	esac
	say "try it: relay 3000"
}

fetch() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL -o "$2" "$1" || fail "download failed: $1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1" || fail "download failed: $1"
	else
		fail "need curl or wget"
	fi
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{ print $1 }'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | awk '{ print $1 }'
	else
		fail "need sha256sum or shasum to verify the download"
	fi
}

say() { printf 'relay: %s\n' "$1"; }
fail() {
	printf 'relay: %s\n' "$1" >&2
	exit 1
}

main "$@"
