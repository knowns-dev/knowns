package doctor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/util"
)

const (
	defaultVersionEndpoint = "https://registry.npmjs.org/knowns/latest"
	onlineCheckTimeout     = 3 * time.Second
)

type httpDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type providerTarget struct {
	ID      string
	APIBase string
	APIKey  string
}

type onlineDependencies struct {
	client       httpDoer
	versionURL   string
	loadProvider func(*storage.Store) (providerTarget, bool, error)
}

func defaultOnlineDependencies() onlineDependencies {
	return onlineDependencies{
		client: &http.Client{
			Timeout: 2500 * time.Millisecond,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		versionURL:   defaultVersionEndpoint,
		loadProvider: loadConfiguredProvider,
	}
}

// OnlineCheckers returns external diagnostics. The checkers are always
// registered so offline runs can return explicit online_disabled skips, but
// their bodies are never invoked unless RunOptions.Online is true.
func OnlineCheckers(store *storage.Store) []Checker {
	return onlineCheckersWithDependencies(store, onlineDependencies{})
}

func onlineCheckersWithDependencies(store *storage.Store, deps onlineDependencies) []Checker {
	defaults := defaultOnlineDependencies()
	if deps.client == nil {
		deps.client = defaults.client
	}
	if deps.versionURL == "" {
		deps.versionURL = defaults.versionURL
	}
	if deps.loadProvider == nil {
		deps.loadProvider = defaults.loadProvider
	}
	return []Checker{
		onlineProviderChecker(store, deps),
		onlineVersionChecker(deps),
	}
}

func onlineVersionChecker(deps onlineDependencies) Checker {
	return Checker{
		ID:             "online.version",
		Scope:          ScopeOnline,
		Timeout:        onlineCheckTimeout,
		RequiresOnline: true,
		Check: func(ctx context.Context) (CheckResult, error) {
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, deps.versionURL, nil)
			if err != nil {
				return onlineWarning(
					"Version service could not be queried",
					"version_request_invalid",
					"Run `knowns update` directly to check for an available release.",
					"knowns update",
				), nil
			}
			req.Header.Set("Accept", "application/json")
			resp, err := deps.client.Do(req)
			if err != nil {
				return onlineWarning(
					"Version service is unreachable",
					networkErrorCode(ctx, err),
					"Retry the online diagnostic or run `knowns update` directly.",
					"knowns update",
				), nil
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				result := onlineWarning(
					"Version service returned an unexpected response",
					"version_unexpected_status",
					"Retry the online diagnostic or run `knowns update` directly.",
					"knowns update",
				)
				result.Evidence["statusCode"] = resp.StatusCode
				return result, nil
			}

			var payload struct {
				Version string `json:"version"`
			}
			decoder := json.NewDecoder(io.LimitReader(resp.Body, 64*1024))
			if err := decoder.Decode(&payload); err != nil || strings.TrimSpace(payload.Version) == "" {
				return onlineWarning(
					"Version service returned an invalid response",
					"version_invalid_response",
					"Run `knowns update` directly to check for an available release.",
					"knowns update",
				), nil
			}
			latest := strings.TrimSpace(payload.Version)
			if len(latest) > 64 || !safeVersionPattern.MatchString(latest) {
				return onlineWarning(
					"Version service returned an invalid response",
					"version_invalid_response",
					"Run `knowns update` directly to check for an available release.",
					"knowns update",
				), nil
			}
			evidence := Evidence{
				"currentVersion": util.Version,
				"latestVersion":  latest,
			}
			if util.CompareVersions(latest, util.Version) > 0 {
				return CheckResult{
					Status:   StatusWarn,
					Summary:  "A newer Knowns version is available",
					Evidence: evidence,
					Remediation: &Remediation{
						Description: "Update Knowns to the latest available version.",
						Command:     "knowns update",
					},
				}, nil
			}
			return CheckResult{
				Status:   StatusPass,
				Summary:  "Knowns is up to date",
				Evidence: evidence,
			}, nil
		},
	}
}

func onlineProviderChecker(store *storage.Store, deps onlineDependencies) Checker {
	return Checker{
		ID:             "online.provider",
		Scope:          ScopeOnline,
		Timeout:        onlineCheckTimeout,
		RequiresOnline: true,
		Check: func(ctx context.Context) (CheckResult, error) {
			target, configured, err := deps.loadProvider(store)
			if err != nil {
				return CheckResult{}, err
			}
			if !configured {
				return CheckResult{
					Status:     StatusSkip,
					Summary:    "No external embedding provider is configured",
					SkipReason: "not_configured",
				}, nil
			}

			endpoint, err := providerProbeURL(target.APIBase)
			if err != nil {
				return providerFailure(
					target.ID,
					"Configured embedding provider URL is invalid",
					"provider_url_invalid",
					0,
				), nil
			}
			req, err := http.NewRequestWithContext(ctx, http.MethodHead, endpoint, nil)
			if err != nil {
				return providerFailure(
					target.ID,
					"Configured embedding provider request is invalid",
					"provider_request_invalid",
					0,
				), nil
			}
			if target.APIKey != "" {
				req.Header.Set("Authorization", "Bearer "+target.APIKey)
			}
			resp, err := deps.client.Do(req)
			if err != nil {
				return providerFailure(
					target.ID,
					"Configured embedding provider is unreachable",
					networkErrorCode(ctx, err),
					0,
				), nil
			}
			defer resp.Body.Close()

			switch {
			case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
				return providerFailure(
					target.ID,
					"Configured embedding provider rejected authentication",
					"provider_auth_rejected",
					resp.StatusCode,
				), nil
			case resp.StatusCode == http.StatusRequestTimeout:
				return providerFailure(
					target.ID,
					"Configured embedding provider timed out",
					"provider_timeout",
					resp.StatusCode,
				), nil
			case resp.StatusCode == http.StatusTooManyRequests:
				return providerWarning(
					target.ID,
					"Configured embedding provider is rate limited",
					"provider_rate_limited",
					resp.StatusCode,
				), nil
			case resp.StatusCode == http.StatusNotFound:
				return providerFailure(
					target.ID,
					"Configured embedding provider endpoint is unavailable",
					"provider_endpoint_missing",
					resp.StatusCode,
				), nil
			case resp.StatusCode >= 500:
				return providerFailure(
					target.ID,
					"Configured embedding provider is unhealthy",
					"provider_server_error",
					resp.StatusCode,
				), nil
			case resp.StatusCode >= 300 && resp.StatusCode < 400:
				return providerWarning(
					target.ID,
					"Configured embedding provider requires a redirect",
					"provider_redirect",
					resp.StatusCode,
				), nil
			default:
				return CheckResult{
					Status:  StatusPass,
					Summary: "Configured embedding provider is reachable",
					Evidence: Evidence{
						"reachable":  true,
						"statusCode": resp.StatusCode,
					},
				}, nil
			}
		},
	}
}

func loadConfiguredProvider(store *storage.Store) (providerTarget, bool, error) {
	if store == nil {
		return providerTarget{}, false, nil
	}
	project, err := store.Config.Load()
	if err != nil {
		return providerTarget{}, false, err
	}
	semantic := project.Settings.SemanticSearch
	if semantic == nil || !semantic.Enabled ||
		(semantic.Provider != "api" && semantic.Provider != "ollama") {
		return providerTarget{}, false, nil
	}

	settings, err := storage.NewEmbeddingSettingsStore().Load()
	if err != nil {
		return providerTarget{}, false, err
	}
	model, err := settings.GetModel(semantic.Model)
	if err != nil {
		return providerTarget{}, false, err
	}
	provider, err := settings.GetProvider(model.Provider)
	if err != nil {
		return providerTarget{}, false, err
	}
	return providerTarget{
		ID:      model.Provider,
		APIBase: provider.APIBase,
		APIKey:  provider.APIKey,
	}, true, nil
}

func providerProbeURL(apiBase string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(apiBase))
	if err != nil || parsed.Host == "" ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.User != nil {
		return "", fmt.Errorf("invalid provider URL")
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/embeddings"
	return parsed.String(), nil
}

func networkErrorCode(ctx context.Context, err error) string {
	if ctx.Err() == context.DeadlineExceeded || errors.Is(err, context.DeadlineExceeded) {
		return "network_timeout"
	}
	if ctx.Err() == context.Canceled || errors.Is(err, context.Canceled) {
		return "network_canceled"
	}
	return "network_request_failed"
}

func onlineWarning(summary, code, description, command string) CheckResult {
	return CheckResult{
		Status:  StatusWarn,
		Summary: summary,
		Evidence: Evidence{
			"errorCode": code,
		},
		Remediation: &Remediation{
			Description: description,
			Command:     command,
		},
	}
}

func providerFailure(id, summary, code string, statusCode int) CheckResult {
	result := CheckResult{
		Status:  StatusFail,
		Summary: summary,
		Evidence: Evidence{
			"configured": true,
			"errorCode":  code,
			"reachable":  false,
		},
		Remediation: providerRemediation(id),
	}
	if statusCode > 0 {
		result.Evidence["statusCode"] = statusCode
		result.Evidence["reachable"] = true
	}
	return result
}

func providerWarning(id, summary, code string, statusCode int) CheckResult {
	result := providerFailure(id, summary, code, statusCode)
	result.Status = StatusWarn
	return result
}

var (
	safeProviderIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	sensitiveIDPattern    = regexp.MustCompile(`(?i)(secret|token|password|credential|bearer|api[_-]?key|sk[_-])`)
	safeVersionPattern    = regexp.MustCompile(`^v?[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$`)
)

func providerRemediation(id string) *Remediation {
	remediation := &Remediation{
		Description: "Verify the configured embedding provider and its credentials.",
	}
	if safeProviderIDPattern.MatchString(id) && !sensitiveIDPattern.MatchString(id) {
		remediation.Command = "knowns provider test " + id
	}
	return remediation
}
