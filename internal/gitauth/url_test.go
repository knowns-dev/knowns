package gitauth

import (
	"net/url"
	"testing"
)

func TestInjectHTTPSCredentialRequiresExactTrustedHost(t *testing.T) {
	const token = "top-secret"
	for _, tc := range []struct {
		name       string
		source     string
		allowed    string
		wantInject bool
	}{
		{name: "exact host", source: "https://github.com/knowns-dev/knowns.git", allowed: "github.com", wantInject: true},
		{name: "configured host URL", source: "https://git.example/repo.git", allowed: "https://git.example", wantInject: true},
		{name: "host suffix spoof", source: "https://github.com.attacker.example/repo.git", allowed: "github.com"},
		{name: "different host", source: "https://attacker.example/repo.git", allowed: "github.com"},
		{name: "plaintext", source: "http://github.com/repo.git", allowed: "github.com"},
		{name: "existing credentials", source: "https://user:pass@github.com/repo.git", allowed: "github.com"},
		{name: "no allowed host", source: "https://github.com/repo.git"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := InjectHTTPSCredential(tc.source, token, tc.allowed)
			u, err := url.Parse(got)
			if err != nil {
				t.Fatal(err)
			}
			password, hasPassword := u.User.Password()
			injected := hasPassword && password == token
			if tc.wantInject != injected {
				t.Fatalf("credential injected = %v, want %v: %s", injected, tc.wantInject, got)
			}
			if !tc.wantInject && got != tc.source {
				t.Fatalf("untrusted URL changed: got %q want %q", got, tc.source)
			}
		})
	}
}
