//go:build !darwin

package main

// setDockIcon is only needed on macOS.
func setDockIcon([]byte) {}

// hideFromDock is only needed on macOS.
func hideFromDock() {}

// hideFromDockOnLaunch is only needed on macOS.
func hideFromDockOnLaunch() {}
