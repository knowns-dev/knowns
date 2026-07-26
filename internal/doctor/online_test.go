package doctor

import (
	"context"
	"encoding/json"
	"errors"
	"io"
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

func TestOnlineChecksDoNotInvokeDependenciesOffline(t *testing.T) {
	var httpCalls atomic.Int32
	var providerLoads atomic.Int32
	deps := onlineDependencies{
		client: httpDoerFunc(func(*http.Request) (*http.Response, error) {
			httpCalls.Add(1)
			return nil, errors.New("HTTP must not run")
		}),
		loadProvider: func(*storage.Store) (providerTarget, bool, error) {
			providerLoads.Add(1)
			return providerTarget{}, false, errors.New("provider load must not run")
		},
	}

	result, err := Run(context.Background(), RunOptions{
		Scopes: []Scope{ScopeOnline},
		Online: false,
	}, onlineCheckersWithDependencies(nil, deps))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if httpCalls.Load() != 0 || providerLoads.Load() != 0 {
		t.Fatalf("offline dependency calls = HTTP %d, provider %d", httpCalls.Load(), providerLoads.Load())
	}
	if result.Verdict != VerdictHealthy || result.Summary.Skip != 2 {
		t.Fatalf("offline result = %#v", result)
	}
	for _, check := range result.Checks {
		if check.Status != StatusSkip || check.SkipReason != "online_disabled" {
			t.Fatalf("offline check = %#v", check)
		}
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

	result, err := Run(context.Background(), RunOptions{
		Scopes: []Scope{ScopeOnline},
		Online: true,
	}, onlineCheckersWithDependencies(nil, deps))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if httpCalls.Load() != 2 {
		t.Fatalf("HTTP calls = %d, want 2", httpCalls.Load())
	}
	provider := findCheck(t, result, "online.provider")
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
	result, err := Run(context.Background(), RunOptions{
		Scopes: []Scope{ScopeOnline},
		Online: true,
	}, onlineCheckersWithDependencies(nil, deps))
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
	checkers := onlineCheckersWithDependencies(nil, deps)
	for i := range checkers {
		checkers[i].Timeout = 25 * time.Millisecond
	}

	started := time.Now()
	result, err := Run(context.Background(), RunOptions{
		Scopes: []Scope{ScopeOnline},
		Online: true,
	}, checkers)
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

func TestOnlineProviderRejectsMissingEndpoint(t *testing.T) {
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

	result, err := Run(context.Background(), RunOptions{
		Scopes: []Scope{ScopeOnline},
		Online: true,
	}, []Checker{onlineProviderChecker(nil, deps)})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	check := findCheck(t, result, "online.provider")
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

	result, err := Run(context.Background(), RunOptions{
		Scopes: []Scope{ScopeOnline},
		Online: true,
	}, onlineCheckersWithDependencies(nil, deps))
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
