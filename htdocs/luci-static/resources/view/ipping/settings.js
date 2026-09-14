/* luci-app-ipping - Settings page
 *
 * Standard UCI form for the collector settings and ping targets.
 * The collector re-reads the configuration every round, so changes apply
 * automatically within a minute.
 */
'use strict';
'require view';
'require uci';
'require form';

return view.extend({
	load: function() {
		return uci.load('ipping').then(function() {
			if (!uci.get('ipping', 'global'))
				uci.add('ipping', 'ipping', 'global');
		});
	},

	render: function() {
		var m = new form.Map('ipping', _('Settings'),
			_('The collector re-reads the configuration every round, changes apply automatically within a minute.'));

		var s = m.section(form.NamedSection, 'global', 'ipping', _('General Settings'));
		s.addremove = false;

		var o = s.option(form.Flag, 'enabled', _('Enable collector'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'interval', _('Ping interval (seconds)'),
			_('Rounds start aligned to full minutes. 60 = one round per minute, larger values sample less often.'));
		o.datatype = 'range(60,3600)';
		o.placeholder = '60';
		o.rmempty = false;

		o = s.option(form.Value, 'count', _('Pings per round'));
		o.datatype = 'range(1,20)';
		o.placeholder = '5';
		o.rmempty = false;

		o = s.option(form.Value, 'timeout', _('Ping timeout (seconds)'));
		o.datatype = 'range(1,10)';
		o.placeholder = '2';
		o.rmempty = false;

		o = s.option(form.Value, 'size', _('Packet size (bytes)'));
		o.datatype = 'range(8,1400)';
		o.placeholder = '56';
		o.rmempty = false;

		o = s.option(form.Value, 'dbdir', _('Data directory'),
			_('Where the binary data files are stored. A tmpfs path (default /tmp/ipping-data) avoids flash wear but loses data on reboot. Point this to persistent storage (e.g. /etc/ipping-data or a USB mount) to keep history, at the cost of flash writes.'));
		o.placeholder = '/tmp/ipping-data';
		o.rmempty = false;

		o = s.option(form.Value, 'minute_retention', _('Minute data retention (minutes)'),
			_('10080 = 7 days. Roughly 11 KiB per target per day.'));
		o.datatype = 'range(10,5270400)';
		o.placeholder = '10080';
		o.rmempty = false;

		o = s.option(form.Value, 'hour_retention', _('Hourly data retention (hours)'),
			_('8760 = 365 days. Roughly 7.3 KiB per target per month.'));
		o.datatype = 'range(24,175200)';
		o.placeholder = '8760';
		o.rmempty = false;

		var g = m.section(form.GridSection, 'target', _('Ping Targets'),
			_('Data files are kept per target name (or host). Renaming a target starts a new data set.'));
		g.addremove = true;
		g.anonymous = true;
		g.nodescriptions = true;

		o = g.option(form.Flag, 'enabled', _('Enabled'));
		o.default = '1';
		o.rmempty = false;

		o = g.option(form.Value, 'name', _('Display name'));
		o.optional = true;
		o.placeholder = _('e.g. Gateway');

		o = g.option(form.Value, 'host', _('Host / IP address'));
		o.datatype = 'host';
		o.rmempty = false;

		return m.render();
	}
});
