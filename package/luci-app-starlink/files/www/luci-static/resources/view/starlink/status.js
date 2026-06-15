'use strict';
'require view';
'require rpc';
'require ui';

var HIST_INTERVAL_SEC = 1;
var REFRESH_MS = 5000;
var charts = {};
var rootNode = null;
var refreshTimer = null;
var refreshBusy = false;

var callConfig = rpc.declare({
	object: 'starlink.dish',
	method: 'config'
});

var callStatus = rpc.declare({
	object: 'starlink.dish',
	method: 'status'
});

var callDiagnostics = rpc.declare({
	object: 'starlink.dish',
	method: 'diagnostics'
});

var callAlignment = rpc.declare({
	object: 'starlink.dish',
	method: 'alignment'
});

var callHistory = rpc.declare({
	object: 'starlink.dish',
	method: 'history'
});

var callAction = function(method) {
	return rpc.declare({
		object: 'starlink.dish',
		method: method
	})();
};

function loadData() {
	return Promise.all([
		L.resolveDefault(callConfig(), {}),
		L.resolveDefault(callStatus(), {}),
		L.resolveDefault(callDiagnostics(), {}),
		L.resolveDefault(callAlignment(), {}),
		L.resolveDefault(callHistory(), {})
	]);
}

function text(value, fallback) {
	if (value === null || value === undefined || value === '')
		return fallback || '-';

	return String(value);
}

function number(value, digits) {
	if (value === null || value === undefined || value === '')
		return '-';

	var n = Number(value);
	if (!isFinite(n))
		return text(value);

	return n.toFixed(digits);
}

function avg(values) {
	var total = 0;
	var count = 0;

	values.forEach(function(value) {
		var n = Number(value);
		if (isFinite(n)) {
			total += n;
			count++;
		}
	});

	return count ? total / count : 0;
}

function mbps(value) {
	if (value === null || value === undefined || value === '')
		return '-';

	return number(Number(value) / 1000000, 1) + ' Mbps';
}

function uptime(seconds) {
	var s = Number(seconds || 0);
	var d, h, m;

	if (!isFinite(s) || s <= 0)
		return '-';

	d = Math.floor(s / 86400);
	h = Math.floor((s % 86400) / 3600);
	m = Math.floor((s % 3600) / 60);

	if (d > 0)
		return '%dd %dh %dm'.format(d, h, m);
	if (h > 0)
		return '%dh %dm'.format(h, m);

	return '%dm'.format(m);
}

function pct(value, digits) {
	return number(Number(value || 0) * 100, digits) + '%';
}

function rotateHistory(data, values) {
	if (!Array.isArray(values) || !values.length)
		return [];

	var head = Number(data.current || 0) % values.length;
	var out = head === 0 ? values.slice() : values.slice(head).concat(values.slice(0, head));

	return out.map(function(value) {
		var n = Number(value);
		return isFinite(n) ? n : 0;
	});
}

function activeAlerts(alerts) {
	var out = [];

	Object.keys(alerts || {}).sort().forEach(function(key) {
		if (alerts[key] === true)
			out.push(key);
	});

	return out.length ? out.join(', ') : _('None');
}

function card(label, value, sub, tone) {
	return E('div', { 'class': 'sl-card' + (tone ? ' ' + tone : '') }, [
		E('div', { 'class': 'sl-card-label' }, label),
		E('div', { 'class': 'sl-card-value' }, value),
		sub ? E('div', { 'class': 'sl-card-sub' }, sub) : ''
	]);
}

function chartCard(id, title, summary, color) {
	return E('div', { 'class': 'sl-chart' }, [
		E('div', { 'class': 'sl-chart-head' }, [
			E('div', { 'class': 'sl-chart-title' }, title),
			E('div', { 'class': 'sl-chart-summary' }, summary)
		]),
		E('div', { 'class': 'sl-chart-wrap' }, [
			E('canvas', { 'id': id, 'width': 640, 'height': 170, 'data-color': color }),
			E('div', { 'class': 'sl-chart-tip', 'hidden': '' })
		])
	]);
}

function infoRow(label, value) {
	return E('div', { 'class': 'sl-info-row' }, [
		E('span', {}, label),
		E('strong', {}, text(value))
	]);
}

function buildModel(data) {
	var cfg = data[0] || {};
	var status = data[1] || {};
	var diag = data[2] || {};
	var align = data[3] || {};
	var history = data[4] || {};
	var dlHist = rotateHistory(history, history.downlinkThroughputBps).map(function(v) { return +(v / 1000000).toFixed(3); });
	var ulHist = rotateHistory(history, history.uplinkThroughputBps).map(function(v) { return +(v / 1000000).toFixed(3); });
	var latHist = rotateHistory(history, history.popPingLatencyMs);
	var lossHist = rotateHistory(history, history.popPingDropRate).map(function(v) { return +(v * 100).toFixed(3); });
	var loadedAt = Date.now();

	return {
		cfg: cfg,
		status: status,
		diag: diag,
		align: align,
		history: history,
		dlHist: dlHist,
		ulHist: ulHist,
		latHist: latHist,
		lossHist: lossHist,
		loadedAt: loadedAt,
		error: status.error || diag.error || align.error || history.error
	};
}

function updateCharts(model) {
	charts = {
		'sl-chart-dl': { data: model.dlHist, color: '#009dff', unit: 'Mbps', loadedAt: model.loadedAt, hoverIndex: null },
		'sl-chart-ul': { data: model.ulHist, color: '#00b56a', unit: 'Mbps', loadedAt: model.loadedAt, hoverIndex: null },
		'sl-chart-lat': { data: model.latHist, color: '#d9822b', unit: 'ms', loadedAt: model.loadedAt, hoverIndex: null },
		'sl-chart-loss': { data: model.lossHist, color: '#d94c4c', unit: '%', loadedAt: model.loadedAt, hoverIndex: null }
	};
}

function renderStatus(data) {
	var model = buildModel(data);
	var cfg = model.cfg;
	var status = model.status;
	var diag = model.diag;
	var align = model.align;
	var info = status.deviceInfo || {};
	var state = status.deviceState || {};
	var obs = status.obstructionStats || {};
	var alerts = status.alerts || diag.alerts || {};
	var spanSec = model.dlHist.length * HIST_INTERVAL_SEC;
	var spanMin = Math.floor(spanSec / 60);
	var spanRem = spanSec % 60;

	updateCharts(model);

	if (model.error) {
		return E('div', { 'class': 'sl-content' }, [
			E('div', { 'class': 'alert-message warning' }, model.error)
		]);
	}

	return E('div', { 'class': 'sl-content' }, [
		E('div', { 'class': 'sl-topbar' }, [
			E('div', {}, [
				E('h2', {}, _('Starlink')),
				E('div', { 'class': 'sl-subtitle' }, _('Live dish status and recent history from the local gRPC API.'))
			]),
			E('div', { 'class': 'sl-top-actions' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': function() { showActions(); }
				}, _('Actions')),
				E('button', {
					'class': 'btn cbi-button cbi-button-reload',
					'click': function() { refreshData(); }
				}, _('Refresh'))
			])
		]),
		E('div', { 'class': 'sl-grid cards' }, [
			card(_('Downlink'), mbps(status.downlinkThroughputBps), _('avg %s, peak %s').format(number(avg(model.dlHist), 1), number(model.dlHist.length ? Math.max.apply(Math, model.dlHist) : 0, 1)), 'blue'),
			card(_('Uplink'), mbps(status.uplinkThroughputBps), _('avg %s').format(number(avg(model.ulHist), 1)), 'green'),
			card(_('Latency'), number(status.popPingLatencyMs, 1) + ' ms', _('avg %s, min %s').format(number(avg(model.latHist), 1), number(model.latHist.filter(function(v) { return v > 0; }).length ? Math.min.apply(Math, model.latHist.filter(function(v) { return v > 0; })) : 0, 1)), 'amber'),
			card(_('Drop Rate'), pct(status.popPingDropRate, 2), _('avg %s').format(number(avg(model.lossHist), 2) + '%'), Number(status.popPingDropRate || 0) > 0 ? 'red' : '')
		]),
		E('div', { 'class': 'sl-grid panels' }, [
			E('div', { 'class': 'sl-panel' }, [
				E('h3', {}, _('Dish')),
				infoRow(_('State'), status.state),
				infoRow(_('Uptime'), uptime(state.uptimeS)),
				infoRow(_('Hardware'), info.hardwareVersion),
				infoRow(_('Software'), info.softwareVersion),
				infoRow(_('Country'), info.countryCode),
				infoRow(_('ID'), info.id)
			]),
			E('div', { 'class': 'sl-panel' }, [
				E('h3', {}, _('Obstruction & Alignment')),
				infoRow(_('Obstructed'), obs.currentlyObstructed === true ? _('Yes') : _('No')),
				infoRow(_('Fraction'), number(Number(obs.fractionObstructed || 0) * 100, 2) + '%'),
				infoRow(_('Valid Time'), text(obs.validS) + ' s'),
				infoRow(_('Boresight'), '%s / %s deg'.format(number(align.boresightAzimuthDeg, 1), number(align.boresightElevationDeg, 1))),
				infoRow(_('Desired'), '%s / %s deg'.format(number(align.desiredBoresightAzimuthDeg, 1), number(align.desiredBoresightElevationDeg, 1))),
				infoRow(_('Alerts'), activeAlerts(alerts))
			])
		]),
		E('div', { 'class': 'sl-chart-grid' }, [
			chartCard('sl-chart-dl', _('Downlink'), _('Recent throughput'), '#009dff'),
			chartCard('sl-chart-ul', _('Uplink'), _('Recent throughput'), '#00b56a'),
			chartCard('sl-chart-lat', _('Latency'), _('POP ping'), '#d9822b'),
			chartCard('sl-chart-loss', _('Packet Loss'), _('Ping drop rate'), '#d94c4c')
		]),
		E('div', { 'class': 'sl-foot' }, [
			_('Host %s:%s').format(text(cfg.host), text(cfg.port)),
			' | ',
			_('%s samples, %s').format(model.dlHist.length, spanRem > 0 ? '%sm %ss'.format(spanMin, spanRem) : '%sm'.format(spanMin)),
			' | ',
			_('Updated %s').format(new Date(model.loadedAt).toLocaleTimeString())
		])
	]);
}

function renderIntoRoot(data) {
	if (!rootNode)
		return;

	rootNode.replaceChildren(E('style', {}, style()), renderStatus(data));
	window.setTimeout(drawCharts, 0);
}

function refreshData() {
	if (!rootNode || refreshBusy)
		return Promise.resolve();

	refreshBusy = true;
	rootNode.classList.add('is-refreshing');

	return loadData().then(function(data) {
		renderIntoRoot(data);
	}).catch(function(err) {
		rootNode.replaceChildren(E('style', {}, style()), E('div', { 'class': 'alert-message warning' }, err.message || String(err)));
	}).finally(function() {
		refreshBusy = false;
		if (rootNode)
			rootNode.classList.remove('is-refreshing');
	});
}

function startPolling() {
	if (refreshTimer)
		window.clearInterval(refreshTimer);

	refreshTimer = window.setInterval(function() {
		if (!rootNode || !document.body.contains(rootNode)) {
			window.clearInterval(refreshTimer);
			refreshTimer = null;
			rootNode = null;
			return;
		}

		refreshData();
	}, REFRESH_MS);
}

function showActions() {
	ui.showModal(_('Dish Actions'), [
		E('p', {}, _('These actions send control commands directly to the dish.')),
		E('div', { 'class': 'right' }, [
			E('button', {
				'class': 'btn cbi-button',
				'click': function() { ui.hideModal(); }
			}, _('Cancel')),
			' ',
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'click': function() { return callAction('stow').then(refreshData); }
			}, _('Stow')),
			' ',
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'click': function() { return callAction('unstow').then(refreshData); }
			}, _('Unstow')),
			' ',
			E('button', {
				'class': 'btn cbi-button cbi-button-negative',
				'click': function() { return callAction('reboot').then(refreshData); }
			}, _('Reboot'))
		])
	]);
}

function drawCharts() {
	Object.keys(charts).forEach(function(id) {
		var canvas = document.getElementById(id);
		if (canvas) {
			bindChart(canvas, id);
			drawChart(canvas, charts[id]);
		}
	});
}

function bindChart(canvas, id) {
	if (canvas.dataset.starlinkTooltipBound === '1')
		return;

	canvas.dataset.starlinkTooltipBound = '1';
	canvas.addEventListener('mousemove', function(ev) {
		var chart = charts[id];
		var rect, x, nearestIndex, nearestDistance;

		if (!chart || !chart.points || !chart.points.length)
			return;

		rect = canvas.getBoundingClientRect();
		x = ev.clientX - rect.left;
		nearestIndex = 0;
		nearestDistance = Infinity;

		chart.points.forEach(function(point, index) {
			var distance = Math.abs(point.x - x);
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearestIndex = index;
			}
		});

		chart.hoverIndex = nearestIndex;
		drawChart(canvas, chart);
	});

	canvas.addEventListener('mouseleave', function() {
		var chart = charts[id];
		if (!chart)
			return;

		chart.hoverIndex = null;
		drawChart(canvas, chart);
	});
}

function drawChart(canvas, chart) {
	var wrapper = canvas.parentNode;
	var tip = wrapper.querySelector('.sl-chart-tip');
	var ctx = canvas.getContext('2d');
	var dpr = window.devicePixelRatio || 1;
	var w = wrapper.clientWidth || 600;
	var h = wrapper.clientHeight || 170;
	var data = chart.data || [];
	var pad = { top: 12, right: 12, bottom: 22, left: 42 };
	var cw = w - pad.left - pad.right;
	var ch = h - pad.top - pad.bottom;
	var minV, maxV, range, points;

	canvas.width = Math.floor(w * dpr);
	canvas.height = Math.floor(h * dpr);
	canvas.style.width = w + 'px';
	canvas.style.height = h + 'px';
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, w, h);

	if (data.length < 2) {
		if (tip)
			tip.hidden = true;
		chart.points = [];
		ctx.fillStyle = 'rgba(180,180,180,0.75)';
		ctx.font = '12px sans-serif';
		ctx.fillText(_('No history data'), 12, h / 2);
		return;
	}

	minV = Math.min.apply(Math, data.concat([0]));
	maxV = Math.max.apply(Math, data.concat([0.001]));
	range = Math.max(maxV - minV, 0.001);

	ctx.strokeStyle = 'rgba(128,128,128,0.25)';
	ctx.lineWidth = 1;
	ctx.font = '10px sans-serif';
	ctx.textAlign = 'right';
	ctx.textBaseline = 'middle';
	for (var i = 0; i <= 4; i++) {
		var y = pad.top + ch - (i / 4) * ch;
		var val = minV + (i / 4) * range;
		ctx.beginPath();
		ctx.moveTo(pad.left, y);
		ctx.lineTo(pad.left + cw, y);
		ctx.stroke();
		ctx.fillStyle = 'rgba(160,160,160,0.8)';
		ctx.fillText(val.toFixed(maxV < 10 ? 1 : 0), pad.left - 6, y);
	}

	points = data.map(function(value, index) {
		return {
			x: pad.left + (index / (data.length - 1)) * cw,
			y: pad.top + ch - ((value - minV) / range) * ch,
			value: value,
			index: index
		};
	});
	chart.points = points;

	ctx.beginPath();
	points.forEach(function(point, index) {
		if (index === 0)
			ctx.moveTo(point.x, point.y);
		else
			ctx.lineTo(point.x, point.y);
	});
	ctx.strokeStyle = chart.color;
	ctx.lineWidth = 1.6;
	ctx.stroke();

	ctx.lineTo(pad.left + cw, pad.top + ch);
	ctx.lineTo(pad.left, pad.top + ch);
	ctx.closePath();
	ctx.fillStyle = chart.color + '22';
	ctx.fill();

	ctx.textAlign = 'left';
	ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = 'rgba(160,160,160,0.8)';
	ctx.fillText(chart.unit, pad.left, h - 7);

	if (chart.hoverIndex === null || chart.hoverIndex === undefined || !points[chart.hoverIndex]) {
		if (tip)
			tip.hidden = true;
		return;
	}

	drawTooltip(ctx, wrapper, tip, chart, points[chart.hoverIndex], w);
}

function drawTooltip(ctx, wrapper, tip, chart, point, width) {
	var secsAgo = (chart.data.length - 1 - point.index) * HIST_INTERVAL_SEC;
	var ptTime = new Date(chart.loadedAt - secsAgo * 1000);
	var time = [
		String(ptTime.getHours()).padStart(2, '0'),
		String(ptTime.getMinutes()).padStart(2, '0'),
		String(ptTime.getSeconds()).padStart(2, '0')
	].join(':');
	var rel = secsAgo < 60 ? '%ss ago'.format(secsAgo) : (secsAgo % 60 > 0 ? '%sm %ss ago'.format(Math.floor(secsAgo / 60), secsAgo % 60) : '%sm ago'.format(Math.floor(secsAgo / 60)));

	ctx.beginPath();
	ctx.fillStyle = chart.color;
	ctx.strokeStyle = '#ffffff';
	ctx.lineWidth = 1.5;
	ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
	ctx.fill();
	ctx.stroke();

	if (!tip)
		return;

	tip.innerHTML = '<div class="v">%s %s</div><div class="t">%s (%s)</div>'.format(number(point.value, 3), chart.unit, time, rel);
	tip.hidden = false;
	tip.style.left = Math.min(Math.max(point.x, 58), width - 58) + 'px';
	tip.style.top = Math.max(point.y - 10, 16) + 'px';
}

function style() {
	return '\
.sl-root{max-width:1480px;transition:opacity .15s ease}\
.sl-root.is-refreshing{opacity:.92}\
.sl-topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin:0 0 14px}\
.sl-topbar h2{margin:0 0 2px;font-size:24px}\
.sl-subtitle{opacity:.75}\
.sl-top-actions{display:flex;gap:6px;white-space:nowrap}\
.sl-grid{display:grid;gap:10px;margin-bottom:10px}\
.sl-grid.cards{grid-template-columns:repeat(4,minmax(0,1fr))}\
.sl-grid.panels{grid-template-columns:repeat(2,minmax(0,1fr))}\
.sl-card,.sl-panel,.sl-chart{background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.22);border-radius:6px}\
.sl-card{padding:10px 12px;min-height:76px;border-left:3px solid rgba(127,127,127,.4)}\
.sl-card.blue{border-left-color:#009dff}.sl-card.green{border-left-color:#00b56a}.sl-card.amber{border-left-color:#d9822b}.sl-card.red{border-left-color:#d94c4c}\
.sl-card-label,.sl-card-sub,.sl-chart-summary,.sl-foot{font-size:12px;opacity:.72}\
.sl-card-value{font-size:22px;font-weight:700;line-height:1.25;margin:3px 0 2px}\
.sl-panel{padding:10px 12px}\
.sl-panel h3{font-size:15px;margin:0 0 8px}\
.sl-info-row{display:grid;grid-template-columns:120px minmax(0,1fr);gap:12px;padding:3px 0;border-top:1px solid rgba(127,127,127,.12)}\
.sl-info-row:first-of-type{border-top:0}\
.sl-info-row span{opacity:.72}.sl-info-row strong{font-weight:600;overflow-wrap:anywhere}\
.sl-chart-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:10px}\
.sl-chart{padding:10px}\
.sl-chart-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px}\
.sl-chart-title{font-weight:700}\
.sl-chart-wrap{height:170px;min-width:0;position:relative}\
.sl-chart canvas{display:block;width:100%;height:100%}\
.sl-chart-tip{position:absolute;z-index:3;transform:translate(-50%,-100%);pointer-events:none;background:rgba(18,18,18,.92);color:#f2f2f2;border:1px solid rgba(255,255,255,.18);border-radius:5px;padding:5px 7px;box-shadow:0 4px 14px rgba(0,0,0,.28);white-space:nowrap;text-align:center}\
.sl-chart-tip .v{font-weight:700;font-size:12px}.sl-chart-tip .t{font-size:10px;opacity:.72;margin-top:2px}\
.sl-foot{margin-top:9px;text-align:right}\
@media(max-width:900px){.sl-grid.cards,.sl-grid.panels,.sl-chart-grid{grid-template-columns:1fr}.sl-topbar{display:block}.sl-top-actions{margin-top:10px}.sl-info-row{grid-template-columns:105px minmax(0,1fr)}}';
}

return view.extend({
	load: loadData,

	render: function(result) {
		rootNode = E('div', { 'class': 'sl-root' }, [
			E('style', {}, style()),
			renderStatus(result)
		]);

		window.setTimeout(drawCharts, 0);
		window.setTimeout(drawCharts, 150);
		startPolling();

		return rootNode;
	}
});
