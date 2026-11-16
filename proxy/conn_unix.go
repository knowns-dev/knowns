//go:build !windows

package main

import (
	"errors"
	"io"
	"net"
	"os"
	"syscall"
	"time"
)

func dial(kind, addr string, _ int) (io.ReadWriteCloser, error) {
	if kind != "unix_socket" {
		return nil, errors.New("unsupported endpoint kind " + kind)
	}
	return net.DialTimeout("unix", addr, 2*time.Second)
}

func daemonFiles() ([]*os.File, func()) {
	in, _ := os.Open(os.DevNull)
	out, _ := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	return []*os.File{in, out, out}, func() {
		if in != nil {
			in.Close()
		}
		if out != nil {
			out.Close()
		}
	}
}

func daemonAttr(bool) *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }
func childAttr() *syscall.SysProcAttr      { return nil }
