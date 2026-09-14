#!/bin/sh
# Build an installable .apk package (OpenWrt 24.10+) for luci-app-ipping
# without running a full SDK build.
#
#   tools/build-apk.sh [output.apk]
#   APK_BIN=/path/to/apk tools/build-apk.sh          # locate host apk manually
#   APK_SIGN_KEY=/path/to/key tools/build-apk.sh     # produce a signed package
#
# The host `apk` binary must come from the OpenWrt apk fork (it provides the
# `mkpkg` subcommand used by the OpenWrt buildroot itself):
#   - OpenWrt 24.10+ SDK / buildtree:  staging_dir/host/bin/apk
#   - source:                          https://git.openwrt.org/project/apk.git
# (Alpine's stock apk does NOT support `mkpkg`.)
#
# Without a signing key the package is unsigned; install it with
#   apk add --allow-untrusted ./luci-app-ipping-...apk

set -e

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
name=luci-app-ipping
version=1.0.0-1
out=${1:-"$here/${name}-${version}.apk"}

# ---- locate an apk binary that supports mkpkg -----------------------------
find_apk() {
	for c in \
		"$APK_BIN" \
		"$(command -v apk 2>/dev/null)" \
		"$(pwd)/staging_dir/host/bin/apk" \
		"$(pwd)/../staging_dir/host/bin/apk" \
		"$(pwd)/../../staging_dir/host/bin/apk"; do
		[ -n "$c" ] && [ -x "$c" ] || continue
		if "$c" mkpkg --help 2>&1 | grep -q -- '--output'; then
			printf '%s' "$c"
			return 0
		fi
	done
	return 1
}

if ! APK=$(find_apk); then
	echo "ERROR: no 'apk' binary with 'mkpkg' support found." >&2
	echo "Point APK_BIN at the host apk of an OpenWrt 24.10+ SDK" >&2
	echo "(staging_dir/host/bin/apk), or build the apk fork from" >&2
	echo "https://git.openwrt.org/project/apk.git - or just build the" >&2
	echo "package inside the SDK: make package/luci-app-ipping/compile" >&2
	exit 1
fi
echo "Using apk: $APK"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
idat="$stage/data"
adir="$stage/meta"

# ---- stage the package data (same layout as the OpenWrt build) -----------
mkdir -p "$idat" "$adir"
cp -a "$here/root/." "$idat/"
mkdir -p "$idat/www"
cp -a "$here/htdocs/." "$idat/www/"

chmod 755 "$idat/etc/init.d/ipping" \
         "$idat/etc/uci-defaults/luci-app-ipping" \
         "$idat/usr/libexec/ipping" \
         "$idat/usr/libexec/ipping/ippingd" \
         "$idat/usr/libexec/ipping/ipping-cat" \
         "$idat/usr/libexec/ipping/ipping-lib.sh"

# per-package file list consumed by OpenWrt's apk integration
mkdir -p "$idat/lib/apk/packages"
(cd "$idat" && find . \( -type f -o -type l \) | sed 's|^\./|/|' | LC_ALL=C sort) \
	> "$idat/lib/apk/packages/$name.list"

# ---- install hooks (mirrors include/package-pack.mk + luci.mk) -----------
# default_postinst runs /etc/uci-defaults/*, so installing the package
# creates /etc/config/ipping and enables the init script, just like opkg.
# The luci cache clear + rpcd reload matches the postinst luci.mk generates.
cat > "$adir/post-install" <<'EOF'
#!/bin/sh
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s "${IPKG_INSTROOT}/lib/functions.sh" ] || exit 0
. "${IPKG_INSTROOT}/lib/functions.sh"
[ -n "${IPKG_INSTROOT}" ] || {
	rm -f "${IPKG_INSTROOT}/tmp/luci-indexcache.*"
	rm -rf "${IPKG_INSTROOT}/tmp/luci-modulecache/"
	/etc/init.d/rpcd reload 2>/dev/null
}
export root="${IPKG_INSTROOT}"
export pkgname="luci-app-ipping"
default_postinst
EOF

cat > "$adir/pre-deinstall" <<'EOF'
#!/bin/sh
[ -s "${IPKG_INSTROOT}/lib/functions.sh" ] || exit 0
. "${IPKG_INSTROOT}/lib/functions.sh"
export root="${IPKG_INSTROOT}"
export pkgname="luci-app-ipping"
default_prerm
EOF
chmod 755 "$adir/post-install" "$adir/pre-deinstall"

# ---- package ---------------------------------------------------------------
fakeroot_cmd=''
command -v fakeroot >/dev/null 2>&1 && fakeroot_cmd=fakeroot
[ -n "$fakeroot_cmd" ] || echo "NOTE: fakeroot not found - file ownership will be that of this user (OpenWrt builds as root)."

sig_arg=''
[ -n "$APK_SIGN_KEY" ] && sig_arg="--sign $APK_SIGN_KEY"

$fakeroot_cmd "$APK" mkpkg \
	--info "name:$name" \
	--info "version:$version" \
	--info "description:IP Ping Monitor for LuCI - periodic ping latency collection with graphs" \
	--info "arch:all" \
	--info "license:MIT" \
	--info "origin:$name" \
	--info "maintainer:luci-app-ipping contributors" \
	--info "depends:luci-base" \
	--script "post-install:$adir/post-install" \
	--script "pre-deinstall:$adir/pre-deinstall" \
	--files "$idat" \
	--output "$out" \
	$sig_arg

echo "Built $out"
if [ -n "$APK_SIGN_KEY" ]; then
	echo "Install with:   apk add ./$name-$version.apk"
else
	echo "Install with:   apk add --allow-untrusted ./$name-$version.apk"
fi
