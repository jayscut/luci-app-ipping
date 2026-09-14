#!/bin/sh
# Host-side functional tests for luci-app-ipping.
# Runs on any POSIX-ish sh (tested on macOS /bin/sh and busybox ash).
set -u

TESTDIR=$(cd "$(dirname "$0")" && pwd)
ROOTDIR=$(cd "$TESTDIR/.." && pwd)
LIBDIR="$ROOTDIR/root/usr/libexec/ipping"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/cfg" "$TMP/data" "$TMP/bin"
cp "$TESTDIR/stub-ping" "$TMP/bin/ping"
cp "$TESTDIR/stub-uci" "$TMP/bin/uci"
chmod +x "$TMP/bin/ping" "$TMP/bin/uci"

export PATH="$TMP/bin:$PATH"
export IPPING_UCI_DIR="$TMP/cfg"
export IPPING_LIB_DIR="$LIBDIR"
export STUB_PING_MODE=ok

PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $*" >&2; }
assert_eq() { # <what> <expected> <actual>
	if [ "$2" = "$3" ]; then ok; else bad "$1: expected [$2] got [$3]"; fi
}

write_cfg() { # <dbdir>
	cat > "$TMP/cfg/ipping" <<EOF
config ipping 'global'
	option enabled '1'
	option interval '60'
	option count '3'
	option timeout '1'
	option size '56'
	option dbdir '$1'
	option minute_retention '10080'
	option hour_retention '8760'

config target
	option name 'gw'
	option host '192.168.1.1'
	option enabled '1'

config target
	option name 'dns'
	option host '8.8.8.8'
	option enabled '0'
EOF
}

write_cfg "$TMP/data"

. "$LIBDIR/ipping-lib.sh"
IPPINGD_NO_MAIN=1 . "$LIBDIR/ippingd"

# ---------- slug ----------
assert_eq "slug sanitize" "My_ISP_" "$(ipp_slug 'My ISP!')"
assert_eq "slug empty" "target" "$(ipp_slug '')"

# ---------- epoch conversion ----------
if command -v python3 >/dev/null 2>&1; then
	for d in 19700101 20260913 20240301 20000229 21001231; do
		exp=$(python3 -c "import calendar; print(calendar.timegm((int('$d'[0:4]),int('$d'[4:6]),int('$d'[6:8]),0,0,0)))")
		assert_eq "ymd_to_epoch $d" "$exp" "$(ipp_ymd_to_epoch "$d")"
	done
fi

# ---------- record index ----------
# 2024-02-29 23:00 UTC is the last hour of the leap February file (29*24 = 696)
assert_eq "record_index leap" "695" "$(ipp_record_index "$(( $(ipp_ymd_to_epoch 20240229) + 82800 ))" h)"
assert_eq "record_index mar1h0" "0" "$(ipp_record_index "$(ipp_ymd_to_epoch 20240301)" h)"
assert_eq "record_index day1h5" "5" "$(ipp_record_index "$(( $(ipp_ymd_to_epoch 20240301) + 18000 ))" h)"
assert_eq "record_index minute" "1439" "$(ipp_record_index "$(( $(ipp_ymd_to_epoch 20260913) + 86340 ))" m)"

# ---------- minute record layout (8 bytes, LE) ----------
now=$(date +%s)
today=$(ipp_period_of "$now" m)
E=$(ipp_ymd_to_epoch "$today")           # midnight UTC today -> minute index 0
rm -f "$TMP/data"/gw_*.m.bin
ipp_write_record m gw "$E" 1 2 3 5 0
f="$TMP/data/gw_${today}.m.bin"
assert_eq "minute file size" "8" "$(wc -c < "$f" | tr -d ' ')"
assert_eq "minute record hex" "0100020003000500" "$(ipp_bin2hex "$f" 0 8)"

# sparse hole: write minute 2, hole at 1, size must cover index 2
ipp_write_record m gw "$((E + 120))" 10 20 30 3 1
assert_eq "sparse size" "24" "$(wc -c < "$f" | tr -d ' ')"
assert_eq "sparse rec2 hex" "0a0014001e000301" "$(ipp_bin2hex "$f" 16 8)"
assert_eq "hole read as zeros" "0000000000000000" "$(ipp_bin2hex "$f" 8 8)"

# ---------- hourly record layout (10 bytes) ----------
month=$(ipp_period_of "$now" h)
rm -f "$TMP/data"/gw_*.h.bin
ipp_write_record h gw "$E" 1000 1500 2000 15 6
hf="$TMP/data/gw_${month}.h.bin"
hidxE=$(ipp_record_index "$E" h)
assert_eq "hourly file size" "$(( (hidxE + 1) * 10 ))" "$(wc -c < "$hf" | tr -d ' ')"
assert_eq "hourly record hex" "e803dc05d0070f000600" "$(ipp_bin2hex "$hf" $((hidxE * 10)) 10)"

# ---------- hourly aggregation (weighted avg, loss totals, holes) ----------
rm -f "$TMP/data"/gw_*.m.bin "$TMP/data"/gw_*.h.bin "$TMP/data"/gw.state
H=$(( (now - now % 3600) - 7200 ))       # two full hours ago
ipp_write_record m gw "$H"        1000 1000 1000 5 0
ipp_write_record m gw "$((H + 60))"  1000 2000 3000 5 1
ipp_write_record m gw "$((H + 120))"    0    0    0 5 5
printf '%s\n' "$((H - 3600))" > "$TMP/data/gw.state"

ipp_aggregate_target gw 10080 8760
assert_eq "aggregate rc" "0" "$?"
# cursor stops at the last CLOSED hour (cur_hour - 3600), never the current one
assert_eq "aggregate state" "$((H + 3600))" "$(cat "$TMP/data/gw.state")"
hidx=$(ipp_record_index "$H" h)
got=$(ipp_bin2hex "$hf" $((hidx * 10)) 10)
assert_eq "aggregated hour record" "e803dc05b80b0f000600" "$got"

# the current (unclosed) hour must not have been aggregated
curh=$(( (now - now % 3600) ))
hidxc=$(ipp_record_index "$curh" h)
szc=$(wc -c < "$hf" | tr -d ' ')
if [ "$szc" -le $((hidxc * 10)) ]; then ok; else
	v=$(ipp_bin2hex "$hf" $((hidxc * 10)) 10)
	case "$v" in 00000000000000000000|'') ok ;; *) bad "unclosed hour was aggregated: $v" ;; esac
fi

# the next (empty) hour must stay a hole
hidx2=$((hidx + 1))
sz=$(wc -c < "$hf" | tr -d ' ')
if [ "$sz" -le $((hidx2 * 10)) ]; then ok; else
	v=$(ipp_bin2hex "$hf" $((hidx2 * 10)) 10)
	case "$v" in 00000000000000000000|'') ok ;; *) bad "empty hour not a hole: $v" ;; esac
fi

# idempotent: running again must not change anything
ipp_aggregate_target gw 10080 8760
assert_eq "aggregate idempotent" "e803dc05b80b0f000600" "$(ipp_bin2hex "$hf" $((hidx * 10)) 10)"

# ---------- cleanup ----------
rm -f "$TMP/data"/gw_* "$TMP/data"/gw.state
ipp_write_record m gw "$E" 1 1 1 3 0
ipp_write_record h gw "$E" 1 1 1 15 6
: > "$TMP/data/gw_20200101.m.bin"
: > "$TMP/data/gw_202001.h.bin"
ipp_cleanup gw 10080 8760
[ -f "$TMP/data/gw_20200101.m.bin" ] && bad "old day file not removed" || ok
[ -f "$TMP/data/gw_202001.h.bin" ] && bad "old month file not removed" || ok
[ -f "$TMP/data/gw_${today}.m.bin" ] && ok || bad "today file removed"
[ -f "$TMP/data/gw_${month}.h.bin" ] && ok || bad "current month removed"

# ---------- ipping-cat ----------
rm -f "$TMP/data"/gw_*
ipp_write_record m gw "$E"         1 2 3 3 0
ipp_write_record m gw "$((E + 60))"  4 5 6 3 0
ipp_write_record m gw "$((E + 120))" 7 8 9 3 0
out=$("$LIBDIR/ipping-cat" files gw m)
assert_eq "cat files" "FILES ${today} " "$out"
out=$("$LIBDIR/ipping-cat" read gw m "$today" 0 1440)
assert_eq "cat read full" "HEX
010002000300030004000500060003000700080009000300" "$out"
out=$("$LIBDIR/ipping-cat" read gw m "$today" 2 1)
assert_eq "cat read partial" "HEX
0700080009000300" "$out"
out=$("$LIBDIR/ipping-cat" read gw m 19990101 0 10)
assert_eq "cat read missing" "HEX" "$out"
out=$("$LIBDIR/ipping-cat" read ../etc/passwd m "$today" 0 10)
assert_eq "cat path traversal blocked" "ERR
bad slug" "$out"
out=$("$LIBDIR/ipping-cat" files ../x m)
assert_eq "cat files traversal blocked" "FILES" "$out"
out=$("$LIBDIR/ipping-cat" read gw m "$today" 0 999999)
assert_eq "cat read capped" "HEX
010002000300030004000500060003000700080009000300" "$out"

# ---------- ping round parsing ----------
rm -f "$TMP/data"/gw_*
load_config
slot=$(( (now / 60) * 60 ))
ipp_ping_round "192.168.1.1"
assert_eq "ok: min" "1" "$P_MIN"
assert_eq "ok: avg" "1" "$P_AVG"
assert_eq "ok: max" "2" "$P_MAX"
assert_eq "ok: sent" "3" "$P_SENT"
assert_eq "ok: lost" "0" "$P_LOST"

STUB_PING_MODE=partial ipp_ping_round "192.168.1.1"
assert_eq "partial: avg" "8" "$P_AVG"
assert_eq "partial: lost" "1" "$P_LOST"

STUB_PING_MODE=iputils ipp_ping_round "192.168.1.1"
assert_eq "iputils: avg" "1" "$P_AVG"
assert_eq "iputils: lost" "0" "$P_LOST"

STUB_PING_MODE=fail ipp_ping_round "192.168.1.1"
assert_eq "fail: rtts zeroed" "0 0 0" "$P_MIN $P_AVG $P_MAX"
assert_eq "fail: loss" "3" "$P_LOST"

STUB_PING_MODE=empty ipp_ping_round "no-such-host.invalid"
assert_eq "unresolvable: loss" "3" "$P_LOST"
STUB_PING_MODE=ok

# ---------- IPv6 round ----------
ipp_ping_round "2001:db8::1"
assert_eq "v6: min" "105" "$P_MIN"
assert_eq "v6: avg" "110" "$P_AVG"
assert_eq "v6: max" "115" "$P_MAX"

# ---------- do_round writes one record per enabled target ----------
rm -f "$TMP/data"/*
do_round "$slot"
f="$TMP/data/gw_${today}.m.bin"
[ -f "$f" ] && ok || bad "do_round: no record for enabled target"
[ -f "$TMP/data/dns_${today}.m.bin" ] && bad "do_round: record for disabled target" || ok
assert_eq "do_round record" "0100010002000300" "$(ipp_bin2hex "$f" $(( (slot % 86400) / 60 * 8 )) 8)"

# ---------- config clamping ----------
cat > "$TMP/cfg/ipping" <<EOF
config ipping 'global'
	option enabled '1'
	option interval '30'
	option count '999'
	option timeout '0'
	option size '99999'
	option dbdir '$TMP/data'
	option minute_retention '1'
	option hour_retention '1'
EOF
load_config
assert_eq "clamp interval" "60" "$C_INTERVAL"
assert_eq "clamp count" "20" "$C_COUNT"
assert_eq "clamp timeout" "1" "$C_TIMEOUT"
assert_eq "clamp size" "1400" "$C_SIZE"
assert_eq "clamp minute_retention" "10" "$R_MINUTES"
assert_eq "clamp hour_retention" "24" "$R_HOURS"

# ---------- aggregate catch-up across a gap ----------
rm -f "$TMP/data"/*
H2=$(( (now - now % 3600) - 3 * 3600 ))   # 3 hours ago
ipp_write_record m gw "$((H2 + 3000))" 500 500 500 4 0
rm -f "$TMP/data/gw.state"
ipp_aggregate_target gw 10080 8760
assert_eq "catchup rc" "0" "$?"
# the hour of H2 itself has data (one record at +3000) -> aggregated
hidx4=$(ipp_record_index "$H2" h)
assert_eq "catchup partial hour" "f401f401f40104000000" "$(ipp_bin2hex "$hf" $((hidx4 * 10)) 10)"
# the next hour has no minute samples at all -> must stay a hole (no record)
hidx3=$(ipp_record_index "$((H2 + 3600))" h)
assert_eq "catchup empty hour is a hole" "" "$(ipp_bin2hex "$hf" $((hidx3 * 10)) 10)"

echo ""
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
