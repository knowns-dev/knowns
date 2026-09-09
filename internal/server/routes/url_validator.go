package routes

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// isDisallowedIP reports whether ip belongs to a private, loopback, link-local,
// multicast, unspecified, or cloud metadata network range.
func isDisallowedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}

	// Standard Go IP classifications.
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return true
	}

	// Ensure IPv4-mapped IPv6 addresses are checked in their IPv4 form.
	if ip4 := ip.To4(); ip4 != nil {
		// 100.64.0.0/10 — Carrier-Grade NAT (RFC 6598)
		if ip4[0] == 100 && (ip4[1]&0xc0) == 64 {
			return true
		}
		// 169.254.0.0/16 — Link-Local / Cloud Metadata (AWS/GCP/Azure)
		if ip4[0] == 169 && ip4[1] == 254 {
			return true
		}
		// 127.0.0.0/8 — Loopback
		if ip4[0] == 127 {
			return true
		}
		// 0.0.0.0/8 — Current network
		if ip4[0] == 0 {
			return true
		}
	}

	return false
}

// isDisallowedHost reports whether host names a prohibited target such as
// localhost, internal domains, or cloud metadata endpoints.
func isDisallowedHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	// Strip port if present
	if strings.Contains(h, ":") {
		if parsedHost, _, err := net.SplitHostPort(h); err == nil {
			h = parsedHost
		}
	}
	h = strings.Trim(h, "[]")

	if h == "" || h == "localhost" || strings.HasSuffix(h, ".localhost") ||
		h == "metadata.google.internal" || strings.HasSuffix(h, ".google.internal") ||
		h == "instance-data" || strings.HasSuffix(h, ".internal") || strings.HasSuffix(h, ".local") {
		return true
	}

	// If hostname is directly an IP address, check it immediately.
	if parsedIP := net.ParseIP(h); parsedIP != nil {
		return isDisallowedIP(parsedIP)
	}

	// Resolve hostname via DNS to prevent DNS rebinding / host spoofing.
	ips, err := net.LookupIP(h)
	if err != nil || len(ips) == 0 {
		// If DNS resolution fails, reject to prevent blind SSRF.
		return true
	}

	for _, ip := range ips {
		if isDisallowedIP(ip) {
			return true
		}
	}

	return false
}

// validateExternalURL validates that rawURL uses http/https and targets an
// allowed public host, preventing SSRF attacks against internal networks or
// cloud instance metadata services.
func validateExternalURL(rawURL string) error {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}

	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return fmt.Errorf("unsupported URL scheme %q: only http and https are allowed", u.Scheme)
	}

	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("URL host is required")
	}

	if isDisallowedHost(host) {
		return fmt.Errorf("destination host or IP address is not allowed")
	}

	return nil
}

// validateGitSource verifies that a git remote source URL does not point to
// private, loopback, or cloud metadata endpoints, and avoids dangerous git
// option or protocol injection (e.g. ext::, file://, fd::).
func validateGitSource(source string) error {
	s := strings.TrimSpace(source)
	if s == "" {
		return fmt.Errorf("git source is required")
	}

	// Prevent command injection or git argument injection via leading dashes.
	if strings.HasPrefix(s, "-") {
		return fmt.Errorf("git source must not start with a dash")
	}

	lower := strings.ToLower(s)

	// Block dangerous git protocol transports.
	if strings.HasPrefix(lower, "ext::") || strings.HasPrefix(lower, "fd::") || strings.HasPrefix(lower, "file://") {
		return fmt.Errorf("git transport protocol is not allowed")
	}

	// SCP-style SSH URL: git@host:owner/repo.git
	if strings.HasPrefix(lower, "git@") || (strings.Contains(s, "@") && strings.Contains(s, ":") && !strings.Contains(s, "://")) {
		parts := strings.SplitN(s, "@", 2)
		if len(parts) != 2 {
			return fmt.Errorf("invalid git SSH source format")
		}
		hostAndPath := parts[1]
		colonIdx := strings.Index(hostAndPath, ":")
		if colonIdx == -1 {
			return fmt.Errorf("invalid git SSH source format: missing colon")
		}
		host := hostAndPath[:colonIdx]
		if isDisallowedHost(host) {
			return fmt.Errorf("git SSH host is not allowed")
		}
		return nil
	}

	// HTTP / HTTPS git clone URL
	u, err := url.Parse(s)
	if err != nil {
		return fmt.Errorf("invalid git URL: %w", err)
	}

	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("unsupported git URL scheme %q: only http, https, and git SSH are allowed", u.Scheme)
	}

	if isDisallowedHost(u.Hostname()) {
		return fmt.Errorf("git destination host or IP address is not allowed")
	}

	return nil
}
