package cloudflared

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Daemon manages a shared `cloudflared tunnel --url` process keyed by the
// local port being tunneled. State lives in `~/.knowns/cloudflared-<port>.{pid,url,log}`.
type Daemon struct {
	LocalPort int
	PIDFile   string
	URLFile   string
	LogFile   string

	startedByUs bool
}

func defaultStateDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".knowns")
}

func NewDaemon(localPort int) *Daemon {
	dir := defaultStateDir()
	return &Daemon{
		LocalPort: localPort,
		PIDFile:   filepath.Join(dir, fmt.Sprintf("cloudflared-%d.pid", localPort)),
		URLFile:   filepath.Join(dir, fmt.Sprintf("cloudflared-%d.url", localPort)),
		LogFile:   filepath.Join(dir, fmt.Sprintf("cloudflared-%d.log", localPort)),
	}
}

func (d *Daemon) StartedByUs() bool  { return d.startedByUs }
func (d *Daemon) IsHealthy() bool     { return d.isHealthy() }

// InstallHint returns OS-specific install instructions for cloudflared.
func InstallHint() string {
	const docs = "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
	switch runtime.GOOS {
	case "darwin":
		return "Install cloudflared:\n  brew install cloudflared\n  # or: " + docs
	case "linux":
		return "Install cloudflared:\n  # Debian/Ubuntu:\n  curl -L https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null\n  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main' | sudo tee /etc/apt/sources.list.d/cloudflared.list\n  sudo apt update && sudo apt install cloudflared\n  # Other distros: " + docs
	case "windows":
		return "Install cloudflared:\n  winget install --id Cloudflare.cloudflared\n  # or: " + docs
	default:
		return "Install cloudflared from " + docs
	}
}

// EnsureRunning reuses an existing healthy tunnel for the same port, or spawns a fresh one.
func (d *Daemon) EnsureRunning() error {
	if _, err := exec.LookPath("cloudflared"); err != nil {
		return fmt.Errorf("cloudflared not found in PATH.\n%s", InstallHint())
	}

	if d.isHealthy() {
		log.Printf("[cloudflared] reusing tunnel on port %d", d.LocalPort)
		return nil
	}

	d.cleanupStale()
	return d.start()
}

func (d *Daemon) Stop() error {
	pid, err := d.ReadPID()
	if err != nil {
		return nil
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		os.Remove(d.PIDFile)
		os.Remove(d.URLFile)
		return nil
	}
	log.Printf("[cloudflared] stopping tunnel (pid %d)", pid)
	if err := signalTerm(process); err != nil {
		log.Printf("[cloudflared] signal failed: %v", err)
	}
	done := make(chan struct{})
	go func() { process.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		process.Kill()
		process.Wait()
	}
	os.Remove(d.PIDFile)
	os.Remove(d.URLFile)
	return nil
}

// PublicURL returns the trycloudflare.com URL captured during start.
func (d *Daemon) PublicURL() (string, error) {
	data, err := os.ReadFile(d.URLFile)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func (d *Daemon) isHealthy() bool {
	pid, err := d.ReadPID()
	if err != nil {
		return false
	}
	if !isProcessAlive(pid) {
		return false
	}
	url, err := d.PublicURL()
	return err == nil && url != ""
}

func (d *Daemon) cleanupStale() {
	pid, err := d.ReadPID()
	if err == nil && !isProcessAlive(pid) {
		log.Printf("[cloudflared] removing stale pid %d", pid)
		os.Remove(d.PIDFile)
		os.Remove(d.URLFile)
	}
}

var trycloudflareRe = regexp.MustCompile(`https://[a-zA-Z0-9-]+\.trycloudflare\.com`)

func (d *Daemon) start() error {
	if err := os.MkdirAll(filepath.Dir(d.PIDFile), 0755); err != nil {
		return err
	}

	logFile, err := os.OpenFile(d.LogFile, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("open cloudflared log: %w", err)
	}

	args := []string{
		"tunnel",
		"--no-autoupdate",
		"--url", fmt.Sprintf("http://localhost:%d", d.LocalPort),
	}
	cmd := exec.Command("cloudflared", args...)

	stderr, err := cmd.StderrPipe()
	if err != nil {
		logFile.Close()
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		logFile.Close()
		return err
	}
	cmd.Stdin = strings.NewReader("")

	setSysProcAttr(cmd)

	if err := cmd.Start(); err != nil {
		logFile.Close()
		return fmt.Errorf("start cloudflared: %w", err)
	}

	if err := d.WritePID(cmd.Process.Pid); err != nil {
		log.Printf("[cloudflared] write pid: %v", err)
	}
	d.startedByUs = true
	log.Printf("[cloudflared] spawned pid %d for port %d", cmd.Process.Pid, d.LocalPort)

	urlCh := make(chan string, 1)
	go scanForURL(io.MultiReader(stderr, stdout), logFile, urlCh)
	go func() {
		// Drain & close log when process exits.
		cmd.Wait()
		logFile.Close()
	}()

	select {
	case url := <-urlCh:
		if err := os.WriteFile(d.URLFile, []byte(url), 0644); err != nil {
			log.Printf("[cloudflared] write url: %v", err)
		}
		return nil
	case <-time.After(20 * time.Second):
		return fmt.Errorf("timed out waiting for cloudflared public URL (see %s)", d.LogFile)
	}
}

func scanForURL(r io.Reader, logFile io.Writer, out chan<- string) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	sent := false
	for scanner.Scan() {
		line := scanner.Text()
		fmt.Fprintln(logFile, line)
		if !sent {
			if m := trycloudflareRe.FindString(line); m != "" {
				out <- m
				sent = true
			}
		}
	}
	if !sent {
		close(out)
	}
}

func (d *Daemon) ReadPID() (int, error) {
	data, err := os.ReadFile(d.PIDFile)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(data)))
}

func (d *Daemon) WritePID(pid int) error {
	if err := os.MkdirAll(filepath.Dir(d.PIDFile), 0755); err != nil {
		return err
	}
	return os.WriteFile(d.PIDFile, []byte(strconv.Itoa(pid)), 0644)
}
