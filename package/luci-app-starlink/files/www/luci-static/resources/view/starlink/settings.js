'use strict';
'require view';
'require form';

return view.extend({
	render: function() {
		var m, s, o;

		m = new form.Map('starlink', _('Starlink'));

		s = m.section(form.NamedSection, 'main', 'starlink');
		s.anonymous = true;

		o = s.option(form.Value, 'host', _('Dish host'));
		o.datatype = 'host';
		o.placeholder = '192.168.100.1';
		o.rmempty = false;

		o = s.option(form.Value, 'port', _('Dish gRPC port'));
		o.datatype = 'port';
		o.placeholder = '9200';
		o.rmempty = false;

		o = s.option(form.Value, 'timeout', _('Timeout'));
		o.datatype = 'uinteger';
		o.placeholder = '8';
		o.rmempty = false;

		return m.render();
	}
});
