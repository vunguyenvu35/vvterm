//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// setDockIcon makes the running app wear the given PNG in the Dock and the app switcher. macOS keeps an
// icon cache per app bundle that survives a rebuild (so a changed logo can show up weeks late), and a
// binary started outside a bundle has none: setting it from the app itself is right in every case.
static void setDockIcon(const void *bytes, int length) {
    NSData *data = [NSData dataWithBytes:bytes length:length];
    NSImage *image = [[NSImage alloc] initWithData:data];
    if (image == nil) return;
    dispatch_async(dispatch_get_main_queue(), ^{ [NSApp setApplicationIconImage:image]; });
}
*/
import "C"

import "unsafe"

func setDockIcon(png []byte) {
	if len(png) == 0 {
		return
	}
	C.setDockIcon(unsafe.Pointer(&png[0]), C.int(len(png)))
}
