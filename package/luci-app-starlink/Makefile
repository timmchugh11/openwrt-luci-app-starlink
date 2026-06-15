include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-starlink
PKG_VERSION:=0.1.0
PKG_RELEASE:=3

PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)
PKG_BUILD_DEPENDS:=golang/host
PKG_BUILD_PARALLEL:=1
PKG_BUILD_FLAGS:=no-mips16
PKG_LICENSE:=GPL-3.0-or-later

GO_PKG:=github.com/timmc/openwrt-luci-app-starlink
GO_PKG_BUILD_PKG:=github.com/timmc/openwrt-luci-app-starlink/cmd/starlink-dish
GO_PKG_LDFLAGS_X:=main.version=$(PKG_VERSION)

include $(INCLUDE_DIR)/package.mk
include $(TOPDIR)/feeds/packages/lang/golang/golang-package.mk

define Package/luci-app-starlink
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=LuCI support for Starlink dish telemetry
  DEPENDS:=$(GO_ARCH_DEPENDS) +rpcd +luci-base
endef

define Package/luci-app-starlink/description
  LuCI application and rpcd bridge for reading local Starlink dish telemetry.
endef

define Build/Prepare
	$(INSTALL_DIR) $(PKG_BUILD_DIR)
	$(CP) ./src/* $(PKG_BUILD_DIR)/
endef

define Package/luci-app-starlink/install
	$(call GoPackage/Package/Install/Bin,$(1))
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/etc/config/starlink $(1)/etc/config/starlink
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/etc/uci-defaults/90-luci-app-starlink $(1)/etc/uci-defaults/90-luci-app-starlink
	$(INSTALL_DIR) $(1)/usr/libexec/rpcd
	$(INSTALL_BIN) ./files/usr/libexec/rpcd/starlink.dish $(1)/usr/libexec/rpcd/starlink.dish
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./files/usr/share/luci/menu.d/luci-app-starlink.json $(1)/usr/share/luci/menu.d/luci-app-starlink.json
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/usr/share/rpcd/acl.d/luci-app-starlink.json $(1)/usr/share/rpcd/acl.d/luci-app-starlink.json
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/starlink
	$(INSTALL_DATA) ./files/www/luci-static/resources/view/starlink/status.js $(1)/www/luci-static/resources/view/starlink/status.js
	$(INSTALL_DATA) ./files/www/luci-static/resources/view/starlink/settings.js $(1)/www/luci-static/resources/view/starlink/settings.js
endef

$(eval $(call GoBinPackage,luci-app-starlink))
$(eval $(call BuildPackage,luci-app-starlink))
