//go:build !darwin

package main

// setDockIcon is only needed on macOS.
func setDockIcon([]byte) {}

// slimFullScreenBar is only needed on macOS.
func slimFullScreenBar() {}

// hideFromDock is only needed on macOS.
func hideFromDock() {}

// raiseProcess is only needed on macOS.
func raiseProcess(int) bool { return true }

// hideFromDockOnLaunch is only needed on macOS.
func hideFromDockOnLaunch() {}
