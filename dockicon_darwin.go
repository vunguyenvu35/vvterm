//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

// setDockIcon makes the running app wear the given PNG in the Dock and the app switcher. macOS keeps an
// icon cache per app bundle that survives a rebuild (so a changed logo can show up weeks late), and a
// binary started outside a bundle has none: setting it from the app itself is right in every case.
static void setDockIcon(const void *bytes, int length) {
    NSData *data = [NSData dataWithBytes:bytes length:length];
    NSImage *image = [[NSImage alloc] initWithData:data];
    if (image == nil) return;
    dispatch_async(dispatch_get_main_queue(), ^{ [NSApp setApplicationIconImage:image]; });
}

// hideFromDock keeps a helper process (the Settings window, a terminal window) out of the Dock and the app
// switcher: it is a window of VVTerm, not a second app. The window stays and is brought to the front.
static void hideFromDock(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [NSApp activateIgnoringOtherApps:YES];
    });
}

// hideFromDockOnLaunch makes this process a Dock-less app from its very first moment. Wails asks for a regular
// app (a Dock icon) while it launches, and hiding the icon afterwards only shows it for a moment before it
// goes away again. So the app starts as an accessory and any later request to become a regular app is
// answered with "accessory" instead: the icon is never drawn. Call it before wails.Run.
static NSInteger (*origSetPolicy)(id, SEL, NSApplicationActivationPolicy);
static void hideFromDockOnLaunch(void) {
    Method m = class_getInstanceMethod([NSApplication class], @selector(setActivationPolicy:));
    origSetPolicy = (NSInteger (*)(id, SEL, NSApplicationActivationPolicy))method_getImplementation(m);
    method_setImplementation(m, imp_implementationWithBlock(^BOOL(id self, NSApplicationActivationPolicy p) {
        return origSetPolicy(self, @selector(setActivationPolicy:), NSApplicationActivationPolicyAccessory);
    }));
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    // an accessory app is not brought to the front by itself
    [[NSNotificationCenter defaultCenter] addObserverForName:NSApplicationDidFinishLaunchingNotification object:nil queue:nil
        usingBlock:^(NSNotification *n) { [NSApp activateIgnoringOtherApps:YES]; }];
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

// hideFromDock is for the processes that only show one more window of the app.
func hideFromDock() { C.hideFromDock() }

// hideFromDockOnLaunch must be called before wails.Run.
func hideFromDockOnLaunch() { C.hideFromDockOnLaunch() }
