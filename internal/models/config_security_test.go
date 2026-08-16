package models

import "testing"

func TestValidateOpenCodeServerRestrictsProjectConfigToLoopback(t *testing.T) {
	for _, tc := range []struct {
		name string
		cfg  *OpenCodeServerConfig
		ok   bool
	}{
		{name: "unset", cfg: nil, ok: true},
		{name: "default", cfg: &OpenCodeServerConfig{}, ok: true},
		{name: "localhost external", cfg: &OpenCodeServerConfig{Mode: "external", Host: "localhost", Port: 4096}, ok: true},
		{name: "IPv4 loopback", cfg: &OpenCodeServerConfig{Host: "127.0.0.1", Port: 4096}, ok: true},
		{name: "IPv6 loopback", cfg: &OpenCodeServerConfig{Host: "::1", Port: 4096}, ok: true},
		{name: "private network", cfg: &OpenCodeServerConfig{Host: "192.168.1.10", Port: 4096}},
		{name: "metadata", cfg: &OpenCodeServerConfig{Host: "169.254.169.254", Port: 80}},
		{name: "public hostname", cfg: &OpenCodeServerConfig{Host: "attacker.example", Port: 443}},
		{name: "invalid mode", cfg: &OpenCodeServerConfig{Mode: "proxy", Host: "127.0.0.1", Port: 4096}},
		{name: "invalid port", cfg: &OpenCodeServerConfig{Host: "127.0.0.1", Port: 70000}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := (ProjectSettings{OpenCodeServerConfig: tc.cfg}).ValidateOpenCodeServer()
			if tc.ok && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}
