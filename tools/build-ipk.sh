#!/bin/sh
# Build an installable .ipk for luci-app-ipping without the OpenWrt SDK.
# Works on any POSIX host with ar, tar and gzip (macOS / Linux / WSL).
#
#   tools/build-ipk.sh [output.ipk]
#
# Note: translation catalogs (.po) are not compiled by this script, the UI
# falls back to English. Use the OpenWrt SDK for localized packages and for
# .apk packages (OpenWrt 24.10+).

set -e

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
name=luci-app-ipping
version=1.0.0
release=1
out=${1:-"$here/${name}_${version}-${release}_all.ipk"}

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/control" "$stage/data"
cp -a "$here/root/." "$stage/data/"
mkdir -p "$stage/data/www"
cp -a "$here/htdocs/." "$stage/data/www/"

# make sure executable bits are right
chmod 755 "$stage/data/etc/init.d/ipping" \
         "$stage/data/etc/uci-defaults/luci-app-ipping" \
         "$stage/data/usr/libexec/ipping" \
         "$stage/data/usr/libexec/ipping/ippingd" \
         "$stage/data/usr/libexec/ipping/ipping-cat" \
         "$stage/data/usr/libexec/ipping/ipping-lib.sh"

installed_size=$(du -sk "$stage/data" | cut -f1)

cat > "$stage/control/control" <<EOF
Package: $name
Version: $version-$release
Depends: luci-base
Architecture: all
Section: luci
Source: $name
Installed-Size: $installed_size
Description: IP Ping Monitor for LuCI.
 Periodically pings multiple targets and stores per-minute and hourly
 latency/loss data in a compact architecture-independent binary format.
 Minute data retention defaults to 7 days, hourly data to 365 days,
 both configurable. Storage directory is configurable (tmpfs or
 persistent storage). Data is displayed as SVG charts in LuCI.
EOF

# same postinst luci.mk generates: rebuild LuCI menu cache + reload rpcd
cat > "$stage/control/postinst" <<'EOF'
[ -n "${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd reload 2>/dev/null
	exit 0
}
EOF

(cd "$stage/control" && tar czf "$stage/control.tar.gz" control postinst)
(cd "$stage/data" && tar czf "$stage/data.tar.gz" .)
echo 2.0 > "$stage/debian-binary"
(cd "$stage" && ar rc "$out" debian-binary control.tar.gz data.tar.gz)

echo "Built $out"
echo "Install with:  opkg install $(basename "$out")"
