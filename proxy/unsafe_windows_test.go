//go:build windows

package main

import "unsafe"

func unsafePtr(p *uint32) unsafe.Pointer { return unsafe.Pointer(p) }
