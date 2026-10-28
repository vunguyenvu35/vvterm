//go:build !darwin

package main

// setDockIcon is only needed on macOS.
func setDockIcon([]byte) {}
