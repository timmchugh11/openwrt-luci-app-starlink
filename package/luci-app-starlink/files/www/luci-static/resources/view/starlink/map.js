'use strict';
'require view';
'require rpc';

var REFRESH_MS = 5000;
var OBSTRUCTED_SNR_THRESHOLD = 0.65;
var rootNode = null;
var pollTimer = null;
var refreshBusy = false;

var callStatus = rpc.declare({
	object: 'starlink.dish',
	method: 'status'
});

var callAlignment = rpc.declare({
	object: 'starlink.dish',
	method: 'alignment'
});

var callObstructionMap = rpc.declare({
	object: 'starlink.dish',
	method: 'obstruction_map'
});

var viewState = initialViewState();

function initialViewState() {
	return {
		canvas: null,
		renderer: null,
		scene: null,
		camera: null,
		obsGroup: null,
		mapOrientGroup: null,
		yawGroup: null,
		cellMeshes: [],
		cells: [],
		THREE: null,
		dishLoadStarted: false,
		dishOrientGroup: null,
		desiredOrientGroup: null,
		pendingAlign: null,
		yaw: 0,
		pitch: 0.5,
		zoom: 1.05,
		yawVel: 0.0003,
		baseYawVel: 0.0003,
		spinRaf: null,
		velHistory: [],
		dragging: false,
		pointerId: null,
		lastX: 0,
		lastY: 0,
		resizeBound: false
	};
}

function text(value, fallback) {
	if (value === null || value === undefined || value === '')
		return fallback || '-';

	return String(value);
}

function number(value, digits) {
	var n = Number(value);

	if (!isFinite(n))
		return '-';

	return n.toFixed(digits);
}

function setText(id, value) {
	var el = document.getElementById(id);

	if (el)
		el.textContent = value;
}

function loadData() {
	return Promise.all([
		L.resolveDefault(callObstructionMap(), {}),
		L.resolveDefault(callAlignment(), {}),
		L.resolveDefault(callStatus(), {})
	]);
}

function ensureThreeModule() {
	if (window.__starlinkObstruction3D) {
		initScene();
		return;
	}

	window.addEventListener('starlink-obstruction-3d-ready', initScene, { once: true });

	if (document.querySelector('script[data-starlink-three="1"]'))
		return;

	var script = document.createElement('script');
	script.type = 'module';
	script.src = L.resource('starlink/obstruction-3d.js');
	script.dataset.starlinkThree = '1';
	document.head.appendChild(script);
}

function applyData(data) {
	var obstruction = data[0] || {};
	var alignment = data[1] || {};
	var status = data[2] || {};
	var snr = obstruction.snr || [];
	var rows = Number(obstruction.numRows || 1);
	var cols = Number(obstruction.numCols || Math.round(snr.length / rows) || 1);
	var cells = [];
	var untracked = 0;
	var blocked = 0;
	var alerts = status.alerts || {};
	var obsStats = status.obstructionStats || {};
	var aAz = Number(alignment.boresightAzimuthDeg);
	var aEl = Number(alignment.boresightElevationDeg);
	var dAz = Number(alignment.desiredBoresightAzimuthDeg);
	var dEl = Number(alignment.desiredBoresightElevationDeg);

	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			var val = Number(snr[r * cols + c]);
			var x = ((cols - 1 - c + 0.5) / cols) * 2 - 1;
			var y = ((r + 0.5) / rows) * 2 - 1;
			var radial = x * x + y * y;

			if (radial > 1)
				continue;

			if (!isFinite(val) || val < 0) {
				untracked++;
				continue;
			}

			if (val < OBSTRUCTED_SNR_THRESHOLD)
				blocked++;

			cells.push({
				x: x,
				y: y,
				z: Math.sqrt(1 - radial),
				value: Math.min(1, Math.max(0, val))
			});
		}
	}

	viewState.cells = cells;

	if (viewState.THREE)
		buildCellMesh();

	if (isFinite(aAz) && isFinite(aEl)) {
		viewState.pendingAlign = {
			aAz: aAz,
			aEl: aEl,
			dAz: isFinite(dAz) ? dAz : null,
			dEl: isFinite(dEl) ? dEl : null
		};
		applyDishOrientation(aAz, aEl);
		if (isFinite(dAz) && isFinite(dEl))
			applyDesiredOrientation(dAz, dEl);
	}

	setText('sl-map-dl', status.downlinkThroughputBps != null ? number(Number(status.downlinkThroughputBps) / 1000000, 2) : '-');
	setText('sl-map-ul', status.uplinkThroughputBps != null ? number(Number(status.uplinkThroughputBps) / 1000000, 2) : '-');
	setText('sl-map-ping', status.popPingLatencyMs != null ? number(status.popPingLatencyMs, 0) : '-');
	setText('sl-map-drop', number(Number(status.popPingDropRate || 0) * 100, 1));
	setText('sl-map-samples', cells.length.toLocaleString());
	setText('sl-map-blocked', blocked.toLocaleString());
	setText('sl-map-untracked', untracked.toLocaleString());
	setText('sl-map-actual', '%s / %s'.format(number(aAz, 1), number(aEl, 1)));
	setText('sl-map-desired', '%s / %s'.format(number(dAz, 1), number(dEl, 1)));
	setText('sl-map-obstruction', obsStats.currentlyObstructed === true || alerts.obstructed === true || alerts.roofObstruction === true || alerts.fresnelZoneObstruction === true ? _('Obstructed') : _('Clear'));
	setText('sl-map-updated', _('Updated %s').format(new Date().toLocaleTimeString()));

	renderMap();
}

function refreshData() {
	if (!rootNode || refreshBusy)
		return Promise.resolve();

	refreshBusy = true;
	rootNode.classList.add('is-refreshing');

	return loadData().then(function(data) {
		applyData(data);
	}).finally(function() {
		refreshBusy = false;
		if (rootNode)
			rootNode.classList.remove('is-refreshing');
	});
}

function startPolling() {
	if (pollTimer)
		window.clearInterval(pollTimer);

	pollTimer = window.setInterval(function() {
		if (!rootNode || !document.body.contains(rootNode)) {
			stopScene();
			return;
		}

		refreshData();
	}, REFRESH_MS);
}

function initCanvas() {
	var canvas;

	if (viewState.canvas)
		return;

	canvas = document.getElementById('sl-map-canvas');
	if (!canvas)
		return;

	viewState.canvas = canvas;

	canvas.addEventListener('pointerdown', function(ev) {
		viewState.dragging = true;
		viewState.pointerId = ev.pointerId;
		viewState.lastX = ev.clientX;
		viewState.lastY = ev.clientY;
		viewState.velHistory = [];
		canvas.classList.add('is-dragging');
		canvas.setPointerCapture(ev.pointerId);
	});

	canvas.addEventListener('pointermove', function(ev) {
		var dx;

		if (!viewState.dragging || ev.pointerId !== viewState.pointerId)
			return;

		dx = (ev.clientX - viewState.lastX) * 0.01;
		viewState.yaw += dx;
		viewState.yawVel = dx;
		viewState.pitch = Math.max(-0.4, Math.min(1.0, viewState.pitch + (ev.clientY - viewState.lastY) * 0.01));
		viewState.lastX = ev.clientX;
		viewState.lastY = ev.clientY;
		viewState.velHistory.push(dx);
		if (viewState.velHistory.length > 5)
			viewState.velHistory.shift();
		renderMap();
	});

	function endDrag(ev) {
		var h, flick, speed;

		if (ev && viewState.pointerId !== null && ev.pointerId !== viewState.pointerId)
			return;

		viewState.dragging = false;
		canvas.classList.remove('is-dragging');
		if (ev && canvas.hasPointerCapture(ev.pointerId))
			canvas.releasePointerCapture(ev.pointerId);

		h = viewState.velHistory;
		flick = h.length ? h.reduce(function(a, b) { return a + b; }, 0) / h.length : 0;
		viewState.yawVel = flick;
		if (Math.abs(flick) > 0.0001) {
			speed = Math.abs(viewState.baseYawVel);
			viewState.baseYawVel = flick > 0 ? speed : -speed;
		}
	}

	canvas.addEventListener('pointerup', endDrag);
	canvas.addEventListener('pointercancel', endDrag);
	canvas.addEventListener('pointerleave', function(ev) {
		viewState.velHistory = [];
		endDrag(ev);
	});

	canvas.addEventListener('wheel', function(ev) {
		ev.preventDefault();
		viewState.zoom = Math.max(0.35, Math.min(4.0, viewState.zoom * (ev.deltaY > 0 ? 1.1 : 1 / 1.1)));
		renderMap();
	}, { passive: false });

	if (!viewState.resizeBound) {
		viewState.resizeBound = true;
		window.addEventListener('resize', renderMap);
	}
}

function initScene() {
	var mods, THREE, GLTFLoader, canvas, renderer, scene, camera, obsGroup, mapOrientGroup, yawGroup, key, fill;

	initCanvas();
	if (viewState.renderer)
		return;

	mods = window.__starlinkObstruction3D;
	if (!mods || !viewState.canvas)
		return;

	THREE = mods.THREE;
	GLTFLoader = mods.GLTFLoader;
	canvas = viewState.canvas;
	renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
	renderer.setClearColor(0x000000, 0);
	renderer.setPixelRatio(window.devicePixelRatio || 1);
	if (THREE.SRGBColorSpace)
		renderer.outputColorSpace = THREE.SRGBColorSpace;

	scene = new THREE.Scene();
	camera = new THREE.PerspectiveCamera(46, 1, 0.01, 100);
	camera.position.set(0, 0.9, 2.1);
	camera.lookAt(0, 0.25, 0);

	scene.add(new THREE.AmbientLight(0xffffff, 1.0));
	key = new THREE.DirectionalLight(0xffffff, 2.2);
	key.position.set(2, 4, 3);
	scene.add(key);
	fill = new THREE.DirectionalLight(0x7ab0ff, 0.9);
	fill.position.set(-2, -1, 2);
	scene.add(fill);

	obsGroup = new THREE.Group();
	scene.add(obsGroup);
	mapOrientGroup = new THREE.Group();
	obsGroup.add(mapOrientGroup);
	yawGroup = new THREE.Group();
	scene.add(yawGroup);
	buildCompassRing(THREE, yawGroup);
	yawGroup.scale.setScalar(0.5);

	viewState.THREE = THREE;
	viewState.renderer = renderer;
	viewState.scene = scene;
	viewState.camera = camera;
	viewState.obsGroup = obsGroup;
	viewState.mapOrientGroup = mapOrientGroup;
	viewState.yawGroup = yawGroup;
	viewState.dishOrientGroup = new THREE.Group();
	viewState.desiredOrientGroup = new THREE.Group();
	viewState.desiredOrientGroup.position.y = 0.03;
	obsGroup.add(viewState.dishOrientGroup);
	obsGroup.add(viewState.desiredOrientGroup);

	loadDishModel(THREE, GLTFLoader);
	if (viewState.cells.length)
		buildCellMesh();
	if (viewState.pendingAlign) {
		applyDishOrientation(viewState.pendingAlign.aAz, viewState.pendingAlign.aEl);
		if (viewState.pendingAlign.dAz !== null && viewState.pendingAlign.dEl !== null)
			applyDesiredOrientation(viewState.pendingAlign.dAz, viewState.pendingAlign.dEl);
	}

	renderMap();
	startSpin();
}

function loadDishModel(THREE, GLTFLoader) {
	if (viewState.dishLoadStarted || !GLTFLoader)
		return;

	viewState.dishLoadStarted = true;
	new GLTFLoader().load(L.resource('starlink/models/starlink_mini_dish.glb'), function(gltf) {
		var model = gltf.scene;
		var box = new THREE.Box3().setFromObject(model);
		var ctr = box.getCenter(new THREE.Vector3());
		var dims = box.getSize(new THREE.Vector3());
		var scale = 0.32 / (Math.max(dims.x, dims.y, dims.z) || 1);
		var ghost;

		model.scale.setScalar(scale);
		model.position.set(-ctr.x * scale, -ctr.y * scale + 0.04, -ctr.z * scale);
		model.traverse(function(child) {
			if (!child.isMesh)
				return;
			child.frustumCulled = false;
			child.material = new THREE.MeshStandardMaterial({
				color: 0xe0e8f8,
				metalness: 0.3,
				roughness: 0.55,
				side: THREE.DoubleSide
			});
		});
		viewState.dishOrientGroup.add(model);

		ghost = model.clone(true);
		ghost.traverse(function(child) {
			if (!child.isMesh)
				return;
			child.frustumCulled = false;
			child.material = new THREE.MeshStandardMaterial({
				color: 0x00b56a,
				metalness: 0.1,
				roughness: 0.7,
				transparent: true,
				opacity: 0.35,
				side: THREE.DoubleSide,
				depthWrite: false
			});
		});
		viewState.desiredOrientGroup.add(ghost);
		renderMap();
	});
}

function buildCompassRing(THREE, group) {
	var radius = 0.708;
	var y = 0.01;
	var pts = [];
	var i, angle, major, r1, line, labels, canvas, ctx, sprite, item;

	for (i = 0; i <= 128; i++) {
		angle = (i / 128) * Math.PI * 2;
		pts.push(new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius));
	}

	group.add(new THREE.Line(
		new THREE.BufferGeometry().setFromPoints(pts),
		new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 })
	));

	for (i = 0; i < 72; i++) {
		angle = (i / 72) * Math.PI * 2;
		major = i % 6 === 0;
		r1 = radius - (major ? 0.07 : 0.03);
		line = new THREE.Line(
			new THREE.BufferGeometry().setFromPoints([
				new THREE.Vector3(Math.cos(angle) * r1, y, Math.sin(angle) * r1),
				new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius)
			]),
			new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: major ? 0.75 : 0.3 })
		);
		group.add(line);
	}

	labels = [
		[ 'N', 0, -0.828 ],
		[ 'E', 0.828, 0 ],
		[ 'S', 0, 0.828 ],
		[ 'W', -0.828, 0 ]
	];
	for (i = 0; i < labels.length; i++) {
		item = labels[i];
		canvas = document.createElement('canvas');
		canvas.width = 128;
		canvas.height = 128;
		ctx = canvas.getContext('2d');
		ctx.fillStyle = 'rgba(255,255,255,0.92)';
		ctx.font = 'bold 88px sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(item[0], 64, 68);
		sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true }));
		sprite.position.set(item[1], y + 0.108, item[2]);
		sprite.scale.set(0.156, 0.156, 1);
		group.add(sprite);
	}
}

function buildCellMesh() {
	var THREE = viewState.THREE;
	var geom, opts, clear, blocked, dummy, subsets, i, j, subset, mat, mesh, cell;

	if (!THREE || !viewState.mapOrientGroup)
		return;

	for (i = 0; i < viewState.cellMeshes.length; i++) {
		viewState.mapOrientGroup.remove(viewState.cellMeshes[i]);
		viewState.cellMeshes[i].geometry.dispose();
		viewState.cellMeshes[i].material.dispose();
	}
	viewState.cellMeshes = [];

	if (!viewState.cells.length)
		return;

	geom = new THREE.BoxGeometry(0.022, 0.001, 0.022);
	opts = { transparent: true, opacity: 0.5, depthWrite: false };
	clear = new THREE.MeshBasicMaterial(Object.assign({}, opts, { color: new THREE.Color('#00d5ff') }));
	blocked = new THREE.MeshBasicMaterial(Object.assign({}, opts, { color: new THREE.Color('#ff4c4c') }));
	dummy = new THREE.Object3D();
	subsets = [
		[ viewState.cells.filter(function(c) { return c.value >= OBSTRUCTED_SNR_THRESHOLD; }), clear ],
		[ viewState.cells.filter(function(c) { return c.value < OBSTRUCTED_SNR_THRESHOLD; }), blocked ]
	];

	for (i = 0; i < subsets.length; i++) {
		subset = subsets[i][0];
		mat = subsets[i][1];
		if (!subset.length)
			continue;

		mesh = new THREE.InstancedMesh(geom, mat, subset.length);
		mesh.frustumCulled = false;
		for (j = 0; j < subset.length; j++) {
			cell = subset[j];
			dummy.position.set(cell.x, cell.z, cell.y);
			dummy.rotation.set(0, 0, 0);
			dummy.updateMatrix();
			mesh.setMatrixAt(j, dummy.matrix);
		}
		mesh.instanceMatrix.needsUpdate = true;
		viewState.cellMeshes.push(mesh);
		viewState.mapOrientGroup.add(mesh);
	}
}

function applyDishOrientation(az, el) {
	var THREE = viewState.THREE;
	var qTilt, qAz;

	if (!THREE || !viewState.dishOrientGroup)
		return;

	qTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (90 - el) * Math.PI / 180);
	qAz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI - az * Math.PI / 180);
	viewState.dishOrientGroup.quaternion.multiplyQuaternions(qAz, qTilt);
	if (viewState.mapOrientGroup)
		viewState.mapOrientGroup.quaternion.copy(qAz);
	renderMap();
}

function applyDesiredOrientation(az, el) {
	var THREE = viewState.THREE;
	var qTilt, qAz;

	if (!THREE || !viewState.desiredOrientGroup)
		return;

	qTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (90 - el) * Math.PI / 180);
	qAz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI - az * Math.PI / 180);
	viewState.desiredOrientGroup.quaternion.multiplyQuaternions(qAz, qTilt);
	renderMap();
}

function startSpin() {
	function loop() {
		if (!rootNode || !document.body.contains(rootNode)) {
			stopScene();
			return;
		}

		if (!viewState.dragging) {
			viewState.yawVel *= 0.92;
			viewState.yaw += viewState.yawVel + viewState.baseYawVel;
			if (viewState.yaw > Math.PI)
				viewState.yaw -= Math.PI * 2;
			else if (viewState.yaw < -Math.PI)
				viewState.yaw += Math.PI * 2;
			renderMap();
		}
		viewState.spinRaf = window.requestAnimationFrame(loop);
	}

	if (!viewState.spinRaf)
		viewState.spinRaf = window.requestAnimationFrame(loop);
}

function renderMap() {
	var canvas = viewState.canvas;
	var renderer = viewState.renderer;
	var rect, w, h, z, THREE, qY, qX, q;

	if (!renderer || !canvas)
		return;

	rect = canvas.parentNode.getBoundingClientRect();
	w = Math.max(320, Math.floor(rect.width || 760));
	h = Math.max(260, Math.floor(rect.height || 520));
	renderer.setPixelRatio(window.devicePixelRatio || 1);
	renderer.setSize(w, h, false);
	viewState.camera.aspect = w / h;
	viewState.camera.updateProjectionMatrix();
	z = viewState.zoom;
	viewState.camera.position.set(0, 0.9 * z, 2.1 * z);
	viewState.camera.lookAt(0, 0.25, 0);

	THREE = viewState.THREE;
	qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), viewState.yaw);
	qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), viewState.pitch);
	q = new THREE.Quaternion().multiplyQuaternions(qX, qY);
	if (viewState.obsGroup)
		viewState.obsGroup.quaternion.copy(q);
	if (viewState.yawGroup)
		viewState.yawGroup.quaternion.copy(q);

	renderer.render(viewState.scene, viewState.camera);
}

function stopScene() {
	var i;

	if (pollTimer) {
		window.clearInterval(pollTimer);
		pollTimer = null;
	}
	if (viewState.spinRaf) {
		window.cancelAnimationFrame(viewState.spinRaf);
		viewState.spinRaf = null;
	}
	for (i = 0; i < viewState.cellMeshes.length; i++) {
		if (viewState.cellMeshes[i].geometry)
			viewState.cellMeshes[i].geometry.dispose();
		if (viewState.cellMeshes[i].material)
			viewState.cellMeshes[i].material.dispose();
	}
	if (viewState.renderer)
		viewState.renderer.dispose();
	viewState = initialViewState();
	rootNode = null;
}

function style() {
	return '\
.sl-map-root{max-width:1480px;transition:opacity .15s ease}\
.sl-map-root.is-refreshing{opacity:.92}\
.sl-map-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin:0 0 10px}\
.sl-map-top h2{margin:0 0 2px;font-size:24px}.sl-map-sub{opacity:.72}\
.sl-map-stage{position:relative;min-height:560px;height:calc(100vh - 260px);border:1px solid rgba(127,127,127,.22);border-radius:6px;background:rgba(0,0,0,.18);overflow:hidden}\
#sl-map-canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab}\
#sl-map-canvas.is-dragging{cursor:grabbing}\
.sl-map-overlay{position:absolute;inset:0;pointer-events:none;display:grid;grid-template-columns:1fr 1fr 1fr;grid-template-rows:1fr 1fr 1fr;padding:14px}\
.sl-map-stat{display:flex;flex-direction:column;gap:3px;text-shadow:0 1px 7px rgba(0,0,0,.8)}\
.sl-map-stat div{font-size:13px;line-height:1.35}.sl-map-stat .dim{font-size:11px;opacity:.62}.sl-map-stat strong{font-size:15px}\
.sl-map-tl{grid-column:1;grid-row:1;align-self:start;justify-self:start}.sl-map-tr{grid-column:3;grid-row:1;align-self:start;justify-self:end;text-align:right}.sl-map-bl{grid-column:1;grid-row:3;align-self:end;justify-self:start}.sl-map-br{grid-column:3;grid-row:3;align-self:end;justify-self:end;text-align:right}\
.sl-map-legend{display:flex;gap:10px;justify-content:flex-end;align-items:center;font-size:11px;opacity:.75}.sl-map-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px}.sl-map-clear{color:#00d5ff}.sl-map-blocked{color:#ff6b6b}.sl-map-desired{color:#00b56a}\
@media(max-width:800px){.sl-map-top{display:block}.sl-map-stage{height:560px}.sl-map-overlay{padding:10px}.sl-map-stat div{font-size:12px}}';
}

return view.extend({
	load: loadData,

	render: function(data) {
		if (viewState.canvas && !document.body.contains(viewState.canvas))
			stopScene();

		rootNode = E('div', { 'class': 'sl-map-root' }, [
			E('style', {}, style()),
			E('div', { 'class': 'sl-map-top' }, [
				E('div', {}, [
					E('h2', {}, _('Starlink Map')),
					E('div', { 'class': 'sl-map-sub' }, _('3D obstruction and dish alignment view. Drag to rotate, scroll to zoom.'))
				]),
				E('button', {
					'class': 'btn cbi-button cbi-button-reload',
					'click': function() { refreshData(); }
				}, _('Refresh'))
			]),
			E('div', { 'class': 'sl-map-stage' }, [
				E('canvas', { 'id': 'sl-map-canvas', 'width': 960, 'height': 560 }),
				E('div', { 'class': 'sl-map-overlay' }, [
					E('div', { 'class': 'sl-map-stat sl-map-tl' }, [
						E('div', {}, [ E('strong', { 'id': 'sl-map-dl' }, '-'), ' ', E('span', {}, _('Mbits/s Down')) ]),
						E('div', {}, [ E('strong', { 'id': 'sl-map-ul' }, '-'), ' ', E('span', {}, _('Mbits/s Up')) ]),
						E('div', {}, [ E('strong', { 'id': 'sl-map-ping' }, '-'), ' ', E('span', {}, _('ms Ping')) ])
					]),
					E('div', { 'class': 'sl-map-stat sl-map-tr' }, [
						E('div', { 'class': 'sl-map-legend' }, [
							E('span', {}, [ E('i', { 'class': 'sl-map-dot', 'style': 'background:#00d5ff' }), _('Clear') ]),
							E('span', {}, [ E('i', { 'class': 'sl-map-dot', 'style': 'background:#ff4c4c' }), _('Obstructed') ]),
							E('span', {}, [ E('i', { 'class': 'sl-map-dot', 'style': 'background:#00b56a' }), _('Desired') ])
						])
					]),
					E('div', { 'class': 'sl-map-stat sl-map-bl' }, [
						E('div', { 'class': 'dim' }, [ _('Sky'), ': ', E('span', { 'id': 'sl-map-samples' }, '-'), ' ', _('tracked'), ', ', E('span', { 'id': 'sl-map-blocked' }, '-'), ' ', _('blocked'), ', ', E('span', { 'id': 'sl-map-untracked' }, '-'), ' ', _('untracked') ]),
						E('div', { 'class': 'dim' }, [ _('Actual Az/El'), ': ', E('span', { 'id': 'sl-map-actual' }, '-') ]),
						E('div', { 'class': 'dim sl-map-desired' }, [ _('Desired Az/El'), ': ', E('span', { 'id': 'sl-map-desired' }, '-') ])
					]),
					E('div', { 'class': 'sl-map-stat sl-map-br' }, [
						E('div', {}, [ E('strong', { 'id': 'sl-map-drop' }, '-'), ' ', E('span', {}, _('% Dropped')) ]),
						E('div', { 'id': 'sl-map-obstruction' }, '-'),
						E('div', { 'class': 'dim', 'id': 'sl-map-updated' }, '-')
					])
				])
			])
		]);

		ensureThreeModule();
		window.setTimeout(function() {
			applyData(data);
			startPolling();
		}, 0);

		return rootNode;
	}
});
