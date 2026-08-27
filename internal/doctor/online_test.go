package doctor

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/storage"
)

type httpDoerFunc func(*http.Request) (*http.Response, error)

func (f httpDoerFunc) Do(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestProviderEndpointRunsWithoutAnOnlineFlag(t *testing.T) {
	var httpCalls atomic.Int32
	deps := onlineDependencies{
		client: httpDoerFunc(func(*http.Request) (*http.Response, error) {
			httpCalls.Add(1)
			return onlineResponse(http.StatusNoContent, ""), nil
		}),
		loadProvider: func(*storage.Store) (providerTarget, bool, error) {
			return providerTarget{
				ID:      "remote",
				Kind:    "api",
				Model:   "text-embedding-3-small",
				APIBase: "https://provider.example/v1",
			}, true, nil
		},
	}

	result, err := Run(context.Background(), RunOptions{
		Scopes: []Scope{ScopeSearch},
	}, networkCheckersWithDependencies(nil, deps))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if httpCalls.Load() != 1 {
		t.Fatalf("HTTP calls = %d, want 1", httpCalls.Load())
	}
	check := findCheck(t, result, "search.provider-endpoint")
	if check.Status != StatusPass || check.Evidence["reachable"] != true {
		t.Fatalf("provider endpoint check = %#v", check)
	}
}

func TestProviderEndpointWarnsWhenNetworkIsUnreachable(t *testing.T) {
	deps := onlineDependencies{
		client: httpDoerFunc(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("dial tcp: no route to host")
		}),
		loadProvider: func(*storage.Store) (providerTarget, bool, error) {
			return providerTarget{
				ID:      "remote",
				Kind:    "api",
				APIBase: "https://provider.example/v1",
			}, true, nil
		},
	}

	result, err := Run(context.Background(), RunOptions{
		Scopes: []Scope{ScopeSearch},
	}, []Checker{providerEndpointChecker(nil, deps)})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	check := findCheck(t, result, "search.provider-endpoint")
	if check.Status != StatusWarn || check.Evidence["errorCode"] != "network_request_failed" {
		t.Fatalf("unreachable provider check = %#v", check)
	}
	if result.Verdict != VerdictDegraded {
		t.Fatalf("verdict = %q, want degraded so air-gapped runs still exit 0", result.Verdict)
	}
}

func TestProviderEndpointWarnsWhenSettingsAreIncomplete(t *testing.T) {
	var httpCalls atomic.Int32
	deps := onlineDependencies{
		client: httpDoerFunc(func(*http.Request) (*http.Response, error) {
			httpCalls.Add(1)
			return onlineResponse(http.StatusOK, ""), nil
		}),
		loadProvider: func(*storage.Store) (providerTarget, bool, error) {
			return providerTarget{}, false, errors.New("model qwen3-embedding:0.6b not found")
		},
	}

	result, err := Run(context.Background(), RunOptions{
		Scopes: []Scope{ScopeSearch},
	}, []Checker{providerEndpointChecker(nil, deps)})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	check := findCheck(t, result, "search.provider-endpoint")
	if check.Status != StatusWarn || check.Evidence["errorCode"] != "provider_settings_incomplete" ||
		check.Remediation == nil || check.Remediation.Command != "knowns settings" {
		t.Fatalf("incomplete settings check = %#v", check)
	}
	if httpCalls.Load() != 0 {
		t.Fatalf("HTTP calls = %d, want 0", httpCalls.Load())
	}
}

func TestProviderEndpointRejectsInvalidURLWithoutProbing(t *testing.T) {
	var httpCalls atomic.Int32
	deps := onlineDependencies{
		client: httpDoerFunc(func(*http.Request) (*http.Response, error) {
			httpCalls.Add(1)
			return onlineResponse(http.StatusOK, ""), nil
		}),
		loadProvider: func(*storage.Store) (providerTarget, bool, error) {
			return providerTarget{ID: "remote", Kind: "api", APIBase: "not-a-url"}, true, nil
		},
	}

	result, err := Run(context.Background(), RunOptions{
		Scopes: []Scope{ScopeSearch},
	}, []Checker{providerEndpointChecker(nil, deps)})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	check := findCheck(t, result, "search.provider-endpoint")
	if check.Status != StatusWarn || check.Evidence["errorCode"] != "provider_url_invalid" {
		t.Fatalf("invalid URL check = %#v", check)
	}
	if httpCalls.Load() != 0 {
		t.Fatalf("HTTP calls = %d, want 0", httpCalls.Load())
	}
}

func TestOllamaEndpointReportsPulledAndMissingModels(t *testing.T) {
	tags := `{"models":[{"name":"nomic-embed-text:latest"},{"name":"qwen3-embedding:0.6b"}]}`
	cases := []struct {
		name       string
		model      string
		wantStatus Status
		wantPulled bool
		wantCmd    string
	}{
		{name: "exact tag", model: "qwen3-embedding:0.6b", wantStatus: StatusPass, wantPulled: true},
		{name: "implicit latest", model: "nomic-embed-text", wantStatus: StatusPass, wantPulled: true},
		{
			name:       "not pulled",
			model:      "mxbai-embed-large",
			wantStatus: StatusWarn,
			wantCmd:    "ollama pull mxbai-embed-large",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var probed string
			deps := onlineDependencies{
				client: httpDoerFunc(func(req *http.Request) (*http.Response, error) {
					probed = req.URL.String()
					return onlineResponse(http.StatusOK, tags), nil
				}),
				loadProvider: func(*storage.Store) (providerTarget, bool, error) {
					return providerTarget{
						ID:      "ollama",
						Kind:    "ollama",
						Model:   testCase.model,
						APIBase: "http://localhost:11434/v1",
					}, true, nil
				},
				// Deterministic regardless of whether this machine actually
				// has the ollama binary on PATH: these cases exercise the
				// "installed" branch specifically.
				lookPath: func(string) (string, error) { return "/usr/local/bin/ollama", nil },
			}

			result, err := Run(context.Background(), RunOptions{
				Scopes: []Scope{ScopeSearch},
			}, []Checker{providerEndpointChecker(nil, deps)})
			if err != nil {
				t.Fatalf("Run() error = %v", err)
			}
			if probed != "http://localhost:11434/api/tags" {
				t.Fatalf("probed URL = %q", probed)
			}
			check := findCheck(t, result, "search.provider-endpoint")
			if check.Status != testCase.wantStatus || check.Evidence["pulled"] != testCase.wantPulled {
				t.Fatalf("ollama check = %#v", check)
			}
			if testCase.wantCmd != "" &&
				(check.Remediation == nil || check.Remediation.Command != testCase.wantCmd) {
				t.Fatalf("ollama remediation = %#v", check.Remediation)
			}
		})
	}
}

func TestOllamaEndpointWarnsWhenDaemonIsNotServing(t *testing.T) {
	deps := onlineDependencies{
		client: httpDoerFunc(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("connection refused")
		}),
		loadProvider: func(*storage.Store) (providerTarget, bool, error) {
			return providerTarget{
				ID:      "ollama",
				Kind:    "ollama",
				Model:   "qwen3-embedding:0.6b",
				APIBase: "http://localhost:11434",
			}, true, nil
		},
		lookPath: func(string) (string, error) { return "/usr/local/bin/ollama", nil },
	}

	result, err := Run(context.Background(), RunOptions{
		Scopes: []Scope{ScopeSearch},
	}, []Checker{providerEndpointChecker(nil, deps)})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	// Remediation must resolve from storage.OllamaStateGuidance (AC-7), and
	// must say keyword search still works without Ollama (AC-14).
	wantGuidance := storage.OllamaStateGuidance(storage.OllamaNotRunning, "qwen3-embedding:0.6b")
	check := findCheck(t, result, "search.provider-endpoint")
	if check.Status != StatusWarn || check.Remediation == nil ||
		check.Remediation.Command != "ollama serve" ||
		check.Remediation.Description != wantGuidance.Description ||
		!strings.Contains(check.Remediation.Description, "Keyword search still works") {
		t.Fatalf("ollama daemon check = %#v", check)
	}
}

func TestOllamaEndpointReportsNotInstalledWithoutProbingNetwork(t *testing.T) {
	var httpCalls atomic.Int32
	deps := onlineDependencies{
		client: httpDoerFunc(func(*http.Request) (*http.Response, error) {
			httpCalls.Add(1)
			return onlineResponse(http.StatusOK, `{"models":[]}`), nil
		}),
		loadProvider: func(*storage.Store) (providerTarget, bool, error) {
			return providerTarget{
				ID:      "ollama",
				Kind:    "ollama",
				Model:   "qwen3-embedding:0.6b",
				APIBase: "http://localhost:11434",
			}, true, nil
		},
		lookPath: func(string) (string, error) { return "", errors.New("executable file not found in $PATH") },
	}

	result, err := Run(context.Background(), RunOptions{
		Scopes: []Scope{ScopeSearch},
	}, []Checker{providerEndpointChecker(nil, deps)})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	wantGuidance := storage.OllamaStateGuidance(storage.OllamaNotInstalled, "qwen3-embedding:0.6b")
	check := findCheck(t, result, "search.provider-endpoint")
	if check.Status != StatusWarn ||
		check.Evidence["installed"] != false ||
		check.Remediation == nil ||
		check.Remediation.Description != wantGuidance.Description ||
		!strings.Contains(check.Remediation.Description, "Keyword search still works") {
		t.Fatalf("ollama not-installed check = %#v", check)
	}
	if httpCalls.Load() != 0 {
		t.Fatalf("HTTP calls = %d, want 0 — not-installed must short-circuit before probing", httpCalls.Load())
	}
}

// TestOllamaEndpointProbeIsBoundedAgainstHangingConnection is the NFR-5/AC-20
// regression test: a real TCP listener that accepts the connection and never
// writes a response, the specific failure mode a refused connection cannot
// exercise (a refusal returns immediately and proves nothing about bounding).
// It uses a real *http.Client with no Timeout of its own, so the only thing
// that can possibly bound the request is ollamaProbeTimeout applied inside
// ollamaEndpointResult via the request context.
func TestOllamaEndpointProbeIsBoundedAgainstHangingConnection(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	defer listener.Close()

	release := make(chan struct{})
	defer close(release)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		// Accept the connection and hold it open without ever writing a
		// response — the case a refused connection cannot exercise.
		<-release
	}()

	deps := onlineDependencies{
		client: &http.Client{}, // deliberately no Timeout: only the probe's own bound may apply
		loadProvider: func(*storage.Store) (providerTarget, bool, error) {
			return providerTarget{
				ID:      "ollama",
				Kind:    "ollama",
				Model:   "qwen3-embedding:0.6b",
				APIBase: "http://" + listener.Addr().String(),
			}, true, nil
		},
		lookPath: func(string) (string, error) { return "/usr/local/bin/ollama", nil },
	}

	started := time.Now()
	result, err := Run(context.Background(), RunOptions{
		Scopes: []Scope{ScopeSearch},
	}, []Checker{providerEndpointChecker(nil, deps)})
	elapsed := time.Since(started)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	t.Logf("accept-and-hang probe returned in %s", elapsed)
	if elapsed >= 2*time.Second {
		t.Fatalf("probe took %s, want well under the 2s default check budget", elapsed)
	}

	check := findCheck(t, result, "search.provider-endpoint")
	// Must be a real, meaningful result (OllamaNotRunning), not the runner's
	// generic checker_timeout fallback — that fallback is exactly the
	// failure mode this test guards against (a check that reports a timeout
	// instead of its subject).
	if check.Status != StatusWarn ||
		check.Evidence["errorCode"] == "checker_timeout" ||
		check.Remediation == nil || check.Remediation.Command != "ollama serve" {
		t.Fatalf("accept-and-hang probe result = %#v", check)
	}
}

func TestOnlineChecksCompleteIndependently(t *testing.T) {
	const rawErrorSecret = "sk-online-error-secret"
	var httpCalls atomic.Int32
	deps := onlineDependencies{
		client: httpDoerFunc(func(req *http.Request) (*http.Response, error) {
			httpCalls.Add(1)
			if req.Method == http.MethodGet {
				return nil, errors.New("request failed with " + rawErrorSecret)
			}
			return onlineResponse(http.StatusNoContent, ""), nil
		}),
		loadProvider: func(*storage.Store) (providerTarget, bool, error) {
			return providerTarget{
				ID:      "remote",
				APIBase: "https://provider.example/v1",
				APIKey:  "provider-api-key",
			}, true, nil
		},
	}

	result, err := Run(context.Background(), RunOptions{}, networkCheckersWithDependencies(nil, deps))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if httpCalls.Load() != 2 {
		t.Fatalf("HTTP calls = %d, want 2", httpCalls.Load())
	}
	provider := findCheck(t, result, "search.provider-endpoint")
	if provider.Status != StatusPass || provider.Evidence["statusCode"] != http.StatusNoContent {
		t.Fatalf("provider check = %#v", provider)
	}
	version := findCheck(t, result, "online.version")
	if version.Status != StatusWarn || version.Evidence["errorCode"] != "network_request_failed" {
		t.Fatalf("version check = %#v", version)
	}
	data, _ := json.Marshal(result)
	if strings.Contains(string(data), rawErrorSecret) {
		t.Fatalf("result leaked raw HTTP error: %s", data)
	}
}

func TestOnlineVersionCheckReportsAvailableUpdate(t *testing.T) {
	deps := onlineDependencies{
		client: httpDoerFunc(func(*http.Request) (*http.Response, error) {
			return onlineResponse(http.StatusOK, `{"version":"999.0.0"}`), nil
		}),
		loadProvider: func(*storage.Store) (providerTarget, bool, error) {
			return providerTarget{}, false, nil
		},
	}
	result, err := Run(context.Background(), RunOptions{}, networkCheckersWithDependencies(nil, deps))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	version := findCheck(t, result, "online.version")
	if version.Status != StatusWarn || version.Evidence["latestVersion"] != "999.0.0" ||
		version.Remediation == nil || version.Remediation.Command != "knowns update" {
		t.Fatalf("version check = %#v", version)
	}
}

func TestOnlineChecksAreBoundedAndHonorCancellation(t *testing.T) {
	deps := onlineDependencies{
		client: httpDoerFunc(func(req *http.Request) (*http.Response, error) {
			<-req.Context().Done()
			return nil, req.Context().Err()
		}),
		loadProvider: func(*storage.Store) (providerTarget, bool, error) {
			return providerTarget{
				ID:      "remote",
				APIBase: "https://provider.example/v1",
			}, true, nil
		},
	}
	checkers := networkCheckersWithDependencies(nil, deps)
	for i := range checkers {
		checkers[i].Timeout = 25 * time.Millisecond
	}

	started := time.Now()
	result, err := Run(context.Background(), RunOptions{}, checkers)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("bounded probes took %s", elapsed)
	}
	if len(result.Checks) != 2 || result.Summary.Fail != 2 {
		t.Fatalf("timeout result = %#v", result)
	}
	for _, check := range result.Checks {
		if check.Evidence["errorCode"] != "checker_timeout" {
			t.Fatalf("timeout check = %#v", check)
		}
	}
}

func TestProviderEndpointRejectsMissingEndpoint(t *testing.T) {
	deps := onlineDependencies{
		client: httpDoerFunc(func(*http.Request) (*http.Response, error) {
			return onlineResponse(http.StatusNotFound, ""), nil
		}),
		loadProvider: func(*storage.Store) (providerTarget, bool, error) {
			return providerTarget{
				ID:      "remote",
				APIBase: "https://provider.example/v1",
			}, true, nil
		},
	}

	result, err := Run(context.Background(), RunOptions{}, []Checker{providerEndpointChecker(nil, deps)})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	check := findCheck(t, result, "search.provider-endpoint")
	if check.Status != StatusFail || check.Evidence["errorCode"] != "provider_endpoint_missing" {
		t.Fatalf("provider check = %#v", check)
	}
}

func TestOnlineEvidenceExcludesCredentialsURLsBodiesAndErrors(t *testing.T) {
	const secret = "doctor-secret-9b8776"
	deps := onlineDependencies{
		client: httpDoerFunc(func(req *http.Request) (*http.Response, error) {
			if req.Method == http.MethodGet {
				return onlineResponse(http.StatusOK, `{"version":"`+secret+`"}`), nil
			}
			if req.Method == http.MethodHead {
				if authorization := req.Header.Get("Authorization"); authorization != "Bearer "+secret {
					t.Errorf("Authorization = %q", authorization)
				}
			}
			return nil, errors.New("raw log body and credential: " + secret)
		}),
		loadProvider: func(*storage.Store) (providerTarget, bool, error) {
			return providerTarget{
				ID:      "provider-secret-" + secret,
				APIBase: "https://" + secret + ".example/v1?token=" + secret,
				APIKey:  secret,
			}, true, nil
		},
	}

	result, err := Run(context.Background(), RunOptions{}, networkCheckersWithDependencies(nil, deps))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	for _, forbidden := range []string{secret, "raw log body", "token="} {
		if strings.Contains(string(data), forbidden) {
			t.Fatalf("result leaked %q: %s", forbidden, data)
		}
	}
}

func onlineResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}
