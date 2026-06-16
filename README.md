# luci-app-starlink

Lightweight OpenWrt LuCI application for local Starlink dish telemetry.

The package talks directly to the Starlink dish gRPC API and exposes the data in
LuCI through an rpcd bridge. It is designed to run on OpenWrt without Node.js.

## Quick Install

The release APK is target-specific. The current published APK was built with
the OpenWrt `25.12.4 x86/64` SDK and is intended for x86/64 routers only.
Other router targets need their own build from the matching OpenWrt SDK.

On the OpenWrt router:

```sh
cd /tmp
wget https://github.com/timmchugh11/openwrt-luci-app-starlink/releases/download/v0.2.0-r1/luci-app-starlink-0.2.0-r1.apk
apk update
apk add --allow-untrusted /tmp/luci-app-starlink-0.2.0-r1.apk
rm -rf /tmp/luci-*
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart
```

Then open LuCI:

```text
Services -> Starlink
```

## Network Access

The OpenWrt router must be able to reach the Starlink dish directly. By default
this package connects to:

```text
192.168.100.1:9200
```

Make sure your routing and firewall rules allow traffic from the router to the
dish management address. If the router WAN interface is connected through the
Starlink router or bypass mode, this usually means allowing outbound traffic to
`192.168.100.1` on TCP port `9200` and ensuring the route to `192.168.100.1`
exists.

## Features

- LuCI pages under `Services -> Starlink`.
- Live dish status, hardware/software info, alerts, obstruction summary, and
  alignment summary.
- Recent history charts for downlink, uplink, latency, and packet loss.
- 3D obstruction/alignment map using Three.js and the Starlink Mini dish model.
- In-place telemetry refresh every 5 seconds.
- Chart hover tooltips with value, timestamp, and relative sample age.
- Dish actions for reboot, stow, and unstow.
- Small Go backend installed as `/usr/bin/starlink-dish`.
- rpcd object: `starlink.dish`.

## Package

```text
luci-app-starlink 0.2.0-r1
```

Default dish endpoint:

```text
192.168.100.1:9200
```

Default UCI config:

```text
config starlink 'main'
	option host '192.168.100.1'
	option port '9200'
	option timeout '8'
```

## Repository Layout

```text
package/luci-app-starlink/
  Makefile
  src/
    cmd/starlink-dish/main.go
    go.mod
    go.sum
  files/
    etc/config/starlink
    etc/uci-defaults/90-luci-app-starlink
    usr/libexec/rpcd/starlink.dish
    usr/share/luci/menu.d/luci-app-starlink.json
    usr/share/rpcd/acl.d/luci-app-starlink.json
    www/luci-static/resources/view/starlink/status.js
    www/luci-static/resources/view/starlink/map.js
    www/luci-static/resources/view/starlink/settings.js
    www/luci-static/resources/starlink/
      obstruction-3d.js
      models/starlink_mini_dish.glb
      vendor/three/
```

## Build

Use an OpenWrt SDK that matches the router target and release.

This package is architecture-dependent because it includes the compiled Go
backend at `/usr/bin/starlink-dish`. The LuCI JavaScript and static files are
portable, but the final APK must be built separately for each OpenWrt target.

Example target-specific release names:

```text
luci-app-starlink-0.2.0-r1-x86-64.apk
luci-app-starlink-0.2.0-r1-mediatek-filogic.apk
luci-app-starlink-0.2.0-r1-ramips-mt7621.apk
```

This package has been built against:

```text
OpenWrt 25.12.4 x86/64
```

From inside an extracted SDK:

```sh
echo 'src-link starlink /path/to/openwrt-luci-app-starlink' >> feeds.conf.default
./scripts/feeds update packages starlink
./scripts/feeds install luci-app-starlink
make defconfig
make package/luci-app-starlink/compile V=s
```

The built package will be under:

```text
bin/packages/<target>/starlink/
```

## Docker SDK Build

From this repository root:

```powershell
docker run --rm -v "${PWD}:/feed" ubuntu:24.04 bash -lc "set -euo pipefail; apt-get update >/dev/null; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl wget zstd tar make gcc g++ libc6-dev file python3 unzip rsync patch perl git gawk gettext libssl-dev xz-utils bzip2 libncurses-dev >/dev/null; useradd -m builder; cd /home/builder; curl -fL -o sdk.tar.zst https://downloads.openwrt.org/releases/25.12.4/targets/x86/64/openwrt-sdk-25.12.4-x86-64_gcc-14.3.0_musl.Linux-x86_64.tar.zst; tar --zstd -xf sdk.tar.zst; cd openwrt-sdk-*; echo 'src-link starlink /feed' >> feeds.conf.default; chown -R builder:builder /home/builder; su builder -c './scripts/feeds update packages starlink'; su builder -c './scripts/feeds install luci-app-starlink'; su builder -c 'make defconfig'; su builder -c 'make package/luci-app-starlink/compile V=s'; mkdir -p /feed/dist; find bin -type f \( -name '*luci-app-starlink*.apk' -o -name '*luci-app-starlink*.ipk' \) -print0 | xargs -0 -I{} cp {} /feed/dist/; find /feed/dist -maxdepth 1 -type f -name '*luci-app-starlink*'"
```

## Manual Install

OpenWrt 25.12 uses `apk`.

Download the release on another machine and copy it to the router:

```powershell
scp -O .\dist\luci-app-starlink-0.2.0-r1.apk root@192.168.1.1:/tmp/
```

```sh
apk update
apk add --allow-untrusted /tmp/luci-app-starlink-0.2.0-r1.apk
rm -rf /tmp/luci-*
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart
```

The `-O` flag forces legacy SCP mode, which is useful on OpenWrt systems that
do not provide an SFTP server.

## LuCI Pages

```text
Services -> Starlink -> Status
Services -> Starlink -> Map
Services -> Starlink -> Settings
```

The `Status` page shows compact live metrics and history charts. The `Map` page
loads Three.js only when opened and renders the obstruction map, compass ring,
actual dish orientation, and desired dish orientation using the bundled Starlink
Mini dish model.

## CLI

```sh
starlink-dish config
starlink-dish status
starlink-dish diagnostics
starlink-dish history
starlink-dish obstruction-map
starlink-dish alignment
starlink-dish dump
```

Dish actions:

```sh
starlink-dish stow
starlink-dish unstow
starlink-dish reboot
```

## rpcd

```sh
ubus call starlink.dish config
ubus call starlink.dish status
ubus call starlink.dish diagnostics
ubus call starlink.dish history
ubus call starlink.dish obstruction_map
ubus call starlink.dish alignment
```

## Development

JavaScript syntax checks:

```sh
node --check package/luci-app-starlink/files/www/luci-static/resources/view/starlink/status.js
node --check package/luci-app-starlink/files/www/luci-static/resources/view/starlink/map.js
node --check package/luci-app-starlink/files/www/luci-static/resources/view/starlink/settings.js
```

Direct Go build check:

```sh
cd package/luci-app-starlink/src
go build ./cmd/starlink-dish
```

## License

`luci-app-starlink` is licensed as `GPL-3.0-or-later`.
