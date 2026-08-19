package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/doctor"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

func TestDoctorCommandSurface(t *testing.T) {
	for _, flag := range []string{"verbose", "strict", "scope"} {
		if doctorCmd.Flags().Lookup(flag) == nil {
			t.Fatalf("missing doctor --%s flag", flag)
		}
	}
	if doctorCmd.Flags().Lookup("online") != nil {
		t.Fatal("doctor must not gate diagnostics behind --online")
	}
	if !shouldSkipCLIWarnings([]string{"doctor", "--json"}) {
		t.Fatal("doctor must bypass startup warnings and update checks")
	}
}

func TestDoctorHumanAndJSONModesShareCompleteResult(t *testing.T) {
	store := newDoctorCLIStore(t)
	checkers := []doctor.Checker{
		doctorTestChecker("project.ready", doctor.ScopeProject, doctor.CheckResult{
			Status:  doctor.StatusPass,
			Summary: "Project is ready",
			Evidence: doctor.Evidence{
				"ready": true,
			},
		}),
		doctorTestChecker("search.model", doctor.ScopeSearch, doctor.CheckResult{
			Status:  doctor.StatusWarn,
			Summary: "Model needs attention",
			Remediation: &doctor.Remediation{
				Description: "Download the configured model.",
				Command:     "knowns model download test-model",
			},
		}),
		{
			ID:    "online.version",
			Scope: doctor.ScopeOnline,
			Check: func(context.Context) (doctor.CheckResult, error) {
				return doctor.CheckResult{
					Status:     doctor.StatusSkip,
					Summary:    "Version service is not configured",
					SkipReason: "not_configured",
				}, nil
			},
		},
	}
	deps := doctorTestDependencies(store, checkers)

	defaultOut, defaultErrOut, err := executeDoctorForTest(t, deps)
	if err != nil {
		t.Fatalf("default doctor error = %v", err)
	}
	if strings.Contains(defaultOut, "project.ready") || strings.Contains(defaultOut, "online.version") {
		t.Fatalf("default output exposed passing/skipped checks:\n%s", defaultOut)
	}
	for _, want := range []string{"Knowns Doctor", "DEGRADED", "Summary:", "search.model", "knowns model download test-model"} {
		if !strings.Contains(defaultOut, want) {
			t.Fatalf("default output missing %q:\n%s", want, defaultOut)
		}
	}
	if defaultErrOut != "" {
		t.Fatalf("default stderr = %q", defaultErrOut)
	}

	plainOut, _, err := executeDoctorForTest(t, deps, "--plain", "--verbose")
	if err != nil {
		t.Fatalf("plain doctor error = %v", err)
	}
	for _, want := range []string{"PASS [project.ready]", "WARN [search.model]", "SKIP [online.version]", "Skip reason: not_configured"} {
		if !strings.Contains(plainOut, want) {
			t.Fatalf("plain output missing %q:\n%s", want, plainOut)
		}
	}
	if regexp.MustCompile(`\x1b\[[0-9;]*m`).MatchString(plainOut) {
		t.Fatalf("plain output contains ANSI escapes: %q", plainOut)
	}

	jsonOut, _, err := executeDoctorForTest(t, deps, "--json")
	if err != nil {
		t.Fatalf("JSON doctor error = %v", err)
	}
	var decoded doctor.Result
	if err := json.Unmarshal([]byte(jsonOut), &decoded); err != nil {
		t.Fatalf("decode JSON: %v\n%s", err, jsonOut)
	}
	if decoded.SchemaVersion != doctor.SchemaVersion || decoded.Verdict != doctor.VerdictDegraded ||
		len(decoded.Checks) != 3 || decoded.Summary.Warn != 1 || decoded.Summary.Skip != 1 {
		t.Fatalf("JSON result = %#v", decoded)
	}
}

func TestDoctorScopeFilteringAndValidation(t *testing.T) {
	store := newDoctorCLIStore(t)
	checkers := []doctor.Checker{
		doctorTestChecker("project.ready", doctor.ScopeProject, doctor.CheckResult{Status: doctor.StatusPass}),
		doctorTestChecker("lsp.go", doctor.ScopeLSP, doctor.CheckResult{Status: doctor.StatusPass}),
		doctorTestChecker("ai.skills", doctor.ScopeAI, doctor.CheckResult{Status: doctor.StatusPass}),
		doctorTestChecker("runtime.service", doctor.ScopeRuntime, doctor.CheckResult{Status: doctor.StatusPass}),
	}
	deps := doctorTestDependencies(store, checkers)

	out, _, err := executeDoctorForTest(t, deps,
		"--scope", "project,lsp",
		"--scope", "ai",
		"--json",
	)
	if err != nil {
		t.Fatalf("scoped doctor error = %v", err)
	}
	var decoded doctor.Result
	if err := json.Unmarshal([]byte(out), &decoded); err != nil {
		t.Fatalf("decode JSON: %v\n%s", err, out)
	}
	got := make([]string, 0, len(decoded.Checks))
	for _, check := range decoded.Checks {
		got = append(got, check.ID)
	}
	if strings.Join(got, ",") != "project.ready,lsp.go,ai.skills" {
		t.Fatalf("scoped check order = %v", got)
	}

	_, stderr, err := executeDoctorForTest(t, deps, "--scope", "project,unknown")
	if err == nil || ExitCode(err) != 2 {
		t.Fatalf("unknown scope error/code = %v/%d", err, ExitCode(err))
	}
	if !strings.Contains(stderr, "unknown doctor scope") {
		t.Fatalf("unknown scope stderr = %q", stderr)
	}

	for _, args := range [][]string{{"--not-a-doctor-flag"}, {"unexpected-argument"}} {
		_, _, err := executeDoctorForTest(t, deps, args...)
		if err == nil || ExitCode(err) != 2 {
			t.Fatalf("usage args %v error/code = %v/%d", args, err, ExitCode(err))
		}
	}
}

func TestDoctorExitCodeContract(t *testing.T) {
	store := newDoctorCLIStore(t)
	tests := []struct {
		name        string
		result      doctor.CheckResult
		args        []string
		wantCode    int
		wantVerdict string
	}{
		{
			name:        "healthy",
			result:      doctor.CheckResult{Status: doctor.StatusPass},
			wantCode:    0,
			wantVerdict: "HEALTHY",
		},
		{
			name:        "degraded",
			result:      doctor.CheckResult{Status: doctor.StatusWarn},
			wantCode:    0,
			wantVerdict: "DEGRADED",
		},
		{
			name:        "strict degraded",
			result:      doctor.CheckResult{Status: doctor.StatusWarn},
			args:        []string{"--strict"},
			wantCode:    1,
			wantVerdict: "DEGRADED",
		},
		{
			name:        "unhealthy",
			result:      doctor.CheckResult{Status: doctor.StatusFail},
			wantCode:    1,
			wantVerdict: "UNHEALTHY",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			deps := doctorTestDependencies(store, []doctor.Checker{
				doctorTestChecker("project.test", doctor.ScopeProject, tt.result),
			})
			stdout, stderr, err := executeDoctorForTest(t, deps, tt.args...)
			if got := ExitCode(err); got != tt.wantCode {
				t.Fatalf("ExitCode() = %d, want %d (err=%v)", got, tt.wantCode, err)
			}
			if !strings.Contains(stdout, tt.wantVerdict) {
				t.Fatalf("stdout missing verdict %q:\n%s", tt.wantVerdict, stdout)
			}
			if tt.wantCode == 1 && stderr != "" {
				t.Fatalf("valid non-zero diagnostic wrote stderr: %q", stderr)
			}
		})
	}

	engineDeps := doctorTestDependencies(store, nil)
	engineDeps.run = func(context.Context, doctor.RunOptions, []doctor.Checker) (doctor.Result, error) {
		return doctor.Result{}, errors.New("registry unavailable")
	}
	_, stderr, err := executeDoctorForTest(t, engineDeps)
	if err == nil || ExitCode(err) != 2 {
		t.Fatalf("engine error/code = %v/%d", err, ExitCode(err))
	}
	if !strings.Contains(stderr, "registry unavailable") {
		t.Fatalf("engine stderr = %q", stderr)
	}
}

func TestDoctorNoActiveProjectIsValidUnhealthyResult(t *testing.T) {
	deps := defaultDoctorCommandDependencies()
	deps.findStore = func() (*storage.Store, error) { return nil, nil }

	stdout, stderr, err := executeDoctorForTest(t, deps, "--json")
	if err == nil || ExitCode(err) != 1 {
		t.Fatalf("no-project error/code = %v/%d", err, ExitCode(err))
	}
	if stderr != "" {
		t.Fatalf("no-project stderr = %q", stderr)
	}
	var decoded doctor.Result
	if err := json.Unmarshal([]byte(stdout), &decoded); err != nil {
		t.Fatalf("decode JSON: %v\n%s", err, stdout)
	}
	if decoded.Project.Active || decoded.Verdict != doctor.VerdictUnhealthy {
		t.Fatalf("no-project result = %#v", decoded)
	}
	for _, check := range decoded.Checks {
		if check.ID == "project.active" {
			if check.Status != doctor.StatusFail || check.Remediation == nil ||
				check.Remediation.Command != "knowns init" {
				t.Fatalf("project.active = %#v", check)
			}
			return
		}
	}
	t.Fatal("project.active check missing")
}

func TestDoctorFlagCombinationsDoNotLeakSecretsOrMutateState(t *testing.T) {
	const secret = "doctor-config-log-env-secret-71c5"
	store := newDoctorCLIStore(t)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	project.Settings.SemanticSearch = &models.SemanticSearchSettings{
		Enabled: true,
		Model:   "doctor-test-model",
		VectorStore: &models.SemanticVectorStoreSettings{
			Backend:     models.SemanticVectorBackendQdrant,
			Mode:        models.SemanticVectorStoreModeExternal,
			ExternalURL: "https://user:" + secret + "@qdrant.example/collections?signature=" + secret,
		},
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	logDir := filepath.Join(store.Root, "runtime")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(logDir, "doctor.log"), []byte("raw log "+secret), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	t.Setenv("KNOWN_DOCTOR_TEST_TOKEN", secret)

	deps := doctorCommandDependencies{
		findStore: func() (*storage.Store, error) { return store, nil },
		checkers: func(store *storage.Store) []doctor.Checker {
			checkers := doctor.FoundationCheckers(store)
			checkers = append(checkers, doctor.LocalCheckers(store)...)
			return append(checkers,
				doctor.Checker{
					ID:    "search.provider-endpoint-test",
					Scope: doctor.ScopeSearch,
					Check: func(context.Context) (doctor.CheckResult, error) {
						return doctor.CheckResult{
							Status:  doctor.StatusPass,
							Summary: "Instrumented provider is reachable",
						}, nil
					},
				},
				doctor.Checker{
					ID:    "online.version-test",
					Scope: doctor.ScopeOnline,
					Check: func(context.Context) (doctor.CheckResult, error) {
						return doctor.CheckResult{
							Status:  doctor.StatusPass,
							Summary: "Instrumented version service is reachable",
						}, nil
					},
				},
			)
		},
		run: doctor.Run,
	}
	beforeFiles := snapshotDoctorFiles(t, store.Root)
	sentinel := startDoctorProcessSentinel(t)
	combinations := [][]string{
		nil,
		{"--verbose"},
		{"--plain"},
		{"--plain", "--verbose"},
		{"--json"},
		{"--scope", "project,validation"},
		{"--strict"},
		{"--scope", "online"},
	}
	for _, args := range combinations {
		stdout, stderr, err := executeDoctorForTest(t, deps, args...)
		if code := ExitCode(err); code == 2 {
			t.Fatalf("doctor %v returned engine failure: %v\n%s", args, err, stderr)
		}
		if strings.Contains(stdout+stderr, secret) || strings.Contains(stdout+stderr, "raw log") {
			t.Fatalf("doctor %v leaked sensitive content:\n%s%s", args, stdout, stderr)
		}
		if after := snapshotDoctorFiles(t, store.Root); !equalDoctorSnapshots(beforeFiles, after) {
			t.Fatalf("doctor %v mutated Knowns project files", args)
		}
	}
	sentinel.assertRunning(t)
}

func executeDoctorForTest(
	t *testing.T,
	deps doctorCommandDependencies,
	args ...string,
) (stdout string, stderr string, err error) {
	t.Helper()
	root := &cobra.Command{Use: "knowns"}
	root.PersistentFlags().Bool("plain", false, "")
	root.PersistentFlags().Bool("json", false, "")
	root.AddCommand(newDoctorCmd(deps))
	root.SetArgs(append([]string{"doctor"}, args...))

	var out bytes.Buffer
	var errOut bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&errOut)
	err = root.Execute()
	return out.String(), errOut.String(), err
}

func doctorTestDependencies(store *storage.Store, checkers []doctor.Checker) doctorCommandDependencies {
	return doctorCommandDependencies{
		findStore: func() (*storage.Store, error) { return store, nil },
		checkers:  func(*storage.Store) []doctor.Checker { return checkers },
		run:       doctor.Run,
	}
}

func doctorTestChecker(id string, scope doctor.Scope, result doctor.CheckResult) doctor.Checker {
	return doctor.Checker{
		ID:    id,
		Scope: scope,
		Check: func(context.Context) (doctor.CheckResult, error) {
			if result.Summary == "" {
				result.Summary = "Test check"
			}
			if (result.Status == doctor.StatusWarn || result.Status == doctor.StatusFail) &&
				result.Remediation == nil {
				result.Remediation = &doctor.Remediation{Description: "Resolve test condition."}
			}
			return result, nil
		},
	}
}

func newDoctorCLIStore(t *testing.T) *storage.Store {
	t.Helper()
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doctor-cli-test"); err != nil {
		t.Fatalf("Init() error = %v", err)
	}
	return store
}

func snapshotDoctorFiles(t *testing.T, root string) map[string]string {
	t.Helper()
	snapshot := make(map[string]string)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if entry.IsDir() {
			snapshot[relative+"/"] = entry.Type().String()
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		snapshot[relative] = fmt.Sprintf("%s:%x", info.Mode(), data)
		return nil
	})
	if err != nil {
		t.Fatalf("snapshot project: %v", err)
	}
	return snapshot
}

func equalDoctorSnapshots(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}

type doctorProcessSentinel struct {
	command *exec.Cmd
	stdin   io.WriteCloser
	output  *bufio.Scanner
	stderr  *bytes.Buffer
}

func startDoctorProcessSentinel(t *testing.T) *doctorProcessSentinel {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestDoctorProcessSentinelHelper$")
	command.Env = append(os.Environ(), "KNOWN_DOCTOR_PROCESS_SENTINEL=1")
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatalf("sentinel StdinPipe() error = %v", err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatalf("sentinel StdoutPipe() error = %v", err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatalf("sentinel Start() error = %v", err)
	}
	sentinel := &doctorProcessSentinel{
		command: command,
		stdin:   stdin,
		output:  bufio.NewScanner(stdout),
		stderr:  &stderr,
	}
	for sentinel.output.Scan() {
		if sentinel.output.Text() == "DOCTOR_SENTINEL_READY" {
			t.Cleanup(func() {
				_ = sentinel.stdin.Close()
				_ = sentinel.command.Wait()
			})
			return sentinel
		}
	}
	t.Fatalf("sentinel did not start: %s", stderr.String())
	return nil
}

func (s *doctorProcessSentinel) assertRunning(t *testing.T) {
	t.Helper()
	if _, err := fmt.Fprintln(s.stdin, "PING"); err != nil {
		t.Fatalf("doctor stopped sentinel process: %v\n%s", err, s.stderr.String())
	}
	for s.output.Scan() {
		if s.output.Text() == "PONG" {
			return
		}
	}
	t.Fatalf("doctor stopped sentinel process before PONG: %s", s.stderr.String())
}

func TestDoctorProcessSentinelHelper(t *testing.T) {
	if os.Getenv("KNOWN_DOCTOR_PROCESS_SENTINEL") != "1" {
		t.Skip("helper process")
	}
	fmt.Println("DOCTOR_SENTINEL_READY")
	input := bufio.NewScanner(os.Stdin)
	for input.Scan() {
		if input.Text() == "PING" {
			fmt.Println("PONG")
		}
	}
}
