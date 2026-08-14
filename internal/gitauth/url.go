// Package gitauth applies Git HTTP credentials only to an explicitly trusted host.
package gitauth

import (
	"net"
	"net/url"
	"strings"
)

// InjectHTTPSCredential adds a token to an HTTPS URL only when its hostname
// exactly matches allowedHost. It never forwards credentials over plaintext
// HTTP or replaces credentials already present in the URL.
func InjectHTTPSCredential(source, token, allowedHost string) string {
	if token == "" || strings.TrimSpace(allowedHost) == "" {
		return source
	}
	u, err := url.Parse(source)
	if err != nil || !strings.EqualFold(u.Scheme, "https") || u.Hostname() == "" || u.User != nil {
		return source
	}
	if !strings.EqualFold(u.Hostname(), normalizeHost(allowedHost)) {
		return source
	}
	u.User = url.UserPassword(TokenUsername(u.Hostname()), token)
	return u.String()
}

// TokenUsername returns the conventional HTTP token username for a Git host.
func TokenUsername(host string) string {
	host = strings.ToLower(normalizeHost(host))
	switch {
	case host == "gitlab.com" || strings.HasSuffix(host, ".gitlab.com"):
		return "oauth2"
	case host == "bitbucket.org" || strings.HasSuffix(host, ".bitbucket.org"):
		return "x-token-auth"
	default:
		return "x-access-token"
	}
}

func normalizeHost(host string) string {
	host = strings.TrimSpace(host)
	if u, err := url.Parse(host); err == nil && u.Hostname() != "" {
		return strings.Trim(u.Hostname(), "[]")
	}
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	}
	return strings.Trim(host, "[]")
}
