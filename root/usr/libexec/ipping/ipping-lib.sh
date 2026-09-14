#!/bin/sh
# ipping-lib.sh - shared helpers for luci-app-ipping
#
# Binary storage format (architecture independent, all values little-endian):
#
# The timestamp is NOT stored in the records. Time is implied by the file
# name (UTC day / month) and the record offset inside the file:
#
#   <dbdir>/<slug>_YYYYMMDD.m.bin
#       record i (8 bytes) = minute i of that UTC day (i = 0..1439):
#           u16 rtt_min | u16 rtt_avg | u16 rtt_max | u8 sent | u8 lost
#   <dbdir>/<dbdir>/<slug>_YYYYMM.h.bin
#       record i (10 bytes) = hour i of that UTC month (i = 0..743):
#           u16 rtt_min | u16 rtt_avg | u16 rtt_max | u16 sent | u16 lost
#
#   - rtt values are in units of 0.1 ms; 0 means "no data" (a real rtt is
#     always >= 0.1 ms, so 0 can never collide)
#   - records of minutes/hours that were never sampled stay zero (holes)
#   - <dbdir>/<slug>.state is a tiny text cursor: last aggregated hour epoch

# May be overridden for testing; production default is /etc/config
IPPING_UCI_DIR="${IPPING_UCI_DIR:-/etc/config}"

ipp_log() {
	logger -t ipping -p "daemon.info" "$1" 2>/dev/null
}

ipp_warn() {
	logger -t ipping -p "daemon.err" "$1" 2>/dev/null
}

ipp_validate_slug() {
	case "$1" in
		''|*[!A-Za-z0-9_-]*) return 1 ;;
	esac
	return 0
}

ipp_slug() {
	local s
	s=$(printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '_' | cut -c1-64)
	printf '%s' "${s:-target}"
}

ipp_dbdir() {
	local d
	d=$(uci -c "$IPPING_UCI_DIR" -q get ipping.global.dbdir)
	printf '%s' "${d:-/tmp/ipping-data}"
}

ipp_recsize() {
	[ "$1" = m ] && echo 8 || echo 10
}

# UTC calendar math without strftime/date -d (portable awk arithmetic).
# ipp_utc_parts <epoch> -> "YYYY M D H" (raw numbers, no zero padding)
ipp_utc_parts() {
	awk -v e="$1" 'BEGIN {
		z = int(e / 86400)
		h = int((e - z * 86400) / 3600)
		z2 = z + 719468
		era = int(z2 / 146097)
		doe = z2 - era * 146097
		yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
		y = yoe + era * 400
		doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
		mp = int((5 * doy + 2) / 153)
		d = doy - int((153 * mp + 2) / 5) + 1
		m = mp + (mp < 10 ? 3 : -9)
		if (m <= 2) y++
		printf "%d %d %d %d\n", y, m, d, h
	}'
}

ipp_utc_ymd_of() { # epoch -> YYYYMMDD
	set -- $(ipp_utc_parts "$1")
	printf '%04d%02d%02d' "$1" "$2" "$3"
}

ipp_utc_ym_of() { # epoch -> YYYYMM
	set -- $(ipp_utc_parts "$1")
	printf '%04d%02d' "$1" "$2"
}

# "YYYYMMDD" -> UTC epoch of that day 00:00
ipp_ymd_to_epoch() {
	awk -v s="$1" '
	function days_from_civil(y, m, d,    yy, era, yoe, doy, doe) {
		yy = y - (m <= 2 ? 1 : 0)
		era = int(yy / 400)
		yoe = yy - era * 400
		doy = int((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
		doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
		return era * 146097 + doe - 719468
	}
	BEGIN {
		y = substr(s, 1, 4) + 0
		m = substr(s, 5, 2) + 0
		d = substr(s, 7, 2) + 0
		print days_from_civil(y, m, d) * 86400
	}'
}

# ipp_period_of <epoch> <m|h> -> YYYYMMDD or YYYYMM
ipp_period_of() {
	local mode="$2"
	case "$mode" in m)
		ipp_utc_ymd_of "$1" ;;
	h)
		ipp_utc_ym_of "$1" ;;
	*)
		return 1 ;;
	esac
}

# ipp_record_index <epoch> <m|h> -> record index within the period file
ipp_record_index() {
	local mode="$2" parts
	if [ "$mode" = m ]; then
		echo $(( ($1 % 86400) / 60 ))
	else
		# hour index within the month = (day_of_month - 1) * 24 + hour
		parts=$(ipp_utc_parts "$1")
		set -- $parts
		echo $(( ($3 - 1) * 24 + $4 ))
	fi
}

# ipp_file <m|h> <slug> <period> -> prints path
ipp_file() {
	local db
	db=$(ipp_dbdir)
	if [ "$1" = m ]; then
		printf '%s/%s_%s.m.bin' "$db" "$2" "$3"
	else
		printf '%s/%s_%s.h.bin' "$db" "$2" "$3"
	fi
}

# ipp_write_record <m|h> <slug> <epoch> <min> <avg> <max> <sent> <lost>
# Writes the record at the offset implied by the epoch (sparse holes allowed).
ipp_write_record() {
	local mode="$1" slug="$2" e="$3" mn="$4" av="$5" mx="$6" s="$7" l="$8"
	local period idx f rs
	period=$(ipp_period_of "$e" "$mode") || return 1
	idx=$(ipp_record_index "$e" "$mode")
	f=$(ipp_file "$mode" "$slug" "$period") || return 1
	rs=$(ipp_recsize "$mode")
	mkdir -p "$(dirname "$f")" 2>/dev/null || return 1
	[ -f "$f" ] || : > "$f" || return 1
	if [ "$mode" = m ]; then
		awk -v mn="$mn" -v av="$av" -v mx="$mx" -v s="$s" -v l="$l" 'BEGIN {
			printf "%c%c%c%c%c%c%c%c",
				mn%256, int(mn/256)%256,
				av%256, int(av/256)%256,
				mx%256, int(mx/256)%256,
				s%256, l%256
		}'
	else
		awk -v mn="$mn" -v av="$av" -v mx="$mx" -v s="$s" -v l="$l" 'BEGIN {
			printf "%c%c%c%c%c%c%c%c%c%c",
				mn%256, int(mn/256)%256,
				av%256, int(av/256)%256,
				mx%256, int(mx/256)%256,
				s%256, int(s/256)%256,
				l%256, int(l/256)%256
		}'
	fi | dd of="$f" bs=1 seek=$((idx * rs)) conv=notrunc 2>/dev/null
}

# ipp_bin2hex <file> <byte offset> <len> -> hex string on stdout, rc 1 if no decoder
ipp_bin2hex() {
	local f="$1" off="$2" len="$3" fsize avail h
	[ -r "$f" ] || return 1
	case "$off" in ''|*[!0-9]*) off=0 ;; esac
	case "$len" in ''|*[!0-9]*) len=0 ;; esac
	[ "$len" -gt 0 ] || { printf ''; return 0; }
	fsize=$(wc -c < "$f")
	[ "$off" -lt "$fsize" ] || { printf ''; return 0; }
	avail=$((fsize - off))
	[ "$len" -gt "$avail" ] && len=$avail
	if command -v hexdump >/dev/null 2>&1; then
		h=$(tail -c "+$((off + 1))" "$f" 2>/dev/null | head -c "$len" | hexdump -v -e '1/1 "%02x"' 2>/dev/null)
		case "$h" in
			*[!0-9a-f]*) : ;;
			'') : ;;
			*) [ "${#h}" -eq $((len * 2)) ] && { printf '%s' "$h"; return 0; } ;;
		esac
	fi
	if command -v od >/dev/null 2>&1; then
		h=$(tail -c "+$((off + 1))" "$f" 2>/dev/null | head -c "$len" | od -An -v -tx1 2>/dev/null | tr -d ' \n')
		case "$h" in
			*[!0-9a-f]*) : ;;
			'') : ;;
			*) [ "${#h}" -eq $((len * 2)) ] && { printf '%s' "$h"; return 0; } ;;
		esac
	fi
	if command -v xxd >/dev/null 2>&1; then
		h=$(tail -c "+$((off + 1))" "$f" 2>/dev/null | head -c "$len" | xxd -p 2>/dev/null | tr -d ' \n')
		case "$h" in
			*[!0-9a-f]*) : ;;
			'') : ;;
			*) [ "${#h}" -eq $((len * 2)) ] && { printf '%s' "$h"; return 0; } ;;
		esac
	fi
	return 1
}

# ipp_bin2b64 <file> <offset> <len> -> base64 on stdout, rc 1 if unavailable
ipp_bin2b64() {
	local f="$1" off="$2" len="$3" fsize avail h
	command -v base64 >/dev/null 2>&1 || return 1
	[ -r "$f" ] || return 1
	case "$off" in ''|*[!0-9]*) off=0 ;; esac
	case "$len" in ''|*[!0-9]*) len=0 ;; esac
	[ "$len" -gt 0 ] || { printf ''; return 0; }
	fsize=$(wc -c < "$f")
	[ "$off" -lt "$fsize" ] || { printf ''; return 0; }
	avail=$((fsize - off))
	[ "$len" -gt "$avail" ] && len=$avail
	h=$(tail -c "+$((off + 1))" "$f" 2>/dev/null | head -c "$len" | base64 2>/dev/null | tr -d '\n')
	[ -n "$h" ] && { printf '%s' "$h"; return 0; }
	return 1
}

# ipp_list_periods <m|h> <slug> -> sorted period list (one per line)
ipp_list_periods() {
	local mode="$1" slug="$2" db f p
	db=$(ipp_dbdir)
	for f in "$db/${slug}_"*.*.bin; do
		[ -f "$f" ] || continue
		f="${f##*/}"
		case "$f" in
			"${slug}_"*.m.bin) [ "$mode" = m ] || continue ;;
			"${slug}_"*.h.bin) [ "$mode" = h ] || continue ;;
			*) continue ;;
		esac
		p="${f#"${slug}_"}"
		case "$mode" in
			m) p="${p%.m.bin}" ;;
			h) p="${p%.h.bin}" ;;
		esac
		case "$p" in
			''|*[!0-9]*) continue ;;
		esac
		case "$mode" in
			m) case "$p" in ????????) echo "$p" ;; esac ;;
			h) case "$p" in ??????) echo "$p" ;; esac ;;
		esac
	done | LC_ALL=C sort
}

# ipp_cleanup <slug> <minute_retention_min> <hour_retention_h>
# Deletes whole period files that are entirely outside the retention window.
ipp_cleanup() {
	local slug="$1" rmin="$2" rhr="$3" db now cut p f
	db=$(ipp_dbdir)
	now=$(date +%s)
	cut=$(ipp_utc_ymd_of $((now - rmin * 60)))
	for f in "$db/${slug}_"????????.m.bin; do
		[ -f "$f" ] || continue
		p="${f##*/}"; p="${p#"${slug}_"}"; p="${p%.m.bin}"
		case "$p" in ''|*[!0-9]*) continue ;; esac
		[ "$p" -lt "$cut" ] && rm -f "$f"
	done
	cut=$(ipp_utc_ym_of $((now - rhr * 3600)))
	for f in "$db/${slug}_"??????.h.bin; do
		[ -f "$f" ] || continue
		p="${f##*/}"; p="${p#"${slug}_"}"; p="${p%.h.bin}"
		case "$p" in ''|*[!0-9]*) continue ;; esac
		[ "$p" -lt "$cut" ] && rm -f "$f"
	done
}

# ipp_aggregate_hour <slug> <hour epoch (UTC hour start)>
# Aggregates the 60 minute records of one closed hour into the monthly
# hourly file. rc 0 = handled (record written or nothing to do),
# rc 2 = no binary decoder available.
ipp_aggregate_hour() {
	local slug="$1" h="$2" period idx0 mf hex vals
	period=$(ipp_period_of "$h" m)
	idx0=$(ipp_record_index "$h" m)
	mf=$(ipp_file m "$slug" "$period")
	[ -f "$mf" ] || return 0
	hex=$(ipp_bin2hex "$mf" $((idx0 * 8)) 480) || return 2
	[ -n "$hex" ] || return 0
	vals=$(printf '%s' "$hex" | awk '
		function hv(x) { return index("0123456789abcdef", x) - 1 }
		function hb(x) { return hv(substr(x, 1, 1)) * 16 + hv(substr(x, 2, 1)) }
		{ hex = hex $0 }
		END {
			n = length(hex) / 2
			hmin = 0; hmax = 0; hsum = 0; hcnt = 0; sent = 0; lost = 0; any = 0
			for (r = 0; r * 8 < n; r++) {
				o = r * 16
				mn = hb(substr(hex, o + 1, 2))  + hb(substr(hex, o + 3, 2)) * 256
				av = hb(substr(hex, o + 5, 2))  + hb(substr(hex, o + 7, 2)) * 256
				mx = hb(substr(hex, o + 9, 2))  + hb(substr(hex, o + 11, 2)) * 256
				s  = hb(substr(hex, o + 13, 2))
				l  = hb(substr(hex, o + 15, 2))
				sent += s
				lost += l
				if (mn > 0) {
					if (!any || mn < hmin) hmin = mn
					if (mx > hmax) hmax = mx
					hsum += av * s
					hcnt += s
					any = 1
				}
			}
			if (!any) {
				hmin = 0; havg = 0; hmax = 0
			} else {
				havg = int(hsum / hcnt + 0.5)
			}
			if (sent > 65534) sent = 65534
			if (lost > 65534) lost = 65534
			printf "%d %d %d %d %d", hmin, havg, hmax, sent, lost
		}')
	[ -n "$vals" ] || return 1
	# all-zero hour (no samples at all) -> leave a hole instead of a record
	if [ "$vals" = "0 0 0 0 0" ]; then
		return 0
	fi
	ipp_write_record h "$slug" "$h" $vals
}

# ipp_aggregate_target <slug> <minute_retention_min> <hour_retention_h>
# Brings the hourly file up to date for every closed hour (catch-up aware).
# rc 2 = no binary decoder available.
ipp_aggregate_target() {
	local slug="$1" rmin="$2" rhr="$3"
	local db state lasth now cur_hour h p rc
	db=$(ipp_dbdir)
	mkdir -p "$db" 2>/dev/null
	state="$db/${slug}.state"
	now=$(date +%s)
	cur_hour=$((now - now % 3600))
	lasth=$(cat "$state" 2>/dev/null)
	case "$lasth" in ''|*[!0-9]*) lasth='' ;; esac
	if [ -n "$lasth" ] && { [ "$lasth" -lt 1000000000 ] || [ "$lasth" -gt $((cur_hour + 86400)) ]; }; then
		lasth=''
	fi
	if [ -z "$lasth" ]; then
		# seed the cursor from the oldest existing minute file
		p=$(ipp_list_periods m "$slug" | head -n 1)
		if [ -z "$p" ]; then
			return 0
		fi
		lasth=$(ipp_ymd_to_epoch "$p")
		[ "$lasth" -lt $((cur_hour - 960 * 3600)) ] && lasth=$((cur_hour - 960 * 3600))
		lasth=$((lasth - lasth % 3600))
		# step back one hour so the seed hour itself gets aggregated
		lasth=$((lasth - 3600))
	fi
	rc=0
	h=$lasth
	# only fully closed hours: hour start h is closed when h + 3600 <= now,
	# i.e. h <= cur_hour - 3600
	while [ $((h + 3600)) -lt "$cur_hour" ]; do
		h=$((h + 3600))
		ipp_aggregate_hour "$slug" "$h"
		rc=$?
		[ "$rc" != 0 ] && return "$rc"
		printf '%s\n' "$h" > "${state}.tmp" && mv "${state}.tmp" "$state"
	done
	ipp_cleanup "$slug" "$rmin" "$rhr"
	return 0
}
