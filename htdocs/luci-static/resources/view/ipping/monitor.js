/* luci-app-ipping - IP Ping Monitor view
 *
 * Reads the binary data files written by ippingd through the ipping-cat
 * helper (rpcd file exec), decodes them in the browser and renders plain
 * SVG/DOM views - no third party chart library involved.
 *
 * Views: latency graph (minute/hourly), month calendar, 90-day status bars.
 *
 * Binary record layout (little-endian):
 *   minute record (8 bytes, record i = minute i of the UTC day):
 *     u16 rtt_min | u16 rtt_avg | u16 rtt_max | u8 sent | u8 lost
 *   hourly record (10 bytes, record i = hour i of the UTC month):
 *     u16 rtt_min | u16 rtt_avg | u16 rtt_max | u16 sent | u16 lost
 *   rtt values are 0.1 ms units, 0 means "no data".
 */
'use strict';
'require view';
'require dom';
'require poll';
'require uci';
'require ui';
'require fs';

var CAT = '/usr/libexec/ipping/ipping-cat';
var INIT = '/etc/init.d/ipping';
var RTT_SCALE = 10;          /* stored in 0.1 ms units */
var REC_SIZE = { m: 8, h: 10 };
var REC_RECS = { m: 1440, h: 744 };
var REC_STEP = { m: 60, h: 3600 };
var MAX_POINTS = 1000;

/* day/hour grading thresholds (packet loss fractions) */
var LOSS_WARN = 0.02;
var LOSS_BAD = 0.20;

var GRADE_COLOR = { ok: '#22c55e', warn: '#f59e0b', bad: '#ef4444', none: '#9ca3af' };

var RANGES = [
	{ mode: 'm', seconds: 3600,     label: _('1 hour') },
	{ mode: 'm', seconds: 21600,    label: _('6 hours') },
	{ mode: 'm', seconds: 86400,    label: _('24 hours') },
	{ mode: 'm', seconds: 259200,   label: _('3 days') },
	{ mode: 'm', seconds: 604800,   label: _('7 days') },
	{ mode: 'h', seconds: 2592000,  label: _('30 days') },
	{ mode: 'h', seconds: 7776000,  label: _('90 days') },
	{ mode: 'h', seconds: 15552000, label: _('180 days') },
	{ mode: 'h', seconds: 31536000, label: _('1 year') }
];

var MODES = [
	{ id: 'graph',    label: _('Graph') },
	{ id: 'calendar', label: _('Calendar') },
	{ id: 'days',     label: _('90 days') }
];

var CSS = '\
.ipping-status { display: inline-flex; align-items: center; gap: .4em; margin-right: 1em; } \
.ipping-dot { display: inline-block; width: .8em; height: .8em; border-radius: 50%; } \
.ipping-ok { background: #16a34a; } \
.ipping-bad { background: #dc2626; } \
.ipping-statusline { margin: .2em 0 .5em; } \
.ipping-modebar, .ipping-tabs, .ipping-ranges, .ipping-nav, .ipping-stats, .ipping-legend, .ipping-summary { display: flex; flex-wrap: wrap; gap: .35em; margin: .4em 0; align-items: center; } \
.ipping-active { font-weight: bold; box-shadow: inset 0 0 0 2px #2563eb; } \
.ipping-chart { position: relative; width: 100%; min-height: 120px; } \
.ipping-guide { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(37,99,235,.45); display: none; pointer-events: none; } \
.ipping-tip { position: absolute; top: 4px; background: rgba(17,24,39,.94); color: #f9fafb; font-size: 12px; line-height: 1.55; padding: 6px 10px; border-radius: 6px; display: none; pointer-events: none; white-space: nowrap; z-index: 5; box-shadow: 0 4px 14px rgba(0,0,0,.35); } \
.ipping-tip b { color: #fff; } \
.ipping-muted { color: #6b7280; } \
.ipping-stats span, .ipping-summary span { margin-right: 1.2em; } \
.ipping-stats b, .ipping-summary b { font-weight: 700; } \
.ipping-legend { font-size: 12px; color: #6b7280; } \
.ipping-chip { display: inline-flex; align-items: center; gap: .4em; margin-right: 1.1em; } \
.ipping-chip i { width: .85em; height: .85em; border-radius: 2px; display: inline-block; } \
.ipping-legend span::before { content: "\\25A0\\00a0"; } \
.ipping-lg-band::before { color: rgba(37,99,235,.35); } \
.ipping-lg-avg::before { color: #2563eb; } \
.ipping-lg-loss::before { color: rgba(239,68,68,.75); } \
.ipping-navlabel { font-weight: 600; min-width: 11em; text-align: center; } \
.ipping-cal { display: grid; grid-template-columns: repeat(7, minmax(88px, 1fr)); gap: 6px; max-width: 820px; } \
.ipping-calhead { font-size: 11px; color: #6b7280; text-align: center; padding: 2px 0; text-transform: uppercase; letter-spacing: .06em; } \
.ipping-calcell { border-radius: 9px; min-height: 62px; padding: 5px 8px; display: flex; flex-direction: column; justify-content: space-between; color: #fff; cursor: default; transition: transform .08s ease, box-shadow .08s ease; } \
.ipping-calcell:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,.35); z-index: 2; position: relative; } \
.ipping-calcell .d { font-weight: 600; font-size: 13px; } \
.ipping-calcell .m { font-size: 11px; opacity: .9; } \
.ipping-calcell.blank { background: transparent; min-height: 0; pointer-events: none; } \
.ipping-g-ok { background: linear-gradient(160deg, #22c55e, #15803d); } \
.ipping-g-warn { background: linear-gradient(160deg, #f59e0b, #b45309); } \
.ipping-g-bad { background: linear-gradient(160deg, #ef4444, #991b1b); } \
.ipping-g-none { background: rgba(148,163,184,.16); color: #6b7280; } \
.ipping-g-none .d { opacity: .55; } \
.ipping-today { box-shadow: inset 0 0 0 2px #3b82f6; } \
.ipping-daysum { font-size: 12px; } \
';

function slugify(s) {
	s = String(s || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
	return s || 'target';
}

function periodStart(p) {
	return Date.UTC(+p.substring(0, 4), +p.substring(4, 6) - 1, p.length >= 8 ? +p.substring(6, 8) : 1) / 1000;
}

function periodLength(p) {
	if (p.length >= 8)
		return 86400;
	var y = +p.substring(0, 4), m = +p.substring(4, 6);
	return (Date.UTC(y, m, 1) - Date.UTC(y, m - 1, 1)) / 1000;
}

function hexToBytes(s) {
	s = s.replace(/[^0-9a-fA-F]/g, '');
	var out = new Uint8Array(s.length >> 1);
	for (var i = 0; i < out.length; i++)
		out[i] = parseInt(s.substr(i * 2, 2), 16);
	return out;
}

function b64ToBytes(s) {
	var bin = atob(s.replace(/\s+/g, '')), out = new Uint8Array(bin.length);
	for (var i = 0; i < bin.length; i++)
		out[i] = bin.charCodeAt(i);
	return out;
}

/* decode one period file into records */
function parseRecords(bytes, mode, start) {
	var rs = REC_SIZE[mode], n = Math.floor(bytes.length / rs), recs = [];
	for (var i = 0; i < n; i++) {
		var o = i * rs;
		function rtt(off) {
			var v = bytes[o + off] | (bytes[o + off + 1] << 8);
			return v > 0 ? v / RTT_SCALE : null;
		}
		var mn = rtt(0), av = rtt(2), mx = rtt(4), sent, lost;
		if (mode == 'm') {
			sent = bytes[o + 6];
			lost = bytes[o + 7];
		} else {
			sent = bytes[o + 6] | (bytes[o + 7] << 8);
			lost = bytes[o + 8] | (bytes[o + 9] << 8);
		}
		if (mn === null && sent === 0 && lost === 0)
			continue;
		recs.push({ t: start + i * REC_STEP[mode], min: mn, avg: av, max: mx, sent: sent, lost: lost });
	}
	return recs;
}

function fetchPeriods(slug, mode, since) {
	return fs.exec(CAT, ['files', slug, mode]).then(function(res) {
		var m = /^FILES(.*)$/m.exec(res.stdout || '');
		return (m ? m[1] : '').trim().split(/\s+/).filter(function(p) {
			return /^\d+$/.test(p) && p.length == (mode == 'm' ? 8 : 6);
		}).filter(function(p) {
			return periodStart(p) + periodLength(p) > since;
		}).sort();
	});
}

function fetchPeriodRecords(slug, mode, period) {
	return fs.exec(CAT, ['read', slug, mode, period, 0, REC_RECS[mode]]).then(function(res) {
		var lines = (res.stdout || '').split('\n');
		var tag = lines.shift();
		if (tag == 'HEX')
			return hexToBytes(lines.join(''));
		if (tag == 'B64')
			return b64ToBytes(lines.join(''));
		throw new Error((lines.join(' ').trim() || _('data reader failed')));
	});
}

/* load all records of one target within the given time window */
function fetchRecords(slug, mode, since) {
	return fetchPeriods(slug, mode, since).then(function(periods) {
		var recs = [], i = 0;
		function next() {
			if (i >= periods.length)
				return recs;
			return fetchPeriodRecords(slug, mode, periods[i++]).then(function(bytes) {
				recs = recs.concat(parseRecords(bytes, mode, periodStart(periods[i - 1])));
				return next();
			});
		}
		return next();
	});
}

function fmtRtt(v) {
	return (v === null || isNaN(v)) ? '-' : (v >= 100 ? v.toFixed(0) : v.toFixed(1));
}

function fmtTime(t, withDate) {
	var opt = withDate ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
	                  : { hour: '2-digit', minute: '2-digit' };
	return new Date(t * 1000).toLocaleString(undefined, opt);
}

function fmtFullTime(t) {
	return new Date(t * 1000).toLocaleString();
}

function fmtDay(d) {
	return new Date(d.y, d.m - 1, d.d).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

function niceCeil(x) {
	if (!(x > 0))
		return 100;
	var steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 65534];
	for (var i = 0; i < steps.length; i++)
		if (x <= steps[i])
			return steps[i];
	return 65534;
}

function gradeOf(loss) {
	return loss >= LOSS_BAD ? 'bad' : (loss >= LOSS_WARN ? 'warn' : 'ok');
}

function gradeLabel(g) {
	return g == 'bad' ? _('Outage') : (g == 'warn' ? _('Degraded') : (g == 'ok' ? _('Operational') : _('No data')));
}

/* aggregate hourly records into per-day buckets (local calendar days) */
function aggregateDays(recs, fromEpoch, toEpoch) {
	var map = {}, out = [];
	recs.forEach(function(r) {
		if (r.t < fromEpoch || r.t >= toEpoch)
			return;
		var d = new Date(r.t * 1000);
		var y = d.getFullYear(), m = d.getMonth() + 1, dd = d.getDate();
		var key = y * 10000 + m * 100 + dd;
		var day = map[key];
		if (!day) {
			day = map[key] = { y: y, m: m, d: dd, tStart: new Date(y, m - 1, dd).getTime() / 1000,
				sent: 0, lost: 0, okSent: 0, warnSent: 0, badSent: 0, hours: 0,
				min: null, max: null, sumW: 0, cntW: 0 };
			out.push(day);
		}
		if (!r.sent)
			return;
		day.sent += r.sent;
		day.lost += r.lost;
		day.hours++;
		var g = gradeOf(r.lost / r.sent);
		day[g + 'Sent'] += r.sent;
		if (r.avg !== null) {
			if (day.min === null || r.min < day.min) day.min = r.min;
			if (day.max === null || r.max > day.max) day.max = r.max;
			day.sumW += r.avg * r.sent;
			day.cntW += r.sent;
		}
	});
	out.sort(function(a, b) { return a.tStart - b.tStart; });
	return out;
}

function gradeDay(day) {
	return (!day || !day.sent) ? 'none' : gradeOf(day.lost / day.sent);
}

/* downsample records into at most maxPts buckets */
function downsample(recs, maxPts, mode) {
	if (recs.length <= maxPts)
		return { pts: recs, step: recs.length > 1 ? recs[1].t - recs[0].t : REC_STEP[mode] };
	var bucket = Math.ceil(recs.length / maxPts), out = [],
	    rawStep = recs.length > 1 ? recs[1].t - recs[0].t : REC_STEP[mode];
	for (var i = 0; i < recs.length; i += bucket) {
		var chunk = recs.slice(i, i + bucket), mn = null, mx = null, sum = 0, n = 0, sent = 0, lost = 0;
		for (var j = 0; j < chunk.length; j++) {
			var r = chunk[j];
			if (r.avg !== null) {
				if (mn === null || r.min < mn) mn = r.min;
				if (mx === null || r.max > mx) mx = r.max;
				sum += r.avg; n++;
			}
			sent += r.sent; lost += r.lost;
		}
		out.push({ t: chunk[0].t, min: mn, avg: n ? sum / n : null, max: mx, sent: sent, lost: lost });
	}
	return { pts: out, step: bucket * rawStep };
}

/* build the SVG for the RTT band + avg line and the loss strip */
function renderChart(host, pts, step, t0, t1) {
	var W = 1000, H = 310, padL = 58, padR = 14, padT = 12, padH = 200;
	var lossY = padT + padH + 30, lossH = H - lossY - 26;
	var iw = W - padL - padR, i;
	var px = function(v) { return (+v).toFixed(2); };

	var yMax = 0;
	for (i = 0; i < pts.length; i++)
		if (pts[i].max !== null && pts[i].max > yMax)
			yMax = pts[i].max;
	yMax = niceCeil(yMax * 1.15);

	var x = function(t) { return padL + (t - t0) / Math.max(1, t1 - t0) * iw; };
	var y = function(v) { return padT + padH - v / yMax * padH; };
	var yl = function(p) { return lossY + p / 100 * lossH; };
	var s = [];

	s.push('<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block">');

	for (i = 0; i <= 4; i++) {
		var vy = yMax * i / 4, yy = y(vy);
		s.push('<line x1="' + padL + '" y1="' + px(yy) + '" x2="' + (W - padR) + '" y2="' + px(yy) + '" stroke="#e5e7eb"/>');
		s.push('<text x="' + (padL - 6) + '" y="' + px(yy + 4) + '" font-size="11" fill="#6b7280" text-anchor="end">' + fmtRtt(vy) + ' ms</text>');
	}

	var ticks = 6;
	for (i = 0; i <= ticks; i++) {
		var tx = t0 + (t1 - t0) * i / ticks, xx = x(tx);
		s.push('<text x="' + px(xx) + '" y="' + (padT + padH + 16) + '" font-size="11" fill="#6b7280" text-anchor="' +
			(i == 0 ? 'start' : (i == ticks ? 'end' : 'middle')) + '">' + fmtTime(tx, t1 - t0 > 172800) + '</text>');
	}

	s.push('<line x1="' + padL + '" y1="' + px(yl(0)) + '" x2="' + (W - padR) + '" y2="' + px(yl(0)) + '" stroke="#e5e7eb"/>');
	s.push('<line x1="' + padL + '" y1="' + px(yl(50)) + '" x2="' + (W - padR) + '" y2="' + px(yl(50)) + '" stroke="#f3f4f6"/>');
	s.push('<line x1="' + padL + '" y1="' + px(yl(100)) + '" x2="' + (W - padR) + '" y2="' + px(yl(100)) + '" stroke="#e5e7eb"/>');
	s.push('<text x="' + (padL - 6) + '" y="' + px(yl(0) + 4) + '" font-size="11" fill="#9ca3af" text-anchor="end">0%</text>');
	s.push('<text x="' + (padL - 6) + '" y="' + px(yl(100) + 4) + '" font-size="11" fill="#9ca3af" text-anchor="end">100%</text>');

	/* split into segments on gaps */
	var maxGap = (step || REC_STEP.m) * 3, segs = [], cur = [];
	for (i = 0; i < pts.length; i++) {
		if (cur.length && pts[i].t - cur[cur.length - 1].t > maxGap) {
			segs.push(cur);
			cur = [];
		}
		cur.push(pts[i]);
	}
	if (cur.length)
		segs.push(cur);

	/* min-max band */
	var band = '';
	for (i = 0; i < segs.length; i++) {
		var up = [], dn = [];
		for (var j = 0; j < segs[i].length; j++) {
			var p = segs[i][j];
			up.push(px(x(p.t)) + ',' + px(y(p.max !== null ? p.max : 0)));
			dn.push(px(x(p.t)) + ',' + px(y(p.min !== null ? p.min : 0)));
		}
		if (up.length > 1)
			band += '<polygon points="' + up.join(' ') + ' ' + dn.reverse().join(' ') + '" fill="rgba(37,99,235,0.15)"/>';
	}
	s.push(band);

	/* average line */
	var line = '';
	for (i = 0; i < segs.length; i++) {
		var d = '', opened = false;
		for (var j2 = 0; j2 < segs[i].length; j2++) {
			var p2 = segs[i][j2];
			if (p2.avg === null) {
				opened = false;
				continue;
			}
			d += (opened ? 'L' : 'M') + px(x(p2.t)) + ' ' + px(y(p2.avg));
			opened = true;
		}
		line += '<path d="' + d + '" fill="none" stroke="#2563eb" stroke-width="1.6" stroke-linejoin="round"/>';
	}
	s.push(line);

	/* loss bars */
	var bw = Math.max(1, iw / Math.max(pts.length, 1) * 0.8), loss = '';
	for (i = 0; i < segs.length; i++) {
		for (var j3 = 0; j3 < segs[i].length; j3++) {
			var p3 = segs[i][j3];
			if (!p3.sent)
				continue;
			var lp = Math.min(100, p3.lost / p3.sent * 100);
			if (lp <= 0)
				continue;
			loss += '<rect x="' + px(x(p3.t) - bw / 2) + '" y="' + px(yl(lp)) + '" width="' + px(bw) +
				'" height="' + px(yl(0) - yl(lp)) + '" fill="rgba(239,68,68,0.75)"/>';
		}
	}
	s.push(loss);
	s.push('<line x1="' + padL + '" y1="' + (padT + padH) + '" x2="' + (W - padR) + '" y2="' + (padT + padH) + '" stroke="#9ca3af"/>');
	s.push('</svg>');

	host.innerHTML = s.join('');
}

/* month calendar: one colored cell per day */
function renderCalendar(host, days, y, m, today) {
	var byDate = {};
	days.forEach(function(d) { byDate[d.d] = d; });

	var daysInMonth = new Date(y, m, 0).getDate();
	var lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;   /* Monday = 0 */
	var weekdays = [];
	for (var w = 0; w < 7; w++)
		weekdays.push(new Date(2021, 7, 2 + w).toLocaleDateString(undefined, { weekday: 'short' }));

	var s = '<div class="ipping-cal">';
	weekdays.forEach(function(wd) { s += '<div class="ipping-calhead">' + wd + '</div>'; });
	for (var b = 0; b < lead; b++)
		s += '<div class="ipping-calcell blank"></div>';

	var cells = [];
	for (var dd = 1; dd <= daysInMonth; dd++) {
		var day = byDate[dd];
		var g = gradeDay(day);
		var isToday = (today.getFullYear() == y && today.getMonth() + 1 == m && today.getDate() == dd);
		var meta = '';
		if (day && day.sent)
			meta = (g == 'ok') ? fmtRtt(day.cntW ? day.sumW / day.cntW : null) + ' ms'
			                    : (day.sent ? (day.lost / day.sent * 100).toFixed(0) + '%' : '');
		s += '<div class="ipping-calcell ipping-g-' + g + (isToday ? ' ipping-today' : '') + '" data-didx="' + cells.length + '">' +
		     '<span class="d">' + dd + '</span><span class="m">' + meta + '</span></div>';
		cells.push(day || null);
	}
	s += '</div>';

	host.innerHTML = s;
	return cells;
}

/* 90 vertical status bars, one per day */
function renderDayBars(host, days) {
	var W = 1000, H = 132, padX = 10;
	var areaTop = 8, areaH = 88, labelY = H - 8;
	var now = new Date();
	var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
	var start = todayStart - 89 * 86400;

	var byStart = {};
	days.forEach(function(d) { byStart[d.tStart] = d; });

	var N = 90, slot = (W - 2 * padX) / N, bw = Math.max(2.5, slot * 0.68);
	var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" class="ipping-daysvg">';

	var totalSent = 0, totalLost = 0, recorded = 0, worst = null, counts = { ok: 0, warn: 0, bad: 0, none: 0 };
	var cellList = [];

	for (var i = 0; i < N; i++) {
		var tStart = start + i * 86400;
		var day = byStart[tStart] || null;
		var g = gradeDay(day);
		counts[g]++;
		if (day && day.sent) {
			recorded++;
			totalSent += day.sent;
			totalLost += day.lost;
			if (!worst || (day.lost / day.sent) > (worst.lost / worst.sent))
				worst = day;
		}
		var x = padX + i * slot + (slot - bw) / 2;
		var body = '';
		if (day && day.sent) {
			var okF = day.okSent / day.sent, wnF = day.warnSent / day.sent, bdF = day.badSent / day.sent;
			var yOk = areaTop + (1 - okF) * areaH;
			var yWn = areaTop + (1 - okF - wnF) * areaH;
			if (okF > 0)
				body += '<rect x="' + x.toFixed(2) + '" y="' + yOk.toFixed(2) + '" width="' + bw.toFixed(2) + '" height="' + (okF * areaH).toFixed(2) + '" rx="1.2" fill="' + GRADE_COLOR.ok + '"/>';
			if (wnF > 0)
				body += '<rect x="' + x.toFixed(2) + '" y="' + yWn.toFixed(2) + '" width="' + bw.toFixed(2) + '" height="' + (wnF * areaH).toFixed(2) + '" rx="1.2" fill="' + GRADE_COLOR.warn + '"/>';
			if (bdF > 0)
				body += '<rect x="' + x.toFixed(2) + '" y="' + areaTop + '" width="' + bw.toFixed(2) + '" height="' + (bdF * areaH).toFixed(2) + '" rx="1.2" fill="' + GRADE_COLOR.bad + '"/>';
		} else {
			body += '<rect x="' + x.toFixed(2) + '" y="' + areaTop + '" width="' + bw.toFixed(2) + '" height="' + areaH + '" rx="1.2" fill="rgba(148,163,184,.28)"/>';
		}
		var isToday = (i == N - 1);
		s += '<g class="ipping-daybar" data-didx="' + i + '">' + body +
		     (isToday ? '<rect x="' + (x - 1).toFixed(2) + '" y="' + (areaTop - 1) + '" width="' + (bw + 2).toFixed(2) + '" height="' + (areaH + 2) + '" rx="2" fill="none" stroke="#3b82f6" stroke-width="1.2"/>' : '') +
		     '</g>';
		cellList.push(day);

		if (i % 15 == 0 || i == N - 1) {
			var dl = new Date(tStart * 1000);
			s += '<text x="' + x.toFixed(2) + '" y="' + labelY + '" font-size="11" fill="#6b7280" text-anchor="' +
			     (i == 0 ? 'start' : (i == N - 1 ? 'end' : 'middle')) + '">' +
			     (dl.getMonth() + 1) + '/' + dl.getDate() + '</text>';
		}
	}
	s += '<line x1="' + padX + '" y1="' + (areaTop + areaH + 4) + '" x2="' + (W - padX) + '" y2="' + (areaTop + areaH + 4) + '" stroke="#d1d5db"/>';
	s += '</svg>';

	host.innerHTML = s;
	return { cells: cellList, totalSent: totalSent, totalLost: totalLost, recorded: recorded, counts: counts, worst: worst };
}

function dayTooltip(day) {
	var g = gradeDay(day);
	var h = '<b>' + (day ? fmtDay(day) : '') + '</b><br>' + gradeLabel(g);
	if (day && day.sent) {
		var loss = day.lost / day.sent;
		h += '<br>' + _('Uptime') + ': <b>' + ((1 - loss) * 100).toFixed(2) + '%</b>';
		h += '<br>' + _('Loss') + ': ' + (loss * 100).toFixed(2) + '%';
		if (day.cntW)
			h += '<br>' + _('Average') + ': ' + fmtRtt(day.sumW / day.cntW) + ' ms';
		if (day.min !== null)
			h += '<br>' + _('Min') + ': ' + fmtRtt(day.min) + ' ms / ' + _('Max') + ': ' + fmtRtt(day.max) + ' ms';
		h += '<br>' + _('Recorded hours') + ': ' + day.hours + '/24';
		h += '<br>' + _('Pings') + ': ' + day.sent.toLocaleString() + ' / ' + _('lost') + ' ' + day.lost.toLocaleString();
	}
	return h;
}

return view.extend({
	load: function() {
		return uci.load('ipping').then(function() {
			if (!uci.get('ipping', 'global'))
				uci.add('ipping', 'ipping', 'global');
		});
	},

	updateServiceStatus: function() {
		var self = this;
		return fs.exec(INIT, ['status']).then(function(res) {
			if (!self.statusDot)
				return;
			var running = (res.code == 0 && /running/.test(res.stdout || ''));
			var enabled = uci.get('ipping', 'global', 'enabled') != '0';
			var msg = running
				? (enabled ? _('Collector running') : _('Service running, collection disabled'))
				: _('Service stopped');
			dom.content(self.statusDot, [
				E('span', { 'class': 'ipping-dot ' + (running && enabled ? 'ipping-ok' : 'ipping-bad') }),
				E('span', {}, [ msg ])
			]);
		}).catch(function() {
			if (self.statusDot)
				dom.content(self.statusDot, [ E('span', { 'class': 'ipping-muted' }, [ _('Status unknown') ]) ]);
		});
	},

	refresh: function() {
		var self = this;
		this.updateServiceStatus();

		var targets = uci.sections('ipping', 'target').filter(function(s) {
			return s.host && s.enabled != '0';
		});
		this.rebuildTabs(targets);

		if (!targets.length) {
			this.svgHost.innerHTML = '';
			this.statsBox.innerHTML = '';
			dom.content(this.hintBox, E('p', { 'class': 'alert-message' },
				[ _('No ping targets configured. Add targets in the settings below.') ]));
			return;
		}
		dom.content(this.hintBox, '');

		var now = Math.floor(Date.now() / 1000);
		var p;
		if (this.mode == 'graph') {
			var range = RANGES[this.rangeIdx];
			p = fetchRecords(this.selSlug, range.mode, now - range.seconds).then(function(recs) {
				self.drawGraph(recs, range);
			});
		} else if (this.mode == 'calendar') {
			var monthStart = new Date(this.calY, this.calM - 1, 1).getTime() / 1000;
			p = fetchPeriods(this.selSlug, 'h', 0).then(function(periods) {
				self.updateMonthNav(periods);
				return fetchRecords(self.selSlug, 'h', monthStart - 3600);
			}).then(function(recs) {
				self.drawCalendar(recs);
			});
		} else {
			p = fetchRecords(this.selSlug, 'h', now - 92 * 86400).then(function(recs) {
				self.drawDayBars(recs);
			});
		}
		return p.then(function() {
			self.errShown = false;
		}).catch(function(e) {
			if (!self.errShown) {
				self.errShown = true;
				ui.addNotification(null, E('p', {}, _('Failed to read monitoring data: %s').format(e.message)), 'error');
			}
		});
	},

	drawGraph: function(recs, range) {
		var self = this;
		var now = Math.floor(Date.now() / 1000);
		var t0 = now - range.seconds, t1 = now;
		var ds = downsample(recs, MAX_POINTS, range.mode);

		if (!ds.pts.length) {
			this.svgHost.innerHTML = '';
			this.statsBox.innerHTML = '';
			dom.content(this.statsBox, E('p', { 'class': 'ipping-muted' }, [ _('No data in this time range yet.') ]));
			this.plot = null;
			return;
		}

		renderChart(this.svgHost, ds.pts, ds.step, t0, t1);
		this.plot = { pts: ds.pts, step: ds.step, t0: t0, t1: t1 };

		var last = null, sum = 0, n = 0, mx = 0, sent = 0, lost = 0;
		recs.forEach(function(r) {
			if (r.avg !== null) {
				last = r;
				sum += r.avg; n++;
				if (r.max !== null && r.max > mx) mx = r.max;
			}
			sent += r.sent; lost += r.lost;
		});
		var loss = sent ? (lost / sent * 100) : null;
		dom.content(this.statsBox, E('div', { 'class': 'ipping-stats' }, [
			E('span', {}, [ _('Latest'), ': ', E('b', {}, last ? [ fmtRtt(last.avg), ' ms' ] : [ '-' ]) ]),
			E('span', {}, [ _('Average'), ': ', E('b', {}, n ? [ fmtRtt(sum / n), ' ms' ] : [ '-' ]) ]),
			E('span', {}, [ _('Max'), ': ', E('b', {}, mx ? [ fmtRtt(mx), ' ms' ] : [ '-' ]) ]),
			E('span', {}, [ _('Loss'), ': ', E('b', {}, [ loss === null ? '-' : loss.toFixed(2) + '%' ]) ]),
			E('span', {}, [ _('Samples'), ': ', E('b', {}, [ String(recs.length) ]) ])
		]));
		dom.content(this.legendBox, E('div', { 'class': 'ipping-legend' }, [
			E('span', { 'class': 'ipping-lg-band' }, [ _('min/max range') ]),
			E('span', { 'class': 'ipping-lg-avg' }, [ _('average RTT') ]),
			E('span', { 'class': 'ipping-lg-loss' }, [ _('packet loss') ])
		]));
	},

	drawCalendar: function(recs) {
		var today = new Date();
		var days = aggregateDays(recs,
			new Date(this.calY, this.calM - 1, 1).getTime() / 1000,
			new Date(this.calY, this.calM, 1).getTime() / 1000);
		this.plot = null;
		this.guide.style.display = this.tip.style.display = 'none';
		this.dayList = renderCalendar(this.svgHost, days, this.calY, this.calM, today);

		var withData = days.filter(function(d) { return d.sent; });
		var degraded = withData.filter(function(d) { return gradeDay(d) == 'warn'; }).length;
		var outages = withData.filter(function(d) { return gradeDay(d) == 'bad'; }).length;
		var sent = 0, lost = 0;
		withData.forEach(function(d) { sent += d.sent; lost += d.lost; });
		var uptime = sent ? ((1 - lost / sent) * 100).toFixed(2) + '%' : '-';
		dom.content(this.statsBox, E('div', { 'class': 'ipping-summary' }, [
			E('span', {}, [ _('Month uptime'), ': ', E('b', {}, [ uptime ]) ]),
			E('span', {}, [ _('Days with data'), ': ', E('b', {}, [ String(withData.length) ]) ]),
			E('span', {}, [ _('Degraded'), ': ', E('b', {}, [ String(degraded) ]) ]),
			E('span', {}, [ _('Outage days'), ': ', E('b', {}, [ String(outages) ]) ])
		]));
		this.renderGradeLegend();
	},

	drawDayBars: function(recs) {
		var sum = renderDayBars(this.svgHost, aggregateDays(recs, 0, Date.now() / 1000 + 86400));
		this.plot = null;
		this.guide.style.display = this.tip.style.display = 'none';
		this.dayList = sum.cells;

		var uptime = sum.totalSent ? ((1 - sum.totalLost / sum.totalSent) * 100).toFixed(2) + '%' : '-';
		var worstTxt = '-';
		if (sum.worst && sum.worst.sent) {
			var wl = sum.worst.lost / sum.worst.sent;
			if (wl >= LOSS_WARN)
				worstTxt = new Date(sum.worst.y, sum.worst.m - 1, sum.worst.d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
					' (' + (wl * 100).toFixed(1) + '% ' + _('loss') + ')';
		}
		dom.content(this.statsBox, E('div', { 'class': 'ipping-summary' }, [
			E('span', {}, [ _('90-day uptime'), ': ', E('b', {}, [ uptime ]) ]),
			E('span', {}, [ _('Days with data'), ': ', E('b', {}, [ sum.recorded + '/90' ]) ]),
			E('span', {}, [ _('Worst day'), ': ', E('b', {}, [ worstTxt ]) ])
		]));
		this.renderGradeLegend(sum.counts);
	},

	renderGradeLegend: function(counts) {
		counts = counts || {};
		var self = this;
		var grades = ['ok', 'warn', 'bad', 'none'];
		dom.content(this.legendBox, E('div', { 'class': 'ipping-legend' }, grades.map(function(g) {
			return E('span', { 'class': 'ipping-chip' }, [
				E('i', { 'style': 'background:' + GRADE_COLOR[g] }),
				gradeLabel(g) + (counts[g] !== undefined ? ' \u00d7 ' + counts[g] : '')
			]);
		})));
	},

	updateMonthNav: function(periods) {
		var self = this;
		var min = null;
		periods.forEach(function(p) {
			var v = +p.substring(0, 4) * 12 + (+p.substring(4, 6) - 1);
			if (min === null || v < min)
				min = v;
		});
		var cur = new Date();
		var curV = cur.getFullYear() * 12 + cur.getMonth();
		var thisV = this.calY * 12 + (this.calM - 1);
		var label = new Date(this.calY, this.calM - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
		var prevDisabled = (min === null || thisV <= min);
		var nextDisabled = (thisV >= curV);
		dom.content(this.navBar, [
			E('button', Object.assign({ 'class': 'cbi-button' },
				prevDisabled ? { 'disabled': 'disabled' } : {},
				{ 'click': function() { self.shiftMonth(-1); } }), [ '\u2039' ]),
			E('span', { 'class': 'ipping-navlabel' }, [ label ]),
			E('button', Object.assign({ 'class': 'cbi-button' },
				nextDisabled ? { 'disabled': 'disabled' } : {},
				{ 'click': function() { self.shiftMonth(1); } }), [ '\u203a' ])
		]);
	},

	shiftMonth: function(delta) {
		var v = this.calY * 12 + (this.calM - 1) + delta;
		this.calY = Math.floor(v / 12);
		this.calM = v - this.calY * 12 + 1;
		this.refresh();
	},

	rebuildTabs: function(targets) {
		var self = this;
		var key = targets.map(function(t) { return t['.name']; }).join(',');
		if (key === this.tabKey)
			return;
		this.tabKey = key;
		dom.content(this.tabBar, '');

		if (!targets.length) {
			this.selSlug = null;
			return;
		}

		var slugs = targets.map(function(t) { return slugify(t.name || t.host); });
		if (slugs.indexOf(this.selSlug) < 0)
			this.selSlug = slugs[0];

		targets.forEach(function(t, i) {
			var slug = slugs[i], label = t.name || t.host;
			self.tabBar.appendChild(E('button', {
				'class': 'cbi-button ipping-tab',
				'data-slug': slug,
				'click': function() {
					self.selSlug = slug;
					self.updateTabs();
					self.refresh();
				}
			}, [ label ]));
		});
		this.updateTabs();
	},

	updateTabs: function() {
		var self = this;
		this.tabBar.querySelectorAll('.ipping-tab').forEach(function(b) {
			b.classList.toggle('ipping-active', b.getAttribute('data-slug') == self.selSlug);
		});
	},

	updateRanges: function() {
		var self = this;
		this.rangeBar.querySelectorAll('.ipping-range').forEach(function(b) {
			b.classList.toggle('ipping-active', +b.getAttribute('data-idx') == self.rangeIdx);
		});
	},

	updateModeChrome: function() {
		var self = this;
		this.modeBar.querySelectorAll('.ipping-modebtn').forEach(function(b) {
			b.classList.toggle('ipping-active', b.getAttribute('data-mode') == self.mode);
		});
		this.rangeBar.style.display = (this.mode == 'graph') ? '' : 'none';
		this.navBar.style.display = (this.mode == 'calendar') ? 'flex' : 'none';
	},

	handleHover: function(ev) {
		var rect = this.chartBox.getBoundingClientRect();
		if (this.mode == 'graph' && this.plot) {
			var vx = (ev.clientX - rect.left) * 1000 / rect.width;
			var padL = 58, padR = 14;
			var frac = (vx - padL) / (1000 - padL - padR);
			if (frac < 0 || frac > 1 || !this.plot.pts.length) {
				this.tip.style.display = this.guide.style.display = 'none';
				return;
			}
			var t = this.plot.t0 + frac * (this.plot.t1 - this.plot.t0);
			var best = null, bd = Infinity;
			for (var i = 0; i < this.plot.pts.length; i++) {
				var d = Math.abs(this.plot.pts[i].t - t);
				if (d < bd) { bd = d; best = this.plot.pts[i]; }
			}
			if (!best) {
				this.tip.style.display = this.guide.style.display = 'none';
				return;
			}
			var xpos = padL + (best.t - this.plot.t0) / Math.max(1, this.plot.t1 - this.plot.t0) * (1000 - padL - padR);
			var left = xpos / 1000 * rect.width;
			this.guide.style.display = 'block';
			this.guide.style.left = left + 'px';
			this.tip.style.display = 'block';
			this.tip.style.left = Math.min(Math.max(4, left + 10), rect.width - 190) + 'px';
			this.tip.style.top = '4px';
			var loss = best.sent ? (best.lost / best.sent * 100) : null;
			this.tip.innerHTML = '%s<br>%s: %s ms<br>%s: %s ms / %s ms<br>%s: %s'.format(
				fmtFullTime(best.t),
				_('Avg'), fmtRtt(best.avg),
				_('Min'), fmtRtt(best.min), fmtRtt(best.max),
				_('Loss'), loss === null ? '-' : loss.toFixed(1) + '%'
			);
			return;
		}
		/* calendar / day bars: tooltip from data-didx */
		this.guide.style.display = 'none';
		var el = ev.target && ev.target.closest ? ev.target.closest('[data-didx]') : null;
		if (!el) {
			this.tip.style.display = 'none';
			return;
		}
		var day = this.dayList[+el.getAttribute('data-didx')];
		this.tip.style.display = 'block';
		this.tip.style.left = Math.min(ev.clientX - rect.left + 14, rect.width - 200) + 'px';
		this.tip.style.top = (ev.clientY - rect.top + 14) + 'px';
		this.tip.innerHTML = dayTooltip(day);
	},

	render: function() {
		var self = this;

		this.statusDot = E('span', { 'class': 'ipping-status' }, [ _('Checking…') ]);
		var statusLine = E('div', { 'class': 'ipping-statusline' }, [ this.statusDot ]);

		this.mode = 'graph';
		this.rangeIdx = 1;
		var now = new Date();
		this.calY = now.getFullYear();
		this.calM = now.getMonth() + 1;

		this.modeBar = E('div', { 'class': 'ipping-modebar' });
		this.tabBar = E('div', { 'class': 'ipping-tabs' });
		this.rangeBar = E('div', { 'class': 'ipping-ranges' });
		this.navBar = E('div', { 'class': 'ipping-nav', 'style': 'display:none' });
		this.hintBox = E('div');
		this.svgHost = E('div');
		this.guide = E('div', { 'class': 'ipping-guide' });
		this.tip = E('div', { 'class': 'ipping-tip' });
		this.chartBox = E('div', { 'class': 'ipping-chart' }, [ this.svgHost, this.guide, this.tip ]);
		this.chartBox.addEventListener('mousemove', this.handleHover.bind(this));
		this.chartBox.addEventListener('mouseleave', function() {
			self.tip.style.display = self.guide.style.display = 'none';
		});
		this.statsBox = E('div');
		this.legendBox = E('div');

		MODES.forEach(function(mo) {
			self.modeBar.appendChild(E('button', {
				'class': 'cbi-button ipping-modebtn',
				'data-mode': mo.id,
				'click': function() {
					self.mode = mo.id;
					self.updateModeChrome();
					self.refresh();
				}
			}, [ mo.label ]));
		});

		RANGES.forEach(function(r, i) {
			self.rangeBar.appendChild(E('button', {
				'class': 'cbi-button ipping-range',
				'data-idx': i,
				'click': function() {
					self.rangeIdx = i;
					self.updateRanges();
					self.refresh();
				}
			}, [ r.label ]));
		});

		var chartCard = E('div', { 'class': 'cbi-map' }, [
			E('h3', {}, _('Latency Monitor')),
			this.modeBar,
			this.tabBar,
			this.rangeBar,
			this.navBar,
			this.hintBox,
			this.chartBox,
			this.statsBox,
			this.legendBox
		]);

		var wrap = E('div', {}, [
			E('style', { 'type': 'text/css' }, [ CSS ]),
			statusLine,
			chartCard
		]);

		poll.add(L.bind(this.refresh, this), 60);

		self.updateModeChrome();
		self.updateRanges();
		return wrap;
	}
});
