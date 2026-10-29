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
static void activateSelf(void) {
    if (@available(macOS 14.0, *)) {
        [NSApp activate]; // activateIgnoringOtherApps does nothing since macOS 14
    } else {
        [NSApp activateIgnoringOtherApps:YES];
    }
}

static void hideFromDock(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        activateSelf();
        NSWindow *w = [NSApp keyWindow] ?: [[NSApp windows] firstObject];
        [w makeKeyAndOrderFront:nil];
    });
}

// raiseProcess brings the window of another process of this app (the Settings window) in front of this one.
// Since macOS 14 an app cannot take the front by itself while another app is in front: the app that is in front
// has to hand it over, which is what activateFromApplication does. Returns 0 when that process is not a GUI
// app yet (it registers a moment after it starts), so the caller may ask again.
static int raiseProcess(int pid) {
    __block int ok = 0;
    void (^work)(void) = ^{
        NSRunningApplication *target = [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)pid];
        if (target == nil) return;
        if (@available(macOS 14.0, *)) {
            ok = [target activateFromApplication:[NSRunningApplication currentApplication] options:NSApplicationActivateAllWindows] ? 1 : 0;
        } else {
            ok = [target activateWithOptions:NSApplicationActivateAllWindows | (1 << 1) /* ignoring other apps: the only way before macOS 14 */] ? 1 : 0;
        }
    };
    if ([NSThread isMainThread]) work(); else dispatch_sync(dispatch_get_main_queue(), work);
    return ok;
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
        usingBlock:^(NSNotification *n) { activateSelf(); }];
}

// slimFullScreenBar makes the bar macOS slides over the page in full screen low, with the app's name in it, like
// other Mac apps. Its height comes from the toolbar Wails adds to push the window buttons down in the normal
// window: the toolbar is taken off while the window is in full screen and put back when it leaves. Call it once,
// before wails.Run.
static NSToolbar *savedToolbar = nil;
static void slimFullScreenBar(void) {
    NSNotificationCenter *c = [NSNotificationCenter defaultCenter];
    [c addObserverForName:NSWindowWillEnterFullScreenNotification object:nil queue:nil usingBlock:^(NSNotification *n) {
        NSWindow *w = n.object;
        if (w.toolbar != nil) { savedToolbar = w.toolbar; w.toolbar = nil; }
        w.titleVisibility = NSWindowTitleVisible;
    }];
    [c addObserverForName:NSWindowDidExitFullScreenNotification object:nil queue:nil usingBlock:^(NSNotification *n) {
        NSWindow *w = n.object;
        w.titleVisibility = NSWindowTitleHidden;
        if (savedToolbar != nil) { w.toolbar = savedToolbar; savedToolbar = nil; }
    }];
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

// slimFullScreenBar: see the C function. Call it once, before wails.Run.
func slimFullScreenBar() { C.slimFullScreenBar() }

// hideFromDock is for the processes that only show one more window of the app.
func hideFromDock() { C.hideFromDock() }

// raiseProcess: see the C function.
func raiseProcess(pid int) bool { return C.raiseProcess(C.int(pid)) != 0 }

// hideFromDockOnLaunch must be called before wails.Run.
func hideFromDockOnLaunch() { C.hideFromDockOnLaunch() }
