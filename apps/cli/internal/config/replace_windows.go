//go:build windows

package config

import (
	"errors"
	"os"
	"syscall"
	"unsafe"
)

var replaceFileW = syscall.NewLazyDLL("kernel32.dll").NewProc("ReplaceFileW")

func replaceFile(source, destination string) error {
	if _, err := os.Lstat(destination); errors.Is(err, os.ErrNotExist) {
		return os.Rename(source, destination)
	} else if err != nil {
		return err
	}

	destinationName, err := syscall.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	replacementName, err := syscall.UTF16PtrFromString(source)
	if err != nil {
		return err
	}

	success, _, callErr := replaceFileW.Call(
		uintptr(unsafe.Pointer(destinationName)),
		uintptr(unsafe.Pointer(replacementName)),
		0,
		0,
		0,
		0,
	)
	if success == 0 {
		return callErr
	}
	return nil
}
