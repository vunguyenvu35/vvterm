//go:build darwin

package vault

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework LocalAuthentication -framework Foundation
#import <LocalAuthentication/LocalAuthentication.h>
#include <stdlib.h>

// canAuth: 1 when this Mac can ask for Touch ID, Apple Watch or the account password.
static int canAuth(void) {
    LAContext *c = [[LAContext alloc] init];
    return [c canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:nil] ? 1 : 0;
}

// authenticate shows the system sheet and waits for the answer. 0: ok, 1: cancelled, 2: failed (msg is set).
static int authenticate(const char *reason, char *msg, int msgLen) {
    LAContext *c = [[LAContext alloc] init];
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block int result = 2;
    [c evaluatePolicy:LAPolicyDeviceOwnerAuthentication
      localizedReason:[NSString stringWithUTF8String:reason]
                reply:^(BOOL ok, NSError *err) {
        if (ok) result = 0;
        else {
            result = (err.code == LAErrorUserCancel || err.code == LAErrorSystemCancel || err.code == LAErrorAppCancel) ? 1 : 2;
            snprintf(msg, msgLen, "%s", err.localizedDescription.UTF8String ?: "authentication failed");
        }
        dispatch_semaphore_signal(sem);
    }];
    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
    return result;
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

// BiometricAvailable reports whether this Mac can ask for Touch ID (or the Apple Watch / login password).
func BiometricAvailable() bool { return C.canAuth() == 1 }

// BiometricAuth shows the macOS Touch ID sheet; reason completes "VVTerm is trying to …".
func BiometricAuth(reason string) error {
	r := C.CString(reason)
	defer C.free(unsafe.Pointer(r))
	buf := (*C.char)(C.malloc(256))
	defer C.free(unsafe.Pointer(buf))
	switch C.authenticate(r, buf, 256) {
	case 0:
		return nil
	case 1:
		return errors.New("authentication cancelled")
	default:
		return errors.New(C.GoString(buf))
	}
}
