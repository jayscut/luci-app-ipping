# SPDX-License-Identifier: MIT
#
# Copyright (C) 2026 luci-app-ipping contributors
#
# Builds with the standard OpenWrt buildroot: the packaging format follows
# the buildroot version automatically (23.05 and older produce .ipk,
# 24.10 and newer produce .apk).

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-ipping
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_LICENSE:=MIT
PKG_MAINTAINER:=luci-app-ipping contributors

LUCI_TITLE:=IP Ping Monitor - periodic ping latency collection with graphs
LUCI_DESCRIPTION:=Periodically pings multiple targets and stores per-minute and \
 hourly latency/loss data in a compact architecture-independent binary format \
 (timestamps are implied by file name and record offset, ~166 KiB per target \
 per year). Minute data retention defaults to 7 days, hourly data (averaged \
 from minute data) to 365 days, both configurable. Storage directory is \
 configurable (tmpfs or persistent). Data is displayed as SVG charts in LuCI.
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

# Works in-tree (feeds/luci/applications/) and out-of-tree (any package dir,
# as long as the LuCI feed is installed in the buildroot).
LUCI_MK:=$(firstword $(wildcard \
	$(CURDIR)/../../luci.mk \
	$(TOPDIR)/feeds/luci/luci.mk))

ifeq ($(LUCI_MK),)
$(error luci.mk not found - place this directory under feeds/luci/applications/ or run scripts/feeds update -a first)
endif

include $(LUCI_MK)

# call BuildPackage - OpenWrt buildroot signature
