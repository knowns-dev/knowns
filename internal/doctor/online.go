package doctor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/util"
)

const (
	defaultVersionEndpoint = "https://registry.npmjs.org/knowns/latest"
	onlineCheckTimeout     = 3 * time.Second
	// ollamaProbeTimeout bounds the /api/tags round trip specifically (NFR-5,
	// AC-20): well inside the runner's 2s default per-check budget
	// (runner.go's defaultCheckTimeout), so a socket that accepts the
	// connection and never answers still yields a real OllamaNotRunning
	// result instead of falling through to the runner's own
	// checker_timeout — the failure mode searchModelChecker shipped once
	// via services.DetectAllReadOnly's ~40s LSP probe. This bound is applied
	// via the request context regardless of deps.client's own Timeout (2.5s
	// by default), so it holds even when a caller supplies a client with no
	// timeout at all.
	ollamaProbeTimeout = 1 * time.Second
)

type httpDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type providerTarget struct {
	ID      string
	Kind    string
	Model   string
	APIBase string
	APIKey  string
}

type onlineDependencies struct {
	client       httpDoer
	versionURL   string
	loadProvider func(*storage.Store) (providerTarget, bool, error)
	// lookPath detects the Ollama binary on PATH, the FR-10 signal that
	// distinguishes OllamaNotInstalled from the other three states before
	// any network probe runs — mirrors localDependencies.lookPath in
	// local.go, kept separate because this file's dependency struct is
	// independently constructible in tests that never touch localState.
	lookPath func(string) (string, error)
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
		lookPath:     exec.LookPath,
	}
}

// NetworkCheckers returns diagnostics that probe a network endpoint. They run
// in every doctor invocation: the configured embedding provider is part of the
// project setup a user asks doctor about, so its reachability must not depend
// on an opt-in flag. Every probe is bounded and reports an unreachable network
// as a warning so offline and air-gapped runs stay usable.
func NetworkCheckers(store *storage.Store) []Checker {
	return networkCheckersWithDependencies(store, onlineDependencies{})
}

func networkCheckersWithDependencies(store *storage.Store, deps onlineDependencies) []Checker {
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
	if deps.lookPath == nil {
		deps.lookPath = defaults.lookPath
	}
	return []Checker{
		providerEndpointChecker(store, deps),
		onlineVersionChecker(deps),
	}
}

func onlineVersionChecker(deps onlineDependencies) Checker {
	return Checker{
		ID:      "online.version",
		Scope:   ScopeOnline,
		Timeout: onlineCheckTimeout,
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

func providerEndpointChecker(store *storage.Store, deps onlineDependencies) Checker {
	return Checker{
		ID:      "search.provider-endpoint",
		Scope:   ScopeSearch,
		Timeout: 2 * onlineCheckTimeout,
		Check: func(ctx context.Context) (CheckResult, error) {
			target, configured, err := deps.loadProvider(store)
			if err != nil {
				return CheckResult{
					Status:  StatusWarn,
					Summary: "Configured embedding provider settings are incomplete",
					Evidence: Evidence{
						"configured": true,
						"errorCode":  "provider_settings_incomplete",
					},
					Remediation: &Remediation{
						Description: "Register the configured embedding model and provider in Knowns settings.",
						Command:     "knowns settings",
					},
				}, nil
			}
			if !configured {
				return CheckResult{
					Status:     StatusSkip,
					Summary:    "No external embedding provider is configured",
					SkipReason: "not_configured",
				}, nil
			}

			base, err := url.Parse(strings.TrimSpace(target.APIBase))
			if err != nil || base.Host == "" ||
				(base.Scheme != "http" && base.Scheme != "https") || base.User != nil {
				return providerWarning(
					target.ID,
					"Configured embedding provider URL is invalid",
					"provider_url_invalid",
					0,
				), nil
			}
			if target.Kind == "ollama" {
				return ollamaEndpointResult(ctx, deps, target, base), nil
			}

			endpoint, err := providerProbeURL(target.APIBase)
			if err != nil {
				return providerWarning(
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
				// An unreachable network is an environment condition, not a
				// broken project, so it must never fail a default doctor run.
				return providerWarning(
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
				return providerWarning(
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
						"provider":   target.Kind,
						"reachable":  true,
						"statusCode": resp.StatusCode,
					},
				}, nil
			}
		},
	}
}

// ollamaEndpointResult probes the Ollama tag listing instead of an embeddings
// path: it is the only endpoint that answers both questions doctor cares about
// for this provider — is the daemon serving, and is the configured model
// pulled. It distinguishes all four FR-10 states — OllamaNotInstalled,
// OllamaNotRunning, OllamaModelMissing, OllamaReady — and every non-ready
// result's Remediation resolves from storage.OllamaStateGuidance (AC-7/D6)
// rather than restating install/pull instructions locally.
func ollamaEndpointResult(
	ctx context.Context,
	deps onlineDependencies,
	target providerTarget,
	base *url.URL,
) CheckResult {
	lookPath := deps.lookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	if _, err := lookPath("ollama"); err != nil {
		// No network call: the binary isn't on PATH, so probing the
		// endpoint would only spend the NFR-5 budget confirming what
		// lookPath already answered for free.
		return ollamaGuidanceResult(StatusWarn, storage.OllamaNotInstalled, target, Evidence{
			"provider":  "ollama",
			"model":     target.Model,
			"installed": false,
		})
	}

	// Bounded well inside the runner's 2s default (NFR-5/AC-20): this must
	// hold even when the socket accepts the connection and never answers,
	// independent of whatever Timeout deps.client itself carries.
	probeCtx, cancel := context.WithTimeout(ctx, ollamaProbeTimeout)
	defer cancel()

	endpoint := (&url.URL{Scheme: base.Scheme, Host: base.Host, Path: "/api/tags"}).String()
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return providerFailure(
			target.ID,
			"Configured embedding provider request is invalid",
			"provider_request_invalid",
			0,
		)
	}
	resp, err := deps.client.Do(req)
	if err != nil {
		return ollamaGuidanceResult(StatusWarn, storage.OllamaNotRunning, target, Evidence{
			"provider":  "ollama",
			"model":     target.Model,
			"installed": true,
			"reachable": false,
			"errorCode": networkErrorCode(probeCtx, err),
		})
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return providerWarning(
			target.ID,
			"Ollama returned an unexpected response",
			"provider_unexpected_status",
			resp.StatusCode,
		)
	}
	var tags search.OllamaTagsResponse
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 1<<20))
	if err := decoder.Decode(&tags); err != nil {
		return providerWarning(
			target.ID,
			"Ollama returned an invalid model listing",
			"provider_invalid_response",
			resp.StatusCode,
		)
	}
	for _, model := range tags.Models {
		if ollamaModelMatches(model.Name, target.Model) {
			guidance := storage.OllamaStateGuidance(storage.OllamaReady, target.Model)
			return CheckResult{
				Status:  StatusPass,
				Summary: guidance.Description,
				Evidence: Evidence{
					"provider":  "ollama",
					"model":     target.Model,
					"pulled":    true,
					"reachable": true,
				},
			}
		}
	}
	return ollamaGuidanceResult(StatusWarn, storage.OllamaModelMissing, target, Evidence{
		"provider":  "ollama",
		"model":     target.Model,
		"pulled":    false,
		"reachable": true,
	})
}

// ollamaGuidanceResult builds a CheckResult for a non-ready FR-10 Ollama
// state, rendering both the Summary and the Remediation from
// storage.OllamaStateGuidance so the text — including the keyword-search-
// still-works reassurance (AC-14) — can never drift from what setup and
// init show for the same state (AC-15).
func ollamaGuidanceResult(status Status, state storage.OllamaState, target providerTarget, evidence Evidence) CheckResult {
	guidance := storage.OllamaStateGuidance(state, target.Model)
	return CheckResult{
		Status:   status,
		Summary:  ollamaStateSummary(state),
		Evidence: evidence,
		Remediation: &Remediation{
			Description: guidance.Description,
			Command:     guidance.Command,
		},
	}
}

func ollamaStateSummary(state storage.OllamaState) string {
	switch state {
	case storage.OllamaNotInstalled:
		return "Ollama is not installed"
	case storage.OllamaNotRunning:
		return "Ollama is not serving the configured endpoint"
	case storage.OllamaModelMissing:
		return "Configured Ollama model is not pulled"
	default:
		return "Ollama state could not be determined"
	}
}

// ollamaModelMatches compares a served tag with the configured model, treating
// an omitted tag as Ollama does: "nomic-embed-text" serves "nomic-embed-text:latest".
func ollamaModelMatches(served, configured string) bool {
	served = strings.TrimSpace(strings.ToLower(served))
	configured = strings.TrimSpace(strings.ToLower(configured))
	if served == "" || configured == "" {
		return false
	}
	return canonicalOllamaTag(served) == canonicalOllamaTag(configured)
}

func canonicalOllamaTag(name string) string {
	if strings.Contains(name, ":") {
		return strings.TrimSuffix(name, ":latest")
	}
	return name
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
		Kind:    semantic.Provider,
		Model:   model.Model,
		APIBase: provider.WithDefaults().APIBase,
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
